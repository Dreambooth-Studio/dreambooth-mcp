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
import { buildStartBooth } from "../tools/startBooth.js";
import { buildRefineBooth } from "../tools/refineBooth.js";
import { buildCreateBooth } from "../tools/createBooth.js";
import { buildGetBoothDraft } from "../tools/getBoothDraft.js";
import { buildUpdateBoothDraft } from "../tools/updateBoothDraft.js";
import { buildPreviewFilter } from "../tools/previewFilter.js";
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
export const SERVER_VERSION = "0.3.0";

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
 * `openWorldHint` was `false` on every tool until the v2.0.0 review, on the MCP
 * spec's reading of it: one known service is a closed world, unlike web search.
 * The plugin guidelines define the same hint by a different test — "tools that
 * interact with external systems, accounts, public platforms, or create
 * publicly-visible content must be explicitly labeled" — and by THAT test the
 * old answer was wrong for almost everything here. Reaching a named operator's
 * account on another company's service is exactly the interaction the hint is
 * meant to disclose, and `create_booth` publishes a page anyone can open.
 *
 * So the hint now answers the guidelines' question, not the spec's: `true`
 * whenever the tool leaves this process, `false` only for the two that never
 * do. Where the two readings disagree, the honest and the cautious answer are
 * the same one, which is a good sign it is the right one.
 */
/**
 * `destructiveHint` and `idempotentHint` are included even though the MCP spec
 * treats both as meaningful only when `readOnlyHint` is false — a tool that
 * reads nothing away cannot destroy anything and cannot accumulate an effect,
 * so the spec considers them redundant here.
 *
 * The ChatGPT submission portal disagrees and rejects any tool missing any of
 * the four, redundant or not. It is also the more useful claim to a reviewer:
 * "absent" and "false" read identically to a person but mean different things
 * to a form. Omitting `idempotentHint` is what the v2.0.0 review flagged as an
 * annotation that "does not match the tool's behavior" — the portal read the
 * unset hint as an unanswered question, not as a redundant one.
 *
 * `idempotentHint: true` is the honest value and not merely the required one:
 * asking any of these tools the same question twice returns the same answer and
 * leaves the account exactly as it was. The data underneath may move between
 * calls — that is the account changing, not the tool changing it.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * The two tools that reach nothing: `connection_status` reports the credential
 * state of the request in hand, and `check_generation` reads a job record from
 * this server's own memory. Neither opens a socket, so neither touches an
 * external system, an account, or a public platform. `openWorldHint: false` is
 * a claim about them that can be checked by reading their handlers, which is
 * the only reason it is still here after the review.
 */
const READ_ONLY_LOCAL = {
  ...READ_ONLY,
  openWorldHint: false,
} as const;

/**
 * `connect_account` is the one tool that changes what the session can see, so
 * it must NOT claim readOnlyHint. It is still not destructive — it grants
 * access, it does not remove or overwrite anything — and saying so explicitly
 * is what keeps a client from treating it as dangerous and what stops the
 * submission portal filing it under "no annotations".
 *
 * `idempotentHint: false` is the accurate answer rather than the flattering
 * one: each call opens a NEW device-flow authorization with its own link and
 * its own expiry, so calling it twice is not the same as calling it once. The
 * tool's own description tells the model not to call it again while waiting,
 * which is only worth saying because the repeat has an effect.
 */
const GRANTS_ACCESS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
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
  openWorldHint: true,
} as const;

/**
 * update_booth_draft: not read-only (it changes a draft), not destructive
 * (the draft is not a booth, and the edit replaces nothing an operator has
 * published), idempotent (the same edit twice leaves the same draft — unlike
 * the creates above), and closed-world like everything here.
 */
const EDITS_DRAFT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Booth design and creation, held back until the Studio can serve them.
 *
 * `start_booth`, `refine_booth`, `create_booth`, `get_booth_draft` and
 * `update_booth_draft` all reach `/api/onboarding/*` or
 * `/api/projects/onboarding`, and every one of those routes is gated on the
 * Studio's `digital_mode` feature flag. The flag is OFF in production and its
 * check is the FIRST statement in each handler, before auth, so the routes
 * answer 404 `{"error":"Not found"}` to everyone — verifiable without a token:
 *
 *     curl https://dreamboothstudio.com/api/onboarding/catalog
 *
 * `boothErrorFor` already turns that into an honest sentence ("Booth
 * generation is not enabled on this Dreambooth right now"), so nothing was
 * broken. But a connector that lists five tools which cannot work, and a
 * directory submission whose headline test case is designing a booth, is a
 * promise the product cannot keep — it is what the v2.0.0 review ran into.
 *
 * There is no staged middle ground to reach for: `isFlagLive` returns true as
 * soon as a flag's allow-list is non-empty, and these routes call the
 * identity-free `isFeatureLive`, so allow-listing one tester email would open
 * the onboarding endpoints for everyone. The flag is all or nothing, and
 * turning it on is a launch of the consumer web booth and the dashboard's
 * publish toggle — a product decision, not a submission fix.
 *
 * A plain constant rather than an environment variable, deliberately: this is
 * not a per-environment difference, it is a fact about what the Studio serves
 * today. Flipping it back to `true` is the whole of the work when
 * `digital_mode` ships — and the booth flow should be run end to end against
 * production first, which has never been done.
 *
 * Note what this is NOT: it does not vary per connection, so it does not
 * reintroduce what the note above the write tools exists to prevent. Every
 * caller is shown the same inventory; a compile-time constant keeps that true.
 */
export const BOOTH_TOOLS_LIVE = false;


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
    widgetAccessible({ ...status.config, annotations: READ_ONLY_LOCAL }),
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
      widgetAccessible({ ...info.config, annotations: READ_ONLY_LOCAL }),
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
   * The write tools, registered unconditionally: the same list, in the same
   * order, on every connection.
   *
   * They used to exist only where a bearer did, on the reasoning that writing
   * needs a token that expires in an hour, carries `booths:write` and can be
   * revoked, and that the device flow's one-year unscoped token is none of
   * those. The rule is right. Enforcing it HERE was not, because `bearerAuth`
   * was the mere PRESENCE of an `Authorization` header: `tools/list` answered
   * 10 tools with no header and 22 with any string as one, and `resources/list`
   * answered 1 widget or 3.
   *
   * An inventory that depends on who is asking is not an inventory. The
   * ChatGPT submission portal scans tools from the browser with no credential
   * (see the CORS note in src/http.ts), so it could only ever see the read
   * half while the submission declared all 22 — and any client that caches a
   * list captured before sign-in goes on offering ten tools to an operator who
   * has since connected an account.
   *
   * Removing the gate loosens nothing, because it never decided anything a
   * later layer did not decide again, with a better answer:
   *
   *   no credential      every one of these is in `AUTH_REQUIRED_TOOLS`, so
   *                      the transport answers 401 with the
   *                      `WWW-Authenticate` challenge that STARTS the OAuth
   *                      flow. The gate's answer was "unknown tool", which
   *                      starts nothing and explains nothing.
   *   device-flow token  the Studio refuses it, 403: "This token cannot create
   *                      things. Connect the app through Dreambooth's sign-in
   *                      instead."
   *   read-scoped token  the Studio refuses it, 403: "This connection is
   *                      read-only. Reconnect the app and approve permission
   *                      to create things."
   *
   * The last two were ALREADY what an OAuth connection the gate let through
   * would get, which is the whole argument: the scope decides, only the Studio
   * can read it out of a next-auth JWE this server holds no key for, and both
   * of its refusals are sentences an operator can act on. Answering a coarser
   * version of that question one layer early bought nothing and cost a stable
   * tool list. See docs/write-tools-plan.md §5.6.
   */
  registerWidget(server, {
    uri: WRITE_RESULT_WIDGET_URI,
    name: "write-result-card",
    title: "What was created",
    html: writeResultWidgetHtml,
    description:
      "A card confirming the duplicated booth — its name and what it was copied from — and a link to it in the dashboard.",
  });

  /**
   * The card everything GENERATED renders into — frames, booths, filters
   * and their previews — from the moment it is asked for to the moment it
   * exists. A start/refine/create handle renders as a live skeleton that
   * polls `check_generation` itself and redraws as the preview; the done
   * states show the thing. The one card that loads an image, so the one
   * card whose CSP names an origin. See GENERATION_IMAGE_ORIGINS for why these.
   */
  registerWidget(server, {
    uri: GENERATION_WIDGET_URI,
    name: "generation-preview-card",
    title: "Preview",
    html: generationWidgetHtml,
    description:
      "A card showing the thing being made and, when it is done, the thing itself: a frame preview, a booth draft, a created booth, a saved frame, a created filter, or a filter preview. While work runs it shows a skeleton and updates itself. A preview is not a saved thing.",
    csp: { resourceDomains: GENERATION_IMAGE_ORIGINS },
  });

  const createFilter = buildCreateFilter(studio, config);
  server.registerTool(
    createFilter.name,
    withWidget(
      { ...createFilter.config, annotations: CREATES },
      GENERATION_WIDGET_URI,
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
   * Every one of them renders the generation card. A start or refine returns
   * while nothing exists yet, so its card is a LIVE one: a skeleton of the
   * thing being made that polls `check_generation` itself and redraws as the
   * preview when the work is done — the operator watches it appear, nobody
   * has to ask. `check_generation` is widget-accessible for exactly that;
   * `save_frame` shows the saved frame's thumbnail.
   *
   * Listed unconditionally, like every other tool here. There used to be a
   * flag, from when these wrapped an Imagen route that could never succeed;
   * a switch whose only job is "hide a tool that cannot work" is not worth
   * an environment variable once the tool can. What remains is deploy
   * order — the Studio routes these call must be live first — and that is
   * a note in the README, not a runtime setting.
   */
  const startFrame = buildStartFrame(studio);
  server.registerTool(
    startFrame.name,
    withWidget(
      { ...startFrame.config, annotations: CREATES },
      GENERATION_WIDGET_URI,
      { invoking: "Memulai frame…", invoked: "Sedang membuat frame" },
    ),
    safe(startFrame.handler),
  );

  const refineFrame = buildRefineFrame(studio);
  server.registerTool(
    refineFrame.name,
    withWidget(
      { ...refineFrame.config, annotations: CREATES },
      GENERATION_WIDGET_URI,
      { invoking: "Mengubah frame…", invoked: "Sedang mengubah frame" },
    ),
    safe(refineFrame.handler),
  );

  const checkGeneration = buildCheckGeneration(studio, config);
  server.registerTool(
    checkGeneration.name,
    // Reads a status and creates nothing. Saying so is what lets a client
    // poll without asking the operator each time, which is the only way
    // polling is tolerable — and widget-accessible, so the live card can
    // poll it from inside the iframe as well.
    widgetAccessible(
      withWidget(
        { ...checkGeneration.config, annotations: READ_ONLY_LOCAL },
        GENERATION_WIDGET_URI,
        { invoking: "Mengecek…", invoked: "Pratinjau" },
      ),
    ),
    safe(checkGeneration.handler),
  );

  const saveFrame = buildSaveFrame(studio, config);
  server.registerTool(
    saveFrame.name,
    withWidget(
      { ...saveFrame.config, annotations: CREATES },
      GENERATION_WIDGET_URI,
      { invoking: "Menyimpan frame…", invoked: "Frame disimpan" },
    ),
    safe(saveFrame.handler),
  );
  /**
   * `preview_filter` is the read-only half of filter design: it renders,
   * `create_filter` saves. It stays whatever the booth tools are doing —
   * `/api/filters/preview` carries no feature flag and answers today.
   */
  const previewFilter = buildPreviewFilter(studio);
  server.registerTool(
    previewFilter.name,
    withWidget(
      // Renders a sample photo and returns a URL; creates nothing the
      // operator can see. Read-only is what lets the model preview freely
      // while the operator decides.
      { ...previewFilter.config, annotations: READ_ONLY },
      GENERATION_WIDGET_URI,
      { invoking: "Merender pratinjau filter…", invoked: "Pratinjau filter" },
    ),
    safe(previewFilter.handler),
  );

  // See BOOTH_TOOLS_LIVE: these five are 404 on the Studio until
  // `digital_mode` is live, so they are not advertised.
  if (BOOTH_TOOLS_LIVE) {
    const startBooth = buildStartBooth(studio);
    server.registerTool(
      startBooth.name,
      withWidget(
        { ...startBooth.config, annotations: CREATES },
        GENERATION_WIDGET_URI,
        { invoking: "Merancang booth…", invoked: "Sedang merancang booth" },
      ),
      safe(startBooth.handler),
    );

    const refineBooth = buildRefineBooth(studio);
    server.registerTool(
      refineBooth.name,
      withWidget(
        { ...refineBooth.config, annotations: CREATES },
        GENERATION_WIDGET_URI,
        { invoking: "Mengubah rancangan…", invoked: "Sedang mengubah rancangan" },
      ),
      safe(refineBooth.handler),
    );

    const createBooth = buildCreateBooth(studio, config);
    server.registerTool(
      createBooth.name,
      withWidget(
        { ...createBooth.config, annotations: CREATES },
        GENERATION_WIDGET_URI,
        { invoking: "Membuat booth…", invoked: "Sedang membuat booth" },
      ),
      safe(createBooth.handler),
    );

    /**
     * The other two levers on a draft: read it back (the job store forgets,
     * the Studio does not) and change what a redraw cannot — settings, text,
     * colours, frames, filters, effect — before create_booth applies them.
     */
    const getBoothDraft = buildGetBoothDraft(studio);
    server.registerTool(
      getBoothDraft.name,
      withWidget(
        { ...getBoothDraft.config, annotations: READ_ONLY },
        GENERATION_WIDGET_URI,
        { invoking: "Membaca rancangan…", invoked: "Rancangan booth" },
      ),
      safe(getBoothDraft.handler),
    );

    const updateBoothDraft = buildUpdateBoothDraft(studio);
    server.registerTool(
      updateBoothDraft.name,
      withWidget(
        { ...updateBoothDraft.config, annotations: EDITS_DRAFT },
        GENERATION_WIDGET_URI,
        { invoking: "Mengubah rancangan…", invoked: "Rancangan diperbarui" },
      ),
      safe(updateBoothDraft.handler),
    );
  }

  return server;
}
