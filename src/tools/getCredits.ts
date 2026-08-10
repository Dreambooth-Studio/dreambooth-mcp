import type { StudioClient } from "../studio/client.js";

/** Wraps GET /api/credits. */

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
