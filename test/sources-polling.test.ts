import assert from "node:assert/strict";
import fs from "node:fs";
import { mock, test } from "node:test";
import { fetchConditional, pollEvery, userAgent } from "../src/net.ts";
import { COPOM_WINDOWS, feedEntries, feedSource, nextWindowStart, officialFeeds, parseFeed, windowInterval } from "../src/sources/feeds.ts";
import { Agenda, SIDRA_SPECS, ibgeReleases, nextMonth, releaseTime, sidraSource } from "../src/sources/ibge.ts";
import type { AgendaItem } from "../src/sources/ibge.ts";
import type { Source } from "../src/types.ts";

const fixture = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const S = 1000;

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Replaces global fetch for one test; returns the URLs it was called with. */
function stubFetch(t: { after: (fn: () => void) => void }, handler: Handler): string[] {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

function rss(pubDates: string[]): string {
  const items = pubDates.map((d, i) => `<item><title>Item ${i}</title><link>https://example.test/${i}</link><guid>g${i}</guid><pubDate>${d}</pubDate></item>`);
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><lastBuildDate>Wed, 14 Oct 2026 09:45:15 +0200</lastBuildDate>${items.join("")}</channel></rss>`;
}

// ---------------------------------------------------------------------------------------------
// Feed dates

test("a midnight placeholder less than a day old takes the detection time; real times are kept", () => {
  const now = new Date("2026-10-14T07:45:00Z");
  const [ecb, real, ownMidnight, dateOnly, tenOClock, old, tomorrow] = parseFeed(
    rss([
      "Wed, 14 Oct 2026 02:00:00 +0200", // ECB: 00:00 UTC written in its own offset (live feed, 14/10)
      "Tue, 13 Oct 2026 20:30:00 +0200",
      "Tue, 13 Oct 2026 00:00:00 -0300", // midnight as written, 28 h ago: keeps its own day
      "2026-10-14",
      "Wed, 14 Oct 2026 10:00:00 +0200", // "00:00" inside "10:00:00" is not midnight
      "Mon, 12 Oct 2026 02:00:00 +0200", // two days ago: really old, keep it
      "Thu, 15 Oct 2026 00:00:00 +0000", // tomorrow: a future date is kept
    ]),
    now,
  );
  assert.equal(ecb.publishedAt, now.toISOString());
  assert.equal(real.publishedAt, "2026-10-13T18:30:00.000Z");
  assert.equal(ownMidnight.publishedAt, "2026-10-13T03:00:00.000Z");
  assert.equal(dateOnly.publishedAt, now.toISOString());
  assert.equal(tenOClock.publishedAt, "2026-10-14T08:00:00.000Z");
  assert.equal(old.publishedAt, "2026-10-12T00:00:00.000Z");
  assert.equal(tomorrow.publishedAt, "2026-10-15T00:00:00.000Z");
});

test("a placeholder counts as new for 24 h, then keeps its own day so the pipeline treats it as history", () => {
  const stamp = "Tue, 13 Oct 2026 00:00:00 +0200"; // 12/10 22:00 UTC
  const within = parseFeed(rss([stamp]), new Date("2026-10-13T21:59:00Z"))[0];
  assert.equal(within.publishedAt, "2026-10-13T21:59:00.000Z");
  const after = parseFeed(rss([stamp]), new Date("2026-10-13T22:01:00Z"))[0];
  assert.equal(after.publishedAt, "2026-10-12T22:00:00.000Z");
});

test("BCB Atom dates with a real time are untouched", () => {
  const e = parseFeed(fixture("bcb-copom.xml"), new Date("2026-09-17T12:00:00Z"))[0];
  assert.equal(e.publishedAt, "2026-09-16T21:32:02.000Z");
});

// ---------------------------------------------------------------------------------------------
// Conditional GET and BCB feeds

test("a BCB feed that only rewrote its header and ETag counts as unchanged", async (t) => {
  const xml = fixture("bcb-copom.xml");
  const bodies = [
    xml,
    xml.replace("<updated>2026-10-15T14:50:05-03:00</updated>", "<updated>2026-10-15T14:50:11-03:00</updated>"),
    xml.replace("<entry>", "<entry><id>sitefeeds_99999</id><title>Novo</title><updated>2026-10-15T18:31:00-03:00</updated></entry><entry>"),
  ];
  let n = 0;
  const seenHeaders: Record<string, string>[] = [];
  stubFetch(t, (_url, init) => {
    seenHeaders.push(init.headers as Record<string, string>);
    return new Response(bodies[n], { headers: { etag: `"random-${n++}"` } });
  });
  const src = feedSource({ id: "bcb-test", name: "BCB", tag: "BCB", region: "BR", url: "https://bcb.test/a", lang: "pt", intervalMs: 1000 });
  assert.ok((await src.poll()).length > 0);
  assert.deepEqual(await src.poll(), [], "same entries: nothing to parse");
  const third = await src.poll();
  assert.equal(third[0].externalId, "sitefeeds_99999");
  assert.equal(seenHeaders[1]["if-none-match"], '"random-0"', "still asks with the last ETag (Fed and ECB honour it)");
  assert.match(seenHeaders[0]["user-agent"], /^PlatomAI-AoVivo/);
});

test("feedEntries drops only the feed header", () => {
  assert.equal(feedEntries("<feed><updated>x</updated><entry><id>1</id></entry></feed>"), "<entry><id>1</id></entry></feed>");
  assert.equal(feedEntries(rss(["Wed, 14 Oct 2026 10:00:00 +0200"])).startsWith("<item>"), true);
  assert.equal(feedEntries("<feed></feed>"), "<feed></feed>");
});

test("fetchConditional still returns the cached body on a 304", async (t) => {
  let n = 0;
  stubFetch(t, () => (n++ === 0 ? new Response("<rss>a</rss>", { headers: { etag: '"1"' } }) : new Response(null, { status: 304 })));
  assert.deepEqual(await fetchConditional("https://fed.test/feed"), { changed: true, body: "<rss>a</rss>" });
  assert.deepEqual(await fetchConditional("https://fed.test/feed"), { changed: false, body: "<rss>a</rss>" });
});

test("the User-Agent names the public site as a contact, but not localhost", () => {
  assert.equal(userAgent("http://localhost:8080"), "PlatomAI-AoVivo/0.1 (monitor de fontes oficiais)");
  assert.equal(userAgent("https://aovivo.example.com"), "PlatomAI-AoVivo/0.1 (monitor de fontes oficiais; +https://aovivo.example.com)");
});

// ---------------------------------------------------------------------------------------------
// Copom windows (Brasília time; 14/10/2026 is a Wednesday)

test("Copom statements poll every 3 s on Wednesday 18:00-19:30 in Brasília, every 5 min otherwise", () => {
  const w = COPOM_WINDOWS.comunicados;
  assert.equal(windowInterval(w, new Date("2026-10-14T20:59:59Z")), null); // 17:59:59 BRT
  assert.equal(windowInterval(w, new Date("2026-10-14T21:00:00Z")), 3 * S); // 18:00 BRT
  assert.equal(windowInterval(w, new Date("2026-10-14T22:29:59Z")), 3 * S); // 19:29:59 BRT
  assert.equal(windowInterval(w, new Date("2026-10-14T22:30:00Z")), null); // 19:30 BRT
  assert.equal(windowInterval(w, new Date("2026-10-15T21:00:00Z")), null); // Thursday
  assert.equal(nextWindowStart(w, new Date("2026-10-14T12:00:00Z")), Date.parse("2026-10-14T21:00:00Z"));
  assert.equal(nextWindowStart(w, new Date("2026-10-14T21:10:00Z")), Date.parse("2026-10-21T21:00:00Z"), "inside a window: the next one");
  // Late Tuesday night in Brasília is already Wednesday in UTC: the window is still Wednesday evening BRT.
  assert.equal(nextWindowStart(w, new Date("2026-10-14T02:30:00Z")), Date.parse("2026-10-14T21:00:00Z"));
});

test("Copom minutes poll every 5 s on Tuesday 07:55-08:30 in Brasília", () => {
  const w = COPOM_WINDOWS.atas;
  assert.equal(windowInterval(w, new Date("2026-10-13T10:55:00Z")), 5 * S); // Tue 07:55 BRT
  assert.equal(windowInterval(w, new Date("2026-10-13T11:30:00Z")), null); // 08:30 BRT
  assert.equal(nextWindowStart(w, new Date("2026-10-14T12:00:00Z")), Date.parse("2026-10-20T10:55:00Z"));
});

test("POLL_SCALE reaches every BCB cadence, hot windows included", () => {
  const byId = (scale: number) => new Map(officialFeeds(scale).map((s) => [s.id, s]));
  const wed = new Date("2026-10-14T21:30:00Z");
  const tue = new Date("2026-10-13T11:00:00Z");
  const one = byId(1);
  assert.equal(one.get("bcb-copom")!.intervalMs, 5 * 60 * S);
  assert.equal(one.get("bcb-atas")!.intervalMs, 10 * 60 * S);
  assert.equal(one.get("bcb-notas")!.intervalMs, 30 * S);
  assert.equal(one.get("bcb-copom")!.hotIntervalMs!(wed), 3 * S);
  assert.equal(one.get("bcb-atas")!.hotIntervalMs!(tue), 5 * S);
  assert.equal(one.get("bcb-notas")!.hotIntervalMs!(wed), null);
  assert.equal(one.get("ecb-press")!.nextHotAt!(wed), null);
  const four = byId(4);
  assert.equal(four.get("bcb-copom")!.intervalMs, 20 * 60 * S);
  assert.equal(four.get("bcb-copom")!.hotIntervalMs!(wed), 12 * S);
  assert.equal(four.get("bcb-atas")!.hotIntervalMs!(tue), 20 * S);
  assert.equal(four.get("bcb-copom")!.nextHotAt!(new Date("2026-10-14T12:00:00Z")), Date.parse("2026-10-14T21:00:00Z"));
  assert.equal(byId(0.1).get("bcb-copom")!.hotIntervalMs!(wed), 1 * S, "never below 1 s");
  assert.equal(pollEvery(2 * S, 0.25), 1 * S);
});

// ---------------------------------------------------------------------------------------------
// IBGE agenda

const IPCA = "Índice Nacional de Preços ao Consumidor Amplo";
const PNAD = "Pesquisa Nacional por Amostra de Domicílios Contínua Mensal";

function agendaWith(items: [string, string][], loaded = true): Agenda {
  const a = new Agenda();
  a.items = items
    .map(([when, product]): AgendaItem => ({ when, title: product, product, source: "IBGE", done: false }))
    .sort((x, y) => x.when.localeCompare(y.when));
  a.lastOkAt = loaded ? new Date().toISOString() : null;
  a.lastError = loaded ? null : "agenda indisponível"; // a finished, failed refresh: polls do not wait for it
  return a;
}

const isIpca = SIDRA_SPECS.find((s) => s.id === "ipca")!.calendarTitle;

test("agenda gives the start of the next hot window, 90 s before the release", () => {
  const a = agendaWith([["2026-11-10T12:00:00.000Z", IPCA], ["2026-10-30T12:00:00.000Z", PNAD]]);
  const now = new Date("2026-10-15T18:00:00Z");
  assert.equal(a.nextHotAt(isIpca, now), Date.parse("2026-11-10T11:58:30Z"));
  assert.equal(a.nextHotAt(() => true, now), Date.parse("2026-10-30T11:58:30Z"));
  assert.equal(a.nextHotAt(isIpca, new Date("2026-11-10T11:59:00Z")), null, "inside the last window");
});

test("SIDRA and IBGE releases sources wake up for the next hot window", () => {
  const a = agendaWith([["2026-11-10T12:00:00.000Z", IPCA], ["2026-10-30T12:00:00.000Z", PNAD]]);
  const now = new Date("2026-10-15T18:00:00Z");
  const ipca = sidraSource(SIDRA_SPECS.find((s) => s.id === "ipca")!, a, 1);
  const pnad = sidraSource(SIDRA_SPECS.find((s) => s.id === "desemprego")!, a, 1);
  assert.equal(ipca.nextHotAt!(now), Date.parse("2026-11-10T11:58:30Z"));
  assert.equal(pnad.nextHotAt!(now), Date.parse("2026-10-30T11:58:30Z"));
  assert.equal(ibgeReleases(a, 1).nextHotAt!(now), Date.parse("2026-10-30T11:58:30Z"));
});

test("hot cadences of IBGE sources follow POLL_SCALE", () => {
  const a = agendaWith([["2026-11-10T12:00:00.000Z", IPCA]]);
  const inWindow = new Date("2026-11-10T12:00:30Z");
  const spec = SIDRA_SPECS.find((s) => s.id === "ipca")!;
  assert.equal(sidraSource(spec, a, 1).hotIntervalMs!(inWindow), 2 * S);
  assert.equal(sidraSource(spec, a, 4).hotIntervalMs!(inWindow), 8 * S);
  assert.equal(sidraSource(spec, a, 4).intervalMs, 8 * 60 * S);
  assert.equal(ibgeReleases(a, 1).hotIntervalMs!(inWindow), 3 * S);
  assert.equal(ibgeReleases(a, 10).hotIntervalMs!(inWindow), 30 * S);
  assert.equal(ibgeReleases(a, 10).hotIntervalMs!(new Date("2026-11-10T13:00:00Z")), null);
});

test("agenda refresh gives up after 5 s by default", async (t) => {
  const timeouts: number[] = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    timeouts.push(ms);
    return real.call(AbortSignal, ms);
  };
  t.after(() => {
    AbortSignal.timeout = real;
  });
  stubFetch(t, (_url, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
  const a = new Agenda();
  await a.refresh(new Date(), 30);
  assert.equal(a.lastOkAt, null);
  assert.match(a.lastError ?? "", /abort|timeout/i);
  void a.refresh().catch(() => {});
  assert.deepEqual(timeouts, [30, 5_000]);
});

// ---------------------------------------------------------------------------------------------
// SIDRA release time and stale releases

test("a SIDRA release takes its time from the agenda, and is stale when the agenda has no recent one", () => {
  const now = new Date("2026-10-15T18:15:09Z");
  // Server was down on IPCA day (09/10); the agenda only knows releases from the last 24 h.
  assert.deepEqual(releaseTime(agendaWith([["2026-10-09T12:00:00.000Z", IPCA]]), isIpca, now), {
    publishedAt: "2026-10-09T12:00:00.000Z",
    stale: true,
  });
  assert.deepEqual(releaseTime(agendaWith([["2026-10-15T12:00:00.000Z", PNAD]]), isIpca, now), { publishedAt: now.toISOString(), stale: true });
  // Found 2 min after a release at 09:00 BRT: news, timed at the release.
  const fresh = agendaWith([["2026-10-15T18:13:00.000Z", IPCA]]);
  assert.deepEqual(releaseTime(fresh, isIpca, now), { publishedAt: "2026-10-15T18:13:00.000Z", stale: false });
  // The table updated a few seconds before the scheduled time.
  const early = agendaWith([["2026-10-15T18:15:30.000Z", IPCA]]);
  assert.deepEqual(releaseTime(early, isIpca, now), { publishedAt: now.toISOString(), stale: false });
  // The agenda never loaded: nothing better than the poll time.
  assert.deepEqual(releaseTime(agendaWith([], false), isIpca, now), { publishedAt: now.toISOString(), stale: false });
});

/** SIDRA IPCA rows with only the periods up to `last`. */
function ipcaRows(last: string) {
  const rows = JSON.parse(fixture("sidra-ipca.json"));
  return [rows[0], ...rows.slice(1).filter((r: Record<string, string>) => r.D3C <= last)];
}

test("sidraSource marks a release found after an outage as stale", async (t) => {
  stubFetch(t, () => json(ipcaRows("202609")));
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * S).toISOString();
  const spec = SIDRA_SPECS.find((s) => s.id === "ipca")!;
  const [old] = await sidraSource(spec, agendaWith([[twoDaysAgo, IPCA]]), 1).poll();
  assert.equal(old.stale, true);
  assert.equal(old.publishedAt, twoDaysAgo);
  const justNow = new Date(Date.now() - 60 * S).toISOString();
  const [fresh] = await sidraSource(spec, agendaWith([[justNow, IPCA]]), 1).poll();
  assert.equal(fresh.stale, undefined);
  assert.equal(fresh.publishedAt, justNow);
});

// ---------------------------------------------------------------------------------------------
// SIDRA hot window and Focus cache (clock mocked; fetch stubbed)

function sidraAndFocus(t: { after: (fn: () => void) => void }, focus: () => Response | Promise<Response>) {
  let last = "202608";
  const calls = stubFetch(t, (url) => (url.includes("olinda.bcb.gov.br") ? focus() : json(ipcaRows(last))));
  return { calls, publish: (p: string) => (last = p), focusCalls: () => calls.filter((u) => u.includes("olinda")) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("IPCA: the Focus median is fetched ahead on release day and the squawk does not wait for it", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T10:00:00Z") }); // 07:00 BRT, IPCA at 09:00
  t.after(() => mock.timers.reset());
  const net = sidraAndFocus(t, () => json({ value: [{ Mediana: 0.6 }] }));
  const agenda = agendaWith([["2026-10-09T12:00:00.000Z", IPCA]]);
  const src: Source = sidraSource(SIDRA_SPECS.find((s) => s.id === "ipca")!, agenda, 1);

  await src.poll(); // still August: fetch the median for September in the background
  await flush();
  assert.equal(net.focusCalls().length, 1);
  assert.match(decodeURIComponent(net.focusCalls()[0]), /DataReferencia eq '09\/2026'/);
  await src.poll();
  await flush();
  assert.equal(net.focusCalls().length, 1, "cached: no new request within the hour");

  mock.timers.setTime(Date.parse("2026-10-09T12:00:02Z"));
  net.publish("202609");
  const [item] = await src.poll();
  const enriched = await src.enrich!(item);
  assert.equal(enriched.data!.consensus, 0.6);
  await src.enrich!(item); // a retry reads the cache too
  assert.equal(net.focusCalls().length, 1, "no Olinda request on the critical path");
  assert.equal(item.publishedAt, "2026-10-09T12:00:00.000Z");
});

test("IPCA: on a cache miss the squawk waits at most 1.5 s for Focus", async (t) => {
  // Olinda hangs until the request is aborted.
  stubFetch(t, (url, init) =>
    url.includes("olinda")
      ? new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
      : json(ipcaRows("202609")),
  );
  const src = sidraSource(SIDRA_SPECS.find((s) => s.id === "ipca")!, agendaWith([], false), 1);
  const [item] = await src.poll();
  const t0 = performance.now();
  const enriched = await src.enrich!(item);
  const ms = performance.now() - t0;
  assert.equal(enriched.data!.consensus, null);
  assert.ok(ms >= 1_400 && ms < 3_000, `waited ${Math.round(ms)} ms`);
});

test("SIDRA drops back to the normal cadence once the new number is out", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T11:59:00Z") });
  t.after(() => mock.timers.reset());
  const net = sidraAndFocus(t, () => json({ value: [{ Mediana: 0.6 }] }));
  const agenda = agendaWith([["2026-10-09T12:00:00.000Z", IPCA]]);
  const src = sidraSource(SIDRA_SPECS.find((s) => s.id === "ipca")!, agenda, 1);
  await src.poll();
  assert.equal(src.hotIntervalMs!(new Date()), 2 * S, "waiting for the release");
  mock.timers.setTime(Date.parse("2026-10-09T12:00:01Z"));
  await src.poll();
  assert.equal(src.hotIntervalMs!(new Date()), 2 * S, "not out yet");
  mock.timers.setTime(Date.parse("2026-10-09T12:00:03Z"));
  net.publish("202609");
  await src.poll();
  assert.equal(src.hotIntervalMs!(new Date()), null, "September is out");
  await flush();
});

test("nextMonth rolls over the year", () => {
  assert.equal(nextMonth("202609"), "202610");
  assert.equal(nextMonth("202612"), "202701");
});

test("an unchanged feed is handed over again every 5 minutes, so a failed record is not lost", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-15T15:00:00Z") });
  stubFetch(t, () => new Response(fixture("bcb-copom.xml")));
  const src = feedSource({ id: "bcb-resend", name: "BCB", tag: "BCB", region: "BR", url: "https://bcb.test/resend", lang: "pt", intervalMs: 1000 });
  const first = await src.poll();
  assert.ok(first.length > 0);
  assert.deepEqual(await src.poll(), []);
  t.mock.timers.tick(5 * 60 * S + 1);
  assert.equal((await src.poll()).length, first.length);
  assert.deepEqual(await src.poll(), []);
});

test("SIDRA: a period change this process watched is news even if the agenda does not list it", async (t) => {
  let last = "202608";
  stubFetch(t, () => json(ipcaRows(last)));
  const spec = SIDRA_SPECS.find((s) => s.id === "ipca")!;
  const src = sidraSource(spec, agendaWith([]), 1); // agenda loaded, but no IPCA release in it
  const [before] = await src.poll();
  assert.equal(before.stale, true, "first poll after a start: no watched change, no agenda entry");
  last = "202609";
  const t0 = Date.now();
  const [after] = await src.poll();
  assert.equal(after.externalId, "ipca:202609");
  assert.equal(after.stale, undefined);
  assert.ok(Date.parse(after.publishedAt) >= t0 - 1000);
});

test("SIDRA: without an agenda, the first poll after a start is history", async (t) => {
  stubFetch(t, () => json(ipcaRows("202609")));
  const spec = SIDRA_SPECS.find((s) => s.id === "ipca")!;
  const [first] = await sidraSource(spec, agendaWith([], false), 1).poll();
  assert.equal(first.stale, true);
});

test("SIDRA: a watched period change stays news on later polls (e.g. after a failed record)", async (t) => {
  let last = "202608";
  stubFetch(t, () => json(ipcaRows(last)));
  const spec = SIDRA_SPECS.find((s) => s.id === "ipca")!;
  const src = sidraSource(spec, agendaWith([], false), 1); // calendar down
  await src.poll();
  last = "202609";
  const [first] = await src.poll();
  const [again] = await src.poll();
  assert.equal(first.stale, undefined);
  assert.equal(again.stale, undefined);
  assert.equal(again.publishedAt, first.publishedAt);
});

test("agenda: the first SIDRA poll waits for the calendar's first answer", async () => {
  const a = new Agenda();
  let done = false;
  const wait = a.whenAttempted(5_000).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false);
  // refresh() wakes the waiters in its finally block, here after a failed request.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("erro", { status: 500 })) as typeof fetch;
  try {
    await a.refresh();
  } finally {
    globalThis.fetch = real;
  }
  await wait;
  assert.equal(done, true);
  assert.equal(a.attempted(), true);
});
