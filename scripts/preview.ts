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
import { GENERATION_WIDGET_URI, generationWidgetHtml } from "../src/ui/generationResult.js";

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
    file: "write-booth-light.html",
    label: `${WRITE_RESULT_WIDGET_URI} — duplicated booth, light`,
    html: writeResultWidgetHtml,
    theme: "light",
    toolOutput: {
      kind: "booth",
      id: "66f1c0ffee0000000000f00d",
      title: "Bandung Expo-copy",
      slug: "bandung-expo-copy",
      copiedFrom: { id: "66f1c0ffee0000000000abcd", title: "Bandung Expo" },
      dashboardUrl:
        "https://dreamboothstudio.com/dashboard/projects/66f1c0ffee0000000000f00d/editor",
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
  {
    file: "gen-frame-running-light.html",
    label: `${GENERATION_WIDGET_URI} — frame being generated (live), light`,
    html: generationWidgetHtml,
    theme: "light",
    // The state that must NOT look like a success: a skeleton strip and a
    // spinner. The mock check_generation keeps answering "running", so the
    // card stays here to be looked at.
    toolOutput: {
      kind: "generation",
      jobId: "job-1",
      state: "running",
      what: "batik emas hangat, margin lebar",
      note: "Started. This usually takes 30-90 seconds.",
    },
    replies: {
      check_generation: { kind: "generation", jobId: "job-1", state: "running", what: "batik emas hangat, margin lebar", note: "Still running (generation), 34s so far. Nothing exists yet." },
    },
  },
  {
    file: "gen-frame-preview-dark.html",
    label: `${GENERATION_WIDGET_URI} — frame preview, dark`,
    html: generationWidgetHtml,
    theme: "dark",
    toolOutput: {
      kind: "generation",
      jobId: "job-1",
      state: "done",
      what: "batik emas hangat, margin lebar",
      threadId: "t1",
      generationId: "g1",
      imageUrl: "https://cdn.dreambooth-team.workers.dev/project/op/ai-generated-1.png",
      layout: "strip-3",
      canvasWidth: 1600,
      canvasHeight: 2400,
      placeholderCount: 6,
    },
  },
  {
    file: "gen-frame-saved-light.html",
    label: `${GENERATION_WIDGET_URI} — frame saved, light`,
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: {
      kind: "frame",
      state: "done",
      frameId: "66f1c0ffee0000000000fa11",
      name: "Batik Emas",
      isPublic: false,
      canvasWidth: 1600,
      canvasHeight: 2400,
      placeholderCount: 6,
      thumbnailUrl: "https://cdn.dreambooth-team.workers.dev/project/op/ai-frame-1.png",
      dashboardUrl: "https://dreamboothstudio.com/dashboard/frames/66f1c0ffee0000000000fa11",
    },
  },
  {
    file: "gen-booth-running-dark.html",
    label: `${GENERATION_WIDGET_URI} — booth being designed (live), dark`,
    html: generationWidgetHtml,
    theme: "dark",
    toolOutput: {
      kind: "booth-draft",
      jobId: "job-2",
      state: "running",
      what: "wedding in Bandung, warm gold",
      note: "Started. Designing a booth usually takes 60-120 seconds.",
    },
    replies: {
      check_generation: { kind: "booth-draft", jobId: "job-2", state: "running", what: "wedding in Bandung, warm gold", progress: "Drawing the welcome screen for laptops…" },
    },
  },
  {
    file: "gen-booth-draft-light.html",
    label: `${GENERATION_WIDGET_URI} — booth draft, light`,
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: {
      kind: "booth-draft",
      jobId: "job-2",
      state: "done",
      what: "wedding in Bandung, warm gold",
      draft: {
        draftId: "dft_aaaaaaaaaaaaaaaaaaaaaaaa",
        slug: "bandung-wedding",
        title: "Bandung Wedding",
        headline: "Selamat datang",
        subtext: "Foto dulu yuk",
        cta: "Mulai",
        captureMode: "standard",
        language: "id",
        palette: { backgroundColor: "#FFF7EE", primaryColor: "#B8860B", secondaryColor: "#6B4E16", dark: false },
        welcomePortraitUrl: "https://cdn.dreambooth-team.workers.dev/project/__onboarding__/d-welcomeBgPortrait.png",
        welcomeLandscapeUrl: "https://cdn.dreambooth-team.workers.dev/project/__onboarding__/d-welcomeBgLandscape.png",
        appBackgroundUrl: "https://cdn.dreambooth-team.workers.dev/project/__onboarding__/d-appBg.png",
        frameTags: ["scrapbook", "gold"],
        filterMood: "warm",
        remainingFullGenerations: 2,
        remainingRegens: 5,
      },
    },
  },
  {
    file: "gen-booth-created-light.html",
    label: `${GENERATION_WIDGET_URI} — booth created, light`,
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: {
      kind: "booth",
      jobId: "job-3",
      state: "done",
      what: "Bandung Wedding",
      booth: {
        projectId: "66f1c0ffee0000000000b007",
        slug: "bandung-wedding",
        title: "Bandung Wedding",
        boothUrl: "https://dreambooth.app/bandung-wedding",
        dashboardUrl: "https://dreamboothstudio.com/dashboard/projects/66f1c0ffee0000000000b007/editor",
        imageUrl: "https://cdn.dreambooth-team.workers.dev/project/__onboarding__/d-thumbnail.png",
        ownFrameCount: 3,
        catalogFrameCount: 3,
        filterCount: 1,
      },
    },
  },
  {
    file: "gen-filter-preview-light.html",
    label: `${GENERATION_WIDGET_URI} — filter preview, light`,
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: {
      kind: "filter-preview",
      previewUrl: "https://cdn.dreambooth-team.workers.dev/filter-previews/abc.jpg",
      previewed: ["contrast", "temperature"],
      notPreviewed: ["shadows"],
      sample: "default",
      adjustments: { contrast: 112, temperature: 20, shadows: 15 },
      note: "Nothing has been created.",
    },
  },
  {
    file: "gen-filter-created-dark.html",
    label: `${GENERATION_WIDGET_URI} — filter created, dark`,
    html: generationWidgetHtml,
    theme: "dark",
    toolOutput: {
      kind: "filter",
      id: "66f1c0ffee0000000000beef",
      name: "Senja Hangat",
      isPublic: false,
      adjustments: { contrast: 112, saturation: 88, sepia: 18, brightness: 104 },
      previewUrl: "https://cdn.dreambooth-team.workers.dev/filter-previews/def.jpg",
      dashboardUrl: "https://dreamboothstudio.com/dashboard/filters/66f1c0ffee0000000000beef",
    },
  },
  {
    file: "gen-error-dark.html",
    label: `${GENERATION_WIDGET_URI} — nothing created, dark`,
    html: generationWidgetHtml,
    theme: "dark",
    toolOutput: {
      kind: "booth-draft",
      jobId: "job-9",
      state: "failed",
      what: "x",
      error: "This draft has used all 3 of its full generations. Refine the welcome or background with refine_booth, create it as it is, or start a new draft.",
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
