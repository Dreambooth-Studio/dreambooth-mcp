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

**Subtitle** — the real portal limit is **30 characters**, not the 55 assumed
from the docs. This is 26:

```
Start and run a photobooth
```

Deliberately *not* "Manage your Photobooth". Every tool is read-only; there is
no write path at all. "Manage" is a claim the connector cannot back, and the
field's own instructions ask for plain language without misleading claims — a
reviewer who reads "manage" will try to change a booth setting and find they
cannot. "Start and run" also carries both audiences, which "manage" does not.

**Description** (1,184 chars):

```
Dreambooth Studio is software for running self-service photobooths — the kind you
find at weddings, events and malls.

Thinking about starting one? Ask what hardware you need, how the pricing and plans
work, what a booth costs to run, or how printing and payments are handled. No
account needed for any of that. When you're ready, you can connect and start a
14-day Pro trial without leaving the conversation.

Already running booths? Ask how a booth did last weekend, what you earned this
month and which payment channels it came through, whether a booth is online right
now, how many AI credits you have left, or how much media a booth has produced —
instead of opening the dashboard to look.

Everything it can reach is read-only. It cannot change a booth, issue a refund,
move money, or delete anything, and it only ever sees the account you sign in
with — your own booths, never another operator's.

Revenue figures come from the same source as the Studio dashboard, so the numbers
match what you already see there. Where a figure leaves something out — the wallet
ledger doesn't include cash or voucher income — it says so, rather than presenting
a partial number as your total.
```

**Two audiences, on purpose.** An earlier draft addressed existing operators
only, which undersold the connector as an acquisition channel and is not what
the code does. Paragraph 2 is factual, not marketing: `search_docs` genuinely
requires no account and its own description names pricing, packages and
hardware, and the trial claim is `connect_account`'s own wording — *"approving
creates one, with a 14-day Pro trial"*.

**Categories:** Productivity, Analytics
*(second choice if only one is allowed: Productivity)*

### URLs

**Check all four return 200 immediately before submitting.** A reviewer clicks
every one of them, and a 404 on the support link is a straightforward rejection.

| Portal field | Value |
|---|---|
| Website URL | `https://dreamboothstudio.com` |
| Customer support URL | `https://dreamboothstudio.com/en/docs/getting-started/contact-support` |
| Privacy policy URL | `https://dreamboothstudio.com/en/privacy` |
| Terms of Service URL | `https://dreamboothstudio.com/en/terms` |

The support URL is the one with a history, and the only one that has ever 404'd.
Nothing public existed when this doc was first written — `/en/contact`,
`/contact` and `/en/support` all bounce to `/login`, which is the wrong answer
for a field whose entire purpose is "how does someone who cannot sign in get
help". dreambooth#560 published it.

Do **not** point this field at the site's contact form: per the published-claims
audit, that form emails nobody. The docs page gives WhatsApp and email directly
and sidesteps it.

**Documentation URL:** `https://dreamboothstudio.com/en/docs`
**Support email:** `support@dreamboothstudio.com` — now the only address in the
privacy policy too; the Indonesian copy used to give a personal gmail account.
**Slug:** `dreambooth-studio` — **permanent once published**, like the registry name.

**Icon:** not produced yet. Needs to read at small sizes; the wordmark will not.
The gradient ring from `src/ui/shell.ts` (`LOGO_SVG`) is the mark to use.

## 3. Starter prompts

Each lands on a different tool, so the first impression is not four variations
of the same call.

1. `What hardware do I need to start a photobooth business?`
2. `How much does Dreambooth cost, and what's in each plan?`
3. `How did my booths do last week?`
4. `What did I earn this month, and how much of it was cash?`
5. `Are all my booths online right now?`

**The first two run without an account** — both are `search_docs`. That ordering
is deliberate: a prospective user who taps a starter prompt and is immediately
told to sign in is the fastest way to lose them. An earlier draft led with four
operator questions and buried the only openable one at position five.

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
