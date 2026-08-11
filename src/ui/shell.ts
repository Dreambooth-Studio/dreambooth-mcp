import { baseCss } from "./tokens.js";

/**
 * The parts every widget shares: the document wrapper, the brand mark, and a
 * thin `window.__db` bridge over `window.openai`.
 *
 * The bridge exists because the Apps SDK surface is not uniform across hosts —
 * `openExternal`, `requestDisplayMode` and `notifyIntrinsicHeight` may all be
 * absent, and a widget that assumes them throws inside a sandboxed iframe with
 * no console anyone will read. Every call here feature-detects and degrades.
 */

/**
 * The Dreambooth mark, redrawn as SVG.
 *
 * The real asset is `/assets/images/dreambooth.png` in the Studio — 1768x442,
 * 57 kB. Base64-inlining that would quadruple the size of a 13 kB widget, and
 * linking it would force a `resourceDomains` entry in the CSP, which is the one
 * thing keeping these cards unable to talk to the network at all. So it is
 * redrawn: a gradient ring with an offset dot, using the same four brand
 * colours as `.text-gradient` in `app/globals.css` — veranda, purpleSnail,
 * sachetPink, rodanGold.
 *
 * The wordmark is live text rather than part of the drawing, so it inherits the
 * card's ink colour and stays legible in dark mode.
 */
export const LOGO_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><defs><linearGradient id="dbRing" x1="6" y1="1" x2="16" y2="23" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#63ACA8"/><stop offset=".38" stop-color="#CC6CE6"/><stop offset=".72" stop-color="#F28BB1"/><stop offset="1" stop-color="#FFDE5A"/></linearGradient></defs><circle cx="12" cy="12" r="9.1" stroke="url(#dbRing)" stroke-width="1.8"/><circle cx="8.6" cy="9.1" r="2.6" fill="url(#dbRing)"/></svg>`;

export function brandMark(label = "Dreambooth"): string {
  return `<div class="db-brand">${LOGO_SVG}<span>${label}</span></div>`;
}

/**
 * Escapes text that came from the Studio or from an operator's account before
 * it is written into the card. Email addresses come back from the device flow
 * and are rendered directly, so this is not theoretical.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")  
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * `window.__db` — feature-detected helpers, injected into every widget.
 *
 * Written without template literals on purpose: this string is itself embedded
 * in one, and a stray `${` would be interpolated by TypeScript instead of
 * reaching the browser.
 */
const BRIDGE_JS = `
(function () {
  var api = window.openai || {};
  var db = {};

  db.api = api;

  /**
   * A named function rather than an IIFE because the host can change locale
   * mid-conversation and re-publish globals. Computed once, db.locale would go
   * stale and db.t() would keep serving the old language forever.
   */
  function resolveLocale() {
    var raw = String(api.locale || "id").toLowerCase();
    if (raw.indexOf("es") === 0) return "es";
    if (raw.indexOf("en") === 0) return "en";
    return "id";
  }
  db.locale = resolveLocale();

  /** Picks a string for the active locale, falling back to Indonesian. */
  db.t = function (map) {
    return map[db.locale] || map.id;
  };

  db.applyTheme = function () {
    var theme = api.theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
  };

  /**
   * The document is authored with lang="id" because that is the fallback, but
   * the copy above switches at runtime. Left unsynced, a screen reader
   * pronounces English and Spanish text with Indonesian rules. Re-applied on
   * every globals event, since the host can change locale mid-conversation.
   */
  db.applyLang = function () {
    document.documentElement.lang = db.locale;
  };

  /** Reports height so the host does not clip or over-reserve space. */
  db.fit = function () {
    try {
      if (typeof api.notifyIntrinsicHeight === "function") {
        api.notifyIntrinsicHeight(document.documentElement.scrollHeight);
      }
    } catch (e) {}
  };

  /**
   * Calls an MCP tool and returns its structured payload.
   * Hosts differ on whether the structured result is unwrapped, so accept both.
   */
  db.callTool = function (name, args) {
    if (typeof api.callTool !== "function") {
      return Promise.reject(new Error("callTool unavailable"));
    }
    return api.callTool(name, args || {}).then(function (res) {
      if (res && typeof res === "object" && "structuredContent" in res) {
        return res.structuredContent;
      }
      return res;
    });
  };

  /** Sandboxed iframes cannot window.open; the host has to do it. */
  db.openExternal = function (href) {
    try {
      if (typeof api.openExternal === "function") {
        api.openExternal({ href: href });
        return true;
      }
    } catch (e) {}
    try {
      window.open(href, "_blank", "noopener");
      return true;
    } catch (e) {}
    return false;
  };

  /**
   * Asks the model to do something the widget cannot do itself.
   * Returns false when the host does not support it, so the caller can fall
   * back to telling the operator what to type.
   */
  db.followUp = function (prompt) {
    try {
      if (typeof api.sendFollowUpMessage === "function") {
        api.sendFollowUpMessage({ prompt: prompt });
        return true;
      }
    } catch (e) {}
    return false;
  };

  db.getState = function () {
    return (api.widgetState && typeof api.widgetState === "object") ? api.widgetState : {};
  };

  db.setState = function (state) {
    try {
      if (typeof api.setWidgetState === "function") api.setWidgetState(state);
    } catch (e) {}
  };

  db.toolOutput = function () {
    return api.toolOutput || {};
  };

  /** The host re-publishes globals (theme, locale, toolOutput) on this event. */
  window.addEventListener("openai:set_globals", function () {
    db.api = api = window.openai || api;
    db.locale = resolveLocale();
    db.applyTheme();
    db.applyLang();
    if (typeof db.onGlobals === "function") db.onGlobals();
  });

  db.applyTheme();
  db.applyLang();
  window.__db = db;
})();
`;

/**
 * Wraps a widget body into the single self-contained HTML document that gets
 * served as the UI resource. No external requests of any kind.
 */
export function widgetDocument(options: {
  title: string;
  body: string;
  script: string;
}): string {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${baseCss}</style>
</head>
<body>
${options.body}
<script>${BRIDGE_JS}</script>
<script>${options.script}</script>
</body>
</html>`;
}
