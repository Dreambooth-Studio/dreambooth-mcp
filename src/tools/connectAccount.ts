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
  status: z.string().describe("already_connected | awaiting_approval | use_client_sign_in"),
  message: z.string(),
  email: z.string().nullable().optional(),
  authUrl: z.string().optional().describe("Open in a browser to approve. Present only with awaiting_approval."),
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
      title: "Connect a Dreambooth account",
      // One sentence per answer, because which one a caller gets depends on
      // the client, not on anything the model passes. A client that signs in
      // through its own connector settings (a request with no session and no
      // credential) gets no link: a link handed out on a sessionless request
      // would be approved and then forgotten. This used to promise a link to
      // every caller.
      //
      // The two paths do not sign in the same way. The link is the desktop
      // device flow, and the Studio builds it as an accounts.google.com URL
      // (app/api/auth/desktop/google/authorize), so it is Google only; the
      // exchange links a Google account to a password account with the same
      // email, and creates the account otherwise. The client's own sign-in is
      // the Studio's login page, which takes an email and password too.
      //
      // No trial, plan or upgrade is named anywhere this tool speaks. The
      // plugin guidelines say a plugin "must not display subscription plans,
      // initiate new subscriptions, or promote upgrades", and the portal held
      // this tool for review while its description said "a new Dreambooth
      // account comes with a 14-day Pro trial". That a new account is created
      // stays, said plainly, because it is what happens.
      description:
        "Connect this conversation to the person's Dreambooth Studio account. The answer's status says what happened. " +
        "already_connected: an account is connected; nothing to do. " +
        "awaiting_approval: it returns a link the person opens in their own browser to sign in with Google and approve. A Google account with the same email as an existing Dreambooth account connects that account. Ask them to open it and say when they are done; do not call this tool again while waiting. " +
        "use_client_sign_in: this client connects accounts through its own app or connector settings, where they can sign in with an email and password or with Google, so no link is returned. Ask them to connect Dreambooth there (the client also asks by itself when a tool needs an account), then repeat their question. " +
        "Either way, someone who has no Dreambooth account yet gets one when they sign in. " +
        "Call this when another tool reports that no account is connected, or when someone asks to connect or switch accounts.",
      inputSchema: {},
      outputSchema: connectAccountOutput,
    },
    handler: async () => {
      // Nothing this tool does can persist on a sessionless request: the token
      // store is discarded with the response, so a link handed out here would
      // be approved and then forgotten.
      //
      // That is no longer a dead end. This server is an OAuth 2.1 protected
      // resource, so the client has its own sign-in path — it gets a 401
      // naming the authorization server the moment it calls a tool that needs
      // an account. Point at that rather than at a link this tool cannot make
      // work.
      if (session.stateless && !tokens.get()) {
        return {
          status: "use_client_sign_in",
          message:
            "This client signs in through its own connector settings rather than through a link in the conversation, and it will prompt automatically the next time an account is needed — ask them to connect Dreambooth there and then repeat their question. Signing in creates an account if they do not have one. Product, hardware and troubleshooting questions need no account at all: use search_docs.",
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

      // One flow per session at a time. Each call starts a Studio state and a
      // five-minute poller, so repeated calls were an easy way to fan load out
      // onto the Studio; it also invalidated the link already handed out.
      const pending = tokens.pendingLink();
      if (pending) {
        return {
          status: "awaiting_approval",
          authUrl: pending,
          message:
            "A sign-in link is already waiting for approval. Give them this same link; do not call this tool again while waiting.",
          expiresInMinutes: 5,
          createsAccountIfNeeded: true,
        };
      }

      const { authUrl, state } = await startDeviceFlow(config);
      tokens.setPendingLink(authUrl);
      pollDeviceFlowInBackground(config, tokens, state);

      return {
        status: "awaiting_approval",
        authUrl,
        // Said explicitly because the model otherwise tends to poll by calling
        // the tool again, which starts a second flow and invalidates the first.
        message:
          "Give them this link to open in their browser: they sign in with Google, then approve. A Google account with the same email as their Dreambooth account connects that account; if they do not have a Dreambooth account yet, approving creates one. Do not call this tool again while waiting — once they have approved, the other tools simply start working.",
        expiresInMinutes: 5,
        createsAccountIfNeeded: true,
      };
    },
  };
}
