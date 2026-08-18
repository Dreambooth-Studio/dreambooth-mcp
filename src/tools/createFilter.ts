import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import type { Config } from "../config.js";

/**
 * Wraps POST /api/filters.
 *
 * The first tool in this server that changes anything, and chosen to be first
 * because it is the smallest thing it could change: a filter is a name and a
 * bag of numbers. No upload, no geometry, nothing another operator can see, and
 * undoing it is one click in the dashboard.
 *
 * Requires an OAuth connection carrying `booths:write`. A read-only connection
 * gets a 403 whose sentence names the fix; see writeErrorFor.
 */

/**
 * Ranges copied from `adjustmentRanges` in the Studio's
 * app/[locale]/dashboard/filters/[id]/page.tsx.
 *
 * These are in the schema, not just the description, because the model is
 * translating "hangat dan agak pudar" into numbers and has nothing else to go
 * on. Get the scale wrong and the filter is created successfully and looks
 * broken — the worst of both outcomes, because nothing reports an error.
 *
 * Only the adjustments an operator would ask for by name are exposed. The
 * Studio's model has thirty-odd; sharpening radius and noise-reduction
 * smoothness are not things anyone describes in a sentence, and every extra
 * field is another number for the model to invent.
 */
const adjustments = z
  .object({
    brightness: z.number().min(0).max(200).optional().describe("100 = unchanged"),
    contrast: z.number().min(0).max(200).optional().describe("100 = unchanged"),
    saturation: z.number().min(0).max(200).optional().describe("100 = unchanged, 0 = grey"),
    temperature: z
      .number()
      .min(-100)
      .max(100)
      .optional()
      .describe("0 = unchanged, positive = warmer"),
    tint: z.number().min(-100).max(100).optional().describe("0 = unchanged, positive = magenta"),
    exposure: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    shadows: z.number().min(-100).max(100).optional().describe("0 = unchanged, positive = lifted"),
    highlights: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    whites: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    blacks: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    vibrance: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    clarity: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    dehaze: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    sepia: z.number().min(0).max(100).optional().describe("0 = off"),
    grayscale: z.number().min(0).max(100).optional().describe("0 = off, 100 = black and white"),
    vignette: z.number().min(0).max(200).optional().describe("0 = off"),
    grain: z.number().min(0).max(100).optional().describe("0 = off"),
    blur: z.number().min(0).max(10).optional().describe("0 = off, in pixels"),
    hueRotate: z.number().min(0).max(360).optional().describe("0 = unchanged, in degrees"),
  })
  .describe(
    "Only include what the operator asked to change. An omitted adjustment keeps its neutral value; sending every field at its neutral value creates a filter that does nothing."
  );

export const createFilterOutput = {
  kind: z.literal("filter"),
  id: z.string().optional(),
  name: z.string().optional(),
  isPublic: z.boolean().optional(),
  adjustments: z.record(z.number()).optional(),
  dashboardUrl: z.string().optional(),
};

interface FilterDoc {
  _id?: string;
  name?: string;
  isPublic?: boolean;
  adjustments?: Record<string, number>;
}

export function buildCreateFilter(studio: StudioClient, config: Config) {
  return {
    name: "create_filter",
    config: {
      title: "Create a photo filter",
      description:
        "Create a new photo filter on this operator's account from a description of the look they want — 'warm and slightly faded', 'high contrast black and white'. Translate the description into the adjustment numbers yourself; the ranges are in the schema. Call this only when the operator asks for a filter to be CREATED. It does not change an existing filter, and there is no tool that does — to edit or delete one, send them to the dashboard. Creating the same filter twice makes two filters, so do not retry a call that may have gone through.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(80)
          .describe(
            "What the operator will see in their filter list. Use their words if they named it; otherwise a short descriptive name, not 'Untitled'."
          ),
        adjustments,
        isPublic: z
          .boolean()
          .optional()
          .describe(
            "Leave unset unless the operator explicitly asks for the filter to be shared. Default is private to their account."
          ),
      },
      outputSchema: createFilterOutput,
    },
    handler: async (args: {
      name: string;
      adjustments?: Record<string, number>;
      isPublic?: boolean;
    }) => {
      /**
       * The body is built field by field rather than spread from `args`.
       *
       * A spread would forward anything the model invented — `ownerEmail` above
       * all, which the Studio now refuses outright but which should never leave
       * here in the first place. Identity is not an argument, and the way to
       * keep that true is to name every field that is.
       */
      const created = await studio.post<FilterDoc>("/api/filters", {
        name: args.name,
        adjustments: args.adjustments ?? {},
        isPublic: args.isPublic ?? false,
      });

      return {
        kind: "filter" as const,
        id: created?._id,
        name: created?.name ?? args.name,
        isPublic: created?.isPublic ?? args.isPublic ?? false,
        // Echoed back from the Studio's copy, not from `args`: the POST handler
        // decides what it stores, and reporting what we sent would hide the
        // difference the moment those two diverge.
        adjustments: created?.adjustments ?? args.adjustments,
        dashboardUrl: created?._id
          ? `${config.apiUrl}/dashboard/filters/${created._id}`
          : undefined,
      };
    },
  };
}
