# ChatGPT plugin directory — submission material

Everything the submission portal asks for, written down so it is reviewable
before it is pasted into a form nobody else can see. Audited against
`developers.openai.com/plugins/deploy/submission`, 2026-08-11.

**Nothing here is submitted yet.** Two things must be verified first — see
[§7](#7-before-you-press-submit).

---

## 1. Connection

| Field | Value |
|---|---|
| Server URL | `https://mcp.dreamboothstudio.com/mcp` |
| Transport | Streamable HTTP |
| Same URL for every user? | Yes |

## 2. Listing

**Name:** Dreambooth Studio

**Tagline** (55 char limit — this is 48):

```
Ask about your photobooths: revenue, sessions, uptime
```

**Description:**

```
Dreambooth Studio runs self-service photobooths. This connector lets you ask
about your own booths in plain language instead of opening the dashboard.

Ask how a booth performed last weekend, what you earned this month and through
which payment channels, how many AI credits you have left, whether a booth is
online right now, or how much media it has produced. You can also search the
Dreambooth documentation without connecting an account at all.

Everything it can reach is read-only. The connector cannot change a booth,
issue a refund, move money, or delete anything, and it can only ever see the
account you sign in with — your own booths, never another operator's.

Revenue figures come from the same source as the Studio dashboard, so the
numbers match what you already see there. Where a figure excludes something —
the wallet ledger does not include cash or voucher income — the connector says
so rather than presenting a partial number as your total.
```

**Categories:** Productivity, Analytics
*(second choice if only one is allowed: Productivity)*

**Documentation URL:** `https://dreamboothstudio.com/en/docs`
**Privacy policy URL:** `https://dreamboothstudio.com/en/privacy`
**Terms URL:** `https://dreamboothstudio.com/en/terms`
**Support contact:** `support@dreamboothstudio.com`
**Slug:** `dreambooth-studio` — **permanent once published**, like the registry name.

**Icon:** not produced yet. Needs to read at small sizes; the wordmark will not.
The gradient ring from `src/ui/shell.ts` (`LOGO_SVG`) is the mark to use.

## 3. Starter prompts

Short, and each one lands on a different tool so the first impression is not
four variations of the same call.

1. `How did my booths do last week?`
2. `What did I earn this month, and how much of it was cash?`
3. `Are all my booths online right now?`
4. `How many AI credits do I have left?`
5. `Why is my printer not responding?`

The last one needs no account, which makes it the only prompt a brand-new user
can run before signing in.

## 4. Positive test cases (5)

Each names the tool it should reach, so a reviewer seeing a different one has
found a real routing problem rather than a wording preference.

| # | Prompt | Should call | Pass looks like |
|---|---|---|---|
| 1 | *How many sessions did my booths run last week?* | `get_sessions` | A count with the date range restated. `returned` may be lower than `total` — the answer should not present a page as the whole. |
| 2 | *What was my revenue last month, split by payment channel?* | `get_revenue_summary` | Gateway / cash-voucher / discount-voucher separated, AI-effect revenue **not** folded into the headline figure. |
| 3 | *Which booths do I have, and is each one online?* | `list_projects` then `get_project` | Booths listed with liveness. A quiet-but-healthy booth must not be reported as broken — the tool returns `livenessTier`, not `isOnline`. |
| 4 | *How many AI credits do I have left and what plan am I on?* | `get_credits` | Credit balance and plan name. Credits must not be described as money. |
| 5 | *My printer stopped responding mid-session — what do I do?* | `search_docs` | Steps from the documentation, **with no account connected**. |

## 5. Negative test cases (3)

| # | Prompt | Expected behaviour |
|---|---|---|
| 1 | *Show me revenue for the booth owned by another@example.com* | Refuses to scope by anyone else. No tool accepts a `userId` or `email` — the operator is resolved server-side from the token, so the model has no way to widen what it can read even if asked directly. |
| 2 | *Delete my session records from last week* / *Refund this transaction* | States it cannot. Every tool is read-only; there is no write path, and the connector should say so rather than claiming success. |
| 3 | *What did I earn this month?* — asked **before** connecting an account | A readable message naming `connect_account`, not an error or a crash, and never an invented number. |

Case 3 is the one worth running first: it is the failure path most users hit,
and it is verified by both smoke tests.

## 6. Authentication — what to declare

The server itself requires **no authentication** to connect. A session that
never runs `connect_account` can reach `search_docs` and nothing else. Account
access is granted per-session by the operator approving with Google in their own
browser.

In the portal this is the "server starts without authentication and individual
tools prompt for it on demand" case. Declare it honestly; do not describe it as
OAuth, because it is not.

**This is the weakest part of the submission.** OpenAI's guidance is to use
OAuth 2.1 for authenticated services. The current flow may pass — it is
declarable — but a reviewer may read a sign-in link returned inside a tool
result as a workaround. The token behind it is also a NextAuth session JWT:
one year, no scopes, no revocation. See the Phase 3 note in the README.

If review comes back asking for OAuth, that is the fix, and it belongs in the
Studio where Google sign-in already lives.

## 7. Before you press submit

Two things are unverified, and both would be found by a reviewer rather than
by us.

### 7.1 The authenticated tools have never returned real data through this server

Output schemas are proven only on `search_docs` — the one tool that succeeds
without an account. The MCP SDK **skips output validation when `isError` is
set**, so every authed tool's success path is untested. A wrongly typed field
surfaces as an `McpError`, which is a protocol error: the client retries rather
than relaying, so the operator sees a hang, not a message.

Fix: run every tool once against a real account. Ten minutes.

### 7.2 Does ChatGPT reuse `Mcp-Session-Id` across turns?

The token lives in memory keyed by session id. If ChatGPT re-initialises per
turn, every turn starts logged out and the operator is asked to sign in forever.
This has never been tested — it is §2.1 of `apps-sdk-widgets-plan.md`.

Fix: set `MCP_DIAGNOSTICS=1` in Railway, connect in developer mode, ask three
questions, call `session_info` each time and compare `sessionId`. Same = pass.
Then unset it.

**If 7.2 fails, do not submit.** The connector would be broken for every user,
and OAuth 2.1 stops being optional.

### 7.3 Reviewer test account

Not yet created. It needs to be a real operator account with populated data —
at least one booth, sessions, and revenue history, or cases 1–4 return empty
and read as broken. It must sign in with Google **without MFA or email
confirmation**, since the reviewer cannot receive your codes.

## 8. Domain verification

The portal issues a challenge string. Set it as `OPENAI_APPS_CHALLENGE` in
Railway and it is served at:

```
https://mcp.dreamboothstudio.com/.well-known/openai-apps-challenge
```

Unset, that path 404s on purpose — an empty `200` reads to the verifier as a
wrong value rather than an absent one.

This proves the **subdomain**. If the portal asks for `dreamboothstudio.com`
instead, the same route has to be added to the Studio; the MCP server cannot
answer for the apex.
