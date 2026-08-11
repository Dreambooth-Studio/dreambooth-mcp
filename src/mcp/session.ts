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
}

export const STDIO_SESSION: SessionContext = {
  transport: "stdio",
  sessionId: () => undefined,
};
