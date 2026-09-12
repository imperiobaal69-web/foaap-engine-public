// =============================================================================
//  Semantic bonds — domain-neutral compounding grammar.
//
//  A bond is not a mutable "truth score". It is a conserved relationship with
//  separate support, opposition, predictions, and observed outcomes. Evidence
//  only accumulates; the derived view (supported / opposed / contested and
//  temporal applicability) may change as the network learns.
// =============================================================================

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function text(value, max = 600) {
  return String(value || "").trim().slice(0, max);
}

function refs(value) {
  return [...new Set(
    (Array.isArray(value) ? value : []).map((id) => text(id, 120)).filter(Boolean),
  )];
}

function jsonValue(value, depth = 0) {
  if (depth > 4 || value == null) return value == null ? null : text(value, 300);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => jsonValue(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      out[text(key, 80)] = jsonValue(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  return text(value, 600);
}

function entity(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = text(value.id, 160);
    const label = text(value.label || value.name || value.id, 300);
    return {
      ...(id ? { id } : {}),
      label,
      ...(value.type ? { type: text(value.type, 100) } : {}),
    };
  }
  return { label: text(value, 300) };
}

function entityKey(value) {
  const e = entity(value);
  return `${e.type || ""}:${e.id || e.label}`.toLowerCase();
}

function contextKey(value) {
  const context = jsonValue(value || {});
  if (!context || typeof context !== "object") return String(context || "");
  return JSON.stringify(Object.fromEntries(Object.entries(context).sort(([a], [b]) => a.localeCompare(b))));
}

function bondKey(input) {
  return [
    entityKey(input?.subject),
    text(input?.relation, 120).toLowerCase(),
    entityKey(input?.object),
    contextKey(input?.context),
  ].join("|");
}

function timeValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceKey(item) {
  return [
    item.polarity,
    item.independence_key || "",
    item.statement || "",
    (item.source_atom_ids || []).join(","),
  ].join("|");
}

function normalizeEvidence(input, polarity, ts) {
  const sourceAtomIds = refs(input?.source_atom_ids);
  const independenceKey = text(
    input?.independence_key
      || input?.source_id
      || (sourceAtomIds.length ? `atoms:${sourceAtomIds.join(",")}` : ""),
    240,
  );
  return {
    id: text(input?.id, 120) || uid("evi"),
    polarity,
    statement: text(input?.statement || input?.why, 600),
    why: text(input?.why || input?.statement, 600) || null,
    source_atom_ids: sourceAtomIds,
    source_id: text(input?.source_id, 200) || null,
    independence_key: independenceKey || null,
    independence_verified: !!independenceKey,
    authority: input?.authority ? jsonValue(input.authority) : null,
    observed_at: timeValue(input?.observed_at),
    ts,
  };
}

function addEvidenceToBond(bond, input, polarity, ts) {
  const item = normalizeEvidence(input, polarity, ts);
  const list = polarity === "opposition" ? "opposition" : "support";
  const prior = Array.isArray(bond[list]) ? bond[list] : [];
  const key = evidenceKey(item);
  if (prior.some((entry) => evidenceKey(entry) === key)) return null;
  bond[list] = [...prior, item];
  bond.updated_at = ts;
  return item;
}

function normalizePrediction(input, ts) {
  return {
    id: text(input?.id, 120) || uid("pred"),
    key: text(input?.key, 160) || null,
    statement: text(input?.statement || input?.expected, 600),
    success_criteria: text(input?.success_criteria, 600) || null,
    due_at: timeValue(input?.due_at),
    context: jsonValue(input?.context || {}),
    source_atom_ids: refs(input?.source_atom_ids),
    status: "open",
    ts,
  };
}

function normalizeOutcome(input, ts) {
  const result = ["confirmed", "refuted", "mixed", "inconclusive"].includes(input?.result)
    ? input.result
    : "inconclusive";
  return {
    id: text(input?.id, 120) || uid("out"),
    prediction_id: text(input?.prediction_id, 120) || null,
    prediction_key: text(input?.prediction_key, 160) || null,
    observed: text(input?.observed || input?.statement, 1000),
    result,
    context: jsonValue(input?.context || {}),
    source_atom_ids: refs(input?.source_atom_ids),
    authority: input?.authority ? jsonValue(input.authority) : null,
    observed_at: timeValue(input?.observed_at) || ts,
    ts,
  };
}

export function semanticBondView(bond, now = Date.now()) {
  const support = Array.isArray(bond?.support) ? bond.support : [];
  const opposition = Array.isArray(bond?.opposition) ? bond.opposition : [];
  const outcomes = Array.isArray(bond?.outcomes) ? bond.outcomes : [];
  const independentSupport = new Set(support.map((item) => item.independence_key).filter(Boolean));
  const independentOpposition = new Set(opposition.map((item) => item.independence_key).filter(Boolean));
  const supportSignals = support.length;
  const oppositionSignals = opposition.length;
  const totalSignals = supportSignals + oppositionSignals;
  const verifiedSignals = independentSupport.size + independentOpposition.size;
  const effectiveSupport = verifiedSignals ? independentSupport.size : supportSignals;
  const effectiveOpposition = verifiedSignals ? independentOpposition.size : oppositionSignals;
  const effectiveTotal = effectiveSupport + effectiveOpposition;
  let status = "unresolved";
  if (supportSignals && oppositionSignals) status = "contested";
  else if (supportSignals) status = "supported";
  else if (oppositionSignals) status = "opposed";

  const validFrom = timeValue(bond?.valid_from);
  const validUntil = timeValue(bond?.valid_until);
  let applicability = "active";
  if (validFrom !== null && now < validFrom) applicability = "future";
  else if (validUntil !== null && now > validUntil) applicability = "expired";

  return {
    id: bond?.id || null,
    subject: bond?.subject || null,
    relation: bond?.relation || null,
    object: bond?.object || null,
    context: bond?.context || {},
    valid_from: validFrom,
    valid_until: validUntil,
    status,
    applicability,
    strength: {
      total_signals: totalSignals,
      support_signals: supportSignals,
      opposition_signals: oppositionSignals,
      independent_support: independentSupport.size,
      independent_opposition: independentOpposition.size,
      unverified_support: support.filter((item) => !item.independence_key).length,
      unverified_opposition: opposition.filter((item) => !item.independence_key).length,
      confirmed_outcomes: outcomes.filter((item) => item.result === "confirmed").length,
      refuted_outcomes: outcomes.filter((item) => item.result === "refuted").length,
      balance: effectiveTotal ? (effectiveSupport - effectiveOpposition) / effectiveTotal : 0,
    },
    predictions_open: (bond?.predictions || []).filter((item) => item.status === "open").length,
    outcomes: outcomes.length,
    created_at: bond?.created_at || null,
    updated_at: bond?.updated_at || null,
  };
}

export function ensureSemanticLayer(model) {
  if (!Array.isArray(model.bonds)) model.bonds = [];
  model.bonds = model.bonds.filter(Boolean).map((bond) => ({
    ...bond,
    support: Array.isArray(bond.support) ? bond.support : [],
    opposition: Array.isArray(bond.opposition) ? bond.opposition : [],
    predictions: Array.isArray(bond.predictions) ? bond.predictions : [],
    outcomes: Array.isArray(bond.outcomes) ? bond.outcomes : [],
  }));
  return model;
}

export function addSemanticBond(model, input, ts) {
  ensureSemanticLayer(model);
  const relation = text(input?.relation, 120);
  const subject = entity(input?.subject);
  const object = entity(input?.object);
  if (!subject.label || !relation || !object.label) return null;
  const key = bondKey({ ...input, subject, relation, object });
  let bond = model.bonds.find((item) => item && item.key === key);
  const created = !bond;
  if (!bond) {
    bond = {
      id: text(input?.id, 120) || uid("sb"),
      key,
      subject,
      relation,
      object,
      context: jsonValue(input?.context || {}),
      valid_from: timeValue(input?.valid_from),
      valid_until: timeValue(input?.valid_until),
      source_atom_ids: refs(input?.source_atom_ids),
      support: [],
      opposition: [],
      predictions: [],
      outcomes: [],
      created_at: ts,
      updated_at: ts,
    };
    model.bonds = [...model.bonds, bond];
  } else {
    bond.source_atom_ids = [...new Set([...(bond.source_atom_ids || []), ...refs(input?.source_atom_ids)])];
    if (input?.valid_from != null) bond.valid_from = timeValue(input.valid_from);
    if (input?.valid_until != null) bond.valid_until = timeValue(input.valid_until);
    bond.updated_at = ts;
  }

  const evidence = Array.isArray(input?.evidence) ? input.evidence : [];
  for (const item of evidence) {
    const polarity = item?.polarity === "opposition" ? "opposition" : "support";
    addEvidenceToBond(bond, item, polarity, ts);
  }
  for (const item of Array.isArray(input?.support) ? input.support : []) addEvidenceToBond(bond, item, "support", ts);
  for (const item of Array.isArray(input?.opposition) ? input.opposition : []) addEvidenceToBond(bond, item, "opposition", ts);
  for (const prediction of Array.isArray(input?.predictions) ? input.predictions : []) {
    addBondPrediction(model, bond.id, prediction, ts);
  }
  for (const outcome of Array.isArray(input?.outcomes) ? input.outcomes : []) {
    recordBondOutcome(model, bond.id, outcome, ts);
  }
  return { bond, created, view: semanticBondView(bond, ts) };
}

export function addBondEvidence(model, bondId, input, ts) {
  ensureSemanticLayer(model);
  const bond = model.bonds.find((item) => item?.id === bondId);
  if (!bond) return null;
  const polarity = input?.polarity === "opposition" ? "opposition" : "support";
  const evidence = addEvidenceToBond(bond, input, polarity, ts);
  return evidence ? { bond, evidence, view: semanticBondView(bond, ts) } : { bond, evidence: null, view: semanticBondView(bond, ts) };
}

export function addBondPrediction(model, bondId, input, ts) {
  ensureSemanticLayer(model);
  const bond = model.bonds.find((item) => item?.id === bondId);
  if (!bond) return null;
  const prediction = normalizePrediction(input, ts);
  const duplicate = bond.predictions.find((item) =>
    (prediction.key && item.key === prediction.key)
    || (!prediction.key && item.statement === prediction.statement && item.status === "open"));
  if (duplicate) return { bond, prediction: duplicate, created: false, view: semanticBondView(bond, ts) };
  bond.predictions = [...bond.predictions, prediction];
  bond.updated_at = ts;
  return { bond, prediction, created: true, view: semanticBondView(bond, ts) };
}

export function recordBondOutcome(model, bondId, input, ts) {
  ensureSemanticLayer(model);
  const bond = model.bonds.find((item) => item?.id === bondId);
  if (!bond) return null;
  const outcome = normalizeOutcome(input, ts);
  const duplicate = bond.outcomes.find((item) => item.id === outcome.id);
  if (duplicate) return { bond, outcome: duplicate, created: false, view: semanticBondView(bond, ts) };

  let prediction = null;
  if (outcome.prediction_id) prediction = bond.predictions.find((item) => item.id === outcome.prediction_id);
  else if (outcome.prediction_key) prediction = bond.predictions.find((item) => item.key === outcome.prediction_key);
  if (prediction) {
    outcome.prediction_id = prediction.id;
    prediction.status = "observed";
    prediction.outcome_id = outcome.id;
  }
  bond.outcomes = [...bond.outcomes, outcome];
  bond.updated_at = ts;

  if (outcome.result === "confirmed" || outcome.result === "refuted") {
    addEvidenceToBond(bond, {
      statement: outcome.observed,
      why: `Observed outcome ${outcome.result} the bond${prediction ? ` prediction "${prediction.statement}"` : ""}.`,
      source_atom_ids: outcome.source_atom_ids,
      source_id: outcome.id,
      independence_key: `outcome:${outcome.id}`,
      authority: outcome.authority,
      observed_at: outcome.observed_at,
    }, outcome.result === "confirmed" ? "support" : "opposition", ts);
  }
  return { bond, outcome, prediction, created: true, view: semanticBondView(bond, ts) };
}

export function getSemanticBond(model, bondId, now = Date.now()) {
  ensureSemanticLayer(model);
  const bond = model.bonds.find((item) => item?.id === bondId);
  return bond ? { ...bond, view: semanticBondView(bond, now) } : null;
}

export function semanticBondViews(model, now = Date.now()) {
  ensureSemanticLayer(model);
  return model.bonds.map((bond) => semanticBondView(bond, now));
}
