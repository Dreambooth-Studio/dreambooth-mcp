import type { Config } from "../config.js";
import { studioErrorFor, StudioError, writeErrorFor } from "./errors.js";
import { ownerKeyFor } from "../jobs/store.js";

/**
 * The ONLY place this service talks to Dreambooth.
 *
 * It is a transport, not a data layer: no Mongo, no aggregation, no business
 * rules. Every tool wraps a route the dashboard already calls, so there is
 * exactly one implementation of "what is this operator's revenue" and it lives
 * in the Studio. The moment an aggregation is copied in here it becomes a
 * second source of truth that drifts without anyone noticing.
 *
 * The token is read per request rather than captured at construction, because
 * in HTTP mode a session starts unauthenticated and gains its token part-way
 * through, when the operator finishes the device flow.
 */
export class StudioClient {
  constructor(
    private readonly config: Config,
    private readonly getToken: () => string | null,
    /** Describes why there is no token yet, for the not-connected message. */
    private readonly describeAuth: () => string = () => "not connected"
  ) {}

  private requireToken(): string {
    const token = this.getToken();
    if (!token) {
      // Says "no Dreambooth account is connected", not "your account is not
      // connected": the person asking may not have one yet, and the device
      // flow creates an account for them if so. A message that assumes they
      // are already a customer sends a prospect away.
      throw new StudioError(
        `No Dreambooth account is connected to this conversation (${this.describeAuth()}). ` +
          `Run connect_account and give them the link — approving with Google connects an existing ` +
          `account, or creates one on the spot if they do not have one yet. To answer questions ` +
          `about Dreambooth itself rather than about their booths, use search_docs, which needs no account.`,
        401,
        false
      );
    }
    return token;
  }

  /**
   * Identifies this caller to the job store, without handing out the token.
   *
   * Background work outlives the tool call that started it, so something has
   * to say who may read the result. That something must not be the credential
   * itself — the job store would then hold operator tokens for as long as it
   * holds jobs. A hash answers the only question asked and nothing else, and
   * computing it here means `getToken` stays private.
   *
   * Throws the not-connected message if there is no token, which is the same
   * answer any other call would give.
   */
  ownerKey(): string {
    return ownerKeyFor(this.requireToken());
  }

  async get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const token = this.requireToken();
    const url = new URL(this.config.apiUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          // The routes that use resolveAuthSession accept this. Routes that
          // only call getServerSession do NOT — see the design doc's migration
          // list. We deliberately never forge a session cookie.
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw studioErrorFor(504, path);
      }
      throw studioErrorFor(503, path);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw studioErrorFor(res.status, path);

    return (await res.json()) as T;
  }

  /**
   * Creates something. The only method here that changes anything.
   *
   * Two Studio routes accept it — POST /api/filters and the ?duplicate branch
   * of POST /api/projects — and both require an OAuth access token carrying
   * `booths:write`. A read-scoped token, or the device-flow session token, is
   * refused by the Studio with a 403 whose message is written to be relayed
   * verbatim; see `studioErrorFor`.
   *
   * There is deliberately no `put` or `delete`. Adding one would be a two-line
   * change here and a much larger one everywhere else: the consent screen, the
   * directory listing and the scope's own name all say this connector creates
   * and does not manage. Whoever needs the method should change those first.
   */
  async post<T>(
    path: string,
    body: unknown,
    query: Record<string, string | undefined> = {}
  ): Promise<T> {
    const token = this.requireToken();
    const url = new URL(this.config.apiUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        /**
         * A timeout on a write is NOT the same as a timeout on a read.
         *
         * The request may well have succeeded — the reply is what went missing.
         * Telling the model this is retryable would have it create the filter a
         * second time, so the message says to check rather than to repeat, and
         * `retryable` is false. See studioErrorFor's 504 case for the read
         * equivalent, which says the opposite because repeating a GET is free.
         */
        throw new StudioError(
          `Dreambooth did not answer in time, and a request that creates something may have gone through anyway. ` +
            `Do not try again — ask the operator to check their dashboard first.`,
          504,
          false
        );
      }
      throw studioErrorFor(503, path);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw await writeErrorFor(res, path);

    return (await res.json()) as T;
  }

  /**
   * Fetches a public static file (no Authorization header, no token required).
   *
   * Used for the docs search index, which is a build-time artefact served from
   * /public — not an API route. This is why search_docs works before the
   * operator has connected anything.
   */
  async getPublic<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const res = await fetch(this.config.apiUrl + path, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw studioErrorFor(res.status, path);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw studioErrorFor(504, path);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
