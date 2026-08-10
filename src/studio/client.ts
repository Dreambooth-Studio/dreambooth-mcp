import type { Config } from "../config.js";
import { studioErrorFor } from "./errors.js";

/**
 * The ONLY place this service talks to Dreambooth.
 *
 * It is a transport, not a data layer: no Mongo, no aggregation, no business
 * rules. Every tool wraps a route the dashboard already calls, so there is
 * exactly one implementation of "what is this operator's revenue" and it lives
 * in the Studio. The moment an aggregation is copied in here it becomes a
 * second source of truth that drifts without anyone noticing.
 */
export class StudioClient {
  constructor(private readonly config: Config) {}

  async get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
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
          // The 59 routes that use resolveAuthSession accept this. Routes that
          // only call getServerSession do NOT — see the design doc's route
          // migration list. We deliberately do not forge a session cookie.
          Authorization: `Bearer ${this.config.token}`,
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
   * Fetches a public static file (no Authorization header).
   *
   * Used for the docs search index, which is a build-time artefact served from
   * /public — not an API route.
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
