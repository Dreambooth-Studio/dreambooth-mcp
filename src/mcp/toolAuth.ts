/**
 * Which tools need an operator's credential, and how to tell before dispatch.
 *
 * The list is here rather than inferred from `server.ts` because the check has
 * to happen in the transport, one layer BELOW the MCP server object: the answer
 * to "you are not authorised" is an HTTP 401 with a `WWW-Authenticate` header,
 * and by the time a tool handler runs the status line is long gone.
 *
 * Keep this in sync with `createServer`. A tool missing from here fails open —
 * it runs, hits the Studio without a token, and returns the "not connected"
 * sentence instead of triggering a sign-in, which is the exact failure this
 * whole path exists to remove.
 */
export const AUTH_REQUIRED_TOOLS = new Set([
  "get_sessions",
  "get_gallery_stats",
  "list_projects",
  "get_project",
  "get_revenue_summary",
  "get_credits",
  "get_wallet_transactions",
  // The write tools are advertised on every connection, credentialled or not
  // (see createServer), so this list is the only thing between an
  // uncredentialled call and the Studio. Without it the call would arrive
  // tokenless and come back "no account is connected" — which reads as a
  // failure and starts no sign-in. Listing them here makes it the 401 that
  // begins the OAuth flow instead.
  "create_filter",
  "duplicate_project",
  "start_frame",
  "refine_frame",
  "check_generation",
  "save_frame",
  // Read-only, but it calls the Studio and exists only as the first half of
  // create_filter: a call without a token should start a sign-in, not answer
  // "not connected".
  "preview_filter",
  /**
   * The five booth tools, back on 2026-09-23 with `BOOTH_TOOLS_LIVE`.
   *
   * They came out when the Studio's `digital_mode` flag was off and its
   * onboarding routes 404'd for everyone. This list must track the
   * REGISTRATION, in both directions: a name here that `createServer` does not
   * register turns a call into a 401 that starts a sign-in for a tool that does
   * not exist, and a registered tool missing from here reaches the Studio with
   * no token and answers "not connected" instead of starting one.
   * `scripts/boothTools.test.ts` asserts both against the constant.
   */
  "start_booth",
  "refine_booth",
  "create_booth",
  "get_booth_draft",
  "update_booth_draft",
]);

/**
 * Deliberately NOT in the set above:
 *
 *   search_docs         the whole point is that it answers without an account,
 *                       and the directory listing promises exactly that
 *   connect_account     asking for a credential before the tool that obtains
 *                       one is a loop
 *   connection_status   reads memory; answering "no" is its job
 *   session_info        diagnostic, off in production
 */

interface JsonRpcLike {
  method?: unknown;
  params?: { name?: unknown } | unknown;
}

/**
 * The tool name a request is trying to call, or null if it is not a tool call.
 *
 * Tolerant by design: a batch, a notification, a malformed body or anything
 * that is not `tools/call` returns null and takes the normal path. This
 * function decides whether to REFUSE a request, so every ambiguous case must
 * resolve to "carry on" — guessing wrong in the other direction 401s a
 * perfectly good `initialize` and the connector never starts at all.
 *
 * The batch case is the one with a real cost, so it is worth naming: the SDK
 * does still answer JSON-RPC arrays, so an authenticated `tools/call` wrapped
 * in a batch reaches the tool without a 401 and comes back as the "no account
 * is connected" sentence instead of starting a sign-in. That is a worse
 * experience than the challenge, and it is still the right trade — inspecting
 * a batch to decide whether ANY member needs auth means refusing a whole batch
 * for one member, and 401ing an array that also carries `initialize` breaks the
 * connection outright. Clients that matter do not batch tool calls.
 */
export function toolCallName(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const message = body as JsonRpcLike;
  if (message.method !== "tools/call") return null;
  const params = message.params;
  if (!params || typeof params !== "object") return null;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

/** True when this request is a call to a tool that cannot work without a token. */
export function requiresAuth(body: unknown): boolean {
  const name = toolCallName(body);
  return name !== null && AUTH_REQUIRED_TOOLS.has(name);
}
