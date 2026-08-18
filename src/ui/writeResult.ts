import { brandMark, widgetDocument } from "./shell.js";

/**
 * The card every write tool renders into. One widget, not one per tool.
 *
 * It exists to prove what just happened, and that is the whole job: the tool
 * has already written by the time a widget can be rendered, so there is nothing
 * here to confirm, cancel, poll or re-query. No timer, no `callTool`, no
 * `setWidgetState` — two states and a link.
 *
 * There is deliberately no "undo" button. Undoing means PUT or DELETE, which
 * would widen the connector's scope from "create" to "change and delete" for
 * one button. Undo lives in the dashboard, and the link goes there.
 *
 * Nothing here is a form. The operator described what they wanted in their own
 * sentence and the model turned it into arguments; a form would be asking them
 * to type it a second time. See docs/write-tools-plan.md §5.
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
      filterMade: "Filter dibuat",
      boothMade: "Booth diduplikat",
      open: "Buka di dashboard",
      failed: "Tidak jadi dibuat",
      copiedFrom: "Disalin dari",
      inactive: "belum aktif",
      active: "aktif",
      publicFilter: "bisa dipakai booth mana pun",
      partial: "Pratinjau tidak memuat penajaman, reduksi noise, vignette dan grain.",
      noPreview: "Filter ini memakai efek yang tidak bisa dipratinjau di sini."
    },
    en: {
      filterMade: "Filter created",
      boothMade: "Booth duplicated",
      open: "Open in dashboard",
      failed: "Nothing was created",
      copiedFrom: "Copied from",
      inactive: "not live yet",
      active: "live",
      publicFilter: "available to any booth",
      partial: "The preview leaves out sharpening, noise reduction, vignette and grain.",
      noPreview: "This filter uses effects that cannot be previewed here."
    },
    es: {
      filterMade: "Filtro creado",
      boothMade: "Cabina duplicada",
      open: "Abrir en el panel",
      failed: "No se creo nada",
      copiedFrom: "Copiado de",
      inactive: "aun no activa",
      active: "activa",
      publicFilter: "disponible para cualquier cabina",
      partial: "La vista previa omite nitidez, reduccion de ruido, vineta y grano.",
      noPreview: "Este filtro usa efectos que no se pueden previsualizar aqui."
    }
  };

  /**
   * Adjustment names the operator would recognise, and the ranges they live in.
   *
   * Copied from adjustmentRanges in the Studio's
   * app/[locale]/dashboard/filters/[id]/page.tsx. The 'mid' value is what
   * counts as untouched: 100 for the multiplicative CSS filters, 0 for the
   * additive ones. Without it the summary line would proudly report
   * "Contrast 100" on a filter where contrast was never changed.
   */
  var RANGES = {
    contrast: { mid: 100, label: { id: "Kontras", en: "Contrast", es: "Contraste" } },
    brightness: { mid: 100, label: { id: "Kecerahan", en: "Brightness", es: "Brillo" } },
    saturation: { mid: 100, label: { id: "Saturasi", en: "Saturation", es: "Saturacion" } },
    temperature: { mid: 0, label: { id: "Suhu", en: "Temperature", es: "Temperatura" } },
    exposure: { mid: 0, label: { id: "Eksposur", en: "Exposure", es: "Exposicion" } },
    shadows: { mid: 0, label: { id: "Bayangan", en: "Shadows", es: "Sombras" } },
    highlights: { mid: 0, label: { id: "Sorotan", en: "Highlights", es: "Luces" } },
    vignette: { mid: 0, label: { id: "Vignette", en: "Vignette", es: "Vineta" } },
    grain: { mid: 0, label: { id: "Grain", en: "Grain", es: "Grano" } },
    sepia: { mid: 0, label: { id: "Sepia", en: "Sepia", es: "Sepia" } },
    grayscale: { mid: 0, label: { id: "Hitam putih", en: "Grayscale", es: "Escala de grises" } },
    blur: { mid: 0, label: { id: "Blur", en: "Blur", es: "Desenfoque" } },
    clarity: { mid: 0, label: { id: "Kejernihan", en: "Clarity", es: "Claridad" } },
    vibrance: { mid: 0, label: { id: "Vibrance", en: "Vibrance", es: "Intensidad" } },
    tint: { mid: 0, label: { id: "Tint", en: "Tint", es: "Matiz" } }
  };

  /**
   * The eight adjustments CSS can actually reproduce.
   *
   * Everything else in the Filter model — sharpening, noise reduction, clarity,
   * dehaze, texture, vignette, grain, and every LUT — is applied by the booth's
   * own renderer and has no CSS equivalent. The card says so rather than
   * quietly showing a swatch that is missing half the filter.
   */
  var CSS_FILTERS = {
    brightness: function (v) { return "brightness(" + (v / 100) + ")"; },
    contrast: function (v) { return "contrast(" + (v / 100) + ")"; },
    saturation: function (v) { return "saturate(" + (v / 100) + ")"; },
    sepia: function (v) { return "sepia(" + (v / 100) + ")"; },
    grayscale: function (v) { return "grayscale(" + (v / 100) + ")"; },
    invert: function (v) { return "invert(" + (v / 100) + ")"; },
    hueRotate: function (v) { return "hue-rotate(" + v + "deg)"; },
    blur: function (v) { return "blur(" + v + "px)"; }
  };

  /**
   * A neutral subject for the swatch: warm skin tones into a cool background,
   * with a grey ramp underneath.
   *
   * Drawn rather than photographed for the same reason the logo is (see
   * shell.ts): an <img> would need a resourceDomains entry in the CSP, and an
   * empty CSP is what makes it impossible for these cards to leak a token. The
   * grey ramp is not decoration — brightness and contrast are nearly invisible
   * on a saturated gradient alone, and a swatch that fails to show the
   * adjustment it illustrates is worse than no swatch.
   */
  var SWATCH =
    '<svg viewBox="0 0 72 48" width="72" height="48" aria-hidden="true">' +
    '<defs>' +
    '<linearGradient id="dbSwatch" x1="0" y1="0" x2="72" y2="40" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#F6C9A8"/><stop offset=".45" stop-color="#E08A6B"/>' +
    '<stop offset=".75" stop-color="#7B93C4"/><stop offset="1" stop-color="#2E3F63"/>' +
    '</linearGradient>' +
    '<linearGradient id="dbRamp" x1="0" y1="0" x2="72" y2="0" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#111"/><stop offset=".5" stop-color="#888"/><stop offset="1" stop-color="#fff"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<rect width="72" height="38" rx="4" fill="url(#dbSwatch)"/>' +
    '<rect y="40" width="72" height="8" rx="2" fill="url(#dbRamp)"/>' +
    '</svg>';

  var t = db.t(COPY);

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function num(value) {
    return typeof value === "number" && isFinite(value) ? value : null;
  }

  /** "Kontras +12 · Suhu -8", most-changed first, four at most. */
  function summarise(adjustments) {
    var moved = [];
    for (var key in RANGES) {
      if (!Object.prototype.hasOwnProperty.call(adjustments || {}, key)) continue;
      var value = num(adjustments[key]);
      if (value === null) continue;
      var delta = value - RANGES[key].mid;
      if (delta === 0) continue;
      moved.push({
        label: RANGES[key].label[db.locale] || RANGES[key].label.id,
        delta: delta
      });
    }
    moved.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    return moved.slice(0, 4).map(function (m) {
      return m.label + " " + (m.delta > 0 ? "+" : "") + Math.round(m.delta * 10) / 10;
    }).join(" · ");
  }

  /** The CSS filter string, plus whether anything had to be left out of it. */
  function preview(adjustments) {
    var parts = [];
    var omitted = false;
    for (var key in (adjustments || {})) {
      if (!Object.prototype.hasOwnProperty.call(adjustments, key)) continue;
      var value = num(adjustments[key]);
      if (value === null) continue;
      if (CSS_FILTERS[key]) {
        var neutral = key === "brightness" || key === "contrast" || key === "saturation" ? 100 : 0;
        if (value !== neutral) parts.push(CSS_FILTERS[key](value));
      } else if (RANGES[key] ? value !== RANGES[key].mid : value !== 0) {
        omitted = true;
      }
    }
    return { css: parts.join(" "), omitted: omitted, empty: parts.length === 0 };
  }

  function link(url) {
    if (!url) return "";
    return '<p class="db-note"><a class="db-link" href="' + esc(url) + '" target="_blank" rel="noopener">' +
      esc(t.open) + ' &rarr;</a></p>';
  }

  var CHECK =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2 8.5l4 4 8-9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderFilter(out) {
    var view = preview(out.adjustments);
    var facts = summarise(out.adjustments);
    if (out.isPublic) facts = facts ? facts + " · " + t.publicFilter : t.publicFilter;

    var swatch = view.empty
      ? ''
      : '<div style="margin-top:.75rem"><span style="display:inline-block;line-height:0;filter:' +
        esc(view.css) + '">' + SWATCH + '</span></div>';

    var note = view.empty ? t.noPreview : (view.omitted ? t.partial : "");

    el.innerHTML =
      '<div class="db-status db-status--ok">' + CHECK + '<span>' + esc(t.filterMade) + '</span></div>' +
      '<p class="db-title" style="margin-top:.5rem">' + esc(out.name) + '</p>' +
      (facts ? '<p class="db-sub">' + esc(facts) + '</p>' : '') +
      swatch +
      (note ? '<p class="db-note">' + esc(note) + '</p>' : '') +
      link(out.dashboardUrl);
    db.fit();
  }

  function renderBooth(out) {
    var facts = [];
    if (out.copiedFrom && out.copiedFrom.title) {
      facts.push(t.copiedFrom + " " + out.copiedFrom.title);
    }
    facts.push(out.isActive ? t.active : t.inactive);

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
    if (!out || !out.kind) {
      renderError(out && out.error ? out.error : "");
      return;
    }
    if (out.kind === "filter") { renderFilter(out); return; }
    if (out.kind === "booth") { renderBooth(out); return; }
    renderError("");
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
