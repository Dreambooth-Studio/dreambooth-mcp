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
  /**
   * Registers `session_info`, the connection diagnostic. Off by default: a
   * public directory listing is judged on its tool list, and this one answers
   * nothing an operator asked. Turn it on only to run the session-reuse test.
   */
  diagnostics: boolean;
  /**
   * Registers `generate_frame` and `check_generation`.
   *
   * **Off by default, and that default is the point.** Frame generation
   * reaches Vertex Imagen, and Vertex currently answers `404 NOT_FOUND` for
   * the model this project asks for — so the tools exist, are tested, and
   * cannot succeed. A tool that is listed and always fails is worse than one
   * that is absent: a directory reviewer reads it as a broken connector, and
   * an operator reads it as a broken account.
   *
   * So this is not a feature flag in the usual sense. It is a claim gate:
   * while it is off, nothing in the tool list, the README or the listing copy
   * promises frame generation. Turn it on — `ENABLE_FRAME_GENERATION=1` — in
   * the same change that makes a real generation succeed, and put the frame
   * lines back in `docs/chatgpt-listing.md` at the same time.
   */
  frameGeneration: boolean;
  /**
   * Challenge string issued by the ChatGPT plugin submission portal, served
   * back at /.well-known/openai-apps-challenge to prove we own the host. Empty
   * until a submission is in flight; the route 404s rather than serving blank.
   */
  openaiAppsChallenge: string;
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
    // Opt-in by exact value, not truthiness: MCP_DIAGNOSTICS=0 or =false must
    // mean off, and with a flag whose whole point is "not in production" the
    // surprising reading is the dangerous one.
    diagnostics: ["1", "true", "yes"].includes(
      (process.env.MCP_DIAGNOSTICS || "").trim().toLowerCase()
    ),
    // Same exact-value rule as diagnostics, for the same reason: the
    // surprising reading of a flag like this is the dangerous one.
    frameGeneration: ["1", "true", "yes"].includes(
      (process.env.ENABLE_FRAME_GENERATION || "").trim().toLowerCase()
    ),
    // Trimmed because this gets pasted out of a web form, and a trailing
    // newline would fail the verification with no visible difference.
    openaiAppsChallenge: (process.env.OPENAI_APPS_CHALLENGE || "").trim(),
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
