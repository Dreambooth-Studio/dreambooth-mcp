import assert from "node:assert/strict";
import { test } from "node:test";
import { requiresAuth, toolCallName, AUTH_REQUIRED_TOOLS } from "../src/mcp/toolAuth.js";

/**
 * The gate that decides whether a request gets a 401.
 *
 * Worth testing on its own because both ways of getting it wrong are bad in
 * ways that are hard to see from the outside:
 *
 *   too eager  `initialize` or `tools/list` 401s, and the connector never
 *              starts — which looks exactly like a server that is down
 *   too shy    an authenticated tool answers "no account connected" instead of
 *              triggering sign-in, which is the bug this whole path exists to
 *              fix and which reads as "the connector does not work on my phone"
 */

const call = (name: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: {} },
});

test("requiresAuth: true for every tool that talks to the Studio", () => {
  for (const name of AUTH_REQUIRED_TOOLS) {
    assert.equal(requiresAuth(call(name)), true, `${name} should require auth`);
  }
});

test("requiresAuth: false for the tools that must answer anonymously", () => {
  // search_docs is the listing's promise that pricing and hardware questions
  // need no account. connect_account gating on a credential would be a loop.
  for (const name of ["search_docs", "connect_account", "connection_status", "session_info"]) {
    assert.equal(requiresAuth(call(name)), false, `${name} must not require auth`);
  }
});

test("requiresAuth: false for the protocol methods a connection is built from", () => {
  assert.equal(requiresAuth({ jsonrpc: "2.0", id: 1, method: "initialize" }), false);
  assert.equal(requiresAuth({ jsonrpc: "2.0", id: 2, method: "tools/list" }), false);
  assert.equal(requiresAuth({ jsonrpc: "2.0", id: 3, method: "resources/list" }), false);
  assert.equal(requiresAuth({ jsonrpc: "2.0", method: "notifications/initialized" }), false);
});

test("requiresAuth: false for anything malformed", () => {
  // Every ambiguous input must resolve to "carry on". Guessing the other way
  // 401s a request that was never a tool call.
  assert.equal(requiresAuth(undefined), false);
  assert.equal(requiresAuth(null), false);
  assert.equal(requiresAuth("get_sessions"), false);
  assert.equal(requiresAuth({}), false);
  assert.equal(requiresAuth({ method: "tools/call" }), false);
  assert.equal(requiresAuth({ method: "tools/call", params: {} }), false);
  assert.equal(requiresAuth({ method: "tools/call", params: { name: 42 } }), false);
  assert.equal(requiresAuth({ method: "tools/call", params: null }), false);
});

test("requiresAuth: false for a batch", () => {
  // A JSON-RPC batch is an array. Refusing one wholesale would deny the
  // anonymous calls inside it, so batches take the normal path and each tool
  // reports for itself.
  assert.equal(requiresAuth([call("get_sessions")]), false);
});

test("requiresAuth: unknown tool names are not gated", () => {
  // A name that is not in the set is either a typo from the model or a tool
  // added without updating the set. Both should reach the server and get a
  // proper "unknown tool" error rather than a misleading 401.
  assert.equal(requiresAuth(call("get_everything")), false);
});

test("toolCallName: reports the name for a tool call and null otherwise", () => {
  assert.equal(toolCallName(call("get_credits")), "get_credits");
  assert.equal(toolCallName({ method: "initialize" }), null);
});

/* ------------------------------------------------------- optional methods --- */

/**
 * `prompts/list` answers with an empty list, not an error.
 *
 * This server has no prompts, and declining with -32601 is spec-correct — the
 * capability would not be advertised, so a client that checks before calling
 * never asks. Some clients do not check, and one that calls unconditionally
 * without handling the error gets an exception where it expected an array.
 *
 * An empty list is true and cannot be misread. Asserted here because the
 * failure it prevents happens in somebody else's process, where we would never
 * see it.
 */
test("prompts/list returns an empty list and the capability is declared", async () => {
  const { createServer } = await import("../src/mcp/server.js");
  const { SessionTokens } = await import("../src/auth/tokenStore.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const server = createServer(
    { apiUrl: "https://studio.example", allowedHosts: [] } as never,
    new SessionTokens(),
    { transport: "http", sessionId: () => undefined, stateless: true },
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  // Advertising `prompts` and then erroring would be worse than either alone.
  assert.ok(client.getServerCapabilities()?.prompts, "prompts capability is advertised");

  const listed = await client.listPrompts();
  assert.deepEqual(listed.prompts, []);

  await client.close();
  await server.close();
});
