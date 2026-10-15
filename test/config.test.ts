import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import type { Env } from "../src/config.ts";

function load(env: Env) {
  const warnings: string[] = [];
  const config = loadConfig(env, (msg) => warnings.push(msg));
  return { config, warnings };
}

test("defaults when nothing is set", () => {
  const { config, warnings } = load({});
  assert.equal(config.port, 8080);
  assert.equal(config.pollScale, 1);
  assert.equal(config.backfillPerSource, 3);
  assert.equal(config.ai.concurrency, 3);
  assert.equal(config.ai.effort, "low");
  assert.equal(config.ai.model, "claude-opus-5-5");
  assert.equal(config.ai.enabled, false);
  assert.equal(config.social.minUrgency, "alta");
  assert.equal(config.showReview, false);
  assert.deepEqual(warnings, []);
});

test("empty values count as unset, silently", () => {
  const { config, warnings } = load({ PORT: "", POLL_SCALE: "", BACKFILL_PER_SOURCE: " ", AI_CONCURRENCY: "", AI_EFFORT: "", AI_MODEL: "", SOCIAL_MIN_URGENCY: "", SITE_URL: "", HOST: "" });
  assert.equal(config.port, 8080);
  assert.equal(config.pollScale, 1, "not 0, which would poll back-to-back");
  assert.equal(config.backfillPerSource, 3);
  assert.equal(config.ai.concurrency, 3);
  assert.equal(config.ai.effort, "low");
  assert.equal(config.ai.model, "claude-opus-5-5");
  assert.equal(config.social.minUrgency, "alta");
  assert.equal(config.siteUrl, "http://localhost:8080");
  assert.equal(config.host, "0.0.0.0");
  assert.deepEqual(warnings, []);
});

test("numbers accept a Brazilian decimal comma", () => {
  const { config, warnings } = load({ POLL_SCALE: "0,5", PORT: "3000", BACKFILL_PER_SOURCE: "0", AI_CONCURRENCY: "5" });
  assert.equal(config.pollScale, 0.5);
  assert.equal(config.port, 3000);
  assert.equal(config.backfillPerSource, 0, "0 is a valid choice: no history");
  assert.equal(config.ai.concurrency, 5);
  assert.deepEqual(warnings, []);
});

test("bad or out-of-range numbers fall back to the default with a warning", () => {
  const { config, warnings } = load({ PORT: "80a", POLL_SCALE: "três", BACKFILL_PER_SOURCE: "2.5", AI_CONCURRENCY: "abc" });
  assert.equal(config.port, 8080);
  assert.equal(config.pollScale, 1);
  assert.equal(config.backfillPerSource, 3);
  assert.equal(config.ai.concurrency, 3);
  assert.equal(warnings.length, 4);
  assert.match(warnings[0], /PORT="80a" inválido \(inteiro de 1 a 65535\); usando 8080/);
  assert.match(warnings[1], /POLL_SCALE="três" inválido \(número de 0,25 a 20\); usando 1/);

  const range = load({ PORT: "0", POLL_SCALE: "0", AI_CONCURRENCY: "0", BACKFILL_PER_SOURCE: "-1" });
  assert.equal(range.config.port, 8080, "not a random port");
  assert.equal(range.config.pollScale, 1);
  assert.equal(range.config.ai.concurrency, 3);
  assert.equal(range.config.backfillPerSource, 3);
  assert.equal(range.warnings.length, 4);
});

test("AI_EFFORT accepts only the API's effort levels", () => {
  assert.equal(load({ AI_EFFORT: "HIGH" }).config.ai.effort, "high");
  assert.equal(load({ AI_EFFORT: "xhigh" }).config.ai.effort, "xhigh");
  const bad = load({ AI_EFFORT: "minimal" });
  assert.equal(bad.config.ai.effort, "low");
  assert.match(bad.warnings[0], /AI_EFFORT="minimal" inválido \(use low \| medium \| high \| xhigh \| max\); usando low/);
});

test("SOCIAL_MIN_URGENCY ignores case and rejects unknown levels", () => {
  assert.equal(load({ SOCIAL_MIN_URGENCY: "Alta" }).config.social.minUrgency, "alta");
  assert.equal(load({ SOCIAL_MIN_URGENCY: " urgente " }).config.social.minUrgency, "urgente");
  const bad = load({ SOCIAL_MIN_URGENCY: "urgent" });
  assert.equal(bad.config.social.minUrgency, "alta");
  assert.match(bad.warnings[0], /SOCIAL_MIN_URGENCY="urgent" inválido \(use normal \| alta \| urgente\); usando alta/);
});

test("booleans accept Portuguese and English words and warn on anything else", () => {
  assert.equal(load({ SHOW_REVIEW: "sim" }).config.showReview, true);
  assert.equal(load({ SHOW_REVIEW: "não" }).config.showReview, false);
  const bad = load({ SHOW_REVIEW: "talvez" });
  assert.equal(bad.config.showReview, false);
  assert.equal(bad.warnings.length, 1);
  assert.equal(load({ ANTHROPIC_API_KEY: "sk-ant-x" }).config.ai.enabled, true);
  assert.equal(load({ ANTHROPIC_API_KEY: "sk-ant-x", AI_ENABLED: "0" }).config.ai.enabled, false);
  assert.equal(load({ ANTHROPIC_API_KEY: "" }).config.ai.enabled, false);
});

test("addresses must be http(s) and lose the trailing slash", () => {
  assert.equal(load({ SITE_URL: "https://aovivo.platomai.com.br/" }).config.siteUrl, "https://aovivo.platomai.com.br");
  const bad = load({ SITE_URL: "aovivo.platomai.com.br" });
  assert.equal(bad.config.siteUrl, "http://localhost:8080");
  assert.equal(bad.warnings.length, 1);
  assert.equal(load({ BLUESKY_SERVICE: "ftp://x" }).config.social.bluesky.service, "https://bsky.social");
});

test("SSE caps have defaults and accept 0 to turn the per-IP cap off", () => {
  assert.deepEqual(loadConfig({}, () => {}).sse, { maxClients: 2000, maxPerIp: 20 });
  assert.deepEqual(loadConfig({ SSE_MAX_CLIENTS: "500", SSE_MAX_PER_IP: "0" }, () => {}).sse, { maxClients: 500, maxPerIp: 0 });
  const warnings: string[] = [];
  assert.equal(loadConfig({ SSE_MAX_CLIENTS: "0" }, (m) => warnings.push(m)).sse.maxClients, 2000);
  assert.equal(warnings.length, 1);
});

test("Alpha Vantage stays internal unless told otherwise, and bad queries are dropped with a warning", () => {
  const def = loadConfig({}, () => {}).alphaVantage;
  assert.equal(def.apiKey, "");
  assert.equal(def.use, "interno");
  assert.ok(def.queries.includes("topics:economy_monetary") && def.queries.includes("tickers:PBR"));
  assert.equal(def.intervalMs, 120_000);
  const warnings: string[] = [];
  const cfg = loadConfig({ ALPHAVANTAGE_USO: "Publico", ALPHAVANTAGE_CONSULTAS: "tickers:VALE, keywords:selic ,topics:economy_macro", ALPHAVANTAGE_INTERVALO_S: "10" }, (m) => warnings.push(m)).alphaVantage;
  assert.equal(cfg.use, "publico");
  assert.deepEqual(cfg.queries, ["tickers:VALE", "topics:economy_macro"]);
  assert.equal(cfg.intervalMs, 120_000, "below 30 s falls back to the default");
  assert.equal(warnings.length, 2);
  assert.equal(loadConfig({ ALPHAVANTAGE_USO: "sim" }, () => {}).alphaVantage.use, "interno");
});
