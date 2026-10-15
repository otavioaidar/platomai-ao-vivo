// Text helpers shared by sources, writer and publishers.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", ordf: "ª", ordm: "º", deg: "°",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", atilde: "ã", otilde: "õ",
  acirc: "â", ecirc: "ê", ocirc: "ô", agrave: "à", ccedil: "ç", Aacute: "Á", Eacute: "É",
  Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Atilde: "Ã", Otilde: "Õ", Ccedil: "Ç", euro: "€",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

/** Turns an HTML fragment into readable plain text (paragraphs kept as line breaks). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|nav|header|footer)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[​ ]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/^(Share|-->)$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Extracts the main body of an article page: from the first content marker to the footer. */
export function extractArticle(html: string, maxChars = 6000): string {
  const start = [/id=["']article["']/i, /<main[\s>]/i, /<article[\s>]/i, /id=["']content["']/i]
    .map((re) => html.search(re))
    .find((i) => i >= 0);
  let body = start === undefined ? html : html.slice(start);
  const end = body.search(/<\/main>|<footer[\s>]/i);
  if (end > 0) body = body.slice(0, end);
  body = body.replace(/^[^>]*>/, "");
  const text = htmlToText(body);
  return text.length > maxChars ? text.slice(0, maxChars) + " […]" : text;
}

/** pt-BR number with fixed decimals: 0.82 -> "0,82". */
export function fmtNum(v: number, decimals = 2): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Same as fmtNum but keeps an explicit minus sign and never shows "-0,00". */
export function fmtPct(v: number, decimals = 2): string {
  const s = fmtNum(Math.abs(v) < 0.5 * 10 ** -decimals ? 0 : v, decimals);
  return `${s}%`;
}

/** Every numeric value mentioned in a text, accepting both 1.234,56 (pt) and 1,234.56 (en). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const raw = m[0];
    const candidates = new Set<number>();
    candidates.add(Number(raw.replace(/\./g, "").replace(",", "."))); // pt-BR reading
    candidates.add(Number(raw.replace(/,/g, ""))); // en reading
    candidates.add(Number(raw.replace(",", "."))); // bare decimal comma
    for (const c of candidates) if (Number.isFinite(c)) out.push(c);
  }
  return out;
}

/** Cuts text to a limit on a word boundary, adding an ellipsis. */
export function truncate(s: string, max: number): string {
  if ([...s].length <= max) return s;
  const cut = [...s].slice(0, max - 1).join("");
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "202609" -> "setembro". */
export function monthName(yyyymm: string): string {
  const m = Number(yyyymm.slice(4, 6));
  return MONTHS[m - 1] ?? yyyymm;
}
