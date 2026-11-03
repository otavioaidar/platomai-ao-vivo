// Latency per source over the last days, from the site's database. Usage: npm run latencia [-- <dias>] (default 7)
// "Fonte → detecção" is what a paid feed is judged on; the poll interval is part of it.
import { DatabaseSync } from "node:sqlite";
import { latencyBySource } from "../src/latency.ts";
import type { Headline } from "../src/types.ts";

const days = Number(process.argv[2] ?? 7);
if (!Number.isFinite(days) || days <= 0) {
  console.error("uso: npm run latencia -- <dias>");
  process.exit(1);
}
const file = process.env.DB_PATH?.trim() || "data/aovivo.db";
const db = new DatabaseSync(file, { readOnly: true });
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const rows = db.prepare("SELECT json FROM headlines WHERE published_at >= ?").all(since) as { json: string }[];
db.close();

const report = latencyBySource(rows.map((r) => JSON.parse(r.json) as Headline));
console.log(`Latência por fonte nos últimos ${days} dias (${file}), em segundos:\n`);
console.table(
  report.map((r) => ({
    fonte: r.sourceName,
    itens: r.count,
    "fonte → detecção (mediana)": r.detectP50,
    "fonte → detecção (p95)": r.detectP95,
    "fonte → detecção (máx.)": r.detectMax,
    "detecção → site (mediana)": r.publishP50,
  })),
);
if (!report.length) console.log("Nenhum item novo no período (o histórico da primeira carga não conta).");
