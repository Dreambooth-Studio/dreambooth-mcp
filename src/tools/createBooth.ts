import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import type { Config } from "../config.js";
import { jobs, JobLimitError, type JobContext } from "../jobs/store.js";
import { StudioError } from "../studio/errors.js";
import {
  BOOTH_CREATE_STARTED_NOTE,
  BOOTH_CREATE_TIMEOUT_MS,
  BOOTH_PUBLIC_ORIGIN,
  CREATE_JOB_MAX_RUNTIME_MS,
  DRAFT_FRAMES_TIMEOUT_MS,
  DRAFT_ID_RE,
  DRAW_POLL_ATTEMPTS,
  DRAW_POLL_INTERVAL_MS,
  OBJECT_ID_RE,
  SLUG_RE,
  boothErrorFor,
  pickStarterFrames,
  type BoothCreated,
  type BoothDraftResult,
} from "./boothGeneration.js";

/**
 * Turns a booth draft into a booth — the one step in the booth flow that makes
 * something real, and therefore the one that replicates /new's last screens
 * rather than a single route:
 *
 *   1. is the link name free?                GET  /api/projects/by-slug?checkOnly
 *   2. which AI effect, if one was named?     GET  /api/ai-effects/catalog
 *   3. the booth's own three frames           POST /api/onboarding/draft-frames (drawn now, like /new's Strip step)
 *   4. three starter frames from the catalogue  GET /api/onboarding/frames (+ any the operator named)
 *   5. the Studio's default "Normal" filter   GET  /api/onboarding/catalog (+ any the operator named)
 *   6. the booth                               POST /api/projects/onboarding
 *   7. its id, for the dashboard link          GET  /api/projects/by-slug
 *
 * Steps 3–5 are what makes the created booth complete rather than bare: the
 * welcome design, theme and background come from the draft server-side; the
 * frames and filter are what /new would have pre-selected. The Studio
 * materialises the drawn frames itself; nothing here invents geometry.
 *
 * The slug is checked FIRST, before any image is drawn, because a taken link
 * is the common failure and three frames are the expensive step.
 *
 * A background job, because drawing frames can take five minutes. The job is
 * keyed to the draft (`ref`) so a second create for the same draft is refused
 * while one runs; a create after one finished is stopped by the slug check
 * if it repeats the slug, and is a deliberate second booth if it does not.
 */

export const createBoothOutput = {
  kind: z.literal("booth"),
  jobId: z.string(),
  state: z.string(),
  what: z.string(),
  draftId: z.string().optional(),
  slug: z.string().optional(),
  note: z.string().optional(),
  error: z.string().optional(),
};

interface DraftFramesReply {
  frames?: unknown[];
  status?: "ready" | "drawing" | "unavailable" | string;
}
interface FramesReply {
  items?: Array<{ _id: string; name?: string }>;
  mine?: Array<{ _id: string; name?: string }>;
}
interface CatalogReply {
  filters?: { official?: Array<{ _id?: string; name?: string }> };
}
interface EffectsReply {
  items?: Array<{ id?: string; title?: string }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function dedupe(ids: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface CreateBoothArgs {
  draftId: string;
  title: string;
  slug: string;
  captureMode?: "standard" | "frame-based";
  aiEffectTitle?: string;
  frameIds?: string[];
  filterIds?: string[];
}

/** The handle `create_booth` returns; mirrors `createBoothOutput`. */
export interface CreateBoothHandle {
  kind: "booth";
  jobId: string;
  state: string;
  what: string;
  draftId?: string;
  slug?: string;
  note?: string;
  error?: string;
}

/**
 * The work itself, exported so the tests can drive it stage by stage with a
 * fake Studio and a fake clock.
 */
export async function createBoothWork(
  studio: StudioClient,
  config: Config,
  args: CreateBoothArgs,
  ctx: JobContext,
  options: {
    /** The draft's frame tags + mood, for the starter-frame match. */
    draftTerms?: string[];
    /** The draft's welcome design, shown on the card if no thumbnail came back. */
    draftImage?: string;
    pollSleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<BoothCreated> {
  const wait = options.pollSleep ?? sleep;
  const get = async <T>(path: string, query: Record<string, string | undefined>) =>
    studio.get<T>(path, query);

  // 1. The link name, before anything expensive.
  ctx.progress("Checking the link name…");
  let available: { available?: boolean };
  try {
    available = await get<{ available?: boolean }>("/api/projects/by-slug", {
      slug: args.slug,
      checkOnly: "true",
    });
  } catch (err) {
    throw boothErrorFor(err, "create");
  }
  if (available?.available === false) {
    throw new StudioError(
      `The booth link "${args.slug}" is already taken. Ask the operator for another and call create_booth again — the draft is untouched.`,
      409,
      false
    );
  }

  // 2. The AI effect, resolved by title to an id — the operator says a name.
  let aiEffectId: string | undefined;
  let aiEffectTitle: string | undefined;
  if (args.aiEffectTitle?.trim()) {
    ctx.progress("Looking up the AI effect…");
    const wanted = args.aiEffectTitle.trim().toLowerCase();
    let effects: EffectsReply;
    try {
      effects = await get<EffectsReply>("/api/ai-effects/catalog", {});
    } catch (err) {
      throw boothErrorFor(err, "create");
    }
    const hit = (effects?.items ?? []).find(
      (e) => typeof e.title === "string" && e.title.trim().toLowerCase() === wanted
    );
    if (!hit?.id) {
      const names = (effects?.items ?? [])
        .map((e) => e.title)
        .filter(Boolean)
        .slice(0, 8)
        .join(", ");
      throw new StudioError(
        `No AI effect called "${args.aiEffectTitle.trim()}" is available.${names ? ` Available: ${names}.` : ""} Leave it out, or ask the operator which one.`,
        404,
        false
      );
    }
    aiEffectId = hit.id;
    aiEffectTitle = hit.title;
  }

  // 3. The booth's own frames. Best-effort by the route's own contract: a
  // booth without them is still a booth, and /new ships one too.
  ctx.progress("Drawing the booth's own three frames — up to five minutes…");
  let ownFrameCount = 0;
  for (let attempt = 0; attempt <= DRAW_POLL_ATTEMPTS; attempt++) {
    let reply: DraftFramesReply | null = null;
    try {
      reply = await studio.post<DraftFramesReply>(
        "/api/onboarding/draft-frames",
        { draftId: args.draftId },
        {},
        { timeoutMs: DRAFT_FRAMES_TIMEOUT_MS }
      );
    } catch {
      ctx.progress("The booth's own frames could not be drawn; continuing with catalogue frames.");
      break;
    }
    if (reply?.status === "drawing") {
      if (attempt === DRAW_POLL_ATTEMPTS) break;
      ctx.progress("The booth's frames are still being drawn…");
      await wait(DRAW_POLL_INTERVAL_MS);
      continue;
    }
    if (reply?.status === "ready") ownFrameCount = reply.frames?.length ?? 0;
    break;
  }

  // 4. Starter frames, the way /new picks them. The operator's own frames —
  // including ones saved with save_frame in this conversation — lead the pool.
  ctx.progress("Picking starter frames…");
  let starters: string[] = [];
  try {
    const reply = await get<FramesReply>("/api/onboarding/frames", {
      page: "1",
      pageSize: "24",
      mode: "creator",
    });
    const pool = [...(reply?.mine ?? []), ...(reply?.items ?? [])].filter((f) => f && f._id);
    starters = pickStarterFrames(pool, options.draftTerms ?? []);
  } catch {
    /* the drawn frames still lead server-side; a booth with no picks is fine */
  }
  const frameIds = dedupe([...(args.frameIds ?? []), ...starters]).slice(0, 24);

  // 5. The Studio's default filter, as /new force-selects it, plus any named.
  ctx.progress("Picking filters…");
  let normalId: string | undefined;
  try {
    const catalog = await get<CatalogReply>("/api/onboarding/catalog", { mode: "creator" });
    normalId = (catalog?.filters?.official ?? []).find(
      (f) => typeof f.name === "string" && f.name.trim().toLowerCase() === "normal"
    )?._id;
  } catch {
    /* without the catalogue the operator's own picks still apply */
  }
  const filterIds = dedupe([normalId, ...(args.filterIds ?? [])]).slice(0, 24);

  // 6. The booth. No `theme`: the route falls back to the draft's palette,
  // which is exactly what /new sends. Built field by field.
  ctx.progress("Creating the booth…");
  let created: { slug?: string };
  try {
    created = await studio.post<{ slug?: string }>(
      "/api/projects/onboarding",
      {
        mode: "creator",
        title: args.title,
        slug: args.slug,
        draftId: args.draftId,
        captureMode: args.captureMode,
        aiEffectId,
        frameIds,
        filterIds,
      },
      {},
      { timeoutMs: BOOTH_CREATE_TIMEOUT_MS }
    );
  } catch (err) {
    throw boothErrorFor(err, "create");
  }
  const slug = created?.slug || args.slug;

  // 7. The id, for a dashboard link that opens the editor, and the rendered
  // welcome thumbnail, for the card. Non-fatal: the booth exists either way,
  // the list page is a fine fallback, and the draft's welcome design stands
  // in for the thumbnail.
  let projectId: string | undefined;
  let imageUrl: string | undefined = options.draftImage || undefined;
  try {
    const doc = await get<{ _id?: string; thumbnail?: string }>("/api/projects/by-slug", { slug });
    if (doc?._id) projectId = String(doc._id);
    if (typeof doc?.thumbnail === "string" && doc.thumbnail.startsWith("https://")) {
      imageUrl = doc.thumbnail;
    }
  } catch {
    /* fall back to the list page and the draft's image */
  }

  return {
    projectId,
    slug,
    title: args.title,
    boothUrl: `${BOOTH_PUBLIC_ORIGIN}/${slug}`,
    dashboardUrl: projectId
      ? `${config.apiUrl}/dashboard/projects/${projectId}/editor`
      : `${config.apiUrl}/dashboard/projects`,
    imageUrl,
    ownFrameCount,
    catalogFrameCount: frameIds.length,
    filterCount: filterIds.length,
    aiEffect: aiEffectTitle,
  };
}

export function buildCreateBooth(studio: StudioClient, config: Config) {
  return {
    name: "create_booth",
    config: {
      title: "Create the booth",
      description:
        "Create the booth from a finished draft — the step that makes something real, live at its public link. Call it only after the operator has seen the draft via check_generation and agreed the title and the link name (slug). " +
        "It draws the booth's own three photo-strip frames from the draft (3 images, up to five minutes), adds three starter frames from the catalogue and the Studio's default 'Normal' filter the way dreambooth.app/new does, then creates the booth with the draft's welcome design, background, colour theme and capture mode. Frames saved with save_frame and filters made with create_filter in this conversation can be included by id. " +
        "Returns a job id; check_generation reports progress and, when done, the booth's public link, id and a dashboard link. If the link name is taken it stops before drawing anything — ask for another and call again. " +
        "Creating twice with different link names makes two booths. The booth is live (unlisted) at once; there is no tool that edits or deletes a booth — changes happen in the dashboard.",
      inputSchema: {
        draftId: z.string().regex(DRAFT_ID_RE).describe("The draft to create, from check_generation."),
        title: z
          .string()
          .min(2)
          .max(80)
          .describe("The booth's name. The draft's title from check_generation unless the operator chose one."),
        slug: z
          .string()
          .min(3)
          .max(44)
          .regex(SLUG_RE)
          .describe(
            "The link name: lowercase letters, digits and single hyphens (dreambooth.app/<slug>). The draft's proposed slug from check_generation unless the operator chose one."
          ),
        captureMode: z
          .enum(["standard", "frame-based"])
          .optional()
          .describe("Leave unset to keep what the draft proposed ('standard' = classic strip, 'frame-based' = frame mode)."),
        aiEffectTitle: z
          .string()
          .max(80)
          .optional()
          .describe("The title of a public AI effect to add, exactly as the operator named it. Leave unset for none."),
        frameIds: z
          .array(z.string().regex(OBJECT_ID_RE))
          .max(20)
          .optional()
          .describe("Ids of frames to include — e.g. a frame the operator just saved with save_frame. Starter frames are added anyway."),
        filterIds: z
          .array(z.string().regex(OBJECT_ID_RE))
          .max(20)
          .optional()
          .describe("Ids of filters to include — e.g. one the operator just made with create_filter. The default 'Normal' filter is added anyway."),
      },
      outputSchema: createBoothOutput,
    },
    handler: async (args: CreateBoothArgs): Promise<CreateBoothHandle> => {
      const ownerKey = studio.ownerKey();
      const what = args.title;
      const failed = (error: string): CreateBoothHandle => ({
        kind: "booth" as const,
        jobId: "",
        state: "failed",
        what,
        draftId: args.draftId,
        slug: args.slug,
        error,
      });

      // One create per draft at a time. A second call while the first runs is
      // almost always a retry of an impatient model, and would draw the same
      // frames twice and race on the slug.
      const running = jobs
        .list<unknown>(ownerKey)
        .find((j) => j.kind === "booth" && j.state === "running" && j.ref === args.draftId);
      if (running) {
        return failed(
          `This draft is already being created (job ${running.id}). Call check_generation with that jobId instead of starting another.`
        );
      }

      // What the draft asked for, for the starter-frame match — from the most
      // recent finished design of this draft still in the store, else nothing
      // (the catalogue's popularity order is the fallback, as at /new).
      const latestDraft = jobs
        .list<BoothDraftResult>(ownerKey)
        .find(
          (j) =>
            j.kind === "booth-draft" && j.state === "done" && j.result?.draftId === args.draftId
        );
      const draftTerms = latestDraft?.result
        ? [...latestDraft.result.frameTags, latestDraft.result.filterMood]
        : [];
      const draftImage = latestDraft?.result?.welcomePortraitUrl;

      try {
        const job = jobs.start<BoothCreated>(
          ownerKey,
          what,
          (ctx) => createBoothWork(studio, config, args, ctx, { draftTerms, draftImage }),
          { kind: "booth", maxRuntimeMs: CREATE_JOB_MAX_RUNTIME_MS, ref: args.draftId }
        );

        return {
          kind: "booth" as const,
          jobId: job.id,
          state: job.state,
          what,
          draftId: args.draftId,
          slug: args.slug,
          note: BOOTH_CREATE_STARTED_NOTE,
        };
      } catch (err) {
        if (err instanceof JobLimitError) return failed(err.message);
        throw err;
      }
    },
  };
}
