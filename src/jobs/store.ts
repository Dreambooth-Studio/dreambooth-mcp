import { createHash, randomUUID } from "node:crypto";

/**
 * Work that outlives the tool call that started it.
 *
 * Every generative capability the Studio has — frame generation, welcome
 * design — is an image-model call. `maxDuration` on those routes is 120
 * seconds; this service's own `requestTimeoutMs` defaults to 15. There is no
 * value that reconciles those, because the constraint is not really the
 * timeout: a tool call that blocks for two minutes reads as a hung server to
 * every MCP client. That is the same reason `connect_account` returns
 * immediately and polls rather than waiting for an operator to finish a
 * browser flow.
 *
 * So the shape here is the one that path already proved: the tool starts the
 * work, returns a handle, and a second tool reports on it.
 *
 * ## Why this lives at module scope
 *
 * A request carrying its own bearer is served by `handleStateless`, which
 * builds a throwaway server and closes it on the response. Nothing in that
 * scope survives to the poll. The device-flow `sessions` map is no help
 * either: it exists only for the path that has no bearer, which is exactly the
 * path the write tools are not registered on. So the store has to be the
 * process, and ownership has to be re-established from the credential on every
 * request rather than remembered.
 *
 * ## What that costs, stated plainly
 *
 * This is per-process memory. Two consequences, both real:
 *
 *   - A restart loses every running job. The poll then answers "I cannot find
 *     that", which is honest and recoverable — the work may well have finished
 *     in the Studio, and the message says to check the dashboard.
 *   - If this service is ever run on more than one instance, a job started on
 *     one is invisible to the other, and polls land on whichever instance the
 *     load balancer picks. Today Railway runs a single instance with no
 *     volume. **A second instance breaks polling**, and the fix at that point
 *     is a shared store, not a longer retention.
 */

/** How long a finished job stays readable before it is swept. */
const RETENTION_MS = 15 * 60 * 1000;

/** How long a job may run before it is presumed dead. Studio maxDuration is 120s. */
const MAX_RUNTIME_MS = 3 * 60 * 1000;

/**
 * Concurrent jobs one credential may have in flight.
 *
 * Not politeness. The Studio's frame generation is capped per day per
 * operator, and that allowance is the operator's, not ours to spend. A model
 * that retries a slow call in a loop would burn a day of it in seconds, and
 * the operator would find out by being unable to generate anything at all.
 * Refusing the fourth is the cheapest place to stop that.
 */
const MAX_IN_FLIGHT_PER_OWNER = 3;

export type JobState = "running" | "done" | "failed";

export interface JobFailure {
  message: string;
  status?: number;
}

export interface Job<T = unknown> {
  id: string;
  state: JobState;
  /** What the operator asked for, so a poll can answer without re-deriving it. */
  label: string;
  startedAt: number;
  finishedAt?: number;
  result?: T;
  error?: JobFailure;
}

interface StoredJob<T> extends Job<T> {
  ownerKey: string;
  /**
   * Insertion order, because `startedAt` is not enough to sort by.
   *
   * Two jobs started in the same millisecond tie, and a tie makes "newest
   * first" quietly untrue — `list` is what answers "is it done yet?" when the
   * model did not keep the id, so the wrong job first is the wrong answer.
   * A counter cannot tie.
   */
  seq: number;
}

/**
 * Identifies the holder of a credential without holding the credential.
 *
 * A job is readable only by the token that started it. Comparing tokens
 * directly would mean keeping operator credentials in a map for fifteen
 * minutes after the work finished, which is a strictly worse thing to own than
 * the job it protects. A hash answers the only question ever asked of it — is
 * this the same caller — and answers nothing else.
 *
 * Deliberately NOT the operator's email: this service cannot read one out of
 * the token. It is a next-auth JWE and we hold no key for it.
 */
export function ownerKeyFor(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Raised when one credential has too many generations running at once. */
export class JobLimitError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "JobLimitError";
  }
}

export class JobStore {
  private jobs = new Map<string, StoredJob<unknown>>();
  private nextSeq = 0;

  /**
   * Registers a job and starts it. Returns as soon as the work is scheduled,
   * never awaits it.
   *
   * The promise is settled into the record here rather than by the caller, so
   * a rejection cannot escape as an unhandled rejection and take the process
   * down while an operator is mid-conversation.
   */
  start<T>(ownerKey: string, label: string, work: () => Promise<T>): Job<T> {
    this.sweep();

    const inFlight = [...this.jobs.values()].filter(
      (j) => j.ownerKey === ownerKey && j.state === "running"
    ).length;
    if (inFlight >= MAX_IN_FLIGHT_PER_OWNER) {
      throw new JobLimitError(
        inFlight +
          " of this account's generations are already running. Wait for one to" +
          " finish before starting another — each one uses part of the daily" +
          " free allowance."
      );
    }

    const job: StoredJob<T> = {
      id: randomUUID(),
      ownerKey,
      seq: this.nextSeq++,
      state: "running",
      label,
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job as unknown as StoredJob<unknown>);

    void work().then(
      (result) => {
        job.state = "done";
        job.result = result;
        job.finishedAt = Date.now();
      },
      (err: unknown) => {
        job.state = "failed";
        job.finishedAt = Date.now();
        job.error = {
          message: err instanceof Error ? err.message : String(err),
          status:
            err && typeof err === "object" && "status" in err
              ? Number((err as { status: unknown }).status) || undefined
              : undefined,
        };
      }
    );

    return publicView(job);
  }

  /**
   * The job, if this caller is the one that started it.
   *
   * A job belonging to someone else returns null, identically to one that
   * never existed. Distinguishing the two would confirm to a caller holding a
   * guessed id that it had named something real.
   */
  get<T>(ownerKey: string, id: string): Job<T> | null {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.ownerKey !== ownerKey) return null;
    return publicView(job) as Job<T>;
  }

  /** Every job this caller has, newest first — so "is it done yet?" needs no id. */
  list<T>(ownerKey: string): Job<T>[] {
    this.sweep();
    return [...this.jobs.values()]
      .filter((j) => j.ownerKey === ownerKey)
      .sort((a, b) => b.seq - a.seq)
      .map((j) => publicView(j) as Job<T>);
  }

  /**
   * Drops finished jobs past retention, and fails running ones past the
   * maximum runtime.
   *
   * A job stuck at "running" forever is worse than one marked failed: the
   * model keeps polling and keeps telling the operator to wait for something
   * that is not coming. The Studio's own `maxDuration` is 120 seconds, so
   * anything past three minutes is not slow, it is gone.
   *
   * Called on access rather than on a timer — this store is only ever touched
   * by a request, and a timer would keep the process alive with nothing to do.
   */
  private sweep(now = Date.now()): void {
    for (const [id, job] of this.jobs) {
      if (job.state === "running" && now - job.startedAt > MAX_RUNTIME_MS) {
        job.state = "failed";
        job.finishedAt = now;
        job.error = {
          message:
            "This generation stopped reporting and may or may not have finished." +
            " Check the dashboard before starting another.",
        };
        continue;
      }
      if (job.state !== "running" && now - (job.finishedAt ?? job.startedAt) > RETENTION_MS) {
        this.jobs.delete(id);
      }
    }
  }

  /** Test seam. */
  get size(): number {
    return this.jobs.size;
  }
}

/** Everything except the fields that must never leave this module. */
function publicView<T>(job: StoredJob<T>): Job<T> {
  const { ownerKey: _ownerKey, seq: _seq, ...rest } = job;
  return { ...rest };
}

/**
 * The process-wide store.
 *
 * A single instance is the assumption; the note at the top of this file says
 * what breaks if that stops being true.
 */
export const jobs = new JobStore();
