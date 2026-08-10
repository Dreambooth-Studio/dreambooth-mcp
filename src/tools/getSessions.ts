import { z } from "zod";
import type { StudioClient } from "../studio/client.js";

/**
 * Wraps GET /api/sessions — already accepts Bearer via resolveAuthSession, so
 * this tool needs no change on the Studio side.
 */

export const getSessionsInput = {
  startDate: z
    .string()
    .optional()
    .describe("ISO date (YYYY-MM-DD) for the start of the range, inclusive"),
  endDate: z
    .string()
    .optional()
    .describe("ISO date (YYYY-MM-DD) for the end of the range, inclusive"),
  projectIds: z
    .string()
    .optional()
    .describe("Comma-separated project ids to limit the range to specific booths"),
  transactionStatus: z
    .string()
    .optional()
    .describe("Payment status filter, e.g. settlement, pending"),
  sessionStatus: z.string().optional().describe("Session status filter"),
  paymentSource: z
    .string()
    .optional()
    .describe("Payment channel, e.g. gateway, cash-voucher, discount-voucher"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("How many sessions to return (default 20, max 100)"),
};

interface SessionsResponse {
  total: number;
  pagination?: { totalPages: number; currentPage: number };
  sessions: unknown[];
}

export function buildGetSessions(studio: StudioClient) {
  return {
    name: "get_sessions",
    config: {
      title: "Get photo sessions",
      description:
        "List the photo sessions recorded on this operator's booths, with totals. Call this when the operator asks how busy a booth has been, how many sessions ran in a period, or wants to inspect individual sessions. Supports date ranges, per-booth filtering, payment status and payment channel. For money totals rather than session counts, use get_revenue_summary instead.",
      inputSchema: getSessionsInput,
    },
    handler: async (args: {
      startDate?: string;
      endDate?: string;
      projectIds?: string;
      transactionStatus?: string;
      sessionStatus?: string;
      paymentSource?: string;
      limit?: number;
    }) => {
      const data = await studio.get<SessionsResponse>("/api/sessions", {
        startDate: args.startDate,
        endDate: args.endDate,
        projectIds: args.projectIds,
        transactionStatus: args.transactionStatus,
        sessionStatus: args.sessionStatus,
        paymentSource: args.paymentSource,
        limit: String(args.limit ?? 20),
      });

      return {
        total: data.total,
        returned: data.sessions?.length ?? 0,
        totalPages: data.pagination?.totalPages,
        sessions: data.sessions ?? [],
      };
    },
  };
}
