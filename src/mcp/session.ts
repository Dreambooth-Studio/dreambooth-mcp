/**
 * What a tool is allowed to know about the connection serving it.
 *
 * Deliberately not the transport object: a tool that can reach the transport
 * can reach other sessions' plumbing, and the only thing any tool has ever
 * needed is "which session am I" for diagnostics.
 */
export interface SessionContext {
  transport: "http" | "stdio";
  /**
   * Read lazily — in HTTP mode the id is assigned during `initialize`, after
   * the server object has already been built. Undefined on stdio, which has no
   * session id at all.
   */
  sessionId: () => string | undefined;
  /**
   * True when this request is served with no session at all, so nothing
   * survives the response.
   *
   * It matters to exactly one tool. `connect_account` writes the approved token
   * into a store that, on this path, is discarded the moment the reply is sent
   * — so it would hand the operator a link, poll happily in the background, and
   * never connect anything. Failing loudly beats a link that cannot work.
   */
  stateless?: boolean;
  /**
   * True when this request arrived with its own `Authorization: Bearer` header
   * — that is, on the OAuth path rather than the device flow.
   *
   * It decides whether the write tools are registered at all. The reason it is
   * a boolean about the CREDENTIAL'S ORIGIN rather than about its scope is that
   * the access token is a next-auth JWE: this server holds no key for it and
   * cannot read `scope` out of it, and asking the Studio on every `tools/list`
   * would put a round trip in front of the cheapest call a client makes.
   *
   * So the gate here is the coarse half of the rule — writes exist only where
   * a revocable, scoped token could be — and the Studio enforces the scope
   * itself, returning a 403 whose sentence names the fix. See
   * docs/write-tools-plan.md §5.6.
   */
  bearerAuth?: boolean;
}

export const STDIO_SESSION: SessionContext = {
  transport: "stdio",
  sessionId: () => undefined,
};
