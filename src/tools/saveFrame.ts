import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import type { Config } from "../config.js";

/**
 * Wraps POST /api/ai/frames/from-generation.
 *
 * The only step in the frame flow that creates something the operator can
 * see. A generation is a preview in a thread until this turns it into a Frame:
 * the Studio fetches the chosen image, keys its photo windows transparent
 * from the blank template the thread was opened on, uploads the result, and
 * writes the Frame with the same `drawParams` the /new onboarding flow saves
 * — one implementation, not a second one here.
 *
 * Synchronous, unlike the generation tools: there is no image model in this
 * step, only a download, a cut and an upload, which fits inside the request
 * timeout. If it ever does not, the timeout message says to check the
 * dashboard rather than retry — the same rule as every other write here,
 * because the save may well have gone through.
 *
 * Requires an OAuth connection carrying `booths:write`. A read-only connection
 * gets a 403 whose sentence names the fix; see writeErrorFor.
 */

export const saveFrameOutput = {
  kind: z.literal("frame"),
  state: z.string(),
  frameId: z.string().optional(),
  name: z.string().optional(),
  isPublic: z.boolean().optional(),
  canvasWidth: z.number().optional(),
  canvasHeight: z.number().optional(),
  placeholderCount: z.number().optional(),
  thumbnailUrl: z.string().optional(),
  threadId: z.string().optional(),
  generationId: z.string().optional(),
  dashboardUrl: z.string().optional(),
};

interface SavedFrame {
  frameId?: string;
  name?: string;
  isPublic?: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
  placeholderCount?: number;
  thumbnailUrl?: string;
  threadId?: string;
  generationId?: string;
}

export function buildSaveFrame(studio: StudioClient, config: Config) {
  return {
    name: "save_frame",
    config: {
      title: "Save a generated frame",
      description:
        "Save one generation from a design thread as a real frame in this operator's frame list, with its photo windows cut out. Call it only when the operator has chosen a result — pass the threadId and generationId that check_generation returned for it. " +
        "This CREATES a frame: saving the same generation twice makes two frames, so do not retry a call that may have gone through. The frame is private to the account unless the operator explicitly asks for it to be shared. " +
        "After saving, the operator picks the frame in a booth's frame settings; this tool does not assign it to a booth, and there is no tool that edits or deletes a frame.",
      inputSchema: {
        threadId: z.string().min(1).describe("The design thread the generation belongs to."),
        generationId: z
          .string()
          .min(1)
          .describe("The generation to save, from check_generation. Each version in a thread has its own id."),
        name: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe(
            "What the operator will see in their frame list. Use their words if they named it; otherwise derived from the description."
          ),
        isPublic: z
          .boolean()
          .optional()
          .describe("Leave unset unless they explicitly ask to share it. Default is private to their account."),
      },
      outputSchema: saveFrameOutput,
    },
    handler: async (args: {
      threadId: string;
      generationId: string;
      name?: string;
      isPublic?: boolean;
    }) => {
      /**
       * Built field by field rather than spread from `args`: identity is not
       * an argument, and `ownerEmail` must never leave this process.
       */
      const saved = await studio.post<SavedFrame>("/api/ai/frames/from-generation", {
        threadId: args.threadId,
        generationId: args.generationId,
        name: args.name,
        isPublic: args.isPublic ?? false,
      });

      return {
        kind: "frame" as const,
        state: "done",
        frameId: saved?.frameId,
        name: saved?.name ?? args.name,
        isPublic: saved?.isPublic ?? args.isPublic ?? false,
        canvasWidth: saved?.canvasWidth,
        canvasHeight: saved?.canvasHeight,
        placeholderCount: saved?.placeholderCount,
        thumbnailUrl: saved?.thumbnailUrl,
        threadId: saved?.threadId ?? args.threadId,
        generationId: saved?.generationId ?? args.generationId,
        dashboardUrl: saved?.frameId
          ? `${config.apiUrl}/dashboard/frames/${saved.frameId}`
          : `${config.apiUrl}/dashboard/frames`,
      };
    },
  };
}
