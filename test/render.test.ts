import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { feedHtml } from "../src/render.ts";
import { createServer } from "../src/server.ts";
import { Agenda } from "../src/sources/ibge.ts";
import type { DecifraText, Headline } from "../src/types.ts";

const NOW = new Date("2026-11-06T13:30:00Z"); // 10:30 in Brasília

const base: Headline = {
  id: "x", publishedAt: "2026-11-06T13:10:45Z", sourcePublishedAt: "", detectedAt: "", sourceId: "imprensa-moneytimes",
  sourceName: "Money Times", tag: "IMPRENSA", region: "BR", urgency: "normal", headline: "Governo prorroga imposto de 12% sobre exportação de petróleo",
  explainer: null, topics: [], url: "https://www.moneytimes.com.br/governo-prorroga-imposto/", method: "titulo", status: "publicado", backfill: false, latencyMs: 0,
};

const TEXT: DecifraText = {
  title: "Copom mantém 13,75% e põe expectativas no centro do risco", subtitle: "Para quem toma crédito, o juro segue alto.",
  date: "4 de novembro de 2026", summary: "Segundo o BC, o Copom manteve a Selic em 13,75%.", analysis: ["Primeiro.", "A meta ficou mais longe."],
  impact: [{ label: "Juros", text: "menos espaço para cortes." }], keyMessage: "O dado a observar é o Focus.",
};

test("a press title is a plain link to the outlet's story, with the outlet's name beside it", () => {
  const html = feedHtml([base], NOW);
  assert.match(html, /<a class="t-head t-link" href="https:\/\/www\.moneytimes\.com\.br\/governo-prorroga-imposto\/" target="_blank" rel="noopener">Governo prorroga/);
  assert.ok(!/nofollow|noreferrer|sponsored|ugc/.test(html), "the link passes credit to the outlet and shows where the reader came from");
  assert.match(html, /<span class="t-credit">— Money Times<\/span>/);
  assert.match(html, /<span class="day-main">Hoje<\/span> <span class="day-sub">06\/11<\/span>/);
  assert.match(html, /<time class="t-time" datetime="2026-11-06T13:10:45.000Z">10:10:45<\/time>/);
});

test("an official headline keeps its own text and links to the document; the decifra replaces the explainer", () => {
  const official: Headline = { ...base, id: "c", method: "ia", sourceName: "Copom (comunicados)", tag: "COPOM", urgency: "urgente", headline: "Copom mantém Selic em 13,75%", url: "https://www.bcb.gov.br/x", explainer: "Juro alto encarece o crédito." };
  const plain = feedHtml([official], NOW);
  assert.match(plain, /<span class="t-head">Copom mantém Selic em 13,75%<\/span>/);
  assert.match(plain, /PlatomAI explica:<\/span> Juro alto encarece o crédito\./);
  assert.match(plain, /<span class="flag flag-urgente">URGENTE<\/span>/);

  const withDecifra = feedHtml([{ ...official, decifra: { ...TEXT, status: "publicado", createdAt: "", checks: ["nota interna"] } }], NOW);
  assert.ok(!withDecifra.includes("PlatomAI explica"), "the decifra takes the explainer's place");
  assert.match(withDecifra, /<details class="t-dec">.*Copom mantém 13,75% e põe expectativas/);
  assert.ok(!withDecifra.includes("nota interna"));
  const waiting = feedHtml([{ ...official, decifra: { ...TEXT, status: "revisar", createdAt: "" } }], NOW);
  assert.ok(!waiting.includes("t-dec") && waiting.includes("PlatomAI explica"), "a decifra waiting for review is not public");
});

test("everything from a source is escaped, and only http(s) links are kept", () => {
  const html = feedHtml([{ ...base, headline: 'Alta <script>alert(1)</script> "x"', sourceName: "A&B", url: "javascript:alert(1)" }], NOW);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /Alta &lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;x&quot;/);
  assert.match(html, /— A&amp;B/);
  assert.ok(!html.includes("javascript:"));
  assert.match(html, /<span class="t-head">Alta/, "without a valid link the title is plain text");
});

test("the home page carries the latest headlines in its HTML, and the RSS uses the decifra where there is one", async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), "aovivo-pub-"));
  fs.writeFileSync(path.join(pub, "index.html"), '<!doctype html><div id="feed"><!--manchetes--></div>');
  const store = new Store(":memory:");
  store.save({ ...base, publishedAt: new Date().toISOString() });
  store.save({ ...base, id: "c", method: "ia", headline: "Copom mantém Selic", explainer: "Explicação.", publishedAt: new Date(Date.now() - 1000).toISOString(),
    decifra: { ...TEXT, status: "publicado", createdAt: "" } });
  store.save({ ...base, id: "r", status: "revisar", headline: "Manchete em revisão" });
  const srv = createServer({ store, hub: new Hub(60_000), agenda: new Agenda(), publicDir: pub, siteUrl: "https://aovivo.example", showReview: false, ai: { enabled: false, model: "x" }, statuses: () => [] });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${url}/`);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const page = await res.text();
    assert.match(page, /<div id="feed"><section class="day">/);
    assert.match(page, /href="https:\/\/www\.moneytimes\.com\.br\/governo-prorroga-imposto\/"/);
    assert.ok(!page.includes("Manchete em revisão"), "only public headlines");
    assert.ok(!page.includes("<!--manchetes-->"));
    const rss = await (await fetch(`${url}/rss.xml`)).text();
    assert.match(rss, /<description>PlatomAI decifra: Copom mantém 13,75% e põe expectativas no centro do risco\. Para quem toma crédito/);
    assert.ok(!rss.includes("Explicação."));
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test("a \"$\" in a headline is text: the page is assembled without replacement patterns", async () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), "aovivo-pub-"));
  fs.writeFileSync(path.join(pub, "index.html"), '<!doctype html><main><div id="feed"><!--manchetes--></div></main><footer>rodapé</footer></html>');
  const store = new Store(":memory:");
  store.save({ ...base, publishedAt: new Date().toISOString(), headline: "Governo libera 'US$' e S$&P e US$` para importação" });
  const srv = createServer({ store, hub: new Hub(60_000), agenda: new Agenda(), publicDir: pub, siteUrl: "https://aovivo.example", showReview: false, ai: { enabled: false, model: "x" }, statuses: () => [] });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const page = await (await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`)).text();
    assert.equal(page.split("</html>").length, 2, "one document end");
    assert.equal(page.split("rodapé").length, 2);
    assert.ok(page.includes("Governo libera 'US$' e S$&amp;P e US$` para importação"));
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});
