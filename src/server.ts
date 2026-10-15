import fs from "node:fs";
import http from "node:http";
import path from "node:path";
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

function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function rss(deps: ServerDeps): string {
  const items = deps.store
    .latest(50)
    .map((h) => {
      const desc = h.explainer ? `PlatomAI explica: ${h.explainer}` : h.headline;
      return `<item><title>${escapeHtml(`${h.tag}: ${h.headline}`)}</title><link>${escapeHtml(`${deps.siteUrl}/#${h.id}`)}</link><guid isPermaLink="false">${escapeHtml(h.id)}</guid><pubDate>${new Date(h.publishedAt).toUTCString()}</pubDate><description>${escapeHtml(desc)}</description><source url="${escapeHtml(h.url)}">${escapeHtml(h.sourceName)}</source></item>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>PlatomAI Ao Vivo</title><link>${escapeHtml(deps.siteUrl)}</link><description>Notícias rápidas do mercado a partir de fontes oficiais.</description><language>pt-BR</language>${items}</channel></rss>`;
}

function serveStatic(deps: ServerDeps, urlPath: string, res: http.ServerResponse) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
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

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    switch (url.pathname) {
      case "/api/headlines": {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 150) || 150));
        return json(res, { items: deps.store.latest(limit, deps.showReview) });
      }
      case "/api/stream":
        return deps.hub.attach(res);
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
      case "/rss.xml":
        res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "max-age=15" });
        return res.end(rss(deps));
      case "/healthz":
        return json(res, { ok: true });
      default:
        return serveStatic(deps, url.pathname, res);
    }
  });
}
