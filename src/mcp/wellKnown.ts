import type express from "express";
import type { Config } from "../config.js";
import { SUPPORTED_SCOPES } from "../auth/scopes.js";

/**
 * Discovery. Everything a client reads BEFORE it has a token.
 *
 * These routes are why the ChatGPT submission portal said "We couldn't detect
 * OAuth metadata from this MCP URL". A client does not guess that a server
 * supports OAuth; it follows a fixed chain of documents, and any missing link
 * ends with the connector classified as unauthenticated:
 *
 *   1. a 401 whose WWW-Authenticate names the resource metadata URL
 *   2. that document, which names the authorization server
 *   3. the authorization server's own metadata, on the Studio
 *
 * Registered ahead of the body parser and the transport, for the same reason
 * /health is: nothing about MCP or sessions should be able to break discovery.
 */

/**
 * Both spellings of the protected-resource document.
 *
 * RFC 9728 §3.1 inserts the resource's path into the well-known URL, so a
 * resource at `https://host/mcp` publishes at
 * `/.well-known/oauth-protected-resource/mcp`. Clients construct that URL
 * themselves. Only the bare path existed before, which is a 404 for every
 * client that follows the RFC — the document was written and then published
 * where nothing looks for it.
 *
 * The bare path is kept alongside it because some clients still request it, and
 * a spare route costs nothing next to a failed connection.
 */
const PROTECTED_RESOURCE_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];

/**
 * Where a legacy client looks for the authorization server: on the resource
 * host rather than on the issuer. Redirected rather than mirrored, deliberately.
 *
 * Serving the Studio's document from this host would publish a metadata
 * document whose `issuer` does not match the URL it came from, and RFC 8414 §3
 * requires a client to REJECT exactly that. A redirect sends the client to the
 * real issuer, where the document validates.
 */
const AUTH_SERVER_ALIAS_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
];

function resourceUrl(config: Config, req: express.Request): string {
  return `https://${config.publicHost}/mcp`;
}

export function registerWellKnown(app: express.Express, config: Config): void {
  for (const path of PROTECTED_RESOURCE_PATHS) {
    app.get(path, (req, res) => {
      res.json({
        resource: resourceUrl(config, req),
        // The Studio. Users, Google sign-in and the account model live there; a
        // second identity system here would be one more thing to keep in sync.
        authorization_servers: [config.apiUrl],
        // Everything the Studio can grant, not everything it grants by default.
        // A client builds its authorization request from this list, so naming
        // only `booths:read` here is what would keep `booths:write` unreachable
        // no matter what the Studio supports. The operator still approves each
        // scope on a consent screen that names it.
        scopes_supported: SUPPORTED_SCOPES,
        bearer_methods_supported: ["header"],
        resource_name: "Dreambooth Studio",
        resource_documentation: "https://dreamboothstudio.com/en/docs",
      });
    });
  }

  for (const path of AUTH_SERVER_ALIAS_PATHS) {
    app.get(path, (_req, res) => {
      res.redirect(307, `${config.apiUrl}/.well-known/oauth-authorization-server`);
    });
  }
}
