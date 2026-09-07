/**
 * The page the browser lands on after an OAuth check, shared by every script
 * here that hands the operator a link.
 *
 * It used to live inside oauth-write-check.mjs. A second check that opens a
 * consent screen — scope-default-check.mjs — landed the operator on an
 * unstyled sentence instead, which reads as a broken redirect at exactly the
 * moment they are deciding whether this thing is trustworthy. One card, one
 * place.
 *
 * `where` names the script and port for the footer, since the page can no
 * longer read either from module scope.
 */
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
export function callbackPage(outcome, detail, where) {
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
  <footer><span>mcp-verify · ${escapeHtml(where.script)}</span><span>localhost:${where.port}</span></footer>
</main>
</body>
</html>
`;
}
