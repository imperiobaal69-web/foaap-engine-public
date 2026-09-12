import assert from "node:assert/strict";
import {
  newModel, addClaim, applyVerdicts, deriveNextAction,
  resolveContradiction, recordSupersede, claimLineage,
} from "../engine/model.js";
import { getOntology } from "../engine/ontology.js";

// Synthetic commitments. No model call, credential or persistence is involved.
const ontology = getOntology("venture");
const model = newModel({ axes: ontology.axes });
const ts = Date.UTC(2026, 0, 1);
const first = addClaim(model, { axis: "product", statement: "Launch on 1 March.", kind: "commitment", ts });
const second = addClaim(model, { axis: "product", statement: "Launch on 1 June instead.", kind: "commitment", ts: ts + 1 });

const result = applyVerdicts(model, [{
  a_id: first.id, b_id: second.id, relation: "contradicts", confidence: 0.98,
  severity: "high", why: "These are different exclusive launch dates for the same release.",
}], ts + 2);

assert.equal(result.contradictions.length, 1);
assert.equal(deriveNextAction(model, ontology).kind, "resolve");
console.log("Before resolution: conflicting commitments → next action is resolve.");

const conflict = result.contradictions[0];
resolveContradiction(model, conflict.id, "The team selected the June date after reviewing readiness.", ts + 3);
recordSupersede(model, model.contradictions.find((item) => item.id === conflict.id), ts + 3);
const lineage = claimLineage(model, second.id);
assert.equal(lineage.chain.length, 2);
console.log("After resolution: the June commitment retains its connection to the March commitment.");
console.log(JSON.stringify({
  openContradictions: model.contradictions.filter((item) => !item.resolved_at).length,
  preservedClaims: model.claims.length,
  lineage: lineage.chain.map((item) => ({ statement: item.text, relation: item.relation_to_child || "current" })),
  nextAction: deriveNextAction(model, ontology).kind,
}, null, 2));
