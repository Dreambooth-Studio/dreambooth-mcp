import { brandMark, widgetDocument } from "./shell.js";

/**
 * The card `check_generation` renders into: a generated frame preview, or an
 * honest account of why there is none yet.
 *
 * A separate widget from write-result, and the reason is the CSP. The other
 * cards draw everything inline — the logo, the filter swatch — so their CSP
 * lists no origin at all, and that emptiness is what makes it impossible for
 * them to talk to the network. This card has to show an image the Studio
 * produced, which means an <img> from the Studio's storage, which means a
 * `resourceDomains` entry. Keeping that entry on the one card that needs it
 * leaves the others exactly as closed as they were.
 *
 * It still does no work of its own: no poll, no callTool, no state. The model
 * calls check_generation again when it wants a newer answer, and a fresh card
 * is rendered from that result.
 */

export const GENERATION_WIDGET_URI = "ui://widget/generation.html";

/**
 * Where a generated preview can be loaded from.
 *
 * Generated images are persisted by `persistAiGenerationImageUrls` in the
 * Studio to the same storage the Assets modal lists — Cloudflare R2 behind
 * the CDN hostname, or the S3 bucket when R2 is not configured. These are
 * the image origins the Studio itself allows in `next.config.mjs`
 * (`images.remotePatterns`); copied rather than fetched because a widget's
 * CSP is fixed at registration and a sandboxed iframe cannot ask.
 *
 * An image from any other origin is simply not shown — the card falls back to
 * the caption and the model still has the URL in its own result.
 */
export const GENERATION_IMAGE_ORIGINS = [
  "https://cdn.dreambooth.app",
  "https://cdn.dreambooth-team.workers.dev",
  "https://dreamboothidbucket.s3.ap-southeast-3.amazonaws.com",
  "https://d1zrl7xb0hypsb.cloudfront.net",
];

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
      ready: "Pratinjau siap",
      generating: "Sedang dibuat…",
      failed: "Tidak jadi dibuat",
      unknown: "Tidak ditemukan",
      notSaved: "Belum disimpan — minta diubah, atau minta disimpan ke daftar frame.",
      photos: "foto",
      imageFailed: "Gambar tidak bisa ditampilkan di sini; tautannya ada di jawaban."
    },
    en: {
      ready: "Preview ready",
      generating: "Still generating…",
      failed: "Nothing was generated",
      unknown: "Not found",
      notSaved: "Not saved yet — ask for changes, or ask to save it to the frame list.",
      photos: "photos",
      imageFailed: "The image could not be shown here; the link is in the reply."
    },
    es: {
      ready: "Vista previa lista",
      generating: "Generando…",
      failed: "No se genero nada",
      unknown: "No encontrado",
      notSaved: "Aun no guardado: pide cambios, o pide guardarlo en la lista de marcos.",
      photos: "fotos",
      imageFailed: "La imagen no se pudo mostrar aqui; el enlace esta en la respuesta."
    }
  };

  var t = db.t(COPY);

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * Only an https URL becomes an <img>. The result came from our own tool,
   * but a card is the one place a string turns into markup, so the check
   * lives here regardless.
   */
  function imageTag(url) {
    if (typeof url !== "string" || url.indexOf("https://") !== 0) return "";
    return '<div id="preview" style="margin-top:.75rem;line-height:0">' +
      '<img src="' + esc(url) + '" alt="" style="max-width:100%;max-height:360px;border-radius:.375rem;border:1px solid var(--db-border)">' +
      '</div>';
  }

  /** A blocked or broken image degrades to a sentence, not a broken icon. */
  function watchImage() {
    var img = el.querySelector("#preview img");
    if (!img) return;
    img.onerror = function () {
      var holder = document.getElementById("preview");
      if (holder) holder.innerHTML = '<p class="db-note">' + esc(t.imageFailed) + '</p>';
      db.fit();
    };
    img.onload = function () { db.fit(); };
  }

  var CHECK =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2 8.5l4 4 8-9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderRunning(out) {
    el.innerHTML =
      '<div class="db-status"><span class="db-spinner" aria-hidden="true"></span><span>' + esc(t.generating) + '</span></div>' +
      '<p class="db-title" style="margin-top:.5rem">' + esc(out.what || "") + '</p>' +
      (out.note ? '<p class="db-sub">' + esc(out.note) + '</p>' : '');
    db.fit();
  }

  function renderDone(out) {
    var facts = [];
    if (out.layout) facts.push(out.layout);
    if (out.canvasWidth && out.canvasHeight) facts.push(out.canvasWidth + "x" + out.canvasHeight);
    if (out.placeholderCount) facts.push(out.placeholderCount + " " + t.photos);

    el.innerHTML =
      '<div class="db-status db-status--ok">' + CHECK + '<span>' + esc(t.ready) + '</span></div>' +
      '<p class="db-title" style="margin-top:.5rem">' + esc(out.what || "") + '</p>' +
      (facts.length ? '<p class="db-sub">' + esc(facts.join(" · ")) + '</p>' : '') +
      imageTag(out.imageUrl) +
      '<p class="db-note">' + esc(t.notSaved) + '</p>';
    watchImage();
    db.fit();
  }

  function renderError(title, message) {
    // No dashboard link on this branch: there is nothing there to look at, and
    // a link on a failure reads as "it half worked".
    el.innerHTML =
      '<div class="db-status db-status--err"><span>' + esc(title) + '</span></div>' +
      (message ? '<p class="db-sub" style="margin-top:.5rem">' + esc(message) + '</p>' : '');
    db.fit();
  }

  function render() {
    var out = db.toolOutput();
    if (!out || out.kind !== "generation") {
      renderError(t.failed, out && out.error ? out.error : "");
      return;
    }
    if (out.state === "running") { renderRunning(out); return; }
    if (out.state === "done") { renderDone(out); return; }
    renderError(out.state === "unknown" ? t.unknown : t.failed, out.error || "");
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

export const generationWidgetHtml = widgetDocument({
  title: "Pratinjau frame Dreambooth",
  body: BODY,
  script: SCRIPT,
});
