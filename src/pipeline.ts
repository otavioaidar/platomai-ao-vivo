import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log.ts";
import { meetsUrgency } from "./publishers/index.ts";
import { unsupportedNumbers } from "./writer/guard.ts";
import { renderIndicator } from "./writer/templates.ts";
import type { Store } from "./db.ts";
import type { Hub } from "./hub.ts";
import type { Publisher } from "./publishers/index.ts";
import type { Writer } from "./writer/ai.ts";
import type { Draft, Headline, RawItem, Source, SourceStatus, Status, Urgency } from "./types.ts";

export interface PipelineOptions {
  store: Store;
  writer: Writer;
  hub: Hub;
  publishers: Publisher[];
  minUrgency: Urgency;
  backfillPerSource: number;
  showReview: boolean;
  aiConcurrency: number;
}

/** Items older than this when first seen are shown on the site but never pushed to social networks. */
const STALE_MS = 6 * 3600 * 1000;
const MAX_ATTEMPTS = 3;

export function rawKey(item: RawItem): string {
  return `${item.sourceId}:${item.externalId}`;
}

export function headlineId(item: RawItem): string {
  return `${item.sourceId}-${createHash("sha1").update(item.externalId).digest("hex").slice(0, 10)}`;
}

/** Runs async jobs with at most `n` in flight (keeps AI calls within rate limits). */
class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly n: number;

  constructor(n: number) {
    this.n = Math.max(1, n);
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class Pipeline {
  private readonly o: PipelineOptions;
  private readonly status = new Map<string, SourceStatus>();
  private readonly retries = new Map<string, { item: RawItem; attempts: number; backfill: boolean }>();
  private readonly ai: Limiter;
  private readonly abort = new AbortController();

  constructor(o: PipelineOptions) {
    this.o = o;
    this.ai = new Limiter(o.aiConcurrency);
  }

  statuses(): SourceStatus[] {
    return [...this.status.values()];
  }

  /** Polls one source once and turns every new item into a headline. Returns what was written. */
  async runOnce(src: Source): Promise<Headline[]> {
    const detectedAt = Date.now();
    const st = this.status.get(src.id) ?? { id: src.id, name: src.name, lastOkAt: null, lastError: null };
    this.status.set(src.id, st);
    let items: RawItem[];
    try {
      items = await src.poll();
      st.lastOkAt = new Date().toISOString();
      st.lastError = null;
    } catch (err) {
      st.lastError = (err as Error).message;
      log.warn(`fonte ${src.id} falhou`, err);
      return [];
    }

    const fresh = items
      .filter((i) => !this.o.store.isSeen(rawKey(i)))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    const bootstrap = fresh.length > 0 && !this.o.store.hasSeenAny(src.id);
    let todo = fresh;
    if (bootstrap) {
      // First contact with a source: show only its latest few items, as history, and skip old numeric releases.
      todo = fresh.filter((i) => !i.data).slice(-this.o.backfillPerSource);
    }
    for (const i of fresh) this.o.store.markSeen(rawKey(i), src.id);

    const jobs = todo.map((item) => ({ item, attempts: 0, backfill: bootstrap || detectedAt - Date.parse(item.publishedAt) > STALE_MS }));
    for (const [key, r] of this.retries) {
      if (key.startsWith(`${src.id}:`)) jobs.push({ item: r.item, attempts: r.attempts, backfill: r.backfill });
    }

    const out: Headline[] = [];
    await Promise.all(
      jobs.map(async (job) => {
        const key = rawKey(job.item);
        try {
          const h = await this.process(src, job.item, job.backfill, detectedAt);
          this.retries.delete(key);
          if (h) out.push(h);
        } catch (err) {
          const attempts = job.attempts + 1;
          log.error(`falha ao escrever ${key} (tentativa ${attempts})`, err);
          if (attempts < MAX_ATTEMPTS) this.retries.set(key, { item: job.item, attempts, backfill: job.backfill });
          else this.retries.delete(key);
        }
      }),
    );
    return out;
  }

  private async process(src: Source, raw: RawItem, backfill: boolean, detectedAt: number): Promise<Headline | null> {
    const item = src.enrich ? await src.enrich(raw) : raw;
    let draft: Draft | null;
    if (item.data) {
      draft = renderIndicator(item.data);
    } else {
      const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      const recent = this.o.store.recentByTag(src.tag, since);
      draft = await this.ai.run(() => this.o.writer.write(item, { source: src, recent }));
    }
    if (!draft) return null;
    if (!draft.publish) {
      log.info(`descartado ${src.id}: ${item.title}`, { motivo: draft.reason });
      return null;
    }

    let status: Status = "publicado";
    let reviewReason: string | undefined;
    if (draft.method === "ia") {
      const sourceText = `${item.title}\n${item.body}`;
      const bad = unsupportedNumbers(draft.headline, sourceText);
      if (!draft.headline) {
        status = "revisar";
        reviewReason = "manchete vazia";
      } else if (bad.length) {
        status = "revisar";
        reviewReason = `números sem respaldo na fonte: ${bad.join(", ")}`;
      }
      if (draft.explainer && unsupportedNumbers(draft.explainer, sourceText).length) draft.explainer = null;
    }

    const now = Date.now();
    const h: Headline = {
      id: headlineId(item),
      publishedAt: backfill ? item.publishedAt : new Date(now).toISOString(),
      sourcePublishedAt: item.publishedAt,
      detectedAt: new Date(detectedAt).toISOString(),
      sourceId: src.id,
      sourceName: src.name,
      tag: src.tag,
      region: src.region,
      urgency: draft.urgency,
      headline: draft.headline,
      explainer: draft.explainer,
      topics: draft.topics,
      url: item.url,
      method: draft.method,
      status,
      backfill,
      latencyMs: now - detectedAt,
      ...(reviewReason ? { reviewReason } : {}),
    };
    this.o.store.save(h);
    if (status === "publicado" || this.o.showReview) this.o.hub.send("headline", h);
    log.info(`${status} [${h.tag}] ${h.headline}`, { ms: h.latencyMs, metodo: h.method, ...(reviewReason ? { reviewReason } : {}) });

    if (!backfill && status === "publicado" && h.method !== "rascunho" && meetsUrgency(h, this.o.minUrgency)) {
      for (const p of this.o.publishers) {
        p.publish(h).catch((err) => log.error(`envio ${p.name} falhou`, err));
      }
    }

    if (h.method === "template" && this.o.writer.enabled && item.data) {
      const data = item.data;
      this.ai
        .run(() => this.o.writer.explain(h, item))
        .then((text) => {
          if (!text || unsupportedNumbers(text, `${JSON.stringify(data)} ${h.headline}`).length) return;
          const updated = { ...h, explainer: text };
          this.o.store.save(updated);
          this.o.hub.send("update", updated);
        })
        .catch((err) => log.warn(`explicação de ${h.id} falhou`, err));
    }
    return h;
  }

  /** Starts one polling loop per source. Each loop waits for its poll to finish before sleeping. */
  start(sources: Source[]): void {
    for (const src of sources) {
      void (async () => {
        await sleep(Math.random() * 2000, undefined, { signal: this.abort.signal }).catch(() => {});
        while (!this.abort.signal.aborted) {
          await this.runOnce(src);
          const base = src.hotIntervalMs?.(new Date()) ?? src.intervalMs;
          const delay = base * (0.9 + Math.random() * 0.2);
          await sleep(delay, undefined, { signal: this.abort.signal }).catch(() => {});
        }
      })();
    }
  }

  stop(): void {
    this.abort.abort();
  }
}
