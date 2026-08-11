---
name: mcp-registry-publish
description: Publish an MCP server to the official MCP Registry at registry.modelcontextprotocol.io — server.json, namespace choice, DNS or GitHub authentication, remote-server entries, and republishing. Use when asked to register, publish, or list an MCP server in the MCP registry, or to update an existing registry entry. Not for the ChatGPT or Anthropic directories, which are separate — see mcp-directory-submit.
---

# Publishing to the official MCP Registry

The registry hosts **metadata**, not code. It is also **not** the ChatGPT or Anthropic directory — publishing here does not feed either.

## The decision that cannot be undone

> **Entries cannot be unpublished, and each version's metadata is immutable.**

Updating means publishing a *new version*, never editing an old one. The name and the URL you choose are effectively permanent. Get these right before running anything:

- **The name.** `com.yourcompany/server` reads as the company's; `io.github.someaccount/server` reads as a forge account's. Both are permanent.
- **The URL.** Every downstream aggregator copies it. Publishing a platform-generated hostname (`*.up.railway.app`, `*.vercel.app`) pins your public identity to a host you do not control. Attach a custom domain first.
- **Domain lifetime.** If the domain lapses, the entry keeps pointing every client at a hostname you no longer own, and you cannot take it down. Check auto-renew is on.

## Namespace decides the auth method

| Name format | Login |
|---|---|
| `io.github.user/*` or `io.github.org/*` | `mcp-publisher login github` — OAuth device flow |
| `com.example.*/*` | `mcp-publisher login dns` or `login http` |

For a company-owned server, prefer the domain namespace.

## Steps

```bash
# 1. install (Windows)
$arch = if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe

# 2. keypair + the TXT record value
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"

# 3. validate — the ONLY step you can take back
./mcp-publisher validate server.json

# 4. login, then publish
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 priv: | tail -n +2 | tr -d ' :\n')"
./mcp-publisher login dns --domain example.com --private-key "$PRIVATE_KEY"
./mcp-publisher publish
```

Always `validate` first.

### The TXT record

Goes on the **apex** that matches the namespace — `com.example` proves `example.com`, *not* `mcp.example.com`. In a web DNS panel, enter the value **without surrounding quotes**: the quotes in the docs are BIND zone-file syntax and the panel adds its own. Keep the spaces after each `;`.

## server.json for a remote server

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "com.example/myserver",
  "title": "My Server",
  "description": "Under 100 characters. Capabilities, not implementation.",
  "version": "0.1.0",
  "websiteUrl": "https://example.com",
  "repository": { "url": "https://github.com/org/repo", "source": "github", "id": "123456789" },
  "remotes": [{ "type": "streamable-http", "url": "https://mcp.example.com/mcp" }]
}
```

- `description` is capped at **100 characters** — check with `[...s].length`, not by eye
- omit `packages` entirely if nothing is published to npm; it advertises an install path that does not exist
- `repository.id` comes from `gh api repos/<owner>/<repo> --jq .id`
- a **private** repository URL gives every reader a 404 on the one field meant for security inspection — make it public or omit the field

## Verified in the registry source, not the docs

`IsValidRemoteURL` enforces only HTTPS and no-localhost. There is **no** check binding a remote URL to the namespace domain — a `com.example/*` name pointing at `*.up.railway.app` is accepted today. Third-party posts claiming otherwise are wrong; that rule lives in a *proposed* enhanced-validation design doc. Use a custom domain anyway, because the URL can never be edited in place.

## Guard the signing key

`key.pem` signs the namespace proof. Gitignore it **before** generating it, especially in a public repo — whoever holds it can publish under your namespace permanently, and nothing can be unpublished. Losing it is recoverable: generate a new pair and replace the TXT record.

Also gitignore `.mcpregistry_token` (the cached JWT) and the downloaded `mcp-publisher` binary.

## Verify

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.example/myserver"
```

Downstream aggregators pull on their own schedule — roughly hourly — so a listing takes time to appear elsewhere.
