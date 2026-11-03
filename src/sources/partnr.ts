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
  relevance_score?: number | string | null;
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
/** Story links only: "source_url" often means the outlet's home page, which cannot credit a story. */
const LINK_FIELDS = ["url", "link", "original_url", "article_url"];

/** Before the detail call: the item cannot be credited yet, so it stays off the public site and away from the AI. */
const NOT_LOADED = "Partnr: detalhe não carregado (sem veículo nem link para o crédito)";
/** Detail calls kept for retries (e.g. after an AI failure), so a retry does not cost the API another request. */
const CACHE_MAX = 200;
const CACHE_TTL_MS = 3600 * 1000;

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
    // A bare URL is not an outlet's name (and must not count as both the publisher and the link).
    if (s && !/^https?:\/\//i.test(s)) return s;
  }
  return null;
}

/** A clean http(s) link to a page below the site root, normalised; anything else (home pages, odd characters) is null. */
export function storyLink(s: string | null): string | null {
  if (!s || /[\u0000-\u001F\u007F\s]/.test(s)) return null;
  const u = URL.parse(s);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  return u.pathname.replace(/\/+$/, "") === "" ? null : u.href;
}

function firstLink(a: PartnrArticle): string | null {
  for (const f of LINK_FIELDS) {
    const link = storyLink(str(a[f]));
    if (link) return link;
  }
  // A publisher object may carry the story link; its home page does not count (storyLink drops it).
  for (const f of PUBLISHER_FIELDS) {
    const v = a[f];
    const link = v && typeof v === "object" ? storyLink(str((v as Record<string, unknown>).url)) : null;
    if (link) return link;
  }
  return null;
}

/** relevance_score as a number in [0, 1] (a numeric string is accepted); anything else is null. */
function relevanceOf(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
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

function internalReason(publisher: string | null): string {
  return `uso interno (Partnr · ${publisher ?? "veículo não informado"}): exibir publicamente depende do contrato por escrito`;
}

function reviewReason(o: PartnrOptions, publisher: string | null, link: string | null, relevance: number | null): string | undefined {
  if (o.use === "interno") return internalReason(publisher);
  // The text must credit and link the original story: without both, it cannot go public.
  if (!publisher || !link) return "Partnr sem veículo ou link original: não dá para dar o crédito";
  // Fails closed: without a valid score the minimum cannot be applied.
  if (relevance === null) return "Partnr sem relevância válida: não dá para aplicar o corte mínimo";
  if (relevance < o.minRelevance) return `Partnr: relevância ${relevance} abaixo do mínimo ${o.minRelevance}`;
  return undefined;
}

export function partnrSource(o: PartnrOptions): Source {
  const base = (o.baseUrl ?? PARTNR_BASE_URL).replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${o.apiKey}` };
  const cache = new Map<string, { at: number; article: PartnrArticle }>();

  async function detail(id: string): Promise<PartnrArticle> {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.article;
    const article = articleOf(await fetchJson<unknown>(`${base}/news/${encodeURIComponent(id)}`, 15_000, auth));
    cache.delete(id);
    cache.set(id, { at: Date.now(), article });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return article;
  }
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
        // The restriction is set here, not only in enrich: if the detail call keeps failing, the queued item still
        // carries it on the give-up path.
        const reviewOnly = o.use === "interno" ? internalReason(null) : NOT_LOADED;
        items.push({ sourceId: "partnr", externalId: id, url: "", title, body: "", publishedAt, lang: "pt", reviewOnly });
      }
      return items;
    },
    async enrich(item) {
      const a = await detail(item.externalId);
      reportNewFields(a);
      const publisher = firstString(a, PUBLISHER_FIELDS);
      const link = firstLink(a);
      const reason = reviewReason(o, publisher, link, relevanceOf(a.relevance_score));
      // reviewOnly is replaced, never inherited: the poll-time mark must not outlive a successful detail.
      const { reviewOnly: _pending, ...rest } = item;
      return {
        ...rest,
        url: link ?? "",
        title: str(a.title) ?? item.title,
        body: bodyOf(a, publisher),
        ...(reason ? { reviewOnly: reason } : {}),
      };
    },
  };
}
