import { randomUUID } from "node:crypto";
import type { StudioClient } from "../studio/client.js";
import { StudioError } from "../studio/errors.js";

/**
 * What `start_frame` and `refine_frame` share: the shape of a design thread,
 * how a prompt is sent to it, and how the Studio's reply is read.
 *
 * Frame Studio in the dashboard is a conversation — one thread anchored on a
 * blank template, many generations, the operator keeps one. The connector
 * follows that shape rather than inventing its own, because every other
 * arrangement turns each attempt into a frame somebody has to delete by hand.
 *
 * ## The routes
 *
 *   POST /api/ai/frames/start                  pick a blank template, open a thread
 *   POST /api/ai/threads/{threadId}/messages   generate once, in that thread
 *   POST /api/ai/frames/from-generation        turn the chosen generation into a Frame
 *
 * The middle one is the SAME route the dashboard and the /new onboarding flow
 * call. There is no connector-specific copy of the generation: the prompt, the
 * free-quota rule, the intent classifier and the AI-cost rows are the Studio's,
 * written once.
 */

/**
 * How long a background generation may wait on the Studio.
 *
 * `Config.requestTimeoutMs` (15 s) is right for every interactive call and
 * wrong for this one: an image-model round trip runs 30–90 s. The job store
 * presumes a job dead after three minutes, so this sits under that on
 * purpose — a generation that has not answered in 150 s is reported failed by
 * the same clock that would have swept it, not left "running" with nothing
 * coming.
 */
export const GENERATION_TIMEOUT_MS = 150_000;

/**
 * The layouts an operator can ask for, in their words.
 *
 * Each resolves SERVER-SIDE to one of the Studio's blank templates — this is
 * a vocabulary, not a catalogue. The connector never names a template id, so a
 * template renamed or added in the Studio changes nothing here, and a layout
 * the Studio stops offering comes back as the Studio's own sentence.
 */
export const FRAME_LAYOUTS = {
  "strip-3": "the classic photo strip — 3 photos stacked, printed as a pair on a 4x6",
  "strip-4": "a taller strip — 4 photos stacked, printed as a pair on a 4x6",
  "grid-4": "4 photos in a 2x2 grid on one 4x6",
  "hero-3": "one large photo with two smaller ones beneath it",
  "pair-2": "two landscape photos, one above the other",
} as const;
export type FrameLayout = keyof typeof FRAME_LAYOUTS;
export const FRAME_LAYOUT_KEYS = Object.keys(FRAME_LAYOUTS) as [FrameLayout, ...FrameLayout[]];

export const FRAME_SHAPES = ["rect", "rounded", "circle", "oval", "square"] as const;
export type FrameShape = (typeof FRAME_SHAPES)[number];

/** What POST /api/ai/frames/start answers with. */
export interface FrameThread {
  threadId: string;
  templateId?: string;
  layout?: string;
  shape?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  placeholderCount?: number;
}

/**
 * What a finished generation job holds: enough for the model to show the
 * preview, refine in the same thread, or save the generation as a frame.
 */
export interface GenerationResult extends FrameThread {
  generationId: string;
  imageUrl: string;
}

/** The shapes POST /api/ai/threads/{threadId}/messages answers with. */
interface MessagesReply {
  generation?: { _id?: string; status?: string };
  message?: { content?: string; failureReason?: string | null };
  imageUrls?: string[];
  freeQuotaBlocked?: boolean;
  freeQuotaReason?: string;
  quotaResetAt?: string;
  failureReason?: string;
}

/**
 * One generation in an existing thread.
 *
 * Three replies from the Studio mean "no image", and all three arrive as HTTP
 * 200 because the dashboard renders them in-thread: a used-up daily
 * allowance, a content-policy block, and a model that simply returned nothing.
 * Each becomes a non-retryable error carrying the Studio's own sentence —
 * those are written to be said to an operator, and "the generation failed"
 * is not.
 */
export async function sendFramePrompt(
  studio: StudioClient,
  threadId: string,
  prompt: string
): Promise<{ generationId: string; imageUrl: string }> {
  const reply = await studio.post<MessagesReply>(
    `/api/ai/threads/${encodeURIComponent(threadId)}/messages`,
    // generationRequestId is the Studio's idempotency key for this turn; the
    // route validates it as a UUID.
    { prompt, generationRequestId: randomUUID() },
    {},
    { timeoutMs: GENERATION_TIMEOUT_MS }
  );

  if (reply?.freeQuotaBlocked) {
    const resets = reply.quotaResetAt ? ` It resets at ${reply.quotaResetAt}.` : "";
    throw new StudioError(
      (reply.message?.content?.trim() || "Today's free frame generations are used up.") +
        resets,
      403,
      false
    );
  }

  const generationId = reply?.generation?._id;
  const imageUrl = reply?.imageUrls?.[0];
  if (!generationId || !imageUrl) {
    throw new StudioError(
      reply?.message?.content?.trim() ||
        "The model returned no image this time. Try rephrasing the description, or generate again.",
      502,
      false
    );
  }
  return { generationId: String(generationId), imageUrl };
}

/** "batik emas hangat, margin lebar, …" → a label the poll can answer with. */
export function labelFor(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 59).trimEnd()}…`;
}

/**
 * The sentence every start/refine handle carries.
 *
 * Said in the result rather than left to the description, because this is the
 * sentence the model needs at the moment it decides what to tell the operator.
 */
export const STARTED_NOTE =
  "Started. This usually takes 30-90 seconds — call check_generation with this jobId to see the preview. " +
  "Nothing has been generated or saved yet, so do not describe the frame as made.";
