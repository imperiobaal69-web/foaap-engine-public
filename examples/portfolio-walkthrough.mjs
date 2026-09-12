import { newModel, addClaim, applyVerdicts, deriveNextAction, resolveContradiction, recordSupersede, claimLineage } from "../engine/model.js";
import { getOntology } from "../engine/ontology.js";
import assert from "node:assert/strict";

// Synthetic, reproducible state snapshots for the portfolio's read-only demo.
// IDs are fixed after creation solely to make this fixture reproducible.
export function portfolioWalkthrough() {
  const ontology = getOntology("venture");
  const model = newModel({name:"Northstar / pilot release",axes:ontology.axes});
  const ts = Date.UTC(2026,8,12,12);
  const snapshots=[];
  function snapshot(title, explanation, source) {
    snapshots.push(JSON.parse(JSON.stringify({title,explanation,source,model,nextAction:deriveNextAction(model,ontology,ts)})));
  }
  const first=addClaim(model,{axis:"product",node:"Pilot release",statement:"Launch the pilot on 1 October.",kind:"commitment",ts});
  first.id="claim-october";
  snapshot("A commitment enters the model", "A launch date becomes a claim with an identity, a workstream and a timestamp.", "Planning note / synthetic fixture");
  const second=addClaim(model,{axis:"product",node:"Pilot release",statement:"Launch the same pilot on 1 December instead.",kind:"commitment",ts:ts+1});
  second.id="claim-december";
  const result=applyVerdicts(model,[{a_id:first.id,b_id:second.id,relation:"contradicts",confidence:0.98,severity:"high",why:"The same pilot has two incompatible exclusive launch dates."}],ts+2);
  result.contradictions[0].id="conflict-launch";
  // The verdict is supplied by this fixture. No AI inference is simulated.
  assert.equal(deriveNextAction(model,ontology,ts).kind,"resolve");
  snapshot("A contradiction changes the next action", "Both commitments remain visible. An explicit fixture verdict records why they conflict; the engine prioritizes resolution.", "Revised planning note / synthetic fixture");
  resolveContradiction(model,"conflict-launch","The team selected December after reviewing pilot readiness.",ts+3);
  recordSupersede(model,model.contradictions.find(c=>c.id==="conflict-launch"),ts+3);
  assert.equal(claimLineage(model,second.id).chain.length,2);
  snapshot("A resolution preserves what came before", "The December commitment supersedes October through a recorded edge. The old claim and the reason for replacement remain inspectable.", "Resolution record / synthetic fixture");
  assert.equal(Boolean(snapshots[1].model.contradictions[0].resolved_at),false);
  assert.ok(snapshots[2].model.contradictions[0].resolved_at);
  return snapshots;
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1],"file:").href) console.log(JSON.stringify(portfolioWalkthrough(),null,2));
