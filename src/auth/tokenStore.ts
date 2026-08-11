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
  /**
   * The account the token belongs to, purely so the connected card can say
   * whose it is. Never used to scope a request — the Studio resolves the
   * operator from the token itself.
   */
  private email: string | null = null;
  /** Device-flow state we are still waiting on, if any. */
  private pendingState: string | null = null;
  private pendingSince: number | null = null;
  private lastError: string | null = null;

  // No seed-token constructor on purpose. A session becomes authenticated only
  // by its own operator completing the device flow, so there is no way to
  // pre-load one account's credential into somebody else's session.
  //
  // `forRequest` below is not an exception to that rule. The banned thing is a
  // token from CONFIGURATION, which would authenticate every incoming session
  // as one account. A token from the caller's own Authorization header is that
  // caller's credential, scoped to the single request it arrived on, and is how
  // every stateless HTTP API has always worked.

  /**
   * A store holding one request's bearer token and nothing else.
   *
   * Required because the MCP session is being removed from the protocol
   * (SEP-2567), so there is no longer anywhere durable to keep a token: it has
   * to arrive with each request. This is also exactly the shape OAuth needs, so
   * the stateless path lands before the authorization server does.
   */
  static forRequest(token: string): SessionTokens {
    const store = new SessionTokens();
    store.token = token;
    return store;
  }

  get(): string | null {
    return this.token;
  }

  getEmail(): string | null {
    return this.email;
  }

  set(token: string, email?: string | null): void {
    this.token = token;
    this.email = email ?? null;
    this.pendingState = null;
    this.pendingSince = null;
    this.lastError = null;
  }

  clear(): void {
    this.token = null;
    this.email = null;
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

  /**
   * Machine-readable phase, for the connect card's state machine.
   *
   * Separate from `describe()` because a widget needs to branch on the state
   * and a model needs a sentence; deriving one from the other by parsing
   * English is how a UI ends up broken by a copy edit.
   */
  phase(): "connected" | "waiting" | "expired" | "idle" {
    if (this.token) return "connected";
    if (this.pendingState) return "waiting";
    if (this.lastError) return "expired";
    return "idle";
  }

  /** Seconds the current device flow has been waiting, if one is running. */
  waitingSeconds(): number | null {
    if (!this.pendingState || this.pendingSince === null) return null;
    return Math.round((Date.now() - this.pendingSince) / 1000);
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
