import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { config } from "./config.ts";

/** Identifies us to the source operators, with the public site as a contact when there is one. */
export function userAgent(siteUrl: string): string {
  const local = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(siteUrl);
  return `PlatomAI-AoVivo/0.1 (monitor de fontes oficiais${local ? "" : `; +${siteUrl}`})`;
}

const UA = userAgent(config.siteUrl);

/** A polling cadence scaled by POLL_SCALE, never below 1 s so a small scale cannot hammer a source. */
export function pollEvery(ms: number, scale: number): number {
  return Math.max(1000, ms * scale);
}

/**
 * Some official servers (e.g. servicodados.ibge.gov.br) do not send their intermediate certificate.
 * Browsers fetch it on their own; Node does not, so we ship the missing intermediates in certs/ and
 * add them to the trusted set. Verification stays on: each intermediate still has to chain to a root.
 */
export function installExtraCAs(dir = "certs"): number {
  if (!fs.existsSync(dir)) return 0;
  const pems = fs.readdirSync(dir).filter((f) => f.endsWith(".pem")).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
  if (pems.length) tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...pems]);
  return pems.length;
}

interface CacheEntry { etag?: string; lastModified?: string; body: string; key: string }
const cache = new Map<string, CacheEntry>();

export interface FetchResult { changed: boolean; body: string }

/**
 * GET with timeout and conditional request headers. Fed and ECB answer 304 when nothing changed, so polling
 * them costs almost nothing. The BCB feeds do not: every response has a new random ETag and a new feed-level
 * <updated>, so each poll is a full download (feeds.ts polls them fast only inside the Copom windows).
 * `changed` is false on a 304 or when `fingerprint(body)` is the same as last time (default: the whole body).
 */
export async function fetchConditional(
  url: string,
  timeoutMs = 10_000,
  fingerprint: (body: string) => string = (b) => b,
): Promise<FetchResult> {
  const prev = cache.get(url);
  const headers: Record<string, string> = { "user-agent": UA, accept: "*/*" };
  if (prev?.etag) headers["if-none-match"] = prev.etag;
  if (prev?.lastModified) headers["if-modified-since"] = prev.lastModified;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304 && prev) return { changed: false, body: prev.body };
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${new URL(url).host}`);
  const body = await res.text();
  const key = fingerprint(body);
  const changed = key !== prev?.key;
  cache.set(url, {
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
    body,
    key,
  });
  return { changed, body };
}

export async function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${new URL(url).host}`);
  return res.text();
}

export async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${new URL(url).host}`);
  return (await res.json()) as T;
}
