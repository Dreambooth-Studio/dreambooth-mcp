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

  app.use(express.json({ limit: "4mb" }));

  const handle: express.RequestHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
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
    const tokens = new SessionTokens(config.token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: config.allowedHosts.length > 0,
      allowedHosts: config.allowedHosts.length ? config.allowedHosts : undefined,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, tokens, createdAt: Date.now() });
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

    const server = createServer(config, tokens);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", handle);
  // GET opens the server→client stream; DELETE ends a session. Both are part
  // of the Streamable HTTP contract, not optional extras.
  app.get("/mcp", handle);
  app.delete("/mcp", handle);

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
    for (const entry of sessions.values()) void entry.transport.close();
    sessions.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
