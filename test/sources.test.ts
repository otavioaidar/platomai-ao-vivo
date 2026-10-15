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
  a.items = [{ when: "2026-11-12T12:00:00.000Z", title: "Índice Nacional de Preços ao Consumidor Amplo", product: "", source: "IBGE", done: false }];
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
