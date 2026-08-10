/**
 * Where an operator's Studio token lives while their MCP session is open.
 *
 * IN MEMORY ONLY — never written to disk, never logged. A Railway restart means
 * every operator reconnects, and that is the right trade for v1: there is no
 * credential store to protect, back up, or leak. The token is a NextAuth
 * session JWT, which is session-equivalent (one year, no scopes, no
 * revocation), so the less time it exists anywhere the better.
 *
 * One instance per MCP session. Binding it to the session rather than to the
 * process is what keeps two operators talking to the same server from ever
 * seeing each other's data.
 */
export class SessionTokens {
  private token: string | null = null;
  /** Device-flow state we are still waiting on, if any. */
  private pendingState: string | null = null;
  private pendingSince: number | null = null;
  private lastError: string | null = null;

  constructor(initialToken?: string) {
    this.token = initialToken?.trim() || null;
  }

  get(): string | null {
    return this.token;
  }

  set(token: string): void {
    this.token = token;
    this.pendingState = null;
    this.pendingSince = null;
    this.lastError = null;
  }

  clear(): void {
    this.token = null;
  }

  startPending(state: string): void {
    this.pendingState = state;
    this.pendingSince = Date.now();
    this.lastError = null;
  }

  failPending(reason: string): void {
    this.pendingState = null;
    this.pendingSince = null;
    this.lastError = reason;
  }

  /** Human-readable status for the model to relay when a tool is called too early. */
  describe(): string {
    if (this.token) return "connected";
    if (this.pendingState) {
      const seconds = Math.round((Date.now() - (this.pendingSince ?? Date.now())) / 1000);
      return `waiting for the operator to approve in their browser (${seconds}s so far)`;
    }
    if (this.lastError) return `not connected — ${this.lastError}`;
    return "not connected";
  }
}
