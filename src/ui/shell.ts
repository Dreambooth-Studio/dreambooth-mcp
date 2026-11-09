import { baseCss } from "./tokens.js";

/**
 * The parts every widget shares: the document wrapper, the brand mark, and a
 * thin `window.__db` bridge over `window.openai` and the MCP Apps postMessage
 * protocol.
 *
 * The bridge exists because the Apps SDK surface is not uniform across hosts —
 * `openExternal`, `requestDisplayMode` and `notifyIntrinsicHeight` may all be
 * absent, and a widget that assumes them throws inside a sandboxed iframe with
 * no console anyone will read. Every call here feature-detects and degrades.
 *
 * The handshake is written by hand rather than taken from
 * `@modelcontextprotocol/ext-apps` because these cards are one self-contained
 * document with no build step and no script origin in their CSP.
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

  /** Inside a host's iframe, as opposed to opened directly (npm run preview). */
  var embedded = window.parent !== window;
  /** True once the host has answered ui/initialize. */
  var bridgeReady = false;
  /** Theme and locale from ui/initialize; empty on a window.openai-only host. */
  var hostContext = {};
  var nextRequestId = 1;
  var pendingRequests = {};
  /** The last result the host handed over through the MCP Apps protocol. */
  var delivered = null;
  /** No result yet, and one can still arrive once the handshake is done. */
  var waitingForOutput = embedded && !api.toolOutput;
  var outputTimer = null;
  var NO_OUTPUT_MS = 8000;
  var REQUEST_TIMEOUT_MS = 30000;

  /**
   * A named function rather than an IIFE because the host can change locale
   * mid-conversation and re-publish globals. Computed once, db.locale would go
   * stale and db.t() would keep serving the old language forever.
   */
  function resolveLocale() {
    var raw = String(hostContext.locale || api.locale || "id").toLowerCase();
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
    var theme = (hostContext.theme || api.theme) === "dark" ? "dark" : "light";
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
    reportSize();
  };

  /**
   * Calls an MCP tool and returns its structured payload.
   * Hosts differ on whether the structured result is unwrapped, so accept both.
   */
  db.callTool = function (name, args) {
    var call;
    if (typeof api.callTool === "function") {
      call = api.callTool(name, args || {});
    } else if (bridgeReady) {
      call = request("tools/call", { name: name, arguments: args || {} });
    } else {
      return Promise.reject(new Error("callTool unavailable"));
    }
    return call.then(function (res) {
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
    if (bridgeReady) {
      request("ui/open-link", { url: href }).catch(function () {});
      return true;
    }
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
    if (bridgeReady) {
      request("ui/message", { role: "user", content: [{ type: "text", text: prompt }] }).catch(function () {});
      return true;
    }
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
    return delivered || api.toolOutput || {};
  };

  /** True while the card has nothing to draw yet but may still be given it. */
  db.isWaiting = function () {
    return waitingForOutput;
  };

  var LOADING = { id: "Memuat…", en: "Loading…", es: "Cargando…" };

  db.showLoading = function (target) {
    target.innerHTML =
      '<div class="db-status"><span class="db-spinner" aria-hidden="true"></span><span>' +
      db.t(LOADING) + '</span></div>';
    db.fit();
  };

  function refreshContext() {
    db.locale = resolveLocale();
    db.applyTheme();
    db.applyLang();
    if (typeof db.onGlobals === "function") db.onGlobals();
  }

  /** Hands a result to the card, which may already have drawn without one. */
  function deliver(out) {
    waitingForOutput = false;
    if (outputTimer) { clearTimeout(outputTimer); outputTimer = null; }
    delivered = out;
    if (typeof db.onToolOutput === "function") db.onToolOutput(out);
  }

  /** The host re-publishes globals (theme, locale, toolOutput) on this event. */
  window.addEventListener("openai:set_globals", function () {
    db.api = api = window.openai || api;
    refreshContext();
    if (!delivered && api.toolOutput) deliver(api.toolOutput);
  });

  /**
   * The MCP Apps bridge: JSON-RPC over postMessage with the host.
   *
   * A card served as text/html;profile=mcp-app has to introduce itself with
   * ui/initialize and then send ui/notifications/initialized. A host enforcing
   * that gives up after a few seconds and draws its own "timed out" panel in
   * place of the card, even though the tool call itself succeeded. A host that
   * only offers window.openai never answers, and the card carries on without
   * it, so nothing here can make such a host worse.
   */
  function post(message) {
    try { window.parent.postMessage(message, "*"); } catch (e) {}
  }

  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextRequestId++;
      var timer = setTimeout(function () {
        delete pendingRequests[id];
        reject(new Error(method + " got no answer"));
      }, REQUEST_TIMEOUT_MS);
      pendingRequests[id] = { resolve: resolve, reject: reject, timer: timer };
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }

  /** A tool that failed has no structured result, only the sentence. */
  function outputOf(params) {
    var result = params || {};
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    var first = Array.isArray(result.content) ? result.content[0] : null;
    return { error: first && first.type === "text" ? first.text : "" };
  }

  function onNotification(message) {
    if (message.method === "ui/notifications/tool-result") {
      deliver(outputOf(message.params));
    } else if (message.method === "ui/notifications/tool-cancelled") {
      deliver({ error: (message.params && message.params.reason) || "" });
    } else if (message.method === "ui/notifications/host-context-changed") {
      var changed = message.params || {};
      for (var key in changed) {
        if (Object.prototype.hasOwnProperty.call(changed, key)) hostContext[key] = changed[key];
      }
      refreshContext();
    }
  }

  window.addEventListener("message", function (event) {
    if (!embedded || event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    db.api = api = window.openai || api;

    if (message.method === undefined) {
      var waiting = pendingRequests[message.id];
      if (!waiting) return;
      delete pendingRequests[message.id];
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error.message || "host error"));
      else waiting.resolve(message.result);
      return;
    }

    if (message.id === undefined) { onNotification(message); return; }

    // A request from the host. Teardown and ping only need acknowledging.
    if (message.method === "ui/resource-teardown" || message.method === "ping") {
      post({ jsonrpc: "2.0", id: message.id, result: {} });
    } else {
      post({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  });

  var lastWidth = 0;
  var lastHeight = 0;

  /** max-content, because scrollHeight cannot report smaller than the frame. */
  function reportSize() {
    if (!bridgeReady) return;
    var html = document.documentElement;
    var previous = html.style.height;
    html.style.height = "max-content";
    var height = Math.ceil(html.getBoundingClientRect().height);
    html.style.height = previous;
    var width = Math.ceil(window.innerWidth);
    // A frame that has not been laid out yet measures 0. Passing that on would
    // let the host shrink the card to nothing, so a 0 is never reported.
    if (!height) return;
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    var size = { height: height };
    if (width) size.width = width;
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: size });
  }

  function watchSize() {
    if (typeof ResizeObserver !== "function") return;
    var scheduled = false;
    var observer = new ResizeObserver(function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        reportSize();
      });
    });
    observer.observe(document.documentElement);
    observer.observe(document.body);
  }

  function handshake() {
    request("ui/initialize", {
      appInfo: { name: "dreambooth-card", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26"
    }).then(function (result) {
      bridgeReady = true;
      hostContext = (result && result.hostContext) || {};
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      refreshContext();
      db.fit();
      watchSize();
    }, function () {});
  }

  /**
   * Leaving the card goes through the host.
   *
   * A sandboxed iframe is not necessarily allowed to open windows on its own,
   * and the documented way out of a ChatGPT widget is window.openai.openExternal.
   * So every https link in a card, and every card that names a destination in
   * data-open-href, is routed through db.openExternal. When the host has no
   * such API the anchor keeps its own target="_blank", which is the best a
   * bare iframe can do, so nothing here ever makes a link worse.
   */
  function isHttps(href) {
    return typeof href === "string" && href.indexOf("https://") === 0;
  }

  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!target || typeof target.closest !== "function") return;
    var a = target.closest("a[href]");
    if (a) {
      if (isHttps(a.getAttribute("href")) && (typeof api.openExternal === "function" || bridgeReady)) {
        e.preventDefault();
        db.openExternal(a.href);
      }
      return;
    }
    var card = target.closest("[data-open-href]");
    if (!card) return;
    // Selecting text inside the card is not asking to leave it.
    try { if (window.getSelection && String(window.getSelection())) return; } catch (err) {}
    var url = card.getAttribute("data-open-href");
    if (!isHttps(url)) return;
    e.preventDefault();
    db.openExternal(url);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var target = e.target;
    if (!target || typeof target.closest !== "function") return;
    if (!target.hasAttribute || !target.hasAttribute("data-open-href")) return;
    var url = target.getAttribute("data-open-href");
    if (!isHttps(url)) return;
    e.preventDefault();
    db.openExternal(url);
  });

  /**
   * Makes the whole card a link to one destination, or removes that again.
   * Only cards for things that now exist call this with a URL; a draft or a
   * preview has nowhere to go yet and must not look clickable.
   */
  db.linkCard = function (card, href) {
    if (!card) return;
    if (isHttps(href)) {
      card.setAttribute("data-open-href", href);
      card.setAttribute("role", "link");
      card.setAttribute("tabindex", "0");
      card.classList.add("db-card--link");
    } else {
      card.removeAttribute("data-open-href");
      card.removeAttribute("role");
      card.removeAttribute("tabindex");
      card.classList.remove("db-card--link");
    }
  };

  db.applyTheme();
  db.applyLang();
  window.__db = db;

  if (embedded) {
    handshake();
    if (waitingForOutput) {
      // The card must not sit on a spinner forever if no result ever comes.
      outputTimer = setTimeout(function () {
        waitingForOutput = false;
        if (typeof db.onToolOutput === "function") db.onToolOutput({});
      }, NO_OUTPUT_MS);
    }
  }
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
