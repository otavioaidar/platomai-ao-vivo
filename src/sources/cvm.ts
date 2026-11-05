// CVM fatos relevantes: the CVM's own document search (RAD/ENET), polled for today's filings. A fato relevante is an
// official filing, published free by the regulator; the full text comes from the filed PDF via `pdftotext`
// (poppler-utils, installed in the Docker image). Without it, the headline is written from the filing's subject only.
import { execFile } from "node:child_process";
import { log } from "../log.ts";
import { fetchBytes, postJson } from "../net.ts";
import { decodeEntities } from "../text.ts";
import type { RawItem, Source } from "../types.ts";

const RAD = "https://www.rad.cvm.gov.br/ENET";
/** Category code of "Fato Relevante" in the RAD search (IPE documents). */
const FATO_RELEVANTE = "IPE_4_-1_-1";
/** The text sent to the writer: enough for a filing, short enough for a prompt. */
const MAX_TEXT = 6000;

export interface CvmFiling {
  protocol: string;
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
    out.push({
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

function downloadUrl(f: Pick<CvmFiling, "sequence" | "version" | "protocol">): string {
  return `${RAD}/frmDownloadDocumento.aspx?Tela=ext&numSequencia=${f.sequence}&numVersao=${f.version}&numProtocolo=${f.protocol}&descTipo=IPE&CodigoInstituicao=1`;
}

export function filingTitle(f: CvmFiling): string {
  const again = Number(f.version) > 1 ? " (reapresentação)" : "";
  return `Fato relevante${again}: ${f.company}${f.subject ? ` — ${f.subject}` : ""}`;
}

let warnedNoPdftotext = false;

/** Text of a PDF through poppler's pdftotext; null if the tool is missing or the file has no text layer. */
export function pdfToText(pdf: Buffer): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
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
    intervalMs: o.intervalMs,
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
      const res = await postJson<{ d?: { temErro?: boolean; msgErro?: string; dados?: string } }>(
        `${RAD}/frmConsultaExternaCVM.aspx/ListarDocumentos`,
        body,
        20_000,
        { referer: `${RAD}/frmConsultaExternaCVM.aspx`, "x-requested-with": "XMLHttpRequest" },
      );
      if (!res.d || res.d.temErro) throw new Error(`CVM: ${res.d?.msgErro || "resposta sem documentos"}`);
      const items: RawItem[] = [];
      for (const f of parseRad(res.d.dados ?? "")) {
        filings.set(f.protocol, f);
        if (filings.size > 500) filings.delete(filings.keys().next().value!);
        items.push({
          sourceId: "cvm-fatos",
          externalId: f.protocol,
          url: viewUrl(f.protocol),
          title: filingTitle(f),
          body: `Fato relevante de ${f.company} (código CVM ${f.codeCvm}), entregue à CVM.${f.subject ? ` Assunto: ${f.subject}.` : ""}`,
          publishedAt: f.deliveredAt,
          lang: "pt",
        });
      }
      return items;
    },
    async enrich(item) {
      const f = filings.get(item.externalId);
      if (!f) return item; // after a restart the queued item keeps the summary written at poll time
      const pdf = await fetchBytes(downloadUrl(f), 30_000);
      if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") return item; // not a PDF (e.g. a zip or an error page)
      const text = await extract(pdf);
      if (!text) return item;
      const cut = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)} […]` : text;
      return { ...item, body: `${item.body}\n\n${cut}` };
    },
  };
}
