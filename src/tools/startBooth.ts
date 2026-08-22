import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import { jobs, JobLimitError } from "../jobs/store.js";
import { labelFor } from "./frameGeneration.js";
import {
  BOOTH_GENERATE_TIMEOUT_MS,
  BOOTH_JOB_MAX_RUNTIME_MS,
  BOOTH_STARTED_NOTE,
  boothErrorFor,
  summariseDraft,
  type BoothDraftReply,
  type BoothDraftResult,
} from "./boothGeneration.js";

/**
 * Designs a whole booth from a description, in the background.
 *
 * One Studio call — `POST /api/onboarding/generate` — the same one the /new
 * wizard makes when a creator presses "build": the Studio writes the spec
 * (title, colours, welcome copy, capture mode), draws the welcome screen for
 * phone and laptop, and paints the in-booth background. Sixty to a hundred and
 * twenty seconds, so this returns a handle and `check_generation` reports.
 *
 * What comes back is a DRAFT, deliberately: a booth in chat should be looked
 * at and argued with before it exists, exactly as at /new. `refine_booth`
 * changes it; `create_booth` is the only step that makes something real.
 *
 * No clarify step. /new may ask the creator a few questions first; the model
 * is already in a conversation and can ask its own, so the tool description
 * tells it to gather what /new would ask and put it in the prompt.
 */

export const startBoothOutput = {
  kind: z.literal("booth-draft"),
  jobId: z.string(),
  state: z.string(),
  what: z.string(),
  // Every key the handler can return is declared: the published schema
  // forbids additional properties.
  note: z.string().optional(),
  error: z.string().optional(),
};

export function buildStartBooth(studio: StudioClient) {
  return {
    name: "start_booth",
    config: {
      title: "Design a new booth",
      description:
        "Design a complete photobooth (a 'booth') for this operator from a description — the Studio designs the welcome screen for phone and laptop, the in-booth background, the colour theme, the capture mode, a title and a link name, exactly as dreambooth.app/new does. " +
        "Before calling, gather in chat what /new would ask and put ALL of it in the prompt: the occasion or business, the vibe or style, colours, and the language the booth should speak — there is no separate questions step. " +
        "It returns a job id immediately; call check_generation, and do NOT describe the booth as designed or created until that says done. " +
        "The result is a DRAFT with a draftId: nothing is in the operator's booth list until create_booth. " +
        "Every call makes a new draft and spends 1 of its 3 full generations, and an account may start 10 drafts an hour — never call it speculatively or twice for one request; change a draft with refine_booth instead.",
      inputSchema: {
        prompt: z
          .string()
          .min(3)
          .max(1000)
          .describe(
            "The booth, in the operator's words plus what you gathered: occasion or business, vibe and style, colours, mood, anything that must appear. Up to 1000 characters. Do not name brands, characters or franchises; the image model refuses them."
          ),
        language: z
          .string()
          .min(2)
          .max(10)
          .optional()
          .describe(
            "The language the booth's own text should be in, as a code: 'id', 'en', 'es'. Defaults to English — ask if the operator's booth is not in English."
          ),
      },
      outputSchema: startBoothOutput,
    },
    handler: async (args: { prompt: string; language?: string }) => {
      // Resolved before the job starts, so a bad credential fails here — where
      // the model is still in a tool call that can say so.
      const ownerKey = studio.ownerKey();
      const what = labelFor(args.prompt);

      try {
        const job = jobs.start<BoothDraftResult>(
          ownerKey,
          what,
          async (ctx) => {
            // A new draft's id is unknown until the reply, so there is nothing
            // to narrate against yet; the elapsed time is the honest signal.
            ctx.progress(
              "Designing the booth — title, colours, welcome screens and background. Usually 60-120 seconds."
            );
            let reply: BoothDraftReply;
            try {
              /**
               * Built field by field, never spread from `args`: identity is not
               * an argument, and nothing the model invented may reach the Studio.
               */
              reply = await studio.post<BoothDraftReply>(
                "/api/onboarding/generate",
                { prompt: args.prompt, locale: args.language },
                {},
                { timeoutMs: BOOTH_GENERATE_TIMEOUT_MS }
              );
            } catch (err) {
              throw boothErrorFor(err, "generate");
            }
            return summariseDraft(reply);
          },
          { kind: "booth-draft", maxRuntimeMs: BOOTH_JOB_MAX_RUNTIME_MS }
        );

        return {
          kind: "booth-draft" as const,
          jobId: job.id,
          state: job.state,
          what,
          note: BOOTH_STARTED_NOTE,
        };
      } catch (err) {
        if (err instanceof JobLimitError) {
          return {
            kind: "booth-draft" as const,
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
