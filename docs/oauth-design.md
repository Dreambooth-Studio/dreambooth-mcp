# Half 2 — OAuth 2.1, and the end of session-held tokens

Status: **design**. Half 1 (stateless transport) shipped in dreambooth-mcp#8.
Audited against the MCP SDK in `node_modules` and the Studio at `main`,
2026-08-11.

## Why this is not optional

Two independent forces, either of which alone would be enough.

**ChatGPT already broke us.** iOS and macOS send no `Mcp-Session-Id` on
`tools/call`. Before #8 that produced `400 Bad Request: Server not initialized`
on every tool call — total failure on the operator's first question.

**The protocol is removing sessions.** MCP 2026-07-28:

> **SEP-2567** — "The `Mcp-Session-Id` header is removed and the spec language
> describing session lifecycle and session-scoped behavior is deleted."
> **SEP-2575** — "The `initialize`/`initialized` handshake is removed."
> "Rollout is a clean break: sessions are removed in the next spec version,
> with no deprecation window."

So the thing our auth is built on is being deleted. #8 stopped the crash but
cannot restore capability: with no session, there is nowhere for a token to
live, so every authenticated tool answers "not connected" forever on those
clients.

The replacement the SEP names is what OAuth already does:

> "servers validate `(handle, auth_context)` on every request"

## The shape

```
ChatGPT ──Connect──▶ Studio /oauth/authorize ──▶ Google ──▶ callback
   │                                                          │
   │◀──────────── code (PKCE) ────────────────────────────────┘
   │
   ├──▶ Studio /oauth/token ──▶ access_token (+ refresh_token)
   │
   └──▶ MCP  Authorization: Bearer <access_token>   on EVERY request
              │
              └─▶ requireBearerAuth → verify → tools call the Studio
```

The **Studio is the authorization server**. The **MCP server is only a resource
server**. That split matters: users, Google sign-in and the account model
already live in the Studio, and duplicating them here would create a second
identity system to keep in sync.

## What already exists

More than expected. The Studio has an authorization-code flow in all but name,
built for the Electron booth:

| Existing | Reuse |
|---|---|
| `/api/auth/desktop/google/authorize` | state creation, Google redirect |
| `/api/auth/desktop/google/callback` | Google round-trip |
| `/api/auth/desktop/google/exchange` | mints a token with `encode` from `next-auth/jwt` |
| `DesktopOAuthState` model | store PKCE challenge and client metadata alongside state |
| `resolveAuthSession` | already decodes tokens with the server secret → becomes `verifyAccessToken` |

The MCP SDK ships the rest:

| SDK | Gives |
|---|---|
| `server/auth/router.js` → `mcpAuthRouter()` | `/authorize`, `/token`, `/register`, `/revoke`, AS metadata |
| `server/auth/middleware/bearerAuth.js` → `requireBearerAuth({ verifier })` | per-request validation, attaches `AuthInfo` |
| `server/auth/providers/proxyProvider.js` | proxies to an upstream OAuth server |
| `getOAuthProtectedResourceMetadataUrl()` | the `/.well-known/oauth-protected-resource` pointer |

So this is mostly **adapting an existing flow to a standard**, not building an
identity system.

## Studio work

1. `GET /.well-known/oauth-authorization-server` — discovery.
2. `GET /api/oauth/authorize` — validate `client_id`, `redirect_uri`,
   `code_challenge` (S256 required by OAuth 2.1), `state`. Reuse the desktop
   flow's Google redirect. Persist the PKCE challenge with the state.
3. `POST /api/oauth/token` — `grant_type=authorization_code` with
   `code_verifier`; also `refresh_token`. Codes are single-use and short-lived.
4. `POST /api/oauth/register` — dynamic client registration. ChatGPT prefers
   DCR; a static client is the fallback if we want to avoid open registration.
5. `POST /api/oauth/revoke` — the revocation the README has owed since v1.

## MCP server work

Small, because #8 already routes sessionless requests through per-request auth:

1. `requireBearerAuth({ verifier })` on `/mcp`; read the token from `req.auth`
   instead of `bearerToken(req)`.
2. Serve `/.well-known/oauth-protected-resource` pointing at the Studio AS, so
   a 401 tells the client where to authenticate.
3. Return `WWW-Authenticate` on 401 — how a client knows to start the flow
   rather than showing the user an error.

## Token design — this is the Phase 3 debt

Today's token is a NextAuth session JWT: **one year, no scopes, no revocation**
(`auth.ts`, `maxAge: ONE_YEAR_SECONDS`). It has been the weakest point in every
directory submission draft.

Do **not** reuse it as the access token. Mint a distinct one:

| Property | Today | Proposed |
|---|---|---|
| Lifetime | 1 year | ~1 hour access, 30-day refresh |
| Scopes | none | at minimum `booths:read` |
| Revocable | no | yes — a token registry keyed by `jti` |
| Audience | the whole Studio | this MCP server (RFC 8707 `resource`) |

An operator disconnecting the connector in ChatGPT should actually revoke
access. Today it would not.

## What gets deleted

`connect_account`, `connection_status`, `session_info`, the connect-account
widget, `SessionTokens`, the idle sweep, and the stateful branch in `http.ts`.
All of it exists to work around not having OAuth.

Two consequences worth naming:

- The **connect card** is the only widget currently shipped. Losing it costs
  the Apps SDK work its sole visible surface — the widget plumbing survives,
  the card does not. A revenue or booth-picker card is the natural replacement.
- Operators stop being silently logged out by every deploy, because nothing
  lives in memory any more.

## Rollout

The stateful path stays until ChatGPT web moves, then is removed. Both already
coexist after #8. Order:

1. Studio AS behind a feature flag, exercised with a scripted client.
2. MCP resource-server changes; keep `connect_account` working for stateful
   clients during the overlap.
3. Verify with `.claude/skills/mcp-verify` — the sessionless path must now pass
   every authenticated tool, which is the acceptance test for this whole piece.
4. Delete the session machinery.
5. Resume the ChatGPT submission, declaring **OAuth** rather than "no auth".

## Open decisions

1. **Dynamic client registration, or a static client for ChatGPT?** DCR is what
   the clients expect; open registration on a public endpoint needs rate
   limiting and a cleanup policy.
2. **Access-token lifetime.** One hour is conventional; shorter means more
   refresh traffic against the Studio.
3. **Scopes.** One `booths:read` scope is enough for a read-only connector, and
   splitting further before there is a write tool is speculative.
4. **Does the Electron booth migrate too?** It uses the same desktop flow. Not
   required by anything here, and worth deciding deliberately rather than by
   accident.
