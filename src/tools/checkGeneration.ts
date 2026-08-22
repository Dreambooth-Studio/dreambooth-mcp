import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import type { Config } from "../config.js";
import { jobs, type Job, type JobKind } from "../jobs/store.js";
import type { GenerationResult } from "./frameGeneration.js";
import type { BoothCreated, BoothDraftResult } from "./boothGeneration.js";

/**
 * Reports on any background work this server started: a frame generation
 * (`start_frame` / `refine_frame`), a booth design (`start_booth` /
 * `refine_booth`), or a booth creation (`create_booth`).
 *
 * One poll tool rather than one per kind, on purpose. The job store is shared,
 * so "the most recent job" has one answer; the model already knows this tool;
 * and a directory reviewer reads the tool list. The cost is a wider result
 * schema in which the kind decides which block is present — `draft` for a
 * designed booth, `booth` for a created one, the flat frame keys for a frame.
 *
 * Reads memory in this process — it never calls the Studio — which is why it
 * is cheap enough to poll and why it must be honest about not knowing. A job
 * id it cannot find is not evidence that nothing happened: this store is
 * per-process, so a restart loses running jobs while the Studio carries on.
 * The answer in that case says what still works (a draftId survives, a
 * created booth shows in list_projects) rather than reporting a failure that
 * may not have happened.
 *
 * `readOnlyHint: true` is true and load-bearing here: a client may call this
 * without asking, which is what makes polling tolerable.
 */

const BOOTH_DRAFT_OUTPUT = z.object({
  draftId: z.string(),
  slug: z.string(),
  title: z.string(),
  headline: z.string(),
  subtext: z.string(),
  cta: z.string(),
  captureMode: z.string(),
  language: z.string(),
  palette: z.object({
    backgroundColor: z.string(),
    primaryColor: z.string(),
    secondaryColor: z.string(),
    dark: z.boolean(),
  }),
  welcomePortraitUrl: z.string(),
  welcomeLandscapeUrl: z.string(),
  appBackgroundUrl: z.string(),
  logoUrl: z.string().optional(),
  frameTags: z.array(z.string()),
  filterMood: z.string(),
  remainingFullGenerations: z.number(),
  remainingRegens: z.number(),
  regenerated: z.array(z.string()).optional(),
});

const BOOTH_CREATED_OUTPUT = z.object({
  projectId: z.string().optional(),
  slug: z.string(),
  title: z.string(),
  boothUrl: z.string(),
  dashboardUrl: z.string(),
  ownFrameCount: z.number(),
  catalogFrameCount: z.number(),
  filterCount: z.number(),
  aiEffect: z.string().optional(),
});

export const checkGenerationOutput = {
  /** Which kind of work this reports on; "job" only when nothing was found. */
  kind: z.enum(["generation", "booth-draft", "booth", "job"]),
  jobId: z.string().optional(),
  state: z.string(),
  what: z.string(),
  // Every key the handler can return is declared: the published schema
  // forbids additional properties, so a key this list omits is a client-side
  // protocol error rather than a sentence the operator can read.
  note: z.string().optional(),
  progress: z.string().optional(),
  error: z.string().optional(),
  dashboardUrl: z.string().optional(),
  // A frame generation, flat — unchanged from before booths existed.
  threadId: z.string().optional(),
  generationId: z.string().optional(),
  imageUrl: z.string().optional(),
  layout: z.string().optional(),
  canvasWidth: z.number().optional(),
  canvasHeight: z.number().optional(),
  placeholderCount: z.number().optional(),
  // A booth designed (not yet created), and a booth created.
  draft: BOOTH_DRAFT_OUTPUT.optional(),
  booth: BOOTH_CREATED_OUTPUT.optional(),
};

const KIND_LABEL: Record<JobKind, string> = {
  generation: "generation",
  "booth-draft": "booth design",
  booth: "booth creation",
};

/**
 * The handler's result, typed once so every branch is the same shape to a
 * caller — a test reading `done.threadId` off a running answer gets
 * `undefined`, not a type error. Mirrors `checkGenerationOutput` exactly.
 */
export interface CheckGenerationResult {
  kind: JobKind | "job";
  jobId?: string;
  state: string;
  what: string;
  note?: string;
  progress?: string;
  error?: string;
  dashboardUrl?: string;
  threadId?: string;
  generationId?: string;
  imageUrl?: string;
  layout?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  placeholderCount?: number;
  draft?: BoothDraftResult;
  booth?: BoothCreated;
}

export function buildCheckGeneration(studio: StudioClient, config: Config) {
  return {
    name: "check_generation",
    config: {
      title: "Check background work",
      description:
        "Report on background work started by start_frame, refine_frame, start_booth, refine_booth or create_booth. Call it with the jobId that returned, or with no arguments for the most recent job on this connection of any kind. " +
        "While it says 'running', nothing exists yet — relay the progress line if there is one, tell the operator it is still going, and wait 10-15 seconds before calling again rather than polling tightly. " +
        "When it says 'done': a frame job carries imageUrl, threadId and generationId (a preview — nothing saved until save_frame); a booth design carries draft{…} (a draft — nothing created until create_booth); a booth creation carries booth{slug, boothUrl, projectId} — the one case where something now exists. " +
        "This reads a status and creates nothing, so it is always safe to call.",
      inputSchema: {
        jobId: z
          .string()
          .optional()
          .describe(
            "The id a start/refine/create tool returned. Omit to report on the most recent job on this connection."
          ),
      },
      outputSchema: checkGenerationOutput,
    },
    handler: async (args: { jobId?: string }): Promise<CheckGenerationResult> => {
      const ownerKey = studio.ownerKey();

      const job: Job<unknown> | null | undefined = args.jobId
        ? jobs.get<unknown>(ownerKey, args.jobId)
        : jobs.list<unknown>(ownerKey)[0];

      if (!job) {
        return {
          kind: "job" as const,
          state: "unknown",
          what: "",
          error: args.jobId
            ? "No job with that id is being tracked. It may have finished before a restart, or belonged to a different connection. " +
              "A threadId still works with refine_frame and save_frame; a draftId still works with refine_booth and create_booth; a booth that was being created may have finished — list_projects or the dashboard will show it."
            : "No background work has been started on this connection.",
          dashboardUrl: `${config.apiUrl}/dashboard`,
        };
      }

      const base = { kind: job.kind, jobId: job.id, what: job.label };

      if (job.state === "running") {
        return {
          ...base,
          state: "running",
          // Elapsed rather than a percentage: there is no progress to report,
          // and inventing one would be a number the operator would rely on.
          note: `Still running (${KIND_LABEL[job.kind]}), ${Math.round((Date.now() - job.startedAt) / 1000)}s so far. Nothing exists yet.`,
          progress: job.progress,
        };
      }

      if (job.state === "failed") {
        return {
          ...base,
          state: "failed",
          // The Studio's own sentence where there is one — a used-up daily
          // allowance says when it resets, a taken link name says to pick
          // another — which is the thing the operator actually needs.
          error: job.error?.message ?? `The ${KIND_LABEL[job.kind]} failed.`,
        };
      }

      if (job.kind === "booth-draft") {
        const draft = job.result as BoothDraftResult | undefined;
        return {
          ...base,
          state: "done",
          draft,
          note:
            "This is a draft, not a booth: show the operator the welcome preview and the title. " +
            "refine_booth changes it (redraws are limited per draft); create_booth makes it real — the title and link name are chosen then.",
        };
      }

      if (job.kind === "booth") {
        const booth = job.result as BoothCreated | undefined;
        return {
          ...base,
          state: "done",
          booth,
          dashboardUrl: booth?.dashboardUrl,
          note: booth
            ? `The booth now exists at ${booth.boothUrl}. It can be opened in the dashboard to edit; there is no tool that edits or deletes it.`
            : "The booth was created.",
        };
      }

      const result = job.result as GenerationResult | undefined;
      return {
        ...base,
        state: "done",
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
