// =============================================================================

import { semanticBondViews } from "./bonds.js";
//  Engine model — the UNIVERSAL GRAMMAR of FOAAP, server-side.
//
//  FOAAP turns raw inputs from LLM workflows into structured, coherent,
//  stateful models. The grammar is domain-agnostic:
//
//    event          — a raw input that entered the space (immutable log)
//    claim          — an assertion that matters: statement + interpretation +
//                     kind (commitment | constraint | definition | insight)
//    decision       — an explicit committed choice
//    contradiction  — two claims in conflict, with severity + evidence trail
//    semantic bond  — subject/relation/object with conserved support,
//                     opposition, predictions, outcomes, context, and validity
//    node           — an active workstream in the space's graph
//    next_action    — what the state says should happen next
//
//  The DOMAIN enters only through the ontology (engine/ontology.js): axes,
//  catalog, projection hints. Every function here is pure: (model, input) →
//  mutated copy. No I/O, no env, no clock — callers pass ts.
//
//  normalizeModel() upgrades legacy venture-shaped models (cream_cards,
//  pillars, activated_subnodes…) on read, so old spaces keep working
//  without a data migration.
// =============================================================================

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newModel({ name = null, ontology = "venture", lens = null, axes = [] } = {}) {
  const nodes = {};
  for (const a of axes) nodes[a.id] = [];
  return {
    version: 3,
    ontology,
    profile: { name, one_liner: null, phase: null, lens },
    claims: [],
    decisions: [],
    contradictions: [],
    bonds: [],
    nodes,
    events: [],
    journal: [],
  };
}

// ---- legacy upgrade: venture-shaped v1 models → universal grammar -----------
const LEGACY_KIND = { decision: "commitment", restriction: "constraint", definition: "definition", insight: "insight" };

export function normalizeModel(raw, axes = []) {
  const m = raw && typeof raw === "object" ? raw : {};
  if (m.version >= 2 && Array.isArray(m.claims)) {
    m.version = 3;
    if (!m.nodes || typeof m.nodes !== "object") m.nodes = {};
    for (const a of axes) if (!m.nodes[a.id]) m.nodes[a.id] = [];
    if (!Array.isArray(m.bonds)) m.bonds = [];
    return m;
  }
  const p = m.profile || {};
  const out = newModel({ name: p.venture_name || p.name || null, ontology: m.ontology || "venture", lens: p.archetype || p.lens || null, axes });
  out.claims = (m.cream_cards || m.claims || []).filter(Boolean).map((c) => ({
    id: c.id || uid("c"),
    axis: c.pillar || c.axis || null,
    node: c.subnode || c.node || null,
    statement: c.founder_statement || c.statement || "",
    interpretation: c.maestro_context || c.interpretation || "",
    kind: LEGACY_KIND[c.type] || c.kind || "insight",
    ts: c.ts || null,
    archived_at: c.archived_at || undefined,
    supersedes: c.supersedes || undefined,
  }));
  out.decisions = (m.decisions || []).filter(Boolean).map((d) => ({
    id: d.id, text: d.text, axis: d.pillar || d.axis || null, confidence: d.confidence || "high", source: d.source || "legacy", ts: d.ts,
  }));
  out.contradictions = m.contradictions || [];
  out.bonds = Array.isArray(m.bonds) ? m.bonds : [];
  out.events = m.events || [];
  out.journal = m.synthesis_journal || m.journal || [];
  const legacyNodes = m.activated_subnodes || m.nodes || {};
  for (const axis of Object.keys(legacyNodes)) {
    if (!out.nodes[axis]) out.nodes[axis] = [];
    for (const n of legacyNodes[axis] || []) {
      if (!n) continue;
      out.nodes[axis].push({
        id: n.id,
        catalog_id: n.pattern_id || n.catalog_id || null,
        axis: n.pillar || n.axis || axis,
        label: n.label || n.id,
        source: n.source || (n.pattern_id ? "catalog" : "emergent"),
        status: String(n.status || "ACTIVE").toUpperCase(),
        activated_at: n.activated_at || null,
        why_now: n.why_now || null,
        first_question: n.first_question || null,
        archived_at: n.archived_at || undefined,
      });
    }
  }
  return out;
}

// ---- mutations ---------------------------------------------------------------
export function appendEvent(model, { kind, type = null, text = "", payload = null, ts }) {
  const ev = { id: uid("ev"), ts, kind, type, text: String(text).slice(0, 600), payload };
  model.events = [...(model.events || []), ev];
  return ev;
}

export function addClaim(model, { axis, node, statement, interpretation, kind = "insight", derived_from = null, source_atom_ids = null, ts }) {
  const claim = {
    id: uid("c"),
    axis: axis || null,
    node: String(node || "").slice(0, 80) || null,
    statement: String(statement || "").slice(0, 600),
    interpretation: String(interpretation || "").slice(0, 1000),
    kind,
    ts,
  };
  if (Array.isArray(source_atom_ids) && source_atom_ids.length) {
    claim.source_atom_ids = [...new Set(source_atom_ids.map((id) => String(id).slice(0, 120)).filter(Boolean))];
  }
  // Lineage: what this claim compounded from. [{id, relation, confidence?, why?, via?}]
  // relation: "refines" (judged at ingest) | "supersedes" (via resolved contradiction)
  // why = the judge's one-sentence intention — an arrow must explain itself.
  if (Array.isArray(derived_from) && derived_from.length) {
    claim.derived_from = derived_from.map((e) => ({
      id: e.id,
      relation: e.relation === "supersedes" ? "supersedes" : "refines",
      ...(typeof e.confidence === "number" ? { confidence: e.confidence } : {}),
      ...(e.why ? { why: String(e.why).slice(0, 300) } : {}),
      ...(e.via ? { via: e.via } : {}),
    }));
  }
  model.claims = [...(model.claims || []), claim];
  return claim;
}

// Resolution creates the supersede edge: the winning side (b) of a resolved
// contradiction now derives from the losing side (a). This is where the
// "title" stops being lossy — the replacement is RECORDED, not implied by sort.
export function recordSupersede(model, contradiction, ts) {
  const a = contradiction?.source_ids?.a;
  const b = contradiction?.source_ids?.b;
  if (!a?.id || !b?.id) return null;
  // why = the HUMAN's resolution reason — the strongest intention there is.
  const edge = {
    id: a.id, relation: "supersedes", via: contradiction.id, ts,
    ...(contradiction.resolved_reason ? { why: String(contradiction.resolved_reason).slice(0, 300) } : {}),
  };
  const stamp = (list) => (list || []).map((x) => {
    if (!x || x.id !== b.id) return x;
    const prior = Array.isArray(x.derived_from) ? x.derived_from : [];
    if (prior.some((e) => e && e.id === a.id && e.relation === "supersedes")) return x;
    return { ...x, derived_from: [...prior, edge] };
  });
  if (b.type === "decision") model.decisions = stamp(model.decisions);
  else model.claims = stamp(model.claims);
  return edge;
}

// Apply externally-judged verdicts (the sovereign path: THEIR model judged the
// docket, our grammar records the outcome). Pure: no I/O, no LLM. Each verdict
// references existing objects by id; invalid ones are reported, never guessed.
//   verdicts: [{a_id, b_id, relation: "contradicts"|"refines"|"unrelated",
//               confidence, severity?, why}]
// Gates mirror the reference judge adapter: contradicts ≥ 0.7, refines ≥ 0.6,
// and why is REQUIRED — an arrow that cannot explain itself is not recorded.
export function applyVerdicts(model, verdicts, ts) {
  const byId = new Map();
  for (const c of model.claims || []) if (c) byId.set(c.id, { obj: c, type: "claim", list: "claims" });
  for (const d of model.decisions || []) if (d) byId.set(d.id, { obj: d, type: "decision", list: "decisions" });

  const contradictions = [];
  const lineage = [];
  const skipped = [];
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    const relation = v?.relation;
    if (relation === "unrelated") continue;
    const a = byId.get(v?.a_id);
    const b = byId.get(v?.b_id);
    const confidence = typeof v?.confidence === "number" ? Math.round(v.confidence * 100) / 100 : null;
    const why = String(v?.why || "").trim();
    const fail = (reason) => skipped.push({ a_id: v?.a_id || null, b_id: v?.b_id || null, relation: relation || null, reason });
    if (!a || !b) { fail("unknown a_id or b_id"); continue; }
    if (!why) { fail("why is required — an arrow must explain itself"); continue; }
    if (relation === "contradicts") {
      if (confidence === null || confidence < 0.7) { fail("contradicts needs confidence >= 0.7"); continue; }
      const dup = (model.contradictions || []).find((c) => c && !c.resolved_at
        && c.source_ids?.a?.id === v.a_id && c.source_ids?.b?.id === v.b_id);
      if (dup) { fail(`already open as ${dup.id}`); continue; }
      contradictions.push(addContradiction(model, {
        claim_a: a.obj.statement || a.obj.text,
        claim_b: b.obj.statement || b.obj.text,
        severity: ["high", "medium", "low"].includes(v.severity) ? v.severity : "medium",
        confidence, why,
        source: "external_verdict",
        source_ids: {
          a: { type: a.type, id: v.a_id, axis: a.obj.axis || null },
          b: { type: b.type, id: v.b_id, axis: b.obj.axis || null },
        },
        trail: [
          { ts: a.obj.ts || null, kind: a.type, axis: a.obj.axis || null, text: String(a.obj.statement || a.obj.text || "").slice(0, 280) },
          { ts: b.obj.ts || null, kind: b.type, axis: b.obj.axis || null, text: String(b.obj.statement || b.obj.text || "").slice(0, 280) },
        ],
        axes: a.obj.axis && b.obj.axis
          ? (a.obj.axis === b.obj.axis ? a.obj.axis : `${a.obj.axis} ↔ ${b.obj.axis}`)
          : null,
        ts,
      }));
    } else if (relation === "refines") {
      if (confidence === null || confidence < 0.6) { fail("refines needs confidence >= 0.6"); continue; }
      const prior = Array.isArray(b.obj.derived_from) ? b.obj.derived_from : [];
      if (prior.some((e) => e && e.id === v.a_id)) { fail("edge already recorded"); continue; }
      const edge = { id: v.a_id, relation: "refines", confidence, why: why.slice(0, 300) };
      const stamped = { ...b.obj, derived_from: [...prior, edge] };
      model[b.list] = model[b.list].map((x) => (x && x.id === v.b_id ? stamped : x));
      byId.set(v.b_id, { ...b, obj: stamped });
      lineage.push({ from: v.b_id, to: v.a_id, ...edge });
    } else {
      fail(`unknown relation "${relation}"`);
    }
  }
  return { contradictions, lineage, skipped };
}

// Walk a claim/decision's ancestry: head → derived_from ids → their ancestors.
// Returns { chain, contradictions, events } — everything that made it compound.
export function claimLineage(model, refId, { maxDepth = 12 } = {}) {
  const byId = new Map();
  for (const c of model.claims || []) if (c) byId.set(c.id, { ...c, ref_type: "claim" });
  for (const d of model.decisions || []) if (d) byId.set(d.id, { ...d, ref_type: "decision" });
  const head = byId.get(refId);
  if (!head) return null;

  const chain = [];
  const seen = new Set();
  const queue = [{ id: refId, depth: 0, relation: null, via: null }];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur.id) || cur.depth > maxDepth) continue;
    seen.add(cur.id);
    const item = byId.get(cur.id);
    if (!item) continue;
    chain.push({
      id: item.id,
      ref_type: item.ref_type,
      axis: item.axis || null,
      text: item.statement || item.text || "",
      kind: item.kind || null,
      ts: item.ts || null,
      relation_to_child: cur.relation,
      via_contradiction: cur.via,
      archived: !!item.archived_at,
    });
    for (const e of item.derived_from || []) {
      if (e && e.id) queue.push({ id: e.id, depth: cur.depth + 1, relation: e.relation || "refines", via: e.via || null });
    }
  }

  const ids = new Set(chain.map((x) => x.id));
  const contradictions = (model.contradictions || []).filter(
    (c) => c && (ids.has(c.source_ids?.a?.id) || ids.has(c.source_ids?.b?.id))
  );
  const events = (model.events || []).filter((ev) => {
    const u = ev?.payload?.understood;
    if (!u) return false;
    return (u.claims || []).some((id) => ids.has(id)) || (u.decisions || []).some((id) => ids.has(id));
  }).map((ev) => ({ id: ev.id, ts: ev.ts, kind: ev.kind, type: ev.type, text: ev.text }));

  return { head: refId, chain, contradictions, events };
}

export function addDecision(model, { text, axis = null, confidence = "high", source = "engine_api", source_atom_ids = null, ts }) {
  const decision = {
    id: uid("d"),
    text: String(text || "").slice(0, 600),
    axis, confidence, source, ts,
  };
  if (Array.isArray(source_atom_ids) && source_atom_ids.length) {
    decision.source_atom_ids = [...new Set(source_atom_ids.map((id) => String(id).slice(0, 120)).filter(Boolean))];
  }
  model.decisions = [...(model.decisions || []), decision];
  return decision;
}

export function addContradiction(model, { kind = "claim_conflict", axes = null, claim_a, claim_b, severity, confidence, why = null, source = "engine_ingest", source_ids = null, trail = [], ts }) {
  const entry = {
    id: uid("ct"),
    ts, kind, axes,
    claim_a: String(claim_a || "").slice(0, 400),
    claim_b: String(claim_b || "").slice(0, 400),
    text: `${String(claim_a || "").slice(0, 160)} ⇄ ${String(claim_b || "").slice(0, 160)}`,
    severity: severity || "medium",
    confidence: typeof confidence === "number" ? confidence : null,
    why: why ? String(why).slice(0, 300) : null,
    source,
    source_ids,
    trail,
  };
  model.contradictions = [...(model.contradictions || []), entry];
  return entry;
}

export function resolveContradiction(model, contradictionId, reason, ts) {
  let found = null;
  model.contradictions = (model.contradictions || []).map((c) => {
    if (c && c.id === contradictionId && !c.resolved_at) {
      found = { ...c, resolved_at: ts, resolved_reason: String(reason || "").slice(0, 300) };
      return found;
    }
    return c;
  });
  return found;
}

export function addNode(model, ontology, { axis, label, catalog_id = null, why_now = null, source_atom_ids = null, ts }) {
  const canon = catalog_id ? ontology.catalog.find((p) => p.id === catalog_id) : null;
  const ax = canon ? canon.axis : axis;
  if (!ontology.axes.some((a) => a.id === ax)) return null;
  const id = canon
    ? canon.id
    : `${String(label || "node").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)}-${Math.random().toString(36).slice(2, 6)}`;
  const existing = (model.nodes?.[ax] || []).find((n) => n && n.id === id && !n.archived_at);
  if (existing) return existing;
  const node = {
    id,
    catalog_id: canon ? canon.id : null,
    axis: ax,
    label: canon ? canon.label : String(label || "").slice(0, 80),
    source: canon ? "catalog" : "emergent",
    status: "ACTIVE",
    activated_at: ts,
    why_now: why_now ? String(why_now).slice(0, 300) : null,
    first_question: canon ? canon.first_question : null,
  };
  if (Array.isArray(source_atom_ids) && source_atom_ids.length) {
    node.source_atom_ids = [...new Set(source_atom_ids.map((id) => String(id).slice(0, 120)).filter(Boolean))];
  }
  model.nodes = { ...model.nodes, [ax]: [...(model.nodes?.[ax] || []), node] };
  return node;
}

// ---- next action --------------------------------------------------------------
// Priority: unresolved contradiction → mature active node → first empty axis → keep.
export function deriveNextAction(model, ontology, now = Date.now()) {
  const contras = (model.contradictions || []).filter((c) => c && !c.resolved_at);
  if (contras.length) {
    const rank = { high: 3, medium: 2, low: 1 };
    const top = [...contras].sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0) || (b.ts || 0) - (a.ts || 0))[0];
    return {
      kind: "resolve",
      label: `Resolve contradiction: ${String(top.claim_b || top.text || "").slice(0, 80)}`,
      ref: top.id,
      why: `Unresolved ${top.severity} contradiction — the model holds two incompatible claims.`,
    };
  }
  const bondViews = semanticBondViews(model, now);
  const overdue = (model.bonds || [])
    .flatMap((bond) => (bond.predictions || [])
      .filter((prediction) => prediction.status === "open" && prediction.due_at !== null && prediction.due_at <= now)
      .map((prediction) => ({ bond, prediction })))
    .sort((a, b) => (a.prediction.due_at || 0) - (b.prediction.due_at || 0))[0];
  if (overdue) {
    return {
      kind: "observe",
      label: `Record outcome: ${String(overdue.prediction.statement || "").slice(0, 80)}`,
      ref: overdue.bond.id,
      prediction_ref: overdue.prediction.id,
      why: "A semantic prediction is due; compounding requires reality to return to the bond.",
    };
  }
  const contested = bondViews
    .filter((bond) => bond.applicability === "active" && bond.status === "contested")
    .sort((a, b) => (b.strength.total_signals || 0) - (a.strength.total_signals || 0))[0];
  if (contested) {
    return {
      kind: "investigate_bond",
      label: `Investigate: ${contested.subject?.label || "?"} ${contested.relation || "?"} ${contested.object?.label || "?"}`,
      ref: contested.id,
      why: "The bond holds both support and opposition; gather context or outcome evidence before relying on it.",
    };
  }
  const claims = (model.claims || []).filter((c) => c && !c.archived_at);
  for (const a of ontology.axes) {
    for (const n of model.nodes?.[a.id] || []) {
      if (!n || n.archived_at || n.status === "COMPLETED") continue;
      const count = claims.filter((c) => (c.node || "").toLowerCase() === (n.label || "").toLowerCase()).length;
      if (count >= 2) {
        return { kind: "complete", label: `Complete ${n.label}`, ref: n.id, why: `${count} claims banked — ready to close out.` };
      }
    }
  }
  for (const a of ontology.axes) {
    const active = (model.nodes?.[a.id] || []).some((n) => n && !n.archived_at);
    if (!active) {
      return { kind: "open", label: `Open ${a.label}`, ref: a.id, why: `No active workstream in ${a.label} yet.` };
    }
  }
  return { kind: "keep", label: "Keep going", ref: null, why: "All axes active, nothing blocked." };
}
