---
name: mcp-directory-submit
description: Prepare and submit an MCP server to the ChatGPT plugin directory or the Anthropic Connectors Directory — tool annotations, output schemas, listing copy and field limits, domain verification, starter prompts, positive and negative test cases, and the pre-submit gates that stop a review being wasted. Use when asked to list, publish, submit, or get an MCP server into ChatGPT or Claude's directory, when a submission form field is unclear, or when a portal rejects a server for missing annotations.
---

# Submitting an MCP server to a public directory

Two different directories, two different portals, one shared truth: **they are not the MCP Registry.** Publishing to `registry.modelcontextprotocol.io` does not feed either. See `mcp-registry-publish` for that.

## Hard gates — check these before any other work

| Directory | Gate |
|---|---|
| **ChatGPT** | Verified developer or business identity on the OpenAI Platform, plus Apps Management write access |
| **Anthropic** | A **Team or Enterprise** organization — the portal lives in admin settings, absent on individual plans |

Both need a **public HTTPS privacy policy URL**. A missing or incomplete one is an automatic rejection at both. Check it is genuinely public: policies that live only inside a signup modal, or that redirect to `/login`, do not count. Fetch every URL you plan to submit and confirm `200` without a session.

## Every tool needs all three annotations

```ts
{ readOnlyHint: boolean, destructiveHint: boolean, openWorldHint: boolean }
```

The MCP spec treats `destructiveHint` as meaningful only when `readOnlyHint` is false. **The ChatGPT portal disagrees and rejects any tool missing any of the three.** Set all three on every tool, including read-only ones.

`absent` and `false` look identical to a person and mean different things to a form. Only one of them is a claim.

Also required: a `title` on every tool, and `outputSchema` on every tool for ChatGPT.

## Justifying the annotations

The portal asks you to explain each value **per tool**. Write from what the tool actually does. Ten identical sentences teach a reviewer nothing and invite scrutiny.

- **Read Only: True** — name the single read it performs and the mutations it cannot do.
- **Read Only: False** — say exactly what state changes, and why that is not destructive.
- **Open World: False** — name the one host and endpoint. If identity is resolved server-side from a token rather than passed as an argument, say so: it makes "cannot reach another account" structural rather than a promise.
- **Destructive: False** — list the specific verbs it cannot perform (cancel, refund, delete, deactivate), not a generic "it is safe".

The strongest argument is architectural. If the upstream API accepts the connector's credential **only on `GET`** and requires a browser session for writes, then a write is impossible even from a future tool that tried. Verify that before claiming it, and scope the claim to the routes it is true of.

## Listing fields — verify limits against the form, not the docs

Published docs and the live form disagree. Measure with code, never by eye:

```js
[...subtitle].length   // ChatGPT subtitle: 30 max, NOT the 55 the docs imply
[...description].length
```

**Do not describe capability the server lacks.** "Manage your X" on a read-only connector fails the form's own instruction to avoid misleading claims, and a reviewer will try to change something and find they cannot.

**Write for every audience the server actually serves.** If any tool works without an account, prospective users are a real audience — say what they can ask before signing up. Ordering starter prompts so the first ones need no account matters: a prompt that immediately demands sign-in is the fastest way to lose someone.

The URL slug is usually **permanent once published**. Treat it like a domain.

## Test cases

Five positive, three negative for ChatGPT. Name the tool each prompt should reach, so a reviewer landing elsewhere has found a routing bug rather than a wording preference.

Good negative cases prove refusals that matter:

1. Ask for another user's data — should be impossible by construction, not by refusal
2. Ask for a deletion or refund — must decline, not fake success
3. Ask a question before connecting — must name the connect tool, never invent a number

## Domain verification (ChatGPT)

The portal issues a token to be served at an origin-root well-known URL on the **MCP hostname** — leave the challenge base blank and it uses that host, so a subdomain route is enough and the apex is not needed.

Serve it from an environment variable, and **404 when unset** rather than returning an empty `200`: an empty body reads to the verifier as a *wrong* token and to you as a broken route. Trim the value; it is pasted from a web form and a trailing newline fails verification with nothing visibly wrong.

## A green scan means less than it looks

The portal's "Scan Tools" reads `tools/list` — **metadata only. It never calls a tool.** It will report a healthy inventory while the tools themselves are broken.

Re-scan after any change to annotations or schemas; the portal keeps whatever it captured last.

## Pre-submit gates

Do not submit until:

1. **Every authenticated tool has returned real data at least once.** See `mcp-verify`. Unauthenticated smoke tests cannot verify authenticated tools, and the SDK skips output validation on error paths.
2. **The upstream API the tools wrap is actually deployed.** Check the routes are on `main`, not in someone's working tree.
3. **Session behaviour is confirmed with the real host.** If tokens are held per MCP session in memory, verify the host reuses its session id across turns. If it re-initialises per turn, every turn starts logged out and the connector is broken for everyone — that is an OAuth-or-nothing decision, not a detail.
4. **A reviewer test account exists**, populated with real data, signing in **without MFA or email confirmation** — the reviewer cannot receive the codes. An empty account makes working tools look broken.
5. Every submitted URL returns `200`.

## Authentication

If the server starts unauthenticated and individual tools prompt for sign-in on demand, both portals let you declare that. **Declare it honestly; do not call it OAuth.**

Be clear-eyed that it is the weakest part of such a submission: guidance from both vendors points at OAuth 2.1, and a sign-in link returned inside a tool result can read as a workaround. If the underlying credential is long-lived, unscoped and unrevocable, expect that to come up.
