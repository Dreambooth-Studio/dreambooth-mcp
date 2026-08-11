import { z } from "zod";
import type { StudioClient } from "../studio/client.js";

/**
 * Wraps GET /api/gallery — already Bearer-capable.
 *
 * Returns the counts only, never the image list: a model does not need 12 media
 * URLs to answer "how many photos did we take", and returning them would burn
 * the operator's context window for nothing.
 */

export const getGalleryStatsInput = {
  projectId: z
    .string()
    .optional()
    .describe("Limit to one booth. Omit for every booth this operator owns."),
  includeExpired: z
    .boolean()
    .optional()
    .describe("Count media past its retention window too (default false)"),
};

/** Counts only — never media. See the note on `searchDocsOutput`. */
export const getGalleryStatsOutput = {
  totalCount: z.number(),
  activeCount: z.number().optional().describe("Still inside the retention window"),
  expiredCount: z.number().optional().describe("Past retention and no longer downloadable"),
};

interface GalleryResponse {
  totalCount: number;
  stats?: { totalCount: number; expiredCount: number; activeCount: number };
}

export function buildGetGalleryStats(studio: StudioClient) {
  return {
    name: "get_gallery_stats",
    config: {
      title: "Get gallery statistics",
      description:
        "How much media this operator's booths have produced: total, still active, and expired past the retention window. Call this when the operator asks how many photos or videos a booth has taken, or whether media is being lost to retention. Returns counts only, not the media itself.",
      inputSchema: getGalleryStatsInput,
      outputSchema: getGalleryStatsOutput,
    },
    handler: async (args: { projectId?: string; includeExpired?: boolean }) => {
      const data = await studio.get<GalleryResponse>("/api/gallery", {
        projectId: args.projectId,
        includeExpired: args.includeExpired ? "true" : undefined,
        limit: "1",
      });

      return {
        totalCount: data.stats?.totalCount ?? data.totalCount ?? 0,
        activeCount: data.stats?.activeCount,
        expiredCount: data.stats?.expiredCount,
      };
    },
  };
}
