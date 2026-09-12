// Unit tests for the pure engine core — `npm test` (node:test, zero deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newModel, normalizeModel, appendEvent, addClaim, addDecision, addContradiction,
  addNode, resolveContradiction, deriveNextAction, recordSupersede, claimLineage, applyVerdicts,
} from "../engine/model.js";
import { getOntology } from "../engine/ontology.js";

const TS = 1700000000000;
const ONT = getOntology("venture");

test("newModel has the universal-grammar shape", () => {
  const m = newModel({ name: "X", ontology: "venture", lens: "b2b-saas", axes: ONT.axes });
  assert.equal(m.version, 3);
  assert.equal(m.ontology, "venture");
  assert.equal(m.profile.name, "X");
  assert.equal(m.profile.lens, "b2b-saas");
  for (const a of ONT.axes) assert.ok(Array.isArray(m.nodes[a.id]));
  assert.deepEqual(m.claims, []);
  assert.deepEqual(m.contradictions, []);
  assert.deepEqual(m.bonds, []);
});

test("normalizeModel upgrades a legacy venture model", () => {
  const legacy = {
    version: 1,
    profile: { venture_name: "OldCo", archetype: "hardware-physical" },
    cream_cards: [{ id: "c_1", pillar: "product", subnode: "Supply", founder_statement: "we build X", maestro_context: "why", type: "restriction", ts: TS }],
    decisions: [{ id: "d_1", text: "go", pillar: "capital", confidence: "high", ts: TS }],
    activated_subnodes: { product: [{ id: "funding-strategy", pattern_id: "funding-strategy", pillar: "capital", label: "Funding", status: "ACTIVE" }] },
    contradictions: [],
    synthesis_journal: [{ state_line: "x" }],
  };
  const m = normalizeModel(legacy, ONT.axes);
  assert.equal(m.version, 3);
  assert.equal(m.profile.name, "OldCo");
  assert.equal(m.profile.lens, "hardware-physical");
  assert.equal(m.claims[0].statement, "we build X");
  assert.equal(m.claims[0].interpretation, "why");
  assert.equal(m.claims[0].kind, "constraint");   // restriction → constraint
  assert.equal(m.claims[0].axis, "product");
  assert.equal(m.decisions[0].axis, "capital");
  assert.equal(m.journal.length, 1);
  assert.deepEqual(m.bonds, []);
  const node = m.nodes.product[0];
  assert.equal(node.catalog_id, "funding-strategy");
});

test("mutations append with ids and clamp lengths", () => {
  const m = newModel({ axes: ONT.axes });
  const ev = appendEvent(m, { kind: "ingest", type: "message", text: "x".repeat(9999), ts: TS });
  assert.match(ev.id, /^ev_/);
  assert.equal(ev.text.length, 600);
  const c = addClaim(m, { axis: "product", node: "Pricing", statement: "s", interpretation: "ctx", kind: "definition", ts: TS });
  assert.match(c.id, /^c_/);
  const d = addDecision(m, { text: "go", axis: "capital", ts: TS });
  assert.equal(d.confidence, "high");
  assert.equal(m.events.length, 1);
  assert.equal(m.claims.length, 1);
  assert.equal(m.decisions.length, 1);
});

test("contradiction lifecycle: add → resolve", () => {
  const m = newModel({ axes: ONT.axes });
  const ct = addContradiction(m, { claim_a: "A", claim_b: "B", severity: "high", confidence: 0.9, ts: TS });
  assert.match(ct.id, /^ct_/);
  assert.equal(m.contradictions.filter((c) => !c.resolved_at).length, 1);
  const r = resolveContradiction(m, ct.id, "chose B", TS + 1);
  assert.equal(r.resolved_reason, "chose B");
  assert.equal(m.contradictions.filter((c) => !c.resolved_at).length, 0);
  assert.equal(resolveContradiction(m, ct.id, "again", TS + 2), null, "double-resolve returns null");
});

test("node activation: catalog vs emergent, idempotent per id", () => {
  const m = newModel({ axes: ONT.axes });
  const canon = addNode(m, ONT, { axis: "capital", label: "whatever", catalog_id: "funding-strategy", ts: TS });
  assert.equal(canon.source, "catalog");
  assert.equal(canon.axis, "capital");
  const emer = addNode(m, ONT, { axis: "product", label: "Data As Vehicles", why_now: "core wedge", ts: TS });
  assert.equal(emer.source, "emergent");
  assert.equal(emer.catalog_id, null);
  const again = addNode(m, ONT, { axis: "capital", label: "x", catalog_id: "funding-strategy", ts: TS + 5 });
  assert.equal(again.id, canon.id, "re-activation returns the existing node");
});

test("deriveNextAction priority: resolve > complete > open > keep", () => {
  const m = newModel({ axes: ONT.axes });
  assert.equal(deriveNextAction(m, ONT).kind, "open");
  const node = addNode(m, ONT, { axis: "foundations", label: "Legal Entity", catalog_id: "legal-entity-structure", ts: TS });
  addClaim(m, { axis: "foundations", node: "Legal Entity Structure", statement: "a", interpretation: "", ts: TS });
  addClaim(m, { axis: "foundations", node: "Legal Entity Structure", statement: "b", interpretation: "", ts: TS });
  const complete = deriveNextAction(m, ONT);
  assert.equal(complete.kind, "complete");
  assert.equal(complete.ref, node.id);
  const ct = addContradiction(m, { claim_a: "A", claim_b: "B", severity: "high", ts: TS });
  assert.equal(deriveNextAction(m, ONT).kind, "resolve");
  assert.equal(deriveNextAction(m, ONT).ref, ct.id);
  resolveContradiction(m, ct.id, "done", TS + 1);
  assert.equal(deriveNextAction(m, ONT).kind, "complete");
});

test("lineage: refine edges at addClaim, supersede edge at resolution, full walk", () => {
  const m = newModel({ axes: ONT.axes });
  const v1 = addClaim(m, { axis: "product", statement: "target LatAm", interpretation: "", kind: "commitment", ts: TS });
  const v2 = addClaim(m, {
    axis: "product", statement: "target B2B mid-market in LatAm", interpretation: "", kind: "commitment",
    derived_from: [{ id: v1.id, relation: "refines", confidence: 0.85 }], ts: TS + 1,
  });
  assert.equal(v2.derived_from[0].id, v1.id);
  assert.equal(v2.derived_from[0].relation, "refines");

  const ct = addContradiction(m, {
    claim_a: "target B2B mid-market in LatAm", claim_b: "target enterprise in Mexico only",
    severity: "high", confidence: 0.95,
    source_ids: { a: { type: "claim", id: v2.id, axis: "product" }, b: { type: "claim", id: null, axis: "product" } },
    ts: TS + 2,
  });
  const v3 = addClaim(m, { axis: "product", statement: "target enterprise in Mexico only", interpretation: "", kind: "commitment", ts: TS + 2 });
  ct.source_ids.b.id = v3.id;
  resolveContradiction(m, ct.id, "founder chose Mexico", TS + 3);
  const edge = recordSupersede(m, m.contradictions.find((c) => c.id === ct.id), TS + 3);
  assert.equal(edge.id, v2.id);
  assert.equal(edge.relation, "supersedes");
  assert.equal(edge.via, ct.id);

  const lin = claimLineage(m, v3.id);
  assert.equal(lin.chain.length, 3, "v3 → v2 → v1");
  assert.deepEqual(lin.chain.map((x) => x.id), [v3.id, v2.id, v1.id]);
  assert.equal(lin.chain[1].relation_to_child, "supersedes");
  assert.equal(lin.chain[1].via_contradiction, ct.id);
  assert.equal(lin.chain[2].relation_to_child, "refines");
  assert.equal(lin.contradictions.length, 1);
  assert.equal(claimLineage(m, "c_nope"), null);
});

test("lineage: supersede edge stamps decisions too and is idempotent", () => {
  const m = newModel({ axes: ONT.axes });
  const d1 = addDecision(m, { text: "raise 500k", axis: "capital", ts: TS });
  const d2 = addDecision(m, { text: "raise 1M", axis: "capital", ts: TS + 1 });
  const ct = addContradiction(m, {
    claim_a: "raise 500k", claim_b: "raise 1M", severity: "high", confidence: 0.9,
    source_ids: { a: { type: "decision", id: d1.id, axis: "capital" }, b: { type: "decision", id: d2.id, axis: "capital" } },
    ts: TS + 1,
  });
  resolveContradiction(m, ct.id, "chose 1M", TS + 2);
  recordSupersede(m, m.contradictions[0], TS + 2);
  recordSupersede(m, m.contradictions[0], TS + 3);
  const winner = m.decisions.find((d) => d.id === d2.id);
  assert.equal(winner.derived_from.length, 1, "edge is not duplicated");
  assert.equal(winner.derived_from[0].id, d1.id);
  const lin = claimLineage(m, d2.id);
  assert.deepEqual(lin.chain.map((x) => x.id), [d2.id, d1.id]);
});

test("applyVerdicts: sovereign judging through the grammar", () => {
  const m = newModel({ axes: ONT.axes });
  const a = addDecision(m, { text: "raise 500k", axis: "capital", ts: TS });
  const b = addDecision(m, { text: "raise 1M", axis: "capital", ts: TS + 1 });
  const c1 = addClaim(m, { axis: "product", statement: "target LatAm", interpretation: "", ts: TS });
  const c2 = addClaim(m, { axis: "product", statement: "target B2B mid-market in LatAm", interpretation: "", ts: TS + 1 });

  const out = applyVerdicts(m, [
    { a_id: a.id, b_id: b.id, relation: "contradicts", confidence: 0.95, severity: "high", why: "500k and 1M cannot both be true" },
    { a_id: c1.id, b_id: c2.id, relation: "refines", confidence: 0.9, why: "adds segment detail; both fully true" },
    { a_id: a.id, b_id: c2.id, relation: "unrelated", confidence: 0.9, why: "different objects" },
    { a_id: "d_nope", b_id: b.id, relation: "contradicts", confidence: 0.9, why: "x" },
    { a_id: c1.id, b_id: c2.id, relation: "refines", confidence: 0.9 },
    { a_id: a.id, b_id: b.id, relation: "contradicts", confidence: 0.5, why: "too unsure" },
  ], TS + 2);

  assert.equal(out.contradictions.length, 1);
  assert.equal(out.contradictions[0].severity, "high");
  assert.equal(out.contradictions[0].why, "500k and 1M cannot both be true");
  assert.equal(out.contradictions[0].source, "external_verdict");
  assert.equal(out.contradictions[0].trail.length, 2);
  assert.equal(out.lineage.length, 1);
  assert.equal(out.lineage[0].to, c1.id);
  assert.equal(out.lineage[0].why, "adds segment detail; both fully true");
  const stamped = m.claims.find((x) => x.id === c2.id);
  assert.equal(stamped.derived_from[0].id, c1.id);
  assert.equal(out.skipped.length, 3, "unknown id + missing why + low confidence");

  // Idempotency: same verdicts again → everything dedupes, nothing doubles.
  const again = applyVerdicts(m, [
    { a_id: a.id, b_id: b.id, relation: "contradicts", confidence: 0.95, severity: "high", why: "dup" },
    { a_id: c1.id, b_id: c2.id, relation: "refines", confidence: 0.9, why: "dup" },
  ], TS + 3);
  assert.equal(again.contradictions.length, 0);
  assert.equal(again.lineage.length, 0);
  assert.equal(m.contradictions.length, 1);
  assert.equal(m.claims.find((x) => x.id === c2.id).derived_from.length, 1);
});

test("applyVerdicts feeds lineage: refine edge shows up in claimLineage with why", () => {
  const m = newModel({ axes: ONT.axes });
  const c1 = addClaim(m, { axis: "product", statement: "v1", interpretation: "", ts: TS });
  const c2 = addClaim(m, { axis: "product", statement: "v2", interpretation: "", ts: TS + 1 });
  applyVerdicts(m, [{ a_id: c1.id, b_id: c2.id, relation: "refines", confidence: 0.8, why: "narrows scope" }], TS + 1);
  const lin = claimLineage(m, c2.id);
  assert.deepEqual(lin.chain.map((x) => x.id), [c2.id, c1.id]);
  assert.equal(lin.chain[1].relation_to_child, "refines");
});
