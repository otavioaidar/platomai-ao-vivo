import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { Headline, RawItem } from "./types.ts";

/** How long a write waits for another connection's lock (e.g. the sqlite3 CLI) before failing. */
const BUSY_TIMEOUT_MS = 5000;

/** A source item waiting to be written, kept in SQLite so a failure or a restart never loses it. */
export interface PendingJob {
  key: string;
  sourceId: string;
  item: RawItem;
  backfill: boolean;
  /** Failed attempts so far. */
  attempts: number;
  /** Epoch ms when the item was first detected (latency is measured from here, across retries). */
  firstDetectedAt: number;
}

export interface NewJob {
  key: string;
  item: RawItem;
  backfill: boolean;
}

/** A headline waiting for its "PlatomAI decifra", kept in SQLite so a restart never loses it. */
export interface DecifraJob {
  headlineId: string;
  sourceName: string;
  /** The item the headline was written from, enriched (full text, filing or numeric release). */
  item: RawItem;
  attempts: number;
}

interface PendingRow {
  raw_key: string;
  source_id: string;
  item_json: string;
  backfill: number;
  attempts: number;
  first_detected_at: number;
}

/** SQLite store: which source items were already seen, what is still waiting to be written, and every headline. */
export class Store {
  readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS seen (
        raw_key TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        first_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_seen_source ON seen(source_id);
      CREATE TABLE IF NOT EXISTS pending (
        raw_key TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        item_json TEXT NOT NULL,
        backfill INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        first_detected_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_pending_due ON pending(source_id, next_attempt_at);
      CREATE TABLE IF NOT EXISTS headlines (
        id TEXT PRIMARY KEY,
        published_at TEXT NOT NULL,
        status TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_headlines_pub ON headlines(published_at DESC);
      CREATE TABLE IF NOT EXISTS decifra_pending (
        headline_id TEXT PRIMARY KEY,
        source_name TEXT NOT NULL,
        item_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_error TEXT
      );
    `);
  }

  /** Prepared statements are compiled once and reused. */
  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Runs `fn` in one write transaction: all of it is stored, or none of it. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  isSeen(rawKey: string): boolean {
    return this.stmt("SELECT 1 FROM seen WHERE raw_key = ?").get(rawKey) !== undefined;
  }

  markSeen(rawKey: string, sourceId: string): void {
    this.stmt("INSERT OR IGNORE INTO seen (raw_key, source_id, first_seen) VALUES (?, ?, ?)").run(rawKey, sourceId, new Date().toISOString());
  }

  hasSeenAny(sourceId: string): boolean {
    return this.stmt("SELECT 1 FROM seen WHERE source_id = ? LIMIT 1").get(sourceId) !== undefined;
  }

  /** Marks new items seen and queues the ones to write, in the same transaction. */
  admit(sourceId: string, seenKeys: string[], jobs: NewJob[], detectedAt: number): void {
    this.tx(() => {
      for (const key of seenKeys) this.markSeen(key, sourceId);
      for (const j of jobs) {
        this.stmt(
          `INSERT OR IGNORE INTO pending (raw_key, source_id, item_json, backfill, attempts, next_attempt_at, first_detected_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
        ).run(j.key, sourceId, JSON.stringify(j.item), j.backfill ? 1 : 0, detectedAt, detectedAt);
      }
    });
  }

  /** Queued items of a source whose next attempt is due, oldest first. */
  /** When the earliest queued item of a source is due again (epoch ms), or null when its queue is empty. */
  nextPendingAt(sourceId: string): number | null {
    const row = this.stmt("SELECT MIN(next_attempt_at) AS t FROM pending WHERE source_id = ?").get(sourceId) as { t: number | null } | undefined;
    return row?.t ?? null;
  }

  duePending(sourceId: string, now: number): PendingJob[] {
    const rows = this.stmt(
      `SELECT raw_key, source_id, item_json, backfill, attempts, first_detected_at FROM pending
       WHERE source_id = ? AND next_attempt_at <= ? ORDER BY first_detected_at, rowid`,
    ).all(sourceId, now) as unknown as PendingRow[];
    return rows.map((r) => ({
      key: r.raw_key,
      sourceId: r.source_id,
      item: JSON.parse(r.item_json) as RawItem,
      backfill: r.backfill === 1,
      attempts: r.attempts,
      firstDetectedAt: r.first_detected_at,
    }));
  }

  /** Every queued item (for status and tests). */
  pendingCount(): number {
    return (this.stmt("SELECT COUNT(*) AS n FROM pending").get() as { n: number }).n;
  }

  /** Records a failed attempt and when to try again. */
  retryPending(key: string, attempts: number, nextAttemptAt: number, error: string): void {
    this.stmt("UPDATE pending SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE raw_key = ?").run(attempts, nextAttemptAt, error, key);
  }

  /**
   * Stores the final outcome of a queued item (a headline, or null when it was discarded) and removes it from the
   * queue. With `decifra`, the headline is also queued for its analysis, in the same transaction.
   */
  finish(key: string, h: Headline | null, decifra?: { sourceName: string; item: RawItem; at: number }): void {
    this.tx(() => {
      if (h) this.save(h);
      if (h && decifra) {
        this.stmt(
          `INSERT OR IGNORE INTO decifra_pending (headline_id, source_name, item_json, attempts, next_attempt_at, created_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
        ).run(h.id, decifra.sourceName, JSON.stringify(decifra.item), decifra.at, decifra.at);
      }
      this.stmt("DELETE FROM pending WHERE raw_key = ?").run(key);
    });
  }

  /** Headlines whose analysis is due, oldest first. */
  dueDecifra(now: number, limit = 20): DecifraJob[] {
    const rows = this.stmt(
      `SELECT headline_id, source_name, item_json, attempts FROM decifra_pending
       WHERE next_attempt_at <= ? ORDER BY created_at, rowid LIMIT ?`,
    ).all(now, limit) as { headline_id: string; source_name: string; item_json: string; attempts: number }[];
    return rows.map((r) => ({ headlineId: r.headline_id, sourceName: r.source_name, item: JSON.parse(r.item_json) as RawItem, attempts: r.attempts }));
  }

  decifraPendingCount(): number {
    return (this.stmt("SELECT COUNT(*) AS n FROM decifra_pending").get() as { n: number }).n;
  }

  retryDecifra(headlineId: string, attempts: number, nextAttemptAt: number, error: string): void {
    this.stmt("UPDATE decifra_pending SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE headline_id = ?").run(attempts, nextAttemptAt, error, headlineId);
  }

  /** Removes a headline from the analysis queue and, when given, stores what the analysis changed, atomically. */
  finishDecifra(headlineId: string, change?: (h: Headline) => Headline | null): Headline | null {
    return this.tx(() => {
      const out = change ? this.update(headlineId, change) : null;
      this.stmt("DELETE FROM decifra_pending WHERE headline_id = ?").run(headlineId);
      return out;
    });
  }

  /**
   * Read-modify-write of one headline, so background additions (the explainer, the decifra, an approval) never
   * overwrite each other. `change` returns the new headline, or null to leave it as it is. Returns what was saved.
   */
  update(id: string, change: (h: Headline) => Headline | null): Headline | null {
    const h = this.get(id);
    if (!h) return null;
    const next = change(h);
    if (next) this.save(next);
    return next;
  }

  save(h: Headline): void {
    this.stmt(
      `INSERT INTO headlines (id, published_at, status, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at, status = excluded.status, json = excluded.json`,
    ).run(h.id, h.publishedAt, h.status, JSON.stringify(h));
  }

  get(id: string): Headline | null {
    const row = this.stmt("SELECT json FROM headlines WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Headline) : null;
  }

  /** Public headlines, newest first. `includeReview` adds the ones waiting for review, except internal-only items. */
  latest(limit: number, includeReview = false): Headline[] {
    const sql = includeReview
      ? "SELECT json FROM headlines WHERE coalesce(json_extract(json, '$.internalOnly'), 0) = 0 ORDER BY published_at DESC LIMIT ?"
      : "SELECT json FROM headlines WHERE status = 'publicado' ORDER BY published_at DESC LIMIT ?";
    const rows = this.stmt(sql).all(limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Headline);
  }

  /** Everything waiting for a human (failed checks, refusals, internal-only sources), newest first. */
  reviewQueue(limit: number): Headline[] {
    const rows = this.stmt("SELECT json FROM headlines WHERE status = 'revisar' ORDER BY published_at DESC LIMIT ?").all(limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Headline);
  }

  /** Analyses waiting for a reviewer, and the NÃO VALE TEXTO answers of the last ones, newest first. */
  decifraQueue(limit: number): Headline[] {
    const rows = this.stmt(
      `SELECT json FROM headlines
       WHERE json_extract(json, '$.decifra.status') = 'revisar' OR json_extract(json, '$.decifraSkipped') IS NOT NULL
       ORDER BY published_at DESC LIMIT ?`,
    ).all(limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Headline);
  }

  /**
   * Recent public headlines from the same tag, so the writer does not repeat a fact already published.
   * Headlines waiting for review never went public, so they are left out.
   */
  recentByTag(tag: string | string[], sinceIso: string, limit = 15): Headline[] {
    const tags = JSON.stringify(Array.isArray(tag) ? tag : [tag]);
    const rows = this.stmt(
      `SELECT json FROM headlines
       WHERE json_extract(json, '$.tag') IN (SELECT value FROM json_each(?)) AND status = 'publicado' AND published_at >= ?
       ORDER BY published_at DESC LIMIT ?`,
    ).all(tags, sinceIso, limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Headline);
  }

  close(): void {
    this.db.close();
  }
}
