import { XMLParser } from "fast-xml-parser";
import { fetchConditional, fetchText, pollEvery } from "../net.ts";
import { decodeEntities, extractArticle, htmlToText } from "../text.ts";
import type { RawItem, Region, Source } from "../types.ts";

export interface FeedEntry {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  html: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => name === "entry" || name === "item" || name === "link",
});

function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)["#text"]);
  }
  return "";
}

function cleanUrl(u: string): string {
  return u.trim().replace(/^http:\/\//, "https://").replace(/([^:]\/)\/+/g, "$1");
}

const DAY = 24 * 3600 * 1000;

/** True when a feed date carries no real time: date only, 00:00:00 as written, or exactly 00:00:00 UTC. */
function isDateOnly(s: string, t: number): boolean {
  const m = s.match(/(?:^|[\sT])(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return true;
  return (Number(m[1]) === 0 && Number(m[2]) === 0 && Number(m[3] ?? 0) === 0) || t % DAY === 0;
}

/**
 * Source date as ISO. Some feeds (e.g. the ECB) stamp items with a midnight placeholder; when that placeholder
 * is less than a day old, the detection time is closer to the truth and keeps a new item from looking stale.
 * Older placeholders keep their own day, so yesterday's item is still history.
 */
function isoDate(s: string, now: Date): string {
  const t = new Date(s.trim()).getTime();
  if (Number.isNaN(t)) return now.toISOString();
  const age = now.getTime() - t;
  if (isDateOnly(s, t) && age >= 0 && age < DAY) return now.toISOString();
  return new Date(t).toISOString();
}

/** Parses RSS 2.0 or Atom into a flat list, newest first as published by the source. */
export function parseFeed(xml: string, now = new Date()): FeedEntry[] {
  const doc = parser.parse(xml.replace(/^﻿/, "")) as Record<string, any>;
  if (doc.feed) {
    return (doc.feed.entry ?? []).map((e: any): FeedEntry => {
      const links: any[] = e.link ?? [];
      const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
      return {
        id: textOf(e.id),
        title: decodeEntities(textOf(e.title)).trim(),
        url: cleanUrl(alt?.["@_href"] ?? ""),
        publishedAt: isoDate(textOf(e.updated) || textOf(e.published), now),
        html: textOf(e.content) || textOf(e.summary),
      };
    });
  }
  const items: any[] = doc.rss?.channel?.item ?? [];
  return items.map((i): FeedEntry => {
    const link = textOf(Array.isArray(i.link) ? i.link[0] : i.link);
    return {
      id: textOf(i.guid) || link,
      title: decodeEntities(textOf(i.title)).trim(),
      url: cleanUrl(link),
      publishedAt: isoDate(textOf(i.pubDate), now),
      html: textOf(i.description),
    };
  });
}

/** Feed body from its first item on: the header (feed <updated>, lastBuildDate) can change on every request. */
export function feedEntries(xml: string): string {
  const i = xml.search(/<(entry|item)[\s>]/);
  return i < 0 ? xml : xml.slice(i);
}

// ---------------------------------------------------------------------------------------------
// Weekly windows in Brasília time, for sources that publish on a known weekday and hour.

/** A weekly window in Brasília time with its own polling interval. */
export interface PollWindow {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** "HH:MM", Brasília time. */
  from: string;
  to: string;
  everyMs: number;
}

const BRT_MS = -3 * 3600 * 1000; // Brazil has had no daylight saving time since 2019

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Every [start, end) in epoch ms of the windows from the Brasília day of `now` up to a week ahead. */
function windowTimes(windows: PollWindow[], now: Date): { start: number; end: number; w: PollWindow }[] {
  const today = Math.floor((now.getTime() + BRT_MS) / DAY) * DAY; // Brasília midnight, on the UTC clock
  const out: { start: number; end: number; w: PollWindow }[] = [];
  for (let d = 0; d <= 7; d++) {
    const day = today + d * DAY;
    for (const w of windows) {
      if (new Date(day).getUTCDay() !== w.weekday) continue;
      out.push({ start: day + minutes(w.from) * 60_000 - BRT_MS, end: day + minutes(w.to) * 60_000 - BRT_MS, w });
    }
  }
  return out;
}

/** Polling interval of the window that contains `now`, or null outside every window. */
export function windowInterval(windows: PollWindow[], now: Date): number | null {
  const t = now.getTime();
  return windowTimes(windows, now).find((x) => t >= x.start && t < x.end)?.w.everyMs ?? null;
}

/** Start (epoch ms) of the next window after `now`, or null when there is none. */
export function nextWindowStart(windows: PollWindow[], now: Date): number | null {
  const starts = windowTimes(windows, now).map((x) => x.start).filter((s) => s > now.getTime());
  return starts.length ? Math.min(...starts) : null;
}

export interface FeedSourceOptions {
  id: string;
  name: string;
  tag: string;
  region: Region;
  url: string;
  lang: "pt" | "en";
  intervalMs: number;
  /** Faster polling inside these weekly windows (cadences already scaled). */
  windows?: PollWindow[];
  /** Fetch the linked page for the full text (feeds that carry only a title). */
  fetchArticle?: boolean;
}

/** How often an unchanged feed's entries are handed to the pipeline again (it skips the ones already seen). */
const RESEND_MS = 5 * 60 * 1000;

export function feedSource(o: FeedSourceOptions): Source {
  const windows = o.windows ?? [];
  let lastFullAt = 0;
  return {
    id: o.id,
    name: o.name,
    tag: o.tag,
    region: o.region,
    intervalMs: o.intervalMs,
    hotIntervalMs: (now) => windowInterval(windows, now),
    nextHotAt: (now) => nextWindowStart(windows, now),
    async poll() {
      const { changed, body } = await fetchConditional(o.url, 10_000, feedEntries);
      // An unchanged feed is skipped, but every few minutes its entries are handed over again: if the pipeline
      // failed to record them the first time (e.g. a locked database), they are not lost until the feed changes.
      const now = Date.now();
      if (!changed && now - lastFullAt < RESEND_MS) return [];
      lastFullAt = now;
      return parseFeed(body).map(
        (e): RawItem => ({
          sourceId: o.id,
          externalId: e.id,
          url: e.url,
          title: e.title,
          body: htmlToText(e.html),
          publishedAt: e.publishedAt,
          lang: o.lang,
        }),
      );
    },
    async enrich(item) {
      if (!o.fetchArticle || !item.url) return item;
      try {
        const page = await fetchText(item.url, 8_000);
        const text = extractArticle(page);
        return text.length > item.body.length ? { ...item, body: text } : item;
      } catch {
        return item; // the title alone still makes a headline
      }
    },
  };
}

const S = 1000;
const MIN = 60 * S;

/**
 * When the Copom publishes, in Brasília time. The BCB feeds answer every request with a full download,
 * so they are polled fast only inside these windows. Edit here when the schedule changes.
 */
export const COPOM_WINDOWS: Record<"comunicados" | "atas", PollWindow[]> = {
  // Statement: Wednesday evening, at the end of the meeting.
  comunicados: [{ weekday: 3, from: "18:00", to: "19:30", everyMs: 3 * S }],
  // Minutes: the Tuesday morning after the meeting.
  atas: [{ weekday: 2, from: "07:55", to: "08:30", everyMs: 5 * S }],
};

export function officialFeeds(scale: number): Source[] {
  const bcb = "https://www.bcb.gov.br/api/feed/sitebcb/sitefeeds/";
  const every = (ms: number) => pollEvery(ms, scale);
  const hot = (ws: PollWindow[]) => ws.map((w) => ({ ...w, everyMs: every(w.everyMs) }));
  return [
    feedSource({ id: "bcb-copom", name: "Copom (comunicados)", tag: "COPOM", region: "BR", url: bcb + "comunicadoscopom", lang: "pt", intervalMs: every(5 * MIN), windows: hot(COPOM_WINDOWS.comunicados) }),
    feedSource({ id: "bcb-atas", name: "Copom (atas)", tag: "COPOM", region: "BR", url: bcb + "atascopom", lang: "pt", intervalMs: every(10 * MIN), windows: hot(COPOM_WINDOWS.atas) }),
    feedSource({ id: "bcb-notas", name: "Banco Central (notas)", tag: "BCB", region: "BR", url: bcb + "notasImprensa", lang: "pt", intervalMs: every(30 * S) }),
    feedSource({ id: "fed-monetary", name: "Fed (política monetária)", tag: "FED", region: "INTL", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", lang: "en", intervalMs: every(20 * S), fetchArticle: true }),
    feedSource({ id: "fed-speeches", name: "Fed (discursos)", tag: "FED", region: "INTL", url: "https://www.federalreserve.gov/feeds/speeches.xml", lang: "en", intervalMs: every(60 * S), fetchArticle: true }),
    feedSource({ id: "ecb-press", name: "BCE (imprensa)", tag: "BCE", region: "INTL", url: "https://www.ecb.europa.eu/rss/press.html", lang: "en", intervalMs: every(30 * S), fetchArticle: true }),
  ];
}
