import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { brasiliaTime, cvmSource, filingTitle, parseRad, viewUrl } from "../src/sources/cvm.ts";

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

test("reads the RAD answer: company, subject, Brasília delivery time and the document ids", () => {
  const filings = parseRad(rad.d.dados);
  assert.deepEqual(filings, [
    { sequence: "1109030", version: "1", protocol: "1584324", codeCvm: "00243-7", company: "AXIA ENERGIA S.A.", category: "Fato Relevante", subject: "Cancelamento do registro perante a SEC", deliveredAt: "2026-11-05T11:08:00.000Z" },
    { sequence: "1109021", version: "1", protocol: "1584315", codeCvm: "01665-9", company: "PORTO SEGURO S.A.", category: "Fato Relevante", subject: "Modificação de Projeções Divulgadas", deliveredAt: "2026-11-05T09:47:00.000Z" },
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
  assert.equal(viewUrl("1584324"), "https://www.rad.cvm.gov.br/ENET/frmExibirArquivoIPEExterno.aspx?NumeroProtocoloEntrega=1584324");
});

test("polls today and yesterday for fatos relevantes only, and turns each filing into an item", async (t) => {
  const calls = stubFetch(t, () => json(rad));
  const items = await cvmSource({ intervalMs: 30_000, extract: async () => null }).poll();
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://www.rad.cvm.gov.br/ENET/frmConsultaExternaCVM.aspx/ListarDocumentos");
  const body = JSON.parse(calls[0].body!);
  assert.equal(body.categoria, "IPE_4_-1_-1");
  assert.match(body.dataDe, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(items.length, 2);
  assert.deepEqual(
    { id: items[1].externalId, title: items[1].title, url: items[1].url, at: items[1].publishedAt, lang: items[1].lang },
    {
      id: "1584315",
      title: "Fato relevante: PORTO SEGURO S.A. — Modificação de Projeções Divulgadas",
      url: "https://www.rad.cvm.gov.br/ENET/frmExibirArquivoIPEExterno.aspx?NumeroProtocoloEntrega=1584315",
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
  const calls = stubFetch(t, (url) => (url.includes("ListarDocumentos") ? json(rad) : new Response(pdf ? "%PDF-1.4 conteudo" : "<html>erro</html>")));
  const seen: Buffer[] = [];
  const src = cvmSource({ intervalMs: 30_000, extract: async (b) => (seen.push(b), "FATO RELEVANTE\nA Porto Seguro comunica as projeções de 2026.") });
  const [, porto] = await src.poll();
  const full = await src.enrich!(porto);
  assert.match(calls[1].url, /frmDownloadDocumento\.aspx\?Tela=ext&numSequencia=1109021&numVersao=1&numProtocolo=1584315&descTipo=IPE/);
  assert.equal(seen[0].subarray(0, 5).toString(), "%PDF-");
  assert.match(full.body, /Assunto: Modificação de Projeções Divulgadas\.\n\nFATO RELEVANTE\nA Porto Seguro comunica as projeções de 2026\.$/);

  pdf = false;
  assert.equal((await src.enrich!(porto)).body, porto.body);
  // An item queued before a restart is not in memory any more: it keeps its summary without another download.
  const before = calls.length;
  assert.equal((await cvmSource({ intervalMs: 30_000 }).enrich!(porto)).body, porto.body);
  assert.equal(calls.length, before);
});
