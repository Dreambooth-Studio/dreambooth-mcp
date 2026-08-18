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
 * which is what a proxy error or an HTML error page looks like from here.
 */
export async function writeErrorFor(res: Response, route: string): Promise<StudioError> {
  const relayed = await readErrorMessage(res);
  if (!relayed) return studioErrorFor(res.status, route);

  // Never retryable. Every status this path produces is a decision the Studio
  // made about the request — read-only connection, an argument it will not
  // accept, a name already taken — and repeating it produces the same answer,
  // or worse, a second copy of whatever did get through.
  return new StudioError(relayed, res.status, false);
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
