/**
 * Streamable HTTP acceptance check.
 *
 * Starts the built server, then drives it with a real MCP client over HTTP:
 * handshake, session id assignment, tools/list, an unauthenticated tool call,
 * and session isolation — two clients must not see each other's connection
 * state.
 *
 *   npm run build && npm run inspect:http
 */
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const OK = "[32m";
const BAD = "[31m";
const RESET = "[0m";

const PORT = Number(process.env.SMOKE_PORT || 8099);
const URL_BASE = `http://127.0.0.1:${PORT}`;

function text(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ text?: string }>;
  return blocks
    .map((b) => b.text ?? "")
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${URL_BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy");
}

/**
 * HTTP mode must refuse to start with a developer token configured: seeding
 * every session with one account's token would serve that account's data to
 * whoever connects. Verified by starting the server the wrong way on purpose.
 */
async function assertRefusesSeedToken(): Promise<boolean> {
  return new Promise((resolve) => {
    const bad = spawn(process.execPath, ["dist/index.js", "--http"], {
      env: { ...process.env, PORT: String(PORT + 1), DREAMBOOTH_TOKEN: "a-token" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    bad.stderr.on("data", (d) => (stderr += d));
    bad.on("exit", (code) => {
      resolve(code !== 0 && /must not be set in HTTP mode/.test(stderr));
    });
  });
}

async function main(): Promise<void> {
  if (await assertRefusesSeedToken()) {
    console.log(`${OK}✓${RESET} refuses to start with DREAMBOOTH_TOKEN set`);
  } else {
    console.log(`${BAD}✗${RESET} started with a seed token — every session would share it`);
    process.exitCode = 1;
  }

  const child = spawn(process.execPath, ["dist/index.js", "--http"], {
    env: { ...process.env, PORT: String(PORT), DREAMBOOTH_TOKEN: "" },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let failures = 0;
  const fail = (msg: string) => {
    failures++;
    console.log(`${BAD}✗${RESET} ${msg}`);
  };

  try {
    await waitForHealth();
    const health = (await (await fetch(`${URL_BASE}/health`)).json()) as {
      status: string;
      sessions: number;
    };
    console.log(`${OK}✓${RESET} /health → ${health.status}, ${health.sessions} sessions`);

    // --- client A ---
    const a = new Client({ name: "smoke-a", version: "1.0.0" });
    const ta = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`));
    await a.connect(ta);
    const sidA = ta.sessionId;
    console.log(`${OK}✓${RESET} client A connected, session ${sidA ? "assigned" : "MISSING"}`);
    if (!sidA) fail("no Mcp-Session-Id assigned");

    const { tools } = await a.listTools();
    console.log(`${OK}✓${RESET} tools/list → ${tools.length} tools`);
    if (!tools.some((t) => t.name === "connect_account")) fail("connect_account missing");

    // Public tool works with no account connected at all.
    const docs = (await a.callTool({
      name: "search_docs",
      arguments: { query: "printer", limit: 1 },
    })) as { content?: unknown; isError?: boolean };
    if (docs.isError) fail(`search_docs should work unauthenticated: ${text(docs)}`);
    else console.log(`${OK}✓${RESET} search_docs (no auth) → ${text(docs).slice(0, 90)}…`);

    // Authed tool must refuse in a way the model can act on, naming the fix.
    const sessionsCall = (await a.callTool({
      name: "get_sessions",
      arguments: { limit: 1 },
    })) as { content?: unknown; isError?: boolean };
    const msg = text(sessionsCall);
    if (!sessionsCall.isError) fail("get_sessions should refuse without a token");
    else if (!/connect_account/.test(msg)) fail(`refusal must name the fix, got: ${msg}`);
    else console.log(`${OK}✓${RESET} get_sessions (no auth) → ${msg.slice(0, 110)}…`);

    // --- client B: sessions must be independent ---
    const b = new Client({ name: "smoke-b", version: "1.0.0" });
    const tb = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`));
    await b.connect(tb);
    const sidB = tb.sessionId;
    if (!sidB || sidB === sidA) fail("client B reused client A's session id");
    else console.log(`${OK}✓${RESET} client B got a distinct session`);

    const health2 = (await (await fetch(`${URL_BASE}/health`)).json()) as { sessions: number };
    if (health2.sessions < 2) fail(`expected 2 sessions, health reports ${health2.sessions}`);
    else console.log(`${OK}✓${RESET} /health tracks ${health2.sessions} live sessions`);

    // Unknown session id must be a clean 404, not a 500.
    const bogus = await fetch(`${URL_BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "does-not-exist",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    if (bogus.status !== 404) fail(`unknown session should 404, got ${bogus.status}`);
    else console.log(`${OK}✓${RESET} unknown session id → 404`);

    await a.close();
    await b.close();
  } finally {
    child.kill("SIGTERM");
  }

  if (failures > 0) {
    console.error(`${BAD}✗ ${failures} check(s) failed${RESET}`);
    process.exit(1);
  }
  console.log(`${OK}✓ http smoke passed${RESET}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${BAD}✗ http smoke failed:${RESET}`, err);
  process.exit(1);
});
