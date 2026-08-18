/**
 * Writes every widget to disk with a mock `window.openai`, so the card can be
 * opened in a browser and compared against the Studio dashboard side by side.
 *
 *   npm run preview        then open the printed paths
 *
 * The mock is deliberately crude — it answers `callTool` from a script, it does
 * not talk to anything. The point is the pixels, not the plumbing; the plumbing
 * is what `npm run inspect` checks.
 *
 * Each widget is written twice, light and dark, because the Studio is
 * light-only and the dark variant has no equivalent anywhere else to check
 * against.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONNECT_WIDGET_URI, connectAccountWidgetHtml } from "../src/ui/connectAccount.js";
import { WRITE_RESULT_WIDGET_URI, writeResultWidgetHtml } from "../src/ui/writeResult.js";

interface Scenario {
  file: string;
  label: string;
  html: string;
  theme: "light" | "dark";
  /** Becomes `window.openai.toolOutput`. */
  toolOutput: Record<string, unknown>;
  /** Canned `callTool` replies, keyed by tool name. */
  replies?: Record<string, unknown>;
  /** Becomes `window.openai.widgetState` — the only way to preview a mid-flow state. */
  widgetState?: Record<string, unknown>;
}

const AUTH_URL = "https://dreamboothstudio.com/api/auth/desktop/google/authorize?state=preview";

const SCENARIOS: Scenario[] = [
  {
    file: "connect-idle-light.html",
    label: `${CONNECT_WIDGET_URI} — idle, light`,
    html: connectAccountWidgetHtml,
    theme: "light",
    toolOutput: { status: "awaiting_approval", authUrl: AUTH_URL },
    // Never connects, so the waiting state stays on screen to be looked at.
    replies: { connection_status: { connected: false, phase: "waiting" } },
  },
  {
    file: "connect-idle-dark.html",
    label: `${CONNECT_WIDGET_URI} — idle, dark`,
    html: connectAccountWidgetHtml,
    theme: "dark",
    toolOutput: { status: "awaiting_approval", authUrl: AUTH_URL },
    replies: { connection_status: { connected: false, phase: "waiting" } },
  },
  {
    file: "connect-connected-light.html",
    label: `${CONNECT_WIDGET_URI} — connected, light`,
    html: connectAccountWidgetHtml,
    theme: "light",
    toolOutput: { status: "already_connected", email: "budi@tokofoto.id" },
  },
  {
    file: "connect-waiting-light.html",
    label: `${CONNECT_WIDGET_URI} — waiting, light`,
    html: connectAccountWidgetHtml,
    theme: "light",
    toolOutput: { status: "awaiting_approval", authUrl: AUTH_URL },
    // Resumed 12 seconds in, which is how this state looks when the operator
    // scrolls back to a card they left open.
    widgetState: { phase: "waiting", startedAt: Date.now() - 12_000 },
    replies: { connection_status: { connected: false, phase: "waiting" } },
  },
  {
    file: "connect-expired-dark.html",
    label: `${CONNECT_WIDGET_URI} — expired, dark`,
    html: connectAccountWidgetHtml,
    theme: "dark",
    toolOutput: { status: "awaiting_approval", authUrl: AUTH_URL },
    widgetState: { phase: "expired" },
    replies: { connection_status: { connected: false, phase: "expired" } },
  },
  {
    file: "write-filter-light.html",
    label: `${WRITE_RESULT_WIDGET_URI} — filter, light`,
    html: writeResultWidgetHtml,
    theme: "light",
    toolOutput: {
      kind: "filter",
      id: "66f1c0ffee0000000000beef",
      name: "Senja Hangat",
      isPublic: false,
      // Only CSS-reproducible adjustments: this is the swatch at its best, and
      // the one to look at when checking that the preview means anything.
      adjustments: { contrast: 112, saturation: 88, sepia: 18, brightness: 104 },
      dashboardUrl: "https://dreamboothstudio.com/dashboard/filters/66f1c0ffee0000000000beef",
    },
  },
  {
    file: "write-filter-partial-dark.html",
    label: `${WRITE_RESULT_WIDGET_URI} — filter with unpreviewable effects, dark`,
    html: writeResultWidgetHtml,
    theme: "dark",
    toolOutput: {
      kind: "filter",
      id: "66f1c0ffee0000000000cafe",
      name: "Analog Kasar",
      isPublic: true,
      // Grain, vignette and clarity have no CSS equivalent. The card must show
      // the swatch AND say what it left out — checking that is the point of
      // this scenario.
      adjustments: { contrast: 118, grain: 40, vignette: 60, clarity: 25, temperature: 15 },
      dashboardUrl: "https://dreamboothstudio.com/dashboard/filters/66f1c0ffee0000000000cafe",
    },
  },
  {
    file: "write-booth-light.html",
    label: `${WRITE_RESULT_WIDGET_URI} — duplicated booth, light`,
    html: writeResultWidgetHtml,
    theme: "light",
    toolOutput: {
      kind: "booth",
      id: "66f1c0ffee0000000000f00d",
      title: "Bandung Expo-copy",
      slug: "bandung-expo-copy",
      isActive: false,
      copiedFrom: { id: "66f1c0ffee0000000000abcd", title: "Bandung Expo" },
      dashboardUrl:
        "https://dreamboothstudio.com/dashboard/projects/66f1c0ffee0000000000f00d/editor",
    },
  },
  {
    file: "write-frame-running-light.html",
    label: `${WRITE_RESULT_WIDGET_URI} — frame still generating, light`,
    html: writeResultWidgetHtml,
    theme: "light",
    // The state that must NOT look like a success. Nothing exists yet, and a
    // checkmark here is a claim that something does.
    toolOutput: {
      kind: "frame",
      state: "running",
      what: '2x6" photo strip frame',
      note: "Still generating, 34s so far. Nothing has been created yet.",
    },
  },
  {
    file: "write-frame-done-dark.html",
    label: `${WRITE_RESULT_WIDGET_URI} — frame created, dark`,
    html: writeResultWidgetHtml,
    theme: "dark",
    toolOutput: {
      kind: "frame",
      state: "done",
      what: "Batik Emas",
      frameId: "66f1c0ffee0000000000fa11",
      name: "Batik Emas",
      isPublic: false,
      canvasWidth: 600,
      canvasHeight: 1800,
      placeholderCount: 3,
      dashboardUrl: "https://dreamboothstudio.com/dashboard/frames/66f1c0ffee0000000000fa11",
    },
  },
  {
    file: "write-error-dark.html",
    label: `${WRITE_RESULT_WIDGET_URI} — nothing created, dark`,
    html: writeResultWidgetHtml,
    theme: "dark",
    // What the host passes when the tool returned isError: no `kind`, so the
    // card must not render a success it cannot substantiate.
    toolOutput: {
      error: "This connection is read-only. Reconnect the app and approve permission to create things.",
    },
  },
];

function mock(scenario: Scenario): string {
  const shim = `<script>
window.openai = {
  theme: ${JSON.stringify(scenario.theme)},
  locale: ${JSON.stringify(process.env.PREVIEW_LOCALE || "id")},
  displayMode: "inline",
  toolOutput: ${JSON.stringify(scenario.toolOutput)},
  widgetState: ${JSON.stringify(scenario.widgetState ?? {})},
  setWidgetState: function (s) { console.log("setWidgetState", s); },
  callTool: function (name) {
    var replies = ${JSON.stringify(scenario.replies ?? {})};
    console.log("callTool", name);
    return Promise.resolve({ structuredContent: replies[name] || {} });
  },
  openExternal: function (o) { console.log("openExternal", o.href); },
  notifyIntrinsicHeight: function (h) { console.log("height", h); }
};
</script>`;

  // Injected before the widget's own scripts, and the page background is set
  // here rather than in the widget: the host paints behind the card, so a
  // preview on bare white would hide a card that is invisible in dark mode.
  const pageBg = scenario.theme === "dark" ? "#0F0F0F" : "#F4F4F5";
  return scenario.html
    .replace("</head>", `<style>body{background:${pageBg};padding:24px}</style>${shim}</head>`);
}

const outDir = resolve(process.cwd(), ".preview");
mkdirSync(outDir, { recursive: true });

for (const scenario of SCENARIOS) {
  const path = resolve(outDir, scenario.file);
  writeFileSync(path, mock(scenario), "utf8");
  console.log(`${scenario.label}\n  ${path}\n`);
}

console.log(`Set PREVIEW_LOCALE=en or es to check the other two locales.`);
