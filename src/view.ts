import type { Headline } from "./types.ts";

/**
 * What the public site and the live stream may see of a headline: the decifra only once it is published (without
 * the reviewer's check notes), and never the agent's internal NÃO VALE TEXTO reason.
 */
export function publicHeadline(h: Headline): Headline {
  const { decifra, decifraSkipped: _skipped, ...rest } = h;
  if (decifra?.status !== "publicado") return rest;
  const { checks: _checks, ...shown } = decifra;
  return { ...rest, decifra: shown };
}
