/**
 * Writes the submission cards from REAL tool responses.
 *
 *   node .claude/skills/mcp-verify/scripts/oauth-write-check.mjs \
 *     https://mcp.dreamboothstudio.com --booth --capture .screenshots/build/real
 *   npx tsx .screenshots/build/build_cards_real.ts
 *   node .screenshots/build/render_portal.js .screenshots/portal
 *
 * The sibling `build_cards.ts` writes the same cards from payloads typed by
 * hand. That is fine for eyeballing a widget while developing it, but a
 * directory screenshot built that way is a drawing of the product rather than a
 * picture of it: the booth, the frame and the filter in it never existed. This
 * one reads what the tools actually returned during an OAuth write check, so
 * every image in a screenshot is one the model really generated.
 *
 * Images here are live https://cdn.dreambooth.app URLs, so unlike build_cards.ts
 * there is nothing to route to a local asset - the renderer loads them.
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generationWidgetHtml } from "D:/things to do/dreambooth/dreambooth-mcp/src/ui/generationResult.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURED = resolve(process.env.CAPTURE_DIR || join(HERE, "real"));
const OUT = resolve(process.env.CARDS_OUT || join(HERE, "cards-real"));

type Payload = Record<string, unknown>;

const captures: { file: string; body: Payload }[] = readdirSync(CAPTURED)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((file) => ({ file, body: JSON.parse(readFileSync(join(CAPTURED, file), "utf8")) as Payload }));

if (captures.length === 0) throw new Error(`no captures in ${CAPTURED} - run the check with --capture first`);

/**
 * The last capture matching a predicate: later calls are the settled states.
 *
 * Returns null rather than throwing when a state was never captured. A run can
 * end early - the booth round polls for minutes and one connect timeout kills
 * the client while the server finishes the job anyway - and three cards built
 * from real responses beat four where one is invented. The portal takes one to
 * four screenshots, so a short set is valid.
 */
function pick(label: string, match: (b: Payload) => boolean): Payload | null {
  const hit = [...captures].reverse().find((c) => match(c.body));
  console.log(`${label.padEnd(16)} <- ${hit ? hit.file : "NOT CAPTURED, skipping"}`);
  return hit ? hit.body : null;
}

const done = (b: Payload, kind: string) => b.kind === kind && b.state === "done";

const CARDS: { file: string; toolOutput: Payload | null }[] = [
  {
    file: "booth-draft-light",
    toolOutput: pick("booth draft", (b) => done(b, "booth-draft") && Boolean(b.draft)),
  },
  {
    file: "frame-preview-light",
    toolOutput: pick("frame preview", (b) => done(b, "generation") && Boolean(b.imageUrl)),
  },
  {
    file: "filter-preview-light",
    toolOutput: pick("filter preview", (b) => b.kind === "filter-preview" && Boolean(b.previewUrl)),
  },
  {
    file: "booth-created-light",
    toolOutput: pick("booth created", (b) => done(b, "booth") && Boolean(b.booth)),
  },
];

function page(toolOutput: Payload): string {
  const shim = `<script>
window.openai = {
  theme: "light",
  locale: "en",
  displayMode: "inline",
  toolOutput: ${JSON.stringify(toolOutput)},
  widgetState: {},
  setWidgetState: function () {},
  callTool: function () { return Promise.resolve({ structuredContent: {} }); },
  openExternal: function () {},
  notifyIntrinsicHeight: function () {}
};
</script>`;
  return generationWidgetHtml.replace(
    "</head>",
    `<style>html,body{background:transparent!important;padding:0!important;margin:0!important}</style>${shim}</head>`,
  );
}

mkdirSync(OUT, { recursive: true });
for (const card of CARDS) {
  if (!card.toolOutput) continue;
  const path = resolve(OUT, `${card.file}.html`);
  writeFileSync(path, page(card.toolOutput), "utf8");
  console.log("wrote", path);
}
