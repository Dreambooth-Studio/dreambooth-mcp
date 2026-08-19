import assert from "node:assert/strict";
import { test } from "node:test";

import { JobStore, JobLimitError, ownerKeyFor } from "../src/jobs/store.js";

/**
 * The store that lets a two-minute generation live behind a fifteen-second
 * tool call.
 *
 * Two properties here are security properties rather than conveniences: a job
 * is readable only by the credential that started it, and the credential
 * itself is never kept. The rest is about not lying to an operator who is
 * waiting — a job that hangs at "running" forever is worse than one that
 * failed, because the model keeps telling them it is nearly ready.
 */

const ALICE = ownerKeyFor("alice-token");
const BOB = ownerKeyFor("bob-token");

/** A promise the test decides when to settle. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the microtask queue drain so a settled job has been recorded. */
const settled = () => new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------- identity --- */

test("the owner key identifies a token without being one", () => {
  assert.equal(ownerKeyFor("alice-token"), ALICE, "same token, same key");
  assert.notEqual(ALICE, BOB, "different tokens, different keys");
  // The point of hashing: the map holds this for fifteen minutes after the
  // work is done, and it must not be a credential when it does.
  assert.ok(!ALICE.includes("alice-token"));
  assert.match(ALICE, /^[0-9a-f]{64}$/);
});

/* -------------------------------------------------------------- running --- */

test("start returns immediately, long before the work finishes", async () => {
  const store = new JobStore();
  const work = deferred<string>();

  const job = store.start(ALICE, "generate a frame", () => work.promise);

  // The whole reason this module exists. If this ever awaits, every MCP client
  // sees a hung server.
  assert.equal(job.state, "running");
  assert.equal(job.label, "generate a frame");
  assert.ok(job.id);
  assert.equal(job.result, undefined);

  work.resolve("a frame");
  await settled();
  assert.equal(store.get(ALICE, job.id)?.state, "done");
  assert.equal(store.get<string>(ALICE, job.id)?.result, "a frame");
});

test("a failure is recorded, not thrown at nobody", async () => {
  const store = new JobStore();
  const work = deferred<string>();
  const job = store.start(ALICE, "generate a frame", () => work.promise);

  // Rejecting here must not produce an unhandled rejection: this settles long
  // after the tool call that started it returned, with no caller left to catch.
  work.reject(Object.assign(new Error("Today's free AI pool is used up."), { status: 403 }));
  await settled();

  const done = store.get(ALICE, job.id);
  assert.equal(done?.state, "failed");
  assert.equal(done?.error?.message, "Today's free AI pool is used up.");
  assert.equal(done?.error?.status, 403);
});

test("a non-Error rejection still produces a readable message", async () => {
  const store = new JobStore();
  const work = deferred<string>();
  const job = store.start(ALICE, "x", () => work.promise);
  work.reject("just a string");
  await settled();
  assert.equal(store.get(ALICE, job.id)?.error?.message, "just a string");
});

/* ------------------------------------------------------------ ownership --- */

test("a job is invisible to any credential but the one that started it", async () => {
  const store = new JobStore();
  const job = store.start(ALICE, "generate a frame", async () => "done");
  await settled();

  assert.ok(store.get(ALICE, job.id), "the owner can read it");
  // Not a different error, not a 403 — the same answer as an id that never
  // existed. Anything else confirms to a caller holding a guessed id that it
  // named something real.
  assert.equal(store.get(BOB, job.id), null);
  assert.equal(store.get(BOB, "00000000-0000-0000-0000-000000000000"), null);
  assert.deepEqual(store.list(BOB), []);
});

/**
 * Both jobs below start in the same millisecond, which is the case that caught
 * a real defect: sorting on `startedAt` alone left them tied, and a tie made
 * "newest first" resolve to insertion order — oldest first — exactly backwards.
 */
test("list returns only this caller's jobs, newest first", async () => {
  const store = new JobStore();
  const first = store.start(ALICE, "first", async () => 1);
  const second = store.start(ALICE, "second", async () => 2);
  store.start(BOB, "bob's", async () => 3);
  await settled();

  const mine = store.list(ALICE);
  assert.equal(mine.length, 2);
  assert.deepEqual(
    mine.map((j) => j.label),
    ["second", "first"]
  );
  assert.ok(mine.every((j) => j.id === first.id || j.id === second.id));
});

test("nothing handed out carries the owner key", async () => {
  const store = new JobStore();
  const started = store.start(ALICE, "x", async () => "y");
  await settled();

  for (const view of [started, store.get(ALICE, started.id), ...store.list(ALICE)]) {
    assert.ok(view);
    assert.ok(!("ownerKey" in (view as object)), "ownerKey must not leave the module");
    assert.ok(!("seq" in (view as object)), "internal ordering is not part of the contract");
  }
});

/* ------------------------------------------------------------ the limit --- */

test("a fourth concurrent generation is refused, because the quota is the operator's", () => {
  const store = new JobStore();
  const held = [deferred<string>(), deferred<string>(), deferred<string>()];
  for (const d of held) store.start(ALICE, "generate", () => d.promise);

  // A model that retries a slow call in a loop would otherwise burn a day of
  // the operator's free allowance in seconds.
  assert.throws(
    () => store.start(ALICE, "one too many", async () => "x"),
    (err: unknown) => err instanceof JobLimitError && !err.retryable
  );

  // The cap is per credential, not global — one busy operator must not block
  // another.
  assert.doesNotThrow(() => store.start(BOB, "bob is fine", async () => "x"));

  for (const d of held) d.resolve("done");
});

test("finishing a job frees a slot", async () => {
  const store = new JobStore();
  const held = [deferred<string>(), deferred<string>(), deferred<string>()];
  for (const d of held) store.start(ALICE, "generate", () => d.promise);

  held[0].resolve("done");
  await settled();

  assert.doesNotThrow(() => store.start(ALICE, "now there is room", async () => "x"));
  for (const d of held) d.resolve("done");
});
