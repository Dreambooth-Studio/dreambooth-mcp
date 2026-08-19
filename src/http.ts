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
  res: express.Response,
): Promise<void> {
  /**
   * There is no server-to-client stream on this path, so say so.
   *
   * A stateless request gets a throwaway server that is closed on the response.
   * It can never push anything, so an SSE stream opened here would sit open
   * forever delivering nothing — which is exactly what it did: `GET /mcp`
   * answered 200, wrote a few bytes, and held the connection until the client
   * gave up. A client that opens the stream and waits for it hangs, and a
   * backend driving that client times out and reports a failure with no cause
   * attached to it.
   *
   * The spec asks for this explicitly. Streamable HTTP says a server that does
   * not offer an SSE stream at the endpoint MUST answer GET with 405, and the
   * point of 405 is that it is instant and unambiguous: the client learns there
   * is no stream and carries on with POST, instead of waiting for one that will
   * never speak.
   *
   * DELETE gets the same treatment. It ends a session, and a stateless request
   * has none to end.
   */
  if (req.method === "GET" || req.method === "DELETE") {
    res
      .status(405)
      .set("Allow", "POST, OPTIONS")
      .json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "This endpoint does not offer a server-to-client stream. Send requests as POST; " +
            "every reply arrives in the POST response.",
        },
        id: null,
      });
    return;
  }

  const token = bearerToken(req);

  // The 401 that starts the OAuth flow. Only tool calls that genuinely need a
  // credential are refused — `initialize`, `tools/list` and `search_docs` still
  // answer anonymously, which is what keeps the listing's promise that product
  // and pricing questions need no account.
  if (
    !token &&
    requiresAuth(req.body, { frameGeneration: config.frameGeneration })
  ) {
    sendUnauthorized(res, config, req, {
      description: `${toolCallName(req.body)} needs a connected Dreambooth account. Sign in to continue; product, pricing and troubleshooting questions work without one via search_docs.`,
      id: requestId(req.body),
    });
    return;
  }

  /**
   * Accept `application/json` alone on this path.
   *
   * The SDK refuses with 406 unless a client offers BOTH `application/json`
   * and `text/event-stream`. That rule protects a transport that might answer
   * with a stream — and since `enableJsonResponse` below, this one never can.
   * Refusing a request we are about to answer in JSON, because the client did
   * not also offer a format we will never send, is a 406 with nothing behind
   * it. A scanner that does not expect one has no way to read it as anything
   * but a broken server.
   *
   * Narrow on purpose: only the stateless path, only when the client already
   * asked for JSON, and only by ADDING the type the SDK wants. A client that
   * offers neither still gets its 406.
   */
  const accept = String(req.headers.accept ?? "");
  if (
    accept.includes("application/json") &&
    !accept.includes("text/event-stream")
  ) {
    const widened = `${accept}, text/event-stream`;
    req.headers.accept = widened;
    /**
     * `rawHeaders` as well, and this is not belt-and-braces.
     *
     * The SDK's Node transport is a wrapper that converts the request into a
     * Web `Request` through `@hono/node-server`, and that conversion reads
     * `rawHeaders` — the flat [name, value, name, value] array — not the
     * parsed `headers` object. Setting only `headers.accept` changes nothing
     * the transport will ever look at, which is exactly what happened the
     * first time this was written: the shim was in the right place, ran on the
     * right request, and the 406 did not move.
     */
    const raw = (req as unknown as { rawHeaders?: string[] }).rawHeaders;
    if (Array.isArray(raw)) {
      let found = false;
      for (let i = 0; i < raw.length; i += 2) {
        if (raw[i]?.toLowerCase() === "accept") {
          raw[i + 1] = widened;
          found = true;
        }
      }
      if (!found) raw.push("accept", widened);
    }
  }

  const tokens = token ? SessionTokens.forRequest(token) : new SessionTokens();

  const transport = new StreamableHTTPServerTransport({
    // undefined is the SDK's documented stateless mode: no session id is
    // minted, and no initialize handshake is required first.
    sessionIdGenerator: undefined,
    /**
     * Answer as plain JSON, not as a one-frame SSE stream.
     *
     * This path can never push anything — the server is closed on the response
     * — so wrapping a single reply in `event: message
data: {…}` buys nothing
     * and costs two failure modes: a client that reasonably calls `res.json()`
     * on a request/response exchange gets a parse error, and any proxy that
     * buffers by content type can hold the reply instead of forwarding it.
     *
     * Does NOT loosen Accept validation. The SDK still refuses with 406 unless
     * the client offers both `application/json` and `text/event-stream`.
     */
    enableJsonResponse: true,
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

/**
 * CORS, before anything else can answer.
 *
 * The ChatGPT submission portal's "Scan Tools" runs in the browser, and so do
 * several MCP clients. With no `Access-Control-Allow-Origin` the browser
 * blocks the response before any JavaScript sees it and reports the generic
 * "Failed to fetch" — which looks like the server is down or the URL is
 * wrong, and is neither. The preflight was already answering 200 with an
 * `allow` header and no CORS headers, which is the most confusing possible
 * combination: reachable by curl, unreachable by a browser.
 *
 * `*` with NO `Access-Control-Allow-Credentials`, deliberately. This service
 * authenticates only from an explicit `Authorization` header — never a cookie
 * — so there is no ambient credential for a hostile page to ride, and `*` is
 * therefore safe in a way it would not be for a cookie-authenticated origin.
 * Adding credentials support later would mean echoing a specific origin and
 * an allow-list; do not add it casually.
 *
 * `Mcp-Session-Id` has to be EXPOSED as well as allowed: a browser client
 * cannot read a response header it was not told about, and that header is how
 * a session-based client keeps its session.
 */
export function corsMiddleware(
  req: {
    method: string;
    headers: Record<string, string | string[] | undefined>;
  },
  res: {
    setHeader(name: string, value: string): void;
    status(code: number): { end(): void };
  },
  next: () => void,
): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  /**
   * Reflect whatever the preflight asked for, rather than guessing it.
   *
   * This was a fixed list of six headers, and a fixed list is a bet on knowing
   * every client. A browser fails the preflight if ANY requested header is
   * missing from the answer, and what it reports is `TypeError: Failed to
   * fetch` — no header named, nothing to go on. Reproduced from a real browser
   * against this deployment: the identical request succeeds with a known header
   * set and throws that exact error the moment one unlisted header is added.
   *
   * OpenAI's and Anthropic's clients both send headers of their own and neither
   * publishes the list, so guessing it once means guessing again every time
   * either of them ships a change.
   *
   * Safe, because allowing a header only lets the browser SEND it. What the
   * request may DO is still decided by the bearer token, and a header the
   * transport does not recognise is ignored. `Vary` is set so a cache cannot
   * answer one client's preflight with another client's allow-list.
   */
  const requested = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    (Array.isArray(requested) ? requested.join(", ") : requested) ||
      "content-type, authorization, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  );
  res.setHeader("Vary", "Origin, Access-Control-Request-Headers");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "mcp-session-id, www-authenticate",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    // 204 and nothing else. A preflight that returns a body invites a client
    // to parse it, and Express's default OPTIONS handler answers with an
    // `allow` header that reads like success while carrying no CORS headers.
    res.status(204).end();
    return;
  }
  next();
}

export function startHttpServer(config: Config): void {
  const app = express();

  app.use(corsMiddleware);
  const sessions = new Map<string, SessionEntry>();

  // Registered BEFORE anything else so Railway's healthcheck can never be
  // blocked by transport or auth logic.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      /**
       * Which build this actually is.
       *
       * `version` comes from a constant and does not move between deploys, so
       * /health could not tell a deploy from three weeks ago apart from one
       * from a minute ago — and "fixed but not deployed" looks exactly like
       * "not fixed". That ambiguity cost real time during the tool-scan
       * investigation.
       */
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "unknown",
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
      if (
        !existing.tokens.get() &&
        requiresAuth(req.body, { frameGeneration: config.frameGeneration })
      ) {
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
      allowedHosts: config.allowedHosts.length
        ? config.allowedHosts
        : undefined,
      onsessioninitialized: (id) => {
        const now = Date.now();
        sessions.set(id, {
          transport,
          tokens,
          createdAt: now,
          lastSeenAt: now,
        });
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
        }),
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
      }),
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
