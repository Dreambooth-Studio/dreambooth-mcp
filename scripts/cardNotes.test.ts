import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { baseCss } from "../src/ui/tokens.js";
import { generationWidgetHtml } from "../src/ui/generationResult.js";
import { CARD_SHOWS_IMAGE } from "../src/tools/cardNotes.js";
import { buildPreviewFilter } from "../src/tools/previewFilter.js";
import type { StudioClient } from "../src/studio/client.js";

test("the card leaves its border and width to the host's frame", () => {
  const card = /\.db-card\{([^}]*)\}/.exec(baseCss)?.[1] ?? "";
  assert.ok(card.includes("padding"), "found the rule");
  assert.doesNotMatch(card, /max-width/);
  assert.doesNotMatch(card, /border:/);
  assert.doesNotMatch(card, /box-shadow/);
});

test("the running card does not print the model's note to the operator", () => {
  assert.doesNotMatch(generationWidgetHtml, /esc\(out\.note\)/);
  assert.match(generationWidgetHtml, /esc\(t\.runningNote\)/);
  // One per locale, so no language falls back to printing "undefined".
  assert.equal((generationWidgetHtml.match(/runningNote:/g) ?? []).length, 3);
});

test("the card's own copy has no em dash", () => {
  const copy = /var COPY = \{[\s\S]*?\n {2}\};/.exec(generationWidgetHtml)?.[0] ?? "";
  assert.ok(copy.includes("runningNote"), "found the copy");
  assert.doesNotMatch(copy, /—/);
});

test("a filter preview tells the model the card already shows the image", async () => {
  const studio = {
    get: async () => ({ previewUrl: "https://cdn.test/p.jpg", previewed: [], notPreviewed: [], sample: "default" }),
  } as unknown as StudioClient;
  const result = await buildPreviewFilter(studio).handler({ adjustments: {} });
  assert.ok(result.note.includes(CARD_SHOWS_IMAGE), result.note);
  assert.match(result.note, /Nothing has been created/);
});

test("no tool note tells the model to show an image itself", () => {
  const source = readFileSync(resolve(process.cwd(), "src/tools/checkGeneration.ts"), "utf8");
  assert.doesNotMatch(source, /Show it to the operator/);
  assert.doesNotMatch(source, /show the operator the welcome preview/);
  assert.equal((source.match(/CARD_SHOWS_IMAGE/g) ?? []).length, 4, "the import and three done notes");
});
