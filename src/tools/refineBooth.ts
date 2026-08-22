import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import { jobs, JobLimitError } from "../jobs/store.js";
import { labelFor } from "./frameGeneration.js";
import {
  BOOTH_GENERATE_TIMEOUT_MS,
  BOOTH_JOB_MAX_RUNTIME_MS,
  BOOTH_STARTED_NOTE,
  DRAFT_ID_RE,
  boothErrorFor,
  summariseDraft,
  withDraftProgress,
  type BoothDraftReply,
  type BoothDraftResult,
} from "./boothGeneration.js";

/**
 * One more turn on a booth draft, in the background.
 *
 * Three things /new lets a creator change after the first build, each through
 * the same `POST /api/onboarding/generate` route:
 *
 *   welcome         redraw the welcome screen from an instruction — in edit
 *                   mode, so the design is kept and only the instruction is
 *                   applied; one orientation, or both
 *   app-background  redraw the calmer backdrop behind the rest of the booth
 *   everything      rebuild the whole draft from a NEW description
 *
 * Orientation is an explicit argument rather than a word in the hint. The
 * Studio can route "make the laptop title bigger" to landscape on its own,
 * but an argument is deterministic and costs the operator nothing extra;
 * a redraw of both orientations spends two of the draft's five.
 *
 * The draft id is an argument, not remembered: the job store keeps a finished
 * job fifteen minutes and nothing across a restart, while the draft lives in
 * the Studio for seven days.
 */

const MAX_HINT_CHARS = 300;

export const refineBoothOutput = {
  kind: z.literal("booth-draft"),
  jobId: z.string(),
  state: z.string(),
  what: z.string(),
  draftId: z.string().optional(),
  note: z.string().optional(),
  error: z.string().optional(),
};

type RefineWhat = "welcome" | "app-background" | "everything";
type Orientation = "phone" | "laptop";

/** The handle `refine_booth` returns; mirrors `refineBoothOutput`. */
export interface RefineBoothHandle {
  kind: "booth-draft";
  jobId: string;
  state: string;
  what: string;
  draftId?: string;
  note?: string;
  error?: string;
}

/** Which Studio body a refinement is. Exported for the tests. */
export function refineBody(args: {
  draftId: string;
  what: RefineWhat;
  instruction: string;
  orientation?: Orientation;
}): Record<string, unknown> {
  if (args.what === "everything") {
    return { draftId: args.draftId, prompt: args.instruction };
  }
  if (args.what === "app-background") {
    return { draftId: args.draftId, regenTarget: "appBg", hint: args.instruction };
  }
  const regenTarget =
    args.orientation === "phone"
      ? "welcomeBgPortrait"
      : args.orientation === "laptop"
        ? "welcomeBgLandscape"
        : "welcome";
  return { draftId: args.draftId, regenTarget, hint: args.instruction };
}

export function buildRefineBooth(studio: StudioClient) {
  return {
    name: "refine_booth",
    config: {
      title: "Refine a booth draft",
      description:
        "Change a booth draft from start_booth, using the draftId check_generation returned. " +
        "what='welcome' redraws the welcome screen from an instruction ('warmer colours', 'bigger headline', 'less clutter') while keeping the design; add orientation 'phone' or 'laptop' to redraw only that screen (1 redraw) — without it both screens are redrawn (2). " +
        "what='app-background' redraws the calmer backdrop behind the rest of the booth (1 redraw). " +
        "what='everything' rebuilds the whole draft from a NEW full description (spends 1 of the draft's 3 full generations) — only when the operator wants a different booth, not a tweak. " +
        "A draft has 5 redraws in total; check_generation reports what is left. Title, headline, link name and colours cannot be edited directly: they change only through a redraw instruction, or at create time (title, slug). " +
        "Returns a job id; call check_generation. Call only when the operator asks for a change — never iterate on your own.",
      inputSchema: {
        draftId: z
          .string()
          .regex(DRAFT_ID_RE)
          .describe("The draft to change, from check_generation's result for start_booth."),
        what: z
          .enum(["welcome", "app-background", "everything"])
          .describe("Which part to change. 'everything' is a full rebuild from a new description."),
        instruction: z
          .string()
          .min(1)
          .max(1000)
          .describe(
            "For 'welcome' / 'app-background': what to change, in the operator's words, up to 300 characters — the current design is kept and only this is applied. For 'everything': the new full description of the booth, up to 1000 characters."
          ),
        orientation: z
          .enum(["phone", "laptop"])
          .optional()
          .describe(
            "Only with what='welcome': redraw just the phone (portrait) or laptop (landscape) screen. Omit to redraw both."
          ),
      },
      outputSchema: refineBoothOutput,
    },
    handler: async (args: {
      draftId: string;
      what: RefineWhat;
      instruction: string;
      orientation?: Orientation;
    }): Promise<RefineBoothHandle> => {
      const ownerKey = studio.ownerKey();
      const what = labelFor(args.instruction);
      const failed = (error: string): RefineBoothHandle => ({
        kind: "booth-draft" as const,
        jobId: "",
        state: "failed",
        what,
        draftId: args.draftId,
        error,
      });

      // Two refusals the schema cannot express, answered as results rather
      // than protocol errors so the model gets the sentence.
      if (args.what !== "everything" && args.instruction.length > MAX_HINT_CHARS) {
        return failed(
          `A redraw instruction is limited to ${MAX_HINT_CHARS} characters. Shorten it, or use what='everything' with a full new description.`
        );
      }
      if (args.orientation && args.what !== "welcome") {
        return failed("orientation only applies to what='welcome'. Leave it out for other changes.");
      }

      const body = refineBody(args);

      try {
        const job = jobs.start<BoothDraftResult>(
          ownerKey,
          what,
          async (ctx) => {
            const call = async () => {
              try {
                return await studio.post<BoothDraftReply>("/api/onboarding/generate", body, {}, {
                  timeoutMs: BOOTH_GENERATE_TIMEOUT_MS,
                });
              } catch (err) {
                throw boothErrorFor(err, "refine");
              }
            };
            // Only a full rebuild stamps the Studio's progress steps; a redraw
            // is one image call, and its elapsed time is the honest signal.
            const reply =
              args.what === "everything"
                ? await withDraftProgress(studio, args.draftId, ctx, call)
                : await call();
            return summariseDraft(reply);
          },
          { kind: "booth-draft", maxRuntimeMs: BOOTH_JOB_MAX_RUNTIME_MS, ref: args.draftId }
        );

        return {
          kind: "booth-draft" as const,
          jobId: job.id,
          state: job.state,
          what,
          draftId: args.draftId,
          note: BOOTH_STARTED_NOTE,
        };
      } catch (err) {
        if (err instanceof JobLimitError) return failed(err.message);
        throw err;
      }
    },
  };
}
