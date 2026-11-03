// Partnr (partnr.ai): Brazilian market news (press and CVM filings) with AI summaries, entities and a relevance
// score. Its public docs list no publisher, original link or full text in the news schema, and public display
// is allowed only "as contracted", so by default items only feed the private review page ("interno"). The
// per-entity impact (POSITIVE/NEGATIVE with a motive) is a directional signal about assets: it is never read.
import { log } from "../log.ts";
import { fetchJson } from "../net.ts";
import type { RawItem, Source } from "../types.ts";

export const PARTNR_BASE_URL = "https://data.partnr.ai/v2";

interface PartnrMetadata {
  published_at?: string;
  analyzed_at?: string;
  categories?: string[];
}

interface PartnrListItem {
  id?: string | number;
  title?: string;
  enhanced_title?: string;
  metadata?: PartnrMetadata;
}

interface PartnrArticle extends PartnrListItem {
  summary?: string;
  key_points?: string[];
  entities?: { type?: string; metadata?: { name?: string } }[];
  relevance_score?: number;
  [field: string]: unknown;
}

export interface PartnrOptions {
  apiKey: string;
  use: "interno" | "publico";
  /** Minimum relevance_score (0–1) for an item to reach the writer in public use. */
  minRelevance: number;
  intervalMs: number;
  baseUrl?: string;
}

/** Fields in the documented schema; anything else is logged once, to learn what the real API sends. */
const DOCUMENTED = new Set(["id", "title", "enhanced_title", "metadata", "summary", "key_points", "entities", "relevance_score"]);
/** Where the full text, the publisher and the original link would be, if the API sends them (none is documented). */
const TEXT_FIELDS = ["content", "body", "text", "full_text", "raw", "article"];
const PUBLISHER_FIELDS = ["source", "source_name", "publisher", "provider"];
const LINK_FIELDS = ["url", "link", "source_url", "original_url"];

const seenFields = new Set<string>();

/** For tests: forget the fields already reported. */
export function resetSeenFields(): void {
  seenFields.clear();
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function firstString(a: PartnrArticle, fields: string[]): string | null {
  for (const f of fields) {
    const v = a[f];
    const s = str(v) ?? (v && typeof v === "object" ? str((v as Record<string, unknown>).name) : null);
    if (s) return s;
  }
  return null;
}

function firstLink(a: PartnrArticle): string | null {
  for (const f of [...LINK_FIELDS, ...PUBLISHER_FIELDS]) {
    const v = a[f];
    const s = str(v) ?? (v && typeof v === "object" ? str((v as Record<string, unknown>).url) : null);
    if (s && /^https?:\/\//i.test(s) && URL.canParse(s)) return s;
  }
  return null;
}

/** The list answers with a bare array (per the official SDKs); an envelope like { data: [...] } is accepted too. */
function listOf(res: unknown): PartnrListItem[] {
  if (Array.isArray(res)) return res;
  const data = res && typeof res === "object" ? (res as Record<string, unknown>).data : undefined;
  if (Array.isArray(data)) return data;
  throw new Error("Partnr: resposta da lista sem notícias");
}

function articleOf(res: unknown): PartnrArticle {
  const data = res && typeof res === "object" ? (res as Record<string, unknown>).data : undefined;
  const a = data && typeof data === "object" && !Array.isArray(data) ? data : res;
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("Partnr: resposta da notícia vazia");
  return a as PartnrArticle;
}

function isoOrNull(s: string | undefined): string | null {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function reportNewFields(a: PartnrArticle): void {
  const fresh = Object.keys(a).filter((k) => !DOCUMENTED.has(k) && !seenFields.has(k));
  if (!fresh.length) return;
  for (const k of fresh) seenFields.add(k);
  log.info(`Partnr: campos fora da documentação na notícia: ${fresh.join(", ")}`);
}

/** What goes to the writer: the full text if the API sends it, else the summary and key points; never the impact. */
function bodyOf(a: PartnrArticle, publisher: string | null): string {
  const text = firstString(a, TEXT_FIELDS);
  const points = (a.key_points ?? []).map(str).filter((p) => p !== null);
  const assets = (a.entities ?? []).map((e) => str(e.metadata?.name)).filter((n) => n !== null);
  return [
    text ?? str(a.summary),
    !text && points.length ? points.map((p) => `- ${p}`).join("\n") : null,
    assets.length ? `Citados: ${[...new Set(assets)].join(", ")}` : null,
    `Publicado originalmente por: ${publisher ?? "veículo não informado pela Partnr"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function reviewReason(o: PartnrOptions, publisher: string | null, link: string | null, relevance: number | null): string | undefined {
  if (o.use === "interno") return `uso interno (Partnr · ${publisher ?? "veículo não informado"}): exibir publicamente depende do contrato por escrito`;
  // The text must credit and link the original story: without both, it cannot go public.
  if (!publisher || !link) return "Partnr sem veículo ou link original: não dá para dar o crédito";
  if (relevance !== null && relevance < o.minRelevance) return `Partnr: relevância ${relevance} abaixo do mínimo ${o.minRelevance}`;
  return undefined;
}

export function partnrSource(o: PartnrOptions): Source {
  const base = (o.baseUrl ?? PARTNR_BASE_URL).replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${o.apiKey}` };
  return {
    id: "partnr",
    name: "Partnr (notícias)",
    tag: "MERCADOS",
    region: "BR",
    intervalMs: o.intervalMs,
    async poll() {
      // Newest first; only new ids go on to the detail call (enrich), so each item costs one more request once.
      const list = listOf(await fetchJson<unknown>(`${base}/news?limit=50`, 15_000, auth));
      const items: RawItem[] = [];
      for (const n of list) {
        const id = n.id === undefined || n.id === null ? null : String(n.id);
        const title = str(n.title) ?? str(n.enhanced_title);
        const publishedAt = isoOrNull(n.metadata?.published_at) ?? isoOrNull(n.metadata?.analyzed_at);
        if (!id || !title || !publishedAt) continue;
        items.push({ sourceId: "partnr", externalId: id, url: "", title, body: "", publishedAt, lang: "pt" });
      }
      return items;
    },
    async enrich(item) {
      const a = articleOf(await fetchJson<unknown>(`${base}/news/${encodeURIComponent(item.externalId)}`, 15_000, auth));
      reportNewFields(a);
      const publisher = firstString(a, PUBLISHER_FIELDS);
      const link = firstLink(a);
      const relevance = typeof a.relevance_score === "number" && Number.isFinite(a.relevance_score) ? a.relevance_score : null;
      const reason = reviewReason(o, publisher, link, relevance);
      return {
        ...item,
        url: link ?? "",
        title: str(a.title) ?? item.title,
        body: bodyOf(a, publisher),
        ...(reason ? { reviewOnly: reason } : {}),
      };
    },
  };
}
