import assert from "node:assert/strict";
import { test } from "node:test";
import { partnrSource, resetSeenFields } from "../src/sources/partnr.ts";
import type { PartnrOptions } from "../src/sources/partnr.ts";

/** List items and articles in the shape of Partnr's docs and official SDKs (GET /news, GET /news/{id}). */
const listItem = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `n${n}`,
  title: `Manchete original ${n}`,
  enhanced_title: `Manchete reescrita ${n}`,
  metadata: { published_at: `2026-11-0${n}T12:00:00Z`, analyzed_at: `2026-11-0${n}T12:00:40Z`, categories: ["macro"] },
  ...extra,
});

const article = (n: number, extra: Record<string, unknown> = {}) => ({
  ...listItem(n),
  summary: `Resumo da IA ${n}.`,
  key_points: ["Ponto um", "Ponto dois"],
  entities: [
    { type: "STOCK", id: "PETR4", metadata: { name: "Petrobras" }, impact: { type: "POSITIVE", motive: "MOTIVO-DIRECIONAL" } },
    { type: "MACRO", id: "SELIC", metadata: { name: "Selic" } },
  ],
  relevance_score: 0.8,
  ...extra,
});

interface Call {
  url: URL;
  auth: string | null;
}

function stubFetch(t: { after: (fn: () => void) => void }, handler: (url: URL) => { status?: number; json: unknown }): Call[] {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url, auth: new Headers(init.headers).get("authorization") });
    const r = handler(url);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
    resetSeenFields();
  });
  return calls;
}

const base: PartnrOptions = { apiKey: "CHAVE-SECRETA", use: "interno", minRelevance: 0.5, intervalMs: 15_000 };

test("lists the newest news with the key in the header, never in the URL", async (t) => {
  const calls = stubFetch(t, () => ({ json: [listItem(3), listItem(2)] }));
  const items = await partnrSource(base).poll();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://data.partnr.ai/v2/news?limit=50");
  assert.equal(calls[0].auth, "Bearer CHAVE-SECRETA");
  assert.ok(!calls[0].url.href.includes("CHAVE"));
  assert.deepEqual(items.map((i) => [i.externalId, i.title, i.publishedAt]), [
    ["n3", "Manchete original 3", "2026-11-03T12:00:00.000Z"],
    ["n2", "Manchete original 2", "2026-11-02T12:00:00.000Z"],
  ]);
  assert.equal(items[0].lang, "pt");
});

test("accepts a { data: [...] } envelope and skips items without id, title or date", async (t) => {
  stubFetch(t, () => ({
    json: {
      data: [
        listItem(1),
        listItem(2, { id: undefined }),
        listItem(3, { title: "", enhanced_title: "" }),
        listItem(4, { metadata: { published_at: "ontem" } }),
        listItem(5, { title: undefined }),
      ],
    },
  }));
  const items = await partnrSource(base).poll();
  assert.deepEqual(items.map((i) => [i.externalId, i.title]), [
    ["n1", "Manchete original 1"],
    ["n5", "Manchete reescrita 5"],
  ]);
});

test("the detail feeds summary, key points and asset names to the writer, never the impact signal", async (t) => {
  const calls = stubFetch(t, () => ({ json: article(1) }));
  const src = partnrSource(base);
  const item = await src.enrich!({ sourceId: "partnr", externalId: "n 1/x", url: "", title: "T", body: "", publishedAt: "2026-11-01T12:00:00.000Z", lang: "pt" });
  assert.equal(calls[0].url.pathname, "/v2/news/n%201%2Fx");
  assert.equal(calls[0].auth, "Bearer CHAVE-SECRETA");
  assert.match(item.body, /^Resumo da IA 1\.\n- Ponto um\n- Ponto dois\nCitados: Petrobras, Selic\nPublicado originalmente por: veículo não informado pela Partnr$/);
  assert.doesNotMatch(item.body, /POSITIVE|MOTIVO-DIRECIONAL/);
  assert.equal(item.url, "");
});

test("internal use (the default) keeps every item on the private review page", async (t) => {
  stubFetch(t, () => ({ json: article(1, { source: "Valor Econômico", url: "https://valor.globo.com/x" }) }));
  const item = await partnrSource(base).enrich!({ sourceId: "partnr", externalId: "n1", url: "", title: "T", body: "", publishedAt: "2026-11-01T12:00:00.000Z", lang: "pt" });
  assert.match(item.reviewOnly ?? "", /^uso interno \(Partnr · Valor Econômico\)/);
});

test("public use needs the publisher and the original link to give credit, and a minimum relevance", async (t) => {
  let art: Record<string, unknown> = article(1);
  stubFetch(t, () => ({ json: art }));
  const pub = partnrSource({ ...base, use: "publico" });
  const raw = { sourceId: "partnr", externalId: "n1", url: "", title: "T", body: "", publishedAt: "2026-11-01T12:00:00.000Z", lang: "pt" as const };

  assert.match((await pub.enrich!(raw)).reviewOnly ?? "", /sem veículo ou link original/);

  art = article(1, { source: { name: "Reuters", url: "https://www.reuters.com/a" }, content: "Texto integral da matéria." });
  const ok = await pub.enrich!(raw);
  assert.equal(ok.reviewOnly, undefined);
  assert.equal(ok.url, "https://www.reuters.com/a");
  // With the full text available it replaces the AI summary; the credit line stays.
  assert.match(ok.body, /^Texto integral da matéria\.\nCitados: Petrobras, Selic\nPublicado originalmente por: Reuters$/);

  art = article(1, { source: "Reuters", url: "javascript:alert(1)" });
  assert.match((await pub.enrich!(raw)).reviewOnly ?? "", /sem veículo ou link original/);

  art = article(1, { source: "Reuters", url: "https://www.reuters.com/a", relevance_score: 0.2 });
  assert.match((await pub.enrich!(raw)).reviewOnly ?? "", /relevância 0\.2 abaixo do mínimo 0\.5/);
});

test("an API error says what failed without the key", async (t) => {
  stubFetch(t, () => ({ status: 401, json: { error: { code: 401, message: "Unauthorized." } } }));
  await assert.rejects(partnrSource(base).poll(), (err: Error) => {
    assert.match(err.message, /HTTP 401 em data\.partnr\.ai/);
    assert.doesNotMatch(err.message, /CHAVE/);
    return true;
  });
});

test("a custom base URL (e.g. a host given in the contract) is used for both calls", async (t) => {
  const calls = stubFetch(t, (url) => ({ json: url.pathname.endsWith("/news") ? [listItem(1)] : article(1) }));
  const src = partnrSource({ ...base, baseUrl: "https://api.exemplo.com/v3/" });
  const [item] = await src.poll();
  await src.enrich!(item);
  assert.deepEqual(calls.map((c) => c.url.origin + c.url.pathname), ["https://api.exemplo.com/v3/news", "https://api.exemplo.com/v3/news/n1"]);
});
