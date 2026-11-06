export type Region = "BR" | "INTL";
export type Urgency = "urgente" | "alta" | "normal";
/**
 * template = deterministic text from official numbers; ia = written by Claude; rascunho = AI off, raw title shown;
 * titulo = a press outlet's own title, shown as is with credit and link (never rewritten, never sent to the AI).
 */
export type Method = "template" | "ia" | "rascunho" | "titulo";
/** revisar = failed an automatic check and waits for a human; never sent to social networks. */
export type Status = "publicado" | "revisar";

/** Numeric release from an official statistics API (e.g. IPCA on SIDRA). */
export interface IndicatorRelease {
  indicator: string;
  label: string;
  period: string;
  periodLabel: string;
  previousPeriodLabel: string | null;
  values: Record<string, number>;
  previous: Record<string, number>;
  /** Market median for the headline value (Focus survey), when one exists. */
  consensus: number | null;
}

/** Something new a source found, before any writing. */
export interface RawItem {
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  body: string;
  publishedAt: string;
  lang: "pt" | "en";
  data?: IndicatorRelease;
  /** The source knows this item is old news (e.g. a release from before an outage): show it as history only. */
  stale?: boolean;
  /**
   * The source's licence covers internal use only (e.g. Alpha Vantage without a written commercial agreement):
   * the item is kept for the private review page with this reason, never shown publicly, and never sent to the AI.
   */
  reviewOnly?: string;
  /** Set by the pipeline on items from a source's first poll, which are shown as history. */
  firstLoad?: boolean;
  /** Set by enrich when the item is a copy of another one already handled (e.g. a joint fato relevante filed by two companies): dropped. */
  duplicateOf?: string;
}

export interface SourceStatus {
  id: string;
  name: string;
  lastOkAt: string | null;
  lastError: string | null;
}

/**
 * oficial: official acts and data (BCB, Fed, ECB, IBGE, CVM), which get "PlatomAI explica" and "PlatomAI decifra".
 * imprensa: a press outlet's feed, shown as title, credit and link only, with no AI.
 * Unset: a licensed feed (Alpha Vantage, Partnr), handled by its own licence flags.
 */
export type SourceKind = "oficial" | "imprensa";

export interface Source {
  id: string;
  name: string;
  tag: string;
  region: Region;
  kind?: SourceKind;
  /** Name in the source status list when one outlet has several feeds ("Agência Brasil (economia)"); defaults to name. */
  label?: string;
  /** Normal polling interval. */
  intervalMs: number;
  /** Optional faster cadence, e.g. around a scheduled release. Returns null to use intervalMs. */
  hotIntervalMs?: (now: Date) => number | null;
  /** Optional start (epoch ms) of the next hot window after `now`, so the scheduler can wake up in time for it. */
  nextHotAt?: (now: Date) => number | null;
  poll(): Promise<RawItem[]>;
  /** Optional enrichment done only for new items (e.g. fetch the full article). */
  enrich?(item: RawItem): Promise<RawItem>;
}

/** What the writer returns for one item. */
export interface Draft {
  publish: boolean;
  urgency: Urgency;
  headline: string;
  explainer: string | null;
  topics: string[];
  reason: string;
  method: Method;
}

export interface Headline {
  id: string;
  publishedAt: string;
  sourcePublishedAt: string;
  detectedAt: string;
  sourceId: string;
  sourceName: string;
  tag: string;
  region: Region;
  urgency: Urgency;
  headline: string;
  explainer: string | null;
  topics: string[];
  url: string;
  method: Method;
  status: Status;
  backfill: boolean;
  /** Why a backfill item is history: a source's first load, flagged old by the source, or written more than 6 h late. */
  history?: "inicio" | "fonte" | "atraso";
  /** Milliseconds from detection at the source to publication on the site. */
  latencyMs: number;
  reviewReason?: string;
  /** Set to "en" when the headline is the source's English title (AI off or review copy). */
  lang?: "pt" | "en";
  /** From a source licensed for internal use only: shown on the private review page, never on the public site. */
  internalOnly?: boolean;
  /** The "PlatomAI decifra" analysis of an official headline. Public only once its status is "publicado". */
  decifra?: Decifra;
  /** Why the analyst agent answered NÃO VALE TEXTO for this headline (internal, for the review page). */
  decifraSkipped?: string;
}

/**
 * revisar = waits for one-click approval on /revisao; publicado = shown on the site;
 * descartado = a reviewer turned it down (kept for the record, never shown).
 */
export type DecifraStatus = "revisar" | "publicado" | "descartado";

/** The analyst agent's text (editorial/agente-analise.md), split into the sections of its delivery format. */
export interface DecifraText {
  title: string;
  subtitle: string;
  date: string;
  summary: string;
  /** "PlatomAI decifra" itself: one or two short paragraphs, the last ending in the closing image. */
  analysis: string[];
  impact: { label: string; text: string }[];
  keyMessage: string;
}

export interface Decifra extends DecifraText {
  status: DecifraStatus;
  createdAt: string;
  reviewedAt?: string;
  /** What the automatic check found (word ceilings, numbers, copied passages…), for the reviewer. Never public. */
  checks?: string[];
}

export const TOPICS = [
  "juros", "inflacao", "cambio", "fiscal", "atividade", "emprego", "bancos-centrais",
  "commodities", "bolsa", "credito", "politica", "global", "regulacao",
] as const;
