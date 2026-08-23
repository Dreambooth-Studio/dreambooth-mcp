import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import { StudioError } from "../studio/errors.js";
import {
  DRAFT_ID_RE,
  DRAFT_READ_TIMEOUT_MS,
  OBJECT_ID_RE,
  SLUG_RE,
  boothErrorFor,
  resolveAiEffect,
  summariseDraft,
  type BoothDraftReply,
  type BoothDraftResult,
} from "./boothGeneration.js";
import { BOOTH_DRAFT_OUTPUT } from "./checkGeneration.js";
import { DRAFT_READ_NOTE } from "./getBoothDraft.js";

/**
 * Changes a booth draft without a redraw — the edits the dashboard's project
 * editor offers, made before the booth exists.
 *
 * The first real round showed the shape of the gap: a draft's title, button
 * text, colours, capture settings, language, frames and filters were all fixed
 * at create time to what the image model and the defaults produced, and the
 * only lever in conversation was a redraw. This is the other lever. It edits
 * the DRAFT — `PATCH /api/onboarding/draft` — and the Studio applies what it
 * holds when `create_booth` runs. A created booth is still never touched from
 * here; that stays the dashboard's job, as the listing says.
 *
 * Two things it cannot do, and says so: the welcome headline and subtext of a
 * "designed" draft are painted into the image, so they need `refine_booth`; and
 * prices, packages and watermarks are configured in the dashboard only.
 *
 * Synchronous (one PATCH), idempotent (sending the same edits twice leaves the
 * same draft), and every field the Studio could not apply comes back by name
 * in `rejected` so the model can tell the operator which word did not land.
 */

const settingsSchema = z
  .object({
    welcome: z.object({ startWithPayment: z.boolean().optional() }).strict().optional(),
    capture: z
      .object({
        captureCount: z.number().int().min(1).max(10).optional(),
        captureCountdown: z.number().int().min(1).max(15).optional(),
        prepTimeout: z.number().int().min(5).max(300).optional(),
        captureTimeout: z.number().int().min(30).max(1800).optional(),
        selfPhotoDuration: z.number().int().min(30).max(1800).optional(),
        gifEnabled: z.boolean().optional(),
        gifSpeed: z.number().int().min(200).max(5000).optional(),
        recordingEnabled: z.boolean().optional(),
        recordingSpeed: z.number().int().min(1).max(4).optional(),
      })
      .strict()
      .optional(),
    retake: z
      .object({
        enabled: z.boolean().optional(),
        retakeTimeout: z.number().int().min(5).max(600).optional(),
        maxRetakeCount: z.number().int().min(-1).max(20).nullable().optional(),
        maxRetakeSession: z.number().int().min(-1).max(20).nullable().optional(),
      })
      .strict()
      .optional(),
    select: z
      .object({ enabled: z.boolean().optional(), selectionTimeout: z.number().int().min(10).max(600).optional() })
      .strict()
      .optional(),
    frame: z.object({ displayFrameTitle: z.boolean().optional() }).strict().optional(),
    filter: z
      .object({
        enabled: z.boolean().optional(),
        useLivePreview: z.boolean().optional(),
        applyAfterCapture: z.boolean().optional(),
      })
      .strict()
      .optional(),
    checkout: z
      .object({
        enabled: z.boolean().optional(),
        checkoutTimeout: z.number().int().min(10).max(600).optional(),
        promoEnabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    payment: z
      .object({ enabled: z.boolean().optional(), paymentTimeout: z.number().int().min(30).max(900).optional() })
      .strict()
      .optional(),
    result: z
      .object({
        resultTimeout: z.number().int().min(10).max(600).optional(),
        askUserConsent: z.boolean().optional(),
        emailEnabled: z.boolean().optional(),
        reprintEnabled: z.boolean().optional(),
        reprintTimeout: z.number().int().min(10).max(600).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const paletteSchema = z
  .object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  })
  .strict();

export const updateBoothDraftInput = {
  draftId: z.string().regex(DRAFT_ID_RE).describe("The draft to change, from check_generation or get_booth_draft."),
  title: z.string().min(2).max(80).optional().describe("The booth's name (used as the title at create time)."),
  slug: z
    .string()
    .min(3)
    .max(44)
    .regex(SLUG_RE)
    .optional()
    .describe("The proposed link name (dreambooth.app/<slug>): lowercase letters, digits, single hyphens. Checked for availability; a taken one is reported, not stored."),
  buttonText: z.string().min(1).max(32).optional().describe("The welcome screen's button label, e.g. 'Mulai' or 'Start'."),
  headline: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Welcome headline. Only drafts whose welcome is laid out as text accept it; on an AI-designed welcome it is painted into the image and the reply says to use refine_booth."),
  subtext: z.string().min(1).max(140).optional().describe("Welcome subtext; same rule as headline."),
  language: z.string().min(2).max(10).optional().describe("Language code of the booth's own text: 'id', 'en', 'es'."),
  captureMode: z.enum(["standard", "frame-based"]).optional().describe("'standard' = classic strip, 'frame-based' = frame mode."),
  palette: paletteSchema.optional().describe("Theme colours as #RRGGBB: primaryColor, secondaryColor, backgroundColor. Only the ones given change."),
  frameIds: z
    .array(z.string().regex(OBJECT_ID_RE))
    .max(20)
    .optional()
    .describe("Frames the booth should carry (replaces the draft's list): e.g. one saved with save_frame, or catalogue ids. create_booth adds starter frames anyway."),
  filterIds: z
    .array(z.string().regex(OBJECT_ID_RE))
    .max(20)
    .optional()
    .describe("Filters the booth should carry (replaces the draft's list): e.g. one made with create_filter. The default 'Normal' is added anyway."),
  aiEffectTitle: z
    .string()
    .max(80)
    .optional()
    .describe("The title of a public AI effect to add, exactly as the operator named it; an empty string removes the one chosen before."),
  settings: settingsSchema
    .optional()
    .describe(
      "Page settings, as the dashboard editor has them, keyed by page: welcome{startWithPayment}, capture{captureCount 1-10, captureCountdown 1-15, prepTimeout, captureTimeout, selfPhotoDuration, gifEnabled, gifSpeed, recordingEnabled, recordingSpeed}, retake{enabled, retakeTimeout, maxRetakeCount, maxRetakeSession}, select{enabled, selectionTimeout}, frame{displayFrameTitle}, filter{enabled, useLivePreview, applyAfterCapture}, checkout{enabled, checkoutTimeout, promoEnabled}, payment{enabled, paymentTimeout}, result{resultTimeout, askUserConsent, emailEnabled, reprintEnabled, reprintTimeout}. Prices and packages are set in the dashboard, not here."
    ),
};

export const updateBoothDraftOutput = {
  kind: z.literal("booth-draft"),
  jobId: z.string(),
  state: z.string(),
  what: z.string(),
  draftId: z.string(),
  draft: BOOTH_DRAFT_OUTPUT.optional(),
  applied: z.array(z.string()).optional(),
  rejected: z.array(z.object({ field: z.string(), reason: z.string() })).optional(),
  slugAvailable: z.boolean().optional(),
  note: z.string().optional(),
  error: z.string().optional(),
};

export interface UpdateBoothDraftArgs {
  draftId: string;
  title?: string;
  slug?: string;
  buttonText?: string;
  headline?: string;
  subtext?: string;
  language?: string;
  captureMode?: "standard" | "frame-based";
  palette?: { primaryColor?: string; secondaryColor?: string; backgroundColor?: string };
  frameIds?: string[];
  filterIds?: string[];
  aiEffectTitle?: string;
  settings?: Record<string, Record<string, boolean | number | null>>;
}

export interface UpdateBoothDraftResult {
  kind: "booth-draft";
  jobId: string;
  state: string;
  what: string;
  draftId: string;
  draft?: BoothDraftResult;
  applied?: string[];
  rejected?: Array<{ field: string; reason: string }>;
  slugAvailable?: boolean;
  note?: string;
  error?: string;
}

/** What goes to the Studio: the fields, by their names there, never spread from args. */
export async function patchBodyFor(studio: StudioClient, args: UpdateBoothDraftArgs): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { draftId: args.draftId };
  if (args.title !== undefined) body.title = args.title;
  if (args.slug !== undefined) body.slug = args.slug;
  if (args.buttonText !== undefined) body.cta = args.buttonText;
  if (args.headline !== undefined) body.headline = args.headline;
  if (args.subtext !== undefined) body.subtext = args.subtext;
  if (args.language !== undefined) body.language = args.language;
  if (args.captureMode !== undefined) body.captureMode = args.captureMode;
  if (args.palette !== undefined) body.palette = args.palette;
  if (args.frameIds !== undefined) body.frameIds = args.frameIds;
  if (args.filterIds !== undefined) body.filterIds = args.filterIds;
  if (args.settings !== undefined) body.settings = args.settings;
  if (args.aiEffectTitle !== undefined) {
    // A name from the operator becomes the catalogue id the Studio stores;
    // an empty name removes the effect chosen before.
    body.aiEffectId = args.aiEffectTitle.trim() ? (await resolveAiEffect(studio, args.aiEffectTitle)).id : null;
  }
  return body;
}

export function buildUpdateBoothDraft(studio: StudioClient) {
  return {
    name: "update_booth_draft",
    config: {
      title: "Change a booth draft's settings",
      description:
        "Change a booth draft without a redraw: its title, link name, welcome button text, colours, capture mode, language, which frames and filters it carries, its AI effect, and the page settings the dashboard editor offers (photo count, countdown, timeouts, GIF/recording, retake, checkout, payment, result). " +
        "Use it after check_generation shows the draft and the operator asks for one of these; what it sets is applied when create_booth runs. " +
        "It cannot change the welcome headline or subtext of an AI-designed welcome (those are painted into the image — use refine_booth), and prices or packages are set in the dashboard. " +
        "Answers at once with the updated draft, `applied` (what landed) and `rejected` (what did not, and why) — relay a rejection as a sentence, never as success. " +
        "It never touches a booth that already exists.",
      inputSchema: updateBoothDraftInput,
      outputSchema: updateBoothDraftOutput,
    },
    handler: async (args: UpdateBoothDraftArgs): Promise<UpdateBoothDraftResult> => {
      const failed = (error: string): UpdateBoothDraftResult => ({
        kind: "booth-draft" as const,
        jobId: "",
        state: "failed",
        what: args.title ?? "booth draft",
        draftId: args.draftId,
        error,
      });

      let body: Record<string, unknown>;
      try {
        body = await patchBodyFor(studio, args);
      } catch (err) {
        if (err instanceof StudioError) return failed(err.message);
        throw err;
      }
      if (Object.keys(body).length === 1) {
        return failed("Nothing to change was given. Name at least one field: title, slug, buttonText, language, captureMode, palette, frameIds, filterIds, aiEffectTitle or settings.");
      }

      let reply: BoothDraftReply;
      try {
        reply = await studio.patch<BoothDraftReply>("/api/onboarding/draft", body, {}, { timeoutMs: DRAFT_READ_TIMEOUT_MS });
      } catch (err) {
        throw boothErrorFor(err, "edit");
      }
      const draft = summariseDraft(reply);
      const applied = Array.isArray(reply.applied) ? reply.applied : [];
      const rejected = Array.isArray(reply.rejected) ? reply.rejected : [];
      const note =
        (applied.length
          ? `Applied: ${applied.join(", ")}. `
          : "Nothing was applied — every field was rejected; tell the operator why. ") +
        (rejected.length ? `Not applied: ${rejected.map((r) => `${r.field} ${r.reason}`).join("; ")}. ` : "") +
        DRAFT_READ_NOTE;

      return {
        kind: "booth-draft" as const,
        jobId: "",
        state: "done",
        what: draft.title || args.draftId,
        draftId: args.draftId,
        draft,
        applied,
        rejected,
        ...(typeof reply.slugAvailable === "boolean" ? { slugAvailable: reply.slugAvailable } : {}),
        note,
      };
    },
  };
}
