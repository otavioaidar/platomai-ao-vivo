// Checks that every number in an AI headline or explainer is backed by the source text.
// The checked text is always Brazilian Portuguese; the source is read the way its language writes numbers.
import { parseNumber } from "../text.ts";

type Lang = "pt" | "en";
/** pct: "%", "por cento", "percent"; pp: percentage points; bp: basis points; null: no unit written. */
type Unit = "pct" | "pp" | "bp" | null;
/** num: a real figure; frac: a fraction, which counts only with a unit; date: part of a date or time; word: a spelled-out count or ordinal. */
type Kind = "num" | "frac" | "date" | "word";

interface Num {
  raw: string;
  start: number;
  end: number;
  value: number;
  kind: Kind;
  unit: Unit;
  /** 1, or 1e3/1e6/1e9/1e12 for "mil", "milhões", "billion"… written after it. */
  scale: number;
  /** Written with a minus sign. */
  neg: boolean;
  /** A fall word (recua, queda, fell…) comes before it in the same clause. */
  fall: boolean;
  /** What a fraction reads as when no unit follows it (the integer part of "4 1/4", or "1/4" as a date). */
  alt?: { kind: Kind; values: number[] };
}

/** Accented letters count as letters, so word edges work for "três" or "milhões". */
const L = String.raw`\p{L}`;
const word = (body: string, flags = "giu") => new RegExp(`(?<![${L}\\d])(?:${body})(?![${L}\\d])`, flags);

const BP: [RegExp, Exclude<Unit, null>] = [/^[\s-]*(?:pb|bps?|pontos?[\s-]+(?:base|básicos?)|basis[\s-]+points?)(?![\p{L}])/iu, "bp"];
const PCT: [RegExp, Exclude<Unit, null>] = [/^\s*(?:%|por\s+cento(?![\p{L}])|percent(?![\p{L}])|per\s+cent(?![\p{L}]))/iu, "pct"];
/**
 * Units by role. In the headline, a bare "ponto" is the house style for p.p. ("em 0,5 ponto", "1/4 de ponto").
 * In the source it must say percentual/percentage: "3 pontos de atenção" or "a 10-point plan" are not rates.
 */
const UNITS: Record<"source" | "text", [RegExp, Exclude<Unit, null>][]> = {
  source: [
    BP,
    [/^[\s-]*(?:p\.\s?p\.?|pp(?![\p{L}])|(?:de[\s-]+)?pontos?[\s-]+percentua(?:l|is)|percentage[\s-]+points?)/iu, "pp"],
    PCT,
  ],
  text: [
    BP,
    [/^[\s-]*(?:p\.\s?p\.?|pp(?![\p{L}])|(?:de[\s-]+)?pontos?[\s-]+percentua(?:l|is)|percentage[\s-]+points?|(?:de[\s-]+)?pontos?(?![\p{L}])|points?(?![\p{L}]))/iu, "pp"],
    PCT,
  ],
};

const SCALES: [RegExp, number][] = [
  [/^\s*(?:mil|thousand)(?![\p{L}])/iu, 1e3],
  [/^\s*(?:milh(?:ão|ao|ões|oes)|mi|million|mn|mln)(?![\p{L}])/iu, 1e6],
  [/^\s*(?:bilh(?:ão|ao|ões|oes)|bi|billion|bn)(?![\p{L}])/iu, 1e9],
  [/^\s*(?:trilh(?:ão|ao|ões|oes)|trillion|tn)(?![\p{L}])/iu, 1e12],
];

const FALL = word(
  "ca(?:i|em|iu|íram|iram)|ced(?:e|em|eu|eram)|queda|recu(?:a|am|ou|o)|baix(?:a|am|ou)|reduz(?:ir|iu|em)?|redução|cort(?:a|am|ou|e|ar)|" +
    "deflação|retra(?:i|iu|ção)|encolh(?:e|eu)|diminu(?:i|iu|ição)|negativ[oa]s?|perd(?:a|e|eu)|" +
    "fell|fall(?:s|ing)?|declin(?:e|ed|es|ing)|decrease[ds]?|drop(?:s|ped)?|lower(?:ed)?|cuts?|reduc(?:e|ed|tion)|" +
    "contract(?:ed|ion)|deflation|minus|negative",
  "iu",
);

/** Range links: in "3-3/4 to 4 percent" or "entre R$ 10 e R$ 12 bilhões" the first number takes the second one's unit. */
const LINK = /^\s*(?:a|e|to|and|até|-|–|—)\s*(?:R\$|US\$|€|\$)?\s*$/iu;

/** Rate-change sizes written in words. Only these phrases count: "por meio de" or "second quarter" are not 0,5 or 0,25. */
const PHRASES: Record<Lang, [string, number][]> = {
  pt: [
    [String.raw`tr[eê]s[\s-]+quartos[\s-]+de[\s-]+ponto(?:[\s-]+percentual)?`, 0.75],
    [String.raw`um[\s-]+quarto[\s-]+de[\s-]+ponto(?:[\s-]+percentual)?`, 0.25],
    [String.raw`meio[\s-]+ponto(?:[\s-]+percentual)?`, 0.5],
  ],
  en: [
    [String.raw`three[\s-]+quarters?(?:[\s-]+of[\s-]+a)?[\s-]+(?:percentage[\s-]+)?points?`, 0.75],
    // An article, "percentage" or the hyphenated compound is required: "third quarter point to weaker growth" is not a cut.
    [String.raw`(?:(?:a|one)[\s-]+quarter(?:[\s-]+of[\s-]+a)?[\s-]+(?:percentage[\s-]+)?|quarter(?:[\s-]+of[\s-]+a)?[\s-]+percentage[\s-]+|quarter-)points?`, 0.25],
    [String.raw`(?:(?:a|one)[\s-]+half(?:[\s-]+of)?(?:[\s-]+a)?[\s-]+(?:percentage[\s-]+)?|half(?:[\s-]+of)?(?:[\s-]+a)?[\s-]+percentage[\s-]+|half-)points?`, 0.5],
  ],
};

/** Spelled-out counts. "um", "uma" and "one" are usually articles, so they count only before a unit or scale word. */
const CARDINALS: Record<Lang, Record<string, number>> = {
  pt: {
    um: 1, uma: 1, dois: 2, duas: 2, três: 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
    dez: 10, onze: 11, doze: 12,
  },
  en: {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  },
};
const ARTICLES = new Set(["um", "uma", "one"]);

/** Ordinals and month names: only in the source, where "second quarter" backs "2º trimestre" and "setembro" backs "16/9". */
const ORDINALS: Record<Lang, Record<string, number>> = {
  pt: {
    primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3, quarto: 4, quarta: 4, quinto: 5,
    quinta: 5, sexto: 6, sexta: 6, sétimo: 7, sétima: 7, oitavo: 8, oitava: 8, nono: 9, nona: 9, décimo: 10, décima: 10,
  },
  en: {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    eleventh: 11, twelfth: 12,
  },
};
const MONTHS: Record<Lang, string[]> = {
  pt: ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

const VULGAR: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75 };

function unitAfter(text: string, end: number, role: "source" | "text"): Unit {
  const tail = text.slice(end, end + 40);
  return UNITS[role].find(([re]) => re.test(tail))?.[1] ?? null;
}

function scaleAfter(text: string, end: number): number {
  const tail = text.slice(end, end + 20);
  return SCALES.find(([re]) => re.test(tail))?.[1] ?? 1;
}

function isNegative(text: string, start: number): boolean {
  return /(?:^|[\s(\[:;=])[-−]$/.test(text.slice(Math.max(0, start - 2), start));
}

function followsFall(text: string, start: number): boolean {
  const clause = text.slice(Math.max(0, start - 50), start).split(/[;:!?\n]|[,.](?=\s)/).pop() ?? "";
  return FALL.test(clause);
}

function isYear(n: Num): boolean {
  return n.kind === "num" && /^\d{4}$/.test(n.raw) && n.value >= 1900 && n.value <= 2100;
}

/** Every number in `text`, with its unit, scale and sign. `role` "source" also reads ordinals and month names. */
function numbers(text: string, lang: Lang, role: "source" | "text"): Num[] {
  const out: Num[] = [];
  let rest = text; // matched spans are blanked here so later passes skip them
  const take = (re: RegExp, make: (m: RegExpMatchArray) => Partial<Num> | null) => {
    const spans: [number, number][] = [];
    for (const m of rest.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const made = make(m);
      if (!made) continue;
      const unit = made.unit !== undefined ? made.unit : unitAfter(text, end, role);
      out.push({
        raw: m[0].trim(),
        start,
        end,
        value: 0,
        kind: "num",
        unit,
        scale: unit ? 1 : scaleAfter(text, end),
        neg: isNegative(text, start),
        fall: followsFall(text, start),
        ...made,
      } as Num);
      spans.push([start, end]);
    }
    for (const [s, e] of spans) rest = rest.slice(0, s) + " ".repeat(e - s) + rest.slice(e);
  };
  const digits = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const split = (n: Num, values: number[], kind: Kind): Num[] => values.map((value) => ({ ...n, value, kind, unit: null, scale: 1 }));

  // Dates and times: their parts are not figures ("10/10/2026" must not back "0,10%").
  take(/(?<![\d\/])\d{1,2}\/\d{1,2}\/\d{2,4}(?![\d\/])|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)|(?<!\d)\d{1,2}(?::\d{2}){1,2}(?!\d)|(?<!\d)\d{1,2}h\d{2}(?!\d)/gi, (m) => ({
    kind: "date", value: NaN, alt: { kind: "date", values: digits(m[0]) },
  }));
  // Fed-style fractions: "3-3/4", "4 1/4", "1/4", "4½".
  take(/(?<![\d.,\/])(\d{1,3})(?:-|\s)([1-7])\/([248])(?![\d\/])/g, (m) =>
    Number(m[2]) < Number(m[3])
      ? { kind: "frac", value: Number(m[1]) + Number(m[2]) / Number(m[3]), alt: { kind: "num", values: [Number(m[1])] } }
      : null,
  );
  take(/(?<![\d.,\/])([1-7])\/([248])(?![\d\/])/g, (m) =>
    Number(m[1]) < Number(m[2]) ? { kind: "frac", value: Number(m[1]) / Number(m[2]), alt: { kind: "date", values: digits(m[0]) } } : null,
  );
  take(/(?<![\d.,])(\d+)?\s?([¼½¾])/g, (m) => ({
    kind: "frac", value: Number(m[1] ?? 0) + VULGAR[m[2]], alt: { kind: "num", values: m[1] ? [Number(m[1])] : [] },
  }));
  take(/(?<![\d\/])\d{1,2}\/\d{1,2}(?![\d\/])/g, (m) => ({ kind: "date", value: NaN, alt: { kind: "date", values: digits(m[0]) } }));

  // Numbers written as words.
  for (const [body, value] of PHRASES[lang]) take(word(body), () => ({ value, unit: "pp" }));
  const cardinals = CARDINALS[lang];
  take(word(Object.keys(cardinals).join("|")), (m) => {
    const w = m[0].toLowerCase();
    const end = (m.index ?? 0) + m[0].length;
    const counted = unitAfter(text, end, role) !== null || scaleAfter(text, end) !== 1;
    if (!counted && ARTICLES.has(w)) return null;
    return { value: cardinals[w], kind: counted ? "num" : "word" };
  });
  if (role === "source") {
    const ordinals = ORDINALS[lang];
    // Weekdays ("quarta-feira") and "segundo o IBGE" are not ordinals.
    take(word(Object.keys(ordinals).join("|")), (m) => {
      const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 8);
      if (/^-feira/i.test(after) || /^\s+(?:o|a|os|as)\s/i.test(after)) return null;
      return { value: ordinals[m[0].toLowerCase()], kind: "word", unit: null };
    });
    const months = MONTHS[lang];
    take(word(months.join("|"), lang === "en" ? "gu" : "giu"), (m) => ({
      value: months.findIndex((mo) => mo.toLowerCase() === m[0].toLowerCase()) + 1, kind: "date", unit: null,
    }));
  }

  // Plain figures, read only the way the language writes them.
  take(/\d+(?:[.,]\d+)*/g, (m) => ({ value: parseNumber(m[0], lang) }));

  out.sort((a, b) => a.start - b.start);
  for (let i = out.length - 2; i >= 0; i--) {
    const a = out[i];
    const b = out[i + 1];
    if (a.unit || a.scale !== 1 || a.kind === "date" || a.kind === "word" || isYear(a)) continue;
    if (LINK.test(text.slice(a.end, b.start))) {
      a.unit = b.unit;
      a.scale = b.scale;
    }
  }
  // A fraction with no unit is not a rate ("1/4" is likely a date); dates split into their parts.
  return out.flatMap((n) => {
    if (n.kind === "date" && n.alt) return split(n, n.alt.values, "date");
    if (n.kind === "frac" && !n.unit) return split(n, n.alt?.values ?? [], n.alt?.kind ?? "num");
    return Number.isFinite(n.value) ? [n] : [];
  });
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Whether source number `s` backs number `h` of the checked text. */
function backs(s: Num, h: Num): boolean {
  // A negative figure needs a minus sign or a fall word on the other side.
  if (s.neg && !h.neg && !h.fall) return false;
  if (h.neg && !s.neg && !s.fall) return false;
  const same = (v: number) => near(s.value * s.scale, v * h.scale);
  if (h.unit === null) return same(h.value);
  // Dates, ordinals and spelled-out counts never back a %, p.p. or pb figure.
  if (s.kind !== "num" && s.kind !== "frac") return false;
  // A bare figure backs a % only when written with decimals (a table cell), not "Tabela 1" or "1º".
  if (h.unit === "pct") return (s.unit === "pct" || (s.unit === null && /[.,]/.test(s.raw))) && same(h.value);
  // The only conversion allowed: basis points <-> percentage points, when the source states one of them.
  if (h.unit === "pp") return (s.unit === "pp" && same(h.value)) || (s.unit === "bp" && same(h.value * 100));
  return (s.unit === "bp" && same(h.value)) || (s.unit === "pp" && same(h.value / 100));
}

/**
 * Numbers in `text` (Brazilian Portuguese: 4,25%) that the source does not support, as written in `text`.
 * `sourceLang` says how the source writes numbers (pt: 1.234,56; en: 1,234.56). Units, scale words
 * (mil, milhões, bilhões) and signs must match; the only conversion accepted is basis points <->
 * percentage points. An empty list means every number checks out.
 */
export function unsupportedNumbers(text: string, source: string, sourceLang: Lang = "pt"): string[] {
  const known = numbers(source, sourceLang, "source");
  const bad = new Map<number, string>();
  for (const h of numbers(text, "pt", "text")) {
    if (!known.some((s) => backs(s, h))) bad.set(h.start, h.raw);
  }
  return [...bad.values()];
}
