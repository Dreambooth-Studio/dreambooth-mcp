import { z } from "zod";
import type { StudioClient } from "../studio/client.js";
import type { Config } from "../config.js";

/**
 * Wraps POST /api/projects?duplicate=true&id=…
 *
 * The useful half of "create a booth", and the only half a connector should
 * have. Duplication takes an id and copies a document the operator already
 * approved; creating one from scratch takes the entire project config — six
 * screens of components, styles and asset URLs — and a config filled in by a
 * model produces a booth that boots wrong on a table at an event, with nothing
 * to point at. The Studio refuses the from-scratch branch for this connection;
 * this tool does not offer it.
 *
 * The copy is named by the Studio (`<title>-copy`, then `-copy-1`) and arrives
 * inactive, so nothing is live until the operator opens it and says so.
 */

export const duplicateProjectOutput = {
  kind: z.literal("booth"),
  id: z.string().optional(),
  title: z.string().optional(),
  slug: z.string().optional(),
  isActive: z.boolean().optional(),
  copiedFrom: z.object({ id: z.string().optional(), title: z.string().optional() }).optional(),
  dashboardUrl: z.string().optional(),
};

interface ProjectDoc {
  _id?: string;
  title?: string;
  slug?: string;
  isActive?: boolean;
}

export function buildDuplicateProject(studio: StudioClient, config: Config) {
  return {
    name: "duplicate_project",
    config: {
      title: "Duplicate a booth",
      description:
        "Copy one of this operator's existing booths, with all of its settings, into a new one. Use it when they want another booth 'like' one they already run — a second location, a one-off event, a variant to experiment on. Call list_projects first to get the project id; the operator will name the booth, not its id. The copy is created inactive and named after the original, so it is safe to make and they can rename it in the dashboard. There is no tool that creates a booth from nothing, and no tool that edits or deletes one.",
      inputSchema: {
        projectId: z
          .string()
          .min(1)
          .describe("The id of the booth to copy, from list_projects. Not its name or slug."),
      },
      outputSchema: duplicateProjectOutput,
    },
    handler: async (args: { projectId: string }) => {
      /**
       * An empty body, deliberately.
       *
       * The duplicate branch reads the source project from the database and
       * copies it; anything sent in the body is ignored by that path. Sending
       * fields anyway would look like this tool can influence the copy, which
       * is the first step towards someone adding a parameter that does.
       */
      const created = await studio.post<ProjectDoc>(
        "/api/projects",
        {},
        { duplicate: "true", id: args.projectId }
      );

      return {
        kind: "booth" as const,
        id: created?._id,
        title: created?.title,
        slug: created?.slug,
        isActive: created?.isActive,
        copiedFrom: {
          id: args.projectId,
          // The Studio names the copy `<original>-copy`, so the original's name
          // is recoverable from it without a second round trip. Falls back to
          // the whole title rather than to nothing if that convention changes.
          title: created?.title?.replace(/-copy(-\d+)?$/, "") || created?.title,
        },
        dashboardUrl: created?._id
          ? `${config.apiUrl}/dashboard/projects/${created._id}/editor`
          : undefined,
      };
    },
  };
}
