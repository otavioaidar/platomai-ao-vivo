import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { XMLValidator } from "fast-xml-parser";
import { Store } from "../src/db.ts";
import { Hub, clientIp } from "../src/hub.ts";
import type { HubLimits } from "../src/hub.ts";
import { SECURITY_HEADERS, createServer, webUrl, xmlText } from "../src/server.ts";
import type { ServerDeps } from "../src/server.ts";
import { Agenda } from "../src/sources/ibge.ts";
import type { Headline } from "../src/types.ts";

const pub = fs.mkdtempSync(path.join(os.tmpdir(), "aovivo-pub-"));
fs.writeFileSync(path.join(pub, "index.html"), "<!doctype html><title>ok</title>");
const store = new Store(":memory:");
const hub = new Hub(60_000);
const deps: ServerDeps = {
  store,
  hub,
  agenda: new Agenda(),
  publicDir: pub,
  siteUrl: "https://aovivo.example",
  showReview: false,
  ai: { enabled: false, model: "nenhum" },
  statuses: () => [],
};
const server = createServer(deps);
let base = "";
let port = 0;

const headline = (id: string, status: Headline["status"] = "publicado"): Headline => ({
  id,
  publishedAt: new Date().toISOString(),
  sourcePublishedAt: new Date().toISOString(),
  detectedAt: new Date().toISOString(),
  sourceId: "bcb-notas",
  sourceName: "Banco Central (notas)",
  tag: "BCB",
  region: "BR",
  urgency: "alta",
  headline: `Manchete ${id} <b>`,
  explainer: null,
  topics: [],
  url: "https://www.bcb.gov.br/",
  method: "ia",
  status,
  backfill: false,
  latencyMs: 1200,
});

/** Starts an extra server on a free port; returns its base URL and a closer. */
async function extraServer(over: Partial<ServerDeps>) {
  const srv = createServer({ ...deps, ...over });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url, close: () => (srv.closeAllConnections(), srv.close()) };
}

/** Sends a raw request line that fetch would refuse or normalise, and returns the status line of the reply. */
function rawGet(target: string, method = "GET"): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let out = "";
    s.setTimeout(2000, () => s.destroy(new Error(`sem resposta para ${target}`)));
    s.on("data", (d) => (out += d));
    s.on("error", reject);
    s.on("close", () => resolve(out.split("\r\n")[0]));
  });
}

/** Opens a live stream and resolves once its headers arrive. */
async function openStream(url: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/stream`, { headers, signal: ctrl.signal });
  return { res, close: () => ctrl.abort() };
}

async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "condição não atingida a tempo");
}

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  hub.close();
  server.closeAllConnections();
  server.close();
});

test("lists published headlines only", async () => {
  store.save(headline("a"));
  store.save(headline("b", "revisar"));
  const res = await fetch(`${base}/api/headlines`);
  const body = (await res.json()) as { items: Headline[] };
  assert.deepEqual(body.items.map((h) => h.id), ["a"]);
});

test("streams new headlines over SSE", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = res.body!.getReader();
  setTimeout(() => hub.send("headline", headline("c")), 50);
  let text = "";
  while (!text.includes("event: headline")) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /"id":"c"/);
  ctrl.abort();
  await waitFor(() => hub.size === 0);
});

test("serves an escaped RSS feed", async () => {
  const xml = await (await fetch(`${base}/rss.xml`)).text();
  assert.match(xml, /<title>BCB: Manchete a &lt;b&gt;<\/title>/);
  assert.match(xml, /https:\/\/aovivo\.example\/#a/);
  assert.match(xml, /<source url="https:\/\/www\.bcb\.gov\.br\/">Banco Central \(notas\)<\/source>/);
});

test("RSS stays valid XML with control characters and drops non-web source links", async () => {
  const bad = { ...headline("ctl"), headline: "Juros\u0001 sobem\u000b \uD800ok", explainer: "Fim\u001f.", url: "javascript:alert(1)" };
  store.save(bad);
  const xml = await (await fetch(`${base}/rss.xml`)).text();
  assert.doesNotMatch(xml, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  assert.doesNotMatch(xml, /javascript:/);
  assert.match(xml, /<title>BCB: Juros sobem ok<\/title>/);
  assert.equal(XMLValidator.validate(xml), true);
  // The item without a web link still has everything else, only <source> is left out.
  const item = xml.split("<item>").find((i) => i.includes("#ctl"))!;
  assert.doesNotMatch(item, /<source/);
});

test("xmlText and webUrl", () => {
  assert.equal(xmlText('a\u0000b & "c" <d> \u{1F4C8}'), "ab &amp; &quot;c&quot; &lt;d&gt; \u{1F4C8}");
  assert.equal(webUrl("https://www.federalreserve.gov/a b"), "https://www.federalreserve.gov/a%20b");
  assert.equal(webUrl("http://x.example/"), "http://x.example/");
  assert.equal(webUrl("javascript:alert(1)"), null);
  assert.equal(webUrl("data:text/html,oi"), null);
  assert.equal(webUrl("/relativo"), null);
});

test("serves the page and refuses paths outside public/", async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status, 403);
  assert.equal((await fetch(`${base}/nao-existe.js`)).status, 404);
});

test("malformed request targets get 400 and the server stays up", async () => {
  for (const target of ["/%E0%A4%A", "/%FF", "/%00", "/a%00.js", "//[", "http://[/"]) {
    assert.match(await rawGet(target), /^HTTP\/1\.1 400 /, target);
    assert.equal((await fetch(`${base}/healthz`)).status, 200, `servidor caiu depois de ${target}`);
  }
});

test("an unexpected error answers 500 instead of crashing", async () => {
  const srv = await extraServer({
    statuses: () => {
      throw new Error("falha simulada");
    },
  });
  try {
    const res = await fetch(`${srv.url}/api/status`);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(`${srv.url}/healthz`)).status, 200);
  } finally {
    srv.close();
  }
  const broken = { latest: () => { throw new Error("banco indisponível"); } } as unknown as Store;
  const srv2 = await extraServer({ store: broken });
  try {
    assert.equal((await fetch(`${srv2.url}/rss.xml`)).status, 500);
  } finally {
    srv2.close();
  }
});

test("refuses other methods with 405", async () => {
  const res = await fetch(`${base}/api/headlines`, { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("sends security headers on every response", async () => {
  const responses = await Promise.all(
    ["/", "/api/headlines", "/api/status", "/rss.xml", "/healthz", "/nao-existe.js", "/%FF"].map((p) => fetch(`${base}${p}`)),
  );
  responses.push(await fetch(`${base}/api/stream`, { method: "HEAD" }));
  for (const res of responses) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, `${res.url} ${name}`);
  }
  const csp = SECURITY_HEADERS["content-security-policy"];
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
  assert.match(csp, /img-src 'self' data:/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(SECURITY_HEADERS["referrer-policy"], "strict-origin-when-cross-origin");
});

test("HEAD /api/stream answers at once and is not counted as a listener", async () => {
  const res = await fetch(`${base}/api/stream`, { method: "HEAD", signal: AbortSignal.timeout(2000) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.match(await rawGet("/api/stream", "HEAD"), /^HTTP\/1\.1 200 /);
  assert.equal(hub.size, 0);
});

test("caps live streams per IP and in total", async () => {
  const limited = new Hub(60_000, { maxClients: 3, maxPerIp: 2 } satisfies HubLimits);
  const srv = await extraServer({ hub: limited });
  const ip = (addr: string) => ({ "x-forwarded-for": `198.51.100.1, ${addr}` });
  try {
    const a1 = await openStream(srv.url, ip("203.0.113.7"));
    const a2 = await openStream(srv.url, ip("203.0.113.7"));
    assert.equal(a1.res.status, 200);
    assert.equal(a2.res.status, 200);
    const a3 = await openStream(srv.url, ip("203.0.113.7"));
    assert.equal(a3.res.status, 503);
    assert.equal(a3.res.headers.get("retry-after"), "30");
    assert.match(await a3.res.text(), /Tente de novo/);

    const b1 = await openStream(srv.url, ip("203.0.113.8"));
    assert.equal(b1.res.status, 200);
    assert.equal(limited.size, 3);
    const c1 = await openStream(srv.url, ip("203.0.113.9"));
    assert.equal(c1.res.status, 503, "limite global");

    // Closing a stream frees its slot for the same address.
    a1.close();
    await waitFor(() => limited.size === 2);
    const a4 = await openStream(srv.url, ip("203.0.113.7"));
    assert.equal(a4.res.status, 200);
    for (const s of [a2, b1, a4]) s.close();
    await waitFor(() => limited.size === 0);
  } finally {
    limited.close();
    srv.close();
  }
});

test("without a forwarded address only the global cap applies", async () => {
  const limited = new Hub(60_000, { maxClients: 3, maxPerIp: 1 });
  const srv = await extraServer({ hub: limited });
  try {
    const open = [await openStream(srv.url), await openStream(srv.url), await openStream(srv.url)];
    assert.deepEqual(open.map((s) => s.res.status), [200, 200, 200]);
    assert.equal((await openStream(srv.url)).res.status, 503);
    for (const s of open) s.close();
    await waitFor(() => limited.size === 0);
  } finally {
    limited.close();
    srv.close();
  }
});

test("clientIp trusts X-Forwarded-For only from a private peer", () => {
  const req = (remoteAddress: string, xff?: string) =>
    ({ socket: { remoteAddress }, headers: xff ? { "x-forwarded-for": xff } : {} }) as unknown as IncomingMessage;
  assert.equal(clientIp(req("8.8.8.8", "1.2.3.4")), "8.8.8.8");
  assert.equal(clientIp(req("2001:db8::1", "1.2.3.4")), "2001:db8:0:0::/64"); // IPv6 viewers are keyed by their /64
  assert.equal(clientIp(req("::ffff:172.17.0.1", "1.1.1.1, 203.0.113.9")), "203.0.113.9");
  assert.equal(clientIp(req("127.0.0.1", "203.0.113.5")), "203.0.113.5");
  assert.equal(clientIp(req("10.0.0.2")), null);
  assert.equal(clientIp(req("::1")), null);
});

test("drops a client that stops reading instead of buffering for it", async () => {
  const slow = new Hub(60_000);
  const srv = await extraServer({ hub: slow });
  const sock = net.connect(Number(new URL(srv.url).port), "127.0.0.1");
  try {
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("GET /api/stream HTTP/1.1\r\nHost: x\r\n\r\n");
    await waitFor(() => slow.size === 1);
    sock.pause(); // never reads again
    const big = { texto: "x".repeat(256 * 1024) };
    for (let i = 0; i < 200 && slow.size === 1; i++) {
      slow.send("headline", big);
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(slow.size, 0);
  } finally {
    sock.destroy();
    slow.close();
    srv.close();
  }
});

test("per-IP cap keys IPv6 viewers by their /64 and reads IPv4-mapped addresses as IPv4", async () => {
  const { ipKey } = await import("../src/hub.ts");
  assert.equal(ipKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("203.0.113.9"), "203.0.113.9");
});
