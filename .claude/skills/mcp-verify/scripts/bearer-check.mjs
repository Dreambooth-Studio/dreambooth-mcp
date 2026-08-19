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

// ---- 0. discovery, before anyone opens a browser ---------------------------
//
// Runs first because it is free and because everything after it costs a human
// a browser approval — but mainly because this is the failure that hides.
//
// A client does not guess which scopes it may ask for; it reads them from
// these documents before it has a token. The write tools once shipped while
// every one of them still said `booths:read` alone, which meant no client
// would ever request `booths:write`, no operator would be offered it on the
// consent screen, and every write would come back 403 telling them to approve
// a permission nothing had asked for. Every unit test passed. Only a live
// deployment can answer this, which is why it is here and not in `npm test`.

const WANT_SCOPES = ["booths:read", "booths:write"];

async function checkDiscovery() {
  let bad = 0;
  const ok = (good, label, detail = "") => {
    if (!good) bad++;
    console.log(`${good ? "OK  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  };

  console.log("Discovery documents:");
  console.log("");

  // Both spellings. RFC 9728 §3.1 puts the resource path in the well-known
  // URL and clients build that themselves, so a client may only ever see one
  // of these — whichever it finds is where it reads the scopes from.
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    try {
      const res = await fetchWithRetry(`${BASE}${path}`);
      const doc = await res.json();
      const scopes = doc.scopes_supported ?? [];
      ok(
        WANT_SCOPES.every((sc) => scopes.includes(sc)),
        `${path} advertises both scopes`,
        JSON.stringify(scopes)
      );
      ok(Array.isArray(doc.authorization_servers) && doc.authorization_servers.length > 0,
        `${path} names an authorization server`);
    } catch (err) {
      ok(false, `${path} readable`, String(err?.message ?? err));
    }
  }

  try {
    const res = await fetchWithRetry(`${STUDIO}/.well-known/oauth-authorization-server`);
    const doc = await res.json();
    const scopes = doc.scopes_supported ?? [];
    // The Studio is the authority: it can only GRANT what is listed here, so a
    // scope advertised by the resource but missing here is unobtainable.
    ok(
      WANT_SCOPES.every((sc) => scopes.includes(sc)),
      "authorization server advertises both scopes",
      JSON.stringify(scopes)
    );
  } catch (err) {
    ok(false, "authorization server metadata readable", String(err?.message ?? err));
  }

  // The 401 is the other place a client learns what it may ask for, and for
  // some clients the only one — not every client fetches the document above
  // before building its authorization request.
  try {
    const res = await fetchWithRetry(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_credits", arguments: {} },
      }),
    });
    const challenge = res.headers.get("www-authenticate") ?? "";
    ok(res.status === 401, "an unauthenticated tool call is refused", `http ${res.status}`);
    ok(/resource_metadata=/.test(challenge), "the challenge names where the metadata lives");
    ok(
      WANT_SCOPES.every((sc) => challenge.includes(sc)),
      "the challenge names the scopes a client may request",
      challenge.match(/scope="[^"]*"/)?.[0] ?? "no scope parameter"
    );
  } catch (err) {
    ok(false, "401 challenge reachable", String(err?.message ?? err));
  }

  return bad;
}

const discoveryFailures = await checkDiscovery();
if (discoveryFailures) {
  console.log("");
  console.log(discoveryFailures + " discovery check(s) failed. Stopping here rather than");
  console.log("asking anyone to approve a browser flow: a client that cannot discover");
  console.log("the right scopes will connect and then fail on its first write, which");
  console.log("is a much harder failure to read than this one.");
  process.exit(1);
}
console.log("");

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
 * Tools that must be REFUSED on this path, and refused readably.
 *
 * This is the security property the write scope was built around, and until
 * now nothing had ever asked the live Studio about it. The token this script
 * holds comes from the device flow: one year, no scope, no revocation. It must
 * not be able to create anything, and the Studio enforces that independently
 * of the MCP server via `judgeBearerWrite` returning "unscoped".
 *
 * Inverted expectations, so read the results carefully:
 *
 *   PASS = the call came back as a refusal with a sentence a model can relay
 *   FAIL = something was CREATED, which is a hole in the guard, or the refusal
 *          was unreadable, which leaves an operator with nothing to act on
 *
 * The arguments are deliberately identifiable. If one of these ever does get
 * through, the row it leaves behind should say where it came from rather than
 * looking like something the operator made.
 */
const MUST_REFUSE = [
  // Synchronous, and the real test: if the guard has a hole this CREATES a
  // filter, which is why the name says so.
  ["create_filter", { name: "bearer-check MUST-NOT-EXIST", adjustments: { contrast: 101 } }],
  // Deliberately a bogus project id. Auth now runs before the source lookup,
  // so a hole in the guard shows up as a 404 rather than as a duplicated
  // booth — a canary that cannot cost anything even when it fires.
  ["duplicate_project", { projectId: "000000000000000000000000" }],
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

// ---- writes must be refused on this path ------------------------------------

console.log("");
console.log("Attempting writes with the device-flow token (all must be REFUSED):");
console.log("");

for (const [name, args] of MUST_REFUSE) {
  const { status, body } = await callStateless(name, args, token);
  const errText = body?.error?.message ?? (body?.result?.isError ? textOf(body.result) : "");

  if (!errText) {
    // Nothing refused it. Either the tool is absent (registration gate), which
    // is fine but proves nothing about the Studio, or something was created.
    const created = JSON.stringify(payload(body?.result) ?? {}).slice(0, 120);
    fail++;
    console.log(`FAIL  ${name}  NOT refused -> ${created}`);
    console.log(`      Check the dashboard: this may have created something.`);
  } else if (/unscoped|read-only|cannot create|sign-in|Unauthorized/i.test(errText)) {
    pass++;
    console.log(`OK    ${name}  refused: ${errText.slice(0, 100)}`);
  } else {
    // Refused, but not for the reason we are testing. Worth a look rather than
    // a pass: a 500 also "refuses", and would hide the guard never running.
    fail++;
    console.log(`FAIL  ${name}  refused for the wrong reason: ${errText.slice(0, 100)}`);
  }
}

/**
 * generate_frame cannot be checked the same way: it returns a job handle
 * immediately and the Studio call happens in the background, so a synchronous
 * look at its result would report "not refused" no matter what happened. The
 * refusal is only visible through check_generation.
 *
 * Worth checking rather than skipping — of the three write tools this is the
 * one that costs something if the guard leaks, because generation spends a
 * slice of the operator's daily allowance.
 */
{
  const started = await callStateless(
    "generate_frame",
    {
      stylePrompt: "bearer-check must not exist",
      size: "strip-2x6",
      placeholderCount: 1,
      layoutIntent: "single",
    },
    token
  );
  const startedErr =
    started.body?.error?.message ??
    (started.body?.result?.isError ? textOf(started.body.result) : "");

  if (startedErr) {
    pass++;
    console.log(`OK    generate_frame  refused before starting: ${startedErr.slice(0, 80)}`);
  } else {
    // It started. The refusal, if the guard works, lands on the job.
    const jobId = payload(started.body?.result)?.jobId;
    await new Promise((r) => setTimeout(r, 6000));
    const checked = await callStateless("check_generation", jobId ? { jobId } : {}, token);
    const job = payload(checked.body?.result) ?? {};

    if (job.state === "failed" && /unscoped|read-only|cannot create/i.test(job.error ?? "")) {
      pass++;
      console.log(`OK    generate_frame  job refused by the Studio: ${String(job.error).slice(0, 80)}`);
    } else if (job.state === "running") {
      fail++;
      console.log(`FAIL  generate_frame  still running after 6s — the Studio did NOT refuse it fast.`);
      console.log(`      Re-check check_generation; if it completes, the guard has a hole.`);
    } else {
      fail++;
      console.log(`FAIL  generate_frame  state=${job.state} error=${String(job.error ?? "").slice(0, 80)}`);
      console.log(`      If state is "done", a frame was CREATED by an unscoped token.`);
    }
  }
}

console.log("");
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
