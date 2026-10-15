import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { errorText } from "../src/log.ts";
import { Pipeline, keepRefreshed, nextDelayMs, releaseText, retryDelayMs } from "../src/pipeline.ts";
import type { Publisher } from "../src/publishers/index.ts";
import type { WriteContext, Writer } from "../src/writer/ai.ts";
import type { Draft, Headline, IndicatorRelease, RawItem, Source } from "../src/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

function item(id: string, title: string, minutesAgo = 0, body = title): RawItem {
  return {
    sourceId: "fake",
    externalId: id,
    url: `https://example.gov/${id}`,
    title,
    body,
    publishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    lang: "pt",
  };
}

function fakeSource(batches: RawItem[][]): Source {
  let i = 0;
  return { id: "fake", name: "Fonte de teste", tag: "BCB", region: "BR", intervalMs: 1000, poll: async () => batches[Math.min(i++, batches.length - 1)] };
}

class FakeWriter implements Writer {
  readonly enabled = true;
  readonly model = "fake";
  calls = 0;
  /** How many of the next calls throw. */
  failures = 0;
  refuse = false;
  /** When set, write() waits for it (to simulate a slow AI call). */
  gate: Promise<void> | null = null;
  recent: Headline[][] = [];
  explanation: string | null = null;
  draft: (i: RawItem) => Draft = (i) => ({ publish: true, urgency: "urgente", headline: i.title, explainer: null, topics: ["juros"], reason: "", method: "ia" });
  async write(i: RawItem, ctx: WriteContext): Promise<Draft | null> {
    this.calls++;
    this.recent.push(ctx.recent);
    if (this.gate) await this.gate;
    if (this.failures > 0) {
      this.failures--;
      throw new Error("API fora do ar");
    }
    return this.refuse ? null : this.draft(i);
  }
  async explain(): Promise<string | null> {
    return this.explanation;
  }
}

class FakePublisher implements Publisher {
  readonly name = "fake";
  readonly live = true;
  sent: Headline[] = [];
  async publish(h: Headline) {
    this.sent.push(h);
  }
}

interface SetupOptions {
  store?: Store;
  backfillPerSource?: number;
  writer?: FakeWriter;
}

function setup(batches: RawItem[][], opts: SetupOptions = {}) {
  const store = opts.store ?? new Store(":memory:");
  const hub = new Hub(60_000);
  const writer = opts.writer ?? new FakeWriter();
  const pub = new FakePublisher();
  const events: string[] = [];
  const send = hub.send.bind(hub);
  hub.send = (event, data) => {
    events.push(event);
    send(event, data);
  };
  const clock = { t: Date.now() };
  const p = new Pipeline({
    store,
    writer,
    hub,
    publishers: [pub],
    minUrgency: "alta",
    backfillPerSource: opts.backfillPerSource ?? 2,
    showReview: false,
    aiConcurrency: 2,
    now: () => clock.t,
  });
  return { store, hub, writer, pub, events, p, clock, src: fakeSource(batches) };
}

function tmpDb(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aovivo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "test.db");
}

test("first run shows only the latest items as history and posts nothing to social networks", async () => {
  const { p, src, store, pub, writer, hub } = setup([[item("1", "Um", 30), item("2", "Dois", 20), item("3", "Três", 10)]]);
  const out = await p.runOnce(src);
  assert.deepEqual(out.map((h) => h.headline), ["Dois", "Três"]);
  assert.ok(out.every((h) => h.backfill));
  assert.equal(writer.calls, 2);
  assert.equal(pub.sent.length, 0);
  assert.equal(store.latest(10).length, 2);
  hub.close();
});

test("BACKFILL_PER_SOURCE=0 writes no history on the first run, and later items still go out", async () => {
  const first = [item("1", "Um", 30), item("2", "Dois", 20)];
  const { p, src, store, writer, pub, hub } = setup([first, [...first, item("3", "Copom decide", 0)]], { backfillPerSource: 0 });
  assert.deepEqual(await p.runOnce(src), []);
  assert.equal(writer.calls, 0);
  assert.equal(store.pendingCount(), 0);
  const out = await p.runOnce(src);
  assert.deepEqual(out.map((h) => h.headline), ["Copom decide"]);
  assert.equal(pub.sent.length, 1);
  hub.close();
});

test("new items after the first run are published, sent to social networks and never repeated", async () => {
  const first = [item("1", "Um", 30)];
  const second = [item("1", "Um", 30), item("2", "Copom reduz Selic para 13,75%", 0)];
  const { p, src, pub, writer, events, hub } = setup([first, second, second]);
  await p.runOnce(src);
  const out = await p.runOnce(src);
  assert.equal(out.length, 1);
  assert.equal(out[0].backfill, false);
  assert.equal(pub.sent.length, 1);
  assert.ok(events.includes("headline"));
  await p.runOnce(src);
  assert.equal(writer.calls, 2, "an item already seen is not written again");
  hub.close();
});

test("an item the source flags as stale is history only: source time, no social post", async () => {
  const old = { ...item("7", "Nota de ontem", 120), stale: true };
  const { p, src, pub, hub } = setup([[item("0", "Antigo", 60)], [item("0", "Antigo", 60), old]]);
  await p.runOnce(src);
  const [h] = await p.runOnce(src);
  assert.equal(h.backfill, true);
  assert.equal(h.status, "publicado");
  assert.equal(h.publishedAt, old.publishedAt);
  assert.equal(pub.sent.length, 0);
  hub.close();
});

test("a headline with a number not found in the source goes to review and is not posted", async () => {
  const { p, src, pub, writer, store, hub } = setup([[item("0", "Antigo", 60)], [item("0", "Antigo", 60), item("9", "Copom decide", 0, "Copom reduz a Selic para 13,75% a.a.")]]);
  await p.runOnce(src);
  writer.draft = () => ({ publish: true, urgency: "urgente", headline: "Copom reduz Selic para 13,50%", explainer: null, topics: [], reason: "", method: "ia" });
  const [h] = await p.runOnce(src);
  assert.equal(h.status, "revisar");
  assert.match(h.reviewReason ?? "", /13,50/);
  assert.equal(pub.sent.length, 0);
  assert.equal(store.latest(10).length, 1, "only the backfilled item is public");
  hub.close();
});

test("an English source is checked with English number reading", async () => {
  const fed = { ...item("f1", "Fed decision", 0, "The Committee decided to lower the target range to 3-3/4 to 4 percent."), lang: "en" as const };
  const { p, src, writer, hub } = setup([[item("0", "Antigo", 60)], [item("0", "Antigo", 60), fed]]);
  await p.runOnce(src);
  writer.draft = () => ({ publish: true, urgency: "urgente", headline: "Fed reduz juros para a faixa de 3,75% a 4,00%", explainer: null, topics: [], reason: "", method: "ia" });
  const [h] = await p.runOnce(src);
  assert.equal(h.status, "publicado");
  hub.close();
});

test("items the writer rejects are not published", async () => {
  const { p, src, store, writer, hub } = setup([[item("1", "Evento institucional", 5)]]);
  writer.draft = () => ({ publish: false, urgency: "normal", headline: "", explainer: null, topics: [], reason: "sem relevância", method: "ia" });
  assert.deepEqual(await p.runOnce(src), []);
  assert.equal(store.latest(10).length, 0);
  assert.equal(store.pendingCount(), 0, "a rejection is a final answer");
  hub.close();
});

test("an AI refusal is kept for review with the source title instead of being dropped", async () => {
  const { p, src, store, writer, pub, events, hub } = setup([[item("0", "Antigo", 60)], [item("0", "Antigo", 60), item("4", "Discurso do presidente do BC", 0)]]);
  await p.runOnce(src);
  writer.refuse = true;
  const [h] = await p.runOnce(src);
  assert.equal(h.status, "revisar");
  assert.equal(h.headline, "Discurso do presidente do BC");
  assert.equal(h.reviewReason, "IA recusou o item");
  assert.equal(store.get(h.id)?.status, "revisar");
  assert.equal(store.latest(10).length, 1, "not public");
  assert.equal(pub.sent.length, 0);
  assert.equal(events.filter((e) => e === "headline").length, 1, "only the backfilled item reached the site");
  assert.equal(store.pendingCount(), 0, "not retried");
  hub.close();
});

test("a failed write is retried with backoff and keeps its first detection time", async () => {
  const batch = [item("0", "Antigo", 60)];
  const next = [...batch, item("5", "Nota nova", 0)];
  const { p, src, writer, store, clock, hub } = setup([batch, next]);
  await p.runOnce(src);
  const detectedAt = clock.t;
  writer.failures = 2;
  assert.deepEqual(await p.runOnce(src), []);
  assert.equal(writer.calls, 2);
  clock.t += 10_000;
  assert.deepEqual(await p.runOnce(src), [], "not before 15 s");
  assert.equal(writer.calls, 2);
  clock.t += 5_000;
  assert.deepEqual(await p.runOnce(src), [], "second failure");
  clock.t += 20_000;
  assert.deepEqual(await p.runOnce(src), [], "not before another 30 s");
  clock.t += 10_000;
  const out = await p.runOnce(src);
  assert.deepEqual(out.map((h) => h.headline), ["Nota nova"]);
  assert.equal(out[0].detectedAt, new Date(detectedAt).toISOString());
  assert.equal(out[0].latencyMs, 45_000);
  assert.equal(writer.calls, 4);
  assert.equal(store.latest(10).length, 2);
  assert.equal(store.pendingCount(), 0);
  hub.close();
});

test("retry delays double from 15 s up to 30 min", () => {
  assert.deepEqual([1, 2, 3, 4].map(retryDelayMs), [15_000, 30_000, 60_000, 120_000]);
  assert.equal(retryDelayMs(30), 30 * MIN);
});

test("an item that keeps failing for 6 h is saved for review with its title instead of being dropped", async () => {
  const batch = [item("0", "Antigo", 60)];
  const { p, src, writer, store, pub, clock, hub } = setup([batch, [...batch, item("6", "Comunicado do Copom", 0)]]);
  await p.runOnce(src);
  writer.failures = 1000;
  await p.runOnce(src);
  let review: Headline[] = [];
  for (let i = 0; i < 100 && !review.length; i++) {
    clock.t += 30 * MIN;
    review = await p.runOnce(src);
  }
  assert.equal(review.length, 1);
  assert.equal(review[0].status, "revisar");
  assert.equal(review[0].headline, "Comunicado do Copom");
  assert.match(review[0].reviewReason ?? "", /falha ao escrever após \d+ tentativas: API fora do ar/);
  assert.ok(writer.calls > 10, "retried many times over hours");
  assert.ok(writer.calls < 30, "bounded by the backoff");
  assert.equal(store.pendingCount(), 0);
  assert.equal(pub.sent.length, 0);
  hub.close();
});

test("an item queued before a restart is written by the next process on the same database", async (t) => {
  const file = tmpDb(t);
  const batch = [item("0", "Antigo", 60)];
  const next = [...batch, item("8", "Copom mantém Selic", 0)];
  const a = setup([batch, next], { store: new Store(file) });
  await a.p.runOnce(a.src);
  a.writer.failures = 1;
  await a.p.runOnce(a.src);
  a.store.close();
  a.hub.close();

  const b = setup([next], { store: new Store(file) });
  b.clock.t = a.clock.t + 15_000;
  const out = await b.p.runOnce(b.src);
  assert.deepEqual(out.map((h) => h.headline), ["Copom mantém Selic"]);
  assert.equal(out[0].latencyMs, 15_000, "latency counts from the first detection");
  b.store.close();
  b.hub.close();
});

test("a process killed in the middle of a write leaves the item queued for the next one", async (t) => {
  const file = tmpDb(t);
  const batch = [item("0", "Antigo", 60)];
  const next = [...batch, item("9", "Fed corta juros", 0)];
  const a = setup([batch, next], { store: new Store(file) });
  await a.p.runOnce(a.src);
  a.writer.gate = new Promise(() => {}); // the AI call never returns
  void a.p.runOnce(a.src);
  await sleep(10);
  a.p.stop();
  assert.equal(await a.p.drain(50), false, "drain gives up after its timeout");
  a.store.close();
  a.hub.close();

  const b = setup([next], { store: new Store(file) });
  const out = await b.p.runOnce(b.src);
  assert.deepEqual(out.map((h) => h.headline), ["Fed corta juros"]);
  b.store.close();
  b.hub.close();
});

test("drain waits for a write in flight before shutdown", async () => {
  const batch = [item("0", "Antigo", 60)];
  const { p, src, writer, store, hub } = setup([batch, [...batch, item("2", "Nota nova", 0)]]);
  await p.runOnce(src);
  let release = () => {};
  writer.gate = new Promise<void>((r) => (release = r));
  void p.runOnce(src);
  await sleep(10);
  p.stop();
  setTimeout(release, 30);
  assert.equal(await p.drain(2000), true);
  assert.equal(store.latest(10).length, 2);
  assert.equal(store.pendingCount(), 0);
  hub.close();
});

test("a network failure shows its cause in the source status", async () => {
  const { p, hub } = setup([]);
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND www.bcb.gov.br"), { code: "ENOTFOUND" });
  const src: Source = { ...fakeSource([]), poll: async () => Promise.reject(new TypeError("fetch failed", { cause })) };
  assert.deepEqual(await p.runOnce(src), []);
  assert.equal(p.statuses()[0].lastError, "fetch failed (causa: getaddrinfo ENOTFOUND www.bcb.gov.br)");
  hub.close();
});

test("the polling loop survives a database error instead of crashing the process", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const { p, store, hub } = setup([]);
  let polls = 0;
  const src: Source = { ...fakeSource([]), intervalMs: 5, poll: async () => [item(`n${++polls}`, `Nota ${polls}`, 0)] };
  const admit = store.admit.bind(store);
  let locked = true;
  store.admit = (...args) => {
    if (locked) {
      locked = false;
      throw new Error("database is locked");
    }
    admit(...args);
  };
  p.start([src]);
  for (let i = 0; i < 200 && polls < 4; i++) await sleep(5);
  p.stop();
  assert.equal(await p.drain(1000), true);
  assert.ok(polls >= 4, "the loop kept polling after the database error");
  assert.ok(store.latest(10).length >= 1, "later items were written");
  hub.close();
});

test("the writer's recent headlines leave out unpublished ones and other tags", () => {
  const store = new Store(":memory:");
  const base = { sourcePublishedAt: "", detectedAt: "", sourceId: "s", sourceName: "S", region: "BR" as const, urgency: "alta" as const, explainer: null, topics: [], url: "", method: "ia" as const, backfill: false, latencyMs: 0 };
  const at = (min: number) => new Date(Date.UTC(2026, 9, 15, 12, min)).toISOString();
  store.save({ ...base, id: "fed-ok", publishedAt: at(1), tag: "FED", headline: "Fed mantém juros", status: "publicado" });
  store.save({ ...base, id: "fed-rev", publishedAt: at(2), tag: "FED", headline: "Fed corta juros", status: "revisar" });
  for (let i = 0; i < 205; i++) store.save({ ...base, id: `bcb-${i}`, publishedAt: at(3 + (i % 50)), tag: "BCB", headline: `BCB ${i}`, status: "publicado" });
  assert.deepEqual(store.recentByTag("FED", at(0)).map((h) => h.id), ["fed-ok"]);
  assert.equal(store.recentByTag("BCB", at(0), 15).length, 15);
  store.close();
});

test("the writer is not told about a headline that is waiting for review", async () => {
  const batch = [item("0", "Antigo", 60)];
  const { p, src, writer, hub } = setup([batch, [...batch, item("1", "Fed decide", 0, "Fed")], [...batch, item("1", "Fed decide", 0, "Fed"), item("2", "Projeções do Fed", 0)]]);
  await p.runOnce(src);
  writer.draft = (i) => ({ publish: true, urgency: "urgente", headline: i.externalId === "1" ? "Fed corta juros em 0,50 p.p." : i.title, explainer: null, topics: [], reason: "", method: "ia" });
  const [rev] = await p.runOnce(src);
  assert.equal(rev.status, "revisar");
  await p.runOnce(src);
  assert.deepEqual(writer.recent.at(-1)?.map((h) => h.headline), ["Antigo"], "the review headline is not in the context");
  hub.close();
});

test("the next poll is moved up so it lands when the hot window opens", () => {
  const now = new Date("2026-10-10T11:58:29Z");
  const release = Date.parse("2026-10-10T12:00:00Z");
  const sidra: Source = {
    id: "sidra-ipca", name: "IPCA", tag: "IBGE", region: "BR", intervalMs: 120_000,
    hotIntervalMs: (d) => (d.getTime() >= release - 90_000 ? 2_000 : null),
    nextHotAt: (d) => (d.getTime() < release - 90_000 ? release - 90_000 : null),
    poll: async () => [],
  };
  assert.equal(nextDelayMs(sidra, now, 1), 1_000, "sleeps only until 11:58:30, not 132 s");
  assert.equal(nextDelayMs(sidra, new Date(release), 0.5), 2_000, "inside the window: hot cadence");
  const plain: Source = { ...sidra, hotIntervalMs: undefined, nextHotAt: () => now.getTime() - 1 };
  assert.equal(nextDelayMs(plain, now, 0.5), 120_000, "a window start in the past is ignored");
  assert.equal(nextDelayMs({ ...plain, nextHotAt: undefined }, now, 0), 108_000);
});

test("a template explainer is checked against the release written in Portuguese", async () => {
  const ipca: IndicatorRelease = {
    indicator: "ipca", label: "IPCA", period: "202609", periodLabel: "setembro 2026", previousPeriodLabel: "agosto 2026",
    values: { mes: 0.44, "12m": 5.17 }, previous: { mes: -0.11 }, consensus: 0.4,
  };
  const text = releaseText("IPCA de setembro sobe 0,44%", ipca);
  assert.match(text, /0,44/);
  assert.match(text, /5,17/);
  assert.match(text, /0,4\b/);
  assert.doesNotMatch(text, /0\.44/);

  for (const [explanation, kept] of [["A alta de 0,44% ficou acima dos 0,4% esperados.", true], ["A inflação acumulada chegou a 6,10%.", false]] as const) {
    const release = { ...item("i1", "IPCA setembro", 0), data: ipca };
    const { p, src, writer, store, hub } = setup([[item("0", "Antigo", 60)], [item("0", "Antigo", 60), release]]);
    await p.runOnce(src);
    writer.explanation = explanation;
    const [h] = await p.runOnce(src);
    assert.equal(h.method, "template");
    await p.drain(1000);
    assert.equal(store.get(h.id)?.explainer ?? null, kept ? explanation : null);
    hub.close();
  }
});

test("a background refresh retries quickly until its first success, then slows down", async () => {
  let calls = 0;
  const results = [false, false, true, true];
  const stop = keepRefreshed(async () => results[calls++] ?? true, 10_000, 5);
  for (let i = 0; i < 100 && calls < 3; i++) await sleep(5);
  await sleep(30);
  stop();
  assert.equal(calls, 3, "two quick retries, then the slow cadence");
});

test("a background refresh that throws counts as a failure and is retried", async () => {
  let calls = 0;
  const stop = keepRefreshed(async () => {
    calls++;
    throw new Error("IBGE fora do ar");
  }, 10_000, 5);
  for (let i = 0; i < 100 && calls < 3; i++) await sleep(5);
  stop();
  assert.ok(calls >= 3);
});

test("error text includes the cause chain and never a Telegram token", () => {
  const tls = Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" });
  assert.equal(errorText(new TypeError("fetch failed", { cause: tls })), "fetch failed (causa: UNABLE_TO_GET_ISSUER_CERT_LOCALLY unable to get local issuer certificate)");
  const refused = Object.assign(new AggregateError([new Error("connect ECONNREFUSED 1.2.3.4:443")], ""), { code: "ECONNREFUSED" });
  assert.equal(errorText(new TypeError("fetch failed", { cause: refused })), "fetch failed (causa: connect ECONNREFUSED 1.2.3.4:443)");
  const deep = new Error("a", { cause: new Error("b", { cause: new Error("c", { cause: new Error("d", { cause: new Error("e") }) }) }) });
  assert.equal(errorText(deep), "a (causa: b; causa: c; causa: d)");
  assert.equal(errorText(new Error("POST https://api.telegram.org/bot123456:AA-bb_cc/sendMessage 400")), "POST https://api.telegram.org/bot***/sendMessage 400");
  assert.equal(errorText("texto"), "texto");
});
