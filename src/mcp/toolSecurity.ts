import { READ_SCOPE, WRITE_SCOPE } from "../auth/scopes.js";
import { AUTH_REQUIRED_TOOLS } from "./toolAuth.js";

/**
 * The tools that need `booths:write`. The Studio refuses them without it.
 *
 * `scripts/readOnlyReconnect.test.ts` checks this list against the annotations
 * on the wire, so a new write tool cannot be declared as read by omission.
 */
export const WRITE_SCOPE_TOOLS = new Set([
  "create_filter",
  "duplicate_project",
  "start_frame",
  "refine_frame",
  "save_frame",
  "start_booth",
  "refine_booth",
  "create_booth",
  "update_booth_draft",
]);

/**
 * Each tool's auth policy, as ChatGPT reads it from `_meta.securitySchemes`.
 *
 * OpenAI documents two things as needed before ChatGPT will offer to authorize
 * again: this declaration, and the `mcp/www_authenticate` challenge a refused call
 * returns. It describes the policy and enforces nothing; the Studio still checks
 * the token's scope on every write.
 */
export function securitySchemesFor(
  name: string,
): Array<{ type: "noauth" } | { type: "oauth2"; scopes: string[] }> {
  if (!AUTH_REQUIRED_TOOLS.has(name)) return [{ type: "noauth" }];
  return [{ type: "oauth2", scopes: [WRITE_SCOPE_TOOLS.has(name) ? WRITE_SCOPE : READ_SCOPE] }];
}
