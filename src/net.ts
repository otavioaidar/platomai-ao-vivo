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

/**
 * A response body as text in the charset it declares: the Content-Type header first, then an XML declaration
 * (Folha's feeds are ISO-8859-1 and say so only in <?xml … encoding?>). Anything else is read as UTF-8.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const declared =
    contentType?.match(/charset="?([\w-]+)/i)?.[1] ??
    new TextDecoder("latin1").decode(bytes.subarray(0, 200)).match(/^\s*<\?xml[^>]*encoding=["']([\w-]+)["']/i)?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // a charset name TextDecoder does not know
  }
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
  const body = decodeBody(new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type"));
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

/** `headers` carries credentials that must stay out of the URL (e.g. a Bearer token), so errors never leak them. */
export async function fetchJson<T>(url: string, timeoutMs = 10_000, headers: Record<string, string> = {}): Promise<T> {
  // fetch would reject such a value with an error that quotes it: fail with a message that does not.
  if (Object.values(headers).some((v) => /[\r\n\0]/.test(v))) throw new Error(`cabeçalho de credencial inválido para ${new URL(url).host}`);
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${new URL(url).host}`);
  return (await res.json()) as T;
}

/** POST of a JSON body that answers JSON (e.g. an ASP.NET page method). */
export async function postJson<T>(url: string, body: unknown, timeoutMs = 15_000, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "user-agent": UA, accept: "application/json", "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${new URL(url).host}`);
  return (await res.json()) as T;
}
