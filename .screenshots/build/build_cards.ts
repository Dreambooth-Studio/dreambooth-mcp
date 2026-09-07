/**
 * Writes the connector's cards as standalone HTML, each with a mock
 * `window.openai`, in the states worth showing in the ChatGPT app directory.
 *
 *   cd dreambooth-mcp && npx tsx .screenshots/build/build_cards.ts
 *   node .screenshots/build/render_cards.js ../   (writes inline-card-*@2x.png next to this folder)
 *
 * Same idea as scripts/preview.ts, but English, light-by-default, no page
 * padding (the template wants the card alone at 353px), and every image points
 * at a stable https URL under the Studio's CDN host — the card only renders
 * https:// images — which render_cards.js answers from local files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generationWidgetHtml } from "D:/things to do/dreambooth/dreambooth-mcp/src/ui/generationResult.js";
import { connectAccountWidgetHtml } from "D:/things to do/dreambooth/dreambooth-mcp/src/ui/connectAccount.js";

const OUT = resolve(process.env.CARDS_OUT || resolve(dirname(fileURLToPath(import.meta.url)), "cards"));
const CDN = "https://cdn.dreambooth-team.workers.dev/shot";

interface Scenario {
  file: string;
  html: string;
  theme: "light" | "dark";
  toolOutput: Record<string, unknown>;
  replies?: Record<string, unknown>;
  widgetState?: Record<string, unknown>;
}

const DRAFT = {
  draftId: "dft_66f1c0ffee0000000000d0a1",
  slug: "genz-photobooth",
  title: "Gen-Z Photo Booth",
  headline: "Welcome",
  subtext: "Let's take beautiful pictures together <3",
  cta: "Start!",
  captureMode: "standard",
  language: "en",
  palette: { backgroundColor: "#FBD9EC", primaryColor: "#3B5FA8", secondaryColor: "#F59BD0", dark: false },
  welcomePortraitUrl: `${CDN}/genz-welcome.png`,
  welcomeLandscapeUrl: `${CDN}/genz-welcome.png`,
  appBackgroundUrl: `${CDN}/genz-welcome.png`,
  frameTags: ["y2k", "pastel"],
  filterMood: "soft",
  remainingFullGenerations: 2,
  remainingRegens: 5,
};

const FILTER_ADJ = { contrast: 104, saturation: 92, temperature: 22, shadows: 10 };

const SCENARIOS: Scenario[] = [
  {
    file: "booth-draft-light",
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: { kind: "booth-draft", jobId: "job-2", state: "done", what: "Gen-Z photo booth, pastel pink and blue, retro desktop vibe", draft: DRAFT },
  },
  {
    file: "booth-draft-dark",
    html: generationWidgetHtml,
    theme: "dark",
    toolOutput: { kind: "booth-draft", jobId: "job-2", state: "done", what: "Gen-Z photo booth, pastel pink and blue, retro desktop vibe", draft: DRAFT },
  },
  {
    file: "booth-designing-light",
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: { kind: "booth-draft", jobId: "job-2", state: "running", what: "Gen-Z photo booth, pastel pink and blue, retro desktop vibe", note: "Started. Designing a booth usually takes 60-120 seconds." },
    replies: { check_generation: { kind: "booth-draft", jobId: "job-2", state: "running", what: "Gen-Z photo booth, pastel pink and blue, retro desktop vibe", progress: "Drawing the welcome screen for phones…" } },
  },
  {
    file: "booth-created-light",
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: {
      kind: "booth", jobId: "job-3", state: "done", what: "Gen-Z Photo Booth",
      booth: {
        projectId: "66f1c0ffee0000000000b007", slug: "genz-photobooth", title: "Gen-Z Photo Booth",
        boothUrl: "https://dreambooth.app/genz-photobooth",
        dashboardUrl: "https://dreamboothstudio.com/dashboard/projects/66f1c0ffee0000000000b007/editor",
        imageUrl: `${CDN}/genz-welcome.png`, ownFrameCount: 3, catalogFrameCount: 3, filterCount: 1,
      },
    },
  },
  {
    file: "frame-preview-light",
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: { kind: "generation", jobId: "job-1", state: "done", what: "wedding frame, deep red with small hearts, six oval photos", threadId: "t1", generationId: "g1", imageUrl: `${CDN}/ai-frame-love.png`, canvasWidth: 1600, canvasHeight: 2400, placeholderCount: 6 },
  },
  {
    file: "frame-preview-dark",
    html: generationWidgetHtml,
    theme: "dark",
    toolOutput: { kind: "generation", jobId: "job-1", state: "done", what: "wedding frame, deep red with small hearts, six oval photos", threadId: "t1", generationId: "g1", imageUrl: `${CDN}/ai-frame-love.png`, canvasWidth: 1600, canvasHeight: 2400, placeholderCount: 6 },
  },
  {
    file: "frame-generating-light",
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: { kind: "generation", jobId: "job-1", state: "running", what: "wedding frame, deep red with small hearts, six oval photos", note: "Started. This usually takes 30-90 seconds." },
    replies: { check_generation: { kind: "generation", jobId: "job-1", state: "running", what: "wedding frame, deep red with small hearts, six oval photos", note: "Still running (generation), 34s so far. Nothing exists yet." } },
  },
  {
    file: "frame-saved-light",
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: { kind: "frame", state: "done", frameId: "66f1c0ffee0000000000fa11", name: "Love Ovals", isPublic: false, canvasWidth: 1600, canvasHeight: 2400, placeholderCount: 6, thumbnailUrl: `${CDN}/ai-frame-love.png`, dashboardUrl: "https://dreamboothstudio.com/dashboard/frames/66f1c0ffee0000000000fa11" },
  },
  {
    file: "filter-preview-light",
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: { kind: "filter-preview", previewUrl: `${CDN}/filter-preview-warm.jpg`, previewed: ["contrast", "saturation", "temperature"], notPreviewed: ["shadows"], sample: "default", adjustments: FILTER_ADJ, note: "Nothing has been created." },
  },
  {
    file: "filter-created-light",
    html: generationWidgetHtml,
    theme: "light",
    toolOutput: { kind: "filter", id: "66f1c0ffee0000000000beef", name: "Warm Fade", isPublic: false, adjustments: FILTER_ADJ, previewUrl: `${CDN}/filter-preview-warm.jpg`, dashboardUrl: "https://dreamboothstudio.com/dashboard/filters/66f1c0ffee0000000000beef" },
  },
  {
    file: "connect-light",
    html: connectAccountWidgetHtml,
    theme: "light",
    toolOutput: { status: "awaiting_approval", authUrl: "https://dreamboothstudio.com/api/auth/desktop/google/authorize?state=preview" },
    replies: { connection_status: { connected: false, phase: "waiting" } },
  },
];

function mock(s: Scenario): string {
  const shim = `<script>
window.openai = {
  theme: ${JSON.stringify(s.theme)},
  locale: "en",
  displayMode: "inline",
  toolOutput: ${JSON.stringify(s.toolOutput)},
  widgetState: ${JSON.stringify(s.widgetState ?? {})},
  setWidgetState: function () {},
  callTool: function (name) {
    var replies = ${JSON.stringify(s.replies ?? {})};
    return Promise.resolve({ structuredContent: replies[name] || {} });
  },
  openExternal: function () {},
  notifyIntrinsicHeight: function () {}
};
</script>`;
  // No page padding and a transparent page: the template wants the card alone.
  return s.html.replace("</head>", `<style>html,body{background:transparent!important;padding:0!important;margin:0!important}</style>${shim}</head>`);
}

mkdirSync(OUT, { recursive: true });
for (const s of SCENARIOS) {
  const path = resolve(OUT, `${s.file}.html`);
  writeFileSync(path, mock(s), "utf8");
  console.log(path);
}
