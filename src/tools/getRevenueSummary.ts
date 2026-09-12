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
/**
 * Every field below is the Studio's to shape, and this handler is a straight
 * passthrough — it returns the route's body untouched. That makes this the one
 * schema in the connector where a surprising value is most likely, and the
 * consequence is not a wrong number: `structuredContent` that fails its
 * published schema raises a PROTOCOL error, and clients answer those by
 * retrying rather than relaying, so the operator gets a hang instead of a
 * sentence. A wrong output schema is worse than no output schema.
 *
 * `.optional()` does not cover it. It tolerates a field being ABSENT and still
 * throws when the field is PRESENT with another type — a `null` from an empty
 * aggregation bucket, a Decimal128 that serialises as an object, a count the
 * route starts returning as a string. Two `.nullable()` patches already in
 * this file (`from`, `lifetimeRevenue`) are that lesson learned one field at a
 * time; `.catch()` ends it for all of them.
 *
 * The generated JSON Schema still carries the documented shape, so the model
 * learns what to expect — an unexpected value just becomes `undefined` instead
 * of taking the whole answer down with it.
 *
 * ## `.catch()` alone is not enough, and the reason is easy to miss
 *
 * The server validates `structuredContent` against this zod object and then
 * sends the ORIGINAL body — not what zod parsed. So `.catch()` stops the
 * server throwing and changes nothing about what goes on the wire. The client
 * validates that wire payload against the PUBLISHED JSON SCHEMA, which still
 * says `revenue` is a number, and raises -32602. The operator gets a retry
 * loop either way.
 *
 * So the handler parses, and returns what came out. That is what actually
 * makes the emitted object match its own schema, and it closes a second hole
 * at the same time: the published schema carries `additionalProperties: false`,
 * so a passthrough would break the moment the route learned a new field.
 */
const figure = (description?: string) => {
  const base = z.number().optional();
  return (description ? base.describe(description) : base).catch(undefined);
};

const revenueFigures = {
  currency: z.string().optional().catch(undefined),
  revenue: figure("main + reprint; the headline figure"),
  mainRevenue: figure(),
  reprintRevenue: figure(),
  aiEffectRevenue: figure("Counted separately, NOT inside revenue"),
  gatewayRevenue: figure(),
  cashVoucherRevenue: figure(),
  discountVoucherRevenue: figure(),
  paidSessions: figure(),
  completedPaidSessions: figure("Paid AND finished; the gap is money taken for sessions that never completed"),
};

export const getRevenueSummaryOutput = {
  found: z.boolean().optional().catch(undefined),
  source: z.string().optional().describe("Which ledger the figures came from").catch(undefined),
  groupBy: z.string().optional().catch(undefined),
  from: z.string().nullable().optional().catch(undefined),
  to: z.string().nullable().optional().catch(undefined),
  buckets: z
    .array(z.object({ period: z.string().optional().catch(undefined), ...revenueFigures }))
    .optional()
    .catch(undefined),
  totals: z.array(z.object(revenueFigures)).optional().catch(undefined),
  /** True when more than one currency is present — do NOT sum across them. */
  mixedCurrency: z.boolean().optional().catch(undefined),
  reconciliation: z
    .object({
      lifetimeRevenue: z.number().nullable().optional().catch(undefined),
      bucketedRevenue: figure(),
      coversLifetimeTotal: z.boolean().optional().catch(undefined),
      unaccounted: z.number().nullable().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
};

/** The same shape, as one object, so the handler can emit what it publishes. */
const revenueSummarySchema = z.object(getRevenueSummaryOutput);

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
    handler: async (args: { groupBy?: "month" | "day"; from?: string; to?: string }) => {
      const body = await studio.get<unknown>("/api/me/revenue-summary", {
        groupBy: args.groupBy,
        from: args.from,
        to: args.to,
      });
      // Every field is optional and every leaf carries `.catch()`, so this
      // cannot throw on a surprising value — only drop it. A body that is not
      // an object at all answers as an empty summary, which reads as "nothing
      // found" rather than as a hang.
      const parsed = revenueSummarySchema.safeParse(body);
      return parsed.success ? parsed.data : {};
    },
  };
}
