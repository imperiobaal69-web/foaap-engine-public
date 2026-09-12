// =============================================================================
//  Pair judge — contradiction detection + lineage classification.
//
//  This file is two things at once:
//    1. The reference implementation the engine runs server-side (managed and
//       BYOK modes) — one batched LLM call over the (new x pool) pairs.
//    2. The published judge adapter (JUDGE_ADAPTER below, served at /adapters):
//       the exact instructions a caller's own model runs client-side in
//       sovereign mode. Both paths use the same prompt and the same gates, so
//       verdicts arrive in one shape no matter which model produced them.
//
//  The discriminator is the simultaneity test, not a doubt-bias: "refines" is
//  only legal when A and B can be fully true at the same time. Without that
//  gate a model smooths real conflicts into refinements, which hides the
//  conflict instead of surfacing it. Fixed 2026-07-12; changing it changes what
//  the lineage means, so bump JUDGE_ADAPTER.version with it.
//
//  Confidence gates: contradicts >= 0.7, refines >= 0.6. Both relations are
//  asked for a one-sentence "why", and JUDGE_ADAPTER advertises why_required.
//  Note the asymmetry: applyVerdicts() rejects a submitted verdict with no why,
//  but this path does not — it records `why: null` and keeps the verdict.
//
//  The candidate pool is curated by the caller (semantic neighbors over the
//  full history plus a deterministic same-axis floor). Every pair is judged.
//  Large pools are chunked rather than truncated, and a batch that returns the
//  wrong number of verdicts or unparseable JSON throws — a detector that
//  silently drops pairs reports a clean state it never checked.
// =============================================================================

const HOUSE_KEY = process.env.ANTHROPIC_API_KEY || "";

async function fetchT(url, opts, ms = 30_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

const DETECT_MODEL = "claude-haiku-4-5-20251001";
const MAX_PAIRS_PER_CALL = 48;
const MIN_CONFIDENCE = 0.7;
const MIN_REFINE_CONFIDENCE = 0.6;

const SYSTEM = `You judge the RELATION between claims recorded in a project's canonical state.

For each pair (A = existing, B = new), classify the relation:
- "contradicts" — A and B make incompatible assertions about the SAME OBJECT/CHOICE. E.g. "we manufacture in Colombia" vs "we manufacture in Mexico". "8 months of budget" vs "12 months of budget". An explicit update/replacement ("we are MOVING from X to Y") still contradicts the earlier committed claim — the old commitment is now stale and a human must resolve it.
- "refines" — B is a refinement, elaboration, or more specific version of A. E.g. "target LatAm" then "target B2B mid-market in LatAm".
- "unrelated" — A and B describe DIFFERENT things, even if thematically related.

THE SIMULTANEITY TEST (mandatory before answering "refines"): can A and B both be FULLY TRUE at the same time? If yes, "refines" (or "unrelated"). If no — if accepting B means A is no longer fully true — the relation is "contradicts", no matter how soft or incremental B sounds. Never use "refines" to smooth over a conflict.

Rules:
- Confidence is 0.0-1.0. Only report "contradicts" with confidence >= 0.7 and "refines" with confidence >= 0.6. When in doubt between refines and unrelated, choose unrelated.
- why: ONE sentence justifying the verdict. REQUIRED for "contradicts" and "refines" — a verdict that cannot explain itself will be discarded.
- severity applies to "contradicts" only: high = load-bearing for the work (core commitments, structure, money, time, scope). medium = strategic but recoverable. low = drift.

You receive numbered PAIRS. Output STRICTLY this JSON, one entry per pair, same order:
{ "verdicts": [ { "pair": 1, "relation": "contradicts"|"refines"|"unrelated", "confidence": 0.0-1.0, "severity": "high"|"medium"|"low"|null, "why": "1 sentence or null" } ] }`;

// The published protocol artifact — what any vendor model runs in sovereign
// mode. Version bumps whenever SYSTEM or the gates change.
export const JUDGE_ADAPTER = {
  id: "judge",
  version: "2026-07-12",
  purpose: "Classify each (existing, new) pair as contradicts / refines / unrelated, with confidence and a one-sentence why.",
  system: SYSTEM,
  gates: { contradicts_min_confidence: MIN_CONFIDENCE, refines_min_confidence: MIN_REFINE_CONFIDENCE, why_required: true },
  submit_to: "POST /api/v1/spaces/:id/verdicts  { verdicts: [{ a_id, b_id, relation, confidence, severity?, why }] }",
};

function claimText(item) {
  return String(item.text || "").slice(0, 280);
}

// existing: [{ref_type, ref_id, axis, text, ts}], fresh: same shape (no id yet ok)
// apiKey: the model key to judge with — the BUILDER's key in BYOK mode; the
// house key only survives for local dogfood.
// Returns { contradictions, lineage }:
//   contradictions — same shape the ingest pipeline always consumed
//   lineage        — [{ existing: {type,id,axis}, fresh_text, relation, confidence, why }]
export async function judgePairs({ existing, fresh, apiKey = HOUSE_KEY }) {
  if (!apiKey || !existing.length || !fresh.length) return { contradictions: [], lineage: [] };
  const pairs = [];
  for (const f of fresh) {
    for (const e of existing) pairs.push({ e, f });
  }
  if (!pairs.length) return { contradictions: [], lineage: [] };

  const contradictions = [];
  const lineage = [];
  for (let offset = 0; offset < pairs.length; offset += MAX_PAIRS_PER_CALL) {
    const batch = pairs.slice(offset, offset + MAX_PAIRS_PER_CALL);
    const user = batch
      .map((p, i) => `PAIR ${i + 1}:\nA (existing ${p.e.ref_type}${p.e.axis ? ` · ${p.e.axis}` : ""}): "${claimText(p.e)}"\nB (new ${p.f.ref_type}${p.f.axis ? ` · ${p.f.axis}` : ""}): "${claimText(p.f)}"`)
      .join("\n\n");

    const r = await fetchT("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DETECT_MODEL,
        max_tokens: 3500,
        temperature: 0.2,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) throw new Error(`judge batch ${Math.floor(offset / MAX_PAIRS_PER_CALL) + 1} failed with ${r.status}; no pairs were silently skipped`);
    const out = await r.json().catch(() => null);
    const raw = out?.content?.find((b) => b.type === "text")?.text || "";
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```(json)?\s*/i, "").replace(/\s*```$/, ""));
    } catch {
      throw new Error(`judge batch ${Math.floor(offset / MAX_PAIRS_PER_CALL) + 1} returned invalid JSON; no pairs were silently skipped`);
    }
    const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
    if (verdicts.length !== batch.length) {
      throw new Error(`judge batch ${Math.floor(offset / MAX_PAIRS_PER_CALL) + 1} returned ${verdicts.length}/${batch.length} verdicts; no partial judgment was accepted`);
    }

    for (const v of verdicts) {
      const idx = (v.pair || 0) - 1;
      const pair = batch[idx];
      if (!pair) continue;
      const relation = v.relation || (v.contradiction ? "contradicts" : "unrelated");
      const confidence = Math.round((v.confidence || 0) * 100) / 100;
      const why = String(v.why || v.explanation || "").trim() || null;
      if (relation === "refines" && confidence >= MIN_REFINE_CONFIDENCE && pair.e.ref_id) {
        lineage.push({
          existing: { type: pair.e.ref_type, id: pair.e.ref_id, axis: pair.e.axis || null },
          fresh_text: claimText(pair.f),
          relation: "refines",
          confidence,
          why,
        });
        continue;
      }
      if (relation !== "contradicts" || confidence < MIN_CONFIDENCE) continue;
      contradictions.push({
        claim_a: claimText(pair.e),
        claim_b: claimText(pair.f),
        severity: v.severity || "medium",
        confidence,
        why,
        explanation: why,
        source_ids: {
          a: { type: pair.e.ref_type, id: pair.e.ref_id || null, axis: pair.e.axis || null },
          b: { type: pair.f.ref_type, id: pair.f.ref_id || null, axis: pair.f.axis || null },
        },
        trail: [
          { ts: pair.e.ts || null, kind: pair.e.ref_type, axis: pair.e.axis || null, text: claimText(pair.e) },
          { ts: pair.f.ts || null, kind: pair.f.ref_type, axis: pair.f.axis || null, text: claimText(pair.f) },
        ],
        axes: pair.e.axis && pair.f.axis
          ? (pair.e.axis === pair.f.axis ? pair.e.axis : `${pair.e.axis} ↔ ${pair.f.axis}`)
          : null,
      });
    }
  }
  return { contradictions, lineage };
}

// Back-compat wrapper — same contract the ingest pipeline consumed before
// lineage existed. Kept so nothing external breaks mid-migration.
export async function detectContradictions({ existing, fresh }) {
  const { contradictions } = await judgePairs({ existing, fresh });
  return contradictions;
}
