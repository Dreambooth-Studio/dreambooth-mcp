import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/server.js";
import { AUTH_REQUIRED_TOOLS } from "../src/mcp/toolAuth.js";
import { WRITE_SCOPE_TOOLS } from "../src/mcp/toolSecurity.js";
import { SessionTokens } from "../src/auth/tokenStore.js";
import { RECONNECT_TO_CREATE, needsWritePermission } from "../src/studio/errors.js";
import type { Config } from "../src/config.js";

/**
 * A connection granted read before the write scope reached it has to connect
 * again, and refresh never raises its scope. These tests walk what such an
 * operator meets: the auth policy on `tools/list`, then the refusal and the
 * challenge on a real tool call through the MCP client, with only the Studio's
 * HTTP answers faked.
 */

const CONFIG = {
  apiUrl: "https://studio.test",
  publicUrl: "https://mcp.test",
  publicHost: "mcp.test",
  requestTimeoutMs: 1000,
  diagnostics: false,
} as unknown as Config;

const STUDIO_READ_ONLY =
  "This connection is read-only. Disconnect Dreambooth in this app's settings, connect it again, and approve creating things on the Dreambooth page that opens.";
const OLD_STUDIO_READ_ONLY =
  "This connection is read-only. Reconnect the app and approve permission to create things.";

async function connected() {
  const tokens = new SessionTokens();
  tokens.set("connector-token");
  const server = createServer(CONFIG, tokens, {
    transport: "http",
    sessionId: () => undefined,
    stateless: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Answers every Studio request with the same status and JSON body. */
async function withStudioAnswer<T>(status: number, body: unknown, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function challengeOf(result: { _meta?: Record<string, unknown> }): string {
  const challenges = result._meta?.["mcp/www_authenticate"];
  assert.ok(Array.isArray(challenges), "the result carries a challenge");
  return String(challenges[0]);
}

const FILTER_ARGS = { name: "Warm", adjustments: { temperature: 10 } };

/** Starts a booth and polls until its background job has an answer. */
async function failedBoothCheck(client: Client) {
  const started = await client.callTool({
    name: "start_booth",
    arguments: { prompt: "garden wedding, warm gold", language: "en" },
  });
  const jobId = (started.structuredContent as { jobId: string }).jobId;
  for (let i = 0; i < 100; i++) {
    const check = await client.callTool({ name: "check_generation", arguments: { jobId } });
    if ((check.structuredContent as { state?: string }).state !== "running") return check;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the job never finished");
}

/* ------------------------------------------------------------ the policy --- */

test("every tool declares its auth policy, and the policy matches its annotations", async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 22);

  for (const tool of tools) {
    const schemes = tool._meta?.securitySchemes as Array<{ type: string; scopes?: string[] }>;
    assert.ok(Array.isArray(schemes) && schemes.length === 1, `${tool.name} declares a policy`);

    if (!AUTH_REQUIRED_TOOLS.has(tool.name)) {
      assert.deepEqual(schemes, [{ type: "noauth" }], tool.name);
      continue;
    }
    // A tool that changes anything needs write, and only those do.
    const writes = tool.annotations?.readOnlyHint === false;
    assert.equal(WRITE_SCOPE_TOOLS.has(tool.name), writes, `${tool.name} against readOnlyHint`);
    assert.deepEqual(
      schemes,
      [{ type: "oauth2", scopes: [writes ? "booths:write" : "booths:read"] }],
      tool.name
    );
  }
});

test("declaring the policy leaves a tool's widget metadata in place", async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  for (const name of ["start_booth", "check_generation", "connect_account"]) {
    const meta = tools.find((t) => t.name === name)?._meta;
    assert.ok(meta?.["openai/outputTemplate"], `${name} keeps its card`);
  }
});

/* ---------------------------------------------------------- the challenge --- */

test("a refused create says what to do and carries the challenge", async () => {
  for (const sentence of [STUDIO_READ_ONLY, OLD_STUDIO_READ_ONLY]) {
    const client = await connected();
    const result = await withStudioAnswer(403, { error: sentence }, () =>
      client.callTool({ name: "create_filter", arguments: FILTER_ARGS })
    );
    assert.equal(result.isError, true);
    assert.equal((result.content as Array<{ text: string }>)[0].text, sentence);

    const challenge = challengeOf(result);
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, /error="insufficient_scope"/);
    assert.match(challenge, /scope="booths:read booths:write"/);
    assert.match(
      challenge,
      /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource\/mcp"/
    );
    assert.equal(result._meta?.status, 403, "the card's fields are still there");
  }
});

test("a booth job refused by the Studio's 403 carries the challenge on check_generation", async () => {
  const client = await connected();
  const check = await withStudioAnswer(403, { error: STUDIO_READ_ONLY }, () => failedBoothCheck(client));
  const out = check.structuredContent as { state: string; error: string };
  assert.equal(out.state, "failed");
  assert.equal(out.error, STUDIO_READ_ONLY);
  assert.equal(check.isError, true);
  assert.match(challengeOf(check), /insufficient_scope/);
});

test("the old 401 on the booth routes no longer blames a deploy", async () => {
  const client = await connected();
  const check = await withStudioAnswer(
    401,
    { error: "Sign in to generate your booth.", code: "AUTH_REQUIRED" },
    () => failedBoothCheck(client)
  );
  const out = check.structuredContent as { state: string; error: string };
  assert.equal(out.state, "failed");
  assert.ok(out.error.includes(RECONNECT_TO_CREATE), out.error);
  assert.doesNotMatch(out.error, /not deployed/);
  assert.match(challengeOf(check), /insufficient_scope/);
});

test("other failures get no challenge, because connecting again would not fix them", async () => {
  const cases: Array<[number, string]> = [
    [400, "Name is required."],
    [403, "Forbidden"],
    [409, "That link name is already taken."],
    [429, "Too many filters."],
    [500, "Something broke."],
  ];
  for (const [status, sentence] of cases) {
    const client = await connected();
    const result = await withStudioAnswer(status, { error: sentence }, () =>
      client.callTool({ name: "create_filter", arguments: FILTER_ARGS })
    );
    assert.equal(result.isError, true, sentence);
    assert.equal(result._meta?.["mcp/www_authenticate"], undefined, sentence);
  }

  const client = await connected();
  const check = await withStudioAnswer(429, { error: "Too many booths created from this account." }, () =>
    failedBoothCheck(client)
  );
  assert.equal((check.structuredContent as { state: string }).state, "failed");
  assert.equal(check.isError, undefined, "an ordinary failed job stays an ordinary result");
  assert.equal(check._meta?.["mcp/www_authenticate"], undefined);
});

test("a successful read is untouched", async () => {
  const client = await connected();
  const result = await withStudioAnswer(200, { credits: 5, package: "pro" }, () =>
    client.callTool({ name: "get_credits", arguments: {} })
  );
  assert.equal(result.isError, undefined);
  assert.equal(result._meta, undefined);
});

test("needsWritePermission recognises the refusals and nothing else", () => {
  for (const yes of [STUDIO_READ_ONLY, OLD_STUDIO_READ_ONLY, `Not accepted. ${RECONNECT_TO_CREATE}`]) {
    assert.equal(needsWritePermission(yes), true, yes);
  }
  for (const no of ["", "Forbidden", "Sign in to generate your booth.", "This token cannot create things.", "thread-only"]) {
    assert.equal(needsWritePermission(no), false, no);
  }
});
