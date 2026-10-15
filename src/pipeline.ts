import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { errorText, log } from "./log.ts";
import { meetsUrgency } from "./publishers/index.ts";
import { fmtNum } from "./text.ts";
import { unsupportedNumbers } from "./writer/guard.ts";
import { renderIndicator } from "./writer/templates.ts";
import type { PendingJob, Store } from "./db.ts";
import type { Hub } from "./hub.ts";
import type { Publisher } from "./publishers/index.ts";
import type { Writer, WriterDraft } from "./writer/ai.ts";
import type { Draft, Headline, IndicatorRelease, RawItem, Source, SourceStatus, Status, Urgency } from "./types.ts";

export interface PipelineOptions {
  store: Store;
  writer: Writer;
  hub: Hub;
  publishers: Publisher[];
  minUrgency: Urgency;
  backfillPerSource: number;
  showReview: boolean;
  aiConcurrency: number;
  /** Clock in epoch ms; tests pass a fake one. */
  now?: () => number;
}

/** Items older than this when first seen are shown on the site but never pushed to social networks. */
const STALE_MS = 6 * 3600 * 1000;
/** A failed write is retried 15 s, 30 s, 1 min… later (at most 30 min apart) for 6 h, then goes to review. */
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 30 * 60_000;
const GIVE_UP_MS = 6 * 3600 * 1000;

export function rawKey(item: RawItem): string {
  return `${item.sourceId}:${item.externalId}`;
}

export function headlineId(item: RawItem): string {
  return `${item.sourceId}-${createHash("sha1").update(item.externalId).digest("hex").slice(0, 10)}`;
}

/** Wait before the next attempt after `attempts` failures: 15 s, 30 s, 1 min… capped at 30 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** Sleep before a source's next poll: its interval (hot or normal) ±10%, cut short so it wakes when the next hot window opens. */
export function nextDelayMs(src: Source, now: Date, jitter = Math.random()): number {
  const base = src.hotIntervalMs?.(now) ?? src.intervalMs;
  const delay = base * (0.9 + jitter * 0.2);
  const hotAt = src.nextHotAt?.(now) ?? null;
  const t = now.getTime();
  return hotAt !== null && hotAt > t ? Math.min(delay, hotAt - t) : delay;
}

/** pt-BR number keeping the decimals the value has: 0.44 -> "0,44", 13.75 -> "13,75", 6 -> "6". */
function ptNumber(v: number): string {
  return fmtNum(v, Math.min(4, (String(v).split(".")[1] ?? "").length));
}

/** A numeric release as Portuguese text (comma decimals): what a template headline's explainer is checked against. */
export function releaseText(headline: string, rel: IndicatorRelease): string {
  const nums = [...Object.values(rel.values), ...Object.values(rel.previous)];
  if (rel.consensus !== null) nums.push(rel.consensus);
  // Every value of the releases we cover is a percentage; the unit lets the guard accept integers like "5%".
  return [headline, rel.label, rel.periodLabel, rel.previousPeriodLabel ?? "", ...nums.map((v) => `${ptNumber(v)}%`)].join("\n");
}

/**
 * Runs `task` now and keeps running it in the background: every `retryMs` until it first succeeds
 * (returns true), then every `okMs`. Never blocks the caller. Returns a function that stops it.
 */
export function keepRefreshed(task: () => Promise<boolean>, okMs: number, retryMs: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let everOk = false;
  const tick = async () => {
    try {
      everOk = (await task()) || everOk;
    } catch (err) {
      log.warn("atualização em segundo plano falhou", err);
    }
    if (!stopped) timer = setTimeout(() => void tick(), everOk ? okMs : retryMs);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Runs async jobs with at most `n` in flight (keeps AI calls within rate limits). */
class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly n: number;

  constructor(n: number) {
    this.n = Number.isFinite(n) ? Math.max(1, n) : 1;
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
  private readonly now: () => number;
  private readonly status = new Map<string, SourceStatus>();
  private readonly ai: Limiter;
  private readonly abort = new AbortController();
  /** Polling loops started by start(). */
  private readonly loops: Promise<void>[] = [];
  /** Writes, social posts and explainers still running; shutdown waits for them. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** Queue keys being written right now, so an overlapping run never writes the same item twice. */
  private readonly busy = new Set<string>();

  constructor(o: PipelineOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.ai = new Limiter(o.aiConcurrency);
  }

  statuses(): SourceStatus[] {
    return [...this.status.values()];
  }

  /** Polls one source once, then writes every queued item that is due (new ones and retries). Returns what was written. */
  async runOnce(src: Source): Promise<Headline[]> {
    const st = this.status.get(src.id) ?? { id: src.id, name: src.name, lastOkAt: null, lastError: null };
    this.status.set(src.id, st);
    const detectedAt = this.now();
    let items: RawItem[] | null = null;
    try {
      items = await src.poll();
      st.lastOkAt = new Date().toISOString();
      st.lastError = null;
    } catch (err) {
      st.lastError = errorText(err);
      log.warn(`fonte ${src.id} falhou`, err);
    }
    if (items) this.admit(src, items, detectedAt);

    const due = this.o.store.duePending(src.id, this.now()).filter((j) => !this.busy.has(j.key));
    const out: Headline[] = [];
    await Promise.all(
      due.map(async (job) => {
        const h = await this.track(this.attempt(src, job));
        if (h) out.push(h);
      }),
    );
    return out;
  }

  /** Marks new items seen and queues the ones to write, in one transaction, so a crash between the two never loses an item. */
  private admit(src: Source, items: RawItem[], detectedAt: number): void {
    // Oldest first; items with the same date keep the feed's order (newest first), so the newest ties end up last.
    const fresh = items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => !this.o.store.isSeen(rawKey(item)))
      .sort((a, b) => a.item.publishedAt.localeCompare(b.item.publishedAt) || b.i - a.i)
      .map(({ item }) => item);
    if (!fresh.length) return;
    const bootstrap = !this.o.store.hasSeenAny(src.id);
    let todo = fresh;
    if (bootstrap) {
      // First contact with a source: show only its latest few items, as history, and skip old numeric releases.
      const n = Math.floor(this.o.backfillPerSource);
      todo = n > 0 ? fresh.filter((i) => !i.data).slice(-n) : [];
    }
    const jobs = todo.map((item) => ({
      key: rawKey(item),
      item,
      // Stale items (first run, flagged by the source, or too old) are site history only: no social posts.
      backfill: bootstrap || item.stale === true || detectedAt - Date.parse(item.publishedAt) > STALE_MS,
    }));
    this.o.store.admit(src.id, fresh.map(rawKey), jobs, detectedAt);
  }

  /** One attempt at a queued item. A failure is retried with backoff and, after GIVE_UP_MS, saved for review. Never throws. */
  private async attempt(src: Source, job: PendingJob): Promise<Headline | null> {
    if (this.abort.signal.aborted) return null; // shutting down: it stays queued for the next start
    this.busy.add(job.key);
    try {
      return await this.process(src, job);
    } catch (err) {
      try {
        return this.failed(src, job, err);
      } catch (dbErr) {
        log.error(`falha ao registrar erro de ${job.key}`, dbErr);
        return null;
      }
    } finally {
      this.busy.delete(job.key);
    }
  }

  private failed(src: Source, job: PendingJob, err: unknown): Headline | null {
    const attempts = job.attempts + 1;
    const now = this.now();
    log.error(`falha ao escrever ${job.key} (tentativa ${attempts})`, err);
    if (now - job.firstDetectedAt < GIVE_UP_MS) {
      this.o.store.retryPending(job.key, attempts, now + retryDelayMs(attempts), errorText(err));
      return null;
    }
    return this.commit(job, this.review(src, job.item, job, `falha ao escrever após ${attempts} tentativas: ${errorText(err)}`));
  }

  private async process(src: Source, job: PendingJob): Promise<Headline | null> {
    const item = src.enrich ? await src.enrich(job.item) : job.item;
    // Licensed for internal use only: keep it for the private review page, never public, and never sent to the AI.
    if (item.reviewOnly) return this.commit(job, { ...this.review(src, item, job, item.reviewOnly), internalOnly: true });
    if (item.data) {
      const draft = renderIndicator(item.data);
      if (!draft) {
        log.warn(`sem modelo para ${item.data.indicator}; item ${job.key} ignorado`);
        this.o.store.finish(job.key, null);
        return null;
      }
      const h = this.commit(job, this.build(src, item, job, draft));
      this.explain(h, item, item.data);
      return h;
    }

    const since = new Date(this.now() - 6 * 3600 * 1000).toISOString();
    const recent = this.o.store.recentByTag(src.tag, since);
    const draft = await this.ai.run(() => this.o.writer.write(item, { source: src, recent }));
    // A refusal is a final answer, but the fact may matter: keep it for a human to look at.
    if (!draft) return this.commit(job, this.review(src, item, job, "IA recusou o item"));
    if (!draft.publish) {
      log.info(`descartado ${src.id}: ${item.title}`, { motivo: draft.reason });
      this.o.store.finish(job.key, null);
      return null;
    }
    return this.commit(job, this.build(src, item, job, draft));
  }

  /**
   * Turns a draft into a headline. AI text goes to review when a number is not in the source or the writer
   * flagged it (e.g. too long). An item written after STALE_MS (long retries, or a restart after downtime) is history.
   */
  private build(src: Source, item: RawItem, job: PendingJob, draft: WriterDraft): Headline {
    const reasons: string[] = [];
    let explainer = draft.explainer;
    if (draft.method === "ia") {
      const sourceText = `${item.title}\n${item.body}`;
      const bad = unsupportedNumbers(draft.headline, sourceText, item.lang);
      if (!draft.headline) reasons.push("manchete vazia");
      else if (bad.length) reasons.push(`números sem respaldo na fonte: ${bad.join(", ")}`);
      if (draft.review) reasons.push(draft.review);
      if (explainer && unsupportedNumbers(explainer, sourceText, item.lang).length) explainer = null;
    }
    const status: Status = reasons.length ? "revisar" : "publicado";
    const reviewReason = reasons.length ? reasons.join("; ") : undefined;
    const now = this.now();
    const backfill = job.backfill || now - Date.parse(item.publishedAt) > STALE_MS;
    return {
      id: headlineId(item),
      publishedAt: backfill ? item.publishedAt : new Date(now).toISOString(),
      sourcePublishedAt: item.publishedAt,
      detectedAt: new Date(job.firstDetectedAt).toISOString(),
      sourceId: src.id,
      sourceName: src.name,
      tag: src.tag,
      region: src.region,
      urgency: draft.urgency,
      headline: draft.headline,
      explainer,
      topics: draft.topics,
      url: item.url,
      method: draft.method,
      status,
      backfill,
      latencyMs: now - job.firstDetectedAt,
      ...(draft.method === "rascunho" && item.lang === "en" ? { lang: "en" as const } : {}),
      ...(reviewReason ? { reviewReason } : {}),
    };
  }

  /** A headline for review made of the source's own title, used when no checked text could be written. */
  private review(src: Source, item: RawItem, job: PendingJob, reason: string): Headline {
    const draft: Draft = {
      publish: true,
      urgency: "normal",
      headline: item.lang === "en" ? `[EN] ${item.title}` : item.title,
      explainer: null,
      topics: [],
      reason,
      method: "rascunho",
    };
    return { ...this.build(src, item, job, draft), status: "revisar", reviewReason: reason };
  }

  /** Saves the headline and clears its queue entry in one transaction, then sends it to the site and social networks. */
  private commit(job: PendingJob, h: Headline): Headline {
    this.o.store.finish(job.key, h);
    if (h.status === "publicado" || (this.o.showReview && !h.internalOnly)) this.o.hub.send("headline", h);
    log.info(`${h.status} [${h.tag}] ${h.headline}`, { ms: h.latencyMs, metodo: h.method, ...(h.reviewReason ? { reviewReason: h.reviewReason } : {}) });

    if (!h.backfill && h.status === "publicado" && h.method !== "rascunho" && meetsUrgency(h, this.o.minUrgency)) {
      for (const p of this.o.publishers) {
        void this.track(p.publish(h).catch((err) => log.error(`envio ${p.name} falhou`, err)));
      }
    }
    return h;
  }

  /** Adds a "PlatomAI explica" line to a template headline in the background, if every number checks out. */
  private explain(h: Headline, item: RawItem, rel: IndicatorRelease): void {
    if (!this.o.writer.enabled || this.abort.signal.aborted) return;
    const source = releaseText(h.headline, rel);
    const job = this.ai
      .run(() => this.o.writer.explain(h, item))
      .then((text) => {
        if (!text || unsupportedNumbers(text, source, "pt").length) return;
        const updated = { ...h, explainer: text };
        this.o.store.save(updated);
        this.o.hub.send("update", updated);
      })
      .catch((err) => log.warn(`explicação de ${h.id} falhou`, err));
    void this.track(job);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  /** Starts one polling loop per source. Each loop waits for its poll to finish before sleeping. */
  start(sources: Source[]): void {
    for (const src of sources) this.loops.push(this.loop(src));
  }

  private async loop(src: Source): Promise<void> {
    const signal = this.abort.signal;
    await sleep(Math.random() * 2000, undefined, { signal }).catch(() => {});
    while (!signal.aborted) {
      let delay = src.intervalMs;
      try {
        await this.runOnce(src);
        delay = nextDelayMs(src, new Date(this.now()));
        // Wake up for a queued retry even when the source itself is polled rarely (e.g. Copom outside its window).
        const retryAt = this.o.store.nextPendingAt(src.id);
        if (retryAt !== null) delay = Math.min(delay, Math.max(1000, retryAt - this.now()));
      } catch (err) {
        // A broken run (e.g. the database is locked) must never take the whole process down.
        log.error(`ciclo de ${src.id} falhou`, err);
      }
      await sleep(delay, undefined, { signal }).catch(() => {});
    }
  }

  stop(): void {
    this.abort.abort();
  }

  /** After stop(): waits for the loops and every write or post in flight, up to `timeoutMs`. True if all finished. */
  async drain(timeoutMs: number): Promise<boolean> {
    const timer = new AbortController();
    const timeout = sleep(timeoutMs, false, { signal: timer.signal }).catch(() => false);
    const settled = (async () => {
      await Promise.allSettled(this.loops);
      while (this.inflight.size) await Promise.allSettled([...this.inflight]);
      return true;
    })();
    const ok = await Promise.race([settled, timeout]);
    timer.abort();
    return ok;
  }
}
