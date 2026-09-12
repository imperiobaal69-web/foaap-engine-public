import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addSemanticBond,
  addBondEvidence,
  addBondPrediction,
  recordBondOutcome,
  getSemanticBond,
  semanticBondView,
} from "../engine/bonds.js";
import { deriveNextAction, newModel } from "../engine/model.js";
import { getOntology } from "../engine/ontology.js";

const TS = 1_700_000_000_000;
const ONT = getOntology("venture");

test("semantic strength grows monotonically while the evidence balance remains revisable", () => {
  const model = newModel({ axes: ONT.axes });
  const created = addSemanticBond(model, {
    subject: "advertising spend",
    relation: "increases",
    object: "sales",
    context: { saturation: "low" },
    source_atom_ids: ["a1"],
    support: [{
      statement: "Campaign A increased sales.",
      independence_key: "campaign-a",
      source_atom_ids: ["a1"],
    }],
  }, TS);

  assert.equal(created.created, true);
  assert.equal(created.view.status, "supported");
  assert.equal(created.view.strength.total_signals, 1);

  const opposed = addBondEvidence(model, created.bond.id, {
    polarity: "opposition",
    statement: "Campaign B increased spend but sales declined.",
    independence_key: "campaign-b",
    source_atom_ids: ["a2"],
  }, TS + 1);
  assert.equal(opposed.view.status, "contested");
  assert.equal(opposed.view.strength.total_signals, 2);
  assert.equal(opposed.view.strength.support_signals, 1);
  assert.equal(opposed.view.strength.opposition_signals, 1);
  assert.equal(opposed.view.strength.balance, 0);

  const duplicate = addBondEvidence(model, created.bond.id, {
    polarity: "opposition",
    statement: "Campaign B increased spend but sales declined.",
    independence_key: "campaign-b",
    source_atom_ids: ["a2"],
  }, TS + 2);
  assert.equal(duplicate.evidence, null);
  assert.equal(duplicate.view.strength.total_signals, 2, "repeated evidence is conserved once, not mistaken for independence");
});

test("predictions close through observed outcomes and outcomes become evidence", () => {
  const model = newModel({ axes: ONT.axes });
  const { bond } = addSemanticBond(model, {
    subject: "usage-based pricing",
    relation: "improves",
    object: "conversion",
  }, TS);
  const prediction = addBondPrediction(model, bond.id, {
    key: "pricing-test",
    statement: "Conversion exceeds 8%",
    success_criteria: "conversion_rate > 0.08",
    due_at: TS + 10,
    source_atom_ids: ["p1"],
  }, TS + 1);

  const next = deriveNextAction(model, ONT, TS + 11);
  assert.equal(next.kind, "observe");
  assert.equal(next.ref, bond.id);
  assert.equal(next.prediction_ref, prediction.prediction.id);

  const result = recordBondOutcome(model, bond.id, {
    id: "out_pricing",
    prediction_key: "pricing-test",
    observed: "Conversion reached 9.4%.",
    result: "confirmed",
    source_atom_ids: ["o1"],
  }, TS + 12);
  assert.equal(result.prediction.status, "observed");
  assert.equal(result.view.strength.confirmed_outcomes, 1);
  assert.equal(result.view.strength.support_signals, 1);
  assert.equal(result.view.strength.total_signals, 1);
  assert.equal(getSemanticBond(model, bond.id, TS + 12).outcomes[0].id, "out_pricing");
});

test("refuted outcomes strengthen opposition instead of deleting the relationship", () => {
  const model = newModel({ axes: ONT.axes });
  const { bond } = addSemanticBond(model, {
    subject: "community-led growth",
    relation: "reduces",
    object: "acquisition cost",
    support: [{ statement: "Pilot suggested lower CAC.", independence_key: "pilot-1" }],
  }, TS);
  const before = semanticBondView(bond, TS);
  const outcome = recordBondOutcome(model, bond.id, {
    id: "out_cac",
    observed: "CAC increased by 18%.",
    result: "refuted",
  }, TS + 1);

  assert.equal(before.strength.total_signals, 1);
  assert.equal(outcome.view.strength.total_signals, 2);
  assert.equal(outcome.view.strength.opposition_signals, 1);
  assert.equal(outcome.view.status, "contested");
  assert.equal(model.bonds.length, 1, "the bond remains present");
});

test("temporal validity changes applicability without removing historical evidence", () => {
  const model = newModel({ axes: ONT.axes });
  const { bond } = addSemanticBond(model, {
    subject: "manufacturing",
    relation: "located in",
    object: "Colombia",
    valid_from: TS,
    valid_until: TS + 100,
    support: [{ statement: "The Medellín contract was signed.", independence_key: "contract-1" }],
  }, TS);

  assert.equal(semanticBondView(bond, TS + 50).applicability, "active");
  assert.equal(semanticBondView(bond, TS + 101).applicability, "expired");
  assert.equal(semanticBondView(bond, TS + 101).strength.total_signals, 1);
});
