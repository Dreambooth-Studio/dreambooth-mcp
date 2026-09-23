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
 * A capture matching a predicate - by default the LAST, because later calls are
 * the settled states.
 *
 * Returns null rather than throwing when a state was never captured. A run can
 * end early - the booth round polls for minutes and one connect timeout kills
 * the client while the server finishes the job anyway - and three cards built
 * from real responses beat four where one is invented. The portal takes one to
 * four screenshots, so a short set is valid.
 *
 * `from: "first"` exists because "last settled" is the wrong rule for anything
 * the capture run REFINES. See the frame card below; this cost a wrong
 * screenshot on the 2026-09-07 set.
 */
function pick(
  label: string,
  match: (b: Payload) => boolean,
  from: "last" | "first" = "last",
): Payload | null {
  const ordered = from === "last" ? [...captures].reverse() : captures;
  const hit = ordered.find((c) => match(c.body));
  console.log(`${label.padEnd(16)} <- ${hit ? hit.file : "NOT CAPTURED, skipping"} (${from})`);
  return hit ? hit.body : null;
}

const done = (b: Payload, kind: string) => b.kind === kind && b.state === "done";

const CARDS: { file: string; toolOutput: Payload | null }[] = [
  {
    file: "booth-draft-light",
    toolOutput: pick("booth draft", (b) => done(b, "booth-draft") && Boolean(b.draft)),
  },
  {
    /**
     * The FIRST settled generation, not the last, and both reasons matter.
     *
     * The capture run is start -> check -> refine -> check -> save, and the
     * refine prompt is "the same, but darker and with less ornament". Under the
     * default "last settled" rule this card was built from that turn, so its
     * headline read as an instruction rather than as the brief - and the
     * listing shows a starter prompt beside the picture. A card has to be the
     * answer to the prompt it sits next to, and only the first turn is.
     *
     * The first generation is also the better picture, which was not luck.
     * `promptBuilder.ts` requires photo windows to stay flat opaque #00FF00 so
     * `frameFromThreadGeneration` can key them out on save; the refine turn
     * decorated three of the six holes with brown floral instead, so its image
     * shows three green slots and three brown ones. It reads as a rendering
     * fault. (The frame SAVED from that generation is genuinely broken for the
     * same reason - worth fixing on the product side, separately.)
     */
    file: "frame-preview-light",
    toolOutput: pick("frame preview", (b) => done(b, "generation") && Boolean(b.imageUrl), "first"),
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
