import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { SessionTokens } from "./auth/tokenStore.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp/server.js";

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

  app.use(express.json({ limit: "4mb" }));

  const handle: express.RequestHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      existing.lastSeenAt = Date.now();
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

    // No session id — this must be an initialize request; anything else is a
    // client error, and the transport rejects it for us.
    //
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
