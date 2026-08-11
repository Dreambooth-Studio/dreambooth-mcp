/**
 * Design tokens, copied by hand from `dreambooth-prod/tailwind.config.js` and
 * the class idioms actually used in `app/[locale]/dashboard/`.
 *
 * Copied rather than imported because widgets run in a sandboxed iframe with no
 * Tailwind, no build step and no access to the Studio's stylesheet. That makes
 * this file a second copy of the design system, so it is deliberately tiny and
 * every value cites its source name — if the Studio changes `blueSparkle`, this
 * is the one place that has to follow.
 *
 * Source of truth for the idioms below (frequency counted over the dashboard):
 *   card    bg-white rounded-lg shadow-sm border border-gray-200
 *   label   text-xs font-medium text-gray-500 mb-1
 *   input   border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700
 *   button  bg-blueSparkle text-white rounded-lg px-4 py-2 text-sm font-medium
 */

export const color = {
  /**
   * blueSparkle / primary.DEFAULT.
   *
   * NON-TEXT ONLY — focus rings and borders, where WCAG imposes no ratio.
   * As a text or fill colour it fails AA: white on #007AFF is 4.02:1, and
   * #007AFF on white is also 4.02:1, both short of the 4.5:1 that 14px/500 and
   * 12px text require. The Studio has the same problem; it was never checked as
   * a text colour. Use `primaryFill` or `primaryText` for anything a person
   * reads, and keep this for the ring so the brand hue still shows.
   */
  primary: "#007AFF",
  /** Button background. White label on this is 5.67:1. */
  primaryFill: "#0063D1",
  /** Button background on hover. White label 6.87:1. */
  primaryFillHover: "#0057B8",
  /** Primary AS TEXT on a light surface — links, ghost buttons. 5.67:1 on white. */
  primaryText: "#0063D1",
  /** Primary as text on the dark surface. 6.42:1 on #1D1D1D. */
  primaryTextDark: "#4DA3FF",
  primarySubtle: "#E6F1FF",
  /** anarchist / danger.DEFAULT */
  danger: "#DC2E49",
  /** warning.ink — the text-safe amber. warning.DEFAULT fails WCAG AA on white. */
  warningInk: "#B45309",
  /** scifiTakeout / success.DEFAULT */
  success: "#025E4A",
  /** carbon */
  ink: "#333333",
  inkMuted: "#6B7280",
  border: "#E5E7EB",
  borderStrong: "#D1D5DB",
  surface: "#FFFFFF",
  surfaceHover: "#F9FAFB",
} as const;

/**
 * Inter with a system stack behind it. Deliberately NOT an @import of Google
 * Fonts: a webfont request is blocked unless it is declared in the widget CSP,
 * and it buys a FOUT inside a 400px card for a face most systems already have.
 */
const FONT_STACK = `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/**
 * Dark values exist because ChatGPT reports the viewer's theme and a pure-white
 * card in a dark thread is glare. The Studio itself is light-only, so these are
 * new — chosen from the existing palette (`black`, `plaster`) rather than
 * invented, and the accent does not move, so the brand reads the same.
 */
export const baseCss = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
:root{
  --db-primary:${color.primary};
  --db-primary-fill:${color.primaryFill};
  --db-primary-fill-hover:${color.primaryFillHover};
  --db-primary-text:${color.primaryText};
  --db-primary-subtle:${color.primarySubtle};
  --db-danger:${color.danger};
  --db-warning:${color.warningInk};
  --db-success:${color.success};
  --db-ink:${color.ink};
  --db-ink-muted:${color.inkMuted};
  --db-border:${color.border};
  --db-border-strong:${color.borderStrong};
  --db-surface:${color.surface};
  --db-surface-hover:${color.surfaceHover};
}
[data-theme="dark"]{
  /* The fill does not move — white on it is already 5.67:1 against any
     surface, since the label sits on the fill and not on the card. Only the
     text token lightens, because #0063D1 on #1D1D1D is 2.97:1. */
  --db-primary-text:${color.primaryTextDark};
  --db-primary-subtle:rgba(0,122,255,.16);
  --db-ink:#EAEAEA;
  --db-ink-muted:#9CA3AF;
  --db-border:#2E2E2E;
  --db-border-strong:#3A3A3A;
  --db-surface:#1D1D1D;
  --db-surface-hover:#262626;
  --db-success:#3DBF9A;
  --db-warning:#E4A836;
}
body{
  font-family:${FONT_STACK};
  color:var(--db-ink);
  font-size:14px;
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.db-card{
  background:var(--db-surface);
  border:1px solid var(--db-border);
  border-radius:.5rem;
  box-shadow:0 1px 2px 0 rgb(0 0 0 / .05);
  padding:1.25rem;
  max-width:520px;
}
.db-brand{display:flex;align-items:center;gap:.5rem;margin-bottom:1rem}
.db-brand span{font-weight:600;font-size:.875rem;letter-spacing:-.01em}
.db-title{font-size:1rem;font-weight:600;margin:0 0 .25rem}
.db-sub{font-size:.8125rem;color:var(--db-ink-muted);margin:0}
.db-label{display:block;font-size:.75rem;font-weight:500;color:var(--db-ink-muted);margin-bottom:.25rem}
.db-input{
  width:100%;
  border:1px solid var(--db-border-strong);
  border-radius:.5rem;
  padding:.5rem .75rem;
  font:inherit;
  font-size:.875rem;
  color:var(--db-ink);
  background:var(--db-surface);
}
.db-input:hover{background:var(--db-surface-hover)}
.db-input:focus{outline:none;border-color:var(--db-primary);box-shadow:0 0 0 2px var(--db-primary-subtle)}
.db-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:.5rem;
  background:var(--db-primary-fill);
  color:#fff;
  border:0;
  border-radius:.5rem;
  padding:.5rem 1rem;
  font:inherit;
  font-size:.875rem;
  font-weight:500;
  cursor:pointer;
  transition:background-color .15s ease,opacity .15s ease;
}
.db-btn:hover:not(:disabled){background:var(--db-primary-fill-hover)}
.db-btn:focus-visible{outline:2px solid var(--db-primary);outline-offset:2px}
.db-btn:disabled{opacity:.4;cursor:not-allowed}
.db-btn--block{width:100%}
.db-btn--ghost{background:transparent;color:var(--db-primary-text);border:1px solid var(--db-border-strong)}
.db-btn--ghost:hover:not(:disabled){background:var(--db-primary-subtle)}
.db-chip{
  border-radius:9999px;
  border:1px solid var(--db-border);
  background:var(--db-surface);
  padding:.375rem .75rem;
  font:inherit;
  font-size:.875rem;
  color:var(--db-ink);
  cursor:pointer;
}
.db-chip:hover{background:var(--db-surface-hover)}
.db-chip[aria-pressed="true"]{background:var(--db-primary-subtle);border-color:var(--db-primary);color:var(--db-primary-text)}
.db-note{font-size:.75rem;color:var(--db-ink-muted);margin:.75rem 0 0}
.db-status{display:flex;align-items:center;gap:.5rem;font-size:.875rem}
.db-status--ok{color:var(--db-success);font-weight:500}
.db-status--warn{color:var(--db-warning)}
.db-status--err{color:var(--db-danger)}
.db-spinner{
  width:1rem;height:1rem;flex:none;
  border:2px solid var(--db-border);
  border-top-color:var(--db-primary);
  border-radius:9999px;
  animation:db-spin .7s linear infinite;
}
@keyframes db-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.db-spinner{animation-duration:2.4s}}
.db-link{color:var(--db-primary-text);text-decoration:none;font-size:.75rem}
.db-link:hover{text-decoration:underline}
`;
