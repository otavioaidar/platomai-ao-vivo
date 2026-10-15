import { log } from "./log.ts";
import type { Urgency } from "./types.ts";

export type Env = Record<string, string | undefined>;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const URGENCIES: readonly Urgency[] = ["normal", "alta", "urgente"];
const TRUE = ["1", "true", "sim", "yes", "on"];
const FALSE = ["0", "false", "nao", "não", "no", "off"];

/** "0.25" -> "0,25" for messages to the operator. */
function br(n: number): string {
  return String(n).replace(".", ",");
}

/** Typed readers over the environment. An empty value counts as unset; a bad one warns and uses the default. */
function reader(env: Env, warn: (msg: string) => void) {
  const raw = (name: string) => env[name]?.trim() || undefined;
  const bad = (name: string, v: string, expected: string, def: string) =>
    warn(`config: ${name}="${v}" inválido (${expected}); usando ${def}`);

  return {
    str: (name: string, def: string) => raw(name) ?? def,

    /** Accepts a comma as the decimal separator ("0,5"). */
    num(name: string, def: number, min: number, max: number, int = false): number {
      const v = raw(name);
      if (v === undefined) return def;
      const n = Number(v.replace(",", "."));
      if (Number.isFinite(n) && n >= min && n <= max && (!int || Number.isInteger(n))) return n;
      bad(name, v, `${int ? "inteiro" : "número"} de ${br(min)} a ${br(max)}`, br(def));
      return def;
    },

    /** Case-insensitive choice from a fixed list. */
    oneOf<T extends string>(name: string, allowed: readonly T[], def: T): T {
      const v = raw(name);
      if (v === undefined) return def;
      const hit = allowed.find((a) => a === v.toLowerCase());
      if (hit) return hit;
      bad(name, v, `use ${allowed.join(" | ")}`, def);
      return def;
    },

    bool(name: string, def: boolean): boolean {
      const v = raw(name);
      if (v === undefined) return def;
      if (TRUE.includes(v.toLowerCase())) return true;
      if (FALSE.includes(v.toLowerCase())) return false;
      bad(name, v, "use 1 ou 0", def ? "1" : "0");
      return def;
    },

    /** An http(s) address without the trailing slash. */
    url(name: string, def: string): string {
      const v = raw(name);
      if (v === undefined) return def;
      if (/^https?:\/\/[^/\s]+/i.test(v) && URL.canParse(v)) return v.replace(/\/+$/, "");
      bad(name, v, "endereço http:// ou https://", def);
      return def;
    },
  };
}

/** Reads and validates every setting. Pure apart from `warn`, so tests can pass any environment. */
export function loadConfig(env: Env, warn: (msg: string) => void = (msg) => log.warn(msg)) {
  const r = reader(env, warn);
  return {
    port: r.num("PORT", 8080, 1, 65535, true),
    host: r.str("HOST", "0.0.0.0"),
    siteUrl: r.url("SITE_URL", "http://localhost:8080"),
    dbPath: r.str("DB_PATH", "data/aovivo.db"),
    editorialPath: r.str("EDITORIAL_PATH", "editorial/linha-editorial.md"),
    /** Multiplies every polling interval (use 0.5 to poll twice as often, 4 to be gentler). */
    pollScale: r.num("POLL_SCALE", 1, 0.25, 20),
    /** How many of the latest items per source to show when the site starts with an empty database (0 = none). */
    backfillPerSource: r.num("BACKFILL_PER_SOURCE", 3, 0, 50, true),
    /** Show headlines that failed the automatic check (status "revisar") on the public site. */
    showReview: r.bool("SHOW_REVIEW", false),
    /** Live-stream (SSE) caps: total open streams and streams per viewer IP (0 turns the per-IP cap off). */
    sse: {
      maxClients: r.num("SSE_MAX_CLIENTS", 2000, 1, 100000, true),
      maxPerIp: r.num("SSE_MAX_PER_IP", 20, 0, 10000, true),
    },
    ai: {
      // The SDK also accepts ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile; AI_ENABLED=1 forces it on.
      enabled: r.bool("AI_ENABLED", Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim())),
      model: r.str("AI_MODEL", "claude-opus-5-5"),
      effort: r.oneOf("AI_EFFORT", EFFORTS, "low"),
      concurrency: r.num("AI_CONCURRENCY", 3, 1, 10, true),
    },
    social: {
      /** Lowest urgency that goes to social networks. */
      minUrgency: r.oneOf("SOCIAL_MIN_URGENCY", URGENCIES, "alta"),
      telegram: { token: r.str("TELEGRAM_BOT_TOKEN", ""), chatId: r.str("TELEGRAM_CHAT_ID", "") },
      bluesky: {
        service: r.url("BLUESKY_SERVICE", "https://bsky.social"),
        handle: r.str("BLUESKY_HANDLE", ""),
        appPassword: r.str("BLUESKY_APP_PASSWORD", ""),
      },
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig(process.env);
