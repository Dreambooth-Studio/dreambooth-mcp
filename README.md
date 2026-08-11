# dreambooth-mcp

MCP server for Dreambooth Studio. Lets ChatGPT, Claude and Gemini answer an
operator's questions about their own booths — "how did my Bandung booth do this
week?" — by wrapping the Studio API the dashboard already uses.

**Status: Phase 1, not yet deployed.** Streamable HTTP + stdio, eight read-only
tools, and account connection through the Studio's existing OAuth device flow.
Railway config is in place; the deploy waits on the `mcp.dreamboothstudio.com`
subdomain.

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

Tokens are held **in memory, per MCP session**. A restart means everyone
reconnects, which is the right trade for v1: there is no credential store to
protect, and the token is session-equivalent (one year, no scopes, no
revocation). Hardening — scopes, a token registry, revocation, 30-day TTL — is
Phase 3, before any public connector listing.

## Deploy

Railway, following the `dreambooth-whatsapp` recipe: `railway.json` with
`npm run build` / `npm start`, healthcheck on `/health`, restart ON_FAILURE. No
Dockerfile, no CI, and no volume — this service is stateless.

Set `DREAMBOOTH_API_URL` and `ALLOWED_HOSTS`. There is no token to configure.
Leave `MCP_DIAGNOSTICS` unset in production — see the tools section.

### Claude Desktop

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

## Tools (v1 read-only)

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

That is the complete v1 read set. Two more tools exist that wrap nothing:
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
`resolveAuthSession` (POST/PUT/DELETE deliberately still do not), and
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
   auto-approve them. A write tool must not.
5. Failures go back as `isError` content with a sentence the model can relay —
   never a protocol error, which just makes clients retry.

## Notes

- **stdout is the transport.** A single `console.log` corrupts the stream and the
  client drops the connection with a parse error. Diagnostics go to stderr.
- Do not copy `dreambooth-whatsapp`'s habit of committing `.env`. Nothing secret
  belongs in it here, and the surest way to keep that true is to never start.
