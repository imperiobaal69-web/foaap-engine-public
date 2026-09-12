import assert from "node:assert/strict";
import { test } from "node:test";
import { atomizeText, semanticCoverage } from "../engine/coverage.js";
import { freshSemanticDrafts, freshSemanticRefs } from "../engine/semantic.js";
import { addClaim, addDecision, newModel } from "../engine/model.js";

test("atomization preserves every meaningful source span without silent truncation", () => {
  const text = "Pricing is €29. We launch in October.\n\nThe team sounded optimistic.";
  const atoms = atomizeText(text);
  assert.equal(atoms.length, 3);
  assert.deepEqual(atoms.map((atom) => atom.text), [
    "Pricing is €29.",
    "We launch in October.",
    "The team sounded optimistic.",
  ]);
  assert.equal(new Set(atoms.map((atom) => atom.id)).size, atoms.length);
});

test("semantic coverage requires every atom to become structure or an explicit residual", () => {
  const sourceAtoms = [
    { id: "a1", text: "Pricing is €29." },
    { id: "a2", text: "We launch in October." },
    { id: "a3", text: "The team sounded optimistic." },
  ];
  const complete = semanticCoverage({
    sourceAtoms,
    claims: [{ statement: "Pricing is €29", source_atom_ids: ["a1"] }],
    decisions: [{ text: "Launch in October", source_atom_ids: ["a2"] }],
    residuals: [{ source_atom_id: "a3", reason: "Tone, not canonical state." }],
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.ratio, 1);
  assert.equal(complete.projected_atoms, 2);
  assert.equal(complete.residual_atoms, 1);

  const bondCoverage = semanticCoverage({
    sourceAtoms,
    bonds: [{
      subject: "pricing",
      relation: "affects",
      object: "conversion",
      source_atom_ids: ["a1"],
      evidence: [{ polarity: "support", statement: "Observed pricing test", source_atom_ids: ["a2"] }],
    }],
    residuals: [{ source_atom_id: "a3", reason: "Tone." }],
  });
  assert.equal(bondCoverage.status, "complete");
  assert.equal(bondCoverage.ratio, 1);

  const incomplete = semanticCoverage({
    sourceAtoms,
    claims: [{ statement: "Pricing is €29", source_atom_ids: ["a1", "missing"] }],
  });
  assert.equal(incomplete.status, "incomplete");
  assert.deepEqual(incomplete.unaccounted_atom_ids, ["a2", "a3"]);
  assert.deepEqual(incomplete.invalid_source_refs, ["missing"]);
});

test("mixed extraction sends both decisions and claims into judging and the docket", () => {
  const extracted = {
    decisions: [{ axis: "product", text: "Launch in October" }],
    claims: [{ axis: "capital", statement: "Runway is eight months" }],
  };
  const drafts = freshSemanticDrafts(extracted, 123);
  assert.deepEqual(drafts.map((item) => item.ref_type), ["decision", "claim"]);
  assert.deepEqual(drafts.map((item) => item.text), ["Launch in October", "Runway is eight months"]);

  const refs = freshSemanticRefs({
    decisions: [{ id: "d1", text: "Launch in October" }],
    claims: [{ id: "c1", statement: "Runway is eight months" }],
  });
  assert.deepEqual(refs.map((item) => item.id), ["d1", "c1"]);
});

test("molecules retain the source atoms that produced them", () => {
  const model = newModel();
  const claim = addClaim(model, {
    axis: "product",
    statement: "Pricing is €29",
    interpretation: "Launch price",
    source_atom_ids: ["a1", "a1"],
    ts: 1,
  });
  const decision = addDecision(model, {
    axis: "product",
    text: "Launch in October",
    source_atom_ids: ["a2"],
    ts: 2,
  });
  assert.deepEqual(claim.source_atom_ids, ["a1"]);
  assert.deepEqual(decision.source_atom_ids, ["a2"]);
});
