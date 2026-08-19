import assert from "node:assert/strict";
import { test } from "node:test";

import { corsMiddleware } from "../src/http.js";

/**
 * Whether a browser is allowed to read this server's responses.
 *
 * Worth a test file of its own because of how this failed: the preflight was
 * already answering `200 OK` with an `allow` header and no CORS headers at all.
 * curl was perfectly happy. A browser blocked every response before any
 * JavaScript could see it and reported "Failed to fetch" — which reads as the
 * server being down or the URL being wrong, and was neither. The ChatGPT
 * portal's Scan Tools runs in the browser, so the connector was unscannable
 * while looking healthy from every command line we tried.
 *
 * Reachable-by-curl and unreachable-by-browser is the worst combination to
 * debug, so it is pinned here.
 */

function run(method: string) {
  const headers: Record<string, string> = {};
  let status: number | undefined;
  let ended = false;
  let nexted = false;

  corsMiddleware(
    { method },
    {
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      status(code: number) {
        status = code;
        return {
          end() {
            ended = true;
          },
        };
      },
    },
    () => {
      nexted = true;
    }
  );

  return { headers, status, ended, nexted };
}

test("every response carries an allow-origin", () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    const { headers } = run(method);
    assert.equal(headers["access-control-allow-origin"], "*", method);
  }
});

test("credentials are NOT allowed, which is what makes the wildcard safe", () => {
  const { headers } = run("POST");
  // `*` plus credentials is rejected by browsers anyway, but the real reason is
  // narrower: this service authenticates only from an explicit Authorization
  // header, never a cookie. There is no ambient credential for a hostile page
  // to ride. If that ever changes, the wildcard has to become an allow-list.
  assert.equal(headers["access-control-allow-credentials"], undefined);
});

test("the headers a client actually sends are allowed", () => {
  const { headers } = run("POST");
  const allowed = headers["access-control-allow-headers"].toLowerCase();
  for (const h of ["content-type", "authorization", "mcp-session-id", "mcp-protocol-version"]) {
    assert.ok(allowed.includes(h), `${h} must be allowed`);
  }
});

test("mcp-session-id and www-authenticate are exposed, not just allowed", () => {
  const { headers } = run("POST");
  const exposed = headers["access-control-expose-headers"].toLowerCase();
  // A browser cannot READ a response header it was not told about. Allowing a
  // header on the way in is a different thing from exposing it on the way out,
  // and these two are how a client keeps a session and how it discovers where
  // to authenticate.
  assert.ok(exposed.includes("mcp-session-id"));
  assert.ok(exposed.includes("www-authenticate"));
});

test("a preflight ends at 204 and never reaches the transport", () => {
  const { status, ended, nexted, headers } = run("OPTIONS");
  assert.equal(status, 204);
  assert.ok(ended, "the preflight is answered here");
  assert.ok(!nexted, "and must not fall through to session or auth logic");
  // Still carries the CORS headers — a preflight without them is the exact
  // failure this file exists for.
  assert.equal(headers["access-control-allow-origin"], "*");
  assert.ok(headers["access-control-allow-methods"].includes("POST"));
});

test("a real request falls through", () => {
  const { nexted, ended } = run("POST");
  assert.ok(nexted, "POST must reach the MCP transport");
  assert.ok(!ended);
});
