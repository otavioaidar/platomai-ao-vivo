import assert from "node:assert/strict";
import { test } from "node:test";
import { alphaVantageSource, avTime, parseQuery } from "../src/sources/alphavantage.ts";
import type { AlphaVantageOptions } from "../src/sources/alphavantage.ts";

/** Synthetic articles in Alpha Vantage's NEWS_SENTIMENT shape (field names and formats as the live API sends them). */
const article = (n: number, extra: Record<string, unknown> = {}) => ({
  title: `Manchete de teste ${n}`,
  url: `https://example.com/noticia-${n}`,
  time_published: `2026101${n}T174522`,
  summary: `Resumo ${n}.`,
  source: "Agência Exemplo",
  topics: [{ topic: "economy_monetary", relevance_score: "0.9" }],
  ticker_sentiment: [{ ticker: "PBR", relevance_score: "0.8" }],
  ...extra,
});

function stubFetch(t: { after: (fn: () => void) => void }, handler: (url: URL) => unknown) {
  const real = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url);
    return new Response(JSON.stringify(handler(url)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

const base: AlphaVantageOptions = {
  apiKey: "CHAVE-SECRETA",
  queries: [parseQuery("topics:economy_monetary")!, parseQuery("tickers:PBR")!],
  use: "interno",
  minRelevance: 0.5,
  intervalMs: 120_000,
};

test("reads queries and Alpha Vantage's UTC timestamps", () => {
  assert.deepEqual(parseQuery("topics:economy_macro"), { kind: "topics", value: "economy_macro" });
  assert.deepEqual(parseQuery(" tickers:FOREX:BRL "), { kind: "tickers", value: "FOREX:BRL" });
  assert.equal(parseQuery("keywords:selic"), null);
  // An LA Times story published at 17:45:11Z showed up as 20261015T174522.
  assert.equal(avTime("20261015T174522"), "2026-10-15T17:45:22.000Z");
  assert.equal(avTime("20261015T1745"), "2026-10-15T17:45:00.000Z");
  assert.equal(avTime("15/10/2026"), null);
  assert.equal(avTime(undefined), null);
});

test("asks NEWS_SENTIMENT once per query, newest first, and merges the same article found twice", async (t) => {
  const calls = stubFetch(t, () => ({ feed: [article(5), article(4)] }));
  const items = await alphaVantageSource(base).poll();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get("function"), "NEWS_SENTIMENT");
  assert.equal(calls[0].searchParams.get("topics"), "economy_monetary");
  assert.equal(calls[1].searchParams.get("tickers"), "PBR");
  assert.equal(calls[0].searchParams.get("sort"), "LATEST");
  assert.deepEqual(items.map((i) => i.externalId), ["https://example.com/noticia-5", "https://example.com/noticia-4"]);
  assert.equal(items[0].lang, "en");
  assert.equal(items[0].publishedAt, "2026-10-15T17:45:22.000Z");
  assert.match(items[0].body, /Publicado originalmente por: Agência Exemplo/);
});

test("internal use (the default) marks every item for the private review only; public use does not", async (t) => {
  stubFetch(t, () => ({ feed: [article(5)] }));
  const [internal] = await alphaVantageSource(base).poll();
  assert.match(internal.reviewOnly ?? "", /^uso interno \(Alpha Vantage · Agência Exemplo\)/);
  const [pub] = await alphaVantageSource({ ...base, use: "publico" }).poll();
  assert.equal(pub.reviewOnly, undefined);
});

test("drops articles below the relevance floor for the query that found them, and bad links", async (t) => {
  stubFetch(t, (url) =>
    url.searchParams.get("topics")
      ? { feed: [article(1, { topics: [{ topic: "economy_monetary", relevance_score: "0.2" }] }), article(2, { url: "javascript:alert(1)" })] }
      : { feed: [] },
  );
  assert.deepEqual(await alphaVantageSource(base).poll(), []);
});

test("an article weak for one query but strong for another is kept", async (t) => {
  const weakTopic = article(3, { topics: [{ topic: "economy_monetary", relevance_score: "0.1" }] });
  stubFetch(t, () => ({ feed: [weakTopic] }));
  const items = await alphaVantageSource(base).poll();
  assert.equal(items.length, 1, "found again by tickers:PBR with relevance 0.8");
});

test("a limit or premium message fails the poll without leaking the key; one bad query does not sink the others", async (t) => {
  stubFetch(t, () => ({ Information: "Thank you for using Alpha Vantage! This is a premium endpoint." }));
  await assert.rejects(alphaVantageSource(base).poll(), (err: Error) => {
    assert.match(err.message, /premium endpoint/);
    assert.doesNotMatch(err.message, /CHAVE-SECRETA/);
    return true;
  });
});

test("partial failure still returns what the other queries found", async (t) => {
  stubFetch(t, (url) => (url.searchParams.get("tickers") ? { Note: "limite por minuto" } : { feed: [article(6)] }));
  const items = await alphaVantageSource(base).poll();
  assert.equal(items.length, 1);
});
