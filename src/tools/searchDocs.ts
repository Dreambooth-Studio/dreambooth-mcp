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

export const searchDocsInput = {
  query: z.string().min(2).describe("Search terms, in English or Indonesian"),
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
const cache = new Map<string, DocPage[]>();

function score(page: DocPage, terms: string[]): number {
  const title = page.title.toLowerCase();
  const keywords = (page.keywords || "").toLowerCase();
  const content = (page.content || "").toLowerCase();

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
        "Search the Dreambooth Studio documentation and FAQ. Call this before answering any question about the product, pricing, packages, hardware, printing, subscriptions, or troubleshooting — answer from the docs rather than from memory. Works without a connected account.",
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
        pages = index.pages ?? [];
        cache.set(locale, pages);
      }

      const terms = args.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
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
          // to decide to open the link, not 3 KB of prose per hit.
          excerpt: (hit.page.content || "").slice(0, 500),
        }));

      return { locale, query: args.query, resultCount: hits.length, results: hits };
    },
  };
}
