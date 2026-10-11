import { z } from "zod";
import type { StudioClient } from "../studio/client.js";

/**
 * Searches the Dreambooth documentation corpus.
 *
 * Uses the build-time search index served from /public (46 pages per locale),
 * NOT /api/docs-index — that route returns navigation only, with no page
 * content to match against.
 *
 * This is the one v1 tool that needs no token, so it works before the operator
 * has connected an account. That makes it the natural "try before you sign in"
 * surface later on.
 */

/**
 * Bounds on the one tool anyone can call without an account.
 *
 * Scoring is terms × pages × a scan of each page, on the event loop. Unbounded,
 * a single anonymous call with a few MB of "aa aa aa…" blocked the process for
 * minutes and stalled every operator's tool calls with it. A real question is
 * a sentence; these leave plenty of room for one.
 */
const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 12;

export const searchDocsInput = {
  query: z.string().min(2).max(MAX_QUERY_LENGTH).describe("Search terms, in English or Indonesian"),
  locale: z.enum(["en", "id"]).optional().describe("Docs language (default en)"),
  limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5)"),
};

/**
 * Output schemas, on every tool, for three readers: ChatGPT's plugin review
 * requires "explicit input and output schemas", widgets get a contract for the
 * `structuredContent` they render, and the model gets to know the shape before
 * it calls.
 *
 * They are deliberately PERMISSIVE. The SDK validates `structuredContent`
 * against this and throws `McpError` on a mismatch — a protocol error, which
 * rule #5 of the README exists to prevent, because clients respond to those by
 * retrying rather than by relaying. Anything the Studio owns is therefore
 * `.optional()`: a field it renames must degrade to a missing key, never to a
 * broken tool. Only values this file constructs itself are required.
 */
export const searchDocsOutput = {
  locale: z.string(),
  query: z.string(),
  resultCount: z.number(),
  results: z.array(
    z.object({
      title: z.string().optional(),
      href: z.string().optional(),
      excerpt: z.string(),
    })
  ),
};

interface DocPage {
  slug: string;
  title: string;
  href: string;
  keywords?: string;
  content?: string;
}

interface DocsIndex {
  pages: DocPage[];
}

/** Cached per locale for the process lifetime — the index only changes on deploy. */
const cache = new Map<string, IndexedPage[]>();

/**
 * Pages whose subject is Dreambooth's own plans, prices and billing come back
 * as a title and a link, never as an excerpt.
 *
 * The plugin guidelines say a plugin "must not display subscription plans,
 * initiate new subscriptions, or promote upgrades", and that it may "link to
 * an informational page describing available plans". An excerpt of the
 * pricing page IS a displayed plan list, so the model gets the page to link
 * instead. Matched by href, which the en and id indexes share.
 *
 * Deliberately narrow: pages that mention a plan in passing keep their
 * excerpt, and the checkout packages an operator sells to guests at a booth
 * are the operator's prices, not Dreambooth's plans. Pages that explain a
 * feature depends on the plan (vouchers, email reports) stay too; the
 * guidelines allow explaining that. The getting-started FAQ is here because
 * the excerpt is its first 500 characters, which are its free-trial answer.
 */
export const LINK_ONLY_PAGES = new Set([
  "/docs/account/pricing-and-plans",
  "/docs/account/payments-and-currency",
  "/docs/account/subscription-billing",
  "/docs/faq/account-billing-faq",
  "/docs/faq/getting-started-faq",
  "/docs/getting-started/first-session-no-install",
]);

export const LINK_ONLY_EXCERPT =
  "This page covers Dreambooth's own plans and billing. Share the link; do not quote its prices, plans or trials in the conversation.";

/** Lowercased once when the index is cached, not on every term of every call. */
interface IndexedPage extends DocPage {
  titleLc: string;
  keywordsLc: string;
  contentLc: string;
}

function score(page: IndexedPage, terms: string[]): number {
  const title = page.titleLc;
  const keywords = page.keywordsLc;
  const content = page.contentLc;

  let total = 0;
  for (const term of terms) {
    if (title.includes(term)) total += 10;
    if (keywords.includes(term)) total += 4;
    // Count content hits but cap them, so one long page cannot outrank a page
    // whose title is an exact match.
    const hits = content.split(term).length - 1;
    total += Math.min(hits, 5);
  }
  return total;
}

export function buildSearchDocs(studio: StudioClient) {
  return {
    name: "search_docs",
    config: {
      title: "Search Dreambooth documentation",
      description:
        "Search the Dreambooth Studio documentation and FAQ. Call this before answering any question about the product, hardware, printing, booth setup, guest payments, or troubleshooting — answer from the docs rather than from memory. Pages about Dreambooth's own plans and billing come back as a link only: share the link, and do not quote prices, plans or trials in the conversation. Works without a connected account.",
      inputSchema: searchDocsInput,
      outputSchema: searchDocsOutput,
    },
    handler: async (args: { query: string; locale?: "en" | "id"; limit?: number }) => {
      const locale = args.locale ?? "en";

      let pages = cache.get(locale);
      if (!pages) {
        const index = await studio.getPublic<DocsIndex>(
          `/docs-search-index-${locale}.json`
        );
        pages = (index.pages ?? []).map((page) => ({
          ...page,
          titleLc: (page.title || "").toLowerCase(),
          keywordsLc: (page.keywords || "").toLowerCase(),
          contentLc: (page.content || "").toLowerCase(),
        }));
        cache.set(locale, pages);
      }

      // Deduplicated and capped as well as length-limited: the schema bounds
      // the string, this bounds the work, and stays true if either changes.
      const terms = [
        ...new Set(args.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)),
      ].slice(0, MAX_TERMS);
      const limit = args.limit ?? 5;

      const hits = pages
        .map((page) => ({ page, score: score(page, terms) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((hit) => ({
          title: hit.page.title,
          href: hit.page.href,
          // A window, not the whole page: the model needs enough to answer or
          // to decide to open the link, not 3 KB of prose per hit. None at
          // all for a plans page; see LINK_ONLY_PAGES.
          excerpt: LINK_ONLY_PAGES.has(hit.page.href)
            ? LINK_ONLY_EXCERPT
            : (hit.page.content || "").slice(0, 500),
        }));

      return { locale, query: args.query, resultCount: hits.length, results: hits };
    },
  };
}
