import { z } from "zod";
import type { Config } from "../config.js";
import type { SessionTokens } from "../auth/tokenStore.js";
import { STDIO_SESSION, type SessionContext } from "../mcp/session.js";
import { startDeviceFlow, pollDeviceFlowInBackground } from "../auth/deviceFlow.js";

/**
 * Two shapes flattened into one, because an output schema is a single object
 * and this tool returns either "already connected" or "here is a link". Every
 * branch-specific field is therefore optional; `status` is what discriminates.
 *
 * This doubles as the connect card's contract — the widget reads `authUrl`,
 * `status` and `email` off `toolOutput`, so a rename here breaks the card.
 */
export const connectAccountOutput = {
  status: z.string().describe("already_connected | awaiting_approval"),
  message: z.string(),
  email: z.string().nullable().optional(),
  authUrl: z.string().optional().describe("Open in a browser to approve. Absent when already connected."),
  expiresInMinutes: z.number().optional(),
  createsAccountIfNeeded: z.boolean().optional(),
};

/**
 * Starts the device flow and hands the operator a link.
 *
 * Returns immediately with the URL rather than waiting for approval: a tool
 * call that blocks for minutes reads as a hung server to every MCP client. The
 * polling continues in the background, so by the time the operator asks their
 * next question the token is already in place.
 *
 * This tool is NOT read-only — it changes what the session can see — so it does
 * not carry readOnlyHint and clients will surface it for approval.
 */
export function buildConnectAccount(
  config: Config,
  tokens: SessionTokens,
  session: SessionContext = STDIO_SESSION
) {
  return {
    name: "connect_account",
    config: {
      title: "Connect or create a Dreambooth account",
      description:
        "Connect this conversation to a Dreambooth Studio account. Returns a link the person opens in their own browser to approve with Google. Works for people who do NOT have a Dreambooth account yet — approving creates one, with a 14-day Pro trial — as well as for existing operators. Call this when another tool reports that no account is connected, or when someone asks to connect, sign up, or switch accounts. After returning the link, ask them to open it and say when they are done; do not call this tool again while waiting.",
      inputSchema: {},
      outputSchema: connectAccountOutput,
    },
    handler: async () => {
      // Nothing this tool does can persist on a sessionless request, so say so
      // rather than returning a link that will silently never connect. This is
      // what ChatGPT on iOS and macOS hits today: they send no Mcp-Session-Id
      // on tools/call, and MCP 2026-07-28 removes sessions for everyone.
      if (session.stateless && !tokens.get()) {
        return {
          status: "unsupported_here",
          message:
            "This client does not keep a session between messages, so signing in from inside the conversation cannot work here — a link would be approved and then forgotten. Tell the operator to connect Dreambooth from their client's own connector or app settings, which sends the credential with every request. Product, pricing and troubleshooting questions still work without connecting: use search_docs.",
        };
      }

      if (tokens.get()) {
        return {
          status: "already_connected",
          // Surfaced so the card can name the account instead of saying
          // "connected" and leaving the operator guessing which one.
          email: tokens.getEmail(),
          message:
            "This conversation is already connected to a Dreambooth account. To switch accounts, disconnect first.",
        };
      }

      const { authUrl, state } = await startDeviceFlow(config);
      pollDeviceFlowInBackground(config, tokens, state);

      return {
        status: "awaiting_approval",
        authUrl,
        // Said explicitly because the model otherwise tends to poll by calling
        // the tool again, which starts a second flow and invalidates the first.
        message:
          "Give them this link to open in their browser and approve with Google. If they do not have a Dreambooth account yet, approving creates one with a 14-day Pro trial. Do not call this tool again while waiting — once they have approved, the other tools simply start working.",
        expiresInMinutes: 5,
        createsAccountIfNeeded: true,
      };
    },
  };
}
