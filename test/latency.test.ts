import assert from "node:assert/strict";
import { test } from "node:test";
import { latencyBySource, percentile } from "../src/latency.ts";
import type { Headline } from "../src/types.ts";

const h = (sourceId: string, waitS: number, extra: Partial<Headline> = {}): Headline =>
  ({
    sourceId,
    sourceName: sourceId.toUpperCase(),
    sourcePublishedAt: "2026-11-03T12:00:00.000Z",
    detectedAt: new Date(Date.parse("2026-11-03T12:00:00.000Z") + waitS * 1000).toISOString(),
    latencyMs: 2_000,
    backfill: false,
    ...extra,
  }) as Headline;

test("nearest-rank percentiles", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([7], 95), 7);
});

test("latency per source leaves first-load and source-flagged history out, keeps late items, and counts a source clock ahead of ours as immediate", () => {
  const rows = latencyBySource([
    h("partnr", 40),
    h("partnr", 10),
    h("partnr", 25),
    h("partnr", 600, { backfill: true }),
    h("partnr", 600, { backfill: true, history: "inicio" }),
    h("partnr", 9 * 3600, { backfill: true, history: "atraso" }),
    h("partnr", 5, { backfill: true, history: "fonte" }),
    h("copom", -3),
    h("copom", 4, { sourcePublishedAt: "data ruim" }),
  ]);
  assert.deepEqual(rows, [
    { sourceId: "copom", sourceName: "COPOM", count: 1, detectP50: 0, detectP95: 0, detectMax: 0, publishP50: 2 },
    { sourceId: "partnr", sourceName: "PARTNR", count: 4, detectP50: 25, detectP95: 32400, detectMax: 32400, publishP50: 2 },
  ]);
});
