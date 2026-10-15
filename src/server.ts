import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { log } from "./log.ts";
import { escapeHtml } from "./text.ts";
import type { Store } from "./db.ts";
import type { Hub } from "./hub.ts";
import type { Agenda } from "./sources/ibge.ts";
import type { SourceStatus } from "./types.ts";

export interface ServerDeps {
  store: Store;
  hub: Hub;
  agenda: Agenda;
  publicDir: string;
  siteUrl: string;
  showReview: boolean;
  ai: { enabled: boolean; model: string };
  statuses: () => SourceStatus[];
  /** Bearer token for the private review queue (/api/revisao). Empty: the queue is not served at all. */
  reviewToken?: string;
}

/** Constant-time check of "Authorization: Bearer <token>" (both sides hashed, so lengths never leak). */
export function bearerOk(header: string | undefined, token: string): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header.slice(7).trim()), digest(token));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/** The page loads only its own files, the Google Fonts stylesheet and fonts, and a data: favicon. No inline code. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Sent on every response. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

/** Characters XML 1.0 forbids even when escaped: C0 controls other than tab/LF/CR, lone surrogates, U+FFFE/FFFF. */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/gu;

/** Text safe inside an XML element or a double-quoted attribute. */
export function xmlText(s: string): string {
  return escapeHtml(s.replace(XML_INVALID, ""));
}

/** The address as an absolute http(s) URL, or null (javascript:, data:, relative, malformed). */
export function webUrl(s: string): string | null {
  const u = URL.parse(s);
  return u && (u.protocol === "https:" || u.protocol === "http:") ? u.href : null;
}

function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function badRequest(res: http.ServerResponse) {
  res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Endereço inválido");
}

function rss(deps: ServerDeps): string {
  const items = deps.store
    .latest(50)
    .map((h) => {
      const desc = h.explainer ? `PlatomAI explica: ${h.explainer}` : h.headline;
      const url = webUrl(h.url);
      const source = url ? `<source url="${xmlText(url)}">${xmlText(h.sourceName)}</source>` : "";
      return `<item><title>${xmlText(`${h.tag}: ${h.headline}`)}</title><link>${xmlText(`${deps.siteUrl}/#${h.id}`)}</link><guid isPermaLink="false">${xmlText(h.id)}</guid><pubDate>${new Date(h.publishedAt).toUTCString()}</pubDate><description>${xmlText(desc)}</description>${source}</item>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>PlatomAI Ao Vivo</title><link>${xmlText(deps.siteUrl)}</link><description>Notícias rápidas do mercado a partir de fontes oficiais.</description><language>pt-BR</language>${items}</channel></rss>`;
}

function serveStatic(deps: ServerDeps, urlPath: string, res: http.ServerResponse) {
  let rel: string;
  try {
    rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  } catch {
    return badRequest(res); // malformed %-escape
  }
  if (rel.includes("\0")) return badRequest(res); // fs throws on NUL bytes
  const file = path.resolve(deps.publicDir, rel);
  if (!file.startsWith(path.resolve(deps.publicDir) + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Não encontrado");
      return;
    }
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": rel === "index.html" ? "no-cache" : "public, max-age=300" });
    res.end(buf);
  });
}

function route(deps: ServerDeps, req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const url = URL.parse(req.url ?? "/", "http://localhost");
  if (!url) return badRequest(res);
  switch (url.pathname) {
    case "/api/headlines": {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 150) || 150));
      return json(res, { items: deps.store.latest(limit, deps.showReview) });
    }
    case "/api/stream":
      return deps.hub.attach(req, res);
    case "/api/agenda":
      return json(res, { items: deps.agenda.upcoming() });
    case "/api/status":
      return json(res, {
        ai: deps.ai,
        listeners: deps.hub.size,
        sources: [
          ...deps.statuses(),
          { id: "ibge-agenda", name: "IBGE (agenda)", lastOkAt: deps.agenda.lastOkAt, lastError: deps.agenda.lastError },
        ],
      });
    case "/rss.xml": {
      const body = rss(deps); // built first, so a failure still becomes a 500
      res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "max-age=15" });
      return res.end(body);
    }
    case "/healthz":
      return json(res, { ok: true });
    case "/revisao":
      return serveStatic(deps, "/revisao.html", res);
    case "/api/revisao": {
      if (!deps.reviewToken) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Não encontrado");
        return;
      }
      if (!bearerOk(req.headers.authorization, deps.reviewToken)) {
        res.writeHead(401, { "www-authenticate": "Bearer", "cache-control": "no-store" }).end();
        return;
      }
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
      return json(res, { items: deps.store.reviewQueue(limit) });
    }
    default:
      return serveStatic(deps, url.pathname, res);
  }
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      route(deps, req, res);
    } catch (err) {
      // Last resort: one bad request must never take down the site, the live stream and the polling.
      log.error(`falha ao responder ${req.method} ${JSON.stringify((req.url ?? "").slice(0, 200))}`, err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end();
    }
  });
}
