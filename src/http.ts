import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { SessionTokens } from "./auth/tokenStore.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp/server.js";
import { registerWellKnown } from "./mcp/wellKnown.js";
import { requiresAuth, toolCallName } from "./mcp/toolAuth.js";
import { sendUnauthorized } from "./auth/challenge.js";

/**
 * Streamable HTTP transport, one MCP server per session.
 *
 * The per-session server is what keeps operators apart: each session gets its
 * own SessionTokens, so a token approved in one conversation is unreachable
 * from another. Threading a session id down into every tool would achieve the
 * same thing and be far easier to get subtly wrong.
 *
 * Sessions live in memory. A restart drops them and every operator reconnects —
 * accepted deliberately for v1, because the alternative is persisting
 * session-equivalent credentials.
 */

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  tokens: SessionTokens;
  createdAt: number;
  /** Bumped on every request; the sweep below is the only reader. */
  lastSeenAt: number;
}

/**
 * A session only ever disappeared on explicit close or process restart, which
 * meant an abandoned tab left a session-equivalent token sitting in memory
 * forever. Thirty minutes is longer than any plausible gap between two
 * questions in one conversation, and reconnecting costs the operator about
 * fifteen seconds.
 */
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** `Authorization: Bearer <token>`, or null. Scheme match is case-insensitive. */
function bearerToken(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!token || scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

/**
 * Serves one request with no session at all.
 *
 * A fresh server and transport per request sounds wasteful, and is: it builds
 * the tool registry every time. That is the correct trade for now — it is a few
 * milliseconds of object construction against a connector that is otherwise
 * completely broken on ChatGPT for iOS and macOS, and it keeps the stateful
 * path untouched while the authorization server is built. If the cost ever
 * shows up in the latency numbers, the registry can be hoisted; the request
 * still must not share a token store with anything.
 *
 * Authentication comes ONLY from this request's own Authorization header.
 * Nothing is remembered afterwards, which is the whole point: there is no
 * session for a token to outlive, and no way for one caller's credential to
 * reach another's request.
 */
/** The JSON-RPC id of the request, so an error can be correlated with it. */
function requestId(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return (body as { id?: unknown }).id ?? null;
}

async function handleStateless(
  config: Config,
  req: express.Request,
  res: express.Response
): Promise<void> {
  const token = bearerToken(req);

  // The 401 that starts the OAuth flow. Only tool calls that genuinely need a
  // credential are refused — `initialize`, `tools/list` and `search_docs` still
  // answer anonymously, which is what keeps the listing's promise that product
  // and pricing questions need no account.
  if (!token && requiresAuth(req.body)) {
    sendUnauthorized(res, config, req, {
      description: `${toolCallName(req.body)} needs a connected Dreambooth account. Sign in to continue; product, pricing and troubleshooting questions work without one via search_docs.`,
      id: requestId(req.body),
    });
    return;
  }

  const tokens = token ? SessionTokens.forRequest(token) : new SessionTokens();

  const transport = new StreamableHTTPServerTransport({
    // undefined is the SDK's documented stateless mode: no session id is
    // minted, and no initialize handshake is required first.
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: config.allowedHosts.length > 0,
    allowedHosts: config.allowedHosts.length ? config.allowedHosts : undefined,
  });

  const server = createServer(config, tokens, {
    transport: "http",
    sessionId: () => undefined,
    stateless: true,
    bearerAuth: token !== null,
  });

  // Closed on the response, not after handleRequest returns: the response may
  // still be streaming SSE frames when that promise resolves, and tearing the
  // transport down early truncates the reply.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function startHttpServer(config: Config): void {
  const app = express();
  const sessions = new Map<string, SessionEntry>();

  // Registered BEFORE anything else so Railway's healthcheck can never be
  // blocked by transport or auth logic.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: SERVER_NAME,
      version: SERVER_VERSION,
      sessions: sessions.size,
      apiUrl: config.apiUrl,
    });
  });

  /**
   * Domain-ownership proof for the ChatGPT plugin directory.
   *
   * OpenAI issues a challenge string in the submission portal and then fetches
   * it back from this exact path on the host the submitted MCP URL points at —
   * `mcp.dreamboothstudio.com`. If the portal asks for the apex domain instead,
   * the same route has to exist in the Studio; this one only proves the
   * subdomain.
   *
   * Served as text/plain and unauthenticated by necessity: the whole point is
   * that an anonymous fetch from OpenAI can read it. It holds no secret — a
   * challenge string proves possession of the host, and anyone who can read it
   * already reached the host.
   *
   * Registered ahead of the JSON body parser and the transport for the same
   * reason /health is: nothing about MCP or sessions should be able to break
   * a verification fetch.
   */
  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    if (!config.openaiAppsChallenge) {
      // 404 rather than an empty 200: an empty body reads to the verifier as
      // "wrong value" and to us as "route is broken", which are very different
      // problems. A 404 says plainly that nothing is configured yet.
      res.status(404).type("text/plain").send("not configured");
      return;
    }
    res.type("text/plain").send(config.openaiAppsChallenge);
  });

  /**
   * Protected-resource metadata (RFC 9728) and the authorization-server alias,
   * at every path a client actually asks for. See wellKnown.ts — publishing the
   * document at only one of the two spellings is what made this connector look
   * unauthenticated to the submission portal.
   */
  registerWellKnown(app, config);

  app.use(express.json({ limit: "4mb" }));

  const handle: express.RequestHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    // An Authorization header wins over any session, and is never merged into
    // one. A credential that arrived on this request belongs to this request:
    // writing it into a session store would leave it readable by every later
    // request that quotes the same session id, which is a different and much
    // longer-lived thing than the caller handed us.
    if (bearerToken(req)) {
      await handleStateless(config, req, res);
      return;
    }

    if (existing) {
      existing.lastSeenAt = Date.now();
      // Same challenge as the stateless path, so a client behaves identically
      // whether or not it keeps a session — the inconsistency between ChatGPT
      // on the web and on a phone was the reported defect, and one path
      // answering "not connected" while the other returns a signed 401 is
      // exactly that inconsistency in a different place.
      if (!existing.tokens.get() && requiresAuth(req.body)) {
        sendUnauthorized(res, config, req, {
          description: `${toolCallName(req.body)} needs a connected Dreambooth account. Sign in to continue; product, pricing and troubleshooting questions work without one via search_docs.`,
          id: requestId(req.body),
        });
        return;
      }
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      // A session id we do not know: almost always a client reconnecting after
      // a restart. Say so plainly instead of 500-ing.
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unknown session. Start a new one." },
        id: null,
      });
      return;
    }

    // No session id, and not an initialize request.
    //
    // This used to be treated as a client error and the transport answered
    // `400 Bad Request: Server not initialized`. That assumption is now wrong
    // in the field and wrong in the spec:
    //
    //   - ChatGPT on iOS and macOS sends NO Mcp-Session-Id on tools/call, so
    //     every tool call from those clients 400s. The connector does not
    //     degrade there, it fails on the first question.
    //   - MCP 2026-07-28 removes the header and the initialize handshake
    //     outright (SEP-2567, SEP-2575), described as "a clean break... with no
    //     deprecation window".
    //
    // So a request without a session is handled statelessly instead: one
    // throwaway server for this request, authenticated only by the caller's own
    // Authorization header. That is the shape OAuth will use, so this path is
    // the one that survives Half 2 rather than being thrown away by it.
    if (!isInitializeRequest(req.body)) {
      await handleStateless(config, req, res);
      return;
    }

    // A session starts unauthenticated and stays that way until its own
    // operator completes connect_account. There is no configuration that can
    // change that.
    const tokens = new SessionTokens();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: config.allowedHosts.length > 0,
      allowedHosts: config.allowedHosts.length ? config.allowedHosts : undefined,
      onsessioninitialized: (id) => {
        const now = Date.now();
        sessions.set(id, { transport, tokens, createdAt: now, lastSeenAt: now });
        console.log(JSON.stringify({ msg: "session opened", sessionId: id }));
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        console.log(JSON.stringify({ msg: "session closed", sessionId: id }));
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    const server = createServer(config, tokens, {
      transport: "http",
      // Read lazily: the id does not exist until the transport has initialised,
      // which happens after the server is built.
      sessionId: () => transport.sessionId,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", handle);
  // GET opens the server→client stream; DELETE ends a session. Both are part
  // of the Streamable HTTP contract, not optional extras.
  app.get("/mcp", handle);
  app.delete("/mcp", handle);

  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastSeenAt > cutoff) continue;
      sessions.delete(id);
      // Closing the transport is what drops the token: SessionTokens lives in
      // the closure of that session's server, so it goes with it.
      void entry.transport.close();
      console.log(
        JSON.stringify({
          msg: "session evicted (idle)",
          sessionId: id,
          idleMinutes: Math.round((Date.now() - entry.lastSeenAt) / 60000),
        })
      );
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  const server = app.listen(config.port, () => {
    console.log(
      JSON.stringify({
        msg: "listening",
        service: SERVER_NAME,
        version: SERVER_VERSION,
        port: config.port,
        apiUrl: config.apiUrl,
      })
    );
  });

  // Long-lived SSE connections keep sockets open; without an explicit close
  // Railway's SIGTERM turns a deploy into a hang and then a kill.
  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ msg: "shutting down", signal }));
    clearInterval(sweep);
    for (const entry of sessions.values()) void entry.transport.close();
    sessions.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
