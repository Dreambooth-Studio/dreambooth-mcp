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
