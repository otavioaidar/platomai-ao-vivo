import { XMLParser } from "fast-xml-parser";
import { fetchConditional, fetchText } from "../net.ts";
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

function isoDate(s: string): string {
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Parses RSS 2.0 or Atom into a flat list, newest first as published by the source. */
export function parseFeed(xml: string): FeedEntry[] {
  const doc = parser.parse(xml.replace(/^﻿/, "")) as Record<string, any>;
  if (doc.feed) {
    return (doc.feed.entry ?? []).map((e: any): FeedEntry => {
      const links: any[] = e.link ?? [];
      const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
      return {
        id: textOf(e.id),
        title: decodeEntities(textOf(e.title)).trim(),
        url: cleanUrl(alt?.["@_href"] ?? ""),
        publishedAt: isoDate(textOf(e.updated) || textOf(e.published)),
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
      publishedAt: isoDate(textOf(i.pubDate)),
      html: textOf(i.description),
    };
  });
}

export interface FeedSourceOptions {
  id: string;
  name: string;
  tag: string;
  region: Region;
  url: string;
  lang: "pt" | "en";
  intervalMs: number;
  /** Fetch the linked page for the full text (feeds that carry only a title). */
  fetchArticle?: boolean;
}

export function feedSource(o: FeedSourceOptions): Source {
  return {
    id: o.id,
    name: o.name,
    tag: o.tag,
    region: o.region,
    intervalMs: o.intervalMs,
    async poll() {
      const { changed, body } = await fetchConditional(o.url);
      if (!changed) return [];
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

export function officialFeeds(scale: number): Source[] {
  const bcb = "https://www.bcb.gov.br/api/feed/sitebcb/sitefeeds/";
  return [
    feedSource({ id: "bcb-copom", name: "Copom (comunicados)", tag: "COPOM", region: "BR", url: bcb + "comunicadoscopom", lang: "pt", intervalMs: 15 * S * scale }),
    feedSource({ id: "bcb-atas", name: "Copom (atas)", tag: "COPOM", region: "BR", url: bcb + "atascopom", lang: "pt", intervalMs: 30 * S * scale }),
    feedSource({ id: "bcb-notas", name: "Banco Central (notas)", tag: "BCB", region: "BR", url: bcb + "notasImprensa", lang: "pt", intervalMs: 20 * S * scale }),
    feedSource({ id: "fed-monetary", name: "Fed (política monetária)", tag: "FED", region: "INTL", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", lang: "en", intervalMs: 20 * S * scale, fetchArticle: true }),
    feedSource({ id: "fed-speeches", name: "Fed (discursos)", tag: "FED", region: "INTL", url: "https://www.federalreserve.gov/feeds/speeches.xml", lang: "en", intervalMs: 60 * S * scale, fetchArticle: true }),
    feedSource({ id: "ecb-press", name: "BCE (imprensa)", tag: "BCE", region: "INTL", url: "https://www.ecb.europa.eu/rss/press.html", lang: "en", intervalMs: 30 * S * scale, fetchArticle: true }),
  ];
}
