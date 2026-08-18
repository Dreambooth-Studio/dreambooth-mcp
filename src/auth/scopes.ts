/**
 * The scopes the Studio can grant, named once.
 *
 * Two documents have to agree on this list and they are read at different
 * moments by different clients: the protected-resource metadata a client
 * fetches before it has a token (`wellKnown.ts`), and the `WWW-Authenticate`
 * challenge it gets when a tool call is refused (`challenge.ts`). A client
 * builds its authorization request from whichever it saw first.
 *
 * They were separate literals, and the cost of that was concrete: the write
 * tools shipped while both still said `booths:read`, so no client ever asked
 * for `booths:write`, the operator was never offered it on the consent screen,
 * and every write came back 403 telling them to approve a permission that
 * nothing had requested.
 *
 * The Studio remains the authority — `SUPPORTED_SCOPES` in its
 * `lib/oauth/tokens.ts`, which `narrowScope` enforces and which no value here
 * can widen. This is the advertisement, not the grant.
 */

export const READ_SCOPE = "booths:read";

/** Creating a filter, and duplicating a booth. Not editing, deleting or money. */
export const WRITE_SCOPE = "booths:write";

export const SUPPORTED_SCOPES = [READ_SCOPE, WRITE_SCOPE] as const;

/** The space-delimited form an OAuth `scope` parameter takes. */
export const SCOPE_STRING = SUPPORTED_SCOPES.join(" ");
