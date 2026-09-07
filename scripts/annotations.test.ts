import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/server.js";
import { SessionTokens } from "../src/auth/tokenStore.js";
import type { Config } from "../src/config.js";

/**
 * The v2.0.0 directory review rejected this server twice over annotations:
 * once because a hint was absent rather than false ("explicitly set to true or
 * false (not null) for every tool"), and once because a hint did not match the
 * behaviour it claimed to describe.
 *
 * Both failures are invisible from inside the code — `idempotentHint` was
 * simply never written, and every reading of the source agreed with itself.
 * They are only visible in what `tools/list` actually puts on the wire, which
 * is what this file inspects: the advertised annotations, for the whole
 * inventory, on the connection a reviewer uses.
 */

const CONFIG = {
  apiUrl: "https://studio.test",
  publicUrl: "https://mcp.test",
  diagnostics: false,
} as unknown as Config;

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The only two tools that never open a socket. Everything else reaches the Studio. */
const CLOSED_WORLD = new Set(["connection_status", "check_generation"]);

async function advertised() {
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
  return listed.tools;
}

test("every advertised tool answers all four hints explicitly", async () => {
  const tools = await advertised();
  assert.ok(tools.length > 0, "no tools advertised");
  for (const tool of tools) {
    const a = (tool.annotations ?? {}) as Record<string, unknown>;
    for (const hint of HINTS) {
      assert.equal(
        typeof a[hint],
        "boolean",
        `${tool.name}.${hint} is ${JSON.stringify(a[hint])}; the portal reads a missing hint as null, not as false`,
      );
    }
  }
});

test("openWorldHint is false only for the tools that reach nothing", async () => {
  for (const tool of await advertised()) {
    const open = (tool.annotations ?? {}).openWorldHint;
    assert.equal(
      open,
      !CLOSED_WORLD.has(tool.name),
      `${tool.name} claims openWorldHint ${open}; a tool that reaches an operator's account on another service must say true`,
    );
  }
});

test("a read-only tool never also claims to be destructive", async () => {
  for (const tool of await advertised()) {
    const a = (tool.annotations ?? {}) as Record<string, unknown>;
    if (a.readOnlyHint === true) {
      assert.equal(a.destructiveHint, false, `${tool.name} is read-only and cannot be destructive`);
      assert.equal(a.idempotentHint, true, `${tool.name} is read-only, so repeating it has no further effect`);
    }
  }
});
