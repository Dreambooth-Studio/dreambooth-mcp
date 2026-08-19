import type express from "express";
import type { Config } from "../config.js";
import { SCOPE_STRING } from "./scopes.js";

/**
 * The 401 that starts an OAuth flow.
 *
 * This is the single most important response this service sends. An MCP client
 * does not go looking for an authorization server on a hunch — it discovers one
 * because a request came back 401 with a `WWW-Authenticate` header naming where
 * the resource metadata lives (RFC 9728 §5.1, and the MCP authorization spec
 * builds directly on it).
 *
 * Without this header the connector is indistinguishable from a server that
 * needs no authentication at all, which is precisely what ChatGPT concluded:
 * "We couldn't detect OAuth metadata from this MCP URL."
 *
 * Returned only for tool calls that genuinely need a credential — see
 * `toolAuth.ts`. `initialize`, `tools/list` and `search_docs` answer anonymously
 * so that a person who has never heard of Dreambooth can still ask what
 * hardware they need, which is what the directory listing promises.
 */
export function resourceMetadataUrl(config: Config, req: express.Request): string {
  const host = config.publicHost;
  // The path-suffixed form, RFC 9728 §3.1: the resource lives at /mcp, so its
  // metadata lives at /.well-known/oauth-protected-resource/mcp. Clients derive
  // this URL themselves and compare, so pointing at the bare path here while
  // they look at the suffixed one is a mismatch that reads as "no metadata".
  return `https://${host}/.well-known/oauth-protected-resource/mcp`;
}

export function sendUnauthorized(
  res: express.Response,
  config: Config,
  req: express.Request,
  options: { error?: string; description: string; id?: unknown }
): void {
  const { error = "invalid_token", description, id = null } = options;

  res
    .status(401)
    .set(
      "WWW-Authenticate",
      // `scope` is the second way a client learns what it may ask for, and for
      // some clients the only one — not every client fetches the resource
      // metadata document before building its authorization request. Omitting
      // it while the tools that need `booths:write` are registered is how a
      // connector ends up with a token that can only ever be refused.
      `Bearer realm="dreambooth", error="${error}", error_description="${description.replace(
        /"/g,
        "'"
      )}", scope="${SCOPE_STRING}", resource_metadata="${resourceMetadataUrl(config, req)}"`
    )
    // A JSON-RPC body as well as the status line: a client that handles the 401
    // uses the header, and one that does not at least surfaces a sentence
    // instead of an empty response.
    .json({
      jsonrpc: "2.0",
      error: { code: -32001, message: description },
      id: id ?? null,
    });
}
