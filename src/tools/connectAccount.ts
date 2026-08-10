import type { Config } from "../config.js";
import type { SessionTokens } from "../auth/tokenStore.js";
import { startDeviceFlow, pollDeviceFlowInBackground } from "../auth/deviceFlow.js";

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
export function buildConnectAccount(config: Config, tokens: SessionTokens) {
  return {
    name: "connect_account",
    config: {
      title: "Connect a Dreambooth account",
      description:
        "Start connecting this conversation to a Dreambooth Studio account. Returns a link the operator must open in their own browser to approve. Call this when any other tool reports that the account is not connected, or when the operator asks to connect or switch accounts. After returning the link, tell the operator to open it and say when they are done — do not call this tool repeatedly while waiting.",
      inputSchema: {},
    },
    handler: async () => {
      if (tokens.get()) {
        return {
          status: "already_connected",
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
          "Give the operator this link to open in their browser and approve. Do not call this tool again while waiting — once they have approved, the other tools will simply start working.",
        expiresInMinutes: 5,
      };
    },
  };
}
