import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeWriter, DraftWriter } from "../src/writer/ai.ts";
import type { RawItem, Source } from "../src/types.ts";

const editorial = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aovivo-")), "linha.md");
fs.writeFileSync(editorial, "Prioridade: juros.");

const source: Source = { id: "bcb-copom", name: "Copom (comunicados)", tag: "COPOM", region: "BR", intervalMs: 1, poll: async () => [] };
const item: RawItem = {
  sourceId: "bcb-copom",
  externalId: "1",
  url: "https://www.bcb.gov.br/x",
  title: "Copom reduz a taxa Selic para 13,75% a.a.",
  body: "O Copom decidiu reduzir a taxa básica de juros em 0,25 ponto percentual, para 13,75% a.a.",
  publishedAt: "2026-09-16T21:32:02.000Z",
  lang: "pt",
};

/** Records the request and returns a canned response, standing in for the SDK client. */
function fakeClient(response: Record<string, unknown>) {
  const requests: Record<string, any>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (req: Record<string, any>) => {
          requests.push(req);
          return response;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const ok = (payload: object) => ({
  stop_reason: "end_turn",
  stop_details: null,
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(payload) }],
});

test("sends a structured-output request with adaptive thinking, effort and server-side fallback", async () => {
  const { client, requests } = fakeClient(
    ok({ publish: true, urgency: "urgente", headline: "Copom reduz Selic em 0,25 p.p., para 13,75% ao ano", explainer: "Juro menor barateia o crédito.", topics: ["juros"], reason: "decisão de juros" }),
  );
  const w = new ClaudeWriter({ model: "claude-opus-5-5", effort: "low", editorialPath: editorial, client });
  const draft = await w.write(item, { source, recent: [] });
  assert.deepEqual(draft, {
    publish: true,
    urgency: "urgente",
    headline: "Copom reduz Selic em 0,25 p.p., para 13,75% ao ano",
    explainer: "Juro menor barateia o crédito.",
    topics: ["juros"],
    reason: "decisão de juros",
    method: "ia",
  });
  const req = requests[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.deepEqual(req.thinking, { type: "adaptive" });
  assert.equal(req.output_config.effort, "low");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(req.fallbacks, "default");
  assert.match(req.system, /<linha-editorial>\nPrioridade: juros\.\n<\/linha-editorial>/);
  assert.match(req.messages[0].content, /<fonte>\nO Copom decidiu/);
});

test("Haiku requests carry no fallback parameter", async () => {
  const { client, requests } = fakeClient(ok({ publish: false, urgency: "normal", headline: "", explainer: "", topics: [], reason: "x" }));
  const w = new ClaudeWriter({ model: "claude-haiku-5-5", effort: "low", editorialPath: editorial, client });
  await w.write(item, { source, recent: [] });
  assert.equal(requests[0].fallbacks, undefined);
  assert.equal(requests[0].betas, undefined);
});

test("an empty explainer becomes null", async () => {
  const { client } = fakeClient(ok({ publish: true, urgency: "alta", headline: "H", explainer: "  ", topics: [], reason: "" }));
  const w = new ClaudeWriter({ model: "claude-opus-5-5", effort: "low", editorialPath: editorial, client });
  assert.equal((await w.write(item, { source, recent: [] }))?.explainer, null);
});

test("a refusal yields no draft", async () => {
  const { client } = fakeClient({ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null }, content: [] });
  const w = new ClaudeWriter({ model: "claude-opus-5-5", effort: "low", editorialPath: editorial, client });
  assert.equal(await w.write(item, { source, recent: [] }), null);
});

test("a cut-off response is an error, so the item is retried", async () => {
  const { client } = fakeClient({ stop_reason: "max_tokens", stop_details: null, content: [] });
  const w = new ClaudeWriter({ model: "claude-opus-5-5", effort: "low", editorialPath: editorial, client });
  await assert.rejects(w.write(item, { source, recent: [] }), /max_tokens/);
});

test("without AI, the source title is shown as a draft", async () => {
  const d = await new DraftWriter().write({ ...item, lang: "en", title: "Fed holds rates" });
  assert.equal(d?.headline, "[EN] Fed holds rates");
  assert.equal(d?.method, "rascunho");
});
