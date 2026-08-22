import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import type { Config } from "../config.js";
import { jobs, type Job } from "../jobs/store.js";
import type { GenerationResult } from "./frameGeneration.js";

/**
 * Reports on work `start_frame` or `refine_frame` started.
 *
 * Reads memory in this process — it never calls the Studio — which is why it
 * is cheap enough to poll and why it must be honest about not knowing. A job
 * id it cannot find is not evidence that nothing happened: this store is
 * per-process, so a restart loses running jobs while the Studio carries on
 * and finishes them. The answer in that case names the dashboard rather than
 * reporting a failure that may not have happened.
 *
 * When it says `done` it hands the model the three things the next step
 * needs: `imageUrl` to show, `threadId` to refine with, `generationId` to
 * save. Those are plain values, not handles — the thread outlives this job
 * and this process, so a conversation can continue after the job is gone.
 *
 * `readOnlyHint: true` is true and load-bearing here: a client may call this
 * without asking, which is what makes polling tolerable.
 */

export const checkGenerationOutput = {
  kind: z.literal("generation"),
  state: z.string(),
  what: z.string(),
  // Every key the handler can return is declared: the published schema
  // forbids additional properties, so a key this list omits is a client-side
  // protocol error rather than a sentence the operator can read.
  note: z.string().optional(),
  threadId: z.string().optional(),
  generationId: z.string().optional(),
  imageUrl: z.string().optional(),
  layout: z.string().optional(),
  canvasWidth: z.number().optional(),
  canvasHeight: z.number().optional(),
  placeholderCount: z.number().optional(),
  error: z.string().optional(),
  dashboardUrl: z.string().optional(),
};

export function buildCheckGeneration(studio: StudioClient, config: Config) {
  return {
    name: "check_generation",
    config: {
      title: "Check a frame generation",
      description:
        "Report on a frame generation started by start_frame or refine_frame. Call it with the jobId that returned, or with no arguments to get the most recent one. " +
        "While it says 'running', nothing has been generated yet — tell the operator it is still going, and wait several seconds before calling again rather than polling tightly. " +
        "When it says 'done' it carries the preview imageUrl, the threadId to refine with and the generationId to save. A preview is not a frame: nothing is in the operator's frame list until save_frame. " +
        "This reads a status and creates nothing, so it is always safe to call.",
      inputSchema: {
        jobId: z
          .string()
          .optional()
          .describe(
            "The id start_frame or refine_frame returned. Omit to report on the most recent generation on this connection."
          ),
      },
      outputSchema: checkGenerationOutput,
    },
    handler: async (args: { jobId?: string }) => {
      const ownerKey = studio.ownerKey();

      const job: Job<GenerationResult> | null | undefined = args.jobId
        ? jobs.get<GenerationResult>(ownerKey, args.jobId)
        : jobs.list<GenerationResult>(ownerKey)[0];

      if (!job) {
        return {
          kind: "generation" as const,
          state: "unknown",
          what: "",
          error: args.jobId
            ? "No generation with that id is being tracked. It may have finished before a restart, or belonged to a different connection. If you still have the threadId, refine_frame continues the same thread; otherwise start again, or check the dashboard."
            : "No generation has been started on this connection.",
          dashboardUrl: `${config.apiUrl}/dashboard/frames`,
        };
      }

      if (job.state === "running") {
        return {
          kind: "generation" as const,
          state: "running",
          what: job.label,
          // Elapsed rather than a percentage: there is no progress to report,
          // and inventing one would be a number the operator would rely on.
          note: `Still generating, ${Math.round((Date.now() - job.startedAt) / 1000)}s so far. Nothing has been generated yet.`,
        };
      }

      if (job.state === "failed") {
        return {
          kind: "generation" as const,
          state: "failed",
          what: job.label,
          // The Studio's own sentence where there is one — a used-up daily
          // allowance says when it resets, a content block says what to
          // rephrase — which is the thing the operator actually needs.
          error: job.error?.message ?? "The generation failed.",
        };
      }

      const result = job.result;
      return {
        kind: "generation" as const,
        state: "done",
        what: job.label,
        threadId: result?.threadId,
        generationId: result?.generationId,
        imageUrl: result?.imageUrl,
        layout: result?.layout,
        canvasWidth: result?.canvasWidth,
        canvasHeight: result?.canvasHeight,
        placeholderCount: result?.placeholderCount,
        note: "This is a preview in the design thread, not a saved frame. Show it to the operator; refine_frame changes it, save_frame keeps it.",
      };
    },
  };
}
