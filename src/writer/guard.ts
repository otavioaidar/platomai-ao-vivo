import { numbersIn } from "../text.ts";

const WORDS: Record<string, number> = { quarter: 0.25, half: 0.5, meio: 0.5 };

/** Every number a source text supports, including fractions like "3-3/4" (Fed style) and "1/4". */
export function sourceNumbers(source: string): Set<number> {
  const out = new Set<number>();
  const add = (n: number) => out.add(Math.round(n * 10000) / 10000);
  for (const n of numbersIn(source)) add(n);
  for (const m of source.matchAll(/(\d+)-(\d+)\/(\d+)/g)) add(Number(m[1]) + Number(m[2]) / Number(m[3]));
  for (const m of source.matchAll(/(?<![\d-])(\d+)\/(\d+)(?![\d/])/g)) add(Number(m[1]) / Number(m[2]));
  for (const [w, v] of Object.entries(WORDS)) if (new RegExp(`\\b${w}\\b`, "i").test(source)) add(v);
  return out;
}

/**
 * Numbers in `text` that the source does not support. Accepts unit conversions the writer is allowed
 * to make (basis points <-> percentage points). An empty list means every number checks out.
 */
export function unsupportedNumbers(text: string, source: string): string[] {
  const known = sourceNumbers(source);
  const has = (n: number) => known.has(Math.round(n * 10000) / 10000);
  const bad: string[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const ok = numbersIn(m[0]).some((n) => has(n) || has(n * 100) || has(n / 100));
    if (!ok) bad.push(m[0]);
  }
  return bad;
}
