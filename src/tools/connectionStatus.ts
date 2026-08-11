import { z } from "zod";
import type { SessionTokens } from "../auth/tokenStore.js";

/**
 * The connect card polls this every two seconds and branches on `phase`, so
 * this schema is a UI contract, not just documentation. `phase` is the
 * machine-readable field; `message` is the sentence for the model. Deriving one
 * from the other by parsing English is how a card breaks on a copy edit.
 */
export const connectionStatusOutput = {
  connected: z.boolean(),
  phase: z.enum(["connected", "waiting", "expired", "idle"]),
  email: z.string().nullable(),
  waitingSeconds: z.number().nullable().describe("How long the current device flow has been pending"),
  message: z.string(),
};

/**
 * Whether this session has an account attached yet.
 *
 * Exists for the connect card, which has to poll: the device flow completes in
 * the operator's browser, and nothing pushes that back into the widget. The
 * card calls this every two seconds until the phase flips.
 *
 * Touches no Studio route — it reads the in-memory session and returns. That is
 * what makes it safe to call on a timer.
 *
 * It never returns the token, only whether one exists and which account it
 * belongs to. The email is already visible to the operator whose session this
 * is, and no other session can reach this instance.
 */
export function buildConnectionStatus(tokens: SessionTokens) {
  return {
    name: "connection_status",
    config: {
      title: "Check Dreambooth connection",
      description:
        "Whether this conversation currently has a Dreambooth account connected, and which one. Call this if you are unsure whether to run connect_account first. Cheap and read-only — it does not contact Dreambooth.",
      inputSchema: {},
      outputSchema: connectionStatusOutput,
    },
    handler: async () => {
      const phase = tokens.phase();
      return {
        connected: phase === "connected",
        phase,
        email: tokens.getEmail(),
        waitingSeconds: tokens.waitingSeconds(),
        message: tokens.describe(),
      };
    },
  };
}
