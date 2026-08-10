/**
 * Environment, validated once at boot. Fails loudly rather than surfacing as a
 * confusing 401 on the first tool call.
 */

export interface Config {
  /** Origin of the Studio API. */
  apiUrl: string;
  /**
   * Phase 0 only: a personal NextAuth session token, pasted by the developer.
   *
   * Phase 1 replaces this with the device flow (POST /api/auth/desktop/google/
   * authorize → poll /status), so the operator authorises in their own browser
   * and no token is ever pasted into a config file. This token is
   * session-equivalent — one year, no scopes, no revocation — so it must never
   * be committed, logged, or shared.
   */
  token: string;
  /** Per-request ceiling for calls to the Studio. */
  requestTimeoutMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in — see README.`
    );
  }
  return value.trim();
}

export function loadConfig(): Config {
  return {
    apiUrl: (process.env.DREAMBOOTH_API_URL || "https://dreamboothstudio.com").replace(
      /\/$/,
      ""
    ),
    token: required("DREAMBOOTH_TOKEN"),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
  };
}
