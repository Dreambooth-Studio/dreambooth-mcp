/**
 * Proves the STATELESS path: a tool call carrying no session id, authenticated
 * only by `Authorization: Bearer`.
 *
 *   node bearer-check.mjs https://mcp.example.com
 *
 * This is the path OAuth will use, so it can be verified BEFORE an
 * authorization server exists. OAuth decides how a client *obtains* a token;
 * the transport path is identical either way. Any flow that hands a token to
 * its caller is enough to test it.
 *
 * Here that is the Studio's own device flow — the same three calls the MCP
 * server makes internally:
 *
 *   POST /api/auth/desktop/google/authorize {mode:"login"} -> { state, oauthUrl }
 *   ... operator approves in a browser ...
 *   GET  /api/auth/desktop/status?state=...                -> { sessionToken }
 *
 * THE TOKEN IS NEVER PRINTED AND NEVER WRITTEN TO DISK. It is a real
 * credential — currently a one-year, unscoped, unrevocable session JWT — so it
 * lives in this process's memory and dies with it. That property is exactly
 * what makes Half 2 worth doing; do not "improve" this script by caching it.
 */
import { McpClient, payload, textOf } from "./mcp.mjs";

const BASE = (process.argv[2] || "").replace(/\/$/, "");
const STUDIO = (process.argv[3] || "https://dreamboothstudio.com").replace(/\/$/, "");
if (!BASE) throw new Error("usage: node bearer-check.mjs <mcpBaseUrl> [studioUrl]");

const mask = (t) => `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} chars)`;

/**
 * Retries transport-level failures.
 *
 * Not defensive padding: a single ECONNRESET on the first call has already
 * killed a run here, and every run of this script costs a human a browser
 * approval. Anything before the token is in hand must survive a blip.
 */
async function fetchWithRetry(url, init, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---- 1. obtain a token the same way the server does -------------------------

const authorize = await fetchWithRetry(`${STUDIO}/api/auth/desktop/google/authorize`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ mode: "login" }),
});
if (!authorize.ok) throw new Error(`authorize failed: HTTP ${authorize.status}`);
const started = await authorize.json();
const url = started.oauthUrl || started.authUrl || started.url;
if (!started.state || !url) throw new Error("authorize returned no state/url");

console.log("\nOpen this and approve:\n");
console.log(`   ${url}\n`);
console.log("Waiting");

let token = null;
const deadline = Date.now() + 5 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const res = await fetch(
      `${STUDIO}/api/auth/desktop/status?state=${encodeURIComponent(started.state)}`
    );
    const s = await res.json();
    if (s.status === "completed" && s.sessionToken) { token = s.sessionToken; break; }
    if (s.status === "expired" || s.status === "not_found") break;
  } catch {
    // a failed poll is not a failed approval
  }
  process.stdout.write(".");
}
console.log("");

if (!token) {
  console.log("\nno token — link expired or approval not completed\n");
  process.exit(1);
}
console.log(`\ntoken obtained: ${mask(token)}\n`);

// ---- 2. use it with NO session id at all ------------------------------------

const TOOLS = [
  ["get_credits", {}],
  ["list_projects", {}],
  ["get_revenue_summary", {}],
  ["get_sessions", { limit: 3 }],
  ["get_gallery_stats", {}],
  ["get_wallet_transactions", { limit: 3 }],
  ["search_docs", { query: "printer", limit: 1 }],
];

/**
 * A brand-new client per call, with no session id and never an initialize.
 * That is deliberate: it is the harshest version of what ChatGPT on iOS and
 * macOS does, and it is what the 2026-07-28 spec makes universal.
 */
async function callStateless(name, args, tokenValue) {
  const res = await fetchWithRetry(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenValue}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) return { status: res.status, body: JSON.parse(line.slice(6)) };
  }
  return { status: res.status, body: text.trim() ? JSON.parse(text.trim()) : null };
}

console.log("Calling every tool with NO session id, bearer only:\n");
let pass = 0, fail = 0;

for (const [name, args] of TOOLS) {
  const { status, body } = await callStateless(name, args, token);
  if (status !== 200 || body?.error) {
    fail++;
    console.log(`FAIL  ${name}  [http ${status}] ${body?.error?.message ?? ""}`);
  } else if (body?.result?.isError) {
    fail++;
    console.log(`FAIL  ${name}  ${textOf(body.result).slice(0, 120)}`);
  } else {
    pass++;
    console.log(`OK    ${name}  ${JSON.stringify(payload(body.result)).slice(0, 90)}`);
  }
}

// A wrong token must be rejected readably, not accepted and not crash.
const bogus = await callStateless("get_credits", {}, `${token.slice(0, -4)}xxxx`);
const rejected = bogus.body?.result?.isError || bogus.body?.error;
console.log(`\n${rejected ? "OK  " : "FAIL"}  tampered token rejected`);
if (!rejected) fail++;

console.log("\n" + "─".repeat(64));
console.log(`${pass} passed, ${fail} failed`);
console.log(
  fail
    ? "\nThe stateless bearer path is NOT working. OAuth cannot fix this — it\nwould deliver a token down the same path that is failing here."
    : "\nThe stateless bearer path works end to end. OAuth's remaining job is\nonly to hand the client a token; the transport is proven."
);
process.exit(fail ? 1 : 0);
