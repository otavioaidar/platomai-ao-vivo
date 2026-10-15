// Polls every source once and prints what it found, without writing anything. Usage: npm run probe
// Behind a proxy, run it with NODE_USE_ENV_PROXY=1, like `npm run dev`.
import { errorText } from "../src/log.ts";
import { installExtraCAs } from "../src/net.ts";
import { officialFeeds } from "../src/sources/feeds.ts";
import { Agenda, SIDRA_SPECS, ibgeReleases, sidraSource } from "../src/sources/ibge.ts";
import { renderIndicator } from "../src/writer/templates.ts";

installExtraCAs();
const agenda = new Agenda();
await agenda.refresh();
console.log(`agenda: ${agenda.items.length} divulgações; próximas:`, agenda.upcoming().slice(0, 4).map((i) => `${i.when} ${i.title}`));

const sources = [...officialFeeds(1), ibgeReleases(agenda, 1), ...SIDRA_SPECS.map((s) => sidraSource(s, agenda, 1))];
for (const src of sources) {
  const t0 = Date.now();
  try {
    const items = await src.poll();
    const first = items[0];
    console.log(`\n[${src.id}] ${items.length} itens em ${Date.now() - t0} ms`);
    const hot = src.nextHotAt?.(new Date());
    if (hot) console.log(`  próxima janela rápida: ${new Date(hot).toISOString()}`);
    if (!first) continue;
    const item = src.enrich ? await src.enrich(first) : first;
    console.log(`  ${item.publishedAt}${item.stale ? " (antigo: só histórico)" : ""} | ${item.title}`);
    console.log(`  ${item.url}`);
    console.log(`  corpo (${item.body.length} chars): ${item.body.slice(0, 220).replace(/\n/g, " / ")}`);
    if (item.data) console.log("  modelo fixo:", renderIndicator(item.data)?.headline);
  } catch (err) {
    console.log(`\n[${src.id}] ERRO ${errorText(err)}`);
  }
}
