import { z } from "zod";
import type { StudioClient } from "../studio/client.js";

/**
 * One booth in detail, plus whether its device is actually alive.
 *
 * Combines GET /api/projects?id=… with GET /api/device-monitoring, because
 * "tell me about my Bandung booth" almost always means both "how is it
 * configured" and "is it running right now", and making the model issue two
 * calls to answer one question wastes a round trip and invites it to answer
 * with only half the picture.
 *
 * The project document is deliberately gutted before it is returned: it carries
 * the entire page tree — every component, style and asset URL across six
 * screens — which is tens of KB the model cannot use and the operator pays for
 * in context.
 */

/** See the note on `searchDocsOutput` for why every Studio-owned field is optional. */
export const getProjectOutput = {
  project: z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    slug: z.string().optional(),
    isActive: z.boolean().optional(),
    isPublic: z.boolean().optional(),
    currency: z.string().optional(),
    country: z.string().optional(),
    screenSize: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
  deviceCount: z.number(),
  devices: z.array(
    z.object({
      deviceId: z.string().optional(),
      /**
       * livenessTier, NOT isOnline. isOnline collapses "quiet because it was
       * shut down deliberately" into "offline", which is how a healthy fleet
       * gets reported as broken.
       */
      liveness: z.string().optional(),
      lastSeenAt: z.string().optional(),
      lastActivityAt: z.string().optional(),
      closedAt: z.string().nullable().optional(),
      closedReason: z.string().nullable().optional(),
      appVersion: z.string().optional(),
      camera: z.string().optional(),
      printer: z.string().optional(),
      internet: z.string().optional(),
      cpuUsagePercent: z.number().optional(),
      ramUsagePercent: z.number().optional(),
      diskFreeGB: z.number().optional(),
    })
  ).describe("Empty when device monitoring is unavailable — not an error"),
};

export const getProjectInput = {
  projectId: z.string().describe("Project id from list_projects"),
};

interface ProjectDoc {
  _id?: string;
  title?: string;
  slug?: string;
  isActive?: boolean;
  isPublic?: boolean;
  country?: string;
  resolvedCurrency?: string;
  screenSize?: { width?: number; height?: number };
  createdAt?: string;
  updatedAt?: string;
}

interface DeviceItem {
  deviceId: string;
  projectId: string | null;
  projectName: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  lastActivityAt: string | null;
  livenessTier?: string;
  closedAt?: string | null;
  closedReason?: string | null;
  cpuUsagePercent: number | null;
  ramUsagePercent: number | null;
  diskFreeGB: number | null;
  internetStatus: string | null;
  cameraStatus: string | null;
  printerStatus: string | null;
}

export function buildGetProject(studio: StudioClient) {
  return {
    name: "get_project",
    config: {
      title: "Get one booth in detail",
      description:
        "Full detail for a single booth: its name, public link, currency, screen size, and the live status of the device running it — whether it is online, when it was last seen, app version, and camera/printer/internet state. Call this when the operator asks about one specific booth, or whether a booth is working. Get the project id from list_projects first.",
      inputSchema: getProjectInput,
      outputSchema: getProjectOutput,
    },
    handler: async (args: { projectId: string }) => {
      const project = await studio.get<ProjectDoc>("/api/projects", {
        id: args.projectId,
      });

      // Device status is a nice-to-have: a monitoring hiccup must not turn
      // "tell me about this booth" into an error.
      let devices: DeviceItem[] = [];
      try {
        const monitoring = await studio.get<{ devices?: DeviceItem[] }>(
          "/api/device-monitoring"
        );
        devices = (monitoring.devices ?? []).filter(
          (d) => d.projectId && String(d.projectId) === String(args.projectId)
        );
      } catch {
        devices = [];
      }

      return {
        project: {
          id: project._id,
          title: project.title,
          slug: project.slug,
          isActive: project.isActive,
          isPublic: project.isPublic,
          currency: project.resolvedCurrency,
          country: project.country,
          screenSize: project.screenSize,
          updatedAt: project.updatedAt,
        },
        deviceCount: devices.length,
        devices: devices.map((d) => ({
          deviceId: d.deviceId,
          // livenessTier, not isOnline: `isOnline` is retained only for
          // back-compat and collapses "quiet because it was shut down
          // deliberately" into "offline", which is how a healthy fleet ends up
          // reported as broken.
          liveness: d.livenessTier,
          lastSeenAt: d.lastSeenAt,
          lastActivityAt: d.lastActivityAt,
          closedAt: d.closedAt ?? null,
          closedReason: d.closedReason ?? null,
          appVersion: d.appVersion,
          camera: d.cameraStatus,
          printer: d.printerStatus,
          internet: d.internetStatus,
          cpuUsagePercent: d.cpuUsagePercent,
          ramUsagePercent: d.ramUsagePercent,
          diskFreeGB: d.diskFreeGB,
        })),
      };
    },
  };
}
