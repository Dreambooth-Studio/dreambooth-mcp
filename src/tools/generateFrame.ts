import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import type { Config } from "../config.js";
import { jobs, JobLimitError } from "../jobs/store.js";

/**
 * Wraps POST /api/ai/frames/create, in the background.
 *
 * The only tool here that cannot answer in one call. Frame generation is an
 * image-model call — the Studio route declares `maxDuration = 120` — and this
 * service's request timeout is fifteen seconds. Waiting is not an option even
 * with a longer timeout: a tool call that blocks for two minutes reads as a
 * hung server to every MCP client. So this starts the work and returns a
 * handle, and `check_generation` reports on it. Same shape `connect_account`
 * uses for the device flow.
 *
 * It creates a real Frame, not a preview. `/api/ai/frames/generate` returns
 * image bytes and leaves persisting to its caller, which suits the dashboard
 * and is useless here — nobody is holding a blob in browser memory on behalf
 * of a connector, so a preview would spend a slice of the operator's daily
 * allowance and produce nothing.
 */

/**
 * The canvas sizes this tool will generate at, in pixels at 300 DPI.
 *
 * A named size rather than a width and a height, and that restriction is the
 * point. `drawParams.canvasWidth/Height` is the contract the booth renders and
 * prints against; a model translating "make it a photo strip" into numbers it
 * invented produces a frame that is created successfully and prints wrong,
 * which is the worst failure available here because nothing reports an error.
 *
 * An operator who wants a size that is not here changes it in the frame
 * editor, where they can see the result. This tool does not need to cover
 * every case to be useful; it needs to never produce a broken one.
 */
const CANVAS_PRESETS = {
  "strip-2x6": { width: 600, height: 1800, label: '2x6" photo strip' },
  "photo-4x6-portrait": { width: 1200, height: 1800, label: '4x6" portrait' },
  "photo-4x6-landscape": { width: 1800, height: 1200, label: '4x6" landscape' },
  "square-4x4": { width: 1200, height: 1200, label: '4x4" square' },
} as const;

type PresetKey = keyof typeof CANVAS_PRESETS;

export const generateFrameOutput = {
  kind: z.literal("generation"),
  jobId: z.string(),
  state: z.string(),
  what: z.string(),
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

export function buildGenerateFrame(studio: StudioClient, config: Config) {
  return {
    name: "generate_frame",
    config: {
      title: "Generate a photo frame",
      description:
        "Design a new photo frame for this operator's booths from a description of the look they want — 'batik motifs in warm gold', 'minimal Scandinavian, lots of white space'. " +
        "This takes up to two minutes, so it returns immediately with a job id and you must call check_generation to find out how it went; do NOT tell the operator it is finished until check_generation says so. " +
        "Generation is free but capped per day per account, so do not call it speculatively or more than once for the same request. " +
        "It creates a new frame and cannot change an existing one — to edit or delete a frame, send them to the dashboard.",
      inputSchema: {
        stylePrompt: z
          .string()
          .min(1)
          .max(600)
          .describe(
            "What the frame should look like, in the operator's own words where possible. Describe decoration, colour and mood — not the photo slots, which are placed by layout."
          ),
        size: z
          .enum(Object.keys(CANVAS_PRESETS) as [PresetKey, ...PresetKey[]])
          .describe(
            "Print size. '2x6\" photo strip' is the classic photobooth strip; 4x6 is a single postcard-sized print. Ask the operator if it is not obvious from what they said."
          ),
        placeholderCount: z
          .number()
          .int()
          .min(1)
          .max(12)
          .describe("How many photos appear in the frame. A classic strip is 3 or 4."),
        layoutIntent: z
          .enum(["single", "strip", "grid", "hero", "collage"])
          .describe(
            "How the photo windows are arranged. Use 'strip' for a vertical run of equal photos, 'single' for one, 'grid' for rows and columns, 'hero' for one large plus smaller ones."
          ),
        apertureFamily: z
          .enum(["rect", "rounded", "circle"])
          .optional()
          .describe("The shape photos are cut to. Defaults to rectangular."),
        decorativeDensity: z
          .enum(["minimal", "moderate", "rich"])
          .optional()
          .describe("How much decoration fills the space around the photos."),
        name: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe("What the operator will see in their frame list. Derived from the description when absent."),
        isPublic: z
          .boolean()
          .optional()
          .describe("Leave unset unless they explicitly ask to share it. Default is private to their account."),
      },
      outputSchema: generateFrameOutput,
    },
    handler: async (args: {
      stylePrompt: string;
      size: PresetKey;
      placeholderCount: number;
      layoutIntent: string;
      apertureFamily?: string;
      decorativeDensity?: string;
      name?: string;
      isPublic?: boolean;
    }) => {
      const preset = CANVAS_PRESETS[args.size];

      // Resolved before the job starts, so a bad credential fails here — where
      // the model is still in a tool call that can say so — rather than inside
      // background work nobody is waiting on.
      const ownerKey = studio.ownerKey();

      /**
       * Built field by field, never spread from `args`. A spread would forward
       * anything the model invented, `ownerEmail` above all — which the Studio
       * refuses outright, but which should never leave this process.
       */
      const body = {
        stylePrompt: args.stylePrompt,
        canvasWidth: preset.width,
        canvasHeight: preset.height,
        sizeLabel: preset.label,
        placeholderCount: args.placeholderCount,
        layoutIntent: args.layoutIntent,
        apertureFamily: args.apertureFamily ?? "rect",
        decorativeDensity: args.decorativeDensity ?? "moderate",
        name: args.name,
        isPublic: args.isPublic ?? false,
      };

      const what = args.name || `${preset.label} frame`;

      try {
        const job = jobs.start<CreatedFrame>(ownerKey, what, () =>
          studio.post<CreatedFrame>("/api/ai/frames/create", body)
        );

        return {
          kind: "generation" as const,
          jobId: job.id,
          state: job.state,
          what,
          // Said in the result rather than left to the description, because
          // this is the sentence the model needs at the moment it is deciding
          // what to tell the operator.
          note: `Started. This usually takes 30-90 seconds — call check_generation with this jobId to see how it went. Nothing exists yet, so do not describe the frame as created.`,
          dashboardUrl: `${config.apiUrl}/dashboard/frames`,
        };
      } catch (err) {
        if (err instanceof JobLimitError) {
          // Not a Studio failure, so it never reached writeErrorFor. Shaped
          // the same way a Studio refusal is: one sentence, not retryable.
          return {
            kind: "generation" as const,
            jobId: "",
            state: "failed",
            what,
            error: err.message,
          };
        }
        throw err;
      }
    },
  };
}
