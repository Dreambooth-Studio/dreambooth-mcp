import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZodTypeAny } from "zod";

import { buildStartFrame } from "../src/tools/startFrame.js";
import { buildRefineFrame } from "../src/tools/refineFrame.js";
import { buildStartBooth } from "../src/tools/startBooth.js";
import { buildRefineBooth } from "../src/tools/refineBooth.js";
import { buildCreateFilter } from "../src/tools/createFilter.js";
import { buildPreviewFilter } from "../src/tools/previewFilter.js";
import { BOOTH_BRIEF, CHANGE_BRIEF, FILTER_RESTRAINT, FRAME_BRIEF } from "../src/tools/promptNotes.js";
import type { Config } from "../src/config.js";
import type { StudioClient } from "../src/studio/client.js";

/**
 * The connector forwards prompts verbatim, so the only defence against a
 * caption-style "stunning, elegant, magical" prompt is what the parameter
 * descriptions tell the calling model. These hold each guidance sentence to the
 * parameter the model reads while writing that value — not merely somewhere in
 * the tool — and keep the operator-protection sentences that were there before.
 */

const studio = {} as StudioClient;
const config = { apiUrl: "https://studio.example" } as unknown as Config;

const described = (schema: ZodTypeAny | undefined): string => schema?.description ?? "";

test("start_frame's prompt asks for a concrete brief and keeps the brand rule", () => {
  const prompt = described(buildStartFrame(studio).config.inputSchema.prompt);
  assert.ok(prompt.includes(FRAME_BRIEF));
  assert.match(prompt, /brands, characters or franchises/);
  assert.match(prompt, /Not the photo slots/);
});

test("refine_frame's prompt asks for the change only", () => {
  const prompt = described(buildRefineFrame(studio).config.inputSchema.prompt);
  assert.ok(prompt.includes(CHANGE_BRIEF));
  assert.match(prompt, /whole thread as context/);
});

test("start_booth's prompt asks for facts and art direction, not copy", () => {
  const prompt = described(buildStartBooth(studio).config.inputSchema.prompt);
  assert.ok(prompt.includes(BOOTH_BRIEF));
  assert.match(prompt, /brands, characters or franchises/);
});

test("refine_booth's instruction covers both a redraw and a rebuild", () => {
  const instruction = described(buildRefineBooth(studio).config.inputSchema.instruction);
  assert.ok(instruction.includes(CHANGE_BRIEF), "a redraw states the change only");
  assert.ok(instruction.includes(BOOTH_BRIEF), "a rebuild is written like start_booth");
  assert.match(instruction, /300 characters/);
});

test("both filter tools carry the restraint guidance on the same adjustments schema", () => {
  for (const tool of [buildCreateFilter(studio, config), buildPreviewFilter(studio)]) {
    const adjustments = described(tool.config.inputSchema.adjustments);
    assert.ok(adjustments.includes(FILTER_RESTRAINT), `${tool.name} lost the restraint guidance`);
    assert.match(adjustments, /does nothing/, `${tool.name} lost the neutral-values warning`);
  }
});

test("the guidance names the operator's specifics as untouchable", () => {
  // Steering, not rewriting: names, colours and motif names pass through.
  assert.match(FRAME_BRIEF, /Keep their specifics exactly/);
  assert.match(BOOTH_BRIEF, /exactly as given/);
  assert.match(BOOTH_BRIEF, /quote it/);
});

test("every first-prompt brief starts from the operator's own words", () => {
  // Their sentence is the intent; the brief is an interpretation added after it.
  for (const brief of [FRAME_BRIEF, BOOTH_BRIEF]) {
    assert.match(brief, /^Start with what the operator said, in their words and language/);
    assert.match(brief, /Never swap a choice they made/);
  }
  assert.match(CHANGE_BRIEF, /operator's own words/);
});

test("a booth's visual reference is picked by the model, not demanded of the operator", () => {
  assert.match(BOOTH_BRIEF, /theirs if they gave one, otherwise one you pick/);
  assert.match(BOOTH_BRIEF, /do not ask them for one/);
  assert.match(BOOTH_BRIEF, /in words/);
});
