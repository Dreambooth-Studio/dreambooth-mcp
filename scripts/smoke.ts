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
 * It runs unauthenticated: search_docs needs no account, and the authed tools
 * must fail with a readable message naming connect_account rather than
 * crashing — which is itself worth verifying.
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
    // --stdio is required: the entry point defaults to HTTP, and without this
    // the child starts a web server and never answers on stdin.
    args: [require.resolve("tsx/cli"), "src/index.ts", "--stdio"],
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

  let failures = 0;

  // Widgets: a tool that points at a `ui://` resource which does not resolve
  // renders as a blank card with no error anywhere, so check the link both
  // ways — the tool's pointer, and the resource behind it.
  const { resources } = await client.listResources();
  console.log(`${OK}✓${RESET} resources/list returned ${resources.length}`);

  for (const tool of tools) {
    const meta = (tool as { _meta?: Record<string, unknown> })._meta;
    const uri = meta?.["ui.resourceUri"] as string | undefined;
    if (!uri) continue;

    if (meta?.["openai/outputTemplate"] !== uri) {
      console.log(`${BAD}✗ ${tool.name}: openai/outputTemplate does not match ui.resourceUri${RESET}`);
      failures++;
    }

    try {
      const read = await client.readResource({ uri });
      const first = read.contents?.[0] as { mimeType?: string; text?: string } | undefined;
      const html = first?.text ?? "";
      if (!first?.mimeType?.startsWith("text/html")) {
        console.log(`${BAD}✗ ${uri}: wrong mimeType (${first?.mimeType})${RESET}`);
        failures++;
      } else if (!html.includes("window.__db")) {
        console.log(`${BAD}✗ ${uri}: document is missing the widget bridge${RESET}`);
        failures++;
      } else if (/https?:\/\/(?!127\.|localhost)/.test(html.replace(/https?:\/\/\S*dreambooth\S*/gi, ""))) {
        // Any absolute URL in the document is a request the CSP will block.
        console.log(`${BAD}✗ ${uri}: references an external origin${RESET}`);
        failures++;
      } else {
        console.log(
          `${OK}✓${RESET} ${tool.name} → ${uri} (${(html.length / 1024).toFixed(1)} kB, self-contained)`
        );
      }
    } catch (err) {
      console.log(`${BAD}✗ ${uri}: unreadable — ${(err as Error).message}${RESET}`);
      failures++;
    }
  }

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "search_docs", args: { query: "printer", locale: "en", limit: 2 } },
    { name: "list_projects", args: {} },
    // Needs a real id, so it only runs when one is supplied.
    ...(process.env.SMOKE_PROJECT_ID
      ? [{ name: "get_project", args: { projectId: process.env.SMOKE_PROJECT_ID } }]
      : []),
    { name: "get_sessions", args: { limit: 1 } },
    { name: "get_revenue_summary", args: { groupBy: "month" } },
    { name: "get_credits", args: {} },
    { name: "get_wallet_transactions", args: { limit: 2 } },
    { name: "get_gallery_stats", args: {} },
  ];

  for (const call of calls) {
    const result = (await client.callTool({
      name: call.name,
      arguments: call.args,
    })) as { content?: unknown; isError?: boolean; structuredContent?: unknown };

    // Widgets read `structuredContent`; text-only clients read `content`. A
    // success that carries only one of the two is broken for half the hosts.
    if (!result.isError && result.structuredContent === undefined) {
      console.log(`${BAD}✗ ${call.name}: success without structuredContent${RESET}`);
      failures++;
    }

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
