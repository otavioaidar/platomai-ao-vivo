import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { brasiliaTime, cvmSource, filingTitle, parseRad, portugueseText, viewUrl } from "../src/sources/cvm.ts";
import { unsupportedNumbers } from "../src/writer/guard.ts";

// Real answer of the CVM's RAD search for fatos relevantes on 05/11/2026.
const rad = JSON.parse(fs.readFileSync("test/fixtures/cvm-rad.json", "utf8")) as { d: { dados: string } };

interface Call {
  url: string;
  method: string;
  body: string | null;
}

function stubFetch(t: { after: (fn: () => void) => void }, handler: (url: string) => Response): Call[] {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null });
    return handler(url);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const b64 = (s: string) => Buffer.from(s, "latin1").toString("base64");

test("reads the RAD answer: company, subject, Brasília delivery time and the document ids", () => {
  const filings = parseRad(rad.d.dados);
  assert.deepEqual(filings, [
    { status: "Ativo", sequence: "1109030", version: "1", protocol: "1584324", codeCvm: "00243-7", company: "AXIA ENERGIA S.A.", category: "Fato Relevante", subject: "Cancelamento do registro perante a SEC", deliveredAt: "2026-11-05T11:08:00.000Z" },
    { status: "Ativo", sequence: "1109021", version: "1", protocol: "1584315", codeCvm: "01665-9", company: "PORTO SEGURO S.A.", category: "Fato Relevante", subject: "Modificação de Projeções Divulgadas", deliveredAt: "2026-11-05T09:47:00.000Z" },
  ]);
  assert.deepEqual(parseRad(""), []);
  assert.deepEqual(parseRad("lixo$&sem campos&*"), []);
});

test("Brasília times become UTC and titles name the company and the subject", () => {
  assert.equal(brasiliaTime("05/11/2026 08:08"), "2026-11-05T11:08:00.000Z");
  assert.equal(brasiliaTime("31/12/2026 23:30"), "2027-01-01T02:30:00.000Z");
  assert.equal(brasiliaTime("ontem"), null);
  const [f] = parseRad(rad.d.dados);
  assert.equal(filingTitle(f), "Fato relevante: AXIA ENERGIA S.A. — Cancelamento do registro perante a SEC");
  assert.equal(filingTitle({ ...f, version: "2", subject: "" }), "Fato relevante (reapresentação): AXIA ENERGIA S.A.");
  assert.equal(viewUrl("1584324"), "https://www.rad.cvm.gov.br/ENETWeb/frmExibirArquivoIPEExterno.aspx?NumeroProtocoloEntrega=1584324");
});

test("polls today and yesterday for fatos relevantes only, and turns each filing into an item", async (t) => {
  const calls = stubFetch(t, () => json(rad));
  const items = await cvmSource({ intervalMs: 30_000, extract: async () => null }).poll();
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://www.rad.cvm.gov.br/ENETWeb/frmConsultaExternaCVM.aspx/ListarDocumentos");
  const body = JSON.parse(calls[0].body!);
  assert.equal(body.categoria, "IPE_4_-1_-1");
  assert.match(body.dataDe, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(items.length, 2);
  assert.deepEqual(
    { id: items[1].externalId, title: items[1].title, url: items[1].url, at: items[1].publishedAt, lang: items[1].lang },
    {
      id: "1584315",
      title: "Fato relevante: PORTO SEGURO S.A. — Modificação de Projeções Divulgadas",
      url: "https://www.rad.cvm.gov.br/ENETWeb/frmExibirArquivoIPEExterno.aspx?NumeroProtocoloEntrega=1584315",
      at: "2026-11-05T09:47:00.000Z",
      lang: "pt",
    },
  );
  assert.match(items[1].body, /^Fato relevante de PORTO SEGURO S\.A\. \(código CVM 01665-9\), entregue à CVM\. Assunto: Modificação de Projeções Divulgadas\.$/);
});

test("an error answer from the CVM is a failed poll, not an empty one", async (t) => {
  stubFetch(t, () => json({ d: { temErro: true, msgErro: "Sessão expirada" } }));
  await assert.rejects(cvmSource({ intervalMs: 30_000 }).poll(), /CVM: Sessão expirada/);
});

test("enrich downloads the filed PDF and adds its text; anything that is not a PDF keeps the summary", async (t) => {
  let pdf = true;
  const calls = stubFetch(t, (url) => (url.includes("ListarDocumentos") ? json(rad) : json({ d: b64(pdf ? "%PDF-1.4 conteudo\n%%EOF" : "<html>erro</html>") })));
  const seen: Buffer[] = [];
  const src = cvmSource({ intervalMs: 30_000, extract: async (b) => (seen.push(b), "FATO RELEVANTE\nA Porto Seguro comunica as projeções de 2026.") });
  const [, porto] = await src.poll();
  const full = await src.enrich!(porto);
  assert.equal(calls[1].url, "https://www.rad.cvm.gov.br/ENETWeb/frmExibirArquivoIPEExterno.aspx/ExibirPDF");
  assert.equal(calls[1].method, "POST");
  assert.equal(JSON.parse(calls[1].body!).numeroProtocolo, "1584315");
  assert.equal(seen[0].subarray(0, 5).toString(), "%PDF-");
  assert.match(full.body, /Assunto: Modificação de Projeções Divulgadas\.\n\nFATO RELEVANTE\nA Porto Seguro comunica as projeções de 2026\.$/);

  pdf = false;
  assert.equal((await src.enrich!(porto)).body, porto.body);
  // An item queued before a restart is not in memory any more: it keeps its summary without another download.
  const before = calls.length;
  assert.equal((await cvmSource({ intervalMs: 30_000 }).enrich!(porto)).body, porto.body);
  assert.equal(calls.length, before);
});

// Shaped like the real CSN filing of 20/10/2026 (protocol 1581919): Portuguese first, then the English version.
const BILINGUE = [
  "COMPANHIA SIDERÚRGICA NACIONAL",
  "FATO RELEVANTE",
  "A Companhia informa a venda da CSN Cimentos por valor de empresa de R$ 12,7 bilhões, com alta de 8,5% sobre a proposta anterior.",
  "Base: R$ 12.7 billion (8.5% acima), conforme apresentação.",
  "MATERIAL FACT",
  "The Company announces the sale of CSN Cimentos for an enterprise value of R$ 12.7 billion, up 8.5%.",
].join("\n");

test("bilingual filings keep only the Portuguese text, so the number check reads every number the right way", () => {
  const { text, lang } = portugueseText(BILINGUE);
  assert.equal(lang, "pt");
  assert.doesNotMatch(text, /MATERIAL FACT|billion|12\.7/);
  assert.match(text, /R\$ 12,7 bilhões/);
  // Before the cut, "12.7 billion" read as Portuguese made a 10x wrong headline pass.
  assert.deepEqual(unsupportedNumbers("CSN vende CSN Cimentos por R$ 12,7 bilhões", text, lang), []);
  assert.notDeepEqual(unsupportedNumbers("CSN vende CSN Cimentos por R$ 127 bilhões", text, lang), []);
  assert.notDeepEqual(unsupportedNumbers("Valor sobe 85% sobre a proposta", text, lang), []);
});

test("an English-only filing is marked English; English first and Portuguese after keeps the Portuguese", () => {
  assert.equal(portugueseText("MATERIAL FACT\nTIM S.A. announces R$1,562,205,580.51 in interest on capital.").lang, "en");
  const flipped = portugueseText("MATERIAL FACT\nThe Company announces R$ 1.5 billion.\nFATO RELEVANTE\nA Companhia anuncia R$ 1,5 bilhão.");
  assert.equal(flipped.lang, "pt");
  assert.equal(flipped.text, "FATO RELEVANTE\nA Companhia anuncia R$ 1,5 bilhão.");
  assert.equal(portugueseText("Texto sem título, com 3,5% de alta.").text, "Texto sem título, com 3,5% de alta.");
});

test("captcha, an expired session or a changed format fail the poll instead of looking like a quiet day", async (t) => {
  let answer: unknown = { d: { temErro: false, dados: "", SolicitarCaptcha: "S" } };
  stubFetch(t, () => json(answer));
  const src = cvmSource({ intervalMs: 30_000 });
  await assert.rejects(src.poll(), /captcha/);
  answer = { d: { temErro: false, dados: "", expirouSessao: true } };
  await assert.rejects(src.poll(), /sessão expirada/);
  answer = { d: { temErro: false, dados: null } };
  await assert.rejects(src.poll(), /sem lista/);
  answer = { d: { temErro: false, dados: rad.d.dados.replace(/OpenDownloadDocumentos\(/g, "Baixar(") } };
  await assert.rejects(src.poll(), /formato da lista mudou/);
  answer = { d: { temErro: false, dados: "", SolicitarCaptcha: "N" } };
  assert.deepEqual(await src.poll(), [], "a day with no filings is normal");
});

test("a replaced filing is dropped and a re-filing is history only, flagged as a correction", async (t) => {
  const recs = rad.d.dados.split("&*");
  // Function replacements: "$&" in a replacement string would mean "the matched text".
  const inactive = recs[0].replace("$&Ativo$&", () => "$&Inativo$&");
  const refiled = recs[1].replace("$&Ativo$&1$&", () => "$&Ativo$&2$&").replace("'1109021','1','1584315'", "'1109021','2','1584399'");
  stubFetch(t, () => json({ d: { temErro: false, dados: [inactive, refiled, ""].join("&*") } }));
  const items = await cvmSource({ intervalMs: 30_000 }).poll();
  assert.equal(items.length, 1);
  assert.equal(items[0].externalId, "1584399");
  assert.equal(items[0].stale, true);
  assert.match(items[0].title, /^Fato relevante \(reapresentação\): PORTO SEGURO/);
  assert.match(items[0].body, /Reapresentação \(versão 2\) de documento já entregue: é uma correção, não um fato novo\.$/);
});

test("when the PDF cannot be downloaded, the headline goes out with the subject instead of waiting for retries", async (t) => {
  stubFetch(t, (url) => (url.includes("ListarDocumentos") ? json(rad) : new Response("erro", { status: 500 })));
  const src = cvmSource({ intervalMs: 30_000, extract: async () => "nunca chamado" });
  const [, porto] = await src.poll();
  const out = await src.enrich!(porto);
  assert.equal(out.body, porto.body);
});

test("enrich keeps the Portuguese half of a bilingual PDF and marks an English-only one", async (t) => {
  stubFetch(t, (url) => (url.includes("ListarDocumentos") ? json(rad) : json({ d: b64("%PDF-1.4\n%%EOF") })));
  let text = BILINGUE;
  const src = cvmSource({ intervalMs: 30_000, extract: async () => text });
  const [, porto] = await src.poll();
  const pt = await src.enrich!(porto);
  assert.equal(pt.lang, "pt");
  assert.doesNotMatch(pt.body, /MATERIAL FACT|billion/);
  text = "MATERIAL FACT\nPorto Seguro updates its 2026 guidance.";
  const src2 = cvmSource({ intervalMs: 30_000, extract: async () => text });
  const [, again] = await src2.poll();
  const en = await src2.enrich!(again);
  assert.equal(en.lang, "en");
  assert.match(en.body, /Porto Seguro updates its 2026 guidance\.$/);
});

test("a PDF cut short (no %%EOF at the end) is not sent to text extraction", async (t) => {
  stubFetch(t, (url) => (url.includes("ListarDocumentos") ? json(rad) : json({ d: b64("%PDF-1.4 pela metade") })));
  let extracted = false;
  const src = cvmSource({ intervalMs: 30_000, extract: async () => ((extracted = true), "texto") });
  const [, porto] = await src.poll();
  assert.equal((await src.enrich!(porto)).body, porto.body);
  assert.equal(extracted, false);
});
