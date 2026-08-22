import { brandMark, widgetDocument } from "./shell.js";

/**
 * The card `duplicate_project` renders into.
 *
 * It exists to prove what just happened, and that is the whole job: the tool
 * has already written by the time a widget can be rendered, so there is nothing
 * here to confirm, cancel, poll or re-query. No timer, no `callTool`, no
 * `setWidgetState` — one state and a link.
 *
 * Everything generated — frames, booths, filters and their previews — renders
 * in the generation card instead (src/ui/generationResult.ts), because those
 * show images from the Studio's storage and therefore name an origin in their
 * CSP. This card draws everything inline and names none, and that emptiness
 * is what makes it impossible for it to talk to the network at all.
 *
 * There is deliberately no "undo" button. Undoing means PUT or DELETE, which
 * would widen the connector's scope from "create" to "change and delete" for
 * one button. Undo lives in the dashboard, and the link goes there.
 */

export const WRITE_RESULT_WIDGET_URI = "ui://widget/write-result.html";

const BODY = `
<div class="db-card" id="card">
  ${brandMark()}
  <div id="content"></div>
</div>
`;

/**
 * No template literals below — this file is one, and `${` inside the widget
 * script would be interpolated at build time instead of reaching the browser.
 */
const SCRIPT = `
(function () {
  var db = window.__db;
  var el = document.getElementById("content");

  var COPY = {
    id: {
      boothMade: "Booth diduplikat",
      open: "Buka di dashboard",
      failed: "Tidak jadi dibuat",
      copiedFrom: "Disalin dari"
    },
    en: {
      boothMade: "Booth duplicated",
      open: "Open in dashboard",
      failed: "Nothing was created",
      copiedFrom: "Copied from"
    },
    es: {
      boothMade: "Cabina duplicada",
      open: "Abrir en el panel",
      failed: "No se creo nada",
      copiedFrom: "Copiado de"
    }
  };

  var t = db.t(COPY);

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function link(url) {
    if (!url) return "";
    return '<p class="db-note"><a class="db-link" href="' + esc(url) + '" target="_blank" rel="noopener">' +
      esc(t.open) + ' &rarr;</a></p>';
  }

  var CHECK =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2 8.5l4 4 8-9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderBooth(out) {
    /*
     * No active/inactive line, deliberately.
     *
     * The card used to end with one, driven by isActive. That field is a
     * soft-delete flag defaulting to true, not a live/paused switch, so the
     * label claimed a distinction the product does not have. What is worth
     * saying is that it is a copy, and of what. Both are below.
     *
     * No backticks in this comment. It lives inside the template literal that
     * is this whole SCRIPT string, and one backtick ends the string.
     */
    var facts = [];
    if (out.copiedFrom && out.copiedFrom.title) {
      facts.push(t.copiedFrom + " " + out.copiedFrom.title);
    }

    el.innerHTML =
      '<div class="db-status db-status--ok">' + CHECK + '<span>' + esc(t.boothMade) + '</span></div>' +
      '<p class="db-title" style="margin-top:.5rem">' + esc(out.title) + '</p>' +
      '<p class="db-sub">' + esc(facts.join(" · ")) + '</p>' +
      link(out.dashboardUrl);
    db.fit();
  }

  function renderError(message) {
    // No dashboard link on this branch: there is nothing there to look at, and
    // a link on a failure reads as "it half worked".
    el.innerHTML =
      '<div class="db-status db-status--err"><span>' + esc(t.failed) + '</span></div>' +
      (message ? '<p class="db-sub" style="margin-top:.5rem">' + esc(message) + '</p>' : '');
    db.fit();
  }

  function render() {
    var out = db.toolOutput();
    if (out && out.kind === "booth") { renderBooth(out); return; }
    renderError(out && out.error ? out.error : "");
  }

  // Re-resolve the copy, not just re-render: t was captured at start-up, so a
  // host that switches locale mid-conversation would keep the old language.
  db.onGlobals = function () {
    t = db.t(COPY);
    render();
  };

  render();
})();
`;

export const writeResultWidgetHtml = widgetDocument({
  title: "Hasil pembuatan Dreambooth",
  body: BODY,
  script: SCRIPT,
});
