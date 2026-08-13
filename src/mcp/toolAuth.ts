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
