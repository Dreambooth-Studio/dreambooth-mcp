import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { buildGetBoothDraft } from "../src/tools/getBoothDraft.js";
import { buildUpdateBoothDraft, patchBodyFor } from "../src/tools/updateBoothDraft.js";
import { createBoothWork } from "../src/tools/createBooth.js";
import { boothErrorFor, readBoothDraft, resolveAiEffect, summariseDraft } from "../src/tools/boothGeneration.js";
import { ownerKeyFor, type JobContext } from "../src/jobs/store.js";
import { StudioError } from "../src/studio/errors.js";
import type { Config } from "../src/config.js";
import type { StudioClient } from "../src/studio/client.js";

/**
 * The two levers on a booth draft that a redraw is not — read it back, change
 * what the dashboard editor would — and what create_booth now carries: the
 * draft's own title and link, what update_booth_draft gave it, and what this
 * connection made earlier.
 */

const CONFIG = {
  apiUrl: "https://studio.example",
  port: 0,
  requestTimeoutMs: 1000,
  allowedHosts: [],
  diagnostics: false,
} as unknown as Config;

const DRAFT_ID = `dft_${"a".repeat(24)}`;
const HEX24 = (c: string) => c.repeat(24);

const DRAFT_REPLY = {
  draftId: DRAFT_ID,
  slug: "bandung-wedding",
  spec: {
    title: "Bandung Wedding",
    slugBase: "bandung-wedding",
    palette: { backgroundColor: "#FFF7EE", primaryColor: "#B8860B", secondaryColor: "#6B4E16", dark: false },
    welcome: { headline: "Selamat datang", subtext: "Foto dulu yuk", cta: "Mulai" },
    captureMode: "standard",
    frameTags: ["scrapbook", "gold"],
    filterMood: "warm",
    locale: "id",
  },
  designMode: "designed",
  assets: {
    welcomeBgPortrait: "https://cdn.dreambooth-team.workers.dev/project/__onboarding__/d-welcomeBgPortrait.png",
    welcomeBgLandscape: "https://cdn.dreambooth-team.workers.dev/project/__onboarding__/d-welcomeBgLandscape.png",
    appBg: "https://cdn.dreambooth-team.workers.dev/project/__onboarding__/d-appBg.png",
    logoUrl: "",
  },
  remaining: { fullGenerations: 2, regens: 5 },
};

interface Call {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  options?: { timeoutMs?: number };
}
type Reply = (call: Call) => unknown;

function fakeStudio(reply: Reply) {
  const calls: Call[] = [];
  const record = (call: Call) => {
    calls.push(call);
    return reply(call);
  };
  const studio = {
    ownerKey: () => ownerKeyFor(randomUUID()),
    get: async (path: string, query?: Record<string, string | undefined>, options?: { timeoutMs?: number }) =>
      record({ method: "GET", path, query, options }),
    post: async (path: string, body: unknown, _q?: unknown, options?: { timeoutMs?: number }) =>
      record({ method: "POST", path, body, options }),
    patch: async (path: string, body: unknown, _q?: unknown, options?: { timeoutMs?: number }) =>
      record({ method: "PATCH", path, body, options }),
  } as unknown as StudioClient;
  return { studio, calls };
}

const ctxOf = (seen: string[]): JobContext => ({ jobId: "j", progress: (t) => seen.push(t) });
const noSleep = async () => {};

/* ----------------------------------------------------------------- read --- */

test("get_booth_draft reads the draft back with what it was given", async () => {
  const { studio, calls } = fakeStudio(() => ({
    ...DRAFT_REPLY,
    overrides: { settings: { capture: { captureCount: 4 } }, frameIds: [HEX24("c")], aiEffectId: HEX24("e") },
    overridesSummary: ["capture.captureCount=4", "1 frame(s) chosen", "AI effect chosen"],
  }));
  const result = await buildGetBoothDraft(studio).handler({ draftId: DRAFT_ID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/onboarding/draft");
  assert.equal(calls[0].query?.draftId, DRAFT_ID);
  assert.equal(result.kind, "booth-draft");
  assert.equal(result.state, "done");
  assert.equal(result.what, "Bandung Wedding");
  assert.equal(result.draft?.title, "Bandung Wedding");
  assert.deepEqual(result.draft?.settings, { capture: { captureCount: 4 } });
  assert.deepEqual(result.draft?.frameIds, [HEX24("c")]);
  assert.equal(result.draft?.aiEffectId, HEX24("e"));
  assert.deepEqual(result.draft?.edited, ["capture.captureCount=4", "1 frame(s) chosen", "AI effect chosen"]);
  assert.match(String(result.note), /update_booth_draft/);
});

test("a draft without conversation-time edits carries none of those keys", () => {
  const draft = summariseDraft({ ...DRAFT_REPLY, overrides: null, overridesSummary: [] });
  assert.equal("frameIds" in draft, false);
  assert.equal("settings" in draft, false);
  assert.equal("edited" in draft, false);
});

test("reading a draft the Studio cannot read or edit yet says so, and a gone draft says that", async () => {
  const missingRoute = fakeStudio(() => {
    throw new StudioError("Nothing found at /api/onboarding/draft.", 404, false);
  });
  await assert.rejects(
    () => readBoothDraft(missingRoute.studio, DRAFT_ID),
    (err: unknown) => err instanceof StudioError && /cannot read or edit booth drafts yet/.test(err.message) && /create_booth still work/.test(err.message)
  );
  const gone = fakeStudio(() => {
    throw new StudioError("Draft not found", 404, false);
  });
  await assert.rejects(
    () => readBoothDraft(gone.studio, DRAFT_ID),
    (err: unknown) => err instanceof StudioError && /not available to this account/.test(err.message)
  );
  // The digital-mode sentence is unchanged for the generate stage.
  assert.match(boothErrorFor(new StudioError("Not found", 404, false), "generate").message, /digital-mode/);
});

/* ----------------------------------------------------------------- edit --- */

test("update_booth_draft maps the operator's words onto the Studio's fields, nothing else", async () => {
  const { studio } = fakeStudio(() => ({ items: [{ id: HEX24("e"), title: "Anime Glow" }] }));
  const body = await patchBodyFor(studio, {
    draftId: DRAFT_ID,
    title: "Pernikahan Bandung",
    slug: "pernikahan-bandung",
    buttonText: "Mulai",
    language: "id",
    captureMode: "frame-based",
    palette: { primaryColor: "#B8860B" },
    frameIds: [HEX24("c")],
    filterIds: [HEX24("d")],
    aiEffectTitle: "anime glow",
    settings: { capture: { captureCount: 4 }, checkout: { promoEnabled: false } },
  });
  assert.deepEqual(body, {
    draftId: DRAFT_ID,
    title: "Pernikahan Bandung",
    slug: "pernikahan-bandung",
    cta: "Mulai",
    language: "id",
    captureMode: "frame-based",
    palette: { primaryColor: "#B8860B" },
    frameIds: [HEX24("c")],
    filterIds: [HEX24("d")],
    settings: { capture: { captureCount: 4 }, checkout: { promoEnabled: false } },
    aiEffectId: HEX24("e"),
  });
  assert.equal("ownerEmail" in body, false);
  // An empty effect name removes the chosen effect.
  const removed = await patchBodyFor(studio, { draftId: DRAFT_ID, aiEffectTitle: "" });
  assert.deepEqual(removed, { draftId: DRAFT_ID, aiEffectId: null });
});

test("update_booth_draft PATCHes the draft and relays applied and rejected by name", async () => {
  const { studio, calls } = fakeStudio((call) => {
    if (call.method === "PATCH") {
      return {
        ...DRAFT_REPLY,
        spec: { ...DRAFT_REPLY.spec, welcome: { ...DRAFT_REPLY.spec.welcome, cta: "Mulai" } },
        overrides: { settings: { capture: { captureCount: 4 } } },
        overridesSummary: ["capture.captureCount=4"],
        applied: ["cta", "settings.capture.captureCount"],
        rejected: [{ field: "headline", reason: "is painted into the welcome image on this draft; change it with a redraw (refine_booth)" }],
      };
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const result = await buildUpdateBoothDraft(studio).handler({
    draftId: DRAFT_ID,
    buttonText: "Mulai",
    headline: "Selamat datang di Bandung",
    settings: { capture: { captureCount: 4 } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].path, "/api/onboarding/draft");
  assert.deepEqual(calls[0].body, {
    draftId: DRAFT_ID,
    cta: "Mulai",
    headline: "Selamat datang di Bandung",
    settings: { capture: { captureCount: 4 } },
  });
  assert.equal(result.state, "done");
  assert.equal(result.draft?.cta, "Mulai");
  assert.deepEqual(result.draft?.edited, ["capture.captureCount=4"]);
  assert.deepEqual(result.applied, ["cta", "settings.capture.captureCount"]);
  assert.equal(result.rejected?.length, 1);
  assert.match(String(result.note), /Applied: cta, settings\.capture\.captureCount/);
  assert.match(String(result.note), /Not applied: headline/);
});

test("update_booth_draft with nothing to change, or an unknown effect, answers as a result", async () => {
  const { studio, calls } = fakeStudio(() => ({ items: [{ id: HEX24("e"), title: "Anime Glow" }] }));
  const nothing = await buildUpdateBoothDraft(studio).handler({ draftId: DRAFT_ID });
  assert.equal(nothing.state, "failed");
  assert.match(String(nothing.error), /Nothing to change/);
  assert.equal(calls.length, 0, "no request for an empty edit");

  const unknown = await buildUpdateBoothDraft(studio).handler({ draftId: DRAFT_ID, aiEffectTitle: "Sparkle" });
  assert.equal(unknown.state, "failed");
  assert.match(String(unknown.error), /No AI effect called "Sparkle"/);
  assert.match(String(unknown.error), /Anime Glow/);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0, "nothing patched");
});

test("update_booth_draft on a Studio without the route says what still works", async () => {
  const { studio } = fakeStudio((call) => {
    if (call.method === "PATCH") throw new StudioError("Nothing found at /api/onboarding/draft.", 404, false);
    throw new Error("unexpected");
  });
  await assert.rejects(
    () => buildUpdateBoothDraft(studio).handler({ draftId: DRAFT_ID, buttonText: "Mulai" }),
    (err: unknown) => err instanceof StudioError && /cannot read or edit booth drafts yet/.test(err.message)
  );
});

test("resolveAiEffect matches the title case-insensitively and names what exists otherwise", async () => {
  const { studio } = fakeStudio(() => ({ items: [{ id: HEX24("e"), title: "Anime Glow" }, { id: HEX24("1"), title: "Vintage" }] }));
  assert.deepEqual(await resolveAiEffect(studio, "  ANIME glow "), { id: HEX24("e"), title: "Anime Glow" });
  await assert.rejects(
    () => resolveAiEffect(studio, "Sparkle"),
    (err: unknown) => err instanceof StudioError && /Anime Glow, Vintage/.test(err.message)
  );
});

/* --------------------------------------------------------------- create --- */

/** A Studio answering every create stage, with the draft carrying edits. */
function happyCreate(overrides: Partial<Record<string, Reply>> = {}): Reply {
  return (call) => {
    const key = `${call.method} ${call.path}${call.query?.checkOnly ? "?checkOnly" : ""}`;
    const custom = overrides[key];
    if (custom) return custom(call);
    switch (key) {
      case "GET /api/onboarding/draft":
        return {
          ...DRAFT_REPLY,
          overrides: { settings: { capture: { captureCount: 4 } }, frameIds: [HEX24("7")], filterIds: [HEX24("8")], aiEffectId: HEX24("e") },
          overridesSummary: ["capture.captureCount=4", "1 frame(s) chosen", "1 filter(s) chosen", "AI effect chosen"],
        };
      case "GET /api/projects/by-slug?checkOnly":
        return { available: true };
      case "GET /api/ai-effects/catalog":
        return { items: [{ id: HEX24("e"), title: "Anime Glow" }] };
      case "POST /api/onboarding/draft-frames":
        return { frames: [{}, {}, {}], status: "ready" };
      case "GET /api/onboarding/frames":
        return { mine: [], items: [{ _id: HEX24("2"), name: "Classic White" }, { _id: HEX24("3"), name: "Scrapbook Gold" }] };
      case "GET /api/onboarding/catalog":
        return { filters: { official: [{ _id: HEX24("f"), name: "Normal" }] } };
      case "POST /api/projects/onboarding":
        return { slug: (call.body as { slug: string }).slug };
      case "GET /api/projects/by-slug":
        return { _id: HEX24("b"), thumbnail: "https://cdn.dreambooth-team.workers.dev/project/__onboarding__/d-thumbnail.png" };
      default:
        throw new Error(`unexpected ${key}`);
    }
  };
}

test("create_booth takes title and slug from the draft and carries what the draft and this connection hold", async () => {
  const { studio, calls } = fakeStudio(happyCreate());
  const result = await createBoothWork(studio, CONFIG, { draftId: DRAFT_ID }, ctxOf([]), {
    pollSleep: noSleep,
    recentFrameIds: [HEX24("5")],
    recentFilterIds: [HEX24("6")],
  });
  const create = calls.find((c) => c.method === "POST" && c.path === "/api/projects/onboarding")?.body as Record<string, unknown>;
  assert.equal(create.title, "Bandung Wedding", "the draft's title");
  assert.equal(create.slug, "bandung-wedding", "the draft's proposed slug");
  assert.equal(create.aiEffectId, HEX24("e"), "the effect given to the draft");
  // Draft's frames, then the frame saved here, then starters — the draft's
  // words ("scrapbook", "gold") pick Scrapbook Gold before Classic White.
  assert.deepEqual(create.frameIds, [HEX24("7"), HEX24("5"), HEX24("3"), HEX24("2")]);
  // Normal first, then the draft's filter, then the one made here.
  assert.deepEqual(create.filterIds, [HEX24("f"), HEX24("8"), HEX24("6")]);
  assert.equal(result.title, "Bandung Wedding");
  assert.equal(result.aiEffect, "Anime Glow", "the title is looked up for the card");
  assert.equal(result.filterCount, 3);
});

test("create_booth: what the call names still comes first, and a call without title or slug on a bare draft is refused", async () => {
  const { studio, calls } = fakeStudio(happyCreate());
  await createBoothWork(
    studio,
    CONFIG,
    { draftId: DRAFT_ID, title: "Pernikahan", slug: "pernikahan", frameIds: [HEX24("c")], filterIds: [HEX24("d")], aiEffectTitle: "anime glow" },
    ctxOf([]),
    { pollSleep: noSleep }
  );
  const create = calls.find((c) => c.method === "POST" && c.path === "/api/projects/onboarding")?.body as Record<string, unknown>;
  assert.equal(create.title, "Pernikahan");
  assert.equal(create.slug, "pernikahan");
  assert.equal((create.frameIds as string[])[0], HEX24("c"));
  assert.equal((create.filterIds as string[])[1], HEX24("d"));

  const bare = fakeStudio(
    happyCreate({ "GET /api/onboarding/draft": () => ({ ...DRAFT_REPLY, slug: "", spec: { ...DRAFT_REPLY.spec, title: "", slugBase: "" } }) })
  );
  await assert.rejects(
    () => createBoothWork(bare.studio, CONFIG, { draftId: DRAFT_ID }, ctxOf([]), { pollSleep: noSleep }),
    (err: unknown) => err instanceof StudioError && /needs a title and a link name/.test(err.message)
  );
  assert.equal(bare.calls.length, 1, "refused before the link check");
});

test("create_booth still creates on a Studio without the draft route, and stops on a draft that is gone", async () => {
  const noRoute = fakeStudio(
    happyCreate({
      "GET /api/onboarding/draft": () => {
        throw new StudioError("Nothing found at /api/onboarding/draft.", 404, false);
      },
    })
  );
  const result = await createBoothWork(noRoute.studio, CONFIG, { draftId: DRAFT_ID, title: "Bandung Wedding", slug: "bandung-wedding" }, ctxOf([]), {
    pollSleep: noSleep,
  });
  assert.equal(result.slug, "bandung-wedding");
  const create = noRoute.calls.find((c) => c.method === "POST" && c.path === "/api/projects/onboarding")?.body as Record<string, unknown>;
  assert.deepEqual(create.filterIds, [HEX24("f")], "only what the call and the catalogue give");

  const gone = fakeStudio(
    happyCreate({
      "GET /api/onboarding/draft": () => {
        throw new StudioError("Draft not found", 404, false);
      },
    })
  );
  await assert.rejects(
    () => createBoothWork(gone.studio, CONFIG, { draftId: DRAFT_ID, title: "x y", slug: "x-y" }, ctxOf([]), { pollSleep: noSleep }),
    (err: unknown) => err instanceof StudioError && /not available to this account/.test(err.message)
  );
  assert.equal(gone.calls.length, 1, "nothing else is attempted");
});
