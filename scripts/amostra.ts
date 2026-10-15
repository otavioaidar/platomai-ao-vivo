// Shows how the AI would write the latest items of every text source, without publishing anything.
// Used to calibrate editorial/linha-editorial.md. Needs ANTHROPIC_API_KEY. Usage: npm run amostra [-- 2]
// Behind a proxy, run it with NODE_USE_ENV_PROXY=1, like `npm run dev`.
import fs from "node:fs";
import { config } from "../src/config.ts";
import { errorText } from "../src/log.ts";
import { installExtraCAs } from "../src/net.ts";
import { officialFeeds } from "../src/sources/feeds.ts";
import { Agenda, ibgeReleases } from "../src/sources/ibge.ts";
import { unsupportedNumbers } from "../src/writer/guard.ts";
import { ClaudeWriter } from "../src/writer/ai.ts";
import type { RawItem, Source } from "../src/types.ts";

if (!config.ai.enabled) {
  console.error("Defina ANTHROPIC_API_KEY (ou AI_ENABLED=1 com um perfil `ant auth login`) para gerar a amostra.");
  process.exit(1);
}
installExtraCAs();
const perSource = Number(process.argv[2] ?? 2);
const writer = new ClaudeWriter({ model: config.ai.model, effort: config.ai.effort, editorialPath: config.editorialPath });
const sources = [...officialFeeds(1), ibgeReleases(new Agenda(), 1)];

// The file is written as we go, so a failure halfway keeps every sample already paid for.
fs.mkdirSync("data", { recursive: true });
const out = `data/amostra-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
const save = (lines: string[]) => {
  fs.appendFileSync(out, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
};
save([`# Amostra da redação (${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })})`, "", `Modelo: ${config.ai.model}, esforço ${config.ai.effort}`, ""]);

/** One item written by the AI, as Markdown lines. Never throws. */
async function sample(src: Source, raw: RawItem): Promise<string[]> {
  let item = raw;
  try {
    if (src.enrich) item = await src.enrich(raw);
  } catch (err) {
    console.error(`enriquecimento falhou (${src.id}): ${errorText(err)}`);
  }
  const head = [`## ${src.name}: ${item.title}`, `Fonte: ${item.url}`, ""];
  const t0 = Date.now();
  try {
    const d = await writer.write(item, { source: src, recent: [] });
    const ms = Date.now() - t0;
    if (!d) return [...head, "- IA recusou o item", ""];
    const sourceText = `${item.title}\n${item.body}`;
    const bad = unsupportedNumbers(d.headline, sourceText, item.lang);
    const badExplainer = d.explainer ? unsupportedNumbers(d.explainer, sourceText, item.lang) : [];
    return [
      ...head,
      `- **${d.publish ? d.urgency.toUpperCase() : "NÃO PUBLICARIA"}**: ${d.headline || "(vazio)"}`,
      d.explainer ? `- PlatomAI explica: ${d.explainer}` : "- (sem explicação)",
      `- Motivo: ${d.reason}`,
      `- Checagem de números: ${bad.length ? `FALHOU (${bad.join(", ")})` : "ok"} · ${ms} ms`,
      ...(badExplainer.length ? [`- Explicação seria descartada (números sem respaldo: ${badExplainer.join(", ")})`] : []),
      ...(d.review ? [`- Iria para revisão: ${d.review}`] : []),
      "",
    ];
  } catch (err) {
    return [...head, `- Erro: ${errorText(err)}`, ""];
  }
}

for (const src of sources) {
  let items: RawItem[];
  try {
    items = (await src.poll()).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, perSource);
  } catch (err) {
    save([`## ${src.name}: ERRO ${errorText(err)}`, ""]);
    continue;
  }
  for (const raw of items) save(await sample(src, raw));
}

console.log(`\nAmostra salva em ${out}`);
