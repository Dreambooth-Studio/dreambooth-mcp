import type { StudioClient } from "../studio/client.js";
import { StudioError } from "../studio/errors.js";
import type { JobContext } from "../jobs/store.js";

/**
 * What `start_booth`, `refine_booth` and `create_booth` share: the Studio's
 * onboarding contract, the shape a finished draft is reported in, the sentences
 * its refusals become, and the small pieces of /new that a connector has to
 * carry itself (starter-frame matching, progress narration).
 *
 * The Studio's `/new` wizard already designs a whole booth from a sentence —
 * spec, welcome screens for phone and laptop, in-booth background, the booth's
 * own frames — and creates it. These tools drive THE SAME routes rather than a
 * connector-specific copy, so a booth designed from chat and one designed at
 * dreambooth.app/new are one code path with one set of caps and one log.
 *
 * ## The routes
 *
 *   POST /api/onboarding/generate       { prompt, locale }                  new draft, 1 of 3
 *   POST /api/onboarding/generate       { draftId, regenTarget, hint }      redraw, 1 of 5 each
 *   POST /api/onboarding/generate       { draftId, prompt }                 rebuild, 1 of 3
 *   GET  /api/onboarding/progress       ?draftId                            narration
 *   POST /api/onboarding/draft-frames   { draftId }                         the booth's own 3 frames
 *   GET  /api/onboarding/frames, /catalog, /api/ai-effects/catalog          what /new picks from
 *   POST /api/projects/onboarding       { title, slug, draftId, … }         the booth, for real
 *
 * A draft lives in the Studio for seven days. Its id comes back to the model
 * as a plain value, so a conversation can continue after the job that made it
 * has been swept from this process.
 */

/** generate / rebuild: the route declares maxDuration 300; /new waits 330 s. */
export const BOOTH_GENERATE_TIMEOUT_MS = 330_000;
/** draft-frames: maxDuration 300 for three sequential image generations. */
export const DRAFT_FRAMES_TIMEOUT_MS = 310_000;
/** projects/onboarding: a thumbnail render plus a few writes. */
export const BOOTH_CREATE_TIMEOUT_MS = 60_000;
/** A design or redraw job: one generate call plus margin. */
export const BOOTH_JOB_MAX_RUNTIME_MS = 6 * 60_000;
/** A create job: slug check, frames (≤5 min), picks, create, lookup. */
export const CREATE_JOB_MAX_RUNTIME_MS = 8 * 60_000;

export const DRAFT_ID_RE = /^dft_[a-f0-9]{24}$/;
/** The Studio's own slug rule (app/api/projects/onboarding). */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const OBJECT_ID_RE = /^[a-f0-9]{24}$/;

/**
 * Where a created booth answers to the public.
 *
 * The consumer host, the one /new's "go live" strip hands out — not the
 * Studio's API origin, which is a different site. A plain constant because it
 * is a fact about the product, not a per-environment setting.
 */
export const BOOTH_PUBLIC_ORIGIN = "https://dreambooth.app";

/** How many catalogue frames /new pre-selects for a fresh booth. */
export const STARTER_FRAME_COUNT = 3;
/** Polling for frames another request is already drawing — /new's numbers. */
export const DRAW_POLL_ATTEMPTS = 6;
export const DRAW_POLL_INTERVAL_MS = 8_000;
/** How often the progress endpoint is read while a rebuild runs. */
export const PROGRESS_POLL_MS = 5_000;

/* --------------------------------------------------------------- shapes --- */

/** The subset of the Studio's BoothSpec these tools read. */
export interface BoothSpecLike {
  title?: string;
  slugBase?: string;
  palette?: {
    backgroundColor?: string;
    primaryColor?: string;
    secondaryColor?: string;
    dark?: boolean;
  };
  welcome?: { headline?: string; subtext?: string; cta?: string };
  captureMode?: string;
  frameTags?: string[];
  filterMood?: string;
  locale?: string;
}

/** What POST /api/onboarding/generate answers with (`draftResponse()`). */
export interface BoothDraftReply {
  draftId?: string;
  slug?: string;
  spec?: BoothSpecLike | null;
  designMode?: string;
  assets?: {
    welcomeBgPortrait?: string;
    welcomeBgLandscape?: string;
    appBg?: string;
    logoUrl?: string;
  };
  remaining?: { fullGenerations?: number; regens?: number };
  regeneratedOrientations?: string[];
}

/**
 * A finished design or redraw job: enough for the model to show the draft,
 * redraw it, or create it — and for `create_booth` to match starter frames.
 */
export interface BoothDraftResult {
  draftId: string;
  slug: string;
  title: string;
  headline: string;
  subtext: string;
  cta: string;
  captureMode: string;
  language: string;
  palette: {
    backgroundColor: string;
    primaryColor: string;
    secondaryColor: string;
    dark: boolean;
  };
  welcomePortraitUrl: string;
  welcomeLandscapeUrl: string;
  appBackgroundUrl: string;
  logoUrl?: string;
  frameTags: string[];
  filterMood: string;
  remainingFullGenerations: number;
  remainingRegens: number;
  /** Which welcome orientations a redraw touched ("portrait" / "landscape"). */
  regenerated?: string[];
}

/** A finished create job. */
export interface BoothCreated {
  projectId?: string;
  slug: string;
  title: string;
  boothUrl: string;
  dashboardUrl: string;
  /** The booth's rendered welcome thumbnail, else the draft's welcome design — so the card can show it. */
  imageUrl?: string;
  ownFrameCount: number;
  catalogFrameCount: number;
  filterCount: number;
  aiEffect?: string;
}

/**
 * Reads a generate/regen reply into the shape the model gets.
 *
 * Throws rather than returning half a draft: a reply without a spec or a
 * draft id is not a booth the operator can look at, and "done" with nothing
 * to show is the claim these tools exist to avoid.
 */
export function summariseDraft(reply: BoothDraftReply): BoothDraftResult {
  const spec = reply?.spec;
  if (!reply?.draftId || !spec) {
    throw new StudioError(
      "Dreambooth answered without a booth design. Nothing was created; try start_booth again.",
      502,
      false
    );
  }
  const palette = spec.palette ?? {};
  return {
    draftId: reply.draftId,
    slug: reply.slug || spec.slugBase || "",
    title: spec.title ?? "",
    headline: spec.welcome?.headline ?? "",
    subtext: spec.welcome?.subtext ?? "",
    cta: spec.welcome?.cta ?? "",
    captureMode: spec.captureMode ?? "standard",
    language: spec.locale ?? "en",
    palette: {
      backgroundColor: palette.backgroundColor ?? "",
      primaryColor: palette.primaryColor ?? "",
      secondaryColor: palette.secondaryColor ?? "",
      dark: palette.dark === true,
    },
    welcomePortraitUrl: reply.assets?.welcomeBgPortrait || "",
    welcomeLandscapeUrl: reply.assets?.welcomeBgLandscape || "",
    appBackgroundUrl: reply.assets?.appBg || "",
    logoUrl: reply.assets?.logoUrl || undefined,
    frameTags: Array.isArray(spec.frameTags) ? spec.frameTags.map(String) : [],
    filterMood: spec.filterMood ?? "",
    remainingFullGenerations: reply.remaining?.fullGenerations ?? 0,
    remainingRegens: reply.remaining?.regens ?? 0,
    regenerated: reply.regeneratedOrientations,
  };
}

/* --------------------------------------------------------------- errors --- */

export type BoothStage = "generate" | "refine" | "frames" | "create" | "lookup";

/**
 * Turns a Studio refusal on the booth routes into the sentence the operator
 * needs — what happened, and what is still possible.
 *
 * The Studio's own wording is kept wherever it already says that; this adds
 * the next step, because a model reading "Regeneration limit reached" will
 * otherwise guess at one. Two answers are translated outright: the 401 that
 * means the Studio has not been updated to admit the connector here, and the
 * 404 that means the digital-mode feature is off — both read as the
 * operator's fault if relayed raw, and neither is.
 */
export function boothErrorFor(err: unknown, stage: BoothStage): StudioError {
  if (!(err instanceof StudioError)) {
    return new StudioError(err instanceof Error ? err.message : String(err), 0, false);
  }
  const m = err.message;

  switch (err.status) {
    case 401:
      if (/sign in to (generate|save)/i.test(m)) {
        return new StudioError(
          "Dreambooth refused this connection for booth generation. That usually means the Studio update that admits the connector here is not deployed yet — the operator can still build the booth at dreambooth.app/new.",
          401,
          false
        );
      }
      return err;
    case 404:
      if (/^nothing found at/i.test(m) || /^not found\.?$/i.test(m)) {
        return new StudioError(
          "Booth generation is not enabled on this Dreambooth right now (the digital-mode feature is off). Nothing was generated.",
          404,
          false
        );
      }
      if (/draft not found/i.test(m)) {
        return new StudioError(
          "That draft is not available to this account — it may have expired (drafts last 7 days) or belong to another account. Start again with start_booth.",
          404,
          false
        );
      }
      return err;
    case 409:
      return new StudioError(
        `${m} Ask the operator for another link name and call create_booth again — the draft and its drawn frames are intact.`,
        409,
        false
      );
    case 429:
      // "Regeneration limit" contains "generation limit": test the narrower
      // sentence first.
      if (/regeneration limit/i.test(m)) {
        return new StudioError(
          "This draft has used all 5 of its redraws. Create it as it is, or start a new draft.",
          429,
          false
        );
      }
      if (/generation limit/i.test(m)) {
        return new StudioError(
          "This draft has used all 3 of its full generations. Refine the welcome or background with refine_booth, create it as it is, or start a new draft.",
          429,
          false
        );
      }
      if (/too many booths/i.test(m)) {
        return new StudioError(`${m} Try again in an hour.`, 429, false);
      }
      return err;
    case 500:
      if (stage === "generate" || stage === "refine") {
        // generationCount only moves on success, so a retry costs nothing.
        return new StudioError(
          `${m} A failed generation does not count against the draft's allowance, so one retry is safe.`,
          500,
          true
        );
      }
      return err;
    case 504:
      if (stage === "generate") {
        return new StudioError(
          "Dreambooth took longer than 5½ minutes to design the booth and the draft could not be retrieved from here. Start again with start_booth — it counts as a new draft.",
          504,
          false
        );
      }
      if (stage === "refine") {
        return new StudioError(
          "Dreambooth took longer than 5½ minutes on the redraw, and it may still have landed on the draft. Do not repeat the same change blindly — each attempt spends a redraw; ask the operator before trying again.",
          504,
          false
        );
      }
      if (stage === "create") {
        return new StudioError(
          "Dreambooth did not answer in time, and the booth may still have been created. Check list_projects or the dashboard before calling create_booth again.",
          504,
          false
        );
      }
      return err;
    default:
      return err;
  }
}

/* ------------------------------------------------------------- progress --- */

/** The Studio's progress steps as a sentence the operator can be told. */
export function progressLabel(step: string): string {
  switch (step) {
    case "spec":
      return "Designing the booth — title, colours and copy…";
    case "welcome_portrait":
      return "Drawing the welcome screen for phones…";
    case "welcome_landscape":
      return "Drawing the welcome screen for laptops…";
    case "app_bg":
      return "Painting the in-booth background…";
    case "done":
      return "Finishing…";
    default:
      return "Starting…";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `work` while narrating the draft's pipeline position into the job.
 *
 * Only a rebuild of an EXISTING draft can be narrated — a new draft's id is
 * not known until the reply arrives, and redraws do not stamp progress. Poll
 * failures are swallowed: narration must never fail the generation it
 * describes.
 */
export async function withDraftProgress<T>(
  studio: StudioClient,
  draftId: string,
  ctx: JobContext,
  work: () => Promise<T>,
  pollMs = PROGRESS_POLL_MS
): Promise<T> {
  let stopped = false;
  const poll = async () => {
    while (!stopped) {
      try {
        const r = await studio.get<{ step?: string }>("/api/onboarding/progress", { draftId });
        if (!stopped && typeof r?.step === "string") ctx.progress(progressLabel(r.step));
      } catch {
        /* narration is best-effort */
      }
      await sleep(pollMs);
    }
  };
  void poll();
  try {
    return await work();
  } finally {
    stopped = true;
  }
}

/* -------------------------------------------------------- starter frames --- */

/**
 * The three catalogue frames /new pre-selects for a fresh booth.
 *
 * A port of `pickStarterFrames` in the booth app's StepFramesV2: `pool` arrives
 * in popularity order, so an unmatched booth still gets the three templates
 * most guests actually use, and a booth whose spec named "scrapbook" or "y2k"
 * gets those first. Ties keep the incoming order.
 */
export function pickStarterFrames(
  pool: Array<{ _id: string; name?: string }>,
  terms: string[],
  count = STARTER_FRAME_COUNT
): string[] {
  const words = terms
    .flatMap((t) => String(t).toLowerCase().split(/[^a-z0-9]+/))
    .filter((t) => t.length >= 3);

  return pool
    .map((frame, order) => {
      const name = String(frame.name ?? "").toLowerCase();
      const hits = words.reduce((n, term) => (name.includes(term) ? n + 1 : n), 0);
      return { frame, hits, order };
    })
    .sort((a, b) => b.hits - a.hits || a.order - b.order)
    .slice(0, count)
    .map((entry) => String(entry.frame._id));
}

/* --------------------------------------------------------------- copy --- */

export const BOOTH_STARTED_NOTE =
  "Started. Designing a booth usually takes 60-120 seconds — call check_generation with this jobId. " +
  "Nothing has been designed or created yet, so do not describe the booth as made.";

export const BOOTH_CREATE_STARTED_NOTE =
  "Started. This takes 2-6 minutes: the booth's own three frames are drawn first, then the booth is created. " +
  "Nothing exists yet — call check_generation; it reports each stage. Do not call create_booth again for this draft while it runs.";
