/**
 * Proves the thing nothing else can: that a connector can actually CREATE.
 *
 *   node oauth-write-check.mjs https://mcp.dreamboothstudio.com
 *
 * `bearer-check.mjs` uses the device flow, whose token is one year, unscoped
 * and unrevocable — and is therefore REFUSED on every write by design. So it
 * can prove the guard holds and can never prove the feature works. Those are
 * different questions and they need different credentials.
 *
 * This walks the real OAuth 2.1 path end to end, the same one ChatGPT and
 * Claude walk when an operator adds the connector:
 *
 *   POST /api/oauth/register            -> client_id (RFC 7591, open by design)
 *   GET  /api/oauth/authorize?...       -> the consent screen, in a browser
 *   ... operator approves ...
 *   -> redirect to 127.0.0.1 with a code
 *   POST /api/oauth/token               -> access token carrying booths:write
 *
 * and then calls every write tool for real.
 *
 * ## This creates things
 *
 * On success it leaves a filter and a frame on the account that approves it.
 * That is the point — a write path that has never written is not verified —
 * but it means this is not a script to run idly. Everything it makes is named
 * so it is obvious in a dashboard list and safe to delete.
 *
 * The token is never printed and never written to disk, same rule as
 * bearer-check. It is short-lived and revocable, which is exactly why it is
 * the credential allowed to do this.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { McpClient, payload, textOf } from "./mcp.mjs";

const BASE = (process.argv[2] || "").replace(/\/$/, "");
const STUDIO = (process.argv[3] || "https://dreamboothstudio.com").replace(/\/$/, "");
if (!BASE) throw new Error("usage: node oauth-write-check.mjs <mcpBaseUrl> [studioUrl]");

const PORT = Number(process.env.OAUTH_CHECK_PORT || 8765);
/**
 * `localhost`, NOT `127.0.0.1`, and this is not a preference.
 *
 * The Studio's register route accepts both — `isAcceptableRedirectUri` names
 * `127.0.0.1` explicitly — but by the time `/api/oauth/authorize` compares the
 * incoming `redirect_uri` against what was stored, `127.0.0.1` has been
 * rewritten to `localhost`. So a client that registers the literal
 * `127.0.0.1` stores a value that the exact-match check can never match, and
 * every authorize returns "redirect_uri does not match this client's
 * registration" with nothing visibly wrong at either end.
 *
 * Verified in production: registering ONLY `http://localhost:8765/callback`
 * then authorizing with either spelling succeeds; registering only the
 * `127.0.0.1` spelling fails both.
 */
const REDIRECT = `http://localhost:${PORT}/callback`;
const WANT_SCOPE = "booths:read booths:write";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

let pass = 0;
let fail = 0;
const ok = (good, label, detail = "") => {
  good ? pass++ : fail++;
  console.log(`${good ? "OK  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};

// ---- 1. register a client ---------------------------------------------------
//
// Dynamic registration is open, which is correct and worth restating: a client
// id is not a credential. It grants nothing until a specific operator approves
// a specific scope on a screen that names it.

const reg = await fetch(`${STUDIO}/api/oauth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "mcp-verify write check",
    redirect_uris: [REDIRECT],
  }),
});
if (!reg.ok) throw new Error(`register failed: HTTP ${reg.status} ${await reg.text()}`);
const client = await reg.json();
ok(Boolean(client.client_id), "client registered");

// The scope the registration response advertises is what a real client reads
// to decide what to ask for. This is the exact field that, when it said
// "booths:read" alone, made the whole write feature unreachable.
ok(
  String(client.scope || "").includes("booths:write"),
  "registration advertises the write scope",
  JSON.stringify(client.scope)
);

// ---- 2. authorize -----------------------------------------------------------

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

const authUrl = new URL(`${STUDIO}/api/oauth/authorize`);
authUrl.searchParams.set("client_id", client.client_id);
authUrl.searchParams.set("redirect_uri", REDIRECT);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", WANT_SCOPE);
authUrl.searchParams.set("state", state);
authUrl.searchParams.set("code_challenge", challenge);
authUrl.searchParams.set("code_challenge_method", "S256");
// RFC 8707. Names which resource the token is for, so it cannot be replayed
// against a different one.
authUrl.searchParams.set("resource", `${BASE}/mcp`);

const codePromise = new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (!url.pathname.startsWith("/callback")) {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<body style="font:16px system-ui;padding:3rem">${
        code ? "Approved. You can close this tab." : `Failed: ${err || "no code"}`
      }</body>`
    );
    server.close();
    if (url.searchParams.get("state") !== state) {
      reject(new Error("state mismatch — the redirect did not come from our request"));
    } else if (code) {
      resolve(code);
    } else {
      reject(new Error(err || "no code returned"));
    }
  });
  server.listen(PORT);
  setTimeout(() => {
    server.close();
    reject(new Error("timed out waiting for approval"));
  }, 5 * 60 * 1000);
});

console.log("");
console.log("Open this and approve. READ THE CONSENT SCREEN — it should list");
console.log('creating filters and duplicating a booth under "It will be able to":');
console.log("");
console.log(`   ${authUrl}`);
console.log("");
console.log("Waiting for approval...");

const code = await codePromise;
console.log("");
ok(true, "authorization code received");

// ---- 3. exchange for a token ------------------------------------------------

const tokenRes = await fetch(`${STUDIO}/api/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
  }),
});
if (!tokenRes.ok) throw new Error(`token exchange failed: HTTP ${tokenRes.status} ${await tokenRes.text()}`);
const granted = await tokenRes.json();
const token = granted.access_token;
if (!token) throw new Error("no access_token in the token response");

// The whole point. A token that came back read-only means the operator was
// never offered the write scope, or narrowScope dropped it.
ok(
  String(granted.scope || "").includes("booths:write"),
  "the granted token carries booths:write",
  JSON.stringify(granted.scope)
);
ok(Number(granted.expires_in) > 0 && Number(granted.expires_in) <= 3600,
  "the token is short-lived", `expires_in=${granted.expires_in}`);

// ---- 4. do the writes -------------------------------------------------------

async function call(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
  }
  return text.trim() ? JSON.parse(text.trim()) : null;
}

console.log("");
console.log("The write tools should now be visible AND working:");
console.log("");

// tools/list with this token must include them — a reviewer scanning the
// inventory while connected sees what the listing describes.
const listed = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
const listedText = await listed.text();
const names = [...listedText.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
for (const t of ["create_filter", "duplicate_project", "generate_frame", "check_generation"]) {
  ok(names.includes(t), `${t} appears in tools/list`);
}

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

const filter = await call("create_filter", {
  name: `mcp-verify ${stamp}`,
  adjustments: { contrast: 112, saturation: 88, sepia: 18 },
});
const filterOut = payload(filter?.result);
ok(
  !filter?.result?.isError && Boolean(filterOut?.id),
  "create_filter created a filter",
  filter?.result?.isError ? textOf(filter.result).slice(0, 100) : `id=${filterOut?.id}`
);

const frame = await call("generate_frame", {
  stylePrompt: "warm gold batik motifs, generous margins",
  size: "strip-2x6",
  placeholderCount: 3,
  layoutIntent: "strip",
  name: `mcp-verify ${stamp}`,
});
const frameOut = payload(frame?.result);
if (frame?.result?.isError || !frameOut?.jobId) {
  ok(false, "generate_frame started", textOf(frame?.result ?? {}).slice(0, 100));
} else {
  ok(true, "generate_frame started", `job=${frameOut.jobId}`);
  console.log("      waiting up to 2 minutes for the image model...");
  let done = null;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const checked = payload((await call("check_generation", { jobId: frameOut.jobId }))?.result);
    if (checked?.state && checked.state !== "running") {
      done = checked;
      break;
    }
  }
  ok(
    done?.state === "done" && Boolean(done?.frameId),
    "the frame was actually created",
    done ? `state=${done.state} ${done.frameId ?? ""}` : "still running after 2 minutes"
  );
  /**
   * The whole error, not a slice of it.
   *
   * This was truncated to 110 characters and cost a diagnosis: a Vertex 404
   * names the full publisher-model path, and the project, region and model id
   * in it are the three things you need to tell "wrong region" apart from
   * "model does not exist for this project". The first 110 characters contain
   * exactly enough to see that something is wrong and not enough to say what.
   */
  if (done?.error) {
    console.log("");
    console.log("      full error:");
    console.log(`      ${String(done.error)}`);
  }
}

console.log("");
console.log("─".repeat(64));
console.log(`${pass} passed, ${fail} failed`);
if (!fail) {
  console.log("");
  console.log("The write path works end to end over OAuth. Delete the two");
  console.log(`"mcp-verify ${stamp}" items from the dashboard when you are done.`);
}
process.exit(fail ? 1 : 0);
