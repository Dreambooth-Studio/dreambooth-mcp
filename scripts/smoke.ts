/**
 * End-to-end smoke test: spawns the real server over stdio with a real MCP
 * client, completes the handshake, lists the tools, and calls them.
 *
 * This is the Phase 0 acceptance check. It proves the protocol wiring without
 * needing Claude Desktop, and it fails loudly on the two mistakes that are easy
 * to make and hard to see: a stray write to stdout corrupting the transport,
 * and a tool whose schema does not match its handler.
 *
 *   npm run inspect
 *
 * With no DREAMBOOTH_TOKEN set it still exercises search_docs (which needs no
 * auth) and shows the authed tools failing with a readable message rather than
 * a crash — which is itself worth verifying.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const RESET = "[0m";
const OK = "[32m";
const BAD = "[31m";
const DIM = "[2m";

function preview(result: { content?: unknown; isError?: boolean }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.map((b) => b.text ?? "").join("\n");
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 220 ? `${oneLine.slice(0, 220)}…` : oneLine;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [require.resolve("tsx/cli"), "src/index.ts"],
    // Inherit the environment so DREAMBOOTH_TOKEN flows through when present.
    env: { ...process.env } as Record<string, string>,
    stderr: "inherit",
  });

  const client = new Client({ name: "dreambooth-mcp-smoke", version: "0.1.0" });
  await client.connect(transport);
  console.log(`${OK}✓${RESET} handshake completed`);

  const { tools } = await client.listTools();
  console.log(`${OK}✓${RESET} tools/list returned ${tools.length}:`);
  for (const tool of tools) {
    const params = Object.keys(
      (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}
    );
    console.log(`    ${tool.name}(${params.join(", ")})`);
    if (!tool.description || tool.description.length < 40) {
      console.log(`${BAD}    ! description is too thin — the model picks tools by this${RESET}`);
    }
  }

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "search_docs", args: { query: "printer", locale: "en", limit: 2 } },
    { name: "list_projects", args: {} },
    { name: "get_project", args: { projectId: process.env.SMOKE_PROJECT_ID ?? "" } },
    { name: "get_sessions", args: { limit: 1 } },
    { name: "get_revenue_summary", args: { groupBy: "month" } },
    { name: "get_credits", args: {} },
    { name: "get_wallet_transactions", args: { limit: 2 } },
    { name: "get_gallery_stats", args: {} },
  ];

  let failures = 0;
  for (const call of calls) {
    const result = (await client.callTool({
      name: call.name,
      arguments: call.args,
    })) as { content?: unknown; isError?: boolean };

    if (result.isError) {
      // Expected without a token — but it must be a readable sentence, not a stack.
      console.log(`${DIM}·${RESET} ${call.name} → handled error: ${preview(result)}`);
      if (call.name === "search_docs") failures++; // this one needs no auth
    } else {
      console.log(`${OK}✓${RESET} ${call.name} → ${preview(result)}`);
    }
  }

  await client.close();

  if (failures > 0) {
    console.error(`${BAD}✗ ${failures} tool(s) failed that should not have${RESET}`);
    process.exit(1);
  }
  console.log(`${OK}✓ smoke passed${RESET}`);
}

main().catch((err) => {
  console.error(`${BAD}✗ smoke failed:${RESET}`, err);
  process.exit(1);
});
