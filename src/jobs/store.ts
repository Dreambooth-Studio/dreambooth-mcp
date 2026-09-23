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
 * process, and ownership has to be re-established on every request rather than
 * remembered. It is re-established from the JOB ID, not from the credential —
 * see {@link JobStore.byId} for why the credential turned out to be the wrong
 * thing to key on.
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

/**
 * How long a job may run before it is presumed dead, when the caller says
 * nothing. A frame generation's route declares maxDuration 120 s; booth jobs
 * pass their own, longer ceiling (see src/tools/boothGeneration.ts).
 */
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

/**
 * What a job is, for the tool that reports on it and the card that draws it.
 *
 *   generation    a frame — start_frame / refine_frame
 *   booth-draft   a booth designed but not created — start_booth / refine_booth
 *   booth         a booth created — create_booth
 */
export type JobKind = "generation" | "booth-draft" | "booth";

/** What running work may do to its own record: say where it is, and what it turned out to be about. */
export interface JobContext {
  jobId: string;
  progress: (text: string) => void;
  /**
   * Records the thing this job turned out to be about — a thread id — once it
   * knows. Unlike `JobOptions.ref`, which is for work that knows before it
   * starts, this is for work that CREATES the thing it is about: `start_frame`
   * opens a design thread and only then generates in it.
   *
   * It matters most when the job then fails. A thread that exists is not lost
   * because the generation in it was refused, and a poll that can name it
   * lets the conversation carry on in the same thread instead of opening a
   * second one nobody asked for.
   */
  ref: (value: string) => void;
}

export interface JobOptions {
  /** Defaults to "generation", which is what every job was before booths. */
  kind?: JobKind;
  /** Per-job ceiling; defaults to MAX_RUNTIME_MS. */
  maxRuntimeMs?: number;
  /** What the job is about — a draft id — so a second job on it can be refused. */
  ref?: string;
}

export interface JobFailure {
  message: string;
  status?: number;
}

export interface Job<T = unknown> {
  id: string;
  kind: JobKind;
  state: JobState;
  /** What the operator asked for, so a poll can answer without re-deriving it. */
  label: string;
  /** The thing the job is about (a draft id), when it has one. */
  ref?: string;
  startedAt: number;
  finishedAt?: number;
  result?: T;
  error?: JobFailure;
  /** Where running work says it is; cleared of meaning once finished. */
  progress?: string;
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
  /** When this job is presumed dead; per job, because booths run longer than frames. */
  maxRuntimeMs: number;
}

/**
 * Identifies the holder of a credential without holding the credential.
 *
 * Comparing tokens directly would mean keeping operator credentials in a map
 * for fifteen minutes after the work finished, which is a strictly worse thing
 * to own than the job it protects. A hash answers the only question ever asked
 * of it — is this the same caller — and answers nothing else.
 *
 * Deliberately NOT the operator's email: this service cannot read one out of
 * the token. It is a next-auth JWE and we hold no key for it.
 *
 * What it identifies is a TOKEN, not a person, and the difference is the whole
 * reason {@link JobStore.byId} no longer consults it: the same operator gets a
 * new key on every refresh and a different one on every device. It is still
 * the right key for {@link JobStore.list} and for {@link RecentCreations},
 * which answer "what did I just do" and have no id to go on — see the note on
 * `list` for what that costs.
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
  start<T>(
    ownerKey: string,
    label: string,
    work: (ctx: JobContext) => Promise<T>,
    options: JobOptions = {}
  ): Job<T> {
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
      kind: options.kind ?? "generation",
      ref: options.ref,
      maxRuntimeMs: options.maxRuntimeMs ?? MAX_RUNTIME_MS,
      state: "running",
      label,
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job as unknown as StoredJob<unknown>);

    const ctx: JobContext = {
      jobId: job.id,
      progress: (text) => this.progress(job.id, text),
      ref: (value) => this.setRef(job.id, value),
    };
    void work(ctx).then(
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
   * The job with this id, for any caller that can name it.
   *
   * ## Why naming it is the proof
   *
   * This used to also require `ownerKey` to match, and `ownerKey` is
   * `sha256(access token)` — which made a job readable only by the exact
   * bearer string that started it. That is a stricter rule than it sounds,
   * because the token MOVES. The authorization server advertises
   * `refresh_token` and access tokens last an hour, so ChatGPT refreshes
   * mid-conversation; the moment it does, every job started before the refresh
   * becomes unreadable and `check_generation` reports "no job with that id is
   * being tracked" about work that is running perfectly well. The same wall
   * stands between the same person's phone and laptop, which hold different
   * tokens for the same account. A booth creation runs 2-6 minutes and the
   * live card polls throughout; an hour-long conversation crossing a refresh
   * is ordinary, not an edge case.
   *
   * So ownership is carried by the id instead. `randomUUID()` is 122 bits of
   * entropy, it is returned only in the result of the start/refine/create call
   * that minted it, and it goes nowhere else — not into a log line, not into a
   * URL. A caller that can name a job is therefore a caller that was handed
   * it, which is the same conclusion the token hash was being used to reach,
   * reached by something that does not expire.
   *
   * ## What this gives up, stated plainly
   *
   * A guessed id is no longer refused. It is not *findable* — a v4 UUID is not
   * enumerable and the store holds at most a few dozen at a time — but the
   * check is now unguessability rather than a credential comparison, and those
   * are different guarantees. Two things still hold the line: a caller must
   * present SOME token to get this far (`check_generation` resolves
   * `studio.ownerKey()`, which throws without one, and the HTTP transport 401s
   * the call before dispatch), and {@link list} is still owner-scoped, so
   * nobody can enumerate what they were not given.
   *
   * An id that never existed and an id that has been swept return the same
   * `null`, unchanged.
   */
  byId<T>(id: string): Job<T> | null {
    this.sweep();
    const job = this.jobs.get(id);
    return job ? (publicView(job) as Job<T>) : null;
  }

  /**
   * Every job this caller has, newest first — so "is it done yet?" needs no id.
   *
   * Still keyed to the token hash, deliberately: this is the one call that
   * answers a question nobody supplied an id for, so there is nothing else to
   * establish who is asking. The cost is that it goes quiet after a token
   * refresh — the jobs are still there and still readable by {@link byId},
   * they just stop being listed. `check_generation` says so rather than
   * reporting that no work was ever started.
   */
  list<T>(ownerKey: string): Job<T>[] {
    this.sweep();
    return [...this.jobs.values()]
      .filter((j) => j.ownerKey === ownerKey)
      .sort((a, b) => b.seq - a.seq)
      .map((j) => publicView(j) as Job<T>);
  }

  /**
   * Lets running work say where it is — "drawing the welcome screen for
   * phones" — so a poll can relay something better than elapsed seconds.
   * Ignored once the job has finished: a late write from a background loop
   * must not decorate a final state.
   */
  progress(id: string, text: string): void {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return;
    job.progress = text.trim().slice(0, 140);
  }

  /**
   * Records what a running job turned out to be about. Same "running only"
   * rule as `progress`, and for the same reason — but the value SURVIVES the
   * job finishing, because pointing at a thread is exactly what a failed
   * generation still has to offer.
   */
  private setRef(id: string, value: string): void {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return;
    const trimmed = value.trim();
    if (trimmed) job.ref = trimmed;
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
      if (job.state === "running" && now - job.startedAt > job.maxRuntimeMs) {
        job.state = "failed";
        job.finishedAt = now;
        job.error = { message: swept(job.kind) };
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
  const { ownerKey: _ownerKey, seq: _seq, maxRuntimeMs: _maxRuntimeMs, ...rest } = job;
  return { ...rest };
}

/** The sentence a job that ran past its ceiling is failed with. */
function swept(kind: JobKind): string {
  switch (kind) {
    case "booth-draft":
      return (
        "This booth design stopped reporting and may or may not have finished." +
        " Start again with start_booth — a draft made by the lost job cannot be retrieved from here."
      );
    case "booth":
      return (
        "This booth creation stopped reporting and may or may not have finished." +
        " Check list_projects or the dashboard before creating again."
      );
    default:
      return (
        "This generation stopped reporting and may or may not have finished." +
        " Check the dashboard before starting another."
      );
  }
}

/**
 * The process-wide store.
 *
 * A single instance is the assumption; the note at the top of this file says
 * what breaks if that stops being true.
 */
export const jobs = new JobStore();
