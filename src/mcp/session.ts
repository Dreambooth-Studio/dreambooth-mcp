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
}

export const STDIO_SESSION: SessionContext = {
  transport: "stdio",
  sessionId: () => undefined,
};
