import { fetchJson } from "../net.ts";
import { log } from "../log.ts";
import type { IndicatorRelease, RawItem, Source } from "../types.ts";

const S = 1000;
const IBGE = "https://servicodados.ibge.gov.br/api/v3";

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

  async refresh(now = new Date()): Promise<void> {
    const from = new Date(now.getTime() - 24 * 3600 * S);
    const to = new Date(now.getTime() + 30 * 24 * 3600 * S);
    try {
      const res = await fetchJson<CalendarResponse>(`${IBGE}/calendario/?de=${mdy(from)}&ate=${mdy(to)}&qtd=300`);
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
      this.lastError = (err as Error).message;
      log.warn("agenda IBGE falhou", err);
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

  /** True from 90 s before to 15 min after a scheduled release whose title matches. */
  isHot(match: (title: string) => boolean, now = new Date()): boolean {
    const t = now.getTime();
    return this.items.some((i) => {
      const w = Date.parse(i.when);
      return match(i.product) && t >= w - 90 * S && t <= w + 15 * 60 * S;
    });
  }

  anyHot(now = new Date()): boolean {
    return this.isHot(() => true, now);
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
    intervalMs: 30 * S * scale,
    hotIntervalMs: (now) => (agenda.anyHot(now) ? 3 * S : null),
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
  /** Path after https://apisidra.ibge.gov.br/values, asking for the last 2 periods. */
  path: string;
  /** Variable code -> key in IndicatorRelease.values. The first key is the headline value. */
  vars: Record<string, string>;
  calendarTitle: (title: string) => boolean;
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
    id: "desemprego",
    label: "Taxa de desemprego (PNAD Contínua)",
    path: "/t/6381/n1/all/v/4099/p/last%202",
    vars: { "4099": "taxa" },
    calendarTitle: (t) => t.includes("Pesquisa Nacional por Amostra de Domicílios Contínua Mensal"),
  },
];

type SidraRow = Record<string, string>;

/** Turns SIDRA rows (first row is the header) into the latest release with the previous period. */
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
  const prev = periods.length > 1 ? periods.at(-2)! : null;
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
  return {
    indicator: spec.id,
    label: spec.label,
    period: latest,
    periodLabel: data.find((r) => r[periodKey] === latest)?.[labelKey] ?? latest,
    previousPeriodLabel: prev ? data.find((r) => r[periodKey] === prev)?.[labelKey] ?? prev : null,
    values,
    previous: pick(prev),
    consensus: null,
  };
}

/** Focus survey median for a monthly indicator and reference month (YYYYMM). */
export async function focusMedian(indicator: string, yyyymm: string): Promise<number | null> {
  const ref = `${yyyymm.slice(4, 6)}/${yyyymm.slice(0, 4)}`;
  const filter = `Indicador eq '${indicator}' and DataReferencia eq '${ref}' and baseCalculo eq 0`;
  const url =
    "https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativaMercadoMensais" +
    `?$top=1&$format=json&$select=Data,Mediana&$orderby=Data%20desc&$filter=${encodeURIComponent(filter)}`;
  try {
    const res = await fetchJson<{ value: { Mediana: number }[] }>(url);
    return res.value[0]?.Mediana ?? null;
  } catch (err) {
    log.warn(`Focus ${indicator} ${ref} indisponível`, err);
    return null;
  }
}

export function sidraSource(spec: SidraSpec, agenda: Agenda, scale: number): Source {
  return {
    id: `sidra-${spec.id}`,
    name: `IBGE/SIDRA ${spec.label}`,
    tag: "IBGE",
    region: "BR",
    intervalMs: 120 * S * scale,
    hotIntervalMs: (now) => (agenda.isHot(spec.calendarTitle, now) ? 2 * S : null),
    async poll() {
      const rows = await fetchJson<SidraRow[]>(`https://apisidra.ibge.gov.br/values${spec.path}`);
      const rel = parseSidra(spec, rows);
      if (!rel) return [];
      return [
        {
          sourceId: `sidra-${spec.id}`,
          externalId: `${spec.id}:${rel.period}`,
          url: `https://sidra.ibge.gov.br/tabela/${spec.path.split("/")[2]}`,
          title: `${spec.label} ${rel.periodLabel}`,
          body: JSON.stringify(rel.values),
          publishedAt: new Date().toISOString(),
          lang: "pt",
          data: rel,
        },
      ];
    },
    async enrich(item) {
      if (!spec.focus || !item.data) return item;
      const consensus = await focusMedian(spec.focus, item.data.period);
      return { ...item, data: { ...item.data, consensus } };
    },
  };
}
