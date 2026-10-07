import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConnectAccount, connectAccountOutput } from "../src/tools/connectAccount.js";
import { connectAccountWidgetHtml } from "../src/ui/connectAccount.js";
import { SessionTokens } from "../src/auth/tokenStore.js";
import type { Config } from "../src/config.js";

/**
 * connect_account answers three different ways depending on the client, and
 * its description promised only one of them: "Returns a link" to every
 * caller, and "an email and password or Google" for a link the Studio builds
 * as an accounts.google.com URL. A reviewer reads the description and then
 * calls the tool; these tests hold the two to each other.
 */

const CONFIG = {
  apiUrl: "https://studio.test",
  publicUrl: "https://mcp.test",
  diagnostics: false,
} as unknown as Config;

const STATELESS = { transport: "http" as const, sessionId: () => undefined, stateless: true };

const STATUSES = ["already_connected", "awaiting_approval", "use_client_sign_in"];

test("a sessionless request with no credential gets use_client_sign_in and no link", async () => {
  const tool = buildConnectAccount(CONFIG, new SessionTokens(), STATELESS);
  const out = (await tool.handler()) as Record<string, unknown>;
  assert.equal(out.status, "use_client_sign_in");
  assert.equal(out.authUrl, undefined);
});

test("a request carrying a credential is already connected, never handed a link", async () => {
  const tool = buildConnectAccount(CONFIG, SessionTokens.forRequest("tok"), STATELESS);
  const out = (await tool.handler()) as Record<string, unknown>;
  assert.equal(out.status, "already_connected");
  assert.equal(out.authUrl, undefined);
});

test("the description and the output schema name every status the handler returns", () => {
  const { description } = buildConnectAccount(CONFIG, new SessionTokens(), STATELESS).config;
  const schemaNote = connectAccountOutput.status.description ?? "";
  for (const status of STATUSES) {
    assert.ok(description.includes(status), `description never mentions ${status}`);
    assert.ok(schemaNote.includes(status), `status schema never mentions ${status}`);
  }
});

test("the link is described as Google sign-in, not as email and password", () => {
  const { description } = buildConnectAccount(CONFIG, new SessionTokens(), STATELESS).config;
  const linkSentence = description.split("awaiting_approval:")[1]?.split("use_client_sign_in:")[0] ?? "";
  assert.match(linkSentence, /Google/);
  assert.doesNotMatch(linkSentence, /password/i, "the device-flow link is accounts.google.com only");
});

test("the card has its own state for use_client_sign_in instead of 'run connect_account again'", () => {
  // Without it the card fell through to the no-link note, which tells the
  // model to call the tool again: on this path that answer never changes.
  assert.match(connectAccountWidgetHtml, /out\.status === "use_client_sign_in"/);
  assert.match(connectAccountWidgetHtml, /clientSignIn/);
});

test("connect_account names no trial or upgrade, in any answer or on its card", async () => {
  // The plugin guidelines: a plugin "must not display subscription plans,
  // initiate new subscriptions, or promote upgrades". Every one of these
  // places said "14-day Pro trial" while the portal held the tool for review.
  // The id and es card copy are checked too ("uji coba", "prueba"). Word
  // boundaries, because the es card's "Aprueba" (approve) contains "prueba".
  const PROMO = /\btrials?\b|\bupgrades?\b|\buji coba\b|\bprueba\b/i;

  // awaiting_approval needs the device flow, so answer its two Studio calls:
  // the authorize POST hands out a link, and the first status poll ends the
  // background loop (its timers are unref'd either way).
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) =>
    new Response(
      JSON.stringify(
        String(url).includes("/authorize")
          ? { state: "s", oauthUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }
          : { status: "expired" },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  let awaiting: Record<string, unknown>;
  try {
    awaiting = (await buildConnectAccount(CONFIG, new SessionTokens()).handler()) as Record<string, unknown>;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(awaiting.status, "awaiting_approval");

  const tool = buildConnectAccount(CONFIG, new SessionTokens(), STATELESS);
  const answers = [
    awaiting,
    await tool.handler(),
    await buildConnectAccount(CONFIG, SessionTokens.forRequest("tok"), STATELESS).handler(),
  ];
  for (const text of [tool.config.title, tool.config.description, ...answers.map((a) => JSON.stringify(a)), connectAccountWidgetHtml]) {
    assert.doesNotMatch(text, PROMO);
  }
});
