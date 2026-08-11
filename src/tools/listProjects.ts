import { z } from "zod";
import type { StudioClient } from "../studio/client.js";

/**
 * Every field optional: each one is copied straight off a project document, and
 * a Studio rename must degrade to a missing key rather than to an McpError.
 * See the note on `searchDocsOutput`.
 */
export const listProjectsOutput = {
  count: z.number(),
  projects: z.array(
    z.object({
      id: z.string().optional().describe("Pass this as projectId to other tools"),
      title: z.string().optional(),
      slug: z.string().optional(),
      isActive: z.boolean().optional(),
      isPublic: z.boolean().optional(),
      currency: z.string().optional(),
      country: z.string().optional(),
      updatedAt: z.string().optional(),
    })
  ),
};

/**
 * Wraps GET /api/projects.
 *
 * Returns a trimmed row per booth rather than the raw project document. A
 * project doc carries the entire page tree — every component, style and asset
 * URL for six screens — which is tens of KB the model has no use for when it is
 * answering "which booths do I have".
 */

interface ProjectRow {
  _id?: string;
  title?: string;
  slug?: string;
  isActive?: boolean;
  isPublic?: boolean;
  country?: string;
  resolvedCurrency?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function buildListProjects(studio: StudioClient) {
  return {
    name: "list_projects",
    config: {
      title: "List booths",
      description:
        "List the photobooth projects this operator owns, with id, name, public link slug, whether it is active, and its currency. Call this first whenever the operator names a booth — you need the project id to filter any other tool by booth. Does not return booth designs or page layouts.",
      inputSchema: {},
      outputSchema: listProjectsOutput,
    },
    handler: async () => {
      const data = await studio.get<ProjectRow[] | { projects?: ProjectRow[] }>(
        "/api/projects"
      );
      const rows: ProjectRow[] = Array.isArray(data) ? data : (data.projects ?? []);

      return {
        count: rows.length,
        projects: rows.map((p) => ({
          id: p._id,
          title: p.title,
          slug: p.slug,
          isActive: p.isActive,
          isPublic: p.isPublic,
          currency: p.resolvedCurrency,
          country: p.country,
          updatedAt: p.updatedAt,
        })),
      };
    },
  };
}
