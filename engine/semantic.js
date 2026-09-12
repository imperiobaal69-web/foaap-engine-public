// Pure shape transitions shared by ingest and tests. A mixed extraction must
// preserve every semantic citizen; claims never disappear because a decision
// happened to be present in the same input.

export function freshSemanticDrafts(extracted = {}, ts = null) {
  return [
    ...(Array.isArray(extracted.decisions) ? extracted.decisions : []).map((item) => ({
      ref_type: "decision",
      ref_id: null,
      axis: item.axis || null,
      text: item.text,
      ts,
    })),
    ...(Array.isArray(extracted.claims) ? extracted.claims : []).map((item) => ({
      ref_type: "claim",
      ref_id: null,
      axis: item.axis || null,
      text: item.statement,
      ts,
    })),
  ].filter((item) => String(item.text || "").trim());
}

export function freshSemanticRefs({ claims = [], decisions = [] } = {}) {
  return [
    ...decisions.map((item) => ({ id: item.id, type: "decision", text: item.text })),
    ...claims.map((item) => ({ id: item.id, type: "claim", text: item.statement })),
  ].filter((item) => item.id && String(item.text || "").trim());
}
