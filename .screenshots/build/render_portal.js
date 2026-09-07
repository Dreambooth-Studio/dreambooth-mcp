/**
 * Renders the portal screenshots: exactly 706x860, with the WHOLE card visible.
 *
 *   node render_portal.js [outDir]
 *
 * Why this exists next to render_cards.js: that one screenshots the card at its
 * natural height, which is what the Figma template's EXPORT layer wants (card
 * width 353 CSS px, height up to 800). The submission portal caps an upload at
 * 860 px tall, and 860 px at 2x is only 430 CSS px — so most of these cards do
 * not fit at 1:1. The first attempt fitted them by cropping the canvas, which
 * cut the bottom off four of the eight images; that set was rejected.
 *
 * So: put the card on a 353x430 stage and scale it down until it fits, rather
 * than cutting it off. A downscaled 2x render is still sharp, and a whole card
 * on a clean ground reads as a screenshot instead of a mistake.
 */
const path = require("node:path");
const fs = require("node:fs");
const pw = require("D:/things to do/dreambooth/dreambooth-prod/node_modules/playwright");

const HERE = __dirname;
const CARDS = process.env.CARDS_DIR ? path.resolve(process.env.CARDS_DIR) : path.join(HERE, "cards");
const ASSETS = path.join(HERE, "assets");
const OUT = path.resolve(process.argv[2] || path.join(HERE, "portal-out"));

const WIDTH = 353;   // 706 at 2x
const HEIGHT = 430;  // 860 at 2x — the portal's maximum
const SCALE = 2;
const PAD = 6;       // breathing room so the card never touches the edge

/**
 * Four cards, one per thing the app can make. The loading skeletons and the
 * dark variants are deliberately not here: the guidelines ask for screenshots
 * that represent the functionality, and a spinner over an empty placeholder
 * represents the waiting, not the feature. Four is also the portal's cap.
 */
const PICKS = [
  ["01-booth-draft", "booth-draft-light"],
  ["02-frame-preview", "frame-preview-light"],
  ["03-filter-preview", "filter-preview-light"],
  ["04-booth-created", "booth-created-light"],
];

const ROUTES = {
  "/shot/genz-welcome.png": "dreambooth-japanese-preview.png",
  "/shot/ai-frame-love.png": "ai-frame-love.png",
  "/shot/filter-preview-warm.jpg": "filter-preview-warm.jpg",
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await pw.chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
  });
  await context.route("https://cdn.dreambooth-team.workers.dev/**", (route) => {
    const url = new URL(route.request().url());
    const file = ROUTES[url.pathname];
    if (!file) return route.fulfill({ status: 404, body: "not a shot asset" });
    const p = path.join(ASSETS, file);
    return route.fulfill({
      status: 200,
      contentType: file.endsWith(".png") ? "image/png" : "image/jpeg",
      body: fs.readFileSync(p),
    });
  });

  const report = [];
  for (const [outName, cardName] of PICKS) {
    // A state the capture run never reached has no card. Skip it rather than
    // substituting a mock: the portal accepts one to four screenshots.
    if (!fs.existsSync(path.join(CARDS, `${cardName}.html`))) {
      console.log(JSON.stringify({ skipped: cardName, why: "no card html (state not captured)" }));
      continue;
    }
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto("file:///" + path.join(CARDS, `${cardName}.html`).replace(/\\/g, "/"));
    await page.waitForTimeout(1200);
    await page
      .waitForFunction(
        () => Array.from(document.images).every((i) => i.complete && (i.naturalWidth > 0 || !i.src)),
        null,
        { timeout: 20000 },
      )
      .catch(() => errors.push("an image did not load"));

    // Measure the card, then scale it to fit the stage. Done in the page so the
    // browser rasterises at the final size — scaling the PNG afterwards would
    // soften the text.
    const fit = await page.evaluate(
      ({ w, h, pad }) => {
        const card = document.getElementById("card");
        if (!card) return null;
        const natural = card.getBoundingClientRect().height;
        const scale = Math.min(1, (h - pad * 2) / natural);
        const style = document.createElement("style");
        style.textContent = `
          html, body { margin:0 !important; padding:0 !important; background:#F4F4F5 !important;
                       width:${w}px; height:${h}px; overflow:hidden; }
          body { display:flex; align-items:center; justify-content:center; }
          #card { transform: scale(${scale}); transform-origin: center center; }
        `;
        document.head.appendChild(style);
        return { natural: Math.round(natural), scale: Number(scale.toFixed(3)) };
      },
      { w: WIDTH, h: HEIGHT, pad: PAD },
    );
    if (!fit) {
      errors.push("no #card");
      report.push({ cardName, errors });
      await page.close();
      continue;
    }
    await page.waitForTimeout(150);

    const out = path.join(OUT, `${outName}.png`);
    await page.screenshot({ path: out, animations: "disabled" });
    report.push({ out: path.basename(out), cardHeightCss: fit.natural, scale: fit.scale, errors });
    await page.close();
  }
  await browser.close();
  for (const r of report) console.log(JSON.stringify(r));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
