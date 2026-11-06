// Press feeds: each outlet's own title, with credit and a link to the story. Nothing else of the story is kept
// (no summary, no body) and nothing goes to the AI: an isolated title is not protected (Lei 9.610, art. 8, VI),
// but the text is, and several outlets forbid AI use of their content outright.
import { fetchConditional, pollEvery } from "../net.ts";
import { feedEntries, parseFeed } from "./feeds.ts";
import type { RawItem, Source } from "../types.ts";

export interface PressFeed {
  /** Source id, e.g. "imprensa-g1-economia". */
  id: string;
  /** Catalogue entry that turns it on (IMPRENSA_FONTES). */
  outlet: string;
  /** The credit shown next to the title. */
  name: string;
  /** Which feed of the outlet, for the source status list ("economia"). */
  section?: string;
  url: string;
  /** Only stories whose link path starts with one of these (sections of a general feed). Empty: every path. */
  paths?: string[];
  /** Polling interval before POLL_SCALE; defaults to IMPRENSA_INTERVALO_S. */
  intervalMs?: number;
}

const MIN = 60_000;

export const PRESS_FEEDS: PressFeed[] = [
  { id: "imprensa-agenciabrasil-economia", outlet: "agenciabrasil", name: "Agência Brasil", section: "economia", url: "https://agenciabrasil.ebc.com.br/rss/economia/feed.xml" },
  { id: "imprensa-agenciabrasil-politica", outlet: "agenciabrasil", name: "Agência Brasil", section: "política", url: "https://agenciabrasil.ebc.com.br/rss/politica/feed.xml" },
  { id: "imprensa-agenciabrasil-internacional", outlet: "agenciabrasil", name: "Agência Brasil", section: "internacional", url: "https://agenciabrasil.ebc.com.br/rss/internacional/feed.xml" },
  { id: "imprensa-infomoney", outlet: "infomoney", name: "InfoMoney", url: "https://www.infomoney.com.br/feed/", paths: ["/mercados/", "/economia/", "/politica/", "/mundo/"] },
  {
    id: "imprensa-poder360",
    outlet: "poder360",
    name: "Poder360",
    url: "https://www.poder360.com.br/feed/",
    paths: ["/poder-economia/", "/poder-governo/", "/poder-congresso/", "/poder-internacional/", "/poder-eleicoes/", "/poder-energia/", "/poder-agro/"],
  },
  // The g1 feeds are large (about 600 KB): polled less often, with conditional requests.
  { id: "imprensa-g1-economia", outlet: "g1", name: "g1", section: "economia", url: "https://g1.globo.com/rss/g1/economia/", paths: ["/economia/"], intervalMs: 3 * MIN },
  { id: "imprensa-g1-politica", outlet: "g1", name: "g1", section: "política", url: "https://g1.globo.com/rss/g1/politica/", paths: ["/politica/"], intervalMs: 3 * MIN },
  { id: "imprensa-moneytimes", outlet: "moneytimes", name: "Money Times", url: "https://www.moneytimes.com.br/feed/" },
  // Off by default: Folha's terms require authorization for reproduction (IMPRENSA_FONTES=…,folha turns it on).
  { id: "imprensa-folha-mercado", outlet: "folha", name: "Folha", url: "https://feeds.folha.uol.com.br/mercado/rss091.xml" },
];

/**
 * Titles that are not news for this site: stock picks and recommendations (PlatomAI never recommends, and a
 * title with a ticker is usually a pick), advertising, live blogs whose title keeps changing, and service pieces.
 */
const SKIP: RegExp[] = [
  // B3 tickers (PETR4, BODB11): company facts come from the CVM filings instead.
  /\b[A-Z]{4}(?:3|4|5|6|11)\b/,
  /pre[çc]o[- ]alvo|recomenda(?:ção|ções)? de (?:compra|venda)|recomendam? (?:a )?(?:compra|venda)|carteira (?:recomendada|de ações|de dividendos|de fiis)|onde investir|vale a pena|para (?:comprar|investir|lucrar)|(?<![\p{L}])compre(?![\p{L}])|comprar ou vender|hora de (?:comprar|vender)|melhores (?:ações|fundos|fiis|investimentos|bdrs)|ações (?:para|que podem)|renda (?:extra|passiva)|dividendos (?:para|de até)/iu,
  /desconto|imperdível|cupom|black friday|patrocinad|publieditorial|conteúdo de marca|inscrições|concurso|vagas|mega-sena|loteria|lotofácil|quina|horóscopo/iu,
  /(?:^|\s)ao vivo(?::|\s*[-–|])/iu,
];

export function skipTitle(title: string): boolean {
  return SKIP.some((re) => re.test(title));
}

function pathOk(url: string, paths: string[] | undefined): boolean {
  if (!paths?.length) return true;
  const p = URL.parse(url)?.pathname ?? "";
  return paths.some((prefix) => p.startsWith(prefix));
}

/** Folha links go through a redirector ("…/redir/online/mercado/rss091/*https://www1.folha…"): keep the story's own address. */
export function storyUrl(url: string): string {
  const i = url.indexOf("*http");
  return i >= 0 ? url.slice(i + 1) : url;
}

export function pressSource(feed: PressFeed, defaultIntervalMs: number, scale: number): Source {
  return {
    id: feed.id,
    name: feed.name,
    ...(feed.section ? { label: `${feed.name} (${feed.section})` } : {}),
    tag: "IMPRENSA",
    region: "BR",
    kind: "imprensa",
    intervalMs: pollEvery(feed.intervalMs ?? defaultIntervalMs, scale),
    async poll() {
      const { changed, body } = await fetchConditional(feed.url, 10_000, feedEntries);
      if (!changed) return [];
      return parseFeed(body)
        .map((e) => ({ ...e, url: storyUrl(e.url), title: e.title.replace(/\s+/g, " ").trim() }))
        .filter((e) => e.title && e.url && pathOk(e.url, feed.paths) && !skipTitle(e.title))
        .map(
          (e): RawItem => ({
            sourceId: feed.id,
            externalId: e.id || e.url,
            url: e.url,
            title: e.title,
            body: "", // the story's text is the outlet's: never stored
            publishedAt: e.publishedAt,
            lang: "pt",
          }),
        );
    },
  };
}

export function pressFeeds(outlets: readonly string[], defaultIntervalMs: number, scale: number): Source[] {
  return PRESS_FEEDS.filter((f) => outlets.includes(f.outlet)).map((f) => pressSource(f, defaultIntervalMs, scale));
}

// ---------------------------------------------------------------------------------------------
// The same story from several outlets is shown once.

const STOP = new Set([
  "para", "pelo", "pela", "pelos", "pelas", "com", "sem", "sobre", "após", "apos", "entre", "como", "mais", "menos", "diz", "dizem",
  "veja", "entenda", "que", "dos", "das", "nos", "nas", "uma", "uns", "umas", "seu", "sua", "seus", "suas", "este", "esta", "isso",
  "até", "ate", "governo",
]);

function keyWords(title: string): Set<string> {
  const words = title.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+(?:[.,]\p{N}+)?%?/gu) ?? [];
  return new Set(words.filter((w) => (w.length >= 4 || /\d/.test(w)) && !STOP.has(w)));
}

/** True when two titles share most of their key words (overlap over the shorter one). */
export function sameStory(a: string, b: string, threshold = 0.85): boolean {
  const x = keyWords(a);
  const y = keyWords(b);
  const small = Math.min(x.size, y.size);
  if (small < 3) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / small >= threshold;
}
