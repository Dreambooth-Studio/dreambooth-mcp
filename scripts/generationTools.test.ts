import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/server.js";
import { SessionTokens } from "../src/auth/tokenStore.js";
import { buildStartFrame } from "../src/tools/startFrame.js";
import { buildRefineFrame } from "../src/tools/refineFrame.js";
import { buildCheckGeneration } from "../src/tools/checkGeneration.js";
import { buildSaveFrame } from "../src/tools/saveFrame.js";
import { GENERATION_TIMEOUT_MS } from "../src/tools/frameGeneration.js";
import { AUTH_REQUIRED_TOOLS, requiresAuth } from "../src/mcp/toolAuth.js";
import { ownerKeyFor } from "../src/jobs/store.js";
import type { Config } from "../src/config.js";
import type { StudioClient } from "../src/studio/client.js";

/**
 * The one capability that cannot answer in a single call, and the one flow
 * that is a conversation rather than a command.
 *
 * Most of what is asserted here is about not lying to somebody who is waiting:
 * a generation takes up to two minutes, so there is a window in which the
 * honest answer is "nothing exists yet" — and the failure mode this guards is
 * a model telling an operator their frame is ready because a tool returned,
 * or that it is saved because a preview exists.
 */

const CONFIG = {
  apiUrl: "https://studio.example",
  port: 0,
  requestTimeoutMs: 1000,
  allowedHosts: [],
  diagnostics: false,
} as unknown as Config;

const FRAME_TOOLS = ["start_frame", "refine_frame", "check_generation", "save_frame"];

const THREAD = {
  threadId: "t1",
  templateId: "blank-rect-triple-strip",
  layout: "strip-3",
  shape: "rect",
  canvasWidth: 1600,
  canvasHeight: 2400,
  placeholderCount: 6,
};

const IMAGE = "https://cdn.dreambooth.app/project/op%40example.com/ai-generated-1.png";

const generated = (id: string) => ({
  generation: { _id: id, status: "completed" },
  message: { content: "Generated options ready. You can apply or iterate." },
  imageUrls: [IMAGE],
});

type Reply = (path: string, body: unknown) => unknown;

/**
 * A Studio that records every call and answers per route.
 *
 * Each fake gets its own token, so its jobs live under their own owner key:
 * the job store is process-wide, and a hanging generation left behind by one
 * test must not count against the in-flight cap in the next.
 */
function fakeStudio(reply: Reply) {
  const token = randomUUID();
  const calls: Array<{ path: string; body: unknown; options?: { timeoutMs?: number } }> = [];
  const studio = {
    ownerKey: () => ownerKeyFor(token),
    post: async (path: string, body: unknown, _query?: unknown, options?: { timeoutMs?: number }) => {
      calls.push({ path, body, options });
      return reply(path, body);
    },
  } as unknown as StudioClient;
  return { studio, calls };
}

/** The happy path: start opens a thread, messages generates. */
const happy: Reply = (path) => {
  if (path === "/api/ai/frames/start") return THREAD;
  if (path.endsWith("/messages")) return generated("g1");
  throw new Error(`unexpected route ${path}`);
};

const settled = () => new Promise((r) => setImmediate(r));
/** A few ticks: a job that chains two awaits needs more than one. */
const drained = async () => {
  for (let i = 0; i < 10; i++) await settled();
};

/* ------------------------------------------------------------- the gate --- */

async function toolNames(bearerAuth: boolean, config: Config = CONFIG): Promise<string[]> {
  const server = createServer(config, new SessionTokens(), {
    transport: "http",
    sessionId: () => undefined,
    stateless: true,
    bearerAuth,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  await client.close();
  await server.close();
  return listed.tools.map((t) => t.name);
}

test("the frame tools live on the OAuth path only", async () => {
  const withBearer = await toolNames(true);
  for (const name of FRAME_TOOLS) assert.ok(withBearer.includes(name), name);

  // A device-flow token is a year long, unscoped and unrevocable. Generating
  // spends the operator's daily allowance, so it belongs behind the credential
  // that expires and can be revoked, like every other write here.
  const anonymous = await toolNames(false);
  for (const name of FRAME_TOOLS) assert.ok(!anonymous.includes(name), name);
});

test("all four are listed as needing auth, so a call without one starts a sign-in", () => {
  // They are registered only when a bearer is present, so without this a call
  // would come back "unknown tool" — which tells the client nothing and starts
  // no OAuth flow.
  for (const name of FRAME_TOOLS) {
    assert.ok(AUTH_REQUIRED_TOOLS.has(name), name);
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } };
    assert.equal(requiresAuth(call), true, `${name} triggers the sign-in 401`);
  }
});

test("start, refine and save create; check_generation does not", async () => {
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

  for (const name of ["start_frame", "refine_frame", "save_frame"]) {
    const tool = listed.tools.find((t) => t.name === name);
    assert.equal(tool?.annotations?.readOnlyHint, false, name);
    assert.equal(tool?.annotations?.idempotentHint, false, `${name}: two calls make two things`);
  }

  // Polling is only tolerable if a client may do it without asking each time.
  const check = listed.tools.find((t) => t.name === "check_generation");
  assert.equal(check?.annotations?.readOnlyHint, true);

  // The preview card is the only widget allowed to name an image origin; the
  // others stay closed to the network entirely.
  const resources = await (async () => {
    const s = createServer(CONFIG, new SessionTokens(), {
      transport: "http",
      sessionId: () => undefined,
      stateless: true,
      bearerAuth: true,
    });
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    const cl = new Client({ name: "test", version: "0" });
    await Promise.all([s.connect(s2), cl.connect(c2)]);
    const r = await cl.listResources();
    await cl.close();
    await s.close();
    return r.resources;
  })();
  const preview = resources.find((r) => r.uri === "ui://widget/generation.html");
  const writeCard = resources.find((r) => r.uri === "ui://widget/write-result.html");
  assert.ok(preview, "preview card registered");
  const previewCsp = (preview?._meta as { "ui.csp"?: { resourceDomains?: string[] } })?.["ui.csp"];
  assert.ok((previewCsp?.resourceDomains?.length ?? 0) > 0, "preview card may load images");
  const writeCsp = (writeCard?._meta as { "ui.csp"?: { resourceDomains?: string[] } })?.["ui.csp"];
  assert.deepEqual(writeCsp?.resourceDomains, [], "write-result card stays closed");
});

/* ----------------------------------------------------- what gets sent --- */

test("start_frame opens a thread then generates in it, forwarding nothing invented", async () => {
  const { studio, calls } = fakeStudio(happy);
  const tool = buildStartFrame(studio);

  const started = await tool.handler({
    prompt: "batik motifs in warm gold",
    layout: "strip-3",
    shape: "rounded",
    // Identity is never an argument. Even invented, it must not leave here.
    ownerEmail: "someone.else@example.com",
  } as never);
  assert.equal(started.state, "running");
  await drained();

  assert.deepEqual(
    calls.map((c) => c.path),
    ["/api/ai/frames/start", "/api/ai/threads/t1/messages"]
  );
  const startBody = calls[0].body as Record<string, unknown>;
  assert.equal(startBody.ownerEmail, undefined, "ownerEmail must never be forwarded");
  // The whole point of the layout vocabulary: no width, height or photo window
  // chosen by the model ever reaches the Studio.
  assert.deepEqual(Object.keys(startBody).sort(), ["layout", "shape"]);
  assert.equal(startBody.layout, "strip-3");

  const messageBody = calls[1].body as Record<string, unknown>;
  assert.equal(messageBody.prompt, "batik motifs in warm gold");
  assert.match(String(messageBody.generationRequestId), /^[0-9a-f-]{36}$/, "a UUID, as the route requires");
  // Background work waits on the image model; the interactive ceiling would
  // abort every generation at 15 s and report "may have gone through".
  assert.equal(calls[1].options?.timeoutMs, GENERATION_TIMEOUT_MS);
  assert.ok(GENERATION_TIMEOUT_MS >= 120_000, "at least the Studio route's own ceiling");
  assert.equal(calls[0].options?.timeoutMs, undefined, "opening the thread is a normal call");
});

test("start_frame returns a handle and says nothing exists yet", async () => {
  const { studio } = fakeStudio(() => new Promise(() => {}));
  const tool = buildStartFrame(studio);

  const result = await tool.handler({ prompt: "minimal", layout: "grid-4" });

  assert.equal(result.state, "running");
  assert.ok(result.jobId);
  // The sentence that stops a model announcing a frame that does not exist.
  assert.match(String(result.note), /do not describe the frame as made/i);
  assert.match(String(result.note), /saved/i, "and says it is not saved either");
});

test("refine_frame generates in the thread it was given and keeps the id in the result", async () => {
  const { studio, calls } = fakeStudio((path) => {
    assert.equal(path, "/api/ai/threads/t-existing/messages");
    return generated("g2");
  });
  const refine = buildRefineFrame(studio);
  const check = buildCheckGeneration(studio, CONFIG);

  const started = await refine.handler({ threadId: "t-existing", prompt: "darker, less ornament" });
  assert.equal(started.state, "running");
  assert.equal(started.threadId, "t-existing", "known before the job finishes");
  await drained();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.timeoutMs, GENERATION_TIMEOUT_MS);

  const done = await check.handler({ jobId: started.jobId });
  assert.equal(done.state, "done");
  assert.equal(done.threadId, "t-existing");
  assert.equal(done.generationId, "g2");
  assert.equal(done.imageUrl, IMAGE);
});

/* ------------------------------------------------------------- polling --- */

test("check_generation reports running, then the preview with what the next step needs", async () => {
  let release!: (v: unknown) => void;
  const { studio } = fakeStudio((path) =>
    path === "/api/ai/frames/start" ? THREAD : new Promise((r) => (release = r))
  );
  const start = buildStartFrame(studio);
  const check = buildCheckGeneration(studio, CONFIG);

  const started = await start.handler({ prompt: "batik", layout: "strip-3" });
  await drained();

  const running = await check.handler({ jobId: started.jobId });
  assert.equal(running.state, "running");
  assert.equal(running.imageUrl, undefined);
  assert.match(String(running.note), /nothing exists yet/i);

  release(generated("g9"));
  await drained();

  const done = await check.handler({ jobId: started.jobId });
  assert.equal(done.state, "done");
  // The three things the model needs next: to show, to refine, to save.
  assert.equal(done.imageUrl, IMAGE);
  assert.equal(done.threadId, "t1");
  assert.equal(done.generationId, "g9");
  assert.equal(done.layout, "strip-3");
  assert.equal(done.placeholderCount, 6);
  // And the sentence that keeps a preview from being described as a frame.
  assert.match(String(done.note), /not a saved frame/i);
});

test("the Studio's in-thread refusals become the Studio's own sentences", async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    [
      "free quota",
      {
        freeQuotaBlocked: true,
        freeQuotaReason: "user_cap",
        quotaResetAt: "2026-08-23T00:00:00.000Z",
        message: { content: "You've used all your free generations for today." },
      },
      /free generations for today.*resets at 2026-08-23/s,
    ],
    [
      "content block",
      {
        message: { content: "This request was blocked because it names content the image model won't generate." },
        failureReason: "content_blocked",
      },
      /blocked because it names content/,
    ],
    [
      "no image",
      {
        generation: { _id: "g-failed", status: "failed" },
        message: { content: "The model didn't return an image this time." },
        imageUrls: [],
      },
      /didn't return an image/,
    ],
  ];

  for (const [label, reply, expected] of cases) {
    const { studio } = fakeStudio((path) => (path === "/api/ai/frames/start" ? THREAD : reply));
    const start = buildStartFrame(studio);
    const check = buildCheckGeneration(studio, CONFIG);

    const started = await start.handler({ prompt: "x", layout: "strip-3" });
    await drained();

    const done = await check.handler({ jobId: started.jobId });
    assert.equal(done.state, "failed", label);
    // All three arrive from the Studio as HTTP 200, because the dashboard
    // renders them in-thread. They must not be reported as success here, and
    // the operator must get the actionable sentence, not "generation failed".
    assert.match(String(done.error), expected, label);
    assert.equal(done.imageUrl, undefined, label);
  }
});

test("a failed generation relays a Studio HTTP refusal verbatim", async () => {
  const { studio } = fakeStudio((path) => {
    if (path === "/api/ai/frames/start") return THREAD;
    return Promise.reject(
      Object.assign(new Error("This connection is read-only. Reconnect the app and approve permission to create things."), {
        status: 403,
      })
    );
  });
  const start = buildStartFrame(studio);
  const check = buildCheckGeneration(studio, CONFIG);

  const started = await start.handler({ prompt: "x", layout: "pair-2" });
  await drained();

  const done = await check.handler({ jobId: started.jobId });
  assert.equal(done.state, "failed");
  assert.match(String(done.error), /read-only/);
});

test("an unknown job id points at the thread and the dashboard instead of claiming failure", async () => {
  const { studio } = fakeStudio(() => ({}));
  const check = buildCheckGeneration(studio, CONFIG);

  // This store is per-process: a restart loses running jobs while the Studio
  // carries on and finishes them. Reporting a failure here would tell the
  // operator nothing was generated when something may well have been.
  const answer = await check.handler({ jobId: "not-a-real-job" });
  assert.equal(answer.state, "unknown");
  assert.match(String(answer.error), /threadId still works with refine_frame/i);
  assert.match(String(answer.error), /dashboard/i);
  assert.ok(answer.dashboardUrl);
});

/* -------------------------------------------------------------- saving --- */

test("save_frame sends only the fields it declares and reports the frame", async () => {
  const { studio, calls } = fakeStudio((path) => {
    assert.equal(path, "/api/ai/frames/from-generation");
    return {
      frameId: "f1",
      name: "Batik Emas",
      isPublic: false,
      canvasWidth: 1600,
      canvasHeight: 2400,
      placeholderCount: 6,
      thumbnailUrl: "https://cdn.dreambooth.app/project/op/onboarding-ai-frame-1.png",
      threadId: "t1",
      generationId: "g9",
    };
  });
  const save = buildSaveFrame(studio, CONFIG);

  const result = await save.handler({
    threadId: "t1",
    generationId: "g9",
    name: "Batik Emas",
    ownerEmail: "someone.else@example.com",
  } as never);

  assert.equal(calls.length, 1);
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body.ownerEmail, undefined, "ownerEmail must never be forwarded");
  assert.deepEqual(Object.keys(body).sort(), ["generationId", "isPublic", "name", "threadId"]);
  assert.equal(body.isPublic, false, "private unless asked for");

  assert.equal(result.kind, "frame");
  assert.equal(result.state, "done");
  assert.equal(result.frameId, "f1");
  assert.equal(result.placeholderCount, 6);
  assert.equal(result.dashboardUrl, "https://studio.example/dashboard/frames/f1");
});

/* ------------------------------------------------ the published schema --- */

/**
 * Every result must satisfy the outputSchema the server PUBLISHES, not only
 * the zod shape it validates with.
 *
 * Those are two different checks. The server validates `structuredContent`
 * with the zod object, which strips keys it does not know and passes. A client
 * validates against the JSON Schema from `tools/list`, which carries
 * `additionalProperties: false` — so a key the handler returns but the schema
 * never declared is a -32602 protocol error at the client, and the operator
 * sees a hang or a retry instead of the sentence the handler wrote. The
 * handler tests above call the handlers directly and cannot see this; only a
 * round trip through a real client can, which is what this one is.
 */
test("every frame-tool result satisfies the published output schema", async () => {
  // A Studio the test controls: each fetch hangs until released, in order.
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

  const server = createServer(CONFIG, SessionTokens.forRequest("schema-token"), {
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
    // Caching the schemas is what makes callTool validate against them.
    await client.listTools();

    // Running, from the handle: it carries `note` as well.
    const started = await call("start_frame", { prompt: "batik", layout: "strip-3" });
    assert.equal(started.isError, undefined);
    assert.equal(started.structuredContent?.state, "running");
    const jobId = String(started.structuredContent?.jobId);

    // Running, from the poll: this branch carries `note`.
    const running = await call("check_generation", { jobId });
    assert.equal(running.structuredContent?.state, "running");

    // Done: the thread opens, then the generation lands.
    await releaseNext(THREAD);
    await releaseNext(generated("g1"));
    const done = await call("check_generation", { jobId });
    assert.equal(done.structuredContent?.state, "done");
    assert.equal(done.structuredContent?.imageUrl, IMAGE);
    assert.equal(done.structuredContent?.threadId, "t1");

    // Refine: the handle carries threadId before the job is done.
    const refined = await call("refine_frame", { threadId: "t1", prompt: "darker" });
    assert.equal(refined.structuredContent?.state, "running");
    assert.equal(refined.structuredContent?.threadId, "t1");
    await releaseNext(generated("g2"));
    const refinedDone = await call("check_generation", { jobId: String(refined.structuredContent?.jobId) });
    assert.equal(refinedDone.structuredContent?.generationId, "g2");

    // Unknown.
    const unknown = await call("check_generation", { jobId: "not-a-real-job" });
    assert.equal(unknown.structuredContent?.state, "unknown");

    // Saved: a frame card with every field the Studio returns.
    const savePromise = call("save_frame", { threadId: "t1", generationId: "g2", name: "Batik" });
    await releaseNext({
      frameId: "f1",
      name: "Batik",
      isPublic: false,
      canvasWidth: 1600,
      canvasHeight: 2400,
      placeholderCount: 6,
      thumbnailUrl: IMAGE,
      threadId: "t1",
      generationId: "g2",
    });
    const saved = await savePromise;
    assert.equal(saved.isError, undefined);
    assert.equal(saved.structuredContent?.kind, "frame");
    assert.equal(saved.structuredContent?.frameId, "f1");

    // Refused by the in-flight cap: a failed handle carrying `error`, not a
    // protocol error and not an isError refusal — the model needs the sentence.
    await call("start_frame", { prompt: "one", layout: "strip-3" });
    await call("start_frame", { prompt: "two", layout: "strip-3" });
    await call("start_frame", { prompt: "three", layout: "strip-3" });
    const refused = await call("start_frame", { prompt: "four", layout: "strip-3" });
    assert.equal(refused.isError, undefined, "a refusal is a result, not a protocol error");
    assert.equal(refused.structuredContent?.state, "failed");
    assert.equal(refused.structuredContent?.jobId, "");
  } finally {
    globalThis.fetch = realFetch;
    await client.close();
    await server.close();
  }
});
