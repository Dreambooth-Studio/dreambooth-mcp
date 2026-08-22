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

// Any tool needing auth must refuse in a way the client can act on.
//
// This used to insist on isError CONTENT and treat a protocol error as a bug.
// That was right before OAuth: a bare protocol error makes clients retry
// instead of relaying, which a user experiences as a hang. It is wrong now.
// The 401 challenge is deliberate — it carries WWW-Authenticate naming the
// authorization server, and that header is the entire reason a client offers
// to sign in rather than reporting a failure. A JSON-RPC error code -32001 is
// how that 401 surfaces through the SDK.
//
// So both shapes pass, and what is actually checked is that the refusal says
// something. An empty refusal is the real failure either way.
const authed = tools.find((t) => t.annotations?.readOnlyHint && !/doc|search|status|info/i.test(t.name));
if (authed) {
  const r = await client.callTool(authed.name, {});
  const challenge = r?.error && (r.error.code === -32001 || /sign in|connect|account/i.test(r.error.message ?? ""));
  if (challenge) ok(`${authed.name} unauthenticated → 401 challenge: ${String(r.error.message).slice(0, 60)}…`);
  else if (r?.error) bad(`${authed.name} unauthenticated → protocol error with no sign-in cue: ${r.error.message}`);
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

/* ------------------------------------------- reachable from a browser? --- */
//
// Everything above runs from Node, which does not enforce CORS. That blind
// spot cost five deploys: the ChatGPT portal's tool scan runs in a browser and
// reported only "Failed to fetch", while every terminal check passed. Three
// separate causes were found one at a time — no allow-origin at all, an
// invalid `*` + credentials pair, and fixed allow-lists that fail a preflight
// over one unexpected header.
//
// None of them can be caught by fetching. All of them can be caught by reading
// what a preflight answers with.

console.log("\n  browser reachability\n");

const ORIGIN = "https://platform.openai.com";

try {
  // An arbitrary header, which a fixed allow-list cannot satisfy. Doubles as a
  // deployment fingerprint: only a build that REFLECTS the request names it
  // back, so "fixed but not deployed" stops looking like "not fixed".
  const probeHeader = "x-probe-" + Math.random().toString(36).slice(2, 8);
  const res = await fetch(BASE + "/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type," + probeHeader,
    },
  });
  const h = res.headers;

  if (res.status === 200 || res.status === 204) ok("preflight on /mcp -> " + res.status);
  else bad("preflight on /mcp -> " + res.status);

  const allowOrigin = h.get("access-control-allow-origin");
  if (!allowOrigin) bad("no Access-Control-Allow-Origin - a browser cannot read any response");
  else ok("allow-origin: " + allowOrigin);

  // `*` with credentials is invalid CORS; browsers reject the pair outright
  // and report only "Failed to fetch".
  if (allowOrigin === "*" && h.get("access-control-allow-credentials") === "true") {
    bad("allow-origin `*` together with allow-credentials - invalid, browsers reject it");
  }

  const allowHeaders = (h.get("access-control-allow-headers") || "").toLowerCase();
  if (allowHeaders.includes(probeHeader)) ok("allow-headers reflects whatever the preflight asks for");
  else bad("allow-headers does not reflect the request (" + (allowHeaders || "absent") + ") - any client sending an unlisted header fails the preflight");

  const exposed = (h.get("access-control-expose-headers") || "").toLowerCase();
  const missing = ["mcp-session-id", "www-authenticate"].filter((n) => !exposed.includes(n));
  if (missing.length) bad("not exposed to browser clients: " + missing.join(", "));
  else ok("mcp-session-id and www-authenticate are exposed");
} catch (err) {
  bad("preflight on /mcp threw: " + (err && err.message ? err.message : err));
}

/* ------------------------------------------------------------ discovery --- */
//
// A client reads these BEFORE it has a token and builds its authorization
// request from them. The write tools once shipped while every one of these
// still advertised read-only, so no client would ever have asked for the scope
// it needed - and every unit test passed.

console.log("");

async function discovery(url, label) {
  try {
    const res = await fetch(url, { headers: { Origin: ORIGIN } });
    if (!res.ok) { bad(label + " -> " + res.status); return null; }
    if (!res.headers.get("access-control-allow-origin")) {
      bad(label + " -> 200 but no allow-origin, so a browser cannot read it");
      return null;
    }
    const doc = await res.json();
    ok(label + " -> 200" + (doc.scopes_supported ? ", scopes " + JSON.stringify(doc.scopes_supported) : ""));
    return doc;
  } catch (err) {
    bad(label + " threw: " + (err && err.message ? err.message : err));
    return null;
  }
}

const prm =
  (await discovery(BASE + "/.well-known/oauth-protected-resource/mcp", "protected-resource metadata")) ||
  (await discovery(BASE + "/.well-known/oauth-protected-resource", "protected-resource metadata (bare)"));

// The authorization server is on a different host, so it is the hop most
// likely to be missing CORS - and that failure looks identical to the resource
// being down.
const issuer = prm && prm.authorization_servers && prm.authorization_servers[0];
if (issuer) await discovery(issuer + "/.well-known/oauth-authorization-server", "authorization server metadata");
else if (prm) bad("protected-resource metadata names no authorization_servers");

console.log("");
console.log(fails ? `${fails} problem(s) found\n` : "all unauthenticated checks passed\n");
console.log("NOT verified: every tool requiring an account. Run connect.mjs + run-tools.mjs.\n");
process.exit(fails ? 1 : 0);
