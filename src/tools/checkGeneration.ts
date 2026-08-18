import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import type { Config } from "../config.js";
import { jobs, type Job } from "../jobs/store.js";

/**
 * Reports on work `generate_frame` started.
 *
 * Reads memory in this process — it never calls the Studio — which is why it
 * is cheap enough to poll and why it must be honest about not knowing. A job
 * id it cannot find is not evidence that nothing was created: this store is
 * per-process, so a restart loses running jobs while the Studio carries on and
 * finishes them. The answer in that case names the dashboard rather than
 * reporting a failure that may not have happened.
 *
 * `readOnlyHint: true` is true and load-bearing here: a client may call this
 * without asking, which is what makes polling tolerable.
 */

export const checkGenerationOutput = {
  kind: z.literal("frame"),
  state: z.string(),
  what: z.string(),
  frameId: z.string().optional(),
  name: z.string().optional(),
  isPublic: z.boolean().optional(),
  canvasWidth: z.number().optional(),
  canvasHeight: z.number().optional(),
  placeholderCount: z.number().optional(),
  thumbnailUrl: z.string().optional(),
  dashboardUrl: z.string().optional(),
  error: z.string().optional(),
};

interface CreatedFrame {
  frameId?: string;
  name?: string;
  isPublic?: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
  placeholderCount?: number;
  thumbnailUrl?: string;
}

export function buildCheckGeneration(studio: StudioClient, config: Config) {
  return {
    name: "check_generation",
    config: {
      title: "Check a generation",
      description:
        "Report on a frame generation started by generate_frame. Call it with the jobId that returned, or with no arguments to get the most recent one. " +
        "While it says 'running', nothing has been created yet and the operator should be told it is still going — wait several seconds before calling again rather than polling tightly. " +
        "This reads a status and creates nothing, so it is always safe to call.",
      inputSchema: {
        jobId: z
          .string()
          .optional()
          .describe("The id generate_frame returned. Omit to report on the most recent generation."),
      },
      outputSchema: checkGenerationOutput,
    },
    handler: async (args: { jobId?: string }) => {
      const ownerKey = studio.ownerKey();

      const job: Job<CreatedFrame> | null | undefined = args.jobId
        ? jobs.get<CreatedFrame>(ownerKey, args.jobId)
        : jobs.list<CreatedFrame>(ownerKey)[0];

      if (!job) {
        return {
          kind: "frame" as const,
          state: "unknown",
          what: "",
          error: args.jobId
            ? "No generation with that id is being tracked. It may have finished before a restart, or belonged to a different connection — check the dashboard before starting another, because one may already have been created."
            : "No generation has been started on this connection.",
          dashboardUrl: `${config.apiUrl}/dashboard/frames`,
        };
      }

      if (job.state === "running") {
        return {
          kind: "frame" as const,
          state: "running",
          what: job.label,
          // Elapsed rather than a percentage: there is no progress to report,
          // and inventing one would be a number the operator would rely on.
          note: `Still generating, ${Math.round((Date.now() - job.startedAt) / 1000)}s so far. Nothing has been created yet.`,
        };
      }

      if (job.state === "failed") {
        return {
          kind: "frame" as const,
          state: "failed",
          what: job.label,
          // The Studio's own sentence where there is one — a used-up daily
          // allowance says when it resets, which is the thing the operator
          // actually needs.
          error: job.error?.message ?? "The generation failed.",
        };
      }

      const frame = job.result ?? {};
      return {
        kind: "frame" as const,
        state: "done",
        what: job.label,
        frameId: frame.frameId,
        name: frame.name,
        isPublic: frame.isPublic,
        canvasWidth: frame.canvasWidth,
        canvasHeight: frame.canvasHeight,
        placeholderCount: frame.placeholderCount,
        thumbnailUrl: frame.thumbnailUrl,
        dashboardUrl: frame.frameId
          ? `${config.apiUrl}/dashboard/frames/${frame.frameId}`
          : `${config.apiUrl}/dashboard/frames`,
      };
    },
  };
}
