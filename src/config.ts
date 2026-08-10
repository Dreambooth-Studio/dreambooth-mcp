/**
 * Environment, validated once at boot. Fails loudly rather than surfacing as a
 * confusing 401 on the first tool call.
 */

export type Mode = "stdio" | "http";

export interface Config {
  /** Origin of the Studio API. */
  apiUrl: string;
  /**
   * Optional developer token for stdio mode only.
   *
   * In HTTP mode there is no such thing: each session starts unauthenticated
   * and the operator connects through the device flow, so no token is ever
   * pasted into a config file or held for anyone but the person who approved
   * it. When set, this is a NextAuth session JWT — session-equivalent, one
   * year, no scopes, no revocation — so it must never be committed or logged.
   */
  token?: string;
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

export function loadConfig(): Config {
  return {
    apiUrl: (process.env.DREAMBOOTH_API_URL || "https://dreamboothstudio.com").replace(
      /\/$/,
      ""
    ),
    token: process.env.DREAMBOOTH_TOKEN?.trim() || undefined,
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
