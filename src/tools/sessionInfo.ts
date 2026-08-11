import { z } from "zod";
import type { SessionTokens } from "../auth/tokenStore.js";
import type { SessionContext } from "../mcp/session.js";

export const sessionInfoOutput = {
  sessionId: z.string(),
  transport: z.enum(["http", "stdio"]),
  phase: z.enum(["connected", "waiting", "expired", "idle"]),
  serverStartedAt: z.string(),
  uptimeSeconds: z.number(),
};

/**
 * TEMPORARY — delete once the two questions in docs/apps-sdk-widgets-plan.md §2
 * have been answered.
 *
 * The whole auth model assumes a client keeps one `Mcp-Session-Id` for the life
 * of a conversation, because the operator's token lives in that session's
 * memory and nowhere else. That has never been verified against ChatGPT. If a
 * host re-initialises per turn, every turn starts logged out and the device
 * flow becomes an infinite loop for the operator.
 *
 * Two things to check with this tool:
 *   1. ask three questions in a row — the id must not change;
 *   2. compare the id the MODEL sees with the one a WIDGET sees through
 *      callTool — they must match, or widgets cannot fetch their own data.
 *
 * Returns the session id and auth phase. Never the token.
 */
export function buildSessionInfo(tokens: SessionTokens, session: SessionContext) {
  return {
    name: "session_info",
    config: {
      title: "Session diagnostics",
      description:
        "Diagnostic: returns the id of the MCP session serving this conversation and whether it is authenticated. Only call this when someone is explicitly debugging the connection. It tells the operator nothing about their booths.",
      inputSchema: {},
      outputSchema: sessionInfoOutput,
    },
    handler: async () => ({
      sessionId: session.sessionId() ?? "(none — stdio has no session id)",
      transport: session.transport,
      phase: tokens.phase(),
      serverStartedAt: new Date(START_TIME).toISOString(),
      // A restart is indistinguishable from a lost session at the client end,
      // so report it: "the id changed" means something very different if the
      // process also restarted.
      uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
    }),
  };
}

const START_TIME = Date.now();
