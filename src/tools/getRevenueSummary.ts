import { z } from "zod";
import type { StudioClient } from "../studio/client.js";

/**
 * Wraps GET /api/me/revenue-summary — the owner-scoped endpoint added for this
 * server, which in turn wraps the Studio's single revenue implementation.
 *
 * `/api/analytics/revenue` cannot be used: it is superadmin-gated, so an
 * operator gets 403.
 */

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
    },
    handler: async (args: { groupBy?: "month" | "day"; from?: string; to?: string }) =>
      studio.get<unknown>("/api/me/revenue-summary", {
        groupBy: args.groupBy,
        from: args.from,
        to: args.to,
      }),
  };
}
