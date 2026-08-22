import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/server.js";
import { SessionTokens } from "../src/auth/tokenStore.js";
import { buildStartBooth } from "../src/tools/startBooth.js";
import { buildRefineBooth, refineBody } from "../src/tools/refineBooth.js";
import { buildCreateBooth, createBoothWork } from "../src/tools/createBooth.js";
import { buildCheckGeneration } from "../src/tools/checkGeneration.js";
import {
  BOOTH_CREATE_TIMEOUT_MS,
  BOOTH_GENERATE_TIMEOUT_MS,
  BOOTH_PUBLIC_ORIGIN,
  DRAFT_FRAMES_TIMEOUT_MS,
  boothErrorFor,
  pickStarterFrames,
  summariseDraft,
  withDraftProgress,
} from "../src/tools/boothGeneration.js";
import { AUTH_REQUIRED_TOOLS, requiresAuth } from "../src/mcp/toolAuth.js";
import { ownerKeyFor, type JobContext } from "../src/jobs/store.js";
import { StudioError } from "../src/studio/errors.js";
import type { Config } from "../src/config.js";
import type { StudioClient } from "../src/studio/client.js";

/**
 * A booth designed in chat, through the routes /new uses.
 *
 * What is asserted here, mostly, is the same honesty the frame tools are held
 * to — nothing is "created" until check_generation says so, a draft is not a
 * booth — plus the one thing a booth adds: the create step replicates /new's
 * last screens (frames, starter picks, the default filter) so the booth that
 * appears is complete, and it checks the link name BEFORE spending images.
 */

const CONFIG = {
  apiUrl: "https://studio.example",
  port: 0,
  requestTimeoutMs: 1000,
  allowedHosts: [],
  diagnostics: false,
} as unknown as Config;

const BOOTH_TOOLS = ["start_booth", "refine_booth", "create_booth"];
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

type Reply = (
  method: "GET" | "POST",
  path: string,
  body: unknown,
  query: Record<string, string | undefined> | undefined
) => unknown;

interface Call {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  options?: { timeoutMs?: number };
}

/** A Studio that records every call and answers per route; its own token per test. */
function fakeStudio(reply: Reply) {
  const token = randomUUID();
  const calls: Call[] = [];
  const studio = {
    ownerKey: () => ownerKeyFor(token),
    post: async (path: string, body: unknown, _query?: unknown, options?: { timeoutMs?: number }) => {
      calls.push({ method: "POST", path, body, options });
      return reply("POST", path, body, undefined);
    },
    get: async (
      path: string,
      query?: Record<string, string | undefined>,
      options?: { timeoutMs?: number }
    ) => {
      calls.push({ method: "GET", path, query, options });
      return reply("GET", path, undefined, query);
    },
  } as unknown as StudioClient;
  return { studio, calls };
}

const settled = () => new Promise((r) => setImmediate(r));
const drained = async () => {
  for (let i = 0; i < 12; i++) await settled();
};

/* ------------------------------------------------------------- the gate --- */

async function toolNames(bearerAuth: boolean): Promise<string[]> {
  const server = createServer(CONFIG, new SessionTokens(), {
    transport: "http",
    sessionId: () => undefined,
    stateless: true,
    bearerAuth,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const listed = await client.listTools();
  await client.close();
  await server.close();
  return listed.tools.map((t) => t.name);
}

test("the booth tools and preview_filter live on the OAuth path only", async () => {
  const withBearer = await toolNames(true);
  for (const name of [...BOOTH_TOOLS, "preview_filter"]) assert.ok(withBearer.includes(name), name);
  const anonymous = await toolNames(false);
  for (const name of [...BOOTH_TOOLS, "preview_filter"]) assert.ok(!anonymous.includes(name), name);
});

test("all of them are listed as needing auth, so a call without one starts a sign-in", () => {
  for (const name of [...BOOTH_TOOLS, "preview_filter"]) {
    assert.ok(AUTH_REQUIRED_TOOLS.has(name), name);
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } };
    assert.equal(requiresAuth(call), true, name);
  }
});

test("booth tools create; preview_filter and check_generation do not", async () => {
  const server = createServer(CONFIG, new SessionTokens(), {
    transport: "http",
    sessionId: () => undefined,
    stateless: true,
    bearerAuth: true,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const listed = await client.listTools();
  await client.close();
  await server.close();

  for (const name of BOOTH_TOOLS) {
    const tool = listed.tools.find((t) => t.name === name);
    assert.equal(tool?.annotations?.readOnlyHint, false, name);
    assert.equal(tool?.annotations?.idempotentHint, false, name);
  }
  for (const name of ["preview_filter", "check_generation"]) {
    const tool = listed.tools.find((t) => t.name === name);
    assert.equal(tool?.annotations?.readOnlyHint, true, name);
  }
});

/* ----------------------------------------------------- start + check --- */

test("start_booth posts the prompt and language only, with the long timeout", async () => {
  const { studio, calls } = fakeStudio(() => DRAFT_REPLY);
  const start = buildStartBooth(studio);

  const started = await start.handler({
    prompt: "pernikahan di Bandung, emas hangat",
    language: "id",
    ownerEmail: "someone.else@example.com",
  } as never);
  assert.equal(started.state, "running");
  assert.match(String(started.note), /do not describe the booth as made/i);
  await drained();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/onboarding/generate");
  assert.deepEqual(calls[0].body, { prompt: "pernikahan di Bandung, emas hangat", locale: "id" });
  assert.equal(calls[0].options?.timeoutMs, BOOTH_GENERATE_TIMEOUT_MS);
  assert.ok(BOOTH_GENERATE_TIMEOUT_MS >= 300_000, "at least the route's own ceiling");
});

test("check_generation reports a booth draft with what the next step needs", async () => {
  const { studio } = fakeStudio(() => DRAFT_REPLY);
  const start = buildStartBooth(studio);
  const check = buildCheckGeneration(studio, CONFIG);

  const started = await start.handler({ prompt: "wedding in Bandung, warm gold" });
  const running = await check.handler({ jobId: started.jobId });
  assert.equal(running.kind, "booth-draft");
  assert.equal(running.state, "running");
  assert.ok(running.progress, "the job says what it is doing");
  await drained();

  const done = await check.handler({ jobId: started.jobId });
  assert.equal(done.state, "done");
  assert.equal(done.kind, "booth-draft");
  assert.equal(done.draft?.draftId, DRAFT_ID);
  assert.equal(done.draft?.title, "Bandung Wedding");
  assert.equal(done.draft?.slug, "bandung-wedding");
  assert.equal(done.draft?.welcomePortraitUrl, DRAFT_REPLY.assets.welcomeBgPortrait);
  assert.equal(done.draft?.remainingFullGenerations, 2);
  assert.equal(done.draft?.remainingRegens, 5);
  assert.deepEqual(done.draft?.frameTags, ["scrapbook", "gold"]);
  // The sentence that stops a model calling a draft a booth.
  assert.match(String(done.note), /not a booth/i);
  assert.match(String(done.note), /create_booth/);
});

test("a reply without a design is a failure, not a done job", async () => {
  const { studio } = fakeStudio(() => ({ draftId: DRAFT_ID, spec: null }));
  const start = buildStartBooth(studio);
  const check = buildCheckGeneration(studio, CONFIG);
  const started = await start.handler({ prompt: "x" });
  await drained();
  const done = await check.handler({ jobId: started.jobId });
  assert.equal(done.state, "failed");
  assert.match(String(done.error), /without a booth design/i);
});

/* --------------------------------------------------------------- refine --- */

test("refine_booth maps what + orientation onto the Studio's regen targets", () => {
  const base = { draftId: DRAFT_ID, instruction: "warmer" };
  assert.deepEqual(refineBody({ ...base, what: "welcome", orientation: "phone" }), {
    draftId: DRAFT_ID,
    regenTarget: "welcomeBgPortrait",
    hint: "warmer",
  });
  assert.deepEqual(refineBody({ ...base, what: "welcome", orientation: "laptop" }), {
    draftId: DRAFT_ID,
    regenTarget: "welcomeBgLandscape",
    hint: "warmer",
  });
  assert.deepEqual(refineBody({ ...base, what: "welcome" }), {
    draftId: DRAFT_ID,
    regenTarget: "welcome",
    hint: "warmer",
  });
  assert.deepEqual(refineBody({ ...base, what: "app-background" }), {
    draftId: DRAFT_ID,
    regenTarget: "appBg",
    hint: "warmer",
  });
  // A rebuild is the full-generation body, not a regen.
  assert.deepEqual(refineBody({ ...base, what: "everything", instruction: "a different booth" }), {
    draftId: DRAFT_ID,
    prompt: "a different booth",
  });
});

test("refine_booth posts that body and keeps the draft id on the handle and the result", async () => {
  const { studio, calls } = fakeStudio(() => ({
    ...DRAFT_REPLY,
    remaining: { fullGenerations: 2, regens: 4 },
    regeneratedOrientations: ["portrait"],
  }));
  const refine = buildRefineBooth(studio);
  const check = buildCheckGeneration(studio, CONFIG);

  const started = await refine.handler({
    draftId: DRAFT_ID,
    what: "welcome",
    orientation: "phone",
    instruction: "warmer, bigger headline",
  });
  assert.equal(started.state, "running");
  assert.equal(started.draftId, DRAFT_ID);
  await drained();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    draftId: DRAFT_ID,
    regenTarget: "welcomeBgPortrait",
    hint: "warmer, bigger headline",
  });
  assert.equal(calls[0].options?.timeoutMs, BOOTH_GENERATE_TIMEOUT_MS);

  const done = await check.handler({ jobId: started.jobId });
  assert.equal(done.draft?.remainingRegens, 4);
  assert.deepEqual(done.draft?.regenerated, ["portrait"]);
});

test("refine_booth refuses a long hint and a misplaced orientation as results, not protocol errors", async () => {
  const { studio, calls } = fakeStudio(() => DRAFT_REPLY);
  const refine = buildRefineBooth(studio);

  const long = await refine.handler({ draftId: DRAFT_ID, what: "welcome", instruction: "x".repeat(301) });
  assert.equal(long.state, "failed");
  assert.match(String(long.error), /300 characters/);

  const misplaced = await refine.handler({
    draftId: DRAFT_ID,
    what: "app-background",
    orientation: "phone",
    instruction: "darker",
  });
  assert.equal(misplaced.state, "failed");
  assert.match(String(misplaced.error), /orientation only applies/);

  // A rebuild may be as long as a first prompt.
  const rebuild = await refine.handler({ draftId: DRAFT_ID, what: "everything", instruction: "y".repeat(900) });
  assert.equal(rebuild.state, "running");
  await drained();
  // Only the rebuild reached the Studio as a write; the GETs are its progress
  // narration, which the refused calls never started.
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("a rebuild narrates the Studio's progress steps into the job", async () => {
  let step = "spec";
  const { studio } = fakeStudio((method, path) => {
    if (method === "GET" && path === "/api/onboarding/progress") return { step };
    return DRAFT_REPLY;
  });
  const seen: string[] = [];
  const ctx: JobContext = { jobId: "j", progress: (t) => seen.push(t) };

  const result = await withDraftProgress(
    studio,
    DRAFT_ID,
    ctx,
    async () => {
      await new Promise((r) => setTimeout(r, 15));
      step = "welcome_portrait";
      await new Promise((r) => setTimeout(r, 15));
      return "done";
    },
    2
  );
  assert.equal(result, "done");
  assert.ok(seen.some((s) => /title, colours/i.test(s)), seen.join(" | "));
  assert.ok(seen.some((s) => /phones/i.test(s)), seen.join(" | "));
});

/* --------------------------------------------------------------- errors --- */

test("boothErrorFor turns the Studio's refusals into the next step", () => {
  const studio = (status: number, message: string) => new StudioError(message, status, false);
  const s = (e: StudioError) => e.message;

  assert.match(s(boothErrorFor(studio(401, "Sign in to generate your booth."), "generate")), /not deployed yet/);
  assert.match(s(boothErrorFor(studio(401, "Sign in to save your booth."), "create")), /not deployed yet/);
  assert.match(s(boothErrorFor(studio(404, "Not found"), "generate")), /not enabled/);
  assert.match(s(boothErrorFor(studio(404, "Nothing found at /api/onboarding/generate."), "generate")), /not enabled/);
  assert.match(s(boothErrorFor(studio(404, "Draft not found"), "refine")), /expired|another account/);
  assert.match(s(boothErrorFor(studio(409, "That booth link is already taken."), "create")), /draft and its drawn frames are intact/);
  assert.match(s(boothErrorFor(studio(429, "Generation limit reached — sign in to continue customizing."), "generate")), /all 3 of its full generations/);
  assert.match(s(boothErrorFor(studio(429, "Regeneration limit reached for this draft."), "refine")), /all 5 of its redraws/);
  assert.match(s(boothErrorFor(studio(429, "Too many booths created from this account. Try again later."), "generate")), /Try again in an hour/);

  // A failed generation does not consume the allowance, so it is retryable —
  // the one case in this table that is.
  const failed = boothErrorFor(studio(500, "Generation failed. Try again."), "generate");
  assert.equal(failed.retryable, true);
  assert.match(failed.message, /does not count against/);
  assert.equal(boothErrorFor(studio(500, "boom"), "create").retryable, false);

  assert.match(s(boothErrorFor(studio(504, "timed out"), "generate")), /start again with start_booth/i);
  assert.match(s(boothErrorFor(studio(504, "timed out"), "create")), /list_projects/);
  // Anything else passes through untouched.
  assert.equal(s(boothErrorFor(studio(403, "read-only"), "generate")), "read-only");
  assert.match(s(boothErrorFor(new Error("socket hang up"), "create")), /socket hang up/);
});

/* ---------------------------------------------------------- starter frames --- */

test("pickStarterFrames matches the draft's words first, then popularity order", () => {
  const pool = [
    { _id: "p1", name: "Classic White" },
    { _id: "p2", name: "Scrapbook Doodles" },
    { _id: "p3", name: "Golden Hour" },
    { _id: "p4", name: "Neon Y2K" },
    { _id: "p5", name: "Scrapbook Gold" },
  ];
  // "scrapbook" + "gold" + "warm": two hits beat one, ties keep incoming order.
  assert.deepEqual(pickStarterFrames(pool, ["scrapbook", "gold", "warm"]), ["p5", "p2", "p3"]);
  // Nothing matches: the three most popular, as /new does.
  assert.deepEqual(pickStarterFrames(pool, ["underwater"]), ["p1", "p2", "p3"]);
  // Short words do not count; neither does an empty pool.
  assert.deepEqual(pickStarterFrames(pool, ["y2"]), ["p1", "p2", "p3"]);
  assert.deepEqual(pickStarterFrames([], ["scrapbook"]), []);
});

/* --------------------------------------------------------------- create --- */

const CREATE_ARGS = { draftId: DRAFT_ID, title: "Bandung Wedding", slug: "bandung-wedding" };
const ctxOf = (seen: string[]): JobContext => ({ jobId: "j", progress: (t) => seen.push(t) });
const noSleep = async () => {};

/** A Studio that answers every stage of a create happily. */
function happyCreate(overrides: Partial<Record<string, Reply>> = {}): Reply {
  return (method, path, body, query) => {
    const key = `${method} ${path}${query?.checkOnly ? "?checkOnly" : ""}`;
    const custom = overrides[key];
    if (custom) return custom(method, path, body, query);
    switch (key) {
      case "GET /api/projects/by-slug?checkOnly":
        return { available: true };
      case "GET /api/ai-effects/catalog":
        return { items: [{ id: HEX24("e"), title: "Anime Glow" }] };
      case "POST /api/onboarding/draft-frames":
        return { frames: [{ url: "u1" }, { url: "u2" }, { url: "u3" }], status: "ready" };
      case "GET /api/onboarding/frames":
        return {
          mine: [{ _id: HEX24("1"), name: "My Gold Strip" }],
          items: [
            { _id: HEX24("2"), name: "Classic White" },
            { _id: HEX24("3"), name: "Scrapbook Doodles" },
            { _id: HEX24("4"), name: "Neon" },
          ],
        };
      case "GET /api/onboarding/catalog":
        return { filters: { official: [{ _id: HEX24("f"), name: "Normal" }, { _id: HEX24("9"), name: "Warm" }] } };
      case "POST /api/projects/onboarding":
        return { slug: (body as { slug: string }).slug };
      case "GET /api/projects/by-slug":
        return { _id: HEX24("b"), slug: query?.slug };
      default:
        throw new Error(`unexpected ${key}`);
    }
  };
}

test("create_booth runs /new's last screens in order and sends no theme", async () => {
  const { studio, calls } = fakeStudio(happyCreate());
  const seen: string[] = [];

  const result = await createBoothWork(
    studio,
    CONFIG,
    { ...CREATE_ARGS, frameIds: [HEX24("c")], filterIds: [HEX24("d")], aiEffectTitle: "anime glow" },
    ctxOf(seen),
    { draftTerms: ["scrapbook", "gold"], pollSleep: noSleep }
  );

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      "GET /api/projects/by-slug",
      "GET /api/ai-effects/catalog",
      "POST /api/onboarding/draft-frames",
      "GET /api/onboarding/frames",
      "GET /api/onboarding/catalog",
      "POST /api/projects/onboarding",
      "GET /api/projects/by-slug",
    ]
  );
  assert.equal(calls[0].query?.checkOnly, "true", "the link name is checked first");
  assert.equal(calls[2].options?.timeoutMs, DRAFT_FRAMES_TIMEOUT_MS);

  const create = calls[5].body as Record<string, unknown>;
  assert.equal(create.mode, "creator");
  assert.equal(create.title, "Bandung Wedding");
  assert.equal(create.slug, "bandung-wedding");
  assert.equal(create.draftId, DRAFT_ID);
  assert.equal(create.aiEffectId, HEX24("e"), "resolved from the title, case-insensitively");
  assert.equal("theme" in create, false, "the route falls back to the draft's palette, as /new's result does");
  assert.equal("ownerEmail" in create, false);
  // Explicit picks lead; then the three starters — the operator's own gold
  // strip first (it leads the pool), then the two best matches.
  assert.deepEqual(create.frameIds, [HEX24("c"), HEX24("1"), HEX24("3"), HEX24("2")]);
  // The Studio's "Normal" leads the filters, then the operator's own.
  assert.deepEqual(create.filterIds, [HEX24("f"), HEX24("d")]);
  assert.equal(calls[5].options?.timeoutMs, BOOTH_CREATE_TIMEOUT_MS);

  assert.equal(result.slug, "bandung-wedding");
  assert.equal(result.projectId, HEX24("b"));
  assert.equal(result.boothUrl, `${BOOTH_PUBLIC_ORIGIN}/bandung-wedding`);
  assert.equal(result.dashboardUrl, `https://studio.example/dashboard/projects/${HEX24("b")}/editor`);
  assert.equal(result.ownFrameCount, 3);
  assert.equal(result.catalogFrameCount, 4);
  assert.equal(result.filterCount, 2);
  assert.equal(result.aiEffect, "Anime Glow");
  assert.ok(seen.some((s) => /link name/i.test(s)) && seen.some((s) => /Creating the booth/.test(s)));
});

test("a taken link name stops the create before anything is drawn", async () => {
  const { studio, calls } = fakeStudio(
    happyCreate({ "GET /api/projects/by-slug?checkOnly": () => ({ available: false }) })
  );
  await assert.rejects(
    () => createBoothWork(studio, CONFIG, CREATE_ARGS, ctxOf([]), { pollSleep: noSleep }),
    (err: unknown) => err instanceof StudioError && /already taken/.test(err.message) && /untouched/.test(err.message)
  );
  assert.equal(calls.length, 1, "no frames drawn, no booth created");
});

test("an unknown AI effect stops the create and names what exists", async () => {
  const { studio, calls } = fakeStudio(happyCreate());
  await assert.rejects(
    () =>
      createBoothWork(studio, CONFIG, { ...CREATE_ARGS, aiEffectTitle: "Sparkle" }, ctxOf([]), {
        pollSleep: noSleep,
      }),
    (err: unknown) => err instanceof StudioError && /No AI effect called "Sparkle"/.test(err.message) && /Anime Glow/.test(err.message)
  );
  assert.equal(calls.length, 2);
});

test("frames still drawing are polled, then used; unavailable frames are not fatal", async () => {
  let draws = 0;
  const polling = fakeStudio(
    happyCreate({
      "POST /api/onboarding/draft-frames": () =>
        ++draws < 3 ? { frames: [], status: "drawing" } : { frames: [{}, {}, {}], status: "ready" },
    })
  );
  const sleeps: number[] = [];
  const polled = await createBoothWork(polling.studio, CONFIG, CREATE_ARGS, ctxOf([]), {
    pollSleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(draws, 3);
  assert.equal(sleeps.length, 2, "waited between polls");
  assert.equal(polled.ownFrameCount, 3);

  const none = fakeStudio(
    happyCreate({ "POST /api/onboarding/draft-frames": () => ({ frames: [], status: "unavailable" }) })
  );
  const result = await createBoothWork(none.studio, CONFIG, CREATE_ARGS, ctxOf([]), { pollSleep: noSleep });
  assert.equal(result.ownFrameCount, 0);
  assert.ok(none.calls.some((c) => c.path === "/api/projects/onboarding"), "the booth is still created");
});

test("a failed id lookup after creation is not a failed creation", async () => {
  const { studio } = fakeStudio(
    happyCreate({
      "GET /api/projects/by-slug": () => {
        throw new StudioError("Nothing found at /api/projects/by-slug.", 404, false);
      },
    })
  );
  const result = await createBoothWork(studio, CONFIG, CREATE_ARGS, ctxOf([]), { pollSleep: noSleep });
  assert.equal(result.slug, "bandung-wedding");
  assert.equal(result.projectId, undefined);
  assert.equal(result.dashboardUrl, "https://studio.example/dashboard/projects");
});

test("the Studio's create refusals come back as the next step", async () => {
  const { studio } = fakeStudio(
    happyCreate({
      "POST /api/projects/onboarding": () => {
        throw new StudioError("Sign in to save your booth.", 401, false);
      },
    })
  );
  await assert.rejects(
    () => createBoothWork(studio, CONFIG, CREATE_ARGS, ctxOf([]), { pollSleep: noSleep }),
    (err: unknown) => err instanceof StudioError && /not deployed yet/.test(err.message)
  );
});

test("create_booth refuses a second create for the same draft while one runs", async () => {
  let release!: (v: unknown) => void;
  const { studio } = fakeStudio((method, path) => {
    if (method === "GET" && path === "/api/projects/by-slug") return new Promise((r) => (release = r));
    throw new Error(`unexpected ${method} ${path}`);
  });
  const create = buildCreateBooth(studio, CONFIG);

  const first = await create.handler(CREATE_ARGS);
  assert.equal(first.state, "running");
  assert.match(String(first.note), /Nothing exists yet/);

  const second = await create.handler({ ...CREATE_ARGS, slug: "another-slug" });
  assert.equal(second.state, "failed");
  assert.match(String(second.error), /already being created/);
  assert.match(String(second.error), new RegExp(first.jobId));

  release({ available: false }); // ends the first as "taken"; the test only needed it running
  await drained();
});

/* ------------------------------------------------ the published schema --- */

/**
 * Every result must satisfy the outputSchema the server PUBLISHES — the
 * JSON Schema carries `additionalProperties: false`, so an undeclared key is
 * a client-side protocol error the operator experiences as a hang. Only a
 * round trip through a real client can see that.
 */
test("every booth and filter-preview result satisfies the published output schema", async () => {
  const releases: Array<(r: Response) => void> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => releases.push(resolve))) as typeof fetch;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const releaseNext = async (body: unknown) => {
    for (let i = 0; i < 50 && releases.length === 0; i++) await settled();
    assert.ok(releases.length > 0, "a Studio call is waiting to be released");
    releases.shift()!(json(body));
    await drained();
  };

  const server = createServer(CONFIG, SessionTokens.forRequest("booth-schema-token"), {
    transport: "http",
    sessionId: () => undefined,
    stateless: true,
    bearerAuth: true,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  type Result = { structuredContent?: Record<string, unknown>; isError?: boolean };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<Result>;

  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.listTools();

    // Design: running (with progress), then done with a draft.
    const started = await call("start_booth", { prompt: "wedding in Bandung, warm gold", language: "id" });
    assert.equal(started.isError, undefined);
    assert.equal(started.structuredContent?.state, "running");
    const jobId = String(started.structuredContent?.jobId);
    const running = await call("check_generation", { jobId });
    assert.equal(running.structuredContent?.state, "running");
    assert.ok(running.structuredContent?.progress);
    await releaseNext(DRAFT_REPLY);
    const done = await call("check_generation", { jobId });
    assert.equal(done.structuredContent?.state, "done");
    assert.equal((done.structuredContent?.draft as { draftId?: string })?.draftId, DRAFT_ID);

    // Refine: the handle carries the draft id.
    const refined = await call("refine_booth", { draftId: DRAFT_ID, what: "welcome", instruction: "warmer" });
    assert.equal(refined.structuredContent?.draftId, DRAFT_ID);
    await releaseNext({ ...DRAFT_REPLY, regeneratedOrientations: ["portrait", "landscape"] });
    const refinedDone = await call("check_generation", { jobId: String(refined.structuredContent?.jobId) });
    assert.equal(refinedDone.structuredContent?.state, "done");

    // Create: every stage released in order, then a booth.
    const created = await call("create_booth", { draftId: DRAFT_ID, title: "Bandung Wedding", slug: "bandung-wedding" });
    assert.equal(created.isError, undefined);
    assert.equal(created.structuredContent?.state, "running");
    await releaseNext({ available: true });
    await releaseNext({ frames: [{}, {}, {}], status: "ready" });
    await releaseNext({ items: [{ _id: HEX24("2"), name: "Classic White" }], mine: [] });
    await releaseNext({ filters: { official: [{ _id: HEX24("f"), name: "Normal" }] } });
    await releaseNext({ slug: "bandung-wedding" });
    await releaseNext({ _id: HEX24("b") });
    const boothDone = await call("check_generation", { jobId: String(created.structuredContent?.jobId) });
    assert.equal(boothDone.structuredContent?.state, "done");
    assert.equal(boothDone.structuredContent?.kind, "booth");
    assert.equal((boothDone.structuredContent?.booth as { slug?: string })?.slug, "bandung-wedding");

    // Preview: a URL and the split.
    const previewPromise = call("preview_filter", { adjustments: { contrast: 112, shadows: 20 } });
    await releaseNext({
      previewUrl: "https://cdn.dreambooth-team.workers.dev/filter-previews/abc.jpg",
      previewed: ["contrast"],
      notPreviewed: ["shadows"],
      sample: "default",
    });
    const preview = await previewPromise;
    assert.equal(preview.isError, undefined);
    assert.equal(preview.structuredContent?.kind, "filter-preview");
    assert.match(String(preview.structuredContent?.note), /shadows/);

    // Unknown, and the most-recent-job form.
    const unknown = await call("check_generation", { jobId: "not-a-real-job" });
    assert.equal(unknown.structuredContent?.state, "unknown");
    const latest = await call("check_generation");
    assert.equal(latest.structuredContent?.kind, "booth");
  } finally {
    globalThis.fetch = realFetch;
    await client.close();
    await server.close();
  }
});

/* --------------------------------------------------------------- shape --- */

test("summariseDraft refuses a reply without a draft or a spec", () => {
  assert.throws(() => summariseDraft({ draftId: DRAFT_ID, spec: null }), /without a booth design/);
  assert.throws(() => summariseDraft({ spec: DRAFT_REPLY.spec }), /without a booth design/);
  const ok = summariseDraft(DRAFT_REPLY);
  assert.equal(ok.headline, "Selamat datang");
  assert.equal(ok.language, "id");
  assert.equal(ok.palette.primaryColor, "#B8860B");
});
