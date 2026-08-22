import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import { StudioError } from "../studio/errors.js";
import { filterAdjustments, type FilterAdjustmentsInput } from "./filterAdjustments.js";

/**
 * Wraps GET /api/filters/preview.
 *
 * The half of filter design that was missing. `create_filter` turns words into
 * numbers and saves them; until now the operator saw the result only after it
 * existed, as a CSS swatch that cannot show warmth or shadows. This asks the
 * Studio to render its sample photo through the booth's own sharp pipeline —
 * the one that bakes guests' wedding photos — and returns a URL the card can
 * show. Say "warmer", adjust, preview again; `create_filter` only when happy.
 *
 * Read-only, and registered as such. It creates nothing the operator can see:
 * the Studio stores the rendered preview content-addressed (the same look is
 * one file, however many times it is asked for), and a read-scoped connection
 * may call it — only saving needs `booths:write`. Synchronous: a bake is a
 * fraction of a second, well inside the request timeout.
 *
 * The pipeline maps 13 of the 31 adjustments. The rest are applied by the
 * booth at capture time and cannot be shown; the result names them so the
 * model can say so instead of letting "lift the shadows" look ignored.
 */

const PREVIEW_TIMEOUT_MS = 30_000;

export const previewFilterOutput = {
  kind: z.literal("filter-preview"),
  previewUrl: z.string(),
  previewed: z.array(z.string()),
  notPreviewed: z.array(z.string()),
  sample: z.string(),
  adjustments: z.record(z.number()),
  note: z.string(),
};

interface PreviewReply {
  previewUrl?: string;
  previewed?: string[];
  notPreviewed?: string[];
  sample?: string;
}

export function buildPreviewFilter(studio: StudioClient) {
  return {
    name: "preview_filter",
    config: {
      title: "Preview a photo filter",
      description:
        "Show what a filter would look like BEFORE creating it: the Studio renders its sample photo (or the operator's own preview photo, if they set one in the dashboard) through the exact pipeline the booth uses, and returns an image URL. " +
        "Free and read-only — call it whenever the operator is designing a filter, adjust the numbers from their reaction ('warmer', 'less contrast'), preview again, and call create_filter with the same adjustments only once they are happy. " +
        "Some adjustments (shadows, highlights, whites, blacks, clarity, dehaze, vibrance, texture) are applied by the booth but cannot be shown here; the result lists them as notPreviewed so you can say so. Nothing is created by this tool.",
      inputSchema: {
        adjustments: filterAdjustments,
      },
      outputSchema: previewFilterOutput,
    },
    handler: async (args: { adjustments?: FilterAdjustmentsInput }) => {
      const adjustments = (args.adjustments ?? {}) as Record<string, number>;

      let reply: PreviewReply;
      try {
        reply = await studio.get<PreviewReply>(
          "/api/filters/preview",
          { adjustments: JSON.stringify(adjustments) },
          { timeoutMs: PREVIEW_TIMEOUT_MS }
        );
      } catch (err) {
        if (err instanceof StudioError && err.status === 404) {
          throw new StudioError(
            "Dreambooth does not have the filter preview yet — the Studio update that adds it must be deployed first. create_filter still works without a preview; describe the adjustments in words instead.",
            404,
            false
          );
        }
        throw err;
      }

      if (!reply?.previewUrl) {
        throw new StudioError(
          "Dreambooth did not return a preview image. Nothing was created; try again, or create the filter without one.",
          502,
          false
        );
      }

      const notPreviewed = reply.notPreviewed ?? [];
      return {
        kind: "filter-preview" as const,
        previewUrl: reply.previewUrl,
        previewed: reply.previewed ?? [],
        notPreviewed,
        sample: reply.sample ?? "default",
        adjustments,
        note:
          (reply.sample === "account"
            ? "This is the operator's own preview photo through the booth's filter pipeline. "
            : "This is the Studio's sample photo through the booth's filter pipeline. ") +
          "Nothing has been created — call create_filter with the same adjustments when the operator is happy." +
          (notPreviewed.length
            ? ` Not shown in the preview, though the booth will apply them: ${notPreviewed.join(", ")}.`
            : ""),
      };
    },
  };
}
