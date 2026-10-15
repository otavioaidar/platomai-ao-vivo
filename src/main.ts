import { config } from "./config.ts";
import { Store } from "./db.ts";
import { Hub } from "./hub.ts";
import { log } from "./log.ts";
import { installExtraCAs } from "./net.ts";
import { Pipeline, keepRefreshed } from "./pipeline.ts";
import { buildPublishers } from "./publishers/index.ts";
import { createServer } from "./server.ts";
import { officialFeeds } from "./sources/feeds.ts";
import { alphaVantageSource, parseQuery } from "./sources/alphavantage.ts";
import { Agenda, SIDRA_SPECS, ibgeReleases, sidraSource } from "./sources/ibge.ts";
import { ClaudeWriter, DraftWriter } from "./writer/ai.ts";
import type { Writer } from "./writer/ai.ts";

/** The IBGE calendar is retried every 2 min until it first loads, then refreshed every 30 min. */
const AGENDA_RETRY_MS = 2 * 60 * 1000;
const AGENDA_REFRESH_MS = 30 * 60 * 1000;
/** Shutdown waits this long for writes in flight, and exits for sure before Docker's 10 s stop timeout. */
const DRAIN_MS = 8000;
const HARD_EXIT_MS = 9000;

installExtraCAs();

const store = new Store(config.dbPath);
const hub = new Hub(undefined, config.sse);
const agenda = new Agenda();

const writer: Writer = config.ai.enabled
  ? new ClaudeWriter({ model: config.ai.model, effort: config.ai.effort, editorialPath: config.editorialPath })
  : new DraftWriter();
const publishers = buildPublishers(config);

const av = config.alphaVantage;
const sources = [
  ...officialFeeds(config.pollScale),
  ibgeReleases(agenda, config.pollScale),
  ...SIDRA_SPECS.map((s) => sidraSource(s, agenda, config.pollScale)),
  // Only with a key; "interno" (the default) keeps its items on the private review page.
  ...(av.apiKey
    ? [alphaVantageSource({ apiKey: av.apiKey, use: av.use, minRelevance: av.minRelevance, intervalMs: av.intervalMs, queries: av.queries.map(parseQuery).filter((q) => q !== null) })]
    : []),
];

const pipeline = new Pipeline({
  store,
  writer,
  hub,
  publishers,
  minUrgency: config.social.minUrgency,
  backfillPerSource: config.backfillPerSource,
  showReview: config.showReview,
  aiConcurrency: config.ai.concurrency,
});

const server = createServer({
  store,
  hub,
  agenda,
  publicDir: "public",
  siteUrl: config.siteUrl,
  showReview: config.showReview,
  ai: { enabled: writer.enabled, model: writer.model },
  statuses: () => pipeline.statuses(),
  reviewToken: config.reviewToken,
});

// The calendar loads in the background: a slow IBGE must not hold up the site or the other sources.
const stopAgenda = keepRefreshed(
  async () => {
    await agenda.refresh();
    return agenda.lastError === null;
  },
  AGENDA_REFRESH_MS,
  AGENDA_RETRY_MS,
);

// A port that cannot be opened is fatal: exit so Docker or systemd restart the process instead of idling without a site.
server.on("error", (err) => {
  log.error("o servidor não abriu a porta", err);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log.info(`PlatomAI Ao Vivo em http://localhost:${config.port}`, {
    ia: writer.enabled ? `${writer.model} (esforço ${config.ai.effort})` : "desligada (rascunhos)",
    fontes: sources.length,
    redes: publishers.map((p) => `${p.name}:${p.live ? "ao vivo" : "simulação"}`),
    alphaVantage: av.apiKey ? `${av.use} (${av.queries.length} consultas a cada ${av.intervalMs / 1000} s)` : "sem chave",
    revisao: config.reviewToken ? "/revisao (com token)" : "desligada (defina REVIEW_TOKEN)",
  });
  pipeline.start(sources);
});

let closing = false;

/** Stops polling, waits for writes and posts in flight, then closes the database. Items not finished stay queued. */
async function shutdown() {
  if (closing) process.exit(1); // a second signal does not wait
  closing = true;
  log.info("encerrando…");
  setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
  stopAgenda();
  pipeline.stop();
  hub.close();
  server.close();
  if (!(await pipeline.drain(DRAIN_MS))) log.warn("encerrando com itens em andamento; serão retomados na próxima partida");
  store.close();
  process.exit(0);
}
// Last resort (each loop and request has its own handler): log with the stack and exit. Node's state is not safe to
// resume after this; Docker or systemd restart the process and the pending queue picks the work up again.
function fatal(what: string, err: unknown): never {
  log.error(what, err);
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
}
process.on("uncaughtException", (err) => fatal("erro não tratado", err));
process.on("unhandledRejection", (err) => fatal("promessa rejeitada sem tratamento", err));
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
