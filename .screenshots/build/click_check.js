/**
 * Clicks through the preview cards in a real browser and records what leaves
 * the iframe: with a host API present every https link and every linked card
 * must produce exactly one window.openai.openExternal call and no navigation;
 * without the API the anchor must keep its own target="_blank".
 *
 *   node click_check.js   (after `npm run preview` in dreambooth-mcp)
 */
const path = require("node:path");
const pw = require("D:/things to do/dreambooth/dreambooth-prod/node_modules/playwright");

const PREVIEW = "D:/things to do/dreambooth/dreambooth-mcp/.preview";
const fileUrl = (name) => "file:///" + path.join(PREVIEW, name).replace(/\\/g, "/");

async function open(context, name, { withHostApi = true } = {}) {
  const page = await context.newPage();
  const calls = [];
  page.on("console", (m) => { const t = m.text(); if (t.startsWith("openExternal ")) calls.push(t.slice("openExternal ".length)); });
  const popups = [];
  page.on("popup", (p) => popups.push(p.url()));
  if (!withHostApi) {
    await page.addInitScript(() => {
      // Runs before the widget's own scripts: strip the host API after the
      // preview shim defines it, so the "no host" path is exercised.
      document.addEventListener("DOMContentLoaded", () => { if (window.openai) delete window.openai.openExternal; });
    });
  }
  await page.goto(fileUrl(name));
  await page.waitForTimeout(400);
  return { page, calls, popups, nav: () => page.url() };
}

(async () => {
  const browser = await pw.chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const results = [];

  // 1. Created booth: the link and the card body both leave through the host.
  {
    const { page, calls, popups } = await open(context, "gen-booth-created-light.html");
    const before = page.url();
    await page.locator("a.db-link").first().click();
    await page.locator("#card .db-title").click();
    await page.waitForTimeout(300);
    results.push({ case: "booth created: link + card body", calls, popups, navigated: page.url() !== before,
      cardLinked: await page.locator("#card[data-open-href]").count(), role: await page.locator("#card").getAttribute("role") });
    await page.close();
  }
  // 2. Draft: the body must NOT be a link; nothing leaves.
  {
    const { page, calls, popups } = await open(context, "gen-booth-draft-light.html");
    const before = page.url();
    await page.locator("#card .db-title").click();
    await page.waitForTimeout(300);
    results.push({ case: "booth draft: card body", calls, popups, navigated: page.url() !== before,
      cardLinked: await page.locator("#card[data-open-href]").count(), cursor: await page.locator("#card").evaluate((n) => getComputedStyle(n).cursor) });
    await page.close();
  }
  // 3. Frame saved + filter created + duplicated booth: card body leaves.
  for (const name of ["gen-frame-saved-light.html", "gen-filter-created-dark.html", "write-booth-light.html"]) {
    const { page, calls, popups } = await open(context, name);
    const before = page.url();
    await page.locator("#card .db-title").click();
    await page.waitForTimeout(300);
    results.push({ case: `${name}: card body`, calls, popups, navigated: page.url() !== before, href: await page.locator("#card").getAttribute("data-open-href") });
    await page.close();
  }
  // 4. Keyboard: focus the card and press Enter.
  {
    const { page, calls } = await open(context, "gen-frame-saved-light.html");
    await page.locator("#card").focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    results.push({ case: "frame saved: Enter on focused card", calls });
    await page.close();
  }
  // 5. No host API: the anchor keeps target=_blank and opens a popup itself.
  {
    const { page, calls, popups } = await open(context, "gen-booth-created-light.html", { withHostApi: false });
    const hasApi = await page.evaluate(() => typeof (window.openai || {}).openExternal);
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 3000 }).catch(() => null),
      page.locator("a.db-link").first().click(),
    ]);
    results.push({ case: "no host API: link click", hostApi: hasApi, calls, popupUrl: popup ? popup.url() : null, popups });
    if (popup) await popup.close();
    await page.close();
  }
  await browser.close();
  for (const r of results) console.log(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
