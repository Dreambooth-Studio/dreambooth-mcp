import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Apps SDK plumbing: a tool becomes an inline card by pointing at a UI resource
 * through `_meta`, and the host fetches that resource and renders it in a
 * sandboxed iframe.
 *
 * Two spellings are emitted for every field. `ui.*` is the MCP Apps standard;
 * the `openai/*` keys are ChatGPT's compatibility aliases. Emitting both costs
 * nothing and means the same server works whether a host has moved to the
 * standard names yet or not.
 *
 * None of this affects clients that do not render widgets: an unknown `_meta`
 * key is ignored, and the tool's text `content` is what they use.
 */

/** The MCP Apps UI mimetype. Anything else and the host treats it as a file. */
export const WIDGET_MIME = "text/html;profile=mcp-app";

export interface WidgetCsp {
  /** Origins the widget may XHR/fetch. Empty is correct — widgets use callTool. */
  connectDomains?: string[];
  /** Origins for images/fonts/styles. Empty is correct — everything is inline. */
  resourceDomains?: string[];
}

export interface WidgetSpec {
  /** `ui://widget/<name>.html` */
  uri: string;
  /** Registry name; also what shows in resource listings. */
  name: string;
  title: string;
  /** Self-contained HTML document. */
  html: string;
  /** Read by the MODEL to decide whether the card answered the question. */
  description: string;
  csp?: WidgetCsp;
}

/**
 * Registers the HTML document a tool renders into.
 *
 * The CSP defaults to empty on both lists, and that is a deliberate security
 * property rather than an oversight: a widget that cannot reach the network
 * cannot leak the operator's session token, and it does not need to, because
 * every byte of data arrives through `callTool` on the server side.
 */
export function registerWidget(server: McpServer, widget: WidgetSpec): void {
  const csp = {
    connectDomains: widget.csp?.connectDomains ?? [],
    resourceDomains: widget.csp?.resourceDomains ?? [],
  };

  const meta: Record<string, unknown> = {
    "ui.prefersBorder": true,
    "ui.csp": csp,
    "openai/widgetPrefersBorder": true,
    // Legacy ChatGPT key; snake_case, unlike the standard one.
    "openai/widgetCSP": {
      connect_domains: csp.connectDomains,
      resource_domains: csp.resourceDomains,
    },
    "openai/widgetDescription": widget.description,
  };

  server.registerResource(
    widget.name,
    widget.uri,
    { title: widget.title, mimeType: WIDGET_MIME, _meta: meta },
    async (uri) => ({
      // `_meta` is repeated on the contents entry because hosts differ on which
      // copy they read, and a missing CSP is a blank card with no error.
      contents: [{ uri: uri.href, mimeType: WIDGET_MIME, text: widget.html, _meta: meta }],
    })
  );
}

export interface WidgetToolOptions {
  /** Status line while the tool runs. Max 64 characters. */
  invoking?: string;
  /** Status line once it has returned. Max 64 characters. */
  invoked?: string;
}

/**
 * Attaches the widget pointer to a tool's config.
 *
 * Kept separate from `registerWidget` because the two are not one-to-one: the
 * revenue card is rendered by one tool, but a picker widget re-queries several.
 */
export function withWidget<T extends object>(
  config: T,
  uri: string,
  options: WidgetToolOptions = {}
): T & { _meta: Record<string, unknown> } {
  const existing = (config as { _meta?: Record<string, unknown> })._meta ?? {};
  const meta: Record<string, unknown> = {
    ...existing,
    "ui.resourceUri": uri,
    "openai/outputTemplate": uri,
  };

  if (options.invoking) meta["openai/toolInvocation/invoking"] = truncate(options.invoking);
  if (options.invoked) meta["openai/toolInvocation/invoked"] = truncate(options.invoked);

  return { ...config, _meta: meta };
}

/**
 * Marks a tool as callable from inside a widget, not just by the model.
 *
 * Needed for anything a card polls or re-queries on its own — without it the
 * host may refuse the `callTool` and the card silently never updates.
 */
export function widgetAccessible<T extends object>(
  config: T
): T & { _meta: Record<string, unknown> } {
  const existing = (config as { _meta?: Record<string, unknown> })._meta ?? {};
  return {
    ...config,
    _meta: {
      ...existing,
      "ui.visibility": ["model", "app"],
      "openai/widgetAccessible": true,
    },
  };
}

/** Hosts truncate silently past 64 chars; do it here so the cut is deliberate. */
function truncate(text: string): string {
  return text.length <= 64 ? text : `${text.slice(0, 61)}...`;
}
