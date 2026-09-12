import assert from "node:assert/strict";
import { test } from "node:test";
import { judgePairs } from "../engine/contradict.js";

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
