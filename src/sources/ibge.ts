import { fetchJson, pollEvery } from "../net.ts";
import { errorText, log } from "../log.ts";
import type { IndicatorRelease, RawItem, Source } from "../types.ts";

const S = 1000;
const DAY = 24 * 3600 * S;
const BRT_MS = -3 * 3600 * S; // Brazil has had no daylight saving time since 2019
const IBGE = "https://servicodados.ibge.gov.br/api/v3";
/** Hot window around a scheduled release: from 90 s before to 15 min after. */
const LEAD_MS = 90 * S;
const TAIL_MS = 15 * 60 * S;
/** Same rule as the pipeline: a release older than this when first seen is history, not news. */
const STALE_MS = 6 * 3600 * S;

export interface AgendaItem {
  when: string;
  title: string;
  product: string;
  source: string;
  done: boolean;
}

interface CalendarResponse {
  items: { data_divulgacao: string; nome_produto: string; titulo: string; tipo: string }[];
}

/** "15/10/2026 12:00:00" in the given UTC offset (hours) -> Date. */
export function parseBrDate(s: string, offsetHours: number): Date {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return new Date(NaN);
  const [, d, mo, y, h = "00", mi = "00", se = "00"] = m;
  const sign = offsetHours <= 0 ? "-" : "+";
  const off = `${sign}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${off}`);
}

function mdy(d: Date): string {
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${d.getUTCFullYear()}`;
}

/** Short names for the agenda; the full IBGE title stays in `product` for matching. */
const SHORT_NAMES: Record<string, string> = {
  "Índice Nacional de Preços ao Consumidor Amplo": "IPCA",
  "Índice Nacional de Preços ao Consumidor Amplo 15": "IPCA-15",
  "Índice Nacional de Preços ao Consumidor": "INPC",
  "Pesquisa Nacional por Amostra de Domicílios Contínua Mensal": "Desemprego (PNAD Contínua)",
  "Pesquisa Nacional por Amostra de Domicílios Contínua Trimestral": "PNAD Contínua trimestral",
  "Pesquisa Industrial Mensal: Produção Física - Brasil": "Produção industrial (PIM)",
  "Pesquisa Industrial Mensal: Produção Física - Regional": "Produção industrial regional (PIM)",
  "Pesquisa Mensal de Comércio": "Vendas no varejo (PMC)",
  "Pesquisa Mensal de Serviços": "Serviços (PMS)",
  "Levantamento Sistemático da Produção Agrícola": "Safra (LSPA)",
  "Índice de Preços ao Produtor - Indústrias Extrativas e de Transformação": "Preços ao produtor (IPP)",
  "Sistema de Contas Nacionais Trimestrais": "PIB trimestral",
  "Sistema Nacional de Pesquisa de Custos e Índices da Construção Civil": "Custo da construção (Sinapi)",
};

/**
 * IBGE release calendar. Release times in this API are in UTC (IPCA shows 12:00 = 09:00 in Brasília).
 * Used for the site's agenda and to poll SIDRA faster around a scheduled release.
 */
export class Agenda {
  items: AgendaItem[] = [];
  lastOkAt: string | null = null;
  lastError: string | null = null;
  private waiters: (() => void)[] = [];

  /** Whether a refresh has finished at least once (successfully or not). */
  attempted(): boolean {
    return this.lastOkAt !== null || this.lastError !== null;
  }

  /** Resolves when the first refresh finishes, or after `timeoutMs`, whichever comes first. */
  async whenAttempted(timeoutMs: number): Promise<void> {
    if (this.attempted()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Short timeout: a slow calendar must not hold up startup. */
  async refresh(now = new Date(), timeoutMs = 5_000): Promise<void> {
    const from = new Date(now.getTime() - DAY);
    const to = new Date(now.getTime() + 30 * DAY);
    try {
      const res = await fetchJson<CalendarResponse>(`${IBGE}/calendario/?de=${mdy(from)}&ate=${mdy(to)}&qtd=300`, timeoutMs);
      this.items = res.items
        .filter((i) => i.tipo === "Divulgação de Indicadores")
        .map((i) => {
          const when = parseBrDate(i.data_divulgacao, 0);
          const product = i.titulo.trim();
          return { when: when.toISOString(), title: SHORT_NAMES[product] ?? product, product, source: "IBGE", done: when <= now };
        })
        .filter((i) => !Number.isNaN(Date.parse(i.when)))
        .sort((a, b) => a.when.localeCompare(b.when));
      this.lastOkAt = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      this.lastError = errorText(err);
      log.warn("agenda IBGE falhou", err);
    } finally {
      for (const wake of this.waiters.splice(0)) wake();
    }
  }

  upcoming(now = new Date()): AgendaItem[] {
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(3, 0, 0, 0); // 00:00 in Brasília
    if (startOfDay > now) startOfDay.setUTCDate(startOfDay.getUTCDate() - 1);
    return this.items
      .filter((i) => Date.parse(i.when) >= startOfDay.getTime())
      .map((i) => ({ ...i, done: Date.parse(i.when) <= now.getTime() }))
      .slice(0, 40);
  }

  /** The matching release whose hot window (90 s before to 15 min after) contains `now`. */
  current(match: (title: string) => boolean, now = new Date()): AgendaItem | null {
    const t = now.getTime();
    return this.items.find((i) => {
      const w = Date.parse(i.when);
      return match(i.product) && t >= w - LEAD_MS && t <= w + TAIL_MS;
    }) ?? null;
  }

  isHot(match: (title: string) => boolean, now = new Date()): boolean {
    return this.current(match, now) !== null;
  }

  anyHot(now = new Date()): boolean {
    return this.isHot(() => true, now);
  }

  /** Start (epoch ms) of the next hot window of a matching release after `now`, or null. */
  nextHotAt(match: (title: string) => boolean, now = new Date()): number | null {
    const starts = this.items.filter((i) => match(i.product)).map((i) => Date.parse(i.when) - LEAD_MS).filter((s) => s > now.getTime());
    return starts.length ? Math.min(...starts) : null;
  }

  /** Latest matching release whose hot window has opened by `now` (a table may update a few seconds early). */
  lastRelease(match: (title: string) => boolean, now = new Date()): AgendaItem | null {
    const limit = now.getTime() + LEAD_MS;
    return this.items.filter((i) => match(i.product) && Date.parse(i.when) <= limit).at(-1) ?? null;
  }

  /** A matching release scheduled later today (Brasília time). */
  laterToday(match: (title: string) => boolean, now = new Date()): AgendaItem | null {
    const day = (t: number) => Math.floor((t + BRT_MS) / DAY);
    const t = now.getTime();
    return this.items.find((i) => {
      const w = Date.parse(i.when);
      return match(i.product) && w > t && day(w) === day(t);
    }) ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// IBGE press releases (Agência de Notícias): every indicator, as text. Written by the AI.

interface NewsResponse {
  items: { id: number; tipo: string; titulo: string; introducao: string; data_publicacao: string; link: string; produtos: string }[];
}

export function ibgeReleases(agenda: Agenda, scale: number): Source {
  return {
    id: "ibge-releases",
    name: "IBGE (releases)",
    tag: "IBGE",
    region: "BR",
    intervalMs: pollEvery(30 * S, scale),
    hotIntervalMs: (now) => (agenda.anyHot(now) ? pollEvery(3 * S, scale) : null),
    nextHotAt: (now) => agenda.nextHotAt(() => true, now),
    async poll() {
      const res = await fetchJson<NewsResponse>(`${IBGE}/noticias/?tipo=release&qtd=10`);
      return res.items.map(
        (n): RawItem => ({
          sourceId: "ibge-releases",
          externalId: String(n.id),
          url: (n.link ?? "").replace(/^http:\/\//, "https://"),
          title: n.titulo,
          body: `${n.introducao}\n(Pesquisa: ${n.produtos.split("|")[1] ?? ""})`,
          publishedAt: parseBrDate(n.data_publicacao, -3).toISOString(),
          lang: "pt",
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// SIDRA: the numbers themselves, as soon as the table updates. Written by deterministic templates.

export interface SidraSpec {
  id: string;
  label: string;
  /** Path after https://apisidra.ibge.gov.br/values, asking for enough periods for the comparisons. */
  path: string;
  /** Variable code -> key in IndicatorRelease.values. The first key is the headline value. */
  vars: Record<string, string>;
  calendarTitle: (title: string) => boolean;
  /** Periods back to the comparison period: 1 (default) for months, 3 for rolling quarters (no overlap). */
  prevOffset?: number;
  /** Also read the same period a year earlier, into `previous` as `<key>_ano_anterior`. */
  yearAgo?: boolean;
  /** Focus survey indicator for the monthly median (IPCA only). */
  focus?: string;
}

export const SIDRA_SPECS: SidraSpec[] = [
  {
    id: "ipca",
    label: "IPCA",
    path: "/t/1737/n1/all/v/63,69,2265/p/last%202",
    vars: { "63": "mes", "69": "ano", "2265": "12m" },
    calendarTitle: (t) => t.trim() === "Índice Nacional de Preços ao Consumidor Amplo",
    focus: "IPCA",
  },
  {
    id: "ipca15",
    label: "IPCA-15",
    path: "/t/7062/n1/all/v/355,356,1120/p/last%202/c315/7169",
    vars: { "355": "mes", "356": "ano", "1120": "12m" },
    calendarTitle: (t) => t.trim() === "Índice Nacional de Preços ao Consumidor Amplo 15",
  },
  {
    // Rolling quarters: IBGE compares with the previous quarter that shares no month, and with a year earlier.
    id: "desemprego",
    label: "Taxa de desemprego (PNAD Contínua)",
    path: "/t/6381/n1/all/v/4099/p/last%2013",
    vars: { "4099": "taxa" },
    calendarTitle: (t) => t.includes("Pesquisa Nacional por Amostra de Domicílios Contínua Mensal"),
    prevOffset: 3,
    yearAgo: true,
  },
];

type SidraRow = Record<string, string>;

/** Turns SIDRA rows (first row is the header) into the latest release with its comparison periods. */
export function parseSidra(spec: SidraSpec, rows: SidraRow[]): IndicatorRelease | null {
  const data = rows.slice(1);
  const periodKey = Object.keys(rows[0] ?? {}).find((k) => /^D\dC$/.test(k) && /Mês|Trimestre|Ano/.test(rows[0][k]));
  if (!periodKey) return null;
  const labelKey = periodKey.replace(/C$/, "N");
  const varKey = Object.keys(rows[0]).find((k) => /^D\dC$/.test(k) && rows[0][k].startsWith("Variável"));
  if (!varKey) return null;
  const periods = [...new Set(data.map((r) => r[periodKey]))].sort();
  const latest = periods.at(-1);
  if (!latest) return null;
  const prev = periods.at(-1 - (spec.prevOffset ?? 1)) ?? null;
  const yearAgo = spec.yearAgo ? `${Number(latest.slice(0, 4)) - 1}${latest.slice(4)}` : null;
  const pick = (p: string | null) => {
    const out: Record<string, number> = {};
    if (!p) return out;
    for (const r of data.filter((r) => r[periodKey] === p)) {
      const key = spec.vars[r[varKey]];
      const v = Number(r.V);
      if (key && Number.isFinite(v)) out[key] = v;
    }
    return out;
  };
  const values = pick(latest);
  if (!Object.keys(values).length) return null;
  const previous = pick(prev);
  for (const [k, v] of Object.entries(pick(yearAgo))) previous[`${k}_ano_anterior`] = v;
  return {
    indicator: spec.id,
    label: spec.label,
    period: latest,
    periodLabel: data.find((r) => r[periodKey] === latest)?.[labelKey] ?? latest,
    previousPeriodLabel: prev ? data.find((r) => r[periodKey] === prev)?.[labelKey] ?? prev : null,
    values,
    previous,
    consensus: null,
  };
}

/** Focus survey median for a monthly indicator and reference month (YYYYMM). */
export async function focusMedian(indicator: string, yyyymm: string, timeoutMs = 10_000): Promise<number | null> {
  const ref = `${yyyymm.slice(4, 6)}/${yyyymm.slice(0, 4)}`;
  const filter = `Indicador eq '${indicator}' and DataReferencia eq '${ref}' and baseCalculo eq 0`;
  const url =
    "https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativaMercadoMensais" +
    `?$top=1&$format=json&$select=Data,Mediana&$orderby=Data%20desc&$filter=${encodeURIComponent(filter)}`;
  try {
    const res = await fetchJson<{ value: { Mediana: number }[] }>(url, timeoutMs);
    return res.value[0]?.Mediana ?? null;
  } catch (err) {
    log.warn(`Focus ${indicator} ${ref} indisponível`, err);
    return null;
  }
}

/** The month after a YYYYMM period. */
export function nextMonth(yyyymm: string): string {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  return m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, "0")}`;
}

/**
 * When a SIDRA release went out, from the agenda: the latest matching release whose window has opened.
 * Stale when the agenda loaded but knows no such release in the last 6 h (e.g. found after an outage).
 * Falls back to `now` only when the agenda never loaded.
 */
export function releaseTime(agenda: Agenda, match: (title: string) => boolean, now: Date): { publishedAt: string; stale: boolean } {
  if (agenda.lastOkAt === null) return { publishedAt: now.toISOString(), stale: false };
  const r = agenda.lastRelease(match, now);
  if (!r) return { publishedAt: now.toISOString(), stale: true };
  const t = Math.min(Date.parse(r.when), now.getTime());
  return { publishedAt: new Date(t).toISOString(), stale: now.getTime() - t > STALE_MS };
}

/** How long the first SIDRA poll after a start waits for the calendar before judging whether a release is old. */
const AGENDA_WAIT_MS = 6_000;

/** On release day the Focus median is fetched ahead of time; it is refreshed at most this often. */
const FOCUS_TTL_MS = 3600 * S;
/** At release time a missing median gets only this long; the squawk goes out without it otherwise. */
const FOCUS_MISS_MS = 1_500;

export function sidraSource(spec: SidraSpec, agenda: Agenda, scale: number): Source {
  const id = `sidra-${spec.id}`;
  let lastPeriod: string | null = null;
  let newPeriodAt: number | null = null; // when a period newer than the last one appeared
  let watchedPeriod: string | null = null; // the period this process saw replace the previous one
  const focus = new Map<string, { median: number; at: number }>(); // by reference month
  const loading = new Set<string>();

  async function loadFocus(period: string, timeoutMs: number): Promise<number | null> {
    const median = await focusMedian(spec.focus!, period, timeoutMs);
    if (median !== null) focus.set(period, { median, at: Date.now() });
    return median;
  }

  /** Fetches the median for the next period in the background when the agenda says it comes out today. */
  function prefetchFocus(period: string, now: Date): void {
    const cached = focus.get(period);
    if (!spec.focus || loading.has(period) || (cached && now.getTime() - cached.at < FOCUS_TTL_MS)) return;
    if (!agenda.laterToday(spec.calendarTitle, now)) return;
    loading.add(period);
    void loadFocus(period, 10_000).finally(() => loading.delete(period));
  }

  return {
    id,
    name: `IBGE/SIDRA ${spec.label}`,
    tag: "IBGE",
    region: "BR",
    intervalMs: pollEvery(120 * S, scale),
    hotIntervalMs: (now) => {
      const r = agenda.current(spec.calendarTitle, now);
      if (!r) return null;
      // The new number is already out: back to the normal cadence for the rest of the window.
      if (newPeriodAt !== null && newPeriodAt >= Date.parse(r.when) - LEAD_MS) return null;
      return pollEvery(2 * S, scale);
    },
    nextHotAt: (now) => agenda.nextHotAt(spec.calendarTitle, now),
    async poll() {
      const now = new Date();
      const rows = await fetchJson<SidraRow[]>(`https://apisidra.ibge.gov.br/values${spec.path}`);
      const rel = parseSidra(spec, rows);
      if (!rel) return [];
      // A period change this process watched happen is news whatever the agenda says (tables can update early),
      // and stays news on later polls of that period (e.g. if the pipeline failed to record it the first time).
      // On the first poll after a start nothing was watched: that is when an old release could look new, so it
      // waits briefly for the calendar and, without one to date the release, treats it as history.
      if (lastPeriod !== null && rel.period > lastPeriod) {
        watchedPeriod = rel.period;
        newPeriodAt = now.getTime();
      }
      if (lastPeriod === null) await agenda.whenAttempted(AGENDA_WAIT_MS);
      lastPeriod = rel.period;
      prefetchFocus(nextMonth(rel.period), now);
      const watched = rel.period === watchedPeriod;
      const r = releaseTime(agenda, spec.calendarTitle, now);
      const stale = watched ? false : agenda.lastOkAt === null || r.stale;
      // Without an agenda date (none matched, or the calendar never loaded) a watched period keeps the time it was
      // first seen, so later polls of it do not drift to "now".
      const undated = r.stale || agenda.lastOkAt === null;
      const publishedAt = watched && undated && newPeriodAt !== null ? new Date(newPeriodAt).toISOString() : r.publishedAt;
      return [
        {
          sourceId: id,
          externalId: `${spec.id}:${rel.period}`,
          url: `https://sidra.ibge.gov.br/tabela/${spec.path.split("/")[2]}`,
          title: `${spec.label} ${rel.periodLabel}`,
          body: JSON.stringify(rel.values),
          publishedAt,
          lang: "pt",
          data: rel,
          ...(stale ? { stale } : {}),
        },
      ];
    },
    async enrich(item) {
      if (!spec.focus || !item.data) return item;
      const consensus = focus.get(item.data.period)?.median ?? (await loadFocus(item.data.period, FOCUS_MISS_MS));
      return { ...item, data: { ...item.data, consensus } };
    },
  };
}
