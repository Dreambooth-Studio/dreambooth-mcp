/**
 * Asks the one question a write check cannot: what does a client get when it
 * does NOT name a scope?
 *
 *   node scope-default-check.mjs https://mcp.dreamboothstudio.com
 *
 * `oauth-write-check.mjs` passes `scope=booths:read booths:write` explicitly,
 * so it exercises the one path that works and can never find a bug in the
 * default. That gap hid a real one through a whole directory review: an omitted
 * `scope` was defaulted to `booths:read`, while this server lists its write
 * tools to ANY bearer — the gate is "is there a token", not "which scope",
 * because the token is a next-auth JWE it has no key for. The result was a
 * connection that advertised nine write tools and refused every one of them,
 * behind a consent screen that truthfully said it could not change anything.
 * Every creation test case failed that way.
 *
 * So this walks the same OAuth path with the scope parameter LEFT OUT, and
 * reports three things:
 *
 *   1. the scope the token actually came back with
 *   2. whether the write tools are advertised to it anyway
 *   3. what happens when one is called
 *
 * SAFETY: the only write attempted is create_filter, and the expected result is
 * a refusal. If it is not refused, the filter's id is printed for deletion.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { callbackPage } from "./callback-page.mjs";

const ARGS = process.argv.slice(2);
const BASE = (ARGS[0] || "https://mcp.dreamboothstudio.com").replace(/\/$/, "");
const STUDIO = (ARGS[1] || "https://dreamboothstudio.com").replace(/\/$/, "");

const PORT = Number(process.env.OAUTH_CHECK_PORT || 8765);
// localhost, not 127.0.0.1 — see the note in oauth-write-check.mjs: the Studio
// rewrites one to the other between register and authorize, and the exact-match
// check then never matches.
const REDIRECT = `http://localhost:${PORT}/callback`;

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

let pass = 0;
let fail = 0;
const ok = (good, label, detail = "") => {
  good ? pass++ : fail++;
  console.log(`${good ? "OK  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};
const rule = (text) => {
  console.log("");
  console.log("=".repeat(70));
  console.log(text);
  console.log("=".repeat(70));
};

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

// ---- 1. register ------------------------------------------------------------
const reg = await (
  await fetch(`${STUDIO}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "mcp-verify scope default check",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  })
).json();
ok(Boolean(reg.client_id), "client registered");
// What the client was TOLD it may ask for. The gap between this and the granted
// scope below is the whole bug.
ok(
  String(reg.scope || "").includes("booths:write"),
  "registration advertises the write scope",
  JSON.stringify(reg.scope)
);

// ---- 2. authorize, with no scope parameter ----------------------------------
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

const authorize = new URL(`${STUDIO}/api/oauth/authorize`);
authorize.searchParams.set("client_id", reg.client_id);
authorize.searchParams.set("redirect_uri", REDIRECT);
authorize.searchParams.set("response_type", "code");
// Deliberately NOT set. That is the experiment.
authorize.searchParams.set("state", state);
authorize.searchParams.set("code_challenge", challenge);
authorize.searchParams.set("code_challenge_method", "S256");
authorize.searchParams.set("resource", `${BASE}/mcp`);

console.log("");
console.log("Open this and approve. READ THE CONSENT SCREEN — the question is");
console.log("whether it offers to create anything, or only to read:");
console.log("");
console.log(`   ${authorize.toString()}`);
console.log("");
console.log("Waiting for approval...");

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const got = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    const mismatch = Boolean(got) && url.searchParams.get("state") !== state;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      callbackPage(mismatch ? "mismatch" : got ? "approved" : "failed", {
        error: err,
        description: url.searchParams.get("error_description"),
      }, { script: "scope-default-check", port: PORT })
    );
    server.close();
    if (mismatch) reject(new Error("state did not match"));
    else if (got) resolve(got);
    else reject(new Error(err || "no code"));
  });
  server.listen(PORT);
  setTimeout(() => {
    server.close();
    reject(new Error("timed out waiting for approval"));
  }, 10 * 60 * 1000);
});
ok(true, "authorization code received");

// ---- 3. exchange ------------------------------------------------------------
const granted = await (
  await fetch(`${STUDIO}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  })
).json();

const token = granted.access_token;
if (!token) {
  ok(false, "token exchange", JSON.stringify(granted).slice(0, 200));
  process.exit(1);
}

const grantedScope = String(granted.scope || "");
const readOnly = grantedScope === "booths:read";
rule(`1. scope granted when none was requested: ${JSON.stringify(grantedScope)}`);
ok(
  grantedScope.includes("booths:write"),
  "the grant matches what registration advertised",
  readOnly ? "read-only: a client that said nothing was given less than it may ask for" : ""
);

// ---- 4. what is advertised to it? -------------------------------------------
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  for (const line of text.split("\n")) if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
  return text.trim() ? JSON.parse(text.trim()) : null;
}

const WRITES = [
  "create_filter", "duplicate_project", "start_frame", "refine_frame", "save_frame",
  "start_booth", "refine_booth", "create_booth", "update_booth_draft",
];
const names = ((await rpc("tools/list", {}))?.result?.tools ?? []).map((t) => t.name);
const visible = WRITES.filter((w) => names.includes(w));

rule(`2. tools advertised: ${names.length}, of which write tools: ${visible.length}`);
ok(
  !(readOnly && visible.length > 0),
  "the advertised tools match what the grant can do",
  visible.length ? JSON.stringify(visible) : "no write tools advertised"
);

// ---- 5. call one ------------------------------------------------------------
const called = await rpc("tools/call", {
  name: "create_filter",
  arguments: { name: `scope-check ${stamp}`, adjustments: { contrast: 104, saturation: 96 } },
});
const result = called?.result ?? {};
const said = (result.content ?? []).map((c) => c.text).filter(Boolean).join(" ");
const createdId = result.structuredContent?.id;

rule("3. calling create_filter with that token");
console.log(`   isError : ${result.isError === true}`);
console.log(`   created : ${createdId ? `YES  id=${createdId}` : "no"}`);
console.log(`   says    : ${said.slice(0, 300) || JSON.stringify(called).slice(0, 300)}`);

console.log("");
if (readOnly && visible.length > 0 && !createdId) {
  console.log("The bug is present: an omitted scope yields a read-only grant, the");
  console.log("write tools are advertised to it anyway, and calling one is refused.");
  console.log("A connection that promises what it cannot do.");
} else if (!readOnly && visible.length > 0 && createdId) {
  console.log(`Fixed: an omitted scope inherited the registration and the write worked.`);
  console.log(`Delete the filter it made: ${createdId}`);
} else if (createdId) {
  console.log(`Unexpected: the write SUCCEEDED on a ${JSON.stringify(grantedScope)} grant.`);
  console.log(`Delete filter ${createdId} and treat this as a scope-enforcement bug.`);
} else {
  console.log("Neither the old shape nor the fixed one. Read the three answers above.");
}

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
