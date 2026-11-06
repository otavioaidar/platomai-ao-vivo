// CVM fatos relevantes: the CVM's own document search (RAD/ENET), polled for today's filings. A fato relevante is an
// official filing, published free by the regulator; the full text comes from the filed PDF via `pdftotext`
// (poppler-utils, installed in the Docker image). Without it, the headline is written from the filing's subject only.
import { execFile } from "node:child_process";
import { log } from "../log.ts";
import { postJson } from "../net.ts";
import { decodeEntities } from "../text.ts";
import type { RawItem, Source } from "../types.ts";

const RAD = "https://www.rad.cvm.gov.br/ENETWeb";
/** Category code of "Fato Relevante" in the RAD search (IPE documents). */
const FATO_RELEVANTE = "IPE_4_-1_-1";
/** The text sent to the writer: enough for a filing, short enough for a prompt. */
const MAX_TEXT = 6000;

export interface CvmFiling {
  protocol: string;
  status: string;
  sequence: string;
  version: string;
  codeCvm: string;
  company: string;
  category: string;
  subject: string;
  /** When the company delivered it to the CVM, ISO (the RAD shows Brasília time). */
  deliveredAt: string;
}

export interface CvmOptions {
  intervalMs: number;
  /** Faster cadence on weekdays 06:30–08:30 and 17:30–20:30 in Brasília, when most fatos relevantes come out. */
  hotIntervalMs?: number;
  /** PDF → text; defaults to pdftotext. Returns null when no text could be extracted. */
  extract?: (pdf: Buffer) => Promise<string | null>;
}

function clean(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** "05/11/2026 08:08" in Brasília → ISO. */
export function brasiliaTime(s: string): string | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]) + 3, Number(m[5]));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * The RAD answers one string: records separated by "&*", fields by "$&": CVM code, company, category, type,
 * subject, reference date, delivery date and time, status, version, modality, action icons (with the protocol and
 * download ids) and the subject again.
 */
export function parseRad(dados: string): CvmFiling[] {
  const out: CvmFiling[] = [];
  for (const rec of dados.split("&*")) {
    const f = rec.split("$&");
    if (f.length < 11) continue;
    const dl = rec.match(/OpenDownloadDocumentos\('(\d+)','(\d+)','(\d+)','IPE'\)/);
    const deliveredAt = brasiliaTime(clean(f[6]));
    const company = clean(f[1]);
    if (!dl || !deliveredAt || !company) continue;
    const subject = (clean(f[11] ?? "") || clean(f[4]).replace(/\s*-\s*$/, "")).replace(/\.+$/, "");
    const status = clean(f[7]);
    // A filing replaced by a new version is no longer active: only the current one counts.
    if (status && status !== "Ativo") continue;
    out.push({
      status,
      sequence: dl[1],
      version: dl[2],
      protocol: dl[3],
      codeCvm: clean(f[0]),
      company,
      category: clean(f[2]),
      subject: subject === "-" ? "" : subject,
      deliveredAt,
    });
  }
  return out;
}

export function viewUrl(protocol: string): string {
  return `${RAD}/frmExibirArquivoIPEExterno.aspx?NumeroProtocoloEntrega=${protocol}`;
}

/**
 * The filed PDF, through the method the CVM's own viewer uses (base64 in JSON). The plain download link
 * (frmDownloadDocumento) was found to cut files short, which breaks text extraction.
 */
async function filedPdf(protocol: string): Promise<Buffer> {
  const res = await postJson<{ d?: string }>(
    `${RAD}/frmExibirArquivoIPEExterno.aspx/ExibirPDF`,
    { codigoInstituicao: "1", numeroProtocolo: protocol, token: "", versaoCaptcha: "" },
    30_000,
    { referer: viewUrl(protocol), "x-requested-with": "XMLHttpRequest" },
  );
  if (typeof res.d !== "string" || !res.d) throw new Error("CVM: documento sem conteúdo");
  if (res.d.length > 20_000_000) throw new Error("CVM: documento grande demais");
  return Buffer.from(res.d, "base64");
}

export function filingTitle(f: CvmFiling): string {
  const again = Number(f.version) > 1 ? " (reapresentação)" : "";
  return `Fato relevante${again}: ${f.company}${f.subject ? ` — ${f.subject}` : ""}`;
}

let warnedNoPdftotext = false;

/** Text of a PDF through poppler's pdftotext; null if the tool is missing or the file has no text layer. */
export function pdfToText(pdf: Buffer): Promise<string | null> {
  return new Promise((resolve) => {
    // Without -layout: two-column bilingual filings come out as whole Portuguese and English blocks, not interleaved.
    const child = execFile("pdftotext", ["-enc", "UTF-8", "-", "-"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && !warnedNoPdftotext) {
          warnedNoPdftotext = true;
          log.warn("CVM: pdftotext não instalado (poppler-utils); fatos relevantes saem só com o assunto");
        }
        return resolve(null);
      }
      const text = stdout.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      resolve(text || null);
    });
    child.stdin?.on("error", () => {}); // the tool may exit before reading everything
    child.stdin?.end(pdf);
  });
}

/** Title line where the English version of a bilingual filing starts. */
const ENGLISH_START = /^\s*(MATERIAL FACT|RELEVANT FACT|NOTICE TO (THE )?MARKET|ANNOUNCEMENT TO THE MARKET|MARKET ANNOUNCEMENT)\b/im;
const PORTUGUESE_TITLE = /FATO RELEVANTE|COMUNICADO AO MERCADO/i;
/** An English decimal before a unit ("12.7 billion", "8.5%"): read the Brazilian way it would be 10 or 100 times off. */
const ENGLISH_DECIMAL = /\d\.\d{1,3}\s*(%|percent|million|billion|thousand|bn|mn)\b/i;

/**
 * Most filings are bilingual. The writer and the number check read the text as Portuguese, where "12.7" means 127,
 * so the English half is cut off; a filing only in English is marked as such. Stray English-decimal lines go too.
 */
export function portugueseText(text: string): { text: string; lang: "pt" | "en" } {
  const pt = PORTUGUESE_TITLE.exec(text);
  const en = ENGLISH_START.exec(text);
  if (en && !pt) return { text, lang: "en" };
  let part = text;
  if (pt && en) {
    if (en.index > pt.index) {
      part = text.slice(0, en.index); // Portuguese first (with the company header above it), English after
    } else {
      // English first: keep the Portuguese version, up to an English section after it, if any.
      const rest = text.slice(pt.index);
      const again = ENGLISH_START.exec(rest);
      part = again ? rest.slice(0, again.index) : rest;
    }
  }
  const lines = part.split("\n").filter((l) => !ENGLISH_DECIMAL.test(l));
  return { text: lines.join("\n").trim(), lang: "pt" };
}

/**
 * Weekday windows (Brasília) where fatos relevantes cluster: before the open and after the close. In the 30 days to
 * 05/11/2026, 52% of them came out between 17h and 20h and only 5% during trading hours.
 */
export function inFilingWindow(now: Date): boolean {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  if (v("weekday") === "Sat" || v("weekday") === "Sun") return false;
  const m = Number(v("hour")) * 60 + Number(v("minute"));
  return (m >= 6 * 60 + 30 && m < 8 * 60 + 30) || (m >= 17 * 60 + 30 && m < 20 * 60 + 30);
}

function ddmmyyyy(d: Date): string {
  const p = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("day")}/${v("month")}/${v("year")}`;
}

export function cvmSource(o: CvmOptions): Source {
  const extract = o.extract ?? pdfToText;
  const filings = new Map<string, CvmFiling>();
  return {
    id: "cvm-fatos",
    name: "CVM (fatos relevantes)",
    tag: "CVM",
    region: "BR",
    kind: "oficial",
    intervalMs: o.intervalMs,
    hotIntervalMs: (now) => (inFilingWindow(now) ? Math.min(o.hotIntervalMs ?? 10_000, o.intervalMs) : null),
    async poll() {
      const now = new Date();
      // Yesterday too: a filing delivered just before midnight is still found on the first poll after it.
      const body = {
        dataDe: ddmmyyyy(new Date(now.getTime() - 86_400_000)),
        dataAte: ddmmyyyy(now),
        empresa: "", setorAtividade: "-1", categoriaEmissor: "-1", situacaoEmissor: "-1", tipoParticipante: "-1",
        dataReferencia: "", categoria: FATO_RELEVANTE, periodo: "2", horaIni: "", horaFim: "", palavraChave: "",
        ultimaDtRef: "false", tipoEmpresa: "0", token: "", versaoCaptcha: "",
      };
      const res = await postJson<{ d?: { temErro?: boolean; msgErro?: string; dados?: string | null; expirouSessao?: boolean; SolicitarCaptcha?: string } }>(
        `${RAD}/frmConsultaExternaCVM.aspx/ListarDocumentos`,
        body,
        20_000,
        { referer: `${RAD}/frmConsultaExternaCVM.aspx`, "x-requested-with": "XMLHttpRequest" },
      );
      // Each of these used to look like a quiet day: say so instead, so the status page shows the source failing.
      if (!res.d || res.d.temErro) throw new Error(`CVM: ${res.d?.msgErro || "resposta sem documentos"}`);
      if (res.d.SolicitarCaptcha === "S") throw new Error("CVM: a consulta pediu captcha");
      if (res.d.expirouSessao) throw new Error("CVM: sessão expirada");
      if (typeof res.d.dados !== "string") throw new Error("CVM: resposta sem lista");
      const raw = res.d.dados.split("&*").filter((r) => r.split("$&").length >= 11).length;
      const parsed = parseRad(res.d.dados);
      if (raw > 0 && parsed.length === 0) throw new Error("CVM: formato da lista mudou");
      const items: RawItem[] = [];
      for (const f of parsed) {
        filings.set(f.protocol, f);
        if (filings.size > 500) filings.delete(filings.keys().next().value!);
        const again = Number(f.version) > 1;
        items.push({
          sourceId: "cvm-fatos",
          externalId: f.protocol,
          url: viewUrl(f.protocol),
          title: filingTitle(f),
          body:
            `Fato relevante de ${f.company} (código CVM ${f.codeCvm}), entregue à CVM.${f.subject ? ` Assunto: ${f.subject}.` : ""}` +
            (again ? ` Reapresentação (versão ${f.version}) de documento já entregue: é uma correção, não um fato novo.` : ""),
          publishedAt: f.deliveredAt,
          lang: "pt",
          // A re-filing corrects a fact already out: site history only, never a new alert on the social networks.
          ...(again ? { stale: true } : {}),
        });
      }
      return items;
    },
    async enrich(item) {
      const f = filings.get(item.externalId);
      if (!f) return item; // after a restart the queued item keeps the summary written at poll time
      let pdf: Buffer;
      try {
        pdf = await filedPdf(f.protocol);
      } catch (err) {
        // The headline goes out with the subject now, instead of waiting hours of retries for the PDF.
        log.warn(`CVM: PDF do protocolo ${f.protocol} indisponível; a manchete sai com o assunto`, err);
        return item;
      }
      // A whole PDF starts with %PDF- and ends with %%EOF; anything else is a partial file or not a PDF at all.
      if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-" || !pdf.subarray(-1024).toString("latin1").includes("%%EOF")) {
        log.warn(`CVM: o documento do protocolo ${f.protocol} não veio como PDF inteiro; a manchete sai com o assunto`);
        return item;
      }
      const extracted = await extract(pdf);
      if (!extracted) return item;
      const { text, lang } = portugueseText(extracted);
      if (!text) return item;
      const cut = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)} […]` : text;
      return { ...item, body: `${item.body}\n\n${cut}`, lang };
    },
  };
}
