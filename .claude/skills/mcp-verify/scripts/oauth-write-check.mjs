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
 * On success it leaves a filter and a frame on the account that approves it —
 * and, with `--booth`, a whole booth, live at its own link. That is the point
 * — a write path that has never written is not verified — but it means this
 * is not a script to run idly: the booth round spends one full generation,
 * one redraw and three frame images of the account's allowance. Everything it
 * makes is named so it is obvious in a dashboard list and safe to delete.
 *
 * The token is never printed and never written to disk, same rule as
 * bearer-check. It is short-lived and revocable, which is exactly why it is
 * the credential allowed to do this.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { McpClient, payload, textOf } from "./mcp.mjs";

const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter((a) => a.startsWith("--")));
const CAPTURE_VALUE = (() => {
  const i = ARGS.indexOf("--capture");
  return i >= 0 ? ARGS[i + 1] : null;
})();
const [BASE_ARG, STUDIO_ARG] = ARGS.filter((a) => !a.startsWith("--") && a !== CAPTURE_VALUE);
const BASE = (BASE_ARG || "").replace(/\/$/, "");
const STUDIO = (STUDIO_ARG || "https://dreamboothstudio.com").replace(/\/$/, "");
if (!BASE) throw new Error("usage: node oauth-write-check.mjs <mcpBaseUrl> [studioUrl] [--booth]");
/** The booth round creates a real booth and spends real allowance: opt in. */
const WITH_BOOTH = FLAGS.has("--booth");
/**
 * `--capture <dir>` writes every tool's structuredContent to that directory, in
 * call order, as NNN-<tool>.json. The submission screenshots are rendered from
 * these files rather than from mock payloads written by hand: a card built from
 * a guess at the response is a drawing of the product, not a picture of it.
 *
 * Capturing also stops naming the booth "mcp-verify ...". create_booth defaults
 * the title and link to the DRAFT's own, which is what a real operator gets, so
 * the captured card shows the product rather than the test harness. The ids are
 * printed at the end for cleanup.
 */
const CAPTURE_DIR = (() => {
  const i = ARGS.indexOf("--capture");
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : null;
})();

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

// ---- the page the browser lands on -----------------------------------------
//
// The operator arrives here straight from the Studio's consent card, so this
// page borrows that card's shell — whiteout ground, white card, carbon ink, the
// gradient-ring mark from src/ui/shell.ts — instead of dropping them onto an
// unstyled sentence. Values are copied by hand from src/ui/tokens.ts, the same
// way that file copies them from the Studio; nothing is fetched, so the page is
// complete before the server behind it has closed.
//
// It says the one thing that matters at this point: where to look next. The
// code itself is already in the terminal's hands by the time this renders, and
// it is never written into the page.

const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<defs><linearGradient id="ring" x1="6" y1="1" x2="16" y2="23" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0" stop-color="#63ACA8"/><stop offset=".38" stop-color="#CC6CE6"/>' +
  '<stop offset=".72" stop-color="#F28BB1"/><stop offset="1" stop-color="#FFDE5A"/>' +
  "</linearGradient></defs>" +
  '<circle cx="12" cy="12" r="9.1" stroke="url(#ring)" stroke-width="1.8"/>' +
  '<circle cx="8.6" cy="9.1" r="2.6" fill="url(#ring)"/></svg>';

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * @param {"approved" | "failed" | "mismatch"} outcome
 * @param {{ error: string | null, description: string | null }} detail
 *   The `error` / `error_description` query params. They are text the
 *   redirecting party chose, so they are escaped before they reach the page.
 */
function callbackPage(outcome, detail) {
  // Cancel on the consent screen is the one failure the operator chose, and
  // the Studio marks it with access_denied and no description. Say so as a
  // choice, in a quiet tone, rather than as something that went wrong.
  const cancelled = outcome === "failed" && detail.error === "access_denied" && !detail.description;
  const reason = detail.description || detail.error;

  const { tone, title, body } = cancelled
    ? { tone: "quiet", title: "Cancelled", body: "Nothing was connected. You can close this tab." }
    : {
        approved: {
          tone: "ok",
          title: "Approved",
          body: "You can close this tab. The check is carrying on in your terminal.",
        },
        mismatch: {
          tone: "bad",
          title: "Not this check's approval",
          body:
            "This response doesn't match the request the terminal is waiting for. " +
            "Close this tab and start the check again.",
        },
        failed: {
          tone: "bad",
          title: "Not approved",
          body: reason
            ? `The Studio answered <code>${escapeHtml(reason)}</code>. Close this tab and run the check again.`
            : "No authorization code came back. Close this tab and run the check again.",
        },
      }[outcome];

  const icon = tone === "ok" ? '<path d="M5 12.5l4.5 4.5L19 7"/>' : '<path d="M7 7l10 10M17 7L7 17"/>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Dreambooth</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(MARK_SVG)}">
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
body{
  min-height:100vh;display:grid;place-items:center;padding:3.5rem 1.25rem;
  background:#FBFBFB;color:#333333;
  font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.card{
  width:100%;max-width:26rem;padding:1.75rem;
  background:#FFFFFF;border:1px solid #E5E7EB;border-radius:.5rem;
  box-shadow:0 1px 2px 0 rgb(0 0 0 / .05);
}
.brand{display:flex;align-items:center;gap:.5rem;margin-bottom:1.5rem;font-size:.875rem;font-weight:600;letter-spacing:-.01em}
.icon{width:2.75rem;height:2.75rem;margin-bottom:1rem;border-radius:9999px;display:grid;place-items:center}
.icon svg{width:1.5rem;height:1.5rem;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.ok{color:#025E4A;background:rgba(2,94,74,.10)}
.bad{color:#DC2E49;background:rgba(220,46,73,.10)}
.quiet{color:#6B7280;background:rgba(107,114,128,.12)}
h1{margin:0 0 .375rem;font-size:1.125rem;font-weight:600;letter-spacing:-.01em}
p{margin:0;font-size:.875rem;color:#6B7280}
code{
  padding:.0625rem .375rem;border-radius:.375rem;
  font:.8125rem ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#333333;background:#F9FAFB;border:1px solid #E5E7EB;
}
footer{
  display:flex;justify-content:space-between;gap:1rem;
  margin-top:1.5rem;padding-top:1rem;border-top:1px solid #E5E7EB;
  font-size:.75rem;color:#6B7280;
}
@media (prefers-color-scheme:dark){
  body{background:#121212;color:#EAEAEA}
  .card{background:#1D1D1D;border-color:#2E2E2E;box-shadow:none}
  p,footer{color:#9CA3AF}
  footer{border-color:#2E2E2E}
  code{color:#EAEAEA;background:#262626;border-color:#3A3A3A}
  .ok{color:#3DBF9A;background:rgba(61,191,154,.14)}
  .quiet{color:#9CA3AF;background:rgba(156,163,175,.14)}
}
</style>
</head>
<body>
<main class="card">
  <div class="brand">${MARK_SVG}<span>Dreambooth</span></div>
  <div class="icon ${tone}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div>
  <h1>${title}</h1>
  <p>${body}</p>
  <footer><span>mcp-verify · oauth-write-check</span><span>localhost:${PORT}</span></footer>
</main>
</body>
</html>
`;
}

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
    const mismatch = url.searchParams.get("state") !== state;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      callbackPage(mismatch ? "mismatch" : code ? "approved" : "failed", {
        error: err,
        description: url.searchParams.get("error_description"),
      })
    );
    server.close();
    if (mismatch) {
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
console.log("Open this and approve. READ THE CONSENT SCREEN — under \"It will be able to\"");
console.log("it should say: create photo filters and frames, design and create a new booth,");
console.log("and duplicate an existing booth:");
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
  let parsed = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) { parsed = JSON.parse(line.slice(6)); break; }
  }
  if (parsed === null) parsed = text.trim() ? JSON.parse(text.trim()) : null;
  capture(name, parsed);
  return parsed;
}

let captureSeq = 0;
/** Writes one tool response's structuredContent, in call order. */
function capture(name, parsed) {
  if (!CAPTURE_DIR) return;
  const content = parsed?.result?.structuredContent;
  if (!content) return;
  if (captureSeq === 0) mkdirSync(CAPTURE_DIR, { recursive: true });
  captureSeq += 1;
  const file = joinPath(CAPTURE_DIR, `${String(captureSeq).padStart(3, "0")}-${name}.json`);
  writeFileSync(file, JSON.stringify(content, null, 2), "utf8");
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
for (const t of [
  "create_filter",
  "duplicate_project",
  "start_frame",
  "refine_frame",
  "check_generation",
  "save_frame",
  "preview_filter",
  "start_booth",
  "refine_booth",
  "create_booth",
  "get_booth_draft",
  "update_booth_draft",
]) {
  ok(names.includes(t), `${t} appears in tools/list`);
}

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

// Preview first, the way an operator would: an image, and an honest list of
// what the preview cannot show.
const previewed = await call("preview_filter", {
  adjustments: { contrast: 112, saturation: 88, sepia: 18, shadows: 10 },
});
const previewOut = payload(previewed?.result);
ok(
  !previewed?.result?.isError && String(previewOut?.previewUrl || "").startsWith("https://"),
  "preview_filter returned an image URL",
  previewed?.result?.isError ? textOf(previewed.result).slice(0, 100) : String(previewOut?.previewUrl).slice(0, 90)
);
ok(
  Array.isArray(previewOut?.notPreviewed) && previewOut.notPreviewed.includes("shadows"),
  "preview_filter names what it cannot show",
  JSON.stringify(previewOut?.notPreviewed)
);

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

// The frame flow, the way an operator would run it: start, look, ask for one
// change, keep the second version. Two generations of the daily allowance per
// run — which is why this is not a script to run idly.

async function waitForGeneration(jobId, label) {
  console.log(`      waiting up to 2.5 minutes for the image model (${label})...`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const checked = payload((await call("check_generation", { jobId }))?.result);
    if (checked?.state && checked.state !== "running") return checked;
  }
  return null;
}

const started = await call("start_frame", {
  prompt: "warm gold batik motifs, generous margins",
  layout: "strip-3",
  shape: "rect",
});
const startOut = payload(started?.result);
let generated = null;
if (started?.result?.isError || !startOut?.jobId) {
  ok(false, "start_frame started", textOf(started?.result ?? {}).slice(0, 100));
} else {
  ok(true, "start_frame started", `job=${startOut.jobId}`);
  generated = await waitForGeneration(startOut.jobId, "first version");
  ok(
    generated?.state === "done" &&
      Boolean(generated?.imageUrl) &&
      Boolean(generated?.threadId) &&
      Boolean(generated?.generationId),
    "a preview was generated, with a threadId and generationId",
    generated
      ? `state=${generated.state} ${generated.imageUrl ?? generated.error ?? ""}`.slice(0, 110)
      : "still running after 2.5 minutes"
  );
}

let chosen = generated?.state === "done" ? generated : null;
if (chosen) {
  const refined = await call("refine_frame", {
    threadId: chosen.threadId,
    prompt: "the same, but darker and with less ornament",
  });
  const refineOut = payload(refined?.result);
  if (refined?.result?.isError || !refineOut?.jobId) {
    ok(false, "refine_frame started", textOf(refined?.result ?? {}).slice(0, 100));
  } else {
    ok(true, "refine_frame started", `job=${refineOut.jobId}`);
    const second = await waitForGeneration(refineOut.jobId, "refinement");
    const sameThread = second?.threadId === chosen.threadId;
    const newGeneration = Boolean(second?.generationId) && second.generationId !== chosen.generationId;
    ok(
      second?.state === "done" && sameThread && newGeneration,
      "the refinement landed in the same thread as a new generation",
      second
        ? `state=${second.state} thread=${sameThread ? "same" : "DIFFERENT"} generation=${newGeneration ? "new" : "SAME"}`
        : "still running after 2.5 minutes"
    );
    if (second?.state === "done") chosen = second;
  }
}

if (chosen) {
  const saved = await call("save_frame", {
    threadId: chosen.threadId,
    generationId: chosen.generationId,
    name: `mcp-verify ${stamp}`,
  });
  const savedOut = payload(saved?.result);
  ok(
    !saved?.result?.isError && Boolean(savedOut?.frameId),
    "save_frame created a frame from the chosen generation",
    saved?.result?.isError ? textOf(saved.result).slice(0, 100) : `id=${savedOut?.frameId}`
  );
}

// ---- 5. the booth round (opt-in) ---------------------------------------------
//
// start → check → refine once → check → create → check. A real booth, live at
// dreambooth.app/<slug>, on the approving account. Skipped without --booth.

async function waitForJob(jobId, label, maxMs) {
  console.log(`      waiting up to ${Math.round(maxMs / 60000)} minutes (${label})...`);
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10000));
    const checked = payload((await call("check_generation", { jobId }))?.result);
    if (checked?.progress) console.log(`      … ${checked.progress}`);
    if (checked?.state && checked.state !== "running") return checked;
  }
  return null;
}

if (WITH_BOOTH) {
  console.log("");
  console.log("The booth round:");
  console.log("");
  const boothStamp = new Date().toISOString().replace(/\D/g, "").slice(2, 12);

  const startedBooth = await call("start_booth", {
    prompt: "a warm gold wedding photobooth for a garden reception in Bandung, soft florals, elegant serif type",
    language: "en",
  });
  const startOut = payload(startedBooth?.result);
  let draft = null;
  if (startedBooth?.result?.isError || !startOut?.jobId) {
    ok(false, "start_booth started", textOf(startedBooth?.result ?? {}).slice(0, 100));
  } else {
    ok(true, "start_booth started", `job=${startOut.jobId}`);
    const designed = await waitForJob(startOut.jobId, "designing the booth", 6 * 60 * 1000);
    draft = designed?.draft ?? null;
    ok(
      designed?.state === "done" && Boolean(draft?.draftId) && Boolean(draft?.welcomePortraitUrl),
      "a booth draft was designed, with a welcome preview",
      designed ? `state=${designed.state} ${draft?.draftId ?? designed.error ?? ""}`.slice(0, 110) : "still running"
    );
  }

  if (draft) {
    const refined = await call("refine_booth", {
      draftId: draft.draftId,
      what: "welcome",
      orientation: "phone",
      instruction: "warmer, bigger headline",
    });
    const refineOut = payload(refined?.result);
    if (refined?.result?.isError || !refineOut?.jobId) {
      ok(false, "refine_booth started", textOf(refined?.result ?? {}).slice(0, 100));
    } else {
      ok(true, "refine_booth started", `job=${refineOut.jobId}`);
      const redrawn = await waitForJob(refineOut.jobId, "redrawing the welcome", 6 * 60 * 1000);
      ok(
        redrawn?.state === "done" && redrawn?.draft?.draftId === draft.draftId,
        "the redraw landed on the same draft",
        redrawn ? `state=${redrawn.state} regens left=${redrawn?.draft?.remainingRegens}`.slice(0, 110) : "still running"
      );
    }

    // Read the draft back, then change what a redraw cannot: the button
    // text, the photo count, and the filter made earlier in this run. The
    // Studio applies these at create, and the public project record says
    // whether it did — the one assertion here that reaches the booth itself.
    const readBack = payload((await call("get_booth_draft", { draftId: draft.draftId }))?.result);
    ok(
      readBack?.state === "done" && readBack?.draft?.draftId === draft.draftId,
      "get_booth_draft reads the draft back",
      readBack ? `title=${readBack.draft?.title}` : "no draft"
    );
    const edited = payload(
      (
        await call("update_booth_draft", {
          draftId: draft.draftId,
          buttonText: "Mulai",
          settings: { capture: { captureCount: 4 } },
          ...(filterOut?.id ? { filterIds: [filterOut.id] } : {}),
        })
      )?.result
    );
    ok(
      edited?.state === "done" &&
        Array.isArray(edited?.applied) &&
        edited.applied.includes("cta") &&
        edited.applied.includes("settings.capture.captureCount"),
      "update_booth_draft applied the button text and the photo count",
      edited ? `applied=${JSON.stringify(edited.applied)} rejected=${JSON.stringify(edited.rejected)}`.slice(0, 120) : "no reply"
    );
    ok(edited?.draft?.cta === "Mulai", "the draft now says the new button text", `cta=${edited?.draft?.cta}`);

    // Capturing: let title and link default to the draft's, the way a real
    // operator's booth is named. Otherwise mark it as this check's, so it is
    // obvious in a dashboard list and safe to delete.
    const created = await call("create_booth",
      CAPTURE_DIR
        ? { draftId: draft.draftId }
        : { draftId: draft.draftId, title: `mcp-verify ${stamp}`, slug: `mcp-verify-${boothStamp}` });
    const createOut = payload(created?.result);
    if (created?.result?.isError || !createOut?.jobId) {
      ok(false, "create_booth started", textOf(created?.result ?? {}).slice(0, 100));
    } else {
      ok(true, "create_booth started", `job=${createOut.jobId}`);
      const booth = await waitForJob(createOut.jobId, "drawing frames and creating the booth", 8 * 60 * 1000);
      ok(
        booth?.state === "done" && Boolean(booth?.booth?.slug) && Boolean(booth?.booth?.boothUrl),
        "the booth was actually created",
        booth ? `state=${booth.state} ${booth?.booth?.boothUrl ?? booth.error ?? ""}`.slice(0, 110) : "still running"
      );
      if (booth?.booth?.boothUrl) {
        console.log(`      booth: ${booth.booth.boothUrl}`);
        console.log(`      dashboard: ${booth.booth.dashboardUrl}`);
        // The public project record: did the edits reach the booth?
        try {
          const rec = await (await fetch(`${STUDIO}/api/projects/by-slug?slug=${encodeURIComponent(booth.booth.slug)}`)).json();
          ok(
            rec?.pages?.capture?.settings?.captureCount === 4,
            "the created booth carries the draft's photo count",
            `captureCount=${rec?.pages?.capture?.settings?.captureCount}`
          );
          const filters = rec?.pages?.filter?.settings?.filterIds ?? [];
          ok(
            !filterOut?.id || filters.includes(filterOut.id),
            "the created booth carries the filter made in this run",
            `filterIds=${JSON.stringify(filters).slice(0, 80)}`
          );
          const button = (rec?.pages?.welcome?.components ?? []).find((c) => c?.type === "button");
          ok(button?.text === "Mulai", "the created booth's welcome button says the new text", `text=${button?.text}`);
        } catch (err) {
          ok(false, "the created booth could be read back", String(err).slice(0, 80));
        }
      }
    }
  }
}

console.log("");
console.log("─".repeat(64));
console.log(`${pass} passed, ${fail} failed`);
if (!fail) {
  console.log("");
  console.log("The write path works end to end over OAuth. Delete the");
  console.log(`"mcp-verify ${stamp}" items (filter, frame${WITH_BOOTH ? ", booth" : ""}) from the dashboard when you are done.`);
}
process.exit(fail ? 1 : 0);
