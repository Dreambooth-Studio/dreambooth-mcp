import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
import { buildCreateFilter } from "../tools/createFilter.js";
import { buildDuplicateProject } from "../tools/duplicateProject.js";
import { buildStartFrame } from "../tools/startFrame.js";
import { buildRefineFrame } from "../tools/refineFrame.js";
import { buildCheckGeneration } from "../tools/checkGeneration.js";
import { buildSaveFrame } from "../tools/saveFrame.js";
import { registerWidget, withWidget, widgetAccessible } from "./widgets.js";
import {
  CONNECT_WIDGET_URI,
  connectAccountWidgetHtml,
} from "../ui/connectAccount.js";
import {
  WRITE_RESULT_WIDGET_URI,
  writeResultWidgetHtml,
} from "../ui/writeResult.js";
import {
  GENERATION_IMAGE_ORIGINS,
  GENERATION_WIDGET_URI,
  generationWidgetHtml,
} from "../ui/generationResult.js";
import { STDIO_SESSION, type SessionContext } from "./session.js";

export const SERVER_NAME = "dreambooth";
export const SERVER_VERSION = "0.2.0";

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
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
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

/**
 * The write tools. Every claim here is checkable, which is the point.
 *
 * `destructiveHint: false` is true and load-bearing: every one of them only
 * ever adds a row. Nothing they can do overwrites or removes anything,
 * because the Studio never opened a PUT or a DELETE to this connection.
 *
 * `idempotentHint: false` is the uncomfortable one, and it is stated rather
 * than hidden: calling create_filter twice makes two filters. A client that
 * retries a timed-out call will duplicate it, which is why the timeout message
 * in StudioClient.post tells the model to check rather than repeat.
 */
const CREATES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function createServer(
  config: Config,
  tokens: SessionTokens,
  session: SessionContext = STDIO_SESSION,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /**
   * Answer `prompts/list` with an empty list instead of "Method not found".
   *
   * This server has no prompts, and declining the method with a JSON-RPC
   * -32601 is spec-correct: the capability is not advertised, so a client that
   * checks capabilities before calling never asks. Some do not check. A client
   * that calls it unconditionally and does not handle the error gets an
   * exception where it expected an array, and there is nothing in our response
   * to tell whoever is debugging it that the call was optional.
   *
   * An empty list is true, costs one round trip, and cannot be misread. It adds
   * nothing to the tool surface a directory reviewer sees — `prompts/list` is
   * not the tool list — so the usual argument against widening the surface does
   * not apply here.
   *
   * Registered as a capability as well as a handler: advertising `prompts` and
   * then erroring would be worse than either alone.
   */
  server.server.registerCapabilities({ prompts: {} });
  server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
  const studio = new StudioClient(
    config,
    () => tokens.get(),
    () => tokens.describe(),
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
    withWidget(
      { ...connect.config, annotations: GRANTS_ACCESS },
      CONNECT_WIDGET_URI,
      {
        invoking: "Menyiapkan tautan masuk…",
        invoked: "Tautan masuk siap",
      },
    ),
    safe(connect.handler),
  );

  // Polled by the card above, so it must be callable from inside the iframe and
  // not only by the model. It reads memory and returns; nothing reaches the
  // Studio, which is what makes a two-second poll acceptable.
  const status = buildConnectionStatus(tokens);
  server.registerTool(
    status.name,
    widgetAccessible({ ...status.config, annotations: READ_ONLY }),
    safe(status.handler),
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
      safe(info.handler),
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
    safe(sessions.handler),
  );

  const gallery = buildGetGalleryStats(studio);
  server.registerTool(
    gallery.name,
    { ...gallery.config, annotations: READ_ONLY },
    safe(gallery.handler),
  );

  const docs = buildSearchDocs(studio);
  server.registerTool(
    docs.name,
    { ...docs.config, annotations: READ_ONLY },
    safe(docs.handler),
  );

  const projects = buildListProjects(studio);
  server.registerTool(
    projects.name,
    { ...projects.config, annotations: READ_ONLY },
    safe(projects.handler),
  );

  const project = buildGetProject(studio);
  server.registerTool(
    project.name,
    { ...project.config, annotations: READ_ONLY },
    safe(project.handler),
  );

  const revenue = buildGetRevenueSummary(studio);
  server.registerTool(
    revenue.name,
    { ...revenue.config, annotations: READ_ONLY },
    safe(revenue.handler),
  );

  const credits = buildGetCredits(studio);
  server.registerTool(
    credits.name,
    { ...credits.config, annotations: READ_ONLY },
    safe(credits.handler),
  );

  const wallet = buildGetWalletTransactions(studio);
  server.registerTool(
    wallet.name,
    { ...wallet.config, annotations: READ_ONLY },
    safe(wallet.handler),
  );

  /**
   * The write tools exist only on the OAuth path.
   *
   * Not a policy bolted on afterwards — it is the same rule the Studio
   * enforces, applied one layer earlier. Writing requires an access token that
   * expires in an hour, carries `booths:write`, and can be revoked. The device
   * flow's token is none of those: one year, no scope, no revocation. So on
   * stdio and on a device-flow HTTP session these tools are not registered,
   * and a model connected that way cannot promise something that would fail.
   *
   * What this gate does NOT check is the scope, because it cannot: the token is
   * a next-auth JWE and this server has no key for it. A read-scoped connection
   * therefore still SEES the tools and gets a 403 on calling one, with a
   * sentence naming the fix. Registering them per-scope would mean asking the
   * Studio on every tools/list — a round trip in front of the cheapest call a
   * client makes — to prevent a case that already fails cleanly.
   */
  if (session.bearerAuth) {
    registerWidget(server, {
      uri: WRITE_RESULT_WIDGET_URI,
      name: "write-result-card",
      title: "What was created",
      html: writeResultWidgetHtml,
      description:
        "A card confirming what was just created — the filter's name with a preview swatch, the duplicated booth, or the saved frame — and a link to it in the dashboard.",
    });

    const createFilter = buildCreateFilter(studio, config);
    server.registerTool(
      createFilter.name,
      withWidget(
        { ...createFilter.config, annotations: CREATES },
        WRITE_RESULT_WIDGET_URI,
        {
          invoking: "Membuat filter…",
          invoked: "Filter dibuat",
        },
      ),
      safe(createFilter.handler),
    );

    const duplicateProject = buildDuplicateProject(studio, config);
    server.registerTool(
      duplicateProject.name,
      withWidget(
        { ...duplicateProject.config, annotations: CREATES },
        WRITE_RESULT_WIDGET_URI,
        {
          invoking: "Menduplikat booth…",
          invoked: "Booth diduplikat",
        },
      ),
      safe(duplicateProject.handler),
    );

    /**
     * Frame generation is four tools, because it cannot answer in one call and
     * because one answer is rarely the last. An image-model round trip runs
     * 30–90 s against a 15 s request timeout, so `start_frame` and
     * `refine_frame` start work and return a handle, and `check_generation`
     * reports on it. And a first prompt rarely lands, so the shape is the
     * dashboard's Frame Studio thread: start, look, refine in the same thread,
     * and only `save_frame` puts a frame in the operator's list.
     *
     * No widget on `start_frame` / `refine_frame`: at the moment they return,
     * nothing has been generated, and a card is a claim that something has.
     * The preview card belongs on `check_generation`, the only tool that can
     * show an image; the "frame created" card on `save_frame`.
     *
     * Behind `ENABLE_FRAME_GENERATION`, and off by default, until a real
     * start → refine → save round has been run against production. See
     * `Config.frameGeneration`.
     */
    if (config.frameGeneration) {
      registerWidget(server, {
        uri: GENERATION_WIDGET_URI,
        name: "generation-preview-card",
        title: "Frame preview",
        html: generationWidgetHtml,
        description:
          "A card showing the generated frame preview — or that it is still generating, or why it failed. A preview is not a saved frame.",
        // The one card that loads an image, so the one card whose CSP names
        // an origin. See GENERATION_IMAGE_ORIGINS for why these.
        csp: { resourceDomains: GENERATION_IMAGE_ORIGINS },
      });

      const startFrame = buildStartFrame(studio);
      server.registerTool(
        startFrame.name,
        { ...startFrame.config, annotations: CREATES },
        safe(startFrame.handler),
      );

      const refineFrame = buildRefineFrame(studio);
      server.registerTool(
        refineFrame.name,
        { ...refineFrame.config, annotations: CREATES },
        safe(refineFrame.handler),
      );

      const checkGeneration = buildCheckGeneration(studio, config);
      server.registerTool(
        checkGeneration.name,
        withWidget(
          // Reads a status and creates nothing. Saying so is what lets a client
          // poll without asking the operator each time, which is the only way
          // polling is tolerable.
          { ...checkGeneration.config, annotations: READ_ONLY },
          GENERATION_WIDGET_URI,
          { invoking: "Mengecek…", invoked: "Pratinjau frame" },
        ),
        safe(checkGeneration.handler),
      );

      const saveFrame = buildSaveFrame(studio, config);
      server.registerTool(
        saveFrame.name,
        withWidget(
          { ...saveFrame.config, annotations: CREATES },
          WRITE_RESULT_WIDGET_URI,
          { invoking: "Menyimpan frame…", invoked: "Frame disimpan" },
        ),
        safe(saveFrame.handler),
      );
    }
  }

  return server;
}
