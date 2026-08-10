import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { StudioClient } from "../studio/client.js";
import type { SessionTokens } from "../auth/tokenStore.js";
import { buildConnectAccount } from "../tools/connectAccount.js";
import { StudioError } from "../studio/errors.js";
import { buildGetSessions } from "../tools/getSessions.js";
import { buildGetGalleryStats } from "../tools/getGalleryStats.js";
import { buildSearchDocs } from "../tools/searchDocs.js";
import { buildListProjects } from "../tools/listProjects.js";
import { buildGetProject } from "../tools/getProject.js";
import { buildGetRevenueSummary } from "../tools/getRevenueSummary.js";
import { buildGetCredits } from "../tools/getCredits.js";
import { buildGetWalletTransactions } from "../tools/getWalletTransactions.js";

export const SERVER_NAME = "dreambooth";
export const SERVER_VERSION = "0.1.0";

/**
 * Wraps a tool handler so a Studio failure comes back as tool content the model
 * can read, rather than a protocol-level error.
 *
 * The distinction matters: a protocol error tells the client "the server is
 * broken", which prompts a retry. `isError` with a sentence tells the model
 * what happened so it can relay it to the operator and stop.
 */
function safe<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      const result = await handler(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message =
        err instanceof StudioError
          ? err.message
          : `Unexpected failure talking to Dreambooth: ${
              err instanceof Error ? err.message : String(err)
            }`;
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  };
}

/** Every v1 tool is read-only; say so, so clients can auto-approve them. */
const READ_ONLY = { readOnlyHint: true } as const;

export function createServer(config: Config, tokens: SessionTokens): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const studio = new StudioClient(
    config,
    () => tokens.get(),
    () => tokens.describe()
  );

  // Not read-only: it changes what this session can see, so clients should
  // surface it for approval rather than auto-running it.
  const connect = buildConnectAccount(config, tokens);
  server.registerTool(connect.name, connect.config, safe(connect.handler));

  // Registered one call site at a time on purpose: each tool's inputSchema is a
  // different shape, and looping over them collapses the schemas into a union
  // the SDK's generics cannot resolve.
  //
  // Identity is NEVER an argument in any of them. Each tool resolves the
  // operator from the token server-side, exactly as lib/ai-chat does in the
  // Studio — the model cannot widen what it can read by passing an email.
  const sessions = buildGetSessions(studio);
  server.registerTool(
    sessions.name,
    { ...sessions.config, annotations: READ_ONLY },
    safe(sessions.handler)
  );

  const gallery = buildGetGalleryStats(studio);
  server.registerTool(
    gallery.name,
    { ...gallery.config, annotations: READ_ONLY },
    safe(gallery.handler)
  );

  const docs = buildSearchDocs(studio);
  server.registerTool(
    docs.name,
    { ...docs.config, annotations: READ_ONLY },
    safe(docs.handler)
  );

  const projects = buildListProjects(studio);
  server.registerTool(
    projects.name,
    { ...projects.config, annotations: READ_ONLY },
    safe(projects.handler)
  );

  const project = buildGetProject(studio);
  server.registerTool(
    project.name,
    { ...project.config, annotations: READ_ONLY },
    safe(project.handler)
  );

  const revenue = buildGetRevenueSummary(studio);
  server.registerTool(
    revenue.name,
    { ...revenue.config, annotations: READ_ONLY },
    safe(revenue.handler)
  );

  const credits = buildGetCredits(studio);
  server.registerTool(
    credits.name,
    { ...credits.config, annotations: READ_ONLY },
    safe(credits.handler)
  );

  const wallet = buildGetWalletTransactions(studio);
  server.registerTool(
    wallet.name,
    { ...wallet.config, annotations: READ_ONLY },
    safe(wallet.handler)
  );

  return server;
}
