import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import { jobs, JobLimitError } from "../jobs/store.js";
import { StudioError } from "../studio/errors.js";
import {
  FRAME_LAYOUTS,
  FRAME_LAYOUT_KEYS,
  FRAME_SHAPES,
  STARTED_NOTE,
  labelFor,
  sendFramePrompt,
  type FrameLayout,
  type FrameShape,
  type FrameThread,
  type GenerationResult,
} from "./frameGeneration.js";

/**
 * Opens a design thread and makes its first version, in the background.
 *
 * Two Studio calls in one job — `POST /api/ai/frames/start` to pick a blank
 * template and open the thread, then `POST /api/ai/threads/{id}/messages` to
 * generate — because neither half is useful to a model on its own: a thread
 * with no image in it is not something an operator can react to.
 *
 * It returns a handle, not a result. Frame generation is an image-model call
 * of 30–90 s and a tool call that blocks that long reads as a hung server to
 * every MCP client, so `check_generation` reports on it — the same shape
 * `connect_account` uses for the device flow.
 *
 * What it does NOT do is create a frame. The result is a preview in a thread,
 * exactly as in the dashboard's Frame Studio; `save_frame` is the step that
 * puts something in the operator's frame list, and only for the generation
 * they chose.
 */

export const startFrameOutput = {
  kind: z.literal("generation"),
  jobId: z.string(),
  state: z.string(),
  what: z.string(),
  /**
   * Everything the handler can return has to be declared here, optional or
   * not. The JSON Schema published from this object carries
   * `additionalProperties: false`, and a client that validates results — the
   * official SDK client does — turns an undeclared key into a -32602 protocol
   * error, which the operator experiences as a hang. The server's own check
   * is this zod object, which strips unknown keys and passes, so nothing on
   * this side notices. `scripts/generationTools.test.ts` round-trips through a
   * real client for exactly that reason.
   */
  note: z.string().optional(),
  error: z.string().optional(),
};

export function buildStartFrame(studio: StudioClient) {
  return {
    name: "start_frame",
    config: {
      title: "Start designing a photo frame",
      description:
        "Start designing a new photo frame for this operator's booths from a description of the look they want — 'batik motifs in warm gold', 'minimal Scandinavian, lots of white space'. " +
        "It opens a design thread and makes the FIRST version. It returns immediately with a job id; call check_generation to see the result, and do NOT describe the frame as made until that says so. " +
        "The result is a preview in the thread — nothing is in the operator's frame list until save_frame is called with the generation they choose. To change a result, call refine_frame with the threadId that check_generation returns, rather than starting again. " +
        "Every generation spends part of the account's free daily allowance, so do not call this speculatively, twice for the same request, or while another generation is still running.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "What the frame should look like, in the operator's own words where possible: decoration, colour, mood, occasion. Not the photo slots — those come from the layout. Do not name brands, characters or franchises; the image model refuses them."
          ),
        layout: z
          .enum(FRAME_LAYOUT_KEYS)
          .describe(
            "How many photos and how they sit. " +
              FRAME_LAYOUT_KEYS.map((k) => `'${k}': ${FRAME_LAYOUTS[k]}`).join("; ") +
              ". Ask if it is not obvious from what the operator said; 'strip-3' is what most people mean by a photobooth strip."
          ),
        shape: z
          .enum(FRAME_SHAPES)
          .optional()
          .describe(
            "The shape the photos are cut to. Defaults to rectangular. Not every layout comes in every shape; the Studio picks the closest available."
          ),
      },
      outputSchema: startFrameOutput,
    },
    handler: async (args: { prompt: string; layout: FrameLayout; shape?: FrameShape }) => {
      // Resolved before the job starts, so a bad credential fails here — where
      // the model is still in a tool call that can say so — rather than inside
      // background work nobody is waiting on.
      const ownerKey = studio.ownerKey();
      const what = labelFor(args.prompt);

      try {
        const job = jobs.start<GenerationResult>(ownerKey, what, async () => {
          /**
           * Built field by field, never spread from `args`. A spread would
           * forward anything the model invented, `ownerEmail` above all — which
           * the Studio refuses outright, but which should never leave this
           * process.
           */
          const thread = await studio.post<FrameThread>("/api/ai/frames/start", {
            layout: args.layout,
            shape: args.shape,
          });
          if (!thread?.threadId) {
            throw new StudioError(
              "Dreambooth did not open a design thread. Nothing was generated; try again in a moment.",
              502,
              false
            );
          }
          const generated = await sendFramePrompt(studio, thread.threadId, args.prompt);
          return {
            threadId: thread.threadId,
            templateId: thread.templateId,
            layout: thread.layout ?? args.layout,
            shape: thread.shape,
            canvasWidth: thread.canvasWidth,
            canvasHeight: thread.canvasHeight,
            placeholderCount: thread.placeholderCount,
            generationId: generated.generationId,
            imageUrl: generated.imageUrl,
          };
        });

        return {
          kind: "generation" as const,
          jobId: job.id,
          state: job.state,
          what,
          note: STARTED_NOTE,
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
