/**
 * Turns a Studio HTTP failure into a message the MODEL can act on.
 *
 * This matters more than it looks. The model never sees a stack trace — it sees
 * the text we return, and it will relay that text to the operator and decide
 * what to do next. "Request failed" makes it retry forever; "your connection
 * expired, ask the operator to reconnect" makes it stop and say something
 * useful.
 */

export class StudioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** false = retrying will not help; tell the operator instead. */
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "StudioError";
  }
}

export function studioErrorFor(status: number, route: string): StudioError {
  switch (status) {
    case 401:
      return new StudioError(
        "The Dreambooth connection is not valid any more. Ask the operator to reconnect their account, then try again.",
        status,
        false
      );
    case 403:
      return new StudioError(
        "This Dreambooth account is not allowed to read that. Do not retry.",
        status,
        false
      );
    case 404:
      return new StudioError(`Nothing found at ${route}.`, status, false);
    case 429:
      return new StudioError(
        "Dreambooth is rate limiting this connection. Wait a minute before asking again.",
        status,
        true
      );
    case 504:
      /**
       * Reached two ways, and they mean the same thing to a reader: the
       * platform gave up on the route, or this client did (`StudioClient.get`
       * raises its AbortError as a 504). Neither is "Dreambooth had a server
       * error", which is what the 5xx branch below used to say — it blamed the
       * Studio for a request that was merely slow, and for one that WE stopped
       * waiting on.
       *
       * Retryable, because this mapping is only ever reached from a read.
       * Writes go through `writeErrorFor`, which answers a gateway failure
       * with the opposite advice for the opposite reason.
       */
      return new StudioError(
        `Dreambooth took too long to answer ${route}. Nothing was changed — this only reads — so it is safe to ask again in a moment.`,
        status,
        true
      );
    default:
      if (status >= 500) {
        return new StudioError(
          "Dreambooth had a server error. This is usually temporary.",
          status,
          true
        );
      }
      return new StudioError(
        `Dreambooth rejected the request (HTTP ${status}).`,
        status,
        false
      );
  }
}

/**
 * The failure of a request that tried to CREATE something.
 *
 * Different from `studioErrorFor` in one way that matters: it reads the
 * Studio's own `{ error }` body and relays it. Those sentences are product
 * copy, written to be said to an operator — "this connection is read-only,
 * reconnect and approve permission to create things" tells them exactly which
 * button to press, where a generic 403 sends the model off to guess.
 *
 * Falls back to the generic mapping when the body is missing or unreadable,
 * which is what a proxy error or an HTML error page looks like from here —
 * except at 5xx, where the generic mapping says the wrong thing. See below.
 */
export async function writeErrorFor(res: Response, route: string): Promise<StudioError> {
  const relayed = await readErrorMessage(res);
  if (relayed) {
    // A refusal the Studio wrote. Never retryable: every status that arrives
    // with a body is a decision it made about the request — read-only
    // connection, an argument it will not accept, a name already taken — and
    // repeating it produces the same answer, or worse, a second copy of
    // whatever did get through.
    return new StudioError(relayed, res.status, false);
  }

  /**
   * No body to relay. For a 5xx that is the shape of a gateway failure: a
   * platform timeout page, an HTML 502, an empty 500 — and the one case where
   * the read mapping is actively dangerous here, because it calls a 5xx
   * retryable. It is right to for a GET. For a POST it tells the model to
   * repeat a request that may have completed, which is how one duplicated
   * booth becomes two.
   *
   * Whether the write landed is genuinely unknown at this point, so the answer
   * is the one `StudioClient.post` already gives when it aborts: say it may
   * have gone through, and stop.
   */
  if (res.status >= 500) {
    return new StudioError(
      `Dreambooth did not finish the request to ${route}, and a request that creates something may have gone through anyway. ` +
        `Do not try again — ask the operator to check their dashboard first.`,
      res.status,
      false
    );
  }

  // Below 500 the generic mapping is right, 429 included: a rate limit is a
  // refusal before any work, so asking again later is the correct advice.
  return studioErrorFor(res.status, route);
}

/** The `error` field of a JSON body, if there is one and it is a string. */
async function readErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    for (const candidate of [body?.error, body?.message]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return null;
  } catch {
    return null;
  }
}
