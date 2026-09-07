/**
 * Renders every card HTML from build_cards.ts to a PNG the way the ChatGPT
 * Apps screenshot template wants it: the card alone, 353 CSS px wide, at 2x
 * (706 px), height as tall as the card (the template allows up to 800 CSS px).
 *
 *   node render_cards.js [outDir]
 *
 * Uses the machine's Google Chrome through Playwright (channel "chrome"), so
 * nothing is downloaded. Images the card asks for under the Studio CDN host are
 * answered from local files in ./assets — the card only renders https:// URLs.
 */
const path = require("node:path");
const fs = require("node:fs");
const pw = require("D:/things to do/dreambooth/dreambooth-prod/node_modules/playwright");

const HERE = __dirname;
const CARDS = path.join(HERE, "cards");
const ASSETS = path.join(HERE, "assets");
const OUT = path.resolve(process.argv[2] || path.join(HERE, "out"));
const WIDTH = 353;          // the template's card width
const MAX_HEIGHT = 800;     // the template's cap, in CSS px
const SCALE = 2;            // "Export the EXPORT layer at 2x PNG"

const ROUTES = {
  "/shot/genz-welcome.png": "dreambooth-japanese-preview.png",
  "/shot/ai-frame-love.png": "ai-frame-love.png",
  "/shot/filter-preview-warm.jpg": "filter-preview-warm.jpg",
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await pw.chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: 900 },
    deviceScaleFactor: SCALE,
  });
  await context.route("https://cdn.dreambooth-team.workers.dev/**", (route) => {
    const url = new URL(route.request().url());
    const file = ROUTES[url.pathname];
    if (!file) return route.fulfill({ status: 404, body: "not a shot asset" });
    const p = path.join(ASSETS, file);
    const type = file.endsWith(".png") ? "image/png" : "image/jpeg";
    return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(p) });
  });

  const files = fs.readdirSync(CARDS).filter((f) => f.endsWith(".html")).sort();
  const report = [];
  for (const f of files) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto("file:///" + path.join(CARDS, f).replace(/\\/g, "/"));
    // The live states poll check_generation on a timer; give them a beat so
    // the first reply (progress line) is painted, then freeze the spinner.
    await page.waitForTimeout(1200);
    await page.waitForFunction(() =>
      Array.from(document.images).every((i) => i.complete && (i.naturalWidth > 0 || !i.src))
    , null, { timeout: 15000 }).catch(() => errors.push("an image did not load"));
    await page.waitForTimeout(200);
    const card = page.locator("#card");
    const box = await card.boundingBox();
    if (!box) { errors.push("no #card"); report.push({ f, errors }); await page.close(); continue; }
    const name = f.replace(/\.html$/, "");
    const out = path.join(OUT, `inline-card-${name}@2x.png`);
    await card.screenshot({ path: out, omitBackground: true, animations: "disabled" });
    report.push({ f, width: Math.round(box.width), height: Math.round(box.height), tooTall: box.height > MAX_HEIGHT, out, errors });
    await page.close();
  }
  await browser.close();
  for (const r of report) console.log(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
