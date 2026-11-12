import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import { DRAFT_ID_RE, readBoothDraft, type BoothDraftResult } from "./boothGeneration.js";
import { BOOTH_DRAFT_OUTPUT } from "./checkGeneration.js";

/**
 * Reads a booth draft back from the Studio.
 *
 * The job store forgets a finished design after fifteen minutes and everything
 * after a restart, while the draft itself lives in the Studio for seven days.
 * Before this tool, a draft whose job had been swept could only be regenerated
 * (a full generation, one of three) to be looked at again. Now the draftId is
 * enough: the same summary check_generation shows, plus whatever the draft
 * has been given with update_booth_draft.
 *
 * Read-only, and `GET` on the Studio, so a read-scoped connection can use it.
 */

export const getBoothDraftOutput = {
  kind: z.literal("booth-draft"),
  jobId: z.string(),
  state: z.string(),
  what: z.string(),
  draftId: z.string(),
  draft: BOOTH_DRAFT_OUTPUT.optional(),
  note: z.string().optional(),
  error: z.string().optional(),
};

export interface GetBoothDraftResult {
  kind: "booth-draft";
  jobId: string;
  state: string;
  what: string;
  draftId: string;
  draft?: BoothDraftResult;
  note?: string;
  error?: string;
}

export const DRAFT_READ_NOTE =
  "This is a draft, not a booth. update_booth_draft changes its title, button text, colours, capture settings, language, frames, filters and AI effect without a redraw; " +
  "refine_booth redraws the welcome or background; create_booth makes it real.";

export function buildGetBoothDraft(studio: StudioClient) {
  return {
    name: "get_booth_draft",
    config: {
      title: "Read a booth draft",
      description:
        "Read a booth draft by its draftId — the same summary check_generation gives for a finished design, plus everything the draft has been given since (settings, chosen frames, filters, AI effect). " +
        "Use it when the job from start_booth is no longer tracked, to show the draft again before create_booth, or to confirm what update_booth_draft applied. " +
        "Reads only; nothing is generated or created. A draft lives 7 days on the operator's account.",
      inputSchema: {
        draftId: z.string().regex(DRAFT_ID_RE).describe("The draft, from check_generation or a previous tool result."),
      },
      outputSchema: getBoothDraftOutput,
    },
    handler: async (args: { draftId: string }): Promise<GetBoothDraftResult> => {
      const draft = await readBoothDraft(studio, args.draftId);
      return {
        kind: "booth-draft" as const,
        jobId: "",
        state: "done",
        what: draft.title || args.draftId,
        draftId: args.draftId,
        draft,
        note: DRAFT_READ_NOTE,
      };
    },
  };
}
