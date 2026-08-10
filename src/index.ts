#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp/server.js";

/**
 * Phase 0 entry point: stdio transport, for running inside Claude Desktop or
 * the MCP Inspector on a developer machine.
 *
 * Phase 1 swaps this for Streamable HTTP on Railway. Everything under
 * src/mcp/server.ts and src/tools/ stays exactly as it is — only the transport
 * and the token source change.
 *
 * NOTHING may be written to stdout except MCP protocol frames. stdout IS the
 * transport; a stray console.log corrupts the stream and the client drops the
 * connection with a parse error. All diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const server = createServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error(
    `[${SERVER_NAME} ${SERVER_VERSION}] ready on stdio → ${config.apiUrl}`
  );

  const shutdown = (signal: string) => {
    console.error(`[${SERVER_NAME}] ${signal} received, closing`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] failed to start:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
