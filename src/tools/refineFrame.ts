import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import { jobs, JobLimitError } from "../jobs/store.js";
import {
  STARTED_NOTE,
  labelFor,
  sendFramePrompt,
  type GenerationResult,
} from "./frameGeneration.js";

/**
 * One more turn in an existing design thread, in the background.
 *
 * A single prompt rarely lands. The dashboard's Frame Studio solves that with
 * conversation — the operator says "darker", "less ornament", "smaller
 * flowers" and the next generation is made with the whole thread as context,
 * earlier results and their feedback included. This is that turn, for a
 * connector: `POST /api/ai/threads/{threadId}/messages`, the exact route the
 * dashboard calls, so a refinement from chat and one from the Studio are the
 * same thing.
 *
 * The thread id is an argument and not remembered here on purpose. The job
 * store keeps a finished job for fifteen minutes and nothing across a restart;
 * the thread lives in the Studio for as long as the account does. Handing the
 * id back to the model as a plain value is what lets a conversation continue
 * after the handle that produced it is gone.
 */

export const refineFrameOutput = {
  kind: z.literal("generation"),
  jobId: z.string(),
  state: z.string(),
  what: z.string(),
  threadId: z.string().optional(),
  // Declared for the reason given on `startFrameOutput`: the published schema
  // forbids additional properties.
  note: z.string().optional(),
  error: z.string().optional(),
};

export function buildRefineFrame(studio: StudioClient) {
  return {
    name: "refine_frame",
    config: {
      title: "Refine a photo frame design",
      description:
        "Ask for a changed version of a frame in an existing design thread — 'darker', 'less ornament', 'make the flowers smaller', 'more gold'. " +
        "Call it with the threadId that check_generation returned for start_frame, and ONLY when the operator asks for a change: every call spends part of the account's free daily allowance, so never iterate on your own initiative. " +
        "It returns immediately with a job id; call check_generation for the new preview. Earlier versions in the thread stay available to save_frame, so a change the operator dislikes loses nothing.",
      inputSchema: {
        threadId: z
          .string()
          .min(1)
          .describe("The design thread, from check_generation's result for start_frame."),
        prompt: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "What to change, in the operator's words. It is read with the whole thread as context, so 'the same but darker' works; there is no need to repeat the original description."
          ),
      },
      outputSchema: refineFrameOutput,
    },
    handler: async (args: { threadId: string; prompt: string }) => {
      const ownerKey = studio.ownerKey();
      const what = labelFor(args.prompt);

      /**
       * The thread's geometry, from the job that opened it.
       *
       * A refinement is a new image on the SAME blank template — the layout,
       * the canvas and the photo windows cannot change, because the thread is
       * anchored to one template. But only `start_frame` is told what they
       * are, so every refinement used to answer with them missing and the
       * preview card lost its caption ("strip-3 · 1600x2400 · 6 photos") on
       * every version after the first.
       *
       * Read from this process, so it is gone after a restart. That is the
       * right trade: a caption is worth a map lookup and not worth a round
       * trip to the Studio, and a missing one degrades to what the card
       * already does today.
       */
      const opened = jobs
        .list<GenerationResult>(ownerKey)
        .find(
          (j) =>
            j.kind === "generation" &&
            j.state === "done" &&
            j.result?.threadId === args.threadId &&
            j.result?.layout !== undefined
        )?.result;

      try {
        const job = jobs.start<GenerationResult>(ownerKey, what, async (ctx) => {
          ctx.ref(args.threadId);
          const generated = await sendFramePrompt(studio, args.threadId, args.prompt);
          return {
            threadId: args.threadId,
            templateId: opened?.templateId,
            layout: opened?.layout,
            shape: opened?.shape,
            canvasWidth: opened?.canvasWidth,
            canvasHeight: opened?.canvasHeight,
            placeholderCount: opened?.placeholderCount,
            generationId: generated.generationId,
            imageUrl: generated.imageUrl,
          };
        });

        return {
          kind: "generation" as const,
          jobId: job.id,
          state: job.state,
          what,
          threadId: args.threadId,
          note: STARTED_NOTE,
        };
      } catch (err) {
        if (err instanceof JobLimitError) {
          return {
            kind: "generation" as const,
            jobId: "",
            state: "failed",
            what,
            threadId: args.threadId,
            error: err.message,
          };
        }
        throw err;
      }
    },
  };
}
