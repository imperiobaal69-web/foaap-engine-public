import test from "node:test";
import assert from "node:assert/strict";
import {portfolioWalkthrough} from "../examples/portfolio-walkthrough.mjs";
test("the public walkthrough preserves both commitments and a supersession edge",()=>{
  const stages=portfolioWalkthrough();
  assert.equal(stages.length,3);
  assert.equal(stages[1].nextAction.kind,"resolve");
  assert.equal(stages[2].model.claims.length,2);
  const latest=stages[2].model.claims.find(c=>c.id==="claim-december");
  assert.equal(latest.derived_from[0].id,"claim-october");
  assert.equal(latest.derived_from[0].relation,"supersedes");
  assert.notEqual(stages[2].nextAction.kind,"resolve");
});
