import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import type { Config } from "../config.js";
import { filterAdjustments as adjustments } from "./filterAdjustments.js";

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

export const createFilterOutput = {
  kind: z.literal("filter"),
  id: z.string().optional(),
  name: z.string().optional(),
  isPublic: z.boolean().optional(),
  adjustments: z.record(z.number()).optional(),
  dashboardUrl: z.string().optional(),
  /** The saved filter on the Studio's sample photo, for the card. Best-effort. */
  previewUrl: z.string().optional(),
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

      /**
       * The look, for the card: the same render `preview_filter` shows, on the
       * filter as saved. Best-effort — a Studio without the preview route, or a
       * slow render, must not turn a filter that was created into an error.
       */
      let previewUrl: string | undefined;
      try {
        const preview = await studio.get<{ previewUrl?: string }>(
          "/api/filters/preview",
          { adjustments: JSON.stringify(created?.adjustments ?? args.adjustments ?? {}) },
          { timeoutMs: 30_000 }
        );
        if (typeof preview?.previewUrl === "string" && preview.previewUrl.startsWith("https://")) {
          previewUrl = preview.previewUrl;
        }
      } catch {
        /* the card shows the numbers and the link instead */
      }

      return {
        kind: "filter" as const,
        id: created?._id,
        name: created?.name ?? args.name,
        isPublic: created?.isPublic ?? args.isPublic ?? false,
        // Echoed back from the Studio's copy, not from `args`: the POST handler
        // decides what it stores, and reporting what we sent would hide the
        // difference the moment those two diverge.
        adjustments: created?.adjustments ?? args.adjustments,
        previewUrl,
        dashboardUrl: created?._id
          ? `${config.apiUrl}/dashboard/filters/${created._id}`
          : undefined,
      };
    },
  };
}
