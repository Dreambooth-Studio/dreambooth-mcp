import type { Config } from "../config.js";
import { studioErrorFor, StudioError } from "./errors.js";

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
