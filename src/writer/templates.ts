import { fmtNum, fmtPct, monthName } from "../text.ts";
import type { Draft, IndicatorRelease, Urgency } from "../types.ts";

/** Brazilian month name from a SIDRA label like "agosto 2026"; falls back to the label. */
function shortLabel(label: string | null): string {
  if (!label) return "";
  return label.replace(/\s+\d{4}$/, "");
}

function signed(v: number, decimals = 2): string {
  return fmtPct(v, decimals);
}

/** A value in hundredths exactly as shown with 2 decimals ("0,82" -> 82). */
function cents(v: number): number {
  return Number(fmtNum(v, 2).replace(/[.,]/g, ""));
}

function consensusPhrase(value: number, consensus: number | null): { text: string; surprise: number } {
  if (consensus === null) return { text: "", surprise: 0 };
  // Compare the numbers as displayed, so the word always matches what the reader sees.
  const c = cents(consensus);
  const diff = (cents(value) - c) / 100;
  const ref = `mediana Focus (${signed(c / 100)})`;
  if (diff > 0) return { text: `, acima da ${ref}`, surprise: diff };
  if (diff < 0) return { text: `, abaixo da ${ref}`, surprise: diff };
  return { text: `, em linha com a ${ref}`, surprise: 0 };
}

function priceIndex(rel: IndicatorRelease, baseUrgency: Urgency): Draft {
  const v = rel.values.mes;
  const verb = v > 0 ? "sobe" : v < 0 ? "recua" : "fica estável em";
  const month = monthName(rel.period);
  const c = consensusPhrase(v, rel.consensus);
  const parts = [`${rel.label} de ${month} ${verb} ${fmtPct(Math.abs(v))}${c.text}`];
  if (rel.previous.mes !== undefined) parts.push(`${shortLabel(rel.previousPeriodLabel)}: ${signed(rel.previous.mes)}`);
  if (rel.values["12m"] !== undefined) parts.push(`em 12 meses, ${fmtPct(rel.values["12m"])}`);
  const urgency: Urgency = Math.abs(c.surprise) >= 0.05 ? "urgente" : baseUrgency;
  return {
    publish: true,
    urgency,
    headline: parts.join("; "),
    explainer: null,
    topics: ["inflacao"],
    reason: "dado oficial com modelo fixo",
    method: "template",
  };
}

/** Unemployment over a rolling quarter, compared as IBGE does: with the quarter before (no shared month) and a year earlier. */
function unemployment(rel: IndicatorRelease): Draft {
  const v = rel.values.taxa;
  const prev = rel.previous.taxa;
  const yearAgo = rel.previous.taxa_ano_anterior;
  let headline = `Taxa de desemprego fica em ${fmtNum(v, 1)}% no trimestre ${shortLabel(rel.periodLabel)}`;
  if (prev !== undefined) headline += `; trimestre anterior (${shortLabel(rel.previousPeriodLabel)}): ${fmtNum(prev, 1)}%`;
  if (yearAgo !== undefined) headline += `; mesmo trimestre de ${Number(rel.period.slice(0, 4)) - 1}: ${fmtNum(yearAgo, 1)}%`;
  return {
    publish: true,
    urgency: "alta",
    headline,
    explainer: null,
    topics: ["emprego", "atividade"],
    reason: "dado oficial com modelo fixo",
    method: "template",
  };
}

/** Deterministic headline for an official numeric release. Numbers never go through the AI. */
export function renderIndicator(rel: IndicatorRelease): Draft | null {
  switch (rel.indicator) {
    case "ipca":
      return priceIndex(rel, "urgente");
    case "ipca15":
      return priceIndex(rel, "alta");
    case "desemprego":
      return unemployment(rel);
    default:
      return null;
  }
}
