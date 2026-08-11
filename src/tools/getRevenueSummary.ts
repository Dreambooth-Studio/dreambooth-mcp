import { z } from "zod";
import type { StudioClient } from "../studio/client.js";

/**
 * Wraps GET /api/me/revenue-summary — the owner-scoped endpoint added for this
 * server, which in turn wraps the Studio's single revenue implementation.
 *
 * `/api/analytics/revenue` cannot be used: it is superadmin-gated, so an
 * operator gets 403.
 */

/**
 * Mirrors `summariseRevenue` in the Studio (`lib/ai-chat/revenueBreakdown.ts`),
 * which is what `/api/me/revenue-summary` returns verbatim.
 *
 * This tool passes the response through untouched, so every field here belongs
 * to the Studio and every one is optional — see the note on `searchDocsOutput`.
 * The money numbers are described, not recomputed: the README's first rule is
 * that there is exactly one implementation of "what is this operator's
 * revenue", and it is not in this repo.
 */
const revenueFigures = {
  currency: z.string().optional(),
  revenue: z.number().optional().describe("main + reprint; the headline figure"),
  mainRevenue: z.number().optional(),
  reprintRevenue: z.number().optional(),
  aiEffectRevenue: z.number().optional().describe("Counted separately, NOT inside revenue"),
  gatewayRevenue: z.number().optional(),
  cashVoucherRevenue: z.number().optional(),
  discountVoucherRevenue: z.number().optional(),
  paidSessions: z.number().optional(),
  completedPaidSessions: z.number().optional().describe("Paid AND finished; the gap is money taken for sessions that never completed"),
};

export const getRevenueSummaryOutput = {
  found: z.boolean().optional(),
  source: z.string().optional().describe("Which ledger the figures came from"),
  groupBy: z.string().optional(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  buckets: z.array(z.object({ period: z.string().optional(), ...revenueFigures })).optional(),
  totals: z.array(z.object(revenueFigures)).optional(),
  /** True when more than one currency is present — do NOT sum across them. */
  mixedCurrency: z.boolean().optional(),
  reconciliation: z
    .object({
      lifetimeRevenue: z.number().nullable().optional(),
      bucketedRevenue: z.number().optional(),
      coversLifetimeTotal: z.boolean().optional(),
      unaccounted: z.number().nullable().optional(),
    })
    .optional(),
};

export const getRevenueSummaryInput = {
  groupBy: z.enum(["month", "day"]).optional().describe("Bucket size (default month)"),
  from: z.string().optional().describe("Start date, ISO YYYY-MM-DD. Omit for all time."),
  to: z.string().optional().describe("End date, ISO YYYY-MM-DD. Omit for all time."),
};

export function buildGetRevenueSummary(studio: StudioClient) {
  return {
    name: "get_revenue_summary",
    config: {
      title: "Get revenue summary",
      description:
        "Business revenue from this operator's photobooth sessions across EVERY payment channel — gateway payments, cash vouchers (cash collected at the booth) and discount vouchers — grouped by month or day and by currency, with extra-print revenue and AI-effect purchases reported separately. Use this for any question about income, revenue or omzet. It is also the right tool when wallet earnings look too small: cash and voucher money never reaches the wallet ledger, so for operators who take cash the wallet figure legitimately understates income.",
      inputSchema: getRevenueSummaryInput,
      outputSchema: getRevenueSummaryOutput,
    },
    handler: async (args: { groupBy?: "month" | "day"; from?: string; to?: string }) =>
      studio.get<unknown>("/api/me/revenue-summary", {
        groupBy: args.groupBy,
        from: args.from,
        to: args.to,
      }),
  };
}
