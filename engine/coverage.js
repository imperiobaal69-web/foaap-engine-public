// =============================================================================
//  Semantic conservation — nothing enters FOAAP and disappears silently.
//
//  source atom  → claim / decision / activation (projected)
//               → residual                         (preserved, intentionally
//                                                   not promoted to state)
//
//  The model may decide what an atom means. This module only enforces the
//  deterministic invariant: every supplied atom is accounted for exactly by
//  id, and every citation points to an atom that actually exists.
// =============================================================================

const MAX_ATOM_CHARS = 1200;

function cleanId(value) {
  return String(value || "").trim().slice(0, 120);
}

function cleanText(value) {
  return String(value || "").trim();
}

// Deterministic, lossless-enough segmentation for managed prose. Boundaries
// are paragraphs/sentences; long spans are chunked without dropping content.
// Whitespace is normalized, but every non-whitespace source token survives in
// exactly one atom.
export function atomizeText(text, { prefix = "atom", maxChars = MAX_ATOM_CHARS } = {}) {
  const source = cleanText(text);
  if (!source) return [];
  const spans = source
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ0-9])/u)
    .map((span) => span.trim())
    .filter(Boolean);
  const atoms = [];
  for (const span of spans) {
    let rest = span;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(" ", maxChars);
      if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
      atoms.push({ id: `${prefix}_${atoms.length + 1}`, text: rest.slice(0, cut).trim() });
      rest = rest.slice(cut).trim();
    }
    if (rest) atoms.push({ id: `${prefix}_${atoms.length + 1}`, text: rest });
  }
  return atoms;
}

export function normalizeSourceAtoms(input, { fallbackText = "", prefix = "atom" } = {}) {
  const raw = Array.isArray(input) && input.length ? input : atomizeText(fallbackText, { prefix });
  const atoms = [];
  const seen = new Set();
  for (const item of raw) {
    const id = cleanId(item?.id);
    const text = cleanText(item?.text);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    atoms.push({ id, text: text.slice(0, 16384) });
  }
  return atoms;
}

function refsOf(item) {
  const found = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (Array.isArray(value.source_atom_ids)) found.push(...value.source_atom_ids);
    for (const key of ["evidence", "support", "opposition", "predictions", "outcomes"]) {
      if (Array.isArray(value[key])) visit(value[key], depth + 1);
    }
  };
  visit(item);
  return [...new Set(found.map(cleanId).filter(Boolean))];
}

export function semanticCoverage({
  sourceAtoms = [],
  claims = [],
  decisions = [],
  activations = [],
  bonds = [],
  bondEvidence = [],
  predictions = [],
  outcomes = [],
  residuals = [],
} = {}) {
  const atomIds = new Set(sourceAtoms.map((atom) => cleanId(atom?.id)).filter(Boolean));
  if (!atomIds.size) {
    return {
      status: "unverified",
      source_atoms: 0,
      projected_atoms: 0,
      residual_atoms: 0,
      accounted_atoms: 0,
      ratio: null,
      unaccounted_atom_ids: [],
      invalid_source_refs: [],
    };
  }

  const projected = new Set();
  const invalid = new Set();
  for (const item of [...claims, ...decisions, ...activations, ...bonds, ...bondEvidence, ...predictions, ...outcomes]) {
    for (const id of refsOf(item)) {
      if (atomIds.has(id)) projected.add(id);
      else invalid.add(id);
    }
  }

  const residual = new Set();
  for (const item of residuals) {
    const id = cleanId(item?.source_atom_id);
    if (!id) continue;
    if (atomIds.has(id)) residual.add(id);
    else invalid.add(id);
  }

  const accounted = new Set([...projected, ...residual]);
  const unaccounted = [...atomIds].filter((id) => !accounted.has(id));
  return {
    status: unaccounted.length || invalid.size ? "incomplete" : "complete",
    source_atoms: atomIds.size,
    projected_atoms: projected.size,
    residual_atoms: residual.size,
    accounted_atoms: accounted.size,
    ratio: accounted.size / atomIds.size,
    unaccounted_atom_ids: unaccounted,
    invalid_source_refs: [...invalid],
  };
}

export function sourceRefs(input) {
  return refsOf(input);
}
