import { brandMark, widgetDocument } from "./shell.js";

/**
 * The card every GENERATED thing renders into — from the moment it is asked
 * for to the moment it exists.
 *
 * One widget, five kinds of result: a frame being generated and its preview
 * (`generation`), a booth being designed and its draft (`booth-draft`), a booth
 * being created and the booth (`booth`), a saved frame (`frame`), a created
 * filter (`filter`), and a filter preview (`filter-preview`). `job` is the
 * answer when nothing was found.
 *
 * ## It is live
 *
 * A start/refine/create tool returns a handle while the work runs. That handle
 * renders here as a skeleton of the thing being made — a strip with photo
 * windows, a phone with a welcome screen — and the card then polls
 * `check_generation` itself, every few seconds, until the work is done, and
 * redraws as the preview. The operator watches the thing appear; nobody has to
 * ask. The same shape `connect_account` uses with `connection_status`. If the
 * host offers no `callTool`, the card simply stays at "working" and the model's
 * own poll produces the preview card instead.
 *
 * ## The CSP
 *
 * A separate widget from write-result, and the reason is the CSP. That card
 * draws everything inline and lists no origin at all, which is what makes it
 * impossible for it to talk to the network. This card has to show images the
 * Studio produced, which means <img> from the Studio's storage, which means a
 * `resourceDomains` entry. Keeping that entry on the one card that needs it
 * leaves the other exactly as closed as it was.
 */

export const GENERATION_WIDGET_URI = "ui://widget/generation.html";

/**
 * Where a generated image can be loaded from.
 *
 * Generated images are persisted by the Studio to the same storage the Assets
 * modal lists — Cloudflare R2 behind the CDN hostnames, or the S3 bucket when
 * R2 is not configured; onboarding assets, booth thumbnails and filter
 * previews land on the same origins. These are the image origins the Studio
 * itself allows in `next.config.mjs` (`images.remotePatterns`); copied rather
 * than fetched because a widget's CSP is fixed at registration and a sandboxed
 * iframe cannot ask.
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
<style>
.db-skel{animation:db-pulse 1.6s ease-in-out infinite}
@keyframes db-pulse{0%,100%{opacity:.45}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.db-skel{animation:none;opacity:.7}}
.db-live{display:flex;gap:1rem;align-items:flex-start;margin-top:.75rem}
.db-live svg{flex:none}
</style>
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
      workingFrame: "Sedang membuat frame…",
      workingDraft: "Sedang merancang booth…",
      workingBooth: "Sedang membuat booth…",
      working: "Sedang dikerjakan…",
      failed: "Tidak jadi dibuat",
      unknown: "Tidak ditemukan",
      untracked: "Pekerjaan ini sudah tidak dipantau di sini — hasilnya ada di percakapan.",
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
      frameSaved: "Frame disimpan",
      filterMade: "Filter dibuat",
      privateItem: "hanya akun ini",
      publicItem: "bisa dipakai booth mana pun",
      filterPreview: "Pratinjau filter",
      filterNote: "Belum dibuat — minta disimpan kalau sudah cocok.",
      notShown: "Tidak tampak di pratinjau (tetap diterapkan booth):",
      workingOn: "Sedang:"
    },
    en: {
      ready: "Preview ready",
      workingFrame: "Generating your frame…",
      workingDraft: "Designing your booth…",
      workingBooth: "Creating your booth…",
      working: "Still working…",
      failed: "Nothing was created",
      unknown: "Not found",
      untracked: "This job is no longer tracked here — its result is in the conversation.",
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
      frameSaved: "Frame saved",
      filterMade: "Filter created",
      privateItem: "private to this account",
      publicItem: "available to any booth",
      filterPreview: "Filter preview",
      filterNote: "Not created yet — ask to save it once it looks right.",
      notShown: "Not shown in the preview (the booth still applies them):",
      workingOn: "Now:"
    },
    es: {
      ready: "Vista previa lista",
      workingFrame: "Generando tu marco…",
      workingDraft: "Diseñando tu cabina…",
      workingBooth: "Creando tu cabina…",
      working: "Trabajando…",
      failed: "No se creo nada",
      unknown: "No encontrado",
      untracked: "Este trabajo ya no se sigue aqui; su resultado esta en la conversacion.",
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
      frameSaved: "Marco guardado",
      filterMade: "Filtro creado",
      privateItem: "privado de esta cuenta",
      publicItem: "disponible para cualquier cabina",
      filterPreview: "Vista previa del filtro",
      filterNote: "Aun no creado: pide guardarlo cuando se vea bien.",
      notShown: "No se ve en la vista previa (la cabina igual los aplica):",
      workingOn: "Ahora:"
    }
  };

  /** Neutral values, so the filter summary names only what moved. */
  var NEUTRAL = {
    brightness: 100, contrast: 100, saturation: 100,
    temperature: 0, tint: 0, exposure: 0, shadows: 0, highlights: 0, whites: 0, blacks: 0,
    vibrance: 0, clarity: 0, dehaze: 0, sepia: 0, grayscale: 0, vignette: 0, grain: 0,
    blur: 0, hueRotate: 0
  };

  var t = db.t(COPY);
  var current = db.toolOutput() || {};

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
          if (holder) {
            // The holder was sized for an image (line-height 0); give the
            // sentence normal line-height or it prints over the next line.
            holder.removeAttribute("style");
            holder.innerHTML = '<p class="db-note">' + esc(t.imageFailed) + '</p>';
          }
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

  /** "contrast 112 · sepia 18", most-changed first, four at most. */
  function summarise(adjustments) {
    var moved = [];
    for (var key in (adjustments || {})) {
      if (!Object.prototype.hasOwnProperty.call(adjustments, key)) continue;
      var value = adjustments[key];
      if (typeof value !== "number" || !isFinite(value)) continue;
      var mid = Object.prototype.hasOwnProperty.call(NEUTRAL, key) ? NEUTRAL[key] : 0;
      if (value === mid) continue;
      moved.push({ key: key, value: value, delta: Math.abs(value - mid) });
    }
    moved.sort(function (a, b) { return b.delta - a.delta; });
    return moved.slice(0, 4).map(function (m) { return m.key + " " + m.value; }).join(" · ");
  }

  var CHECK =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2 8.5l4 4 8-9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /**
   * What is being made, drawn before it exists: a strip with its photo
   * windows, or a phone with a welcome screen and a button. The shape is the
   * promise; the pulse says it is not done.
   */
  function skeleton(kind) {
    if (kind === "generation") {
      return '<svg class="db-skel" width="64" height="112" viewBox="0 0 64 112" aria-hidden="true">' +
        '<rect x="1" y="1" width="62" height="110" rx="6" fill="var(--db-surface-hover)" stroke="var(--db-border-strong)"/>' +
        '<rect x="10" y="10" width="44" height="26" rx="3" fill="var(--db-border)"/>' +
        '<rect x="10" y="43" width="44" height="26" rx="3" fill="var(--db-border)"/>' +
        '<rect x="10" y="76" width="44" height="26" rx="3" fill="var(--db-border)"/></svg>';
    }
    return '<svg class="db-skel" width="56" height="112" viewBox="0 0 56 112" aria-hidden="true">' +
      '<rect x="1" y="1" width="54" height="110" rx="10" fill="var(--db-surface-hover)" stroke="var(--db-border-strong)"/>' +
      '<rect x="8" y="12" width="40" height="70" rx="4" fill="var(--db-border)"/>' +
      '<rect x="14" y="88" width="28" height="10" rx="5" fill="var(--db-primary-subtle)" stroke="var(--db-primary)"/></svg>';
  }

  function workingTitle(kind) {
    if (kind === "generation") return t.workingFrame;
    if (kind === "booth-draft") return t.workingDraft;
    if (kind === "booth") return t.workingBooth;
    return t.working;
  }

  function renderRunning(out) {
    el.innerHTML =
      '<div class="db-status"><span class="db-spinner" aria-hidden="true"></span><span>' + esc(workingTitle(out.kind)) + '</span></div>' +
      '<div class="db-live">' + skeleton(out.kind) + '<div>' +
        '<p class="db-title">' + esc(out.what || "") + '</p>' +
        (out.progress ? '<p class="db-sub">' + esc(t.workingOn) + ' ' + esc(out.progress) + '</p>' : '') +
        (out.note ? '<p class="db-note">' + esc(out.note) + '</p>' : '') +
      '</div></div>';
    db.fit();
  }

  function renderFramePreview(out) {
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
      imageTag(b.imageUrl) +
      '<p class="db-note">' + link(b.boothUrl, t.openBooth) +
        (b.dashboardUrl ? ' &nbsp; ' + link(b.dashboardUrl, t.openDashboard) : '') + '</p>';
    watchImages();
    db.fit();
  }

  function renderSavedFrame(out) {
    var facts = [];
    if (out.canvasWidth && out.canvasHeight) facts.push(out.canvasWidth + "x" + out.canvasHeight);
    if (out.placeholderCount) facts.push(out.placeholderCount + " " + t.photos);
    facts.push(out.isPublic ? t.publicItem : t.privateItem);

    el.innerHTML =
      '<div class="db-status db-status--ok">' + CHECK + '<span>' + esc(t.frameSaved) + '</span></div>' +
      '<p class="db-title" style="margin-top:.5rem">' + esc(out.name || out.what || "") + '</p>' +
      '<p class="db-sub">' + esc(facts.join(" · ")) + '</p>' +
      imageTag(out.thumbnailUrl) +
      (out.dashboardUrl ? '<p class="db-note">' + link(out.dashboardUrl, t.openDashboard) + '</p>' : '');
    watchImages();
    db.fit();
  }

  function renderFilter(out) {
    var facts = summarise(out.adjustments);
    var audience = out.isPublic ? t.publicItem : t.privateItem;
    facts = facts ? facts + " · " + audience : audience;

    el.innerHTML =
      '<div class="db-status db-status--ok">' + CHECK + '<span>' + esc(t.filterMade) + '</span></div>' +
      '<p class="db-title" style="margin-top:.5rem">' + esc(out.name || "") + '</p>' +
      '<p class="db-sub">' + esc(facts) + '</p>' +
      imageTag(out.previewUrl) +
      (out.dashboardUrl ? '<p class="db-note">' + link(out.dashboardUrl, t.openDashboard) + '</p>' : '');
    watchImages();
    db.fit();
  }

  function renderFilterPreview(out) {
    var facts = summarise(out.adjustments);
    var hidden = (out.notPreviewed || []).join(", ");

    el.innerHTML =
      '<div class="db-status db-status--ok">' + CHECK + '<span>' + esc(t.filterPreview) + '</span></div>' +
      (facts ? '<p class="db-sub" style="margin-top:.5rem">' + esc(facts) + '</p>' : '') +
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

  function renderUntracked(out) {
    el.innerHTML =
      '<p class="db-title">' + esc(out.what || "") + '</p>' +
      '<p class="db-note">' + esc(t.untracked) + '</p>';
    db.fit();
  }

  /* -------------------------------------------------------- live polling --- */

  var POLL_MS = 6000;
  var POLL_MAX_MS = 10 * 60 * 1000;
  var pollTimer = null;
  var pollStartedAt = Date.now();
  var pollFailures = 0;

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /**
   * Asks check_generation until the work is no longer running, then redraws.
   * Failures are tolerated three in a row — a host without callTool rejects
   * at once, and the card just keeps showing "working".
   */
  function startPolling(jobId) {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (Date.now() - pollStartedAt > POLL_MAX_MS) { stopPolling(); return; }
      db.callTool("check_generation", { jobId: jobId }).then(function (res) {
        pollFailures = 0;
        if (!res || typeof res !== "object" || !res.state) return;
        if (res.state === "running") {
          current = res;
          renderRunning(current);
          return;
        }
        stopPolling();
        // A job swept from the store is not a failure of the thing; the
        // conversation has the answer, and this card should not shout.
        if (res.state === "unknown") { renderUntracked(current); return; }
        current = res;
        render();
      }).catch(function () {
        if (++pollFailures >= 3) stopPolling();
      });
    }, POLL_MS);
  }

  function render() {
    var out = current;
    if (!out || !out.kind) { renderError(t.failed, out && out.error ? out.error : ""); return; }
    if (out.kind === "filter-preview") { renderFilterPreview(out); return; }
    if (out.kind === "filter") { renderFilter(out); return; }
    if (out.kind === "frame") {
      if (out.state && out.state !== "done") { renderError(t.failed, out.error || ""); return; }
      renderSavedFrame(out);
      return;
    }
    if (out.state === "running") {
      renderRunning(out);
      if (out.jobId) startPolling(out.jobId);
      return;
    }
    if (out.state === "done") {
      if (out.kind === "generation") { renderFramePreview(out); return; }
      if (out.kind === "booth-draft") { renderDraft(out); return; }
      if (out.kind === "booth") { renderBooth(out); return; }
    }
    renderError(out.state === "unknown" ? t.unknown : t.failed, out.error || "");
  }

  // Re-resolve the copy, not just re-render: t was captured at start-up, so a
  // host that switches locale mid-conversation would keep the old language.
  // The current result is kept — a re-publish of globals must not rewind a
  // finished card to the handle it started from. (No backticks in comments
  // here: this whole script lives inside a template literal.)
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
