export type Region = "BR" | "INTL";
export type Urgency = "urgente" | "alta" | "normal";
/** template = deterministic text from official numbers; ia = written by Claude; rascunho = AI off, raw title shown. */
export type Method = "template" | "ia" | "rascunho";
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
}

export interface SourceStatus {
  id: string;
  name: string;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface Source {
  id: string;
  name: string;
  tag: string;
  region: Region;
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
}

export const TOPICS = [
  "juros", "inflacao", "cambio", "fiscal", "atividade", "emprego", "bancos-centrais",
  "commodities", "bolsa", "credito", "politica", "global", "regulacao",
] as const;
