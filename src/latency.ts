// How fast each source reaches the site: from publication at the source to detection here, and on to the site.
// Used by `npm run latencia` to judge a paid feed during its trial (e.g. Partnr against the free official sources).
import type { Headline } from "./types.ts";

export interface LatencyRow {
  sourceId: string;
  sourceName: string;
  /** Items measured (history from a first start or an outage is left out). */
  count: number;
  /** Seconds from publication at the source to detection by the poller. */
  detectP50: number;
  detectP95: number;
  detectMax: number;
  /** Seconds from detection to publication (or to the review queue). */
  publishP50: number;
}

/** Nearest-rank percentile of an ascending list; 0 for an empty one. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const round = (s: number) => Math.round(s * 10) / 10;

export function latencyBySource(headlines: Headline[]): LatencyRow[] {
  const groups = new Map<string, { name: string; detect: number[]; publish: number[] }>();
  for (const h of headlines) {
    if (h.backfill) continue;
    const detect = (Date.parse(h.detectedAt) - Date.parse(h.sourcePublishedAt)) / 1000;
    if (!Number.isFinite(detect)) continue;
    const g = groups.get(h.sourceId) ?? { name: h.sourceName, detect: [], publish: [] };
    // A source clock slightly ahead of ours would give a negative wait: count it as immediate.
    g.detect.push(Math.max(0, detect));
    g.publish.push(Math.max(0, h.latencyMs / 1000));
    groups.set(h.sourceId, g);
  }
  return [...groups.entries()]
    .map(([sourceId, g]) => {
      const d = g.detect.sort((a, b) => a - b);
      const p = g.publish.sort((a, b) => a - b);
      return {
        sourceId,
        sourceName: g.name,
        count: d.length,
        detectP50: round(percentile(d, 50)),
        detectP95: round(percentile(d, 95)),
        detectMax: round(d[d.length - 1]),
        publishP50: round(percentile(p, 50)),
      };
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}
