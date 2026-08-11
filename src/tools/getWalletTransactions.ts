import { z } from "zod";
import type { StudioClient } from "../studio/client.js";

/**
 * Wraps GET /api/wallet-transactions.
 *
 * Named "wallet" rather than "balance" on purpose. The wallet ledger holds
 * gateway earnings and withdrawals only — cash and voucher money never reaches
 * it. An operator who takes cash will find this number lower than their actual
 * income, and the description says so, because a model that reports it as
 * "your revenue" is giving a wrong answer with confidence.
 */

/** See the note on `searchDocsOutput`. Ledger rows pass through untouched. */
export const getWalletTransactionsOutput = {
  returned: z.number(),
  total: z.number().optional().describe("Rows matching the filter, across all pages"),
  /**
   * True when the row cap was hit, so this is a WINDOW and not the whole
   * ledger. Without it the model cannot tell a complete list from a truncated
   * one, and will describe ten rows as "your transactions".
   */
  truncated: z.boolean(),
  transactions: z.array(z.unknown()),
};

export const getWalletTransactionsInput = {
  limit: z.number().int().min(1).max(50).optional().describe("Max rows (default 10)"),
  from: z.string().optional().describe("Start date, ISO YYYY-MM-DD"),
  to: z.string().optional().describe("End date, ISO YYYY-MM-DD"),
};

interface WalletResponse {
  transactions?: unknown[];
  pagination?: { total?: number; totalPages?: number };
}

export function buildGetWalletTransactions(studio: StudioClient) {
  return {
    name: "get_wallet_transactions",
    config: {
      title: "Get wallet transactions",
      description:
        "This operator's wallet ledger: gateway earnings, withdrawals and refunds, newest first. Use for questions about the wallet, payouts or withdrawals. Do NOT use it to answer 'how much did I earn' — the wallet excludes cash and voucher income entirely, so for operators who take cash it understates real revenue. Use get_revenue_summary for income.",
      inputSchema: getWalletTransactionsInput,
      outputSchema: getWalletTransactionsOutput,
    },
    handler: async (args: { limit?: number; from?: string; to?: string }) => {
      const data = await studio.get<WalletResponse>("/api/wallet-transactions", {
        limit: String(args.limit ?? 10),
        from: args.from,
        to: args.to,
      });
      const rows = data.transactions ?? [];
      return {
        returned: rows.length,
        total: data.pagination?.total,
        truncated: (data.pagination?.total ?? rows.length) > rows.length,
        transactions: rows,
      };
    },
  };
}
