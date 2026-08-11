---
name: mcp-verify
description: Verify a deployed MCP server actually works — handshake, tool inventory, annotations, output schemas, widget resources, refusal paths, and whether the authenticated tools return real data. Use before publishing an MCP server to a registry or directory, after deploying changes to one, when a client reports an MCP server "hangs" or "does nothing", or when asked whether an MCP server is ready to submit. Also use to test an MCP server without installing a connector.
---

# Verifying a deployed MCP server

The failure this skill exists to prevent: **a server that passes every check you thought to run, and fails the first question a real user asks.**

## The rule that makes most MCP verification worthless

> The MCP SDK **skips output-schema validation when `isError` is set.**

So a tool that returns an error proves *nothing* about its schema, its data, or the API behind it. If your smoke tests run unauthenticated, every authenticated tool returns a polite refusal, everything looks green, and you have verified only that refusals work.

**An unauthenticated smoke test cannot verify an authenticated tool.** Ever. Run the tools against a real account or state plainly that they are unverified.

## Order of work

1. `scripts/probe.mjs <baseUrl>` — everything checkable without an account
2. `scripts/connect.mjs <baseUrl>` — device-flow sign-in, prints a session id
3. `scripts/run-tools.mjs <baseUrl> <sessionId> <tool>...` — the authenticated tools

Step 3 is the one people skip and the one that finds real bugs.

## What to check, and why each matters

| Check | Why |
|---|---|
| `initialize` returns `serverInfo` | The URL is an MCP endpoint at all |
| `tools/list` count matches expectation | Diagnostics or dev-only tools leaking into production |
| Every tool has `title` | Directory portals reject tools without one |
| Every tool has all three of `readOnlyHint` / `destructiveHint` / `openWorldHint` | See `mcp-directory-submit`. Absent ≠ false |
| Every tool has `outputSchema` | Required by ChatGPT; also documents `structuredContent` |
| A **successful** call returns `structuredContent` | Widgets and models both read it |
| `resources/list` | `Method not found` means widgets have nowhere to attach |
| Unknown session id → 404, not 500 | Clients reconnect constantly |
| An unauthenticated authed-tool call returns readable `isError` content | Not a protocol error, which makes clients retry forever |

## Output schemas must be permissive

A mismatch between `structuredContent` and `outputSchema` throws `McpError` — a **protocol** error. Clients respond to those by retrying, not by relaying, so the user sees a hang rather than a message. **A wrong output schema is worse than no output schema**: it converts a working tool into a hang.

`.optional()` is not enough. It tolerates a field being *absent*; it still throws when the field is *present with a different type*. For anything the upstream owns, add `.catch()`:

```ts
screenSize: z.object({ width: z.number().optional(), height: z.number().optional() })
  .optional()
  .catch(undefined)   // documented shape, but degrades instead of throwing
```

The generated JSON Schema still carries the documented shape, so the model learns what to expect — but an unexpected value becomes `undefined` rather than a protocol error.

**Nothing type-checks an outputSchema against the handler's return.** A real example from this repo: a field was declared `z.string()` while the interface twenty lines below in the same file correctly typed it `{ width, height }`. `tsc` passed, both smoke tests passed, and only a real call against real data caught it — because the smokes never reached that tool's success path.

Verifying against one account is also weaker evidence than it feels. It proves the shapes for *that* account's data. Another operator's legacy records may differ, which is the second reason to use `.catch()` rather than relying on observation.

## Check the API underneath is actually deployed

Real incident: four of six authenticated tools were broken in production because the upstream routes they wrapped **had never been committed**. They existed in one developer's working tree while the server's README said the work "has now landed". Every layer above trusted that sentence.

Before trusting any "wraps `GET /api/x`" claim:

```bash
git cat-file -e origin/main:path/to/route.ts && echo on-main || echo NOT-ON-MAIN
git status --short path/to/route.ts   # modified-but-uncommitted is the same trap
```

The tell is a **correlation**: if the tools that work map exactly onto the routes already on `main`, the cause is deployment, not code.

## Misleading error messages

A 401 from a route that never learned to read the auth header produces the same message as an expired token — usually something like "your connection is no longer valid". If one tool works with the same credential that another rejects, **the credential is fine**; the route is the problem. Do not send the user off to reconnect.

## Writing your own probe: two traps

**Responses are SSE, not JSON.** Streamable HTTP replies as `event: message\ndata: {...}`. Piping to `jq` fails until you strip the `data: ` prefix.

**Edges return plain text.** A CDN can answer `upstream error` as `text/plain`. Any script doing `JSON.parse(body)` crashes mid-run and takes the session with it. Detect non-JSON and retry rather than throwing — losing the session costs a fresh browser sign-in.

## Reporting

State what was verified and what was not, separately. "Tests pass" after running only unauthenticated checks is a false claim about an authenticated server. Name the tools whose success paths never executed.
