import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Headline } from "./types.ts";

/** SQLite store: which source items were already seen, and every headline written. */
export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS seen (
        raw_key TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        first_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_seen_source ON seen(source_id);
      CREATE TABLE IF NOT EXISTS headlines (
        id TEXT PRIMARY KEY,
        published_at TEXT NOT NULL,
        status TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_headlines_pub ON headlines(published_at DESC);
    `);
  }

  isSeen(rawKey: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen WHERE raw_key = ?").get(rawKey) !== undefined;
  }

  markSeen(rawKey: string, sourceId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO seen (raw_key, source_id, first_seen) VALUES (?, ?, ?)")
      .run(rawKey, sourceId, new Date().toISOString());
  }

  hasSeenAny(sourceId: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen WHERE source_id = ? LIMIT 1").get(sourceId) !== undefined;
  }

  save(h: Headline): void {
    this.db
      .prepare(
        `INSERT INTO headlines (id, published_at, status, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at, status = excluded.status, json = excluded.json`,
      )
      .run(h.id, h.publishedAt, h.status, JSON.stringify(h));
  }

  get(id: string): Headline | null {
    const row = this.db.prepare("SELECT json FROM headlines WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Headline) : null;
  }

  latest(limit: number, includeReview = false): Headline[] {
    const sql = includeReview
      ? "SELECT json FROM headlines ORDER BY published_at DESC LIMIT ?"
      : "SELECT json FROM headlines WHERE status = 'publicado' ORDER BY published_at DESC LIMIT ?";
    const rows = this.db.prepare(sql).all(limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Headline);
  }

  /** Recent headlines from the same tag, used so the writer does not repeat a fact already published. */
  recentByTag(tag: string, sinceIso: string, limit = 15): Headline[] {
    const rows = this.db
      .prepare("SELECT json FROM headlines WHERE published_at >= ? ORDER BY published_at DESC LIMIT 200")
      .all(sinceIso) as { json: string }[];
    return rows
      .map((r) => JSON.parse(r.json) as Headline)
      .filter((h) => h.tag === tag)
      .slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}
