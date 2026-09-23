import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/server.js";
import { SessionTokens } from "../src/auth/tokenStore.js";
import type { Config } from "../src/config.js";

/**
 * What a read tool does when the Studio answers with something its schema did
 * not expect.
 *
 * The answer has to be "less data", never "no answer". A `structuredContent`
 * that fails its published `outputSchema` is a PROTOCOL error, and clients
 * respond to those by retrying rather than relaying — so a single odd value in
 * one bucket does not produce a wrong number, it produces a hang.
 *
 * `get_revenue_summary` is the sharpest case in the connector: its handler
 * returns the route's body untouched, and its schema names fourteen typed
 * fields over data the Studio owns.
 */

const CONFIG = {
  apiUrl: "https://studio.example",
  port: 0,
  requestTimeoutMs: 1000,
  allowedHosts: [],
  diagnostics: false,
} as unknown as Config;

type Result = { structuredContent?: Record<string, unknown>; isError?: boolean };

/** A connected client whose Studio answers every call with `body`. */
async function withStudio(body: unknown, run: (call: (name: string, args?: Record<string, unknown>) => Promise<Result>, client: Client) => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const server = createServer(CONFIG, SessionTokens.forRequest("read-token"), {
    transport: "http",
    sessionId: () => undefined,
    stateless: true,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    // Caching the schemas is what makes callTool validate against them.
    await client.listTools();
    await run(
      (name, args = {}) => client.callTool({ name, arguments: args }) as Promise<Result>,
      client
    );
  } finally {
    globalThis.fetch = realFetch;
    await client.close();
    await server.close();
  }
}

test("a revenue figure the Studio returns in another shape degrades, it does not hang", async () => {
  /**
   * Every value here is one this route could plausibly produce and the schema
   * declares as a number: a null from an empty aggregation bucket, a
   * Decimal128 serialised as an object, a count that came back as a string.
   * Before `.catch()`, any one of them failed the published schema and the
   * operator saw a client retry loop instead of their revenue.
   */
  await withStudio(
    {
      found: true,
      source: "sessions",
      groupBy: "month",
      from: null,
      to: "2026-09-12",
      buckets: [
        { period: "2026-08", currency: "IDR", revenue: 1_250_000, paidSessions: 40 },
        { period: "2026-09", currency: "IDR", revenue: null, paidSessions: "12" },
        { period: "2026-07", currency: "IDR", revenue: { $numberDecimal: "900000" } },
      ],
      totals: [{ currency: "IDR", revenue: 2_150_000 }],
      mixedCurrency: false,
      reconciliation: { lifetimeRevenue: null, bucketedRevenue: 2_150_000 },
    },
    async (call) => {
      const result = await call("get_revenue_summary", { groupBy: "month" });

      assert.equal(result.isError, undefined, "an odd figure must not fail the call");
      assert.equal(result.structuredContent?.source, "sessions");

      const buckets = result.structuredContent?.buckets as Array<Record<string, unknown>>;
      assert.equal(buckets.length, 3, "no bucket is dropped");
      assert.equal(buckets[0].revenue, 1_250_000, "the good figures are untouched");
      assert.equal(buckets[0].paidSessions, 40);
      // The surprising ones are simply absent — the model sees a missing
      // figure, which it can say, instead of a number that was never there.
      assert.equal(buckets[1].revenue, undefined);
      assert.equal(buckets[1].paidSessions, undefined);
      assert.equal(buckets[2].revenue, undefined);
      assert.equal(buckets[1].period, "2026-09", "and the rest of the row survives");

      const reconciliation = result.structuredContent?.reconciliation as Record<string, unknown>;
      assert.equal(reconciliation.bucketedRevenue, 2_150_000);
    }
  );
});

test("a field the route learns tomorrow does not break the tool today", async () => {
  /**
   * The published schema carries `additionalProperties: false`, so an
   * undeclared key in `structuredContent` is a client-side protocol error —
   * not a key the model politely ignores. A handler that returned the route's
   * body untouched would therefore break on the next field anyone adds to
   * `/api/me/revenue-summary`, in a deploy that never touched this repo.
   */
  await withStudio(
    {
      found: true,
      totals: [{ currency: "IDR", revenue: 10 }],
      refundedRevenue: 5,
      somethingAddedNextQuarter: { nested: true },
    },
    async (call) => {
      const result = await call("get_revenue_summary");
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent?.found, true);
      assert.equal(
        result.structuredContent?.refundedRevenue,
        undefined,
        "dropped rather than relayed, because relaying it is what breaks the call"
      );
    }
  );
});

test("get_project sanitises the one field whose shape the Studio owns", async () => {
  /**
   * `screenSize` already carried `.catch()`, added after a real call found a
   * legacy shape — and it was still being forwarded verbatim, so the catch
   * protected the server and the client raised the same protocol error one hop
   * later. A string where an object is published is exactly that case.
   */
  await withStudio(
    { _id: "p1", title: "Booth Bandung", slug: "bandung", screenSize: "1920x1080" },
    async (call) => {
      const result = await call("get_project", { projectId: "p1" });
      assert.equal(result.isError, undefined);
      const project = result.structuredContent?.project as Record<string, unknown>;
      assert.equal(project.title, "Booth Bandung");
      assert.equal(project.screenSize, undefined, "dropped before it reaches the wire");
    }
  );
});

test("the published schema still documents the shape it tolerates", async () => {
  // `.catch()` must not flatten the contract: the model still has to learn
  // that a bucket carries a numeric `revenue`, or it cannot ask for one.
  await withStudio({ found: true }, async (_call, client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === "get_revenue_summary");
    assert.ok(tool, "get_revenue_summary is listed");

    const schema = JSON.stringify(tool!.outputSchema);
    assert.match(schema, /"revenue"/);
    assert.match(schema, /main \+ reprint; the headline figure/, "descriptions survive");
    assert.match(schema, /Counted separately, NOT inside revenue/);
    assert.doesNotMatch(schema, /"revenue":\s*\{\s*\}/, "not widened to anything");
  });
});
