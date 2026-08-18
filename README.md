# dreambooth-mcp

MCP server for Dreambooth Studio. Lets ChatGPT, Claude and Gemini answer an
operator's questions about their own booths — "how did my Bandung booth do this
week?" — by wrapping the Studio API the dashboard already uses.

**Status: Phase 1, live at `https://mcp.dreamboothstudio.com/mcp`.** Streamable
HTTP + stdio, eight read-only tools, two that create something, and account
connection through the Studio's existing OAuth device flow. Listed in the official MCP Registry as
[`com.dreamboothstudio/dreambooth`](https://registry.modelcontextprotocol.io/v0.1/servers?search=com.dreamboothstudio/dreambooth)
v0.1.0.

Phase 3 hardening has since **landed**, on the OAuth path: the Studio runs a
full OAuth 2.1 authorization server — PKCE S256 only, one-hour access tokens,
30-day refresh, dynamic client registration, RFC 8707 resource audience,
RFC 7009 revocation, and a CSRF-bound consent screen that names the scopes
being granted. This server is a protected resource in front of it (RFC 9728).
Both discovery documents are live.

The **device flow is the older path and keeps the older properties** — its
token is a year long, unscoped and unrevocable. That asymmetry is the reason
the two write tools are registered only on the OAuth path; see
[Connecting an account](#connecting-an-account).

Design: [`docs/dreambooth-mcp-design.md`](../dreambooth-prod/docs/dreambooth-mcp-design.md)
in the Studio repo. Inline cards in ChatGPT:
[`docs/apps-sdk-widgets-plan.md`](docs/apps-sdk-widgets-plan.md).

---

## What it does not do

This service holds **no database, no business logic, and no aggregations**. Every
tool wraps a route the Studio already exposes, so there is exactly one
implementation of "what is this operator's revenue" and it lives in the Studio.
The moment an aggregation is copied in here, it becomes a second source of truth
that drifts silently — which is how you end up with three different revenue
numbers and no way to tell which is right.

Also permanently out of scope: withdrawals, payout accounts, MFA/step-up,
subscription token regeneration, and anything under `/api/admin`.

## Run it

```bash
npm install
cp .env.example .env

npm run dev               # Streamable HTTP on PORT (default 8080)
npm run dev:stdio         # stdio, for Claude Desktop

npm run build
npm run inspect           # stdio smoke: handshake, tools/list, widgets, every tool
npm run inspect:http      # HTTP smoke: sessions, isolation, unknown-session 404
npm run preview           # writes each widget state to .preview/ to open in a browser
```

`inspect:http` runs `dist/`, so `npm run build` first or you are testing the last
build rather than your change.

Both smokes run without a token. `search_docs` needs no auth, and the authed
tools must come back with a readable message naming `connect_account` rather
than crashing — that failure path is part of what the checks verify.

## Connecting an account

**There is no token to configure, in either transport.** The operator asks their
assistant to connect; `connect_account` starts the device flow the Studio
already runs for the Electron booth and returns a Google link for them to open.
The tool returns immediately and polls in the background — a tool call that
blocks for minutes reads as a hung server to every MCP client, and by the time
they ask their next question the token is in place.

That includes local development. A pasted token would be a session-equivalent
credential (one year, no scopes, no revocation) sitting in a file on disk, and
in HTTP mode it would authenticate every incoming session as that one account.
Approving in a browser after a restart takes about fifteen seconds; that is the
whole cost of not having it.

Device-flow tokens are held **in memory, per MCP session**. A restart means
everyone reconnects, which is the right trade for that path: there is no
credential store to protect. The token itself is session-equivalent — one year,
no scopes, no revocation — and that has not changed.

What changed is that it is no longer the only way in. A client that arrives
with its own `Authorization: Bearer` is on the **OAuth path**, where the token
expires in an hour, carries a scope the operator approved by name, and can be
revoked at `/api/oauth/revoke`. Nothing is stored here on that path at all: the
credential belongs to the request that carried it and is never written into a
session, where a later request quoting the same session id could read it.

The two credentials are deliberately **not** equivalent in what they may do. The
write tools exist only on the OAuth path, and the Studio refuses a non-GET from
a device-flow token on any route that opted into connector writes — the weaker
credential must not inherit access granted to the stronger one. Everything the
booth fleet POSTs with that token is untouched.

Reading is unchanged on both: a session that never connects an account can read
nothing but `search_docs`.

## Deploy

Railway, following the `dreambooth-whatsapp` recipe: `railway.json` with
`npm run build` / `npm start`, healthcheck on `/health`, restart ON_FAILURE. No
Dockerfile, no CI, and no volume — this service is stateless.

Set `DREAMBOOTH_API_URL` and `ALLOWED_HOSTS`. There is no token to configure.
Leave `MCP_DIAGNOSTICS` unset in production — see the tools section.
`OPENAI_APPS_CHALLENGE` is set only while a directory submission is in flight —
see [`docs/chatgpt-listing.md`](docs/chatgpt-listing.md).

`ALLOWED_HOSTS` must list **both** public hostnames:

```
ALLOWED_HOSTS=mcp.dreamboothstudio.com,dreambooth-mcp-production.up.railway.app
```

Railway keeps serving its generated hostname after a custom domain is attached,
and DNS-rebinding protection is an allow-list, not a filter — naming only one
host makes the other return 400 on `/mcp`. `/health` keeps answering `ok` either
way, because it is registered ahead of the transport, so the healthcheck cannot
tell you this broke. Leaving the variable empty disables the protection entirely
rather than allowing everything through some safer path.

### Publishing to the registry

`server.json` is the registry manifest. **Entries cannot be unpublished and each
version is immutable** — a changed URL or a fixed typo means publishing a new
`version`, never editing the old one.

```bash
./mcp-publisher validate server.json    # checks against the live registry, publishes nothing
./mcp-publisher login dns --domain dreamboothstudio.com --private-key "$(openssl pkey -in key.pem -noout -text | grep -A3 priv: | tail -n +2 | tr -d ' :\n')"
./mcp-publisher publish
```

Always `validate` first; it is the only step in that sequence you can take back.

The `com.dreamboothstudio` namespace is proved by a TXT record on the **apex**
(`dreamboothstudio.com`, not the `mcp` subdomain), signed by `key.pem`. That file
is gitignored and lives on one machine. Losing it is recoverable — generate a new
Ed25519 pair and replace the TXT record. Leaking it is not: this repo is public,
and whoever holds it can publish under `com.dreamboothstudio/*` permanently.

### Connecting a client

The hosted server needs no install. In any client that accepts a remote MCP
server, point it at:

```
https://mcp.dreamboothstudio.com/mcp
```

### Claude Desktop

For running a local checkout — against a preview Studio, or a branch. To use the
deployed server, add the URL above instead; there is nothing to clone.

Add to `claude_desktop_config.json`. `--stdio` is required — the entry point
defaults to HTTP, and without it Claude Desktop starts a web server and waits
forever for a reply on stdin.

```json
{
  "mcpServers": {
    "dreambooth": {
      "command": "npx",
      "args": ["tsx", "src/index.ts", "--stdio"],
      "cwd": "/absolute/path/to/dreambooth-mcp",
      "env": { "DREAMBOOTH_API_URL": "https://dreamboothstudio.com" }
    }
  }
}
```

## Tools

| Tool | Wraps | Auth |
|---|---|---|
| `get_sessions` | `GET /api/sessions` | Bearer |
| `get_gallery_stats` | `GET /api/gallery` | Bearer |
| `search_docs` | `/docs-search-index-{locale}.json` | none |
| `list_projects` | `GET /api/projects` | Bearer |
| `get_project` | `GET /api/projects?id=` + `GET /api/device-monitoring` | Bearer |
| `get_revenue_summary` | `GET /api/me/revenue-summary` | Bearer |
| `get_credits` | `GET /api/credits` | Bearer |
| `get_wallet_transactions` | `GET /api/wallet-transactions` | Bearer |

That is the complete read set. Two more wrap a route that creates something:

| Tool | Wraps | Auth |
|---|---|---|
| `create_filter` | `POST /api/filters` | Bearer + `booths:write` |
| `duplicate_project` | `POST /api/projects?duplicate` | Bearer + `booths:write` |

**They are registered only when the request carries its own bearer token** —
that is, on the OAuth path. On stdio, and on a device-flow HTTP session, they
do not appear in `tools/list` at all. Writing requires a credential that
expires in an hour, carries a scope and can be revoked; the device flow's token
is one year, unscoped and unrevocable, and must not inherit access granted to
the other one. The Studio enforces the same rule independently — see
`utils/resolveAuthSession.ts` there, and [`docs/write-tools-plan.md`](docs/write-tools-plan.md)
for why the gate here cannot check the scope itself.

Nothing edits, nothing deletes, and nothing touches money. There is no `put` or
`delete` on `StudioClient`, and the Studio opened exactly two POST handlers.

Two more tools exist that wrap nothing:
`connection_status` (is this session authenticated — polled by the connect card)
and `session_info` (diagnostics, **temporary**, and registered only when
`MCP_DIAGNOSTICS=1`; delete it once the session-continuity question in the
widgets plan is answered).

Every tool carries a `title`, an `outputSchema`, and explicit `readOnlyHint` /
`destructiveHint` / `openWorldHint` annotations. That is not decoration: both
the Anthropic Connectors Directory and the ChatGPT plugin directory flag a tool
that is missing any of them, and `session_info` is gated off by default because
a listing is judged on its tool list and that one answers nothing an operator
asked.

Output schemas are deliberately **permissive** — every field the Studio owns is
optional. The SDK validates `structuredContent` against the schema and throws
`McpError` on a mismatch, which is a protocol error, and rule 5 below exists to
prevent exactly that. A Studio rename must degrade to a missing key, never to a
broken tool.

## Inline cards (ChatGPT)

`connect_account` renders a real card — a Google button that notices when the
operator has finished approving — instead of a URL they have to copy. It is an
MCP resource (`ui://widget/connect-account.html`) pointed at by `_meta` on the
tool, per the Apps SDK.

`create_filter` and `duplicate_project` share a second card,
`ui://widget/write-result.html`. It renders the result and nothing else: what
was created, a preview swatch for a filter, and a link to it in the dashboard.
There is no confirmation card and no form — a widget only renders after the
tool has already written, so confirming would need a second tool that writes
nothing, and the host's own approval dialog is the real gate. There is no
"undo" button either: undo means PUT or DELETE, which would widen the scope
from "create" to "change and delete" for one button.

The swatch is an inline SVG with a CSS `filter` applied, so the empty CSP below
still holds. It names the adjustments it cannot show — sharpening, noise
reduction, vignette, grain and every LUT have no CSS equivalent, and a swatch
that silently drops half a filter is worse than no swatch.

Nothing about this changes other clients. Every tool result carries the payload
twice: `structuredContent` for widgets, and the same object pretty-printed as
text `content` for Claude and Gemini, which render no widget. The text block is
what it always was.

Widgets are self-contained HTML with an **empty CSP on both domain lists**. That
is load-bearing: a card that cannot reach the network cannot leak the operator's
session token, and it never needs to, because all of its data arrives through
`callTool` on the server side. Keep it that way — inline any asset you need.

Design tokens are copied by hand into `src/ui/tokens.ts` from the Studio's
`tailwind.config.js`, because a sandboxed iframe has no Tailwind. That makes it a
second copy of the design system; when a brand colour moves, it moves there too.

`get_project` reports `livenessTier`, not the device's `isOnline` field.
`isOnline` is retained only for back-compat and collapses "quiet because it was
deliberately shut down" into "offline" — which is how a healthy fleet gets
reported as broken.

The first three needed no Studio change at all. The rest depend on Studio
work that has now landed: `GET` on `/api/projects`, `/api/credits` and
`/api/wallet-transactions` accepts `Authorization: Bearer` via
`resolveAuthSession` (PUT and DELETE deliberately still do not, and POST only
on the two routes named above, only for a token carrying `booths:write`), and
`GET /api/me/revenue-summary` is a new owner-scoped endpoint — `/api/analytics/revenue`
is superadmin-gated and returns 403 to an operator.

`get_wallet_transactions` and `get_revenue_summary` answer different questions
and their descriptions say so. The wallet ledger excludes cash and voucher
income entirely, so for an operator who takes cash it understates real revenue —
a model that reports it as "your earnings" is confidently wrong.

**Identity is never an argument.** No tool accepts a `userId` or `email` — the
operator is resolved server-side from the token, exactly as `lib/ai-chat` does in
the Studio. A tool that needs such an argument is designed wrong.

## Rules for adding a tool

1. It wraps an existing Studio route. If no route fits, add a thin one in the
   Studio — do not reimplement the query here.
2. The description says **when to call it**, not just what it returns. The model
   picks tools by description alone.
3. Return the smallest useful shape. `get_gallery_stats` returns counts, not 12
   media URLs, because the model does not need them and they cost context.
4. Read-only tools carry `annotations: { readOnlyHint: true }` so clients can
   auto-approve them. A write tool must not, and must also state
   `idempotentHint` — `create_filter` says `false`, because calling it twice
   makes two filters and a client that retries a timeout needs to know that.
5. **`ownerEmail` is not an argument.** The Studio's POST handlers accept it for
   the dashboard's collaborator path. A tool that forwards it hands the caller a
   way to write into somebody else's account, so tool bodies are built field by
   field rather than spread from `args`. The Studio refuses it from a bearer as
   well; both halves are deliberate.
6. Failures go back as `isError` content with a sentence the model can relay —
   never a protocol error, which just makes clients retry. For a write, relay
   the Studio's own message: "this connection is read-only, reconnect and
   approve permission to create things" names the button to press.

## Notes

- **stdout is the transport.** A single `console.log` corrupts the stream and the
  client drops the connection with a parse error. Diagnostics go to stderr.
- Do not copy `dreambooth-whatsapp`'s habit of committing `.env`. Nothing secret
  belongs in it here, and the surest way to keep that true is to never start.
