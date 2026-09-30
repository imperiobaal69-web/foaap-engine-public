import assert from "node:assert/strict";
import { test } from "node:test";
import { judgePairs } from "../engine/contradict.js";

function mockJudge(t, getVerdicts) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ verdicts: getVerdicts() }) }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function judgeTwoPairs() {
  return judgePairs({
    existing: [
      { ref_type: "claim", ref_id: "a1", text: "First existing claim" },
      { ref_type: "claim", ref_id: "a2", text: "Second existing claim" },
    ],
    fresh: [{ ref_type: "claim", ref_id: "b", text: "New claim" }],
    apiKey: "test-key",
  });
}

test("judge reads every candidate pair by batching instead of truncating the pool", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const batchSizes = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const user = request.messages[0].content;
    const count = (user.match(/^PAIR \d+:/gm) || []).length;
    batchSizes.push(count);
    return new Response(JSON.stringify({
      content: [{
        type: "text",
        text: JSON.stringify({
          verdicts: Array.from({ length: count }, (_, index) => ({
            pair: index + 1,
            relation: "unrelated",
            confidence: 0.99,
            severity: null,
            why: "Different objects.",
          })),
        }),
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const existing = Array.from({ length: 49 }, (_, index) => ({
    ref_type: "claim",
    ref_id: `existing_${index + 1}`,
    axis: "product",
    text: `Existing claim ${index + 1}`,
    ts: index,
  }));
  const fresh = [{
    ref_type: "claim",
    ref_id: null,
    axis: "product",
    text: "Fresh claim",
    ts: 100,
  }];

  const result = await judgePairs({ existing, fresh, apiKey: "test-key" });
  assert.deepEqual(batchSizes, [48, 1]);
  assert.deepEqual(result, { contradictions: [], lineage: [] });
});

test("judge rejects partial model output rather than accepting silent blind spots", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{
      type: "text",
      text: JSON.stringify({
        verdicts: [{ pair: 1, relation: "unrelated", confidence: 0.9, why: "Different objects." }],
      }),
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  await assert.rejects(
    judgePairs({
      existing: [
        { ref_type: "claim", ref_id: "a1", axis: "product", text: "A1" },
        { ref_type: "claim", ref_id: "a2", axis: "product", text: "A2" },
      ],
      fresh: [{ ref_type: "claim", axis: "product", text: "B" }],
      apiKey: "test-key",
    }),
    /returned 1\/2 verdicts; no partial judgment was accepted/,
  );
});

test("judge rejects duplicate pair IDs even when the verdict count matches", async (t) => {
  mockJudge(t, () => [
    { pair: 1, relation: "contradicts", confidence: 0.9, why: "Conflicting claims." },
    { pair: 1, relation: "unrelated", confidence: 0.9, why: "Different objects." },
  ]);

  await assert.rejects(judgeTwoPairs(), /duplicate pair ID 1; no partial judgment was accepted/);
});

test("judge rejects missing, non-integer and out-of-range pair IDs", async (t) => {
  let invalidVerdict;
  mockJudge(t, () => [
    { pair: 1, relation: "unrelated", confidence: 0.9, why: "Different objects." },
    invalidVerdict,
  ]);

  for (const entry of [null, {}, { pair: null }, { pair: "2" }, { pair: 1.5 }, { pair: 0 }, { pair: -1 }, { pair: 3 }]) {
    invalidVerdict = entry;
    await assert.rejects(judgeTwoPairs(), /invalid pair ID .*; expected an integer from 1 to 2/,
      `must reject ${JSON.stringify(entry)}`);
  }
});

test("judge accepts a complete reordered batch and maps verdicts by pair ID", async (t) => {
  mockJudge(t, () => [
    { pair: 2, relation: "contradicts", confidence: 0.9, why: "Second claim conflicts." },
    { pair: 1, relation: "refines", confidence: 0.9, why: "First claim is refined." },
  ]);

  const result = await judgeTwoPairs();
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.contradictions[0].source_ids.a.id, "a2");
  assert.equal(result.contradictions[0].source_ids.b.id, "b");
  assert.equal(result.lineage.length, 1);
  assert.equal(result.lineage[0].existing.id, "a1");
});
