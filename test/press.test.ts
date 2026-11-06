import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { decodeBody } from "../src/net.ts";
import { PRESS_FEEDS, pressFeeds, pressSource, sameStory, skipTitle, storyUrl } from "../src/sources/press.ts";

function serve(files: Record<string, string>) {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const body = files[url];
    return new Response(body ?? "", { status: body ? 200 : 404, headers: { "content-type": "application/rss+xml; charset=utf-8" } });
  }) as typeof fetch;
  return { urls, restore: () => (globalThis.fetch = real) };
}

test("keeps news titles and drops stock picks, ads, live blogs and service pieces", () => {
  for (const t of [
    "BODB11 tem combinação interessante em ambiente de juros reais elevados",
    "Retorno aos acionistas? Assaí (ASAI3) aprova programa de recompra de ações",
    "Black IA da Empiricus oferece desconto imperdível para você testar 3 modelos",
    "Ibovespa Hoje Ao Vivo: Bolsa oscila em meio a balanços",
    "As 5 melhores ações para comprar em dezembro",
    "IBGE abre inscrições para concurso com mais de 27 mil vagas",
    "Mega-Sena pode pagar R$ 55 milhões nesta sexta-feira",
    "Banco eleva preço-alvo da Petrobras",
  ]) assert.equal(skipTitle(t), true, t);
  for (const t of [
    "Governo prorroga imposto de 12% sobre exportação de petróleo até dezembro",
    "Dólar abre em alta à espera de novos dados de emprego nos EUA",
    "Lula vai criar Ministério da Segurança Pública com Medida Provisória",
    "Ações de gigantes da tecnologia derretem com dúvidas sobre o futuro da IA",
    "TCU recomenda ao governo revisar meta de arrecadação",
    "Inadimplência na carteira de crédito dos bancos sobe em outubro",
  ]) assert.equal(skipTitle(t), false, t);
});

test("the same story from several outlets is one story; open and close of the dollar are two", () => {
  const mt = "Governo prorroga imposto de 12% sobre exportação de petróleo até dezembro";
  assert.equal(sameStory(mt, "Governo Lula prorroga até dezembro imposto de 12% sobre exportação de petróleo"), true);
  assert.equal(sameStory(mt, "Governo prorroga até 31 de dezembro cobrança de imposto de 12% sobre exportação de petróleo"), true);
  assert.equal(sameStory("Dólar abre em alta à espera de dados de emprego nos EUA", "Dólar fecha em alta após dados de emprego nos EUA"), false);
  assert.equal(sameStory("Copom mantém Selic", "Copom eleva Selic"), false);
  assert.equal(sameStory("Dólar sobe", "Dólar sobe"), false, "too few key words to tell");
});

test("a Folha link goes to the story, not through the redirector", () => {
  assert.equal(
    storyUrl("https://redir.folha.com.br/redir/online/mercado/rss091/*https://www1.folha.uol.com.br/mercado/2026/11/dolar.shtml"),
    "https://www1.folha.uol.com.br/mercado/2026/11/dolar.shtml",
  );
  assert.equal(storyUrl("https://g1.globo.com/economia/noticia/x.ghtml"), "https://g1.globo.com/economia/noticia/x.ghtml");
});

test("a press feed yields title, link and date only, without the outlet's text, and skips what is not news", async () => {
  const feed = PRESS_FEEDS.find((f) => f.id === "imprensa-moneytimes")!;
  const s = serve({ [feed.url]: fs.readFileSync("test/fixtures/imprensa/moneytimes.xml", "utf8") });
  try {
    const src = pressSource(feed, 60_000, 1);
    assert.equal(src.kind, "imprensa");
    assert.equal(src.tag, "IMPRENSA");
    const items = await src.poll();
    const titles = items.map((i) => i.title);
    assert.ok(titles.includes("Governo prorroga imposto de 12% sobre exportação de petróleo até dezembro"));
    assert.ok(!titles.some((t) => /BODB11|ASAI3|Empiricus/.test(t)), titles.join(" | "));
    assert.ok(items.every((i) => i.body === "" && i.lang === "pt" && i.url.startsWith("https://www.moneytimes.com.br/")));
    assert.deepEqual(await src.poll(), [], "an unchanged feed hands nothing over");
  } finally {
    s.restore();
  }
});

test("a feed with sections keeps only the configured ones", async () => {
  const feed = { id: "imprensa-teste", outlet: "teste", name: "Teste", url: "https://press.example/feed", paths: ["/economia/"] };
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Governo define lista de minerais críticos</title><link>https://press.example/economia/noticia/a.html</link><guid>a</guid><pubDate>Fri, 06 Nov 2026 12:00:00 GMT</pubDate></item>
    <item><title>Superesportivo bate recorde de velocidade</title><link>https://press.example/carros/noticia/b.html</link><guid>b</guid><pubDate>Fri, 06 Nov 2026 12:01:00 GMT</pubDate></item>
  </channel></rss>`;
  const s = serve({ [feed.url]: xml });
  try {
    const items = await pressSource(feed, 60_000, 1).poll();
    assert.deepEqual(items.map((i) => i.externalId), ["a"]);
  } finally {
    s.restore();
  }
});

test("Folha's redirector links are unwrapped from its real feed", async () => {
  const feed = PRESS_FEEDS.find((f) => f.outlet === "folha")!;
  const s = serve({ [feed.url]: fs.readFileSync("test/fixtures/imprensa/folha.xml", "utf8") });
  try {
    const items = await pressSource(feed, 60_000, 1).poll();
    assert.ok(items.length > 0);
    assert.ok(items.every((i) => !i.url.includes("redir.folha")), items.map((i) => i.url).join(" "));
  } finally {
    s.restore();
  }
});

test("only the outlets turned on are polled, and Folha is off by default", () => {
  const on = pressFeeds(["g1", "poder360"], 60_000, 1).map((s) => s.id);
  assert.deepEqual(on, ["imprensa-poder360", "imprensa-g1-economia", "imprensa-g1-politica"]);
  assert.ok(PRESS_FEEDS.every((f) => f.id.startsWith("imprensa-")));
});

test("a body is decoded in the charset it declares, in the header or in the XML declaration", () => {
  const latin1 = Uint8Array.from([...'<?xml version="1.0" encoding="ISO-8859-1"?><t>Dólar e câmbio</t>'].map((c) => c.charCodeAt(0)));
  assert.equal(decodeBody(latin1, "text/xml"), '<?xml version="1.0" encoding="ISO-8859-1"?><t>Dólar e câmbio</t>');
  assert.equal(decodeBody(new TextEncoder().encode("Dólar"), "application/rss+xml; charset=UTF-8"), "Dólar");
  assert.equal(decodeBody(new TextEncoder().encode("Dólar"), "text/xml; charset=nao-existe"), "Dólar");
});
