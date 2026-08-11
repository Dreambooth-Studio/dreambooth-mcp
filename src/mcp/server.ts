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
import { buildConnectionStatus } from "../tools/connectionStatus.js";
import { buildSessionInfo } from "../tools/sessionInfo.js";
import { registerWidget, withWidget, widgetAccessible } from "./widgets.js";
import { CONNECT_WIDGET_URI, connectAccountWidgetHtml } from "../ui/connectAccount.js";
import { STDIO_SESSION, type SessionContext } from "./session.js";

export const SERVER_NAME = "dreambooth";
export const SERVER_VERSION = "0.1.0";

/**
 * Wraps a tool handler so a Studio failure comes back as tool content the model
 * can read, rather than a protocol-level error.
 *
 * The distinction matters: a protocol error tells the client "the server is
 * broken", which prompts a retry. `isError` with a sentence tells the model
 * what happened so it can relay it to the operator and stop.
 *
 * Every result carries the same payload twice, for two different readers:
 *
 *   structuredContent  the object, for widgets AND for the model
 *   content            the same object pretty-printed, for clients that render
 *                      no widget — Claude and Gemini today
 *
 * The text block is byte-identical to what this function returned before
 * widgets existed, so nothing that works today can regress.
 */
function safe<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      const result = await handler(args);
      return {
        structuredContent: result as Record<string, unknown>,
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
        // `_meta` reaches the widget but never the model, which is exactly
        // right for this: a card needs to know whether to offer "try again",
        // and the model already has the sentence.
        _meta: {
          retryable: err instanceof StudioError ? err.retryable : false,
          status: err instanceof StudioError ? err.status : 0,
        },
      };
    }
  };
}

/**
 * Every v1 tool is read-only; say so, so clients can auto-approve them.
 *
 * `openWorldHint: false` because each tool talks to exactly one known service —
 * this operator's own Studio account — and never to an open set of external
 * entities the way a web search would. Both directory reviews require the hint
 * to be present and explicit, and "absent" is not the same claim as "false".
 */
/**
 * `destructiveHint: false` is included even though the MCP spec treats it as
 * meaningful only when `readOnlyHint` is false — a tool that reads nothing away
 * cannot destroy anything, so the spec considers it redundant here.
 *
 * The ChatGPT submission portal disagrees and rejects any tool missing any of
 * the three, redundant or not. It is also the more useful claim to a reviewer:
 * "absent" and "false" read identically to a person but mean different things
 * to a form.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/**
 * `connect_account` is the one tool that changes what the session can see, so
 * it must NOT claim readOnlyHint. It is still not destructive — it grants
 * access, it does not remove or overwrite anything — and saying so explicitly
 * is what keeps a client from treating it as dangerous and what stops the
 * submission portal filing it under "no annotations".
 */
const GRANTS_ACCESS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export function createServer(
  config: Config,
  tokens: SessionTokens,
  session: SessionContext = STDIO_SESSION
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const studio = new StudioClient(
    config,
    () => tokens.get(),
    () => tokens.describe()
  );

  // The card `connect_account` renders into. Registered before the tool that
  // points at it so a host listing resources mid-registration never sees a
  // dangling ui:// reference.
  registerWidget(server, {
    uri: CONNECT_WIDGET_URI,
    name: "connect-account-card",
    title: "Connect Dreambooth account",
    html: connectAccountWidgetHtml,
    description:
      "A card with a Google sign-in button that reports when the operator has finished approving. Shown instead of pasting the raw link.",
  });

  // Not read-only: it changes what this session can see, so clients should
  // surface it for approval rather than auto-running it.
  const connect = buildConnectAccount(config, tokens, session);
  server.registerTool(
    connect.name,
    withWidget({ ...connect.config, annotations: GRANTS_ACCESS }, CONNECT_WIDGET_URI, {
      invoking: "Menyiapkan tautan masuk…",
      invoked: "Tautan masuk siap",
    }),
    safe(connect.handler)
  );

  // Polled by the card above, so it must be callable from inside the iframe and
  // not only by the model. It reads memory and returns; nothing reaches the
  // Studio, which is what makes a two-second poll acceptable.
  const status = buildConnectionStatus(tokens);
  server.registerTool(
    status.name,
    widgetAccessible({ ...status.config, annotations: READ_ONLY }),
    safe(status.handler)
  );

  // TEMPORARY, and OFF unless MCP_DIAGNOSTICS is set — remove with the tool
  // itself once §2 of the widgets plan is answered. See src/tools/sessionInfo.ts.
  //
  // Gated rather than simply present because a directory listing is judged on
  // its tool list, and a tool whose own description says it "tells the operator
  // nothing about their booths" is noise a reviewer will ask about. Gated
  // rather than deleted because it is the only instrument that answers §2.1 —
  // whether ChatGPT reuses Mcp-Session-Id across turns — and that question
  // decides whether the in-memory auth model works at all.
  //
  // To run the test: set MCP_DIAGNOSTICS=1 in Railway, ask three questions in
  // developer mode, compare sessionId, then unset it.
  if (config.diagnostics) {
    const info = buildSessionInfo(tokens, session);
    server.registerTool(
      info.name,
      widgetAccessible({ ...info.config, annotations: READ_ONLY }),
      safe(info.handler)
    );
  }

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
