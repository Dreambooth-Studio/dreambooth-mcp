import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SERVER_VERSION } from "../src/mcp/server.js";

/**
 * `server.json` is the MCP registry manifest, and the registry listing is live.
 *
 * Nothing in the build reads this file, which is exactly why it rots: it is the
 * one published artifact no test, no typecheck and no deploy ever touches. On
 * 2026-09-23 three different versions were in play at once —
 *
 *   registry (live)   0.1.0, described as reads only
 *   server.json       0.2.0, description 166 chars against a 100-char limit
 *   the actual server 0.3.0, 22 tools including booth design and creation
 *
 * — and the middle one had never been published because it could not be: the
 * registry schema caps `description` at 100 and the file was 66 over, so the
 * 0.2.0 bump failed validation and the listing stayed on 0.1.0. A stale version
 * is a small problem; a manifest that cannot be published is a silent one,
 * because nobody finds out until they try.
 *
 * So this file asserts the two things that go wrong on their own: drift from
 * the version the server actually reports, and a field that has grown past
 * what the registry will accept.
 */

const LIMITS = { name: 200, title: 100, description: 100, version: 255 } as const;

interface Manifest {
  name: string;
  title?: string;
  description: string;
  version: string;
  remotes?: Array<{ type?: string; url?: string }>;
}

// Resolved from the working directory rather than from this file: the scripts
// tsconfig emits CommonJS, where `import.meta` is a compile error. `npm test`
// runs from the package root, which is where server.json lives.
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "server.json"), "utf8"),
) as Manifest;

test("the registry manifest declares the version the server reports", () => {
  // Not cosmetic: the registry is how another client discovers this server, and
  // a listing two versions behind describes a tool surface that no longer
  // exists. It said "sessions, revenue, credits, projects, device status" while
  // the server had twelve write tools.
  assert.equal(
    manifest.version,
    SERVER_VERSION,
    `server.json says ${manifest.version}, the server reports ${SERVER_VERSION}`,
  );
});

test("every published field fits what the registry will accept", () => {
  for (const [field, max] of Object.entries(LIMITS)) {
    const value = manifest[field as keyof Manifest];
    if (typeof value !== "string") continue;
    assert.ok(
      value.length <= max,
      `server.json ${field} is ${value.length} chars, limit ${max} — ` +
        `the publish would fail validation and the listing would silently stay put`,
    );
  }
});

test("the manifest points at the deployed endpoint", () => {
  // The one field whose wrongness is unrecoverable from the client side: a
  // registry entry pointing somewhere else is worse than no entry.
  const remote = (manifest.remotes ?? [])[0];
  assert.equal(remote?.type, "streamable-http");
  assert.equal(remote?.url, "https://mcp.dreamboothstudio.com/mcp");
});
