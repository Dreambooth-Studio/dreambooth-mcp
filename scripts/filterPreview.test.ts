import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { buildPreviewFilter } from "../src/tools/previewFilter.js";
import { buildCreateFilter } from "../src/tools/createFilter.js";
import { filterAdjustments } from "../src/tools/filterAdjustments.js";
import { ownerKeyFor } from "../src/jobs/store.js";
import { StudioError } from "../src/studio/errors.js";
import type { Config } from "../src/config.js";
import type { StudioClient } from "../src/studio/client.js";

/**
 * The read-only half of filter design: see it before creating it.
 *
 * What is asserted: the preview is a GET with the adjustments in the query
 * (so a read-scoped connection can call it), the Studio's "not previewed"
 * split reaches the model as a sentence, a Studio without the route gets a
 * deploy sentence rather than "nothing found", and preview and create share
 * one schema so what was seen is what gets saved.
 */

const CONFIG = { apiUrl: "https://studio.example" } as unknown as Config;

function fakeStudio(reply: (path: string, query?: Record<string, string | undefined>) => unknown) {
  const calls: Array<{ method: string; path: string; query?: Record<string, string | undefined>; options?: { timeoutMs?: number } }> = [];
  const studio = {
    ownerKey: () => ownerKeyFor(randomUUID()),
    get: async (path: string, query?: Record<string, string | undefined>, options?: { timeoutMs?: number }) => {
      calls.push({ method: "GET", path, query, options });
      return reply(path, query);
    },
    post: async () => {
      throw new Error("preview must never POST");
    },
  } as unknown as StudioClient;
  return { studio, calls };
}

test("preview_filter GETs the preview with the adjustments in the query", async () => {
  const { studio, calls } = fakeStudio(() => ({
    previewUrl: "https://cdn.dreambooth-team.workers.dev/filter-previews/abc.jpg",
    previewed: ["contrast", "temperature"],
    notPreviewed: ["shadows"],
    sample: "default",
  }));
  const tool = buildPreviewFilter(studio);

  const result = await tool.handler({ adjustments: { contrast: 112, temperature: 20, shadows: 15 } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/filters/preview");
  assert.deepEqual(JSON.parse(String(calls[0].query?.adjustments)), { contrast: 112, temperature: 20, shadows: 15 });
  assert.ok((calls[0].options?.timeoutMs ?? 0) >= 15_000, "a render is allowed longer than a read");

  assert.equal(result.kind, "filter-preview");
  assert.equal(result.previewUrl, "https://cdn.dreambooth-team.workers.dev/filter-previews/abc.jpg");
  assert.deepEqual(result.notPreviewed, ["shadows"]);
  // The sentence that keeps "lift the shadows" from looking ignored, and the
  // one that keeps a preview from being described as a filter.
  assert.match(result.note, /Not shown in the preview.*shadows/);
  assert.match(result.note, /Nothing has been created/);
  assert.match(result.note, /create_filter/);
});

test("the operator's own sample photo is named when the Studio used it", async () => {
  const { studio } = fakeStudio(() => ({ previewUrl: "https://cdn.dreambooth.app/x.jpg", previewed: [], notPreviewed: [], sample: "account" }));
  const result = await buildPreviewFilter(studio).handler({ adjustments: {} });
  assert.match(result.note, /operator's own preview photo/);
  assert.equal(result.sample, "account");
});

test("a Studio without the preview route answers with a deploy sentence, not 'nothing found'", async () => {
  const { studio } = fakeStudio(() => {
    throw new StudioError("Nothing found at /api/filters/preview.", 404, false);
  });
  await assert.rejects(
    () => buildPreviewFilter(studio).handler({ adjustments: { contrast: 110 } }),
    (err: unknown) =>
      err instanceof StudioError && /must be deployed first/.test(err.message) && /create_filter still works/.test(err.message)
  );
});

test("a reply without a URL is a failure, not a preview", async () => {
  const { studio } = fakeStudio(() => ({ previewed: [], notPreviewed: [] }));
  await assert.rejects(
    () => buildPreviewFilter(studio).handler({ adjustments: {} }),
    (err: unknown) => err instanceof StudioError && /did not return a preview image/.test(err.message)
  );
});

test("preview and create share one adjustments schema, so what was seen is what is saved", () => {
  const preview = buildPreviewFilter({} as StudioClient);
  const create = buildCreateFilter({} as StudioClient, CONFIG);
  assert.equal(preview.config.inputSchema.adjustments, filterAdjustments);
  assert.equal(create.config.inputSchema.adjustments, filterAdjustments);

  // The schema strips what it does not know, so an invented key never reaches
  // the Studio — which would refuse it with a 400 anyway.
  const parsed = filterAdjustments.safeParse({ contrast: 112, warmth: 30 });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data, { contrast: 112 });
});

/* ------------------------------------------------------ the created card --- */

test("create_filter shows the saved filter on the sample photo, best-effort", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const studio = {
    post: async (path: string) => {
      calls.push({ method: "POST", path });
      return { _id: "f1", name: "Senja Hangat", isPublic: false, adjustments: { contrast: 112, sepia: 18 } };
    },
    get: async (path: string, query?: Record<string, string | undefined>) => {
      calls.push({ method: "GET", path });
      assert.deepEqual(JSON.parse(String(query?.adjustments)), { contrast: 112, sepia: 18 }, "the filter AS SAVED");
      return { previewUrl: "https://cdn.dreambooth-team.workers.dev/filter-previews/f1.jpg" };
    },
  } as unknown as StudioClient;

  const result = await buildCreateFilter(studio, CONFIG).handler({
    name: "Senja Hangat",
    adjustments: { contrast: 112, sepia: 18 },
  });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["POST /api/filters", "GET /api/filters/preview"],
    "created first, previewed after — the preview can never block the save"
  );
  assert.equal(result.id, "f1");
  assert.equal(result.previewUrl, "https://cdn.dreambooth-team.workers.dev/filter-previews/f1.jpg");
});

test("a filter is still created when the preview is unavailable", async () => {
  const studio = {
    post: async () => ({ _id: "f2", name: "Mono", isPublic: false, adjustments: { grayscale: 100 } }),
    get: async () => {
      throw new StudioError("Nothing found at /api/filters/preview.", 404, false);
    },
  } as unknown as StudioClient;

  const result = await buildCreateFilter(studio, CONFIG).handler({ name: "Mono", adjustments: { grayscale: 100 } });
  assert.equal(result.id, "f2");
  assert.equal(result.previewUrl, undefined);
});
