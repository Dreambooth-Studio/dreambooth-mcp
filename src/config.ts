/**
 * Environment, validated once at boot. Fails loudly rather than surfacing as a
 * confusing 401 on the first tool call.
 */

export type Mode = "stdio" | "http";

export interface Config {
  /** Origin of the Studio API. */
  apiUrl: string;
  /** Per-request ceiling for calls to the Studio. */
  requestTimeoutMs: number;
  /** HTTP mode only. */
  port: number;
  /**
   * Hosts the transport will answer to, for DNS-rebinding protection. Empty
   * means "allow any", which is correct behind Railway's edge but wrong on a
   * developer machine.
   */
  allowedHosts: string[];
}

/**
 * There is deliberately NO token here, in either transport.
 *
 * Every session — stdio included — authenticates through connect_account and
 * the Studio's device flow, so the operator approves in their own browser and
 * the token exists only in memory for the life of that session. A configured
 * token would be a session-equivalent credential (one year, no scopes, no
 * revocation) sitting on disk, and over HTTP it would authenticate every
 * incoming session as one account. Neither is worth the saved 15 seconds.
 */
export function loadConfig(): Config {
  if (process.env.DREAMBOOTH_TOKEN?.trim()) {
    // Read only to say it is ignored: someone following an old README would
    // otherwise set it and wonder why they are still asked to connect.
    console.error(
      "[dreambooth-mcp] DREAMBOOTH_TOKEN is set but ignored — connect with the connect_account tool instead."
    );
  }

  return {
    apiUrl: (process.env.DREAMBOOTH_API_URL || "https://dreamboothstudio.com").replace(
      /\/$/,
      ""
    ),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
    // Railway injects PORT. API_PORT then a default, matching the whatsapp
    // service's port guard; anything non-integer is a config error, not a
    // reason to silently bind somewhere unexpected.
    port: resolvePort(),
    allowedHosts: (process.env.ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

function resolvePort(): number {
  const raw = process.env.PORT || process.env.API_PORT || "8080";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}" — must be an integer between 1 and 65535.`);
  }
  return port;
}

export function resolveMode(argv: string[]): Mode {
  if (argv.includes("--stdio")) return "stdio";
  if (argv.includes("--http")) return "http";
  return (process.env.MCP_MODE as Mode) === "stdio" ? "stdio" : "http";
}
