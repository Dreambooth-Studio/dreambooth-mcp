import { brandMark, widgetDocument } from "./shell.js";

/**
 * The card every PREVIEW renders into: a generated frame, a booth draft, a
 * booth that was just created, or a filter preview — and an honest account
 * of why there is none yet.
 *
 * A separate widget from write-result, and the reason is the CSP. The other
 * cards draw everything inline — the logo, the filter swatch — so their CSP
 * lists no origin at all, and that emptiness is what makes it impossible for
 * them to talk to the network. This card has to show images the Studio
 * produced, which means <img> from the Studio's storage, which means a
 * `resourceDomains` entry. Keeping that entry on the one card that needs it
 * leaves the others exactly as closed as they were.
 *
 * It still does no work of its own: no poll, no callTool, no state. The model
 * calls the tool again when it wants a newer answer, and a fresh card is
 * rendered from that result. It dispatches on `kind`: "generation" (a frame),
 * "booth-draft", "booth" (created), "filter-preview", and "job" (nothing found).
 */

export const GENERATION_WIDGET_URI = "ui://widget/generation.html";

/**
 * Where a generated preview can be loaded from.
 *
 * Generated images are persisted by the Studio to the same storage the Assets
 * modal lists — Cloudflare R2 behind the CDN hostnames, or the S3 bucket when
 * R2 is not configured; onboarding assets and filter previews land on the
 * same origins. These are the image origins the Studio itself allows in
 * `next.config.mjs` (`images.remotePatterns`); copied rather than fetched
 * because a widget's CSP is fixed at registration and a sandboxed iframe
 * cannot ask.
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
      imageFailed: "Gambar tidak bisa ditampilkan di sini; tautannya ada di jawaban.",
      draftReady: "Rancangan booth siap",
      draftNote: "Belum dibuat — minta diubah, atau minta dibuat jadi booth.",
      remaining: "Sisa: {g} desain ulang penuh · {r} gambar ulang",
      boothMade: "Booth dibuat",
      openBooth: "Buka booth",
      openDashboard: "Buka di dashboard",
      frames: "frame",
      filters: "filter",
      filterPreview: "Pratinjau filter",
      filterNote: "Belum dibuat — minta disimpan kalau sudah cocok.",
      notShown: "Tidak tampak di pratinjau (tetap diterapkan booth):",
      workingOn: "Sedang:"
    },
    en: {
      ready: "Preview ready",
      generating: "Still working…",
      failed: "Nothing was created",
      unknown: "Not found",
      notSaved: "Not saved yet — ask for changes, or ask to save it to the frame list.",
      photos: "photos",
      imageFailed: "The image could not be shown here; the link is in the reply.",
      draftReady: "Booth draft ready",
      draftNote: "Not created yet — ask for changes, or ask to create the booth.",
      remaining: "Left: {g} full rebuilds · {r} redraws",
      boothMade: "Booth created",
      openBooth: "Open the booth",
      openDashboard: "Open in dashboard",
      frames: "frames",
      filters: "filters",
      filterPreview: "Filter preview",
      filterNote: "Not created yet — ask to save it once it looks right.",
      notShown: "Not shown in the preview (the booth still applies them):",
      workingOn: "Now:"
    },
    es: {
      ready: "Vista previa lista",
      generating: "Trabajando…",
      failed: "No se creo nada",
      unknown: "No encontrado",
      notSaved: "Aun no guardado: pide cambios, o pide guardarlo en la lista de marcos.",
      photos: "fotos",
      imageFailed: "La imagen no se pudo mostrar aqui; el enlace esta en la respuesta.",
      draftReady: "Borrador de cabina listo",
      draftNote: "Aun no creada: pide cambios, o pide crear la cabina.",
      remaining: "Quedan: {g} rediseños completos · {r} redibujos",
      boothMade: "Cabina creada",
      openBooth: "Abrir la cabina",
      openDashboard: "Abrir en el panel",
      frames: "marcos",
      filters: "filtros",
      filterPreview: "Vista previa del filtro",
      filterNote: "Aun no creado: pide guardarlo cuando se vea bien.",
      notShown: "No se ve en la vista previa (la cabina igual los aplica):",
      workingOn: "Ahora:"
    }
  };

  var t = db.t(COPY);

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fill(template, vars) {
    return String(template).replace(/\\{(\\w+)\\}/g, function (_, k) {
      return vars[k] == null ? "" : String(vars[k]);
    });
  }

  /**
   * Only an https URL becomes an <img>. The result came from our own tool,
   * but a card is the one place a string turns into markup, so the check
   * lives here regardless.
   */
  function imageTag(url) {
    if (typeof url !== "string" || url.indexOf("https://") !== 0) return "";
    return '<div class="db-preview" style="margin-top:.75rem;line-height:0">' +
      '<img src="' + esc(url) + '" alt="" style="max-width:100%;max-height:360px;border-radius:.375rem;border:1px solid var(--db-border)">' +
      '</div>';
  }

  /** A blocked or broken image degrades to a sentence, not a broken icon. */
  function watchImages() {
    var imgs = el.querySelectorAll(".db-preview img");
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        img.onerror = function () {
          var holder = img.parentNode;
          if (holder) holder.innerHTML = '<p class="db-note">' + esc(t.imageFailed) + '</p>';
          db.fit();
        };
        img.onload = function () { db.fit(); };
      })(imgs[i]);
    }
  }

  /** Only a #rrggbb value becomes a swatch; anything else is not painted. */
  function swatch(hex) {
    if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
    return '<span title="' + esc(hex) + '" style="display:inline-block;width:16px;height:16px;border-radius:9999px;border:1px solid var(--db-border);background:' + esc(hex) + ';vertical-align:middle;margin-right:.25rem"></span>';
  }

  function link(url, label) {
    if (typeof url !== "string" || url.indexOf("https://") !== 0) return "";
    return '<a class="db-link" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + ' &rarr;</a>';
  }

  var CHECK =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2 8.5l4 4 8-9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderRunning(out) {
    el.innerHTML =
      '<div class="db-status"><span class="db-spinner" aria-hidden="true"></span><span>' + esc(t.generating) + '</span></div>' +
      '<p class="db-title" style="margin-top:.5rem">' + esc(out.what || "") + '</p>' +
      (out.progress ? '<p class="db-sub">' + esc(t.workingOn) + ' ' + esc(out.progress) + '</p>' : '') +
      (out.note ? '<p class="db-note">' + esc(out.note) + '</p>' : '');
    db.fit();
  }

  function renderFrame(out) {
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
    watchImages();
    db.fit();
  }

  function renderDraft(out) {
    var d = out.draft || {};
    var p = d.palette || {};
    var facts = [];
    if (d.headline) facts.push(d.headline);
    if (d.cta) facts.push('"' + d.cta + '"');
    var remaining = fill(t.remaining, {
      g: typeof d.remainingFullGenerations === "number" ? d.remainingFullGenerations : "?",
      r: typeof d.remainingRegens === "number" ? d.remainingRegens : "?"
    });

    el.innerHTML =
      '<div class="db-status db-status--ok">' + CHECK + '<span>' + esc(t.draftReady) + '</span></div>' +
      '<p class="db-title" style="margin-top:.5rem">' + esc(d.title || out.what || "") + '</p>' +
      (facts.length ? '<p class="db-sub">' + esc(facts.join(" · ")) + '</p>' : '') +
      '<p class="db-sub" style="margin-top:.5rem">' + swatch(p.backgroundColor) + swatch(p.primaryColor) + swatch(p.secondaryColor) +
        (d.slug ? '<span style="vertical-align:middle">dreambooth.app/' + esc(d.slug) + '</span>' : '') + '</p>' +
      imageTag(d.welcomePortraitUrl) +
      '<p class="db-sub" style="margin-top:.5rem">' + esc(remaining) + '</p>' +
      '<p class="db-note">' + esc(t.draftNote) + '</p>';
    watchImages();
    db.fit();
  }

  function renderBooth(out) {
    var b = out.booth || {};
    var facts = [];
    var frames = (b.ownFrameCount || 0) + (b.catalogFrameCount || 0);
    if (frames) facts.push(frames + " " + t.frames);
    if (b.filterCount) facts.push(b.filterCount + " " + t.filters);
    if (b.aiEffect) facts.push(b.aiEffect);

    el.innerHTML =
      '<div class="db-status db-status--ok">' + CHECK + '<span>' + esc(t.boothMade) + '</span></div>' +
      '<p class="db-title" style="margin-top:.5rem">' + esc(b.title || out.what || "") + '</p>' +
      (facts.length ? '<p class="db-sub">' + esc(facts.join(" · ")) + '</p>' : '') +
      '<p class="db-note">' + link(b.boothUrl, t.openBooth) +
        (b.dashboardUrl ? ' &nbsp; ' + link(b.dashboardUrl, t.openDashboard) : '') + '</p>';
    db.fit();
  }

  function renderFilterPreview(out) {
    var keys = [];
    var adj = out.adjustments || {};
    for (var k in adj) {
      if (Object.prototype.hasOwnProperty.call(adj, k)) keys.push(k + " " + adj[k]);
    }
    var hidden = (out.notPreviewed || []).join(", ");

    el.innerHTML =
      '<div class="db-status db-status--ok">' + CHECK + '<span>' + esc(t.filterPreview) + '</span></div>' +
      (keys.length ? '<p class="db-sub" style="margin-top:.5rem">' + esc(keys.join(" · ")) + '</p>' : '') +
      imageTag(out.previewUrl) +
      (hidden ? '<p class="db-note">' + esc(t.notShown) + ' ' + esc(hidden) + '</p>' : '') +
      '<p class="db-note">' + esc(t.filterNote) + '</p>';
    watchImages();
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
    if (!out || !out.kind) { renderError(t.failed, out && out.error ? out.error : ""); return; }
    if (out.kind === "filter-preview") { renderFilterPreview(out); return; }
    if (out.state === "running") { renderRunning(out); return; }
    if (out.state === "done") {
      if (out.kind === "generation") { renderFrame(out); return; }
      if (out.kind === "booth-draft") { renderDraft(out); return; }
      if (out.kind === "booth") { renderBooth(out); return; }
    }
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
  title: "Pratinjau Dreambooth",
  body: BODY,
  script: SCRIPT,
});
