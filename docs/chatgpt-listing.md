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

## 4. Test cases

The portal asks for four fields per case — **Scenario**, **User prompt**,
**Tool triggered**, **Expected output** — so they are written in that shape
here. Copy them across as-is rather than re-deriving them into the form under
time pressure, which is how a case ends up naming a tool that does not exist.

Five positive and three negative is what the form takes. These are one per
capability with nothing repeated: answering without an account, money, fleet
status, and each of the two things the connector can create. Every case names
the tool it should reach, so a reviewer landing somewhere else has found a real
routing problem rather than a wording preference.

### Positive

**1. Get troubleshooting help without an account**

- **User prompt:** My printer stopped responding mid-session — what do I do?
- **Tool triggered:** `search_docs`
- **Expected output:** Troubleshooting steps drawn from Dreambooth's own
  documentation, returned with no account connected. This is the case that
  verifies product, pricing and hardware questions answer before sign-in.

**2. Review monthly revenue by payment channel**

- **User prompt:** What was my revenue last month, split by payment channel?
- **Tool triggered:** `get_revenue_summary`
- **Expected output:** A monthly total with gateway, cash voucher and discount
  voucher separated. AI-effect revenue is reported as its own figure, not
  folded into the headline total. If the account takes money in more than one
  currency, each is reported separately — there is no exchange rate in this
  data, so a combined figure would be meaningless.

**3. Check which booths are online**

- **User prompt:** Which booths do I have, and is each one online?
- **Tool triggered:** `list_projects`, then `get_project`
- **Expected output:** Every booth on the account with its current device
  status. A booth that is simply idle must not be reported as broken — the
  connector returns a liveness tier rather than a yes/no, because a booth
  between events is healthy.

**4. Create a photo filter from a description**

- **User prompt:** Make me a filter that looks warm and slightly faded
- **Tool triggered:** `create_filter`
- **Expected output:** A new photo filter created on the operator's account,
  named, with the specific adjustments it chose stated back, and a card showing
  a preview swatch. Nothing existing is modified. Calling it twice creates two
  filters — the tool declares itself non-idempotent, so a client should not
  retry it automatically.

**5. Duplicate an existing booth**

- **User prompt:** Set up another booth like my Bandung one for Saturday
- **Tool triggered:** `list_projects`, then `duplicate_project`
- **Expected output:** The booth is resolved by name to an id first, then
  copied. The copy is named after the original and carries its settings,
  packages and promos — but not its public address, so nothing already
  published is affected. The original is unchanged.

### Negative

These prove three different kinds of no: not yet authenticated, impossible by
construction, and absent by design.

**1. Ask an account question before signing in** — run this one first

- **User prompt:** What did I earn this month?
- **Tool triggered:** `get_revenue_summary` — attempted, and refused with 401
- **Expected output:** A prompt to sign in. Never an error, and never an
  invented figure. The server answers 401 with a `WWW-Authenticate` header
  naming where to authenticate, which is what lets the client offer to connect
  rather than report a failure.

**2. Request another operator's data**

- **User prompt:** Show me revenue for the booth owned by another@example.com
- **Tool triggered:** `get_revenue_summary` at most — and it returns only the
  signed-in operator's own data
- **Expected output:** It cannot scope to anyone else and says so. No tool
  accepts a user id or email; the account is resolved server-side from the
  access token. Impossible by construction, not declined by judgement.

**3. Ask for a deletion or a refund**

- **User prompt:** Delete my session records from last week
- **Tool triggered:** None — no tool matches
- **Expected output:** It states plainly that it cannot do either. There is no
  tool and no route for deleting or refunding; the connector's write permission
  covers creating a photo filter and duplicating a booth, and nothing else. It
  must say so rather than claim success.

### Kept out of the submission

Two cases are worth running ourselves and are not worth a slot.

*How many sessions did my booths run last week?* (`get_sessions`) and *How many
AI credits do I have left?* (`get_credits`) are a second and third read tool. A
reviewer learns nothing from them that cases 2 and 3 have not already shown.

*Change the price on my Bandung booth* is the near-miss negative: it must be
refused and pointed at the dashboard, and `duplicate_project` must never be
offered as a substitute for an edit. Worth keeping in our own testing.

### Held: frame generation

**Do not submit a frame-generation case, and do not mention frames in the
listing copy.** `generate_frame` and `check_generation` are behind
`ENABLE_FRAME_GENERATION`, which is off, because Vertex answers 404 for the
Imagen model this project asks for. The tools are not registered, so a reviewer
running the case below would find no such tool.

Restore this case, the frame sentence in the description, and the flag in the
same change — never separately.

> **Design a frame from a description**
> - **User prompt:** Design me a photo strip frame with batik motifs in warm gold
> - **Tool triggered:** `generate_frame`, then `check_generation`
> - **Expected output:** The first call returns a job id and says nothing exists
>   yet; a reviewer seeing "your frame is ready" straight away has found a real
>   bug. The second reports the created frame. Generation is capped per day per
>   account, so a refusal naming the reset time is correct behaviour, not a
>   failure.

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
