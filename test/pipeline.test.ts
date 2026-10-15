import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import { Hub } from "../src/hub.ts";
import { Pipeline } from "../src/pipeline.ts";
import type { Publisher } from "../src/publishers/index.ts";
import type { Writer } from "../src/writer/ai.ts";
import type { Draft, Headline, RawItem, Source } from "../src/types.ts";

function item(id: string, title: string, minutesAgo = 0, body = title): RawItem {
  return {
    sourceId: "fake",
    externalId: id,
    url: `https://example.gov/${id}`,
    title,
    body,
    publishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    lang: "pt",
  };
}

function fakeSource(batches: RawItem[][]): Source {
  let i = 0;
  return { id: "fake", name: "Fonte de teste", tag: "BCB", region: "BR", intervalMs: 1000, poll: async () => batches[Math.min(i++, batches.length - 1)] };
}

class FakeWriter implements Writer {
  readonly enabled = true;
  readonly model = "fake";
  calls = 0;
  failNext = false;
  draft: (i: RawItem) => Draft = (i) => ({ publish: true, urgency: "urgente", headline: i.title, explainer: null, topics: ["juros"], reason: "", method: "ia" });
  async write(i: RawItem): Promise<Draft | null> {
    this.calls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("API fora do ar");
    }
    return this.draft(i);
  }
  async explain(): Promise<string | null> {
    return null;
  }
}

class FakePublisher implements Publisher {
  readonly name = "fake";
  readonly live = true;
  sent: Headline[] = [];
  async publish(h: Headline) {
    this.sent.push(h);
  }
}

function setup(batches: RawItem[][]) {
  const store = new Store(":memory:");
  const hub = new Hub(60_000);
  const writer = new FakeWriter();
  const pub = new FakePublisher();
  const events: string[] = [];
  const send = hub.send.bind(hub);
  hub.send = (event, data) => {
    events.push(event);
    send(event, data);
  };
  const p = new Pipeline({ store, writer, hub, publishers: [pub], minUrgency: "alta", backfillPerSource: 2, showReview: false, aiConcurrency: 2 });
  return { store, hub, writer, pub, events, p, src: fakeSource(batches) };
}

test("first run shows only the latest items as history and posts nothing to social networks", async () => {
  const { p, src, store, pub, writer, hub } = setup([[item("1", "Um", 30), item("2", "Dois", 20), item("3", "Três", 10)]]);
  const out = await p.runOnce(src);
  assert.deepEqual(out.map((h) => h.headline), ["Dois", "Três"]);
  assert.ok(out.every((h) => h.backfill));
  assert.equal(writer.calls, 2);
  assert.equal(pub.sent.length, 0);
  assert.equal(store.latest(10).length, 2);
  hub.close();
});

test("new items after the first run are published, sent to social networks and never repeated", async () => {
  const first = [item("1", "Um", 30)];
  const second = [item("1", "Um", 30), item("2", "Copom reduz Selic para 13,75%", 0)];
  const { p, src, pub, writer, events, hub } = setup([first, second, second]);
  await p.runOnce(src);
  const out = await p.runOnce(src);
  assert.equal(out.length, 1);
  assert.equal(out[0].backfill, false);
  assert.equal(pub.sent.length, 1);
  assert.ok(events.includes("headline"));
  await p.runOnce(src);
  assert.equal(writer.calls, 2, "an item already seen is not written again");
  hub.close();
});

test("a headline with a number not found in the source goes to review and is not posted", async () => {
  const { p, src, pub, writer, store, hub } = setup([[item("0", "Antigo", 60)], [item("0", "Antigo", 60), item("9", "Copom decide", 0, "Copom reduz a Selic para 13,75% a.a.")]]);
  await p.runOnce(src);
  writer.draft = () => ({ publish: true, urgency: "urgente", headline: "Copom reduz Selic para 13,50%", explainer: null, topics: [], reason: "", method: "ia" });
  const [h] = await p.runOnce(src);
  assert.equal(h.status, "revisar");
  assert.match(h.reviewReason ?? "", /13,50/);
  assert.equal(pub.sent.length, 0);
  assert.equal(store.latest(10).length, 1, "only the backfilled item is public");
  hub.close();
});

test("items the writer rejects are not published", async () => {
  const { p, src, store, writer, hub } = setup([[item("1", "Evento institucional", 5)]]);
  writer.draft = () => ({ publish: false, urgency: "normal", headline: "", explainer: null, topics: [], reason: "sem relevância", method: "ia" });
  assert.deepEqual(await p.runOnce(src), []);
  assert.equal(store.latest(10).length, 0);
  hub.close();
});

test("a failed write is retried on the next poll", async () => {
  const batch = [item("0", "Antigo", 60)];
  const { p, src, writer, store, hub } = setup([batch, [...batch, item("5", "Nota nova", 0)], [...batch, item("5", "Nota nova", 0)]]);
  await p.runOnce(src);
  writer.failNext = true;
  assert.deepEqual(await p.runOnce(src), []);
  const out = await p.runOnce(src);
  assert.deepEqual(out.map((h) => h.headline), ["Nota nova"]);
  assert.equal(store.latest(10).length, 2);
  hub.close();
});
