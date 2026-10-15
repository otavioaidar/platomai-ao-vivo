import type { Urgency } from "./types.ts";

const env = process.env;

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "sim", "yes", "on"].includes(v.toLowerCase());
}

export const config = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? "0.0.0.0",
  siteUrl: (env.SITE_URL ?? "http://localhost:8080").replace(/\/$/, ""),
  dbPath: env.DB_PATH ?? "data/aovivo.db",
  editorialPath: env.EDITORIAL_PATH ?? "editorial/linha-editorial.md",
  /** Multiplies every polling interval (use 0.5 to poll twice as often, 4 to be gentler). */
  pollScale: Number(env.POLL_SCALE ?? 1),
  /** How many of the latest items per source to show when the site starts with an empty database. */
  backfillPerSource: Number(env.BACKFILL_PER_SOURCE ?? 3),
  /** Show headlines that failed the automatic check (status "revisar") on the public site. */
  showReview: bool(env.SHOW_REVIEW, false),
  ai: {
    // The SDK also accepts ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile; AI_ENABLED=1 forces it on.
    enabled: bool(env.AI_ENABLED, Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)),
    model: env.AI_MODEL ?? "claude-opus-5-5",
    effort: (env.AI_EFFORT ?? "low") as "low" | "medium" | "high" | "xhigh" | "max",
    concurrency: Number(env.AI_CONCURRENCY ?? 3),
  },
  social: {
    /** Lowest urgency that goes to social networks. */
    minUrgency: (env.SOCIAL_MIN_URGENCY ?? "alta") as Urgency,
    telegram: { token: env.TELEGRAM_BOT_TOKEN ?? "", chatId: env.TELEGRAM_CHAT_ID ?? "" },
    bluesky: {
      service: env.BLUESKY_SERVICE ?? "https://bsky.social",
      handle: env.BLUESKY_HANDLE ?? "",
      appPassword: env.BLUESKY_APP_PASSWORD ?? "",
    },
  },
};

export type Config = typeof config;
