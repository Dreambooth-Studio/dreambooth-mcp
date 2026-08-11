import { z } from "zod";
import type { StudioClient } from "../studio/client.js";

/** Wraps GET /api/credits. */

/** See the note on `searchDocsOutput` for why the Studio-owned fields are optional. */
export const getCreditsOutput = {
  credits: z.number().describe("AI credits remaining. NOT money — see get_wallet_transactions for that."),
  sessionCredits: z.number().optional(),
  videoCredits: z.number().optional(),
  plan: z.string().optional().describe("Subscription package name"),
  subscriptionEndDate: z.string().nullable().optional(),
};

interface CreditsResponse {
  credits?: number;
  sessionCredits?: number;
  videoCredits?: number;
  package?: string;
  subscriptionEndDate?: string | null;
  proTrialJustExpired?: boolean;
}

export function buildGetCredits(studio: StudioClient) {
  return {
    name: "get_credits",
    config: {
      title: "Get AI credits and plan",
      description:
        "This operator's remaining AI credit balance and their current subscription plan, including when it ends. Call this when they ask how many credits are left, whether they can still run AI effects, or what plan they are on. Credits are separate from wallet money — do not confuse the two.",
      inputSchema: {},
      outputSchema: getCreditsOutput,
    },
    handler: async () => {
      const data = await studio.get<CreditsResponse>("/api/credits");
      return {
        credits: data.credits ?? 0,
        sessionCredits: data.sessionCredits,
        videoCredits: data.videoCredits,
        plan: data.package,
        subscriptionEndDate: data.subscriptionEndDate ?? null,
      };
    },
  };
}
