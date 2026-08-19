import assert from "node:assert/strict";
import { test } from "node:test";

import { SUPPORTED_SCOPES, SCOPE_STRING, READ_SCOPE, WRITE_SCOPE } from "../src/auth/scopes.js";
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
