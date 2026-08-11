/**
 * Shared MCP-over-HTTP client for the verification scripts.
 *
 * Deliberately dependency-free: these run against a DEPLOYED server, often from
 * a machine that has never installed the project, and adding an SDK import
 * means the probe can fail for reasons that have nothing to do with the server.
 */

/**
 * Streamable HTTP answers as SSE — `event: message` then `data: {...}` — so a
 * plain JSON.parse of the body fails. Edges also answer with plain text
 * (`upstream error`) under load, which must be retryable rather than fatal:
 * throwing there kills the run and, with it, a session that cost a browser
 * sign-in to obtain.
 */
export function parseFrame(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("{")) {
    throw new Error(`non-JSON from edge: ${trimmed.slice(0, 80)}`);
  }
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
  }
  return JSON.parse(trimmed);
}

export class McpClient {
  constructor(baseUrl, sessionId = null) {
    this.base = baseUrl.replace(/\/$/, "");
    this.sessionId = sessionId;
  }

  async rpc(method, params = {}, { notify = false, retries = 2 } = {}) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const body = notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: Date.now(), method, params };

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.base}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const assigned = res.headers.get("mcp-session-id");
        if (assigned && !this.sessionId) this.sessionId = assigned;
        const text = await res.text();
        return notify ? null : parseFrame(text);
      } catch (err) {
        if (attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  /** initialize + the initialized notification, which some servers require. */
  async handshake(clientName = "mcp-verify") {
    const res = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    });
    await this.rpc("notifications/initialized", {}, { notify: true });
    return res;
  }

  callTool(name, args = {}) {
    return this.rpc("tools/call", { name, arguments: args });
  }

  /** Leaves no session behind on a production server. */
  async close() {
    if (!this.sessionId) return;
    await fetch(`${this.base}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId },
    }).catch(() => {});
  }
}

/** Tool results carry the payload twice; prefer the structured copy. */
export function payload(result) {
  if (result?.structuredContent) return result.structuredContent;
  const raw = (result?.content ?? []).map((c) => c.text ?? "").join("");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function textOf(result) {
  return (result?.content ?? [])
    .map((c) => c.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
