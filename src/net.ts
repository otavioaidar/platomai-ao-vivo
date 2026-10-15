import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const UA = "PlatomAI-AoVivo/0.1 (monitor de fontes oficiais)";

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

interface CacheEntry { etag?: string; lastModified?: string; body: string }
const cache = new Map<string, CacheEntry>();

export interface FetchResult { changed: boolean; body: string }

/**
 * GET with timeout and conditional request headers, so frequent polling costs the source almost nothing
 * when nothing changed (304). `changed` is false when the server answered 304 or the body is identical.
 */
export async function fetchConditional(url: string, timeoutMs = 10_000): Promise<FetchResult> {
  const prev = cache.get(url);
  const headers: Record<string, string> = { "user-agent": UA, accept: "*/*" };
  if (prev?.etag) headers["if-none-match"] = prev.etag;
  if (prev?.lastModified) headers["if-modified-since"] = prev.lastModified;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304 && prev) return { changed: false, body: prev.body };
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${new URL(url).host}`);
  const body = await res.text();
  const changed = body !== prev?.body;
  cache.set(url, {
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
    body,
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
