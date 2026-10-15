import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { createServer } from "../src/server.ts";
import { Agenda } from "../src/sources/ibge.ts";
import type { Headline } from "../src/types.ts";

const pub = fs.mkdtempSync(path.join(os.tmpdir(), "aovivo-pub-"));
fs.writeFileSync(path.join(pub, "index.html"), "<!doctype html><title>ok</title>");
const store = new Store(":memory:");
const hub = new Hub(60_000);
const server = createServer({
  store,
  hub,
  agenda: new Agenda(),
  publicDir: pub,
  siteUrl: "https://aovivo.example",
  showReview: false,
  ai: { enabled: false, model: "nenhum" },
  statuses: () => [],
});
let base = "";

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

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  hub.close();
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
});

test("serves an escaped RSS feed", async () => {
  const xml = await (await fetch(`${base}/rss.xml`)).text();
  assert.match(xml, /<title>BCB: Manchete a &lt;b&gt;<\/title>/);
  assert.match(xml, /https:\/\/aovivo\.example\/#a/);
});

test("serves the page and refuses paths outside public/", async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).status, 403);
  assert.equal((await fetch(`${base}/nao-existe.js`)).status, 404);
});
