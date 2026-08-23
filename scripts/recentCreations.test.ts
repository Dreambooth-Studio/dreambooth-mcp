import assert from "node:assert/strict";
import { test } from "node:test";

import { RecentCreations } from "../src/creations/recent.js";

/**
 * What a connection made recently, so create_booth can carry it. Bounded in
 * count and age, per owner, newest first; never the token itself as a key.
 */

test("remembers per owner and kind, newest first, without duplicates", () => {
  const r = new RecentCreations(() => 1_000);
  r.remember("owner-a", "filter", "f1");
  r.remember("owner-a", "filter", "f2");
  r.remember("owner-a", "filter", "f1");
  r.remember("owner-a", "frame", "fr1");
  r.remember("owner-b", "filter", "f9");
  assert.deepEqual(r.list("owner-a", "filter"), ["f1", "f2"]);
  assert.deepEqual(r.list("owner-a", "frame"), ["fr1"]);
  assert.deepEqual(r.list("owner-b", "filter"), ["f9"]);
  assert.deepEqual(r.list("owner-b", "frame"), []);
  assert.deepEqual(r.list("nobody", "filter"), []);
});

test("ignores empty ids and forgets after two hours", () => {
  let now = 0;
  const r = new RecentCreations(() => now);
  r.remember("o", "filter", undefined);
  r.remember("o", "filter", "");
  assert.deepEqual(r.list("o", "filter"), []);
  r.remember("o", "filter", "old");
  now = 60 * 60 * 1000;
  r.remember("o", "filter", "newer");
  assert.deepEqual(r.list("o", "filter"), ["newer", "old"]);
  now = 2 * 60 * 60 * 1000 + 1;
  assert.deepEqual(r.list("o", "filter"), ["newer"], "the first one aged out");
  now = 4 * 60 * 60 * 1000;
  assert.deepEqual(r.list("o", "filter"), []);
});

test("keeps at most 24 per kind", () => {
  const r = new RecentCreations(() => 0);
  for (let i = 0; i < 30; i++) r.remember("o", "frame", `fr${i}`);
  const list = r.list("o", "frame");
  assert.equal(list.length, 24);
  assert.equal(list[0], "fr29");
  assert.equal(list[23], "fr6");
});
