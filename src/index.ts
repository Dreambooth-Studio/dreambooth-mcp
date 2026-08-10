#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, resolveMode } from "./config.js";
import { SessionTokens } from "./auth/tokenStore.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp/server.js";
import { startHttpServer } from "./http.js";

/**
 * Two transports, one server.
 *
 *   --http  (default)  Streamable HTTP, for Railway and remote connectors.
 *   --stdio            local, for Claude Desktop and the smoke script.
 *
 * Everything under src/mcp/ and src/tools/ is identical either way; only the
 * transport differs. Both start unauthenticated and connect through the same
 * device flow — there is no token to configure in either mode.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const mode = resolveMode(process.argv.slice(2));

  if (mode === "http") {
    startHttpServer(config);
    return;
  }

  // stdio: NOTHING may be written to stdout except MCP protocol frames. stdout
  // IS the transport; a stray console.log corrupts the stream and the client
  // drops the connection with a parse error. Diagnostics go to stderr.
  const tokens = new SessionTokens();
  const server = createServer(config, tokens);
  await server.connect(new StdioServerTransport());

  console.error(
    `[${SERVER_NAME} ${SERVER_VERSION}] ready on stdio → ${config.apiUrl} (run connect_account to sign in)`
  );

  const shutdown = (signal: string) => {
    console.error(`[${SERVER_NAME}] ${signal} received, closing`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(
    `[${SERVER_NAME}] failed to start:`,
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
