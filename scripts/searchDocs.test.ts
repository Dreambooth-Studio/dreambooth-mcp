import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSearchDocs, LINK_ONLY_EXCERPT, LINK_ONLY_PAGES } from "../src/tools/searchDocs.js";
import type { StudioClient } from "../src/studio/client.js";

/**
 * search_docs answers before sign-in, so it is the tool a reviewer reaches
 * first, and it used to invite pricing, packages and subscriptions questions
 * and hand back the pricing page's own table. The plugin guidelines: a plugin
 * "must not display subscription plans", but may link to a page that
 * describes them. These tests hold the tool to that: plans pages come back as
 * a link, everything else keeps its excerpt.
 */

const PRICING_TABLE =
  "Subscription Pricing & Plans | Plan | Per device / month (IDR) | Per device / month (USD) | Starter | Rp 199.000 | $19 |";

const INDEX = {
  pages: [
    {
      slug: ["account", "pricing-and-plans"],
      title: "Subscription Pricing & Plans",
      href: "/docs/account/pricing-and-plans",
      keywords: "subscription price per device per month",
      content: PRICING_TABLE,
    },
    {
      slug: ["hardware", "printers"],
      title: "Printers",
      href: "/docs/hardware/printers",
      keywords: "printer dye-sub",
      content: "Supported printers: DNP DS-RX1, Kodak 6850. A printer that stops mid-session usually needs its ribbon checked.",
    },
    {
      slug: ["platform-setup", "checkout-packages"],
      title: "Checkout Packages",
      href: "/docs/platform-setup/checkout-packages",
      keywords: "what a customer can buy at the booth, price",
      content: "A checkout package is what the customer chooses and pays for at the booth, priced in the project's own currency.",
    },
  ],
};

const studio = { getPublic: async () => INDEX } as unknown as StudioClient;
const docs = buildSearchDocs(studio);

test("a plans page comes back as a link, with no prices in the excerpt", async () => {
  const out = await docs.handler({ query: "subscription price plans" });
  const hit = out.results.find((r) => r.href === "/docs/account/pricing-and-plans");
  assert.ok(hit, "the plans page is still found, so the model can link it");
  assert.equal(hit.excerpt, LINK_ONLY_EXCERPT);
  assert.doesNotMatch(JSON.stringify(out), /Rp 199|\$19|Per device/);
});

test("other pages keep their excerpt, including the guest prices an operator sets", async () => {
  const printer = (await docs.handler({ query: "printer" })).results.find((r) => r.href === "/docs/hardware/printers");
  assert.match(printer?.excerpt ?? "", /DNP DS-RX1/);
  // Checkout packages are what a booth's guests pay the operator: the
  // operator's own prices, not Dreambooth's plans, so they stay readable.
  const packages = (await docs.handler({ query: "checkout package" })).results.find(
    (r) => r.href === "/docs/platform-setup/checkout-packages"
  );
  assert.match(packages?.excerpt ?? "", /pays for at the booth/);
  assert.ok(!LINK_ONLY_PAGES.has("/docs/platform-setup/checkout-packages"));
});

test("the description invites no pricing or subscription questions", () => {
  const { description } = docs.config;
  assert.doesNotMatch(description, /\bpricing\b|\bsubscriptions?\b|\bpackages\b/i);
  assert.match(description, /link only/);
});
