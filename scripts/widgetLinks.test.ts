/**
 * The cards leave the host through window.openai.openExternal, not through the
 * iframe's own window. These tests pin the wiring in the shipped HTML strings:
 * the bridge routes https links and data-open-href cards through
 * db.openExternal, and only the "it now exists" states link the whole card.
 *
 * The behaviour itself (a click producing one openExternal call and no
 * navigation) was checked in a real browser against npm run preview; these
 * tests guard the wiring against drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generationWidgetHtml } from "../src/ui/generationResult.js";
import { writeResultWidgetHtml } from "../src/ui/writeResult.js";
import { connectAccountWidgetHtml } from "../src/ui/connectAccount.js";

const WIDGETS: Array<[string, string]> = [
  ["generation", generationWidgetHtml],
  ["write-result", writeResultWidgetHtml],
  ["connect-account", connectAccountWidgetHtml],
];

test("every widget ships the bridge that routes links through openExternal", () => {
  for (const [name, html] of WIDGETS) {
    assert.ok(html.includes('document.addEventListener("click"'), `${name}: click delegation`);
    assert.ok(html.includes('target.closest("a[href]")'), `${name}: anchors intercepted`);
    assert.ok(html.includes('target.closest("[data-open-href]")'), `${name}: card destinations`);
    assert.ok(html.includes("db.linkCard = function"), `${name}: linkCard helper`);
    assert.ok(html.includes('document.addEventListener("keydown"'), `${name}: keyboard path`);
    // The anchor is only pre-empted when the host can actually open a window.
    assert.ok(html.includes('typeof api.openExternal === "function"'), `${name}: host-gated`);
    // Nothing in the template literal leaked a build-time interpolation.
    assert.ok(!html.includes("${"), `${name}: no unexpanded template markers`);
  }
});

test("the generation card links the whole card only for created things", () => {
  const html = generationWidgetHtml;
  // booth created -> the public link first, dashboard as the fallback
  assert.ok(html.includes("db.linkCard(card, b.boothUrl || b.dashboardUrl);"), "booth created links the card");
  // frame saved and filter created -> dashboard; two call sites
  assert.equal(html.split("db.linkCard(card, out.dashboardUrl);").length - 1, 2, "frame saved + filter created");
  // every render pass starts unlinked, and a live card never links
  assert.ok(html.includes("db.linkCard(card, null);"), "cleared before drawing");
  assert.equal(html.split("db.linkCard(card, null);").length - 1, 2, "cleared in render() and renderRunning()");
});

test("the duplicate card links to the dashboard and a failure never does", () => {
  const html = writeResultWidgetHtml;
  assert.ok(html.includes("db.linkCard(card, out.dashboardUrl);"), "duplicated booth links the card");
  assert.ok(html.includes("db.linkCard(card, null);"), "error branch clears it");
});

test("card links are styled as such", () => {
  for (const [name, html] of WIDGETS) {
    assert.ok(html.includes(".db-card--link{cursor:pointer}"), `${name}: pointer on linked cards`);
    assert.ok(html.includes(".db-card--link:focus-visible"), `${name}: keyboard focus ring`);
  }
});
