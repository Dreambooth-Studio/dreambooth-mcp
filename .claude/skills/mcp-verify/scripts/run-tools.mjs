/**
 * Exercises tools on an ALREADY-CONNECTED session — the only check that proves
 * an authenticated tool's success path and its output schema.
 *
 *   node run-tools.mjs <baseUrl> <sessionId> get_credits list_projects ...
 *   node run-tools.mjs <baseUrl> <sessionId> --all
 *
 * --all discovers every read-only tool from tools/list and runs it with no
 * arguments, which is right for tools whose parameters are all optional.
 *
 * It distinguishes three outcomes that look identical in a chat client and are
 * completely different bugs:
 *
 *   SCHEMA-ERR  structuredContent did not match outputSchema. This is an
 *               McpError, i.e. a PROTOCOL error, so clients retry instead of
 *               relaying — the user sees a hang, not a message.
 *   TOOL-ERROR  the upstream API refused. Usually the route is missing, not
 *               deployed, or does not accept this credential.
 *   TRANSPORT   the edge failed. Retried; not the server's fault.
 */
import { McpClient, payload, textOf } from "./mcp.mjs";

const [, , BASE_RAW, SID, ...rest] = process.argv;
if (!BASE_RAW || !SID) throw new Error("usage: node run-tools.mjs <baseUrl> <sessionId> <tool>... | --all");
const BASE = BASE_RAW.replace(/\/$/, "");

const client = new McpClient(BASE, SID);

let names = rest.filter((a) => !a.startsWith("--"));
if (rest.includes("--all") || names.length === 0) {
  const tools = (await client.rpc("tools/list"))?.result?.tools ?? [];
  names = tools
    .filter((t) => t.annotations?.readOnlyHint)
    .filter((t) => !/status|info/i.test(t.name))
    .map((t) => t.name);
  console.log(`\ndiscovered ${names.length} read-only tools\n`);
}

let pass = 0, schemaFail = 0, toolFail = 0;

for (const name of names) {
  let r;
  try {
    r = await client.callTool(name, {});
  } catch (err) {
    toolFail++;
    console.log(`TRANSPORT  ${name}\n           ${err.message}\n`);
    continue;
  }

  if (r?.error) {
    const isSchema = /output validation|structured content/i.test(r.error.message || "");
    isSchema ? schemaFail++ : toolFail++;
    console.log(`${isSchema ? "SCHEMA-ERR" : "PROTO-ERR "} ${name}\n           ${r.error.message}\n`);
    continue;
  }

  if (r?.result?.isError) {
    toolFail++;
    console.log(`TOOL-ERROR ${name}\n           ${textOf(r.result).slice(0, 160)}\n`);
    continue;
  }

  pass++;
  console.log(`OK         ${name}\n           ${JSON.stringify(payload(r.result)).slice(0, 200)}\n`);
}

console.log("─".repeat(72));
console.log(`${pass} passed, ${schemaFail} output-schema failures, ${toolFail} other failures`);

if (schemaFail) {
  console.log(
    "\nSCHEMA-ERR is the bug this script exists to find. It reaches a real user\n" +
    "as a hang, because clients retry protocol errors instead of relaying them.\n" +
    "Fix by making the schema permissive: every field owned by the upstream API\n" +
    "should be .optional(), so a rename degrades to a missing key."
  );
}
if (toolFail) {
  console.log(
    "\nFor TOOL-ERROR, check the upstream route is actually DEPLOYED before\n" +
    "debugging the tool. If the tools that pass map exactly onto the routes\n" +
    "already on main, the cause is deployment, not code."
  );
}
process.exit(schemaFail || toolFail ? 1 : 0);
