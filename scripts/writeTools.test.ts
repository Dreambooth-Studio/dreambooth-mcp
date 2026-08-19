import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/server.js";
import { SessionTokens } from "../src/auth/tokenStore.js";
import { buildCreateFilter } from "../src/tools/createFilter.js";
import { buildDuplicateProject } from "../src/tools/duplicateProject.js";
import { writeErrorFor } from "../src/studio/errors.js";
import type { Config } from "../src/config.js";
import type { StudioClient } from "../src/studio/client.js";

/**
 * The two tools that change something, and the gate in front of them.
 *
 * Everything here is about a promise made somewhere an operator can read it —
 * the consent screen, the directory listing, the tool annotations. A test that
 * only checked the happy path would leave every one of those unverified.
 */

const CONFIG = {
  apiUrl: "https://studio.example",
  port: 0,
  requestTimeoutMs: 1000,
  allowedHosts: [],
  diagnostics: false,
} as unknown as Config;

/** Records what would have been sent, and answers with whatever the test wants. */
function fakeStudio(reply: unknown) {
  const calls: Array<{ path: string; body: unknown; query: unknown }> = [];
  const studio = {
    post: async (path: string, body: unknown, query: unknown = {}) => {
      calls.push({ path, body, query });
      return reply;
    },
  } as unknown as StudioClient;
  return { studio, calls };
}

/* ------------------------------------------------------------- the gate --- */

async function toolNames(bearerAuth: boolean): Promise<string[]> {
  const server = createServer(CONFIG, new SessionTokens(), {
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
  return listed.tools.map((t) => t.name).sort();
}

test("the write tools exist only where a revocable, scoped token can", async () => {
  const withBearer = await toolNames(true);
  assert.ok(withBearer.includes("create_filter"));
  assert.ok(withBearer.includes("duplicate_project"));
});

test("no bearer, no write tools — a device-flow session cannot reach them", async () => {
  // stdio and device-flow HTTP sessions land here. Their token lives a year,
  // carries no scope and cannot be revoked, which is the whole reason writing
  // was put behind OAuth. A model connected that way must not be able to
  // promise something that would fail.
  const anonymous = await toolNames(false);
  assert.ok(!anonymous.includes("create_filter"));
  assert.ok(!anonymous.includes("duplicate_project"));
  // The read tools are untouched by the gate.
  assert.ok(anonymous.includes("list_projects"));
  assert.ok(anonymous.includes("search_docs"));
});

test("the write tools do not claim to be read-only", async () => {
  const server = createServer(CONFIG, new SessionTokens(), {
    transport: "http",
    sessionId: () => undefined,
    stateless: true,
    bearerAuth: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  await client.close();
  await server.close();

  for (const name of ["create_filter", "duplicate_project"]) {
    const tool = listed.tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is registered`);
    // Both directory reviews check these, and a client uses readOnlyHint to
    // decide whether it may run a tool without asking. "absent" is not "false".
    assert.equal(tool?.annotations?.readOnlyHint, false, name);
    assert.equal(tool?.annotations?.destructiveHint, false, name);
    assert.equal(tool?.annotations?.idempotentHint, false, name);
  }
});

/* ------------------------------------------------------ what gets sent --- */

test("create_filter sends only the fields it declares", async () => {
  const { studio, calls } = fakeStudio({
    _id: "f1",
    name: "Senja Hangat",
    isPublic: false,
    adjustments: { contrast: 112 },
  });
  const tool = buildCreateFilter(studio, CONFIG);

  const result = await tool.handler({
    name: "Senja Hangat",
    adjustments: { contrast: 112 },
    // Identity is never an argument. Even if a model invents this — and the
    // Studio now refuses it outright — it must not leave this process.
    ownerEmail: "someone.else@example.com",
  } as never);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/filters");
  assert.deepEqual(calls[0].body, {
    name: "Senja Hangat",
    adjustments: { contrast: 112 },
    isPublic: false,
  });
  assert.equal(result.dashboardUrl, "https://studio.example/dashboard/filters/f1");
});

test("create_filter reports what the Studio stored, not what it was sent", async () => {
  // The POST handler decides what it keeps. Echoing the arguments back would
  // hide the difference the moment those two diverge — and the card, which
  // draws its swatch from this, would be drawing a filter that does not exist.
  const { studio } = fakeStudio({ _id: "f2", name: "Renamed", adjustments: { sepia: 20 } });
  const tool = buildCreateFilter(studio, CONFIG);
  const result = await tool.handler({ name: "Sent name", adjustments: { contrast: 150 } });

  assert.equal(result.name, "Renamed");
  assert.deepEqual(result.adjustments, { sepia: 20 });
});

test("duplicate_project passes the id as a query and sends no body", async () => {
  const { studio, calls } = fakeStudio({
    _id: "p2",
    title: "Bandung Expo-copy",
    slug: "bandung-expo-copy",
    isActive: false,
  });
  const tool = buildDuplicateProject(studio, CONFIG);
  const result = await tool.handler({ projectId: "p1" });

  assert.equal(calls[0].path, "/api/projects");
  assert.deepEqual(calls[0].query, { duplicate: "true", id: "p1" });
  // Anything in the body would be ignored by the duplicate branch; sending
  // fields anyway suggests this tool can shape the copy, which it cannot.
  assert.deepEqual(calls[0].body, {});
  assert.equal(result.copiedFrom?.title, "Bandung Expo");
  assert.equal(result.dashboardUrl, "https://studio.example/dashboard/projects/p2/editor");
});

test("duplicate_project recovers the original name through -copy-N", async () => {
  const { studio } = fakeStudio({ _id: "p3", title: "Bandung Expo-copy-2" });
  const tool = buildDuplicateProject(studio, CONFIG);
  const result = await tool.handler({ projectId: "p1" });
  assert.equal(result.copiedFrom?.title, "Bandung Expo");
});

/* ------------------------------------------------------------- failing --- */

test("a write failure relays the Studio's own sentence", async () => {
  // These are product copy. "This connection is read-only, reconnect and
  // approve permission to create things" tells the operator which button to
  // press; a generic 403 sends the model off to guess.
  const message = "This connection is read-only. Reconnect the app and approve permission.";
  const error = await writeErrorFor(
    new Response(JSON.stringify({ error: message }), { status: 403 }),
    "/api/filters"
  );
  assert.equal(error.message, message);
  assert.equal(error.status, 403);
  assert.equal(error.retryable, false, "repeating it produces the same answer");
});

test("a write failure with no readable body falls back to the generic mapping", async () => {
  const error = await writeErrorFor(new Response("<html>gateway</html>", { status: 502 }), "/api/filters");
  assert.equal(error.status, 502);
  assert.ok(error.message.length > 0);
});

test("a write failure is never retryable, even at 500", async () => {
  // The read mapping calls a 5xx retryable, and for a GET that is right.
  // Repeating a POST is how one filter becomes two.
  const error = await writeErrorFor(
    new Response(JSON.stringify({ error: "Something broke" }), { status: 500 }),
    "/api/filters"
  );
  assert.equal(error.retryable, false);
});
