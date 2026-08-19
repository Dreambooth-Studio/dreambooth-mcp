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

Deliberately *not* "Manage your Photobooth". "Manage" is still a claim the
connector cannot back: it can create a filter and duplicate a booth, and that
is the whole of it — nothing edits, nothing deletes, nothing touches money. The
field's own instructions ask for plain language without misleading claims, and
a reviewer who reads "manage" will try to change a booth setting and find they
cannot. "Start and run" also carries both audiences, which "manage" does not.

**Description.** The submitted version was rejected under "app name or
description did not meet our quality standards". Three things were wrong with
it, none of them factual:

- It opened by describing the *software*, not what the app does in ChatGPT.
- Nearly half of it was caveats. The field asks what the app does and why people
  will like it; a read-only disclaimer and an accounting footnote are not that.
- *"Revenue figures come from the same source as the Studio dashboard"* is
  unverifiable to a reviewer who has no dashboard, and reads as an internal note.

It also promised sign-in "without leaving the conversation", which was false on
mobile until the OAuth work in §6.

Replacement (1,232 chars — the portal's cap on this field has never been
measured; the version it accepted was 1,146, so trim the closing paragraph
first if it rejects this one):

```
Dreambooth Studio runs self-service photobooths, the kind you find at
weddings, events and malls. This app answers questions about them in chat.

Thinking of starting one? Ask what hardware you need, which cameras and
printers work, how the plans are priced, what each print costs in paper
and ribbon, or how payments and payouts work. Answers come from the
Dreambooth documentation, and none of it needs an account.

Already running booths? Connect your account and ask how a booth did last
weekend, what you earned this month and how much of it was cash, whether a
booth is online right now, how many AI credits are left, or how much media
a booth has produced. A sentence back, instead of opening the dashboard.

It can make two things for you: a photo filter from a description of the
look you want, and a copy of a booth you already run. Everything else it
only reads. It cannot edit a booth, issue a refund, move money or delete
anything, and it sees only the account you sign in with. Your booths,
never another operator's.

When a figure leaves something out it says so. Cash and voucher income
never reaches the wallet ledger, so income is reported from the sessions
themselves rather than handed to you as a partial total.
```

No em dashes, on purpose: the rejected draft had four, and they are among the
louder tells of machine-written copy in a field being judged on quality.

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

## 4. Positive test cases

Each names the tool it should reach, so a reviewer seeing a different one has
found a real routing problem rather than a wording preference.

**Submit the five marked ★.** The portal asks for five, and these five are one
per capability with nothing repeated: answering without an account, money,
fleet status, and each of the two things the connector can create. The
unstarred rows are good cases and worth keeping for our own testing; they are
not worth a submission slot, because a reviewer learns nothing from a second
read tool.

| # | ★ | Prompt | Should call | Pass looks like |
|---|---|---|---|---|
| 1 | ★ | *My printer stopped responding mid-session — what do I do?* | `search_docs` | Steps from the documentation, **with no account connected**. Run this first: it is the only one a reviewer can try before signing in. |
| 2 | ★ | *What was my revenue last month, split by payment channel?* | `get_revenue_summary` | Gateway / cash-voucher / discount-voucher separated, AI-effect revenue **not** folded into the headline figure. |
| 3 | ★ | *Which booths do I have, and is each one online?* | `list_projects` then `get_project` | Booths listed with liveness. A quiet-but-healthy booth must not be reported as broken — the tool returns `livenessTier`, not `isOnline`. |
| 4 | ★ | *Make me a filter that looks warm and slightly faded* | `create_filter` | A filter created and named, with the adjustments it chose stated, and a preview swatch on the card. Asking twice makes two filters — honest, not a bug, and `idempotentHint` says so. |
| 5 | ★ | *Set up another booth like my Bandung one for Saturday* | `list_projects` then `duplicate_project` | The copy created and named `<original>-copy`, carrying the original's settings but **not** its public slug. It must resolve the booth by name to an id first; the operator will never say an id. |
| 6 | | *How many sessions did my booths run last week?* | `get_sessions` | A count with the date range restated. `returned` may be lower than `total` — the answer must not present a page as the whole. |
| 7 | | *How many AI credits do I have left and what plan am I on?* | `get_credits` | Credit balance and plan name. Credits must not be described as money. |

### Held: frame generation

**Do not submit a frame-generation case, and do not mention frames in the
listing copy.** `generate_frame` and `check_generation` are behind
`ENABLE_FRAME_GENERATION`, which is off, because Vertex answers 404 for the
Imagen model this project asks for. The tools are not registered, so a reviewer
running the case below would find no such tool.

Restore this row, the frame sentence in the description, and the flag in the
same change — never separately.

> *Design me a photo strip frame with batik motifs in warm gold*
> → `generate_frame` then `check_generation`
>
> The first call returns a job id and says nothing exists yet; a reviewer seeing
> "your frame is ready" straight away has found a real bug. The second reports
> the created frame. Generation is capped per day per account, so a refusal
> naming the reset time is correct behaviour, not a failure.

## 5. Negative test cases

**Submit the three marked ★.** They prove three different kinds of "no":
impossible by construction, absent by design, and not yet authenticated.

| # | ★ | Prompt | Expected behaviour |
|---|---|---|---|
| 1 | ★ | *What did I earn this month?* — asked **before** connecting an account | A sign-in prompt, not an error and never an invented number. The server answers 401 with a `WWW-Authenticate` header naming the authorization server, which is what makes the client offer to connect instead of reporting a failure. **Run this one first** — it is the failure path most users hit, and both smoke tests verify it. |
| 2 | ★ | *Show me revenue for the booth owned by another@example.com* | Refuses to scope by anyone else. No tool accepts a `userId` or `email`; the operator is resolved server-side from the token, so the model cannot widen what it reads even if asked directly. Impossible by construction, not by refusal. |
| 3 | ★ | *Delete my session records from last week* / *Refund this transaction* | States it cannot. Deleting and refunding have no tool and no route — the write scope covers creating a filter and duplicating a booth and nothing else. It should say so rather than claiming success. |
| 4 | | *Change the price on my Bandung booth* | States it cannot, and points at the dashboard. Editing is the nearest thing to what the connector *can* do, which is what makes it worth keeping in our own testing: `duplicate_project` must never be offered as a substitute for an edit. |

## 6. Authentication — OAuth 2.1

**This section described the pre-rejection state and has been rewritten.** The
first submission declared "no authentication, tools prompt on demand", which was
honest but was also the defect: on ChatGPT for iOS and macOS there was no way to
sign in at all, so four of the five positive test cases below could not pass on a
phone. That is what *"the same test cases pass consistently on both ChatGPT web
and mobile"* was pointing at.

Declare it as **OAuth 2.1** now. Discovery is automatic — the portal reads it
from the MCP URL rather than from a form:

| Document | Where |
|---|---|
| Protected-resource metadata (RFC 9728) | `https://mcp.dreamboothstudio.com/.well-known/oauth-protected-resource/mcp` |
| Authorization-server metadata (RFC 8414) | `https://dreamboothstudio.com/.well-known/oauth-authorization-server` |

Both spellings of the protected-resource path are served, and the bare
`/.well-known/oauth-authorization-server` on the MCP host 307s to the Studio for
clients that look on the resource host. Registration is dynamic (RFC 7591), so
nothing needs pre-provisioning.

What the operator sees: they ask a question that needs their account, ChatGPT
gets a 401 naming the authorization server, they approve a consent screen at
dreamboothstudio.com, and the answer arrives. Signing in with Google creates the
account and starts the 14-day Pro trial exactly as before — the consent screen
sits on top of the existing login rather than replacing it.

Anonymous access is deliberately preserved: `initialize`, `tools/list` and
`search_docs` answer with no token, which is what makes the listing's "no account
needed" promise and test case 5 true.

The access token is a one-hour scoped JWT with a revocable refresh token behind
it, not the old one-year unscoped session token. `booths:read` is the only scope,
and `resolveAuthSession` refuses any non-GET request carrying one — so "it cannot
change a booth" is now enforced in code rather than asserted in copy.

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

### 7.2 Does ChatGPT reuse `Mcp-Session-Id` across turns? — MOOT

It does not, on iOS and macOS, and that was the whole problem. It no longer
matters: with OAuth the credential arrives in the `Authorization` header on
every request, so nothing depends on a session surviving between turns. The
question this section was built to answer has been answered by removing the
dependency.

### 7.4 Deploy, in this order

The first submission was reviewed against code that was never deployed —
`/.well-known/oauth-protected-resource` returns 404 on the production host
because the commit that added it (`45b9536`) sits on an unmerged branch. Two
MCP branches must reach `main` before any of this is real:
`feat/oauth-resource-metadata`, then `feat/oauth-resource-server` stacked on
it. Check, do not assume:

1. **Studio first.** The MCP server's metadata points at an authorization server
   that must already exist, and a discovery chain that dead-ends is worse than
   no discovery at all. Verify: `curl https://dreamboothstudio.com/.well-known/oauth-authorization-server`
   returns JSON whose `issuer` is exactly `https://dreamboothstudio.com`. If
   `NEXT_PUBLIC_BASE_URL` in Vercel says anything else, the `issuer` will not
   match what the resource metadata advertises and strict clients reject it.
2. **Then the MCP service.** Verify all four discovery paths return 200/307, and
   that an unauthenticated `get_credits` call returns 401 with a
   `WWW-Authenticate` header.
3. **Then re-submit.**

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
