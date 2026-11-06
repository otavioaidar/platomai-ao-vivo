// The latest headlines as plain HTML inside the page, so search engines and readers without JavaScript see them,
// with real links to each story: the press titles link to the outlet's own page (SEO and traffic for whoever wrote
// it). The markup mirrors public/app.js, which takes over once the live list loads.
import { escapeHtml } from "./text.ts";
import { publicHeadline } from "./view.ts";
import type { Headline } from "./types.ts";

const TZ = "America/Sao_Paulo";
const hms = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const weekday = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "short" });

/** Text safe in an element or a double-quoted attribute. */
const t = (s: string) => escapeHtml(s);

/** An absolute http(s) address, or null (javascript:, data:, relative, malformed). */
function link(s: string): string | null {
  const u = URL.parse(s);
  return u && (u.protocol === "https:" || u.protocol === "http:") ? u.href : null;
}

function dayLabel(key: string, today: string, yesterday: string, at: Date): { main: string; sub: string } {
  const [, m, d] = key.split("-");
  const ddmm = `${d}/${m}`;
  if (key === today) return { main: "Hoje", sub: ddmm };
  if (key === yesterday) return { main: "Ontem", sub: ddmm };
  return { main: ddmm, sub: weekday.format(at).replace(".", "") };
}

/** "PlatomAI decifra" card, closed, as app.js builds it. */
function decifraHtml(h: Headline): string {
  const d = h.decifra;
  if (!d) return "";
  const sec = (title: string, body: string) => `<section class="dec-sec"><h3 class="dec-h">${t(title)}</h3>${body}</section>`;
  const last = d.analysis.length - 1;
  const analysis = d.analysis.map((p, i) => `<p${i === last && last > 0 ? ' class="dec-image"' : ""}>${t(p)}</p>`).join("");
  const impact = d.impact.map((i) => `<li><strong>${t(i.label)}:</strong> ${t(i.text)}</li>`).join("");
  return (
    `<details class="t-dec"><summary class="dec-sum"><span class="dec-lbl">PlatomAI decifra</span> <span class="dec-title">${t(d.title)}</span></summary>` +
    `<div class="dec-body">` +
    (d.subtitle ? `<p class="dec-sub">${t(d.subtitle)}</p>` : "") +
    (d.date ? `<p class="dec-date">${t(d.date)}</p>` : "") +
    (d.summary ? sec("Resumo", `<p>${t(d.summary)}</p>`) : "") +
    sec("PlatomAI decifra", analysis) +
    (impact ? sec("Impacto nos mercados", `<ul class="dec-list">${impact}</ul>`) : "") +
    (d.keyMessage ? sec("Mensagem-chave", `<p>${t(d.keyMessage)}</p>`) : "") +
    `<p class="dec-sign">Platom.AI — Inteligência Financeira em Linguagem Clara</p>` +
    `<p class="dec-note">Análise de mercado com base no documento oficial. Não é recomendação de investimento.</p>` +
    `</div></details>`
  );
}

function rowHtml(raw: Headline): string {
  const h = publicHeadline(raw);
  const url = link(h.url);
  const press = h.method === "titulo";
  const review = h.status === "revisar";
  const urgency = !review && (h.urgency === "urgente" || h.urgency === "alta") ? h.urgency : "normal";
  const at = new Date(h.publishedAt);
  const region = h.region === "INTL" ? "Internacional" : h.region === "BR" ? "Brasil" : "";
  const tagTitle = [h.sourceName, region].filter(Boolean).join(" · ");
  const lang = h.lang === "en" ? ' lang="en"' : "";

  let text = "";
  if (urgency === "urgente") text += '<span class="flag flag-urgente">URGENTE</span> ';
  else if (urgency === "alta") text += '<span class="flag flag-alta">ALTA</span> ';
  // A press title is the outlet's: it links straight to their story.
  text += press && url
    ? `<a class="t-head t-link" href="${t(url)}" target="_blank" rel="noopener"${lang}>${t(h.headline)}</a>`
    : `<span class="t-head"${lang}>${t(h.headline)}</span>`;
  if (press && h.sourceName) text += ` <span class="t-credit">— ${t(h.sourceName)}</span>`;
  if (review) text += ' <span class="badge">em revisão</span>';
  if (h.method === "rascunho" && !review) text += ' <span class="badge">rascunho (IA desligada)</span>';

  const label = press ? `Ler no ${h.sourceName || "veículo"} (abre em nova aba)` : h.sourceName ? `Fonte: ${h.sourceName} (abre em nova aba)` : "Fonte (abre em nova aba)";
  const src = url
    ? `<a class="t-src" href="${t(url)}" target="_blank" rel="noopener" aria-label="${t(label)}">${press ? "ler" : "fonte"}<span aria-hidden="true"> ↗</span></a>`
    : "";
  // Where there is a PlatomAI decifra, it takes the place of the one-line explainer.
  const expl = h.explainer && !h.decifra ? `<p class="t-expl"><span class="t-expl-lbl">PlatomAI explica:</span> ${t(h.explainer)}</p>` : "";
  return (
    `<li class="row u-${urgency}" data-id="${t(h.id)}">` +
    `<time class="t-time" datetime="${t(at.toISOString())}">${hms.format(at)}</time>` +
    `<span class="t-tag${h.region === "INTL" ? " r-intl" : ""}"${tagTitle ? ` title="${t(tagTitle)}"` : ""}>${t(h.tag || h.sourceName || "Fonte")}</span>` +
    `<p class="t-text">${text}</p>${src}${expl}${decifraHtml(h)}</li>`
  );
}

/** The headlines (newest first) grouped by day in Brasília time, as the live page shows them. */
export function feedHtml(headlines: Headline[], now = new Date()): string {
  const today = ymd.format(now);
  const yesterday = ymd.format(new Date(now.getTime() - 86_400_000));
  const days = new Map<string, Headline[]>();
  for (const h of headlines) {
    const at = new Date(h.publishedAt);
    if (Number.isNaN(at.getTime()) || !h.headline) continue;
    const key = ymd.format(at);
    days.set(key, [...(days.get(key) ?? []), h]);
  }
  return [...days]
    .map(([key, rows]) => {
      const label = dayLabel(key, today, yesterday, new Date(rows[0].publishedAt));
      const id = `dia-ssr-${key}`;
      return (
        `<section class="day"><h2 class="day-head" id="${id}"><span class="day-main">${label.main}</span> <span class="day-sub">${label.sub}</span></h2>` +
        `<ol class="rows" aria-labelledby="${id}">${rows.map(rowHtml).join("")}</ol></section>`
      );
    })
    .join("");
}
