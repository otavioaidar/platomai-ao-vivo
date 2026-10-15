import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Caps on open live streams, so one client cannot hold thousands of sockets. maxPerIp 0 turns that cap off. */
export interface HubLimits {
  maxClients: number;
  maxPerIp: number;
}

export const DEFAULT_HUB_LIMITS: HubLimits = { maxClients: 2000, maxPerIp: 20 };

/** A client this far behind on reading is dropped instead of buffering frames for it; its browser reconnects. */
const MAX_BUFFERED = 64 * 1024;

const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
};

/** Loopback and private ranges: a peer there is our own reverse proxy (or a local client), not a public viewer. */
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("::1", 128, "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");

/**
 * The viewer's address for the per-IP cap. A public peer is the viewer itself. A private peer is the reverse
 * proxy, so we take the last X-Forwarded-For entry (the one the proxy added); null when the proxy sends none.
 */
export function clientIp(req: IncomingMessage): string | null {
  const peer = req.socket.remoteAddress;
  if (!peer) return null;
  if (!PRIVATE.check(peer, net.isIPv6(peer) ? "ipv6" : "ipv4")) return peer;
  const fwd = req.headers["x-forwarded-for"];
  const last = (Array.isArray(fwd) ? fwd.join(",") : (fwd ?? "")).split(",").pop()?.trim();
  return last || null;
}

/** Server-Sent Events fan-out to every open browser tab. */
export class Hub {
  private readonly clients = new Map<ServerResponse, string | null>();
  private readonly perIp = new Map<string, number>();
  private readonly limits: HubLimits;
  private readonly timer: NodeJS.Timeout;

  constructor(pingMs = 20_000, limits: Partial<HubLimits> = {}) {
    this.limits = { ...DEFAULT_HUB_LIMITS, ...limits };
    this.timer = setInterval(() => this.send("ping", {}), pingMs);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Opens a live stream, or answers 503 over a cap. HEAD gets the headers only and is never kept open. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "HEAD") {
      res.writeHead(200, STREAM_HEADERS).end();
      return;
    }
    const ip = clientIp(req);
    if (this.full(ip)) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "30" });
      res.end("Muitas conexões ao vivo agora. Tente de novo em instantes.");
      return;
    }
    res.writeHead(200, { ...STREAM_HEADERS, connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    this.clients.set(res, ip);
    if (ip !== null) this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    res.on("close", () => this.detach(res));
  }

  send(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients.keys()) {
      if (c.writableLength > MAX_BUFFERED) {
        this.detach(c);
        c.destroy();
      } else c.write(frame);
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients.keys()) c.end();
    this.clients.clear();
    this.perIp.clear();
  }

  private full(ip: string | null): boolean {
    const { maxClients, maxPerIp } = this.limits;
    if (this.clients.size >= maxClients) return true;
    return ip !== null && maxPerIp > 0 && (this.perIp.get(ip) ?? 0) >= maxPerIp;
  }

  private detach(res: ServerResponse): void {
    if (!this.clients.has(res)) return;
    const ip = this.clients.get(res) ?? null;
    this.clients.delete(res);
    if (ip === null) return;
    const left = (this.perIp.get(ip) ?? 1) - 1;
    if (left > 0) this.perIp.set(ip, left);
    else this.perIp.delete(ip);
  }
}
