import type { Config } from "../config.js";
import type { SessionTokens } from "./tokenStore.js";

/**
 * Auth v1 — reuses the OAuth device flow the Studio already runs for the
 * Electron booth. No new backend, no new auth server.
 *
 *   POST /api/auth/desktop/google/authorize  {mode:"login"} -> { state, authUrl }
 *   ... operator approves in their own browser ...
 *   GET  /api/auth/desktop/status?state=...             -> { status, sessionToken }
 *   POST /api/auth/desktop/check-session {sessionToken}  -> { valid }
 *
 * The operator's credentials never touch this service; we only ever see the
 * resulting session token, and only in memory.
 *
 * The Studio expires the state after 5 minutes, so polling is bounded to match
 * — an abandoned connect attempt must not leave a timer running for the life of
 * the process.
 */

const POLL_INTERVAL_MS = 2000;
const POLL_CEILING_MS = 5 * 60 * 1000;

interface AuthorizeResponse {
  state?: string;
  /** The Studio's actual field name. `authUrl`/`url` are tolerated in case it is renamed. */
  oauthUrl?: string;
  authUrl?: string;
  url?: string;
  error?: string;
}

interface StatusResponse {
  status: "pending" | "completed" | "expired" | "not_found";
  sessionToken?: string;
  user?: { email?: string };
}

export interface ConnectStart {
  authUrl: string;
  state: string;
}

/** Kicks off the flow and returns the URL the operator must open. */
export async function startDeviceFlow(config: Config): Promise<ConnectStart> {
  const res = await fetch(`${config.apiUrl}/api/auth/desktop/google/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "login" }),
  });

  if (!res.ok) {
    throw new Error(`Could not start sign-in (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as AuthorizeResponse;
  const authUrl = data.oauthUrl || data.authUrl || data.url;
  if (!data.state || !authUrl) {
    throw new Error("Sign-in did not return a link to open.");
  }
  return { authUrl, state: data.state };
}

/**
 * Polls in the background until the operator approves, the state expires, or
 * the ceiling is hit — then writes the token into the session's store.
 *
 * Deliberately not awaited by the tool that starts it: a tool call that blocks
 * for minutes looks like a hung server to every MCP client. The operator's next
 * question arrives after they have approved, and by then the token is in place.
 */
export function pollDeviceFlowInBackground(
  config: Config,
  tokens: SessionTokens,
  state: string,
  log: (message: string) => void = () => {}
): void {
  const startedAt = Date.now();
  tokens.startPending(state);

  const tick = async (): Promise<void> => {
    if (Date.now() - startedAt > POLL_CEILING_MS) {
      tokens.failPending("the sign-in link expired before it was approved");
      log("device flow timed out");
      return;
    }

    try {
      const res = await fetch(
        `${config.apiUrl}/api/auth/desktop/status?state=${encodeURIComponent(state)}`
      );
      if (res.ok) {
        const data = (await res.json()) as StatusResponse;
        if (data.status === "completed" && data.sessionToken) {
          tokens.set(data.sessionToken, data.user?.email);
          log("device flow completed");
          return;
        }
        if (data.status === "expired" || data.status === "not_found") {
          tokens.failPending("the sign-in link expired before it was approved");
          log(`device flow ${data.status}`);
          return;
        }
      }
    } catch {
      // Transient network trouble: keep polling until the ceiling.
    }

    setTimeout(() => void tick(), POLL_INTERVAL_MS).unref?.();
  };

  setTimeout(() => void tick(), POLL_INTERVAL_MS).unref?.();
}

/** Validates a stored token; used at startup and after any 401. */
export async function checkSession(config: Config, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.apiUrl}/api/auth/desktop/check-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionToken: token }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { valid?: boolean };
    return data.valid === true;
  } catch {
    return false;
  }
}
