/**
 * Opens a session and drives whatever sign-in flow the server exposes, then
 * prints the session id for run-tools.mjs.
 *
 *   node connect.mjs https://mcp.example.com [connect_tool] [status_tool]
 *
 * Split from run-tools.mjs on purpose: a transient edge error during a long
 * poll must not cost another browser sign-in. This script's only job is to
 * reach "connected" and hand over an id that survives it.
 */
import { McpClient, payload } from "./mcp.mjs";

const BASE = (process.argv[2] || "").replace(/\/$/, "");
const CONNECT_TOOL = process.argv[3] || "connect_account";
const STATUS_TOOL = process.argv[4] || "connection_status";
if (!BASE) throw new Error("usage: node connect.mjs <baseUrl> [connectTool] [statusTool]");

const client = new McpClient(BASE, null);
await client.handshake("mcp-verify-connect");
console.log(`\nsession ${client.sessionId}\n`);

const started = payload((await client.callTool(CONNECT_TOOL)).result);

if (started?.status === "already_connected") {
  console.log("already connected\n");
} else {
  const url = started?.authUrl || started?.url || started?.verificationUri;
  if (!url) {
    console.log("No sign-in URL in the tool result. Raw payload:\n");
    console.log(JSON.stringify(started, null, 2));
    process.exit(1);
  }
  console.log("Open this and approve:\n");
  console.log(`   ${url}\n`);
  console.log("Waiting");

  const deadline = Date.now() + (started.expiresInMinutes ?? 5) * 60_000;
  let connected = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      // Poll the cheap status tool rather than a data tool: what matters is
      // whether THIS session is authenticated, and a status check that never
      // touches the upstream API is safe on a 3-second timer.
      const s = payload((await client.callTool(STATUS_TOOL)).result);
      if (s?.connected === true) { connected = true; break; }
    } catch {
      // A failed poll is not a failed connection. The deadline gives up, not us.
    }
    process.stdout.write(".");
  }
  console.log("");
  if (!connected) {
    console.log("\nnever connected — link expired or approval not completed\n");
    process.exit(1);
  }
}

// Deliberately NOT closed: the whole point is to hand this id to run-tools.mjs.
console.log(`\nconnected. Now run:\n\n   node run-tools.mjs ${BASE} ${client.sessionId} <tool> [<tool>...]\n`);
console.log("Sessions are usually evicted after a period of inactivity, so use it soon.\n");
