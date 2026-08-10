# dreambooth-mcp

MCP server for Dreambooth Studio. Lets ChatGPT, Claude and Gemini answer an
operator's questions about their own booths — "how did my Bandung booth do this
week?" — by wrapping the Studio API the dashboard already uses.

**Status: Phase 1, not yet deployed.** Streamable HTTP + stdio, eight read-only
tools, and account connection through the Studio's existing OAuth device flow.
Railway config is in place; the deploy waits on the `mcp.dreamboothstudio.com`
subdomain.

Design: [`docs/dreambooth-mcp-design.md`](../dreambooth-prod/docs/dreambooth-mcp-design.md)
in the Studio repo.

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
npm run inspect           # stdio smoke: handshake, tools/list, every tool
npm run inspect:http      # HTTP smoke: sessions, isolation, unknown-session 404
```

Both smokes run without a token. `search_docs` needs no auth, and the authed
tools must come back with a readable message naming `connect_account` rather
than crashing — that failure path is part of what the checks verify.

## Connecting an account

Over HTTP there is no token to paste. The operator asks their assistant to
connect; `connect_account` starts the device flow the Studio already runs for
the Electron booth and returns a Google link for them to open. The tool returns
immediately and polls in the background — a tool call that blocks for minutes
reads as a hung server to every MCP client, and by the time they ask their next
question the token is in place.

Tokens are held **in memory, per MCP session**. A restart means everyone
reconnects, which is the right trade for v1: there is no credential store to
protect, and the token is session-equivalent (one year, no scopes, no
revocation). Hardening — scopes, a token registry, revocation, 30-day TTL — is
Phase 3, before any public connector listing.

## Deploy

Railway, following the `dreambooth-whatsapp` recipe: `railway.json` with
`npm run build` / `npm start`, healthcheck on `/health`, restart ON_FAILURE. No
Dockerfile, no CI, and no volume — this service is stateless.

Set `DREAMBOOTH_API_URL` and `ALLOWED_HOSTS`; leave `DREAMBOOTH_TOKEN` unset.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dreambooth": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/absolute/path/to/dreambooth-mcp",
      "env": { "DREAMBOOTH_TOKEN": "…" }
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

That is the complete v1 read set.

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
- Do not copy `dreambooth-whatsapp`'s habit of committing `.env`. The token here
  belongs to an operator's account.
