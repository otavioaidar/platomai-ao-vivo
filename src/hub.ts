import type { ServerResponse } from "node:http";

/** Server-Sent Events fan-out to every open browser tab. */
export class Hub {
  private readonly clients = new Set<ServerResponse>();
  private readonly timer: NodeJS.Timeout;

  constructor(pingMs = 20_000) {
    this.timer = setInterval(() => this.send("ping", {}), pingMs);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  send(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}
