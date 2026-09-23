import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SUPPORTED_SCOPES, SCOPE_STRING, READ_SCOPE, WRITE_SCOPE } from "../src/auth/scopes.js";
import { createServer } from "../src/mcp/server.js";
import { AUTH_REQUIRED_TOOLS } from "../src/mcp/toolAuth.js";
import { SessionTokens } from "../src/auth/tokenStore.js";
import { registerWellKnown } from "../src/mcp/wellKnown.js";
import { sendUnauthorized } from "../src/auth/challenge.js";
import type { Config } from "../src/config.js";

/**
 * What a client reads BEFORE it has a token.
 *
 * These two documents decide which scopes a client asks for, and nothing about
 * a write tool works if they understate the answer. That is not hypothetical:
 * the write tools were written, reviewed and merged while both documents still
 * said `booths:read` alone — so no client would ever have requested
 * `booths:write`, the operator would never have been offered it, and every
 * write would have come back 403 telling them to approve a permission that
 * nothing had asked for. The feature would have shipped dead, and passed every
 * test that existed.
 *
 * Hence this file. It asserts the advertisement, not the grant — the Studio's
 * `narrowScope` is what actually decides, and it can only ever narrow.
 */

const CONFIG = {
  apiUrl: "https://studio.example",
  // Set separately from allowedHosts on purpose. Identity is what this server
  // claims to be and must match the URL submitted to a directory; allowedHosts
  // is an operational allow-list that may gain entries. This test used to rely
  // on the first deriving from the second, which is the coupling that was
  // removed — adding a host must not silently change the server's identity.
  publicHost: "mcp.example",
  allowedHosts: ["mcp.example"],
} as unknown as Config;

/**
 * `CONFIG` above is shaped for the metadata documents and says nothing about
 * the Studio. Building a server needs the other half.
 */
const SERVER_CONFIG = {
  ...CONFIG,
  apiUrl: "https://studio.example",
  diagnostics: false,
} as unknown as Config;

/** Captures whatever `registerWellKnown` hands to `app.get`. */
function metadataFor(path: string): Record<string, unknown> {
  const routes = new Map<string, (req: unknown, res: unknown) => void>();
  const app = { get: (p: string, h: (req: unknown, res: unknown) => void) => routes.set(p, h) };

  registerWellKnown(app as never, CONFIG);

  const handler = routes.get(path);
  assert.ok(handler, `${path} is registered`);

  let body: Record<string, unknown> | undefined;
  handler({ headers: { host: "mcp.example" } }, {
    json: (payload: Record<string, unknown>) => {
      body = payload;
    },
    redirect: () => {},
  });
  assert.ok(body, `${path} answered with a body`);
  return body;
}

/* ------------------------------------------------------------ constants --- */

test("the scope list names both scopes, and write is not the default", () => {
  assert.deepEqual([...SUPPORTED_SCOPES], [READ_SCOPE, WRITE_SCOPE]);
  assert.equal(SCOPE_STRING, "booths:read booths:write");
  // Read comes first because a client that truncates or takes the head of the
  // list must end up with the harmless one.
  assert.equal(SUPPORTED_SCOPES[0], READ_SCOPE);
});

/* -------------------------------------------- protected-resource metadata --- */

test("protected-resource metadata advertises the write scope", () => {
  // Both spellings: RFC 9728 §3.1 puts the resource path in the well-known
  // URL, and clients construct that themselves. A client that finds only one
  // of these reads the scopes from whichever it found.
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const doc = metadataFor(path);
    assert.deepEqual(doc.scopes_supported, SUPPORTED_SCOPES, path);
    assert.equal(doc.resource, "https://mcp.example/mcp", path);
    assert.deepEqual(doc.authorization_servers, ["https://studio.example"], path);
  }
});

/* ---------------------------------------------------- the 401 challenge --- */

test("the 401 challenge names the scopes a client may request", () => {
  const headers: Record<string, string> = {};
  const res = {
    status() {
      return this;
    },
    set(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    json() {
      return this;
    },
  };

  sendUnauthorized(res as never, CONFIG, { headers: { host: "mcp.example" } } as never, {
    description: "create_filter needs a connected Dreambooth account.",
  });

  const challenge = headers["WWW-Authenticate"];
  assert.ok(challenge, "a WWW-Authenticate header was set");
  // Not every client fetches the metadata document before building its
  // authorization request; for some this header is the only place they learn
  // what may be asked for.
  assert.match(challenge, /scope="booths:read booths:write"/);
  // Still carries what it carried before — this is an addition, not a rewrite.
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(challenge, /error="invalid_token"/);
});

/* ------------------------------------------------- the inventory itself --- */

/**
 * The tool and widget inventory an uncredentialled client is shown.
 *
 * This is the same question as the two documents above — what a client reads
 * BEFORE it has a token — and it had the worst answer of the three. The write
 * tools were registered only when a request carried an `Authorization` header,
 * and the check was on the header's PRESENCE, not on anything in it. So
 * `tools/list` answered 10 tools to a client with no credential and 22 to one
 * sending any string at all, and `resources/list` answered 1 widget or 3.
 *
 * Nothing that consumes a tool list expects it to move. The ChatGPT submission
 * portal scans from the browser with no credential, so it could only ever see
 * the read half while the submission declared all 22; a client that caches the
 * list it got before sign-in goes on offering ten tools to an operator who has
 * since connected an account; and a directory reviewer running a test case
 * against a tool the scan never saw finds it missing.
 *
 * The counts are written out rather than compared against a second build of
 * the same server, because a test that compares the server to itself passes
 * whatever the server does. A number has to be edited by whoever changes it.
 */

/**
 * Twenty-two. It was seventeen between 2026-09-23 morning and afternoon, while
 * the booth tools were withdrawn: the Studio's `digital_mode` flag was off and
 * every route they call answered 404. The flag is on, the flow was proven end
 * to end against production (37 checks, `create_booth` completing for the first
 * time), and `BOOTH_TOOLS_LIVE` is true again.
 *
 * Spelled out precisely so neither direction can happen quietly. Both times the
 * list changed, this test failed first, which is the whole reason the names are
 * written down rather than derived from the server.
 *
 * `docs/submission/build_submission_import.py` declares the same set. If the
 * two disagree, the submission names a tool the portal cannot scan and the
 * import is refused.
 */
const EXPECTED_TOOLS = [
  "check_generation",
  "connect_account",
  "connection_status",
  "create_booth",
  "create_filter",
  "duplicate_project",
  "get_booth_draft",
  "get_credits",
  "get_gallery_stats",
  "get_project",
  "get_revenue_summary",
  "get_sessions",
  "get_wallet_transactions",
  "list_projects",
  "preview_filter",
  "refine_booth",
  "refine_frame",
  "save_frame",
  "search_docs",
  "start_booth",
  "start_frame",
  "update_booth_draft",
];

const EXPECTED_WIDGETS = [
  "ui://widget/connect-account.html",
  "ui://widget/generation.html",
  "ui://widget/write-result.html",
];

/** Everything a client can discover, on a connection carrying no credential. */
async function discovered() {
  const server = createServer(SERVER_CONFIG, new SessionTokens(), {
    transport: "http",
    sessionId: () => undefined,
    stateless: true,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const [tools, resources] = await Promise.all([client.listTools(), client.listResources()]);
  await client.close();
  await server.close();
  return {
    tools: tools.tools.map((t) => t.name).sort(),
    widgets: resources.resources.map((r) => String(r.uri)).sort(),
  };
}

test("every tool is advertised before a credential exists, not only after", async () => {
  const { tools } = await discovered();
  assert.deepEqual(tools, EXPECTED_TOOLS);
});

test("every widget is advertised before a credential exists", async () => {
  // A card with no resource behind it does not degrade to text — the client
  // has nothing to render. Two of these three used to appear only alongside a
  // bearer, which is the same defect as the tools and breaks the same reviewer.
  const { widgets } = await discovered();
  assert.deepEqual(widgets, EXPECTED_WIDGETS);
});

test("the tools that need an account are refused by the transport, not hidden", async () => {
  // The invariant that makes advertising them safe: listing a tool an
  // uncredentialled caller cannot use is only honest if the call is answered
  // with the 401 that starts a sign-in. Anything NOT in this set must be
  // genuinely usable with no account.
  const { tools } = await discovered();
  const open = tools.filter((name) => !AUTH_REQUIRED_TOOLS.has(name));
  assert.deepEqual(open, ["connect_account", "connection_status", "search_docs"]);
});
