import { config } from "./config.ts";
import { Store } from "./db.ts";
import { Hub } from "./hub.ts";
import { log } from "./log.ts";
import { installExtraCAs } from "./net.ts";
import { Pipeline } from "./pipeline.ts";
import { buildPublishers } from "./publishers/index.ts";
import { createServer } from "./server.ts";
import { officialFeeds } from "./sources/feeds.ts";
import { Agenda, SIDRA_SPECS, ibgeReleases, sidraSource } from "./sources/ibge.ts";
import { ClaudeWriter, DraftWriter } from "./writer/ai.ts";
import type { Writer } from "./writer/ai.ts";

installExtraCAs();

const store = new Store(config.dbPath);
const hub = new Hub();
const agenda = new Agenda();
await agenda.refresh();
const agendaTimer = setInterval(() => void agenda.refresh(), 30 * 60 * 1000);

const writer: Writer = config.ai.enabled
  ? new ClaudeWriter({ model: config.ai.model, effort: config.ai.effort, editorialPath: config.editorialPath })
  : new DraftWriter();
const publishers = buildPublishers(config);

const sources = [
  ...officialFeeds(config.pollScale),
  ibgeReleases(agenda, config.pollScale),
  ...SIDRA_SPECS.map((s) => sidraSource(s, agenda, config.pollScale)),
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
});

server.listen(config.port, config.host, () => {
  log.info(`PlatomAI Ao Vivo em http://localhost:${config.port}`, {
    ia: writer.enabled ? `${writer.model} (esforço ${config.ai.effort})` : "desligada (rascunhos)",
    fontes: sources.length,
    redes: publishers.map((p) => `${p.name}:${p.live ? "ao vivo" : "simulação"}`),
  });
  pipeline.start(sources);
});

function shutdown() {
  log.info("encerrando…");
  pipeline.stop();
  clearInterval(agendaTimer);
  hub.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
