import { log } from "./log.ts";
import type { Urgency } from "./types.ts";

export type Env = Record<string, string | undefined>;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const URGENCIES: readonly Urgency[] = ["normal", "alta", "urgente"];
const AV_USES = ["interno", "publico"] as const;
const PARTNR_USES = ["interno", "publico"] as const;
const DECIFRA_MODES = ["revisao", "automatica"] as const;
/** Official sources by id prefix: bcb-copom, bcb-atas, bcb-notas, fed-*, ecb-press, ibge-releases, sidra-*, cvm-fatos. */
export const DECIFRA_SOURCES = ["bcb", "fed", "ecb", "ibge", "sidra", "cvm"] as const;
/** Press feeds on by default: outlets whose titles we show with credit and link (see src/sources/press.ts). */
export const PRESS_DEFAULT = ["agenciabrasil", "infomoney", "poder360", "g1", "moneytimes"] as const;
export const PRESS_ALL = [...PRESS_DEFAULT, "folha"] as const;
/** Monetary, macro and fiscal news, plus US-listed Brazilian companies (ADRs and Nasdaq/NYSE listings). */
const AV_DEFAULT_QUERIES = [
  "topics:economy_monetary", "topics:economy_macro", "topics:economy_fiscal",
  "tickers:PBR", "tickers:VALE", "tickers:ITUB", "tickers:BBD", "tickers:NU", "tickers:XP", "tickers:ERJ", "tickers:SBS",
];
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

    /**
     * Comma-separated values, trimmed; values that fail `valid` are dropped with a warning. `lower` also accepts
     * spaces or semicolons between values and any letter case. `failClosed`: when no value is valid, the result is
     * empty instead of the default, so a typo meant to narrow something never widens it.
     */
    list(name: string, def: readonly string[], valid: (v: string) => boolean, expected: string, opts: { lower?: boolean; failClosed?: boolean } = {}): string[] {
      const v = raw(name);
      if (v === undefined) return [...def];
      const items = (opts.lower ? v.toLowerCase().split(/[,;\s]+/) : v.split(",")).map((s) => s.trim()).filter(Boolean);
      const good = items.filter(valid);
      for (const b of items.filter((i) => !valid(i))) warn(`config: ${name} ignora "${b}" (${expected})`);
      if (good.length) return good;
      if (opts.failClosed) {
        warn(`config: ${name}="${v}" sem nenhum valor válido (${expected}); desligado`);
        return [];
      }
      bad(name, v, expected, def.join(","));
      return [...def];
    },

    /** A token that goes in an HTTP header: printable ASCII only. A bad one warns without echoing it and stays off. */
    secret(name: string): string {
      const v = raw(name);
      if (v === undefined) return "";
      if (/^[\x21-\x7e]+$/.test(v)) return v;
      warn(`config: ${name} inválida (espaço ou caractere de controle); valor ignorado`);
      return "";
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
  const aiKey = r.secret("PLATOMAI_ANTHROPIC_API_KEY");
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
    /** Token for the private review page (/revisao). Empty: the page's data API is off. */
    reviewToken: r.str("REVIEW_TOKEN", ""),
    alphaVantage: {
      apiKey: r.str("ALPHAVANTAGE_API_KEY", ""),
      /**
       * interno: a private radar (review page only). publico: items become headlines, which requires Alpha Vantage's
       * written commercial agreement: its standard licence is personal and non-commercial.
       */
      use: r.oneOf("ALPHAVANTAGE_USO", AV_USES, "interno"),
      queries: r.list("ALPHAVANTAGE_CONSULTAS", AV_DEFAULT_QUERIES, (q) => /^(topics|tickers):[A-Za-z0-9_.:-]+$/.test(q), "use topics:<tema> ou tickers:<código>"),
      // Alpha Vantage scores are generous: on a live AAPL sample, 0.8 kept 20 of 20 Apple stories, 0.5 let in 29 unrelated ones.
      minRelevance: r.num("ALPHAVANTAGE_RELEVANCIA_MIN", 0.8, 0, 1),
      intervalMs: r.num("ALPHAVANTAGE_INTERVALO_S", 120, 30, 3600, true) * 1000,
    },
    cvm: {
      /** Fatos relevantes from the CVM's own search: an official, free source, on by default. */
      enabled: r.bool("CVM_FATOS", true),
      intervalMs: r.num("CVM_INTERVALO_S", 30, 10, 3600, true) * 1000,
    },
    partnr: {
      apiKey: r.secret("PARTNR_API_KEY"),
      /**
       * interno: a private radar (review page only). publico: items go to the writer, which requires the written
       * contract to cover public display and social posts, plus the publisher and original link in each item.
       */
      use: r.oneOf("PARTNR_USO", PARTNR_USES, "interno"),
      minRelevance: r.num("PARTNR_RELEVANCIA_MIN", 0.5, 0, 1),
      intervalMs: r.num("PARTNR_INTERVALO_S", 15, 5, 3600, true) * 1000,
      baseUrl: r.url("PARTNR_URL", "https://data.partnr.ai/v2"),
    },
    /** Live-stream (SSE) caps: total open streams and streams per viewer IP (0 turns the per-IP cap off). */
    sse: {
      maxClients: r.num("SSE_MAX_CLIENTS", 2000, 1, 100000, true),
      maxPerIp: r.num("SSE_MAX_PER_IP", 20, 0, 10000, true),
    },
    ai: {
      /** The app's own key. Preferred over ANTHROPIC_API_KEY, which a development machine may set for other tools. */
      apiKey: aiKey,
      baseUrl: r.url("PLATOMAI_ANTHROPIC_URL", "https://api.anthropic.com"),
      // The SDK also accepts ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile; AI_ENABLED=1 forces it on.
      enabled: r.bool("AI_ENABLED", Boolean(aiKey || env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim())),
      model: r.str("AI_MODEL", "claude-opus-5-5"),
      effort: r.oneOf("AI_EFFORT", EFFORTS, "low"),
      concurrency: r.num("AI_CONCURRENCY", 3, 1, 10, true),
    },
    /** "PlatomAI decifra": the analyst agent's short analysis of each live official headline. Needs the AI on. */
    decifra: {
      enabled: r.bool("DECIFRA", true),
      /** revisao: every text waits for one click on /revisao. automatica: texts that pass every check go straight out. */
      mode: r.oneOf("DECIFRA_PUBLICACAO", DECIFRA_MODES, "revisao"),
      model: r.str("DECIFRA_MODELO", "claude-opus-5-5"),
      effort: r.oneOf("DECIFRA_ESFORCO", EFFORTS, "medium"),
      concurrency: r.num("DECIFRA_CONCORRENCIA", 2, 1, 5, true),
      /** Which official sources get a decifra, by id or id prefix ("bcb", "fed", "bcb-copom", "cvm"…). */
      sources: r.list("DECIFRA_FONTES", DECIFRA_SOURCES, (v) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v), "use prefixos como bcb, fed, ecb, ibge, sidra, cvm", { lower: true, failClosed: true }),
      /**
       * Fatos relevantes get a decifra only from this urgency up. The headline writer sets it from the "Urgência" section
       * of the editorial line (alta: M&A, change of control, judicial recovery, share offering, revised projections,
       * extraordinary dividend…), so editing that file changes which fatos relevantes are analysed.
       */
      cvmMinUrgency: r.oneOf("DECIFRA_CVM_URGENCIA", URGENCIES, "alta"),
      promptPath: r.str("DECIFRA_PROMPT", "editorial/agente-analise.md"),
    },
    /** Press feeds: the outlet's title, credit and link, never rewritten and never sent to the AI. */
    press: {
      outlets: r.list("IMPRENSA_FONTES", PRESS_DEFAULT, (v) => (PRESS_ALL as readonly string[]).includes(v) || v === "nenhuma", `use ${PRESS_ALL.join(", ")} ou nenhuma`, { lower: true, failClosed: true })
        .filter((v) => v !== "nenhuma"),
      intervalMs: r.num("IMPRENSA_INTERVALO_S", 60, 30, 3600, true) * 1000,
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
