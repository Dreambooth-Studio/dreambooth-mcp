import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/server.js";
import { SessionTokens } from "../src/auth/tokenStore.js";
import { buildGenerateFrame } from "../src/tools/generateFrame.js";
import { buildCheckGeneration } from "../src/tools/checkGeneration.js";
import { AUTH_REQUIRED_TOOLS, requiresAuth } from "../src/mcp/toolAuth.js";
import { ownerKeyFor } from "../src/jobs/store.js";
import type { Config } from "../src/config.js";
import type { StudioClient } from "../src/studio/client.js";

/**
 * The one capability that cannot answer in a single call.
 *
 * Most of what is asserted here is about not lying to somebody who is waiting.
 * A generation takes up to two minutes, so there is a window in which the
 * honest answer is "nothing exists yet" — and the failure mode this guards is
 * a model telling an operator their frame is ready because a tool returned.
 */

const CONFIG = {
  apiUrl: "https://studio.example",
  port: 0,
  requestTimeoutMs: 1000,
  allowedHosts: [],
  diagnostics: false,
  // These tests are about the tools existing, so they run with the flag ON.
  // The block at the bottom of this file covers the default, which is OFF.
  frameGeneration: true,
} as unknown as Config;

const CONFIG_FLAG_OFF = { ...CONFIG, frameGeneration: false } as unknown as Config;

const TOKEN = "operator-token";

/** A Studio that records the call and answers when the test says so. */
function fakeStudio(reply: unknown | Promise<unknown>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const studio = {
    ownerKey: () => ownerKeyFor(TOKEN),
    post: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return reply;
    },
  } as unknown as StudioClient;
  return { studio, calls };
}

const settled = () => new Promise((r) => setImmediate(r));

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

test("the generation tools live on the OAuth path only", async () => {
  const withBearer = await toolNames(true);
  assert.ok(withBearer.includes("generate_frame"));
  assert.ok(withBearer.includes("check_generation"));

  // A device-flow token is a year long, unscoped and unrevocable. Generating
  // spends the operator's daily allowance, so it belongs behind the credential
  // that expires and can be revoked, like every other write here.
  const anonymous = await toolNames(false);
  assert.ok(!anonymous.includes("generate_frame"));
  assert.ok(!anonymous.includes("check_generation"));
});

test("both are listed as needing auth, so a call without one starts a sign-in", () => {
  // They are registered only when a bearer is present, so without this a call
  // would come back "unknown tool" — which tells the client nothing and starts
  // no OAuth flow.
  assert.ok(AUTH_REQUIRED_TOOLS.has("generate_frame"));
  assert.ok(AUTH_REQUIRED_TOOLS.has("check_generation"));
});

test("generate_frame creates; check_generation does not", async () => {
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

  const gen = listed.tools.find((t) => t.name === "generate_frame");
  assert.equal(gen?.annotations?.readOnlyHint, false);
  assert.equal(gen?.annotations?.idempotentHint, false, "two calls make two frames");

  // Polling is only tolerable if a client may do it without asking each time.
  const check = listed.tools.find((t) => t.name === "check_generation");
  assert.equal(check?.annotations?.readOnlyHint, true);
});

/* ----------------------------------------------------- what gets sent --- */

test("generate_frame sends a preset canvas, never numbers the model chose", async () => {
  const { studio, calls } = fakeStudio({ frameId: "f1", name: "Batik Emas" });
  const tool = buildGenerateFrame(studio, CONFIG);

  await tool.handler({
    stylePrompt: "batik motifs in warm gold",
    size: "strip-2x6",
    placeholderCount: 3,
    layoutIntent: "strip",
    // Identity is never an argument. Even invented, it must not leave here.
    ownerEmail: "someone.else@example.com",
  } as never);
  await settled();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/ai/frames/create");
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body.ownerEmail, undefined, "ownerEmail must never be forwarded");
  // The whole point of the size enum: drawParams.canvasWidth/Height is what
  // the booth prints against, and a model inventing those makes a frame that
  // is created successfully and prints wrong.
  assert.equal(body.canvasWidth, 600);
  assert.equal(body.canvasHeight, 1800);
  assert.equal(body.isPublic, false, "private unless asked for");
});

test("generate_frame returns a handle and says nothing exists yet", async () => {
  const { studio } = fakeStudio(new Promise(() => {}));
  const tool = buildGenerateFrame(studio, CONFIG);

  const result = await tool.handler({
    stylePrompt: "minimal",
    size: "photo-4x6-portrait",
    placeholderCount: 1,
    layoutIntent: "single",
  } as never);

  assert.equal(result.state, "running");
  assert.ok(result.jobId);
  // The sentence that stops a model announcing a frame that does not exist.
  assert.match(String(result.note), /do not describe the frame as created/i);
});

/* ------------------------------------------------------------- polling --- */

test("check_generation reports running, then the created frame", async () => {
  let release!: (v: unknown) => void;
  const { studio } = fakeStudio(new Promise((r) => (release = r)));
  const gen = buildGenerateFrame(studio, CONFIG);
  const check = buildCheckGeneration(studio, CONFIG);

  const started = await gen.handler({
    stylePrompt: "batik",
    size: "strip-2x6",
    placeholderCount: 3,
    layoutIntent: "strip",
  } as never);

  const running = await check.handler({ jobId: started.jobId });
  assert.equal(running.state, "running");
  assert.ok(!("frameId" in running) || running.frameId === undefined);

  release({
    frameId: "f9",
    name: "Batik Emas",
    isPublic: false,
    canvasWidth: 600,
    canvasHeight: 1800,
    placeholderCount: 3,
  });
  await settled();

  const done = await check.handler({ jobId: started.jobId });
  assert.equal(done.state, "done");
  assert.equal(done.frameId, "f9");
  assert.equal(done.dashboardUrl, "https://studio.example/dashboard/frames/f9");
});

test("a failed generation relays the Studio's own sentence", async () => {
  const { studio } = fakeStudio(
    Promise.reject(
      Object.assign(new Error("You've reached today's free AI frame generation limit."), {
        status: 403,
      })
    )
  );
  const gen = buildGenerateFrame(studio, CONFIG);
  const check = buildCheckGeneration(studio, CONFIG);

  const started = await gen.handler({
    stylePrompt: "x",
    size: "square-4x4",
    placeholderCount: 1,
    layoutIntent: "single",
  } as never);
  await settled();

  const done = await check.handler({ jobId: started.jobId });
  assert.equal(done.state, "failed");
  // A used-up allowance is the one failure an operator can act on, so the
  // Studio's wording survives rather than becoming "the generation failed".
  assert.match(String(done.error), /free AI frame generation limit/);
});

test("an unknown job id points at the dashboard instead of claiming failure", async () => {
  const { studio } = fakeStudio({});
  const check = buildCheckGeneration(studio, CONFIG);

  // This store is per-process: a restart loses running jobs while the Studio
  // carries on and finishes them. Reporting a failure here would tell the
  // operator nothing was created when something may well have been.
  const answer = await check.handler({ jobId: "not-a-real-job" });
  assert.equal(answer.state, "unknown");
  assert.match(String(answer.error), /check the dashboard/i);
  assert.ok(answer.dashboardUrl);
});

/* ------------------------------------------------------------- the flag --- */

/**
 * With ENABLE_FRAME_GENERATION off, the frame tools must not exist anywhere a
 * client can see them.
 *
 * This is a claim gate, not a feature toggle. Vertex answers 404 for the Imagen
 * model this project asks for, so the pair is complete, tested and incapable of
 * succeeding — and a listed tool that always fails reads as a broken connector
 * to a directory reviewer and a broken account to an operator. The default has
 * to be provably off, or "we hid it" is just an intention.
 */
test("the flag hides the frame tools, and only those", async () => {
  const hidden = await toolNames(true, CONFIG_FLAG_OFF);

  assert.ok(!hidden.includes("generate_frame"));
  assert.ok(!hidden.includes("check_generation"));

  // The other write tools are unaffected — this must not be a switch that
  // quietly turns the whole write capability off.
  assert.ok(hidden.includes("create_filter"));
  assert.ok(hidden.includes("duplicate_project"));
  // And the reads, obviously.
  assert.ok(hidden.includes("list_projects"));
  assert.ok(hidden.includes("search_docs"));
});

test("a hidden tool is not answered with a sign-in prompt", () => {
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_frame" } };

  // A 401 is a promise that signing in will help. For a tool that is not
  // registered it would not: the client authenticates, calls again, and is told
  // the tool is unknown — a sign-in loop with nothing at the end of it.
  assert.equal(requiresAuth(call, { frameGeneration: false }), false);
  assert.equal(requiresAuth(call, { frameGeneration: true }), true);

  // Omitting the option must not accidentally re-enable the prompt: the default
  // has to match the config default, which is off.
  assert.equal(requiresAuth(call), false);

  // Unflagged tools are untouched by any of this.
  const filter = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_filter" } };
  assert.equal(requiresAuth(filter), true);
  assert.equal(requiresAuth(filter, { frameGeneration: false }), true);
  assert.ok(AUTH_REQUIRED_TOOLS.has("generate_frame"), "still listed for when the flag is on");
});
