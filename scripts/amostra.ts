// Shows how the AI would write the latest items of every text source, without publishing anything.
// Used to calibrate editorial/linha-editorial.md. Needs ANTHROPIC_API_KEY. Usage: npm run amostra [-- 2]
import fs from "node:fs";
import { config } from "../src/config.ts";
import { installExtraCAs } from "../src/net.ts";
import { officialFeeds } from "../src/sources/feeds.ts";
import { Agenda, ibgeReleases } from "../src/sources/ibge.ts";
import { unsupportedNumbers } from "../src/writer/guard.ts";
import { ClaudeWriter } from "../src/writer/ai.ts";

if (!config.ai.enabled) {
  console.error("Defina ANTHROPIC_API_KEY (ou AI_ENABLED=1 com um perfil `ant auth login`) para gerar a amostra.");
  process.exit(1);
}
installExtraCAs();
const perSource = Number(process.argv[2] ?? 2);
const writer = new ClaudeWriter({ model: config.ai.model, effort: config.ai.effort, editorialPath: config.editorialPath });
const sources = [...officialFeeds(1), ibgeReleases(new Agenda(), 1)];
const lines = [`# Amostra da redação (${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })})`, "", `Modelo: ${config.ai.model}, esforço ${config.ai.effort}`, ""];

for (const src of sources) {
  const items = (await src.poll()).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, perSource);
  for (const raw of items) {
    const item = src.enrich ? await src.enrich(raw) : raw;
    const t0 = Date.now();
    const d = await writer.write(item, { source: src, recent: [] }).catch((e: Error) => ({ error: e.message }));
    const ms = Date.now() - t0;
    lines.push(`## ${src.name}: ${item.title}`, `Fonte: ${item.url}`, "");
    if (!d) lines.push("- IA recusou o item", "");
    else if ("error" in d) lines.push(`- Erro: ${d.error}`, "");
    else {
      const bad = unsupportedNumbers(d.headline, `${item.title}\n${item.body}`);
      lines.push(
        `- **${d.publish ? d.urgency.toUpperCase() : "NÃO PUBLICARIA"}**: ${d.headline || "(vazio)"}`,
        d.explainer ? `- PlatomAI explica: ${d.explainer}` : "- (sem explicação)",
        `- Motivo: ${d.reason}`,
        `- Checagem de números: ${bad.length ? `FALHOU (${bad.join(", ")})` : "ok"} · ${ms} ms`,
        "",
      );
    }
    console.log(lines.slice(-6).join("\n"));
  }
}

fs.mkdirSync("data", { recursive: true });
const out = `data/amostra-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
fs.writeFileSync(out, lines.join("\n"));
console.log(`\nAmostra salva em ${out}`);
