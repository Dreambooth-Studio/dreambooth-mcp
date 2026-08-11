/**
 * Everything checkable about a deployed MCP server WITHOUT an account.
 *
 *   node probe.mjs https://mcp.example.com
 *
 * Exits non-zero if anything a directory portal would reject is missing.
 *
 * What this CANNOT tell you: whether the authenticated tools work. The SDK
 * skips output-schema validation when isError is set, so a refusal proves
 * nothing. Use connect.mjs + run-tools.mjs for that.
 */
import { McpClient, payload, textOf } from "./mcp.mjs";

const BASE = (process.argv[2] || "").replace(/\/$/, "");
if (!BASE) throw new Error("usage: node probe.mjs <baseUrl>");

let fails = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => { fails++; console.log(`  FAIL ${m}`); };
const info = (m) => console.log(`  --   ${m}`);

console.log(`\nProbing ${BASE}\n`);

// /health is conventional, not required — report it, never fail on it.
try {
  const res = await fetch(`${BASE}/health`);
  info(`/health → ${res.status} ${(await res.text()).slice(0, 100)}`);
} catch {
  info("/health → absent (fine; not part of the MCP spec)");
}

const client = new McpClient(BASE);
const init = await client.handshake();
const server = init?.result?.serverInfo;
client.sessionId
  ? ok(`handshake → ${server?.name} ${server?.version}, session assigned`)
  : bad("no Mcp-Session-Id header returned");
info(`capabilities: ${JSON.stringify(init?.result?.capabilities ?? {})}`);

const tools = (await client.rpc("tools/list"))?.result?.tools ?? [];
console.log(`\n  tools/list → ${tools.length}\n`);
console.log("  tool".padEnd(28) + "title  readOnly  destructive  openWorld  outputSchema");
console.log("  " + "-".repeat(76));

for (const t of tools) {
  const a = t.annotations ?? {};
  const hasTitle = Boolean(a.title || t.title);
  const triple =
    typeof a.readOnlyHint === "boolean" &&
    typeof a.destructiveHint === "boolean" &&
    typeof a.openWorldHint === "boolean";
  const complete = hasTitle && triple && Boolean(t.outputSchema);
  if (!complete) fails++;
  console.log(
    "  " + t.name.padEnd(26) +
    (hasTitle ? "yes" : "NO ").padEnd(7) +
    String(a.readOnlyHint ?? "MISSING").padEnd(10) +
    String(a.destructiveHint ?? "MISSING").padEnd(13) +
    String(a.openWorldHint ?? "MISSING").padEnd(11) +
    (t.outputSchema ? "yes" : "MISSING") +
    (complete ? "" : "   <-- portal rejects")
  );
}
console.log("");

// Widgets attach as resources; "Method not found" means there is nowhere to
// attach one, which is a different problem from having none registered.
const res = await client.rpc("resources/list");
if (res?.error) info(`resources/list → not supported (${res.error.message})`);
else {
  const list = res?.result?.resources ?? [];
  info(`resources/list → ${list.length}${list.length ? ": " + list.map((r) => r.uri).join(", ") : ""}`);
}

// An unknown session id is what every reconnecting client sends. It must be a
// clean 404, never a 500.
const bogus = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": "does-not-exist",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
bogus.status === 404 ? ok("unknown session id → 404") : bad(`unknown session should 404, got ${bogus.status}`);

// Any tool needing auth must refuse READABLY. A protocol error here makes
// clients retry instead of relaying, which the user experiences as a hang.
const authed = tools.find((t) => t.annotations?.readOnlyHint && !/doc|search|status|info/i.test(t.name));
if (authed) {
  const r = await client.callTool(authed.name, {});
  if (r?.error) bad(`${authed.name} unauthenticated → protocol error, must be isError content: ${r.error.message}`);
  else if (!r?.result?.isError) info(`${authed.name} returned data without auth — is it meant to be public?`);
  else ok(`${authed.name} unauthenticated → readable refusal: ${textOf(r.result).slice(0, 70)}…`);
}

// A tool that succeeds without auth is the only success path this script can
// reach — take it, because it is the one chance to see structuredContent.
const open = tools.find((t) => /search|docs|public/i.test(t.name));
if (open) {
  const r = await client.callTool(open.name, { query: "test", limit: 1 });
  if (r?.error) bad(`${open.name} → protocol error (likely an outputSchema mismatch): ${r.error.message}`);
  else if (r?.result?.isError) info(`${open.name} → ${textOf(r.result).slice(0, 70)}…`);
  else if (!r.result?.structuredContent) bad(`${open.name} succeeded but returned no structuredContent`);
  else ok(`${open.name} → structuredContent present, schema validated by the SDK`);
}

await client.close();
console.log("");
console.log(fails ? `${fails} problem(s) found\n` : "all unauthenticated checks passed\n");
console.log("NOT verified: every tool requiring an account. Run connect.mjs + run-tools.mjs.\n");
process.exit(fails ? 1 : 0);
