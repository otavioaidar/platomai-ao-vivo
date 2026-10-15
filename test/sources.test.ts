import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { parseFeed } from "../src/sources/feeds.ts";
import { Agenda, SIDRA_SPECS, parseBrDate, parseSidra } from "../src/sources/ibge.ts";
import { renderIndicator } from "../src/writer/templates.ts";
import type { IndicatorRelease } from "../src/types.ts";

const fixture = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

test("parses the BCB Atom feed", () => {
  const entries = parseFeed(fixture("bcb-copom.xml"));
  assert.ok(entries.length > 0);
  const e = entries[0];
  assert.match(e.id, /^sitefeeds_\d+$/);
  assert.match(e.url, /^https:\/\/www\.bcb\.gov\.br\//);
  assert.match(e.title, /Copom/);
  assert.ok(e.html.includes("<p>"), "content keeps the HTML so it can be turned into text");
  assert.ok(!Number.isNaN(Date.parse(e.publishedAt)));
});

test("parses the Fed RSS feed and decodes entities", () => {
  const entries = parseFeed(fixture("fed-monetary.xml"));
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.url.startsWith("https://www.federalreserve.gov/")));
  assert.ok(entries.every((e) => !e.title.includes("&#39;")));
});

test("reads IBGE dates in the right time zone", () => {
  assert.equal(parseBrDate("15/10/2026 09:00:00", -3).toISOString(), "2026-10-15T12:00:00.000Z");
  assert.equal(parseBrDate("23/10/2026 12:00:00", 0).toISOString(), "2026-10-23T12:00:00.000Z");
});

test("agenda marks the window around a scheduled release as hot", () => {
  const a = new Agenda();
  a.items = [{ when: "2026-11-12T12:00:00.000Z", title: "IPCA", product: "Índice Nacional de Preços ao Consumidor Amplo", source: "IBGE", done: false }];
  const ipca = SIDRA_SPECS.find((s) => s.id === "ipca")!;
  assert.equal(a.isHot(ipca.calendarTitle, new Date("2026-11-12T11:59:00Z")), true);
  assert.equal(a.isHot(ipca.calendarTitle, new Date("2026-11-12T12:10:00Z")), true);
  assert.equal(a.isHot(ipca.calendarTitle, new Date("2026-11-12T13:00:00Z")), false);
  const ipca15 = SIDRA_SPECS.find((s) => s.id === "ipca15")!;
  assert.equal(a.isHot(ipca15.calendarTitle, new Date("2026-11-12T12:00:00Z")), false);
});

test("parses SIDRA IPCA with the previous month", () => {
  const spec = SIDRA_SPECS.find((s) => s.id === "ipca")!;
  const rel = parseSidra(spec, JSON.parse(fixture("sidra-ipca.json")))!;
  assert.ok(rel);
  assert.match(rel.period, /^\d{6}$/);
  assert.equal(typeof rel.values.mes, "number");
  assert.equal(typeof rel.values["12m"], "number");
  assert.equal(typeof rel.previous.mes, "number");
  const draft = renderIndicator(rel)!;
  assert.match(draft.headline, /^IPCA de \p{L}+ (sobe|recua|fica estável em) \d/u);
  assert.equal(draft.method, "template");
});

test("parses SIDRA unemployment", () => {
  const spec = SIDRA_SPECS.find((s) => s.id === "desemprego")!;
  const rel = parseSidra(spec, JSON.parse(fixture("sidra-desemprego.json")))!;
  assert.equal(typeof rel.values.taxa, "number");
  assert.match(renderIndicator(rel)!.headline, /^Taxa de desemprego fica em \d+,\d% no trimestre/);
});

// Live SIDRA /t/6381/n1/all/v/4099/p/last 13 (15/10/2026): rolling quarters of the PNAD Contínua.
const PNAD_13: [string, string, string][] = [
  ["202508", "jun-jul-ago 2025", "5.6"], ["202509", "jul-ago-set 2025", "5.6"], ["202510", "ago-set-out 2025", "5.4"],
  ["202511", "set-out-nov 2025", "5.2"], ["202512", "out-nov-dez 2025", "5.1"], ["202601", "nov-dez-jan 2026", "5.4"],
  ["202602", "dez-jan-fev 2026", "5.8"], ["202603", "jan-fev-mar 2026", "6.1"], ["202604", "fev-mar-abr 2026", "5.8"],
  ["202605", "mar-abr-mai 2026", "5.6"], ["202606", "abr-mai-jun 2026", "5.4"], ["202607", "mai-jun-jul 2026", "5.3"],
  ["202608", "jun-jul-ago 2026", "5.3"],
];

function pnadRows(periods: [string, string, string][]) {
  const [header, sample] = JSON.parse(fixture("sidra-desemprego.json"));
  return [header, ...periods.map(([code, label, v]) => ({ ...sample, D3C: code, D3N: label, V: v }))];
}

test("unemployment compares with the previous quarter that shares no month, and a year earlier, as IBGE does", () => {
  const spec = SIDRA_SPECS.find((s) => s.id === "desemprego")!;
  assert.match(spec.path, /\/p\/last%2013$/, "asks SIDRA for enough quarters");
  const rel = parseSidra(spec, pnadRows(PNAD_13))!;
  assert.equal(rel.period, "202608");
  assert.equal(rel.previousPeriodLabel, "mar-abr-mai 2026");
  assert.deepEqual(rel.previous, { taxa: 5.6, taxa_ano_anterior: 5.6 });
  assert.equal(
    renderIndicator(rel)!.headline,
    "Taxa de desemprego fica em 5,3% no trimestre jun-jul-ago; trimestre anterior (mar-abr-mai): 5,6%; mesmo trimestre de 2025: 5,6%",
  );
  // Only the two overlapping quarters: no comparison rather than a misleading one.
  const short = parseSidra(spec, pnadRows(PNAD_13.slice(-2)))!;
  assert.deepEqual(short.previous, {});
  assert.equal(renderIndicator(short)!.headline, "Taxa de desemprego fica em 5,3% no trimestre jun-jul-ago");
});

test("monthly indicators still compare with the previous month", () => {
  const spec = SIDRA_SPECS.find((s) => s.id === "ipca")!;
  const rel = parseSidra(spec, JSON.parse(fixture("sidra-ipca.json")))!;
  assert.equal(rel.period, "202609");
  assert.equal(rel.previousPeriodLabel, "agosto 2026");
  assert.equal(rel.previous.mes, -0.32);
  assert.equal(Object.keys(rel.previous).some((k) => k.endsWith("_ano_anterior")), false);
});

const ipca = (mes: number, consensus: number | null): IndicatorRelease => ({
  indicator: "ipca",
  label: "IPCA",
  period: "202609",
  periodLabel: "setembro 2026",
  previousPeriodLabel: "agosto 2026",
  values: { mes, ano: 3.95, "12m": 4.58 },
  previous: { mes: -0.32 },
  consensus,
});

test("IPCA template compares with the Focus median", () => {
  const above = renderIndicator(ipca(0.82, 0.6))!;
  assert.equal(above.headline, "IPCA de setembro sobe 0,82%, acima da mediana Focus (0,60%); agosto: -0,32%; em 12 meses, 4,58%");
  assert.equal(above.urgency, "urgente");
  assert.match(renderIndicator(ipca(0.6, 0.6))!.headline, /em linha com a mediana Focus/);
  assert.match(renderIndicator(ipca(-0.1, null))!.headline, /^IPCA de setembro recua 0,10%; agosto/);
});

test("Focus comparison uses the numbers as displayed", () => {
  // Olinda medians have 4 decimals: 0.815 is shown as 0,82, so it is in line with 0,82.
  assert.match(renderIndicator(ipca(0.82, 0.815))!.headline, /^IPCA de setembro sobe 0,82%, em linha com a mediana Focus \(0,82%\);/);
  assert.match(renderIndicator(ipca(0.83, 0.825))!.headline, /sobe 0,83%, em linha com a mediana Focus \(0,83%\);/);
  assert.match(renderIndicator(ipca(0.3, 0.295))!.headline, /sobe 0,30%, em linha com a mediana Focus \(0,30%\);/);
  assert.match(renderIndicator(ipca(0.81, 0.815))!.headline, /sobe 0,81%, abaixo da mediana Focus \(0,82%\);/);
  assert.match(renderIndicator(ipca(0.33, 0.3277))!.headline, /sobe 0,33%, em linha com a mediana Focus \(0,33%\);/);
  assert.match(renderIndicator(ipca(-0.32, -0.315))!.headline, /recua 0,32%, em linha com a mediana Focus \(-0,32%\);/);
  // The surprise that makes an IPCA-15 urgent is measured on the displayed numbers too.
  const ipca15 = (mes: number, consensus: number) => ({ ...ipca(mes, consensus), indicator: "ipca15", label: "IPCA-15" });
  assert.equal(renderIndicator(ipca15(0.65, 0.595))!.urgency, "urgente");
  assert.equal(renderIndicator(ipca15(0.64, 0.5951))!.urgency, "alta");
});
