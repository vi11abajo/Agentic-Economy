// Runtime settings (environment variables; see deploy/.env.example).
const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8080),
  /** Public path prefix: feed at BASE, MCP at BASE/mcp, stream at BASE/stream. */
  basePath: (env.BASE_PATH ?? "/prosper-monitor").replace(/\/$/, ""),
  publicUrl: env.PUBLIC_URL ?? "https://mcp.pharosfdv.xyz/prosper-monitor",
  dbPath: env.DB_PATH ?? "data/prosper.db",
  /** First block to scan for ProsperFactory market creations (Prosper deployment cutover on Pharos mainnet). */
  startBlock: BigInt(env.START_BLOCK ?? "17515618"),
  pollMs: Number(env.POLL_MS ?? 2500),
  confirmations: BigInt(env.CONFIRMATIONS ?? 2),
  /** Requests per minute per client IP on our HTTP endpoints (MCP + feed). */
  rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 60),
  telegramToken: env.TELEGRAM_BOT_TOKEN ?? "",
  /** Telegram usernames (without @) allowed to subscribe, comma-separated. */
  allowedUsernames: (env.TELEGRAM_ALLOWED_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean),
  adminContact: env.TELEGRAM_ADMIN_CONTACT ?? "@daolog",
};
