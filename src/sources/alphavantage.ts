// Alpha Vantage NEWS_SENTIMENT: a multi-publisher news feed (Reuters, Benzinga, CNBC, Yahoo Finance…) filtered by
// topic or ticker. Its standard licence is personal and non-commercial, so by default items only feed the private
// review page ("interno"); "publico" is for when PlatomAI has Alpha Vantage's written commercial agreement.
import { log } from "../log.ts";
import { fetchJson } from "../net.ts";
import type { RawItem, Source } from "../types.ts";

/** One NEWS_SENTIMENT filter: a topic (e.g. economy_monetary) or a ticker (e.g. PBR). */
export interface AvQuery {
  kind: "topics" | "tickers";
  value: string;
}

interface AvArticle {
  title?: string;
  url?: string;
  time_published?: string;
  summary?: string;
  source?: string;
  topics?: { topic: string; relevance_score: string }[];
  ticker_sentiment?: { ticker: string; relevance_score: string }[];
}

interface AvResponse {
  feed?: AvArticle[];
  Information?: string;
  Note?: string;
  "Error Message"?: string;
}

export interface AlphaVantageOptions {
  apiKey: string;
  queries: AvQuery[];
  use: "interno" | "publico";
  /** Minimum relevance (0–1) of the article to the topic or ticker that found it. */
  minRelevance: number;
  intervalMs: number;
}

/** "topics:economy_macro" or "tickers:PBR" -> query; anything else -> null. */
export function parseQuery(s: string): AvQuery | null {
  const m = s.trim().match(/^(topics|tickers):([A-Za-z0-9_.:-]+)$/);
  return m ? { kind: m[1] as AvQuery["kind"], value: m[2] } : null;
}

/** "20261015T174522" -> ISO. Alpha Vantage sends UTC (checked against publishers' own timestamps). */
export function avTime(s: string | undefined): string | null {
  const m = s?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function relevance(a: AvArticle, q: AvQuery): number {
  const scores =
    q.kind === "topics"
      ? (a.topics ?? []).map((t) => [t.topic, t.relevance_score] as const)
      : (a.ticker_sentiment ?? []).map((t) => [t.ticker, t.relevance_score] as const);
  const hit = scores.find(([k]) => k.toLowerCase() === q.value.toLowerCase());
  return hit ? Number(hit[1]) || 0 : 0;
}

function queryUrl(apiKey: string, q: AvQuery): string {
  const p = new URLSearchParams({ function: "NEWS_SENTIMENT", [q.kind]: q.value, sort: "LATEST", limit: "50", apikey: apiKey });
  return `https://www.alphavantage.co/query?${p}`;
}

function toItem(a: AvArticle & { url: string; title: string }, publishedAt: string, use: AlphaVantageOptions["use"]): RawItem {
  const publisher = a.source?.trim() || "veículo não informado";
  return {
    sourceId: "alphavantage",
    externalId: a.url,
    url: a.url,
    title: a.title.trim(),
    // The original publisher goes with the text, so a public headline can credit it.
    body: [a.summary?.trim(), `Publicado originalmente por: ${publisher}`].filter(Boolean).join("\n"),
    publishedAt,
    lang: "en",
    ...(use === "interno"
      ? { reviewOnly: `uso interno (Alpha Vantage · ${publisher}): exibir publicamente exige a licença comercial por escrito` }
      : {}),
  };
}

export function alphaVantageSource(o: AlphaVantageOptions): Source {
  return {
    id: "alphavantage",
    name: "Alpha Vantage (notícias)",
    tag: "MERCADOS",
    region: "INTL",
    intervalMs: o.intervalMs,
    async poll() {
      const byUrl = new Map<string, RawItem>();
      let firstError: unknown = null;
      // One request at a time: the plan's per-minute limit may be shared with PlatomAI's other products.
      for (const q of o.queries) {
        try {
          const res = await fetchJson<AvResponse>(queryUrl(o.apiKey, q), 15_000);
          // Limits, a premium-only function or a bad key come back as HTTP 200 with a message instead of a feed.
          if (!Array.isArray(res.feed)) throw new Error(`Alpha Vantage: ${res["Error Message"] ?? res.Information ?? res.Note ?? "resposta sem notícias"}`);
          for (const a of res.feed) {
            if (!a.url || !/^https?:\/\//i.test(a.url) || !a.title?.trim()) continue;
            if (byUrl.has(a.url) || relevance(a, q) < o.minRelevance) continue;
            const publishedAt = avTime(a.time_published);
            if (publishedAt) byUrl.set(a.url, toItem({ ...a, url: a.url, title: a.title }, publishedAt, o.use));
          }
        } catch (err) {
          firstError ??= err;
          log.warn(`Alpha Vantage: consulta ${q.kind}=${q.value} falhou`, err); // the URL (with the key) is never logged
        }
      }
      if (!byUrl.size && firstError) throw firstError;
      return [...byUrl.values()];
    },
  };
}
