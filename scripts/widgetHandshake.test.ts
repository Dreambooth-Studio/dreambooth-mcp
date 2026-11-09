/**
 * The MCP Apps handshake, run for real against the shipped bridge script.
 *
 * A card served as text/html;profile=mcp-app that never sends ui/initialize is
 * replaced by the host's own "timed out" panel, even though the tool succeeded.
 * The script is lifted out of the HTML and run in a throwaway context with a
 * fake parent frame, so these tests see exactly what goes over postMessage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { generationWidgetHtml } from "../src/ui/generationResult.js";
import { writeResultWidgetHtml } from "../src/ui/writeResult.js";
import { connectAccountWidgetHtml } from "../src/ui/connectAccount.js";

type Message = Record<string, any>;

const bridge = (() => {
  const match = /<script>([\s\S]*?window\.__db = db;[\s\S]*?)<\/script>/.exec(generationWidgetHtml);
  assert.ok(match, "the bridge script is in the document");
  return match[1];
})();

function boot(options: { embedded?: boolean; openai?: Record<string, unknown> } = {}) {
  const posted: Message[] = [];
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const parent = { postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) };
  const html = {
    lang: "",
    scrollHeight: 120,
    style: { height: "" },
    setAttribute() {},
    getBoundingClientRect: () => ({ height: 120 }),
  };
  const document = { documentElement: html, body: {}, addEventListener() {} };
  const window: Record<string, any> = {
    openai: options.openai,
    innerWidth: 400,
    addEventListener(type: string, listener: (event: unknown) => void) {
      (listeners[type] ??= []).push(listener);
    },
  };
  window.parent = options.embedded === false ? window : parent;

  vm.runInNewContext(bridge, {
    window,
    document,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms).unref(),
    clearTimeout,
  });

  const fire = (data: unknown, source: unknown = parent) => {
    for (const listener of listeners.message ?? []) listener({ data, source });
  };
  const tick = () => new Promise((done) => setImmediate(done));
  const handshake = async (hostContext: Record<string, unknown> = {}) => {
    fire({ jsonrpc: "2.0", id: posted[0].id, result: { hostContext } });
    await tick();
  };
  return { db: window.__db, posted, fire, tick, handshake, parent, window };
}

const toolResult = (structuredContent: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/tool-result",
  params: { content: [], structuredContent },
});

test("a card introduces itself as soon as it loads", () => {
  const { posted } = boot();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].jsonrpc, "2.0");
  assert.equal(posted[0].method, "ui/initialize");
  assert.equal(typeof posted[0].id, "number");
  assert.deepEqual(Object.keys(posted[0].params).sort(), ["appCapabilities", "appInfo", "protocolVersion"]);
  assert.equal(posted[0].params.protocolVersion, "2026-01-26");
  assert.equal(typeof posted[0].params.appInfo.name, "string");
  assert.equal(typeof posted[0].params.appInfo.version, "string");
});

test("initialized follows the host's answer, and is a notification", async () => {
  const { posted, handshake } = boot();
  assert.ok(!posted.some((m) => m.method === "ui/notifications/initialized"), "not before the answer");
  await handshake();
  const initialized = posted.find((m) => m.method === "ui/notifications/initialized");
  assert.ok(initialized, "sent after the answer");
  assert.equal(initialized.id, undefined);
});

test("the host's result reaches the card", async () => {
  const { db, fire, handshake } = boot();
  let received: Message | undefined;
  db.onToolOutput = (out: Message) => (received = out);
  assert.equal(db.isWaiting(), true);
  await handshake();
  fire(toolResult({ kind: "filter-preview", previewUrl: "https://cdn.dreambooth.app/x.jpg" }));
  assert.equal(received?.kind, "filter-preview");
  assert.equal(db.toolOutput().kind, "filter-preview");
  assert.equal(db.isWaiting(), false);
});

test("a failed tool's sentence reaches the card", async () => {
  const { db, fire, handshake } = boot();
  await handshake();
  fire({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { isError: true, content: [{ type: "text", text: "Nothing was created." }] },
  });
  assert.equal(db.toolOutput().error, "Nothing was created.");
});

test("only the parent frame is listened to", async () => {
  const { db, fire, posted } = boot();
  fire({ jsonrpc: "2.0", id: posted[0].id, result: {} }, { someOtherFrame: true });
  fire(toolResult({ kind: "filter" }), { someOtherFrame: true });
  await new Promise((done) => setImmediate(done));
  assert.ok(!posted.some((m) => m.method === "ui/notifications/initialized"));
  assert.equal(db.toolOutput().kind, undefined);
});

test("a host that only offers window.openai is left alone", async () => {
  const openai = { toolOutput: { kind: "filter-preview" }, callTool: async () => ({ structuredContent: { state: "done" } }) };
  const { db, posted, tick } = boot({ openai });
  assert.equal(db.isWaiting(), false, "the result was already there");
  assert.equal(db.toolOutput().kind, "filter-preview");
  assert.equal((await db.callTool("check_generation", { jobId: "j" })).state, "done");
  await tick();
  assert.deepEqual(posted.map((m) => m.method), ["ui/initialize"], "one unanswered hello, then nothing");
});

test("window.openai stays first when both are offered", async () => {
  const calls: string[] = [];
  const openai = {
    toolOutput: { kind: "filter-preview" },
    callTool: async (name: string) => {
      calls.push(name);
      return { structuredContent: { state: "done" } };
    },
  };
  const { db, posted, handshake } = boot({ openai });
  await handshake();
  await db.callTool("check_generation", {});
  assert.deepEqual(calls, ["check_generation"]);
  assert.ok(!posted.some((m) => m.method === "tools/call"));
});

test("without window.openai the card polls and leaves through the protocol", async () => {
  const { db, posted, fire, handshake, tick } = boot();
  await handshake();

  const call = db.callTool("check_generation", { jobId: "j" });
  const sent = posted.find((m) => m.method === "tools/call");
  assert.equal(sent?.params.name, "check_generation");
  assert.equal(sent?.params.arguments.jobId, "j");
  fire({ jsonrpc: "2.0", id: sent?.id, result: { structuredContent: { state: "running" } } });
  assert.equal((await call).state, "running");

  assert.equal(db.openExternal("https://dreamboothstudio.com/x"), true);
  await tick();
  assert.equal(posted.find((m) => m.method === "ui/open-link")?.params.url, "https://dreamboothstudio.com/x");
});

test("the host's theme and locale win, and later changes apply", async () => {
  const { db, fire, handshake } = boot({ openai: { locale: "id" } });
  let refreshed = 0;
  db.onGlobals = () => refreshed++;
  await handshake({ theme: "dark", locale: "en-US" });
  assert.equal(db.locale, "en");
  assert.equal(refreshed, 1);
  fire({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { locale: "es-MX" } });
  assert.equal(db.locale, "es");
});

test("the card reports its height once connected", async () => {
  const { db, posted, handshake } = boot();
  db.fit();
  assert.ok(!posted.some((m) => m.method === "ui/notifications/size-changed"), "not before the handshake");
  await handshake();
  const size = posted.find((m) => m.method === "ui/notifications/size-changed");
  assert.deepEqual(size?.params, { width: 400, height: 120 });
});

test("a frame that has not been laid out never reports a 0", async () => {
  const { posted, handshake, window } = boot();
  window.innerWidth = 0;
  await handshake();
  const size = posted.find((m) => m.method === "ui/notifications/size-changed");
  assert.deepEqual(size?.params, { height: 120 }, "height only, no width 0");
});

test("a request from the host is always answered", () => {
  const { posted, fire } = boot();
  fire({ jsonrpc: "2.0", id: 91, method: "ui/resource-teardown", params: {} });
  fire({ jsonrpc: "2.0", id: 92, method: "ui/something-new", params: {} });
  assert.deepEqual(posted.find((m) => m.id === 91)?.result, {});
  assert.equal(posted.find((m) => m.id === 92)?.error.code, -32601);
});

test("opened directly, a card talks to nobody", () => {
  const { db, posted } = boot({ embedded: false });
  assert.equal(posted.length, 0);
  assert.equal(db.isWaiting(), false);
});

test("every card can draw late and ships the handshake", () => {
  const widgets: Array<[string, string]> = [
    ["generation", generationWidgetHtml],
    ["write-result", writeResultWidgetHtml],
    ["connect-account", connectAccountWidgetHtml],
  ];
  for (const [name, html] of widgets) {
    assert.ok(html.includes('request("ui/initialize"'), `${name}: handshake`);
    assert.ok(html.includes("db.onToolOutput = function"), `${name}: takes a late result`);
    assert.ok(html.includes("db.isWaiting()"), `${name}: does not call a late result a failure`);
    assert.ok(!html.includes("`"), `${name}: no stray backtick in the script`);
  }
});
