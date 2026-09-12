// =============================================================================
//  Extraction pass — the server-side "understand" verb, in two conceptual
//  stages collapsed into ONE LLM call:
//
//    1. UNIVERSAL GRAMMAR — the forced tool schema: claims (statement +
//       interpretation + kind), decisions, node activations. Domain-free.
//    2. ONTOLOGY PROJECTION — the selected ontology enters as DATA (axes,
//       projection hints, catalog), so the same grammar lands correctly in
//       venture, legal, health, or any future domain. Zero code per domain.
//
//  Deliberately NOT an agent loop: no persona, no streaming, one forced tool.
// =============================================================================

import { CLAIM_KINDS } from "./ontology.js";
import { normalizeSourceAtoms } from "./coverage.js";

const HOUSE_KEY = process.env.ANTHROPIC_API_KEY || "";

async function fetchT(url, opts, ms = 30_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

const EXTRACT_MODEL = "claude-sonnet-4-6";
export const MAX_EXTRACTION_SOURCE_CHARS = 48_000;

// The universal doctrine — FOAAP's spirit, domain-free.
const SYSTEM_BASE = `You are the extraction engine of FOAAP — the context and coherence layer underneath AI-powered work. FOAAP turns raw inputs from LLM workflows into structured, coherent, stateful models: instead of letting conversations, documents, agent runs, or tool outputs disappear into disconnected text, you capture what matters — claims, decisions, constraints, contradictions, evidence, and next actions.

You receive ONE raw input plus the current canonical state of its space. You extract STRUCTURE, nothing else. You never reply conversationally.

WHAT TO EXTRACT:
- claims — a concrete assertion that matters to the work (not speculation, not filler). statement = the assertion, lightly cleaned, faithful to the input. interpretation = one sentence: why it matters, what it connects to. kind: "commitment" (a choice being made) | "constraint" (a hard limit or obligation) | "definition" (what something IS) | "insight" (a load-bearing realization). node = a short Title Case label for the workstream this belongs to (reuse an existing active node label from the state when one fits).
- decisions — ONLY when the input explicitly commits to a choice ("we decided", "we're going with", "locked", "confirmed"). text = the commitment, standalone and specific. confidence: high if explicit, medium if strongly implied.
- activations — a NEW workstream this input opens that has no active node yet. Prefer a catalog_id when one clearly matches; otherwise emergent with a custom label. Do not re-activate labels already active. Activate sparingly — only themes with substance.
- bonds — an explicit reusable relationship: subject → relation → object. Use for causal, enabling, inhibiting, dependency, resource-flow, or predictive relationships that can accumulate evidence over time. Put current evidence in evidence[] as support or opposition. A bond is domain-neutral; do not invent one from mere co-occurrence.
- source atoms — the input is divided into labeled atoms. Every claim, decision, and activation MUST cite the atom ids it came from in source_atom_ids.
- residuals — an atom that should not become canonical state still MUST be returned here with its id and a short reason. An atom is never silently ignored.

RULES:
- Empty structure arrays are valid. Small talk, questions, or content-free atoms become residuals.
- Never invent facts not present in the input.
- A single input can yield both a claim and a decision (the decision IS claimable).
- Every supplied atom id must appear in at least one claim/decision/activation/bond source_atom_ids array (including nested bond evidence) or exactly once in residuals.
- Project every claim/decision/activation onto exactly one axis of THIS SPACE'S ONTOLOGY (below).`;

function ontologySection(ontology) {
  const axes = ontology.axes.map((a) => a.id).join(" | ");
  const catalog = ontology.catalog.map((p) => `${p.id} (${p.axis}): ${p.label}`).join("\n");
  return `ONTOLOGY FOR THIS SPACE — "${ontology.id}":
axes: ${axes}
projection rules: ${ontology.projection_hints}
CATALOG (for activations.catalog_id):
${catalog}`;
}

function buildTool(ontology) {
  const axisEnum = ontology.axes.map((a) => a.id);
  return {
    name: "record_understanding",
    description: "Record every claim, decision, and node activation extracted from the input. Call exactly once.",
    input_schema: {
      type: "object",
      properties: {
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              axis: { type: "string", enum: axisEnum },
              node: { type: "string" },
              statement: { type: "string" },
              interpretation: { type: "string" },
              kind: { type: "string", enum: CLAIM_KINDS },
              source_atom_ids: { type: "array", items: { type: "string" }, minItems: 1 },
            },
            required: ["axis", "node", "statement", "interpretation", "kind", "source_atom_ids"],
          },
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              axis: { type: "string", enum: axisEnum },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              source_atom_ids: { type: "array", items: { type: "string" }, minItems: 1 },
            },
            required: ["text", "axis", "confidence", "source_atom_ids"],
          },
        },
        activations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              axis: { type: "string", enum: axisEnum },
              label: { type: "string" },
              catalog_id: { type: "string" },
              why_now: { type: "string" },
              source_atom_ids: { type: "array", items: { type: "string" }, minItems: 1 },
            },
            required: ["axis", "label", "why_now", "source_atom_ids"],
          },
        },
        bonds: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subject: { type: "string" },
              relation: { type: "string" },
              object: { type: "string" },
              context: { type: "object" },
              valid_from: { type: "string" },
              valid_until: { type: "string" },
              source_atom_ids: { type: "array", items: { type: "string" }, minItems: 1 },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    polarity: { type: "string", enum: ["support", "opposition"] },
                    statement: { type: "string" },
                    why: { type: "string" },
                    independence_key: { type: "string" },
                    source_atom_ids: { type: "array", items: { type: "string" }, minItems: 1 },
                  },
                  required: ["polarity", "statement", "source_atom_ids"],
                },
              },
            },
            required: ["subject", "relation", "object", "source_atom_ids", "evidence"],
          },
        },
        residuals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source_atom_id: { type: "string" },
              reason: { type: "string" },
            },
            required: ["source_atom_id", "reason"],
          },
        },
      },
      required: ["claims", "decisions", "activations", "bonds", "residuals"],
    },
  };
}

function stateSummary(model, ontology) {
  const lines = [];
  const p = model.profile || {};
  if (p.name) lines.push(`space: ${p.name}`);
  if (p.lens) lines.push(`lens: ${p.lens}`);
  const active = [];
  for (const a of ontology.axes) {
    for (const n of model.nodes?.[a.id] || []) {
      if (n && !n.archived_at) active.push(`${n.label} [${a.id}/${n.status}]`);
    }
  }
  if (active.length) lines.push(`active nodes: ${active.join("; ")}`);
  const decs = (model.decisions || []).slice(-5);
  if (decs.length) lines.push(`recent decisions:\n${decs.map((d) => `  - ${String(d.text).slice(0, 160)}`).join("\n")}`);
  return lines.length ? lines.join("\n") : "(empty space — first input)";
}

// The published protocol artifact — the extraction instructions any vendor
// model runs in sovereign mode. The system prompt and tool schema are
// projected through the requested ontology, exactly as the server does it.
export function extractionAdapter(ontology) {
  return {
    id: "extraction",
    version: "2026-07-26",
    purpose: "Conserve source atoms into typed structure, semantic bonds, or explicit residuals in this space's ontology.",
    system: `${SYSTEM_BASE}\n\n${ontologySection(ontology)}`,
    tool_schema: buildTool(ontology),
    user_template: "CURRENT STATE:\n<state summary — GET /spaces/:id/context>\n\nSOURCE ATOMS:\n[atom_1] <source span>\n[atom_2] <source span>",
    submit_to: "POST /api/v1/spaces/:id/events  { source_atoms: [...], claims: [...], decisions: [...], activations: [...], bonds: [...], residuals: [...] }",
  };
}

// apiKey: the model key to extract with — the BUILDER's key in BYOK mode; the
// house key only survives for local dogfood.
export async function extractFromEvent({ model, event, ontology, apiKey = HOUSE_KEY }) {
  if (!apiKey) throw new Error("no model key for extraction — send structured claims/decisions or an X-Model-Key header (see /adapters)");
  const system = `${SYSTEM_BASE}\n\n${ontologySection(ontology)}`;
  const sourceAtoms = normalizeSourceAtoms(event.source_atoms, { fallbackText: event.text, prefix: "input" });
  const sourceText = sourceAtoms.map((atom) => `[${atom.id}] ${atom.text}`).join("\n\n");
  if (sourceText.length > MAX_EXTRACTION_SOURCE_CHARS) {
    throw new Error(`extraction source is ${sourceText.length} characters; split it below ${MAX_EXTRACTION_SOURCE_CHARS} so no atom is truncated`);
  }
  const user = `CURRENT STATE:\n${stateSummary(model, ontology)}\n\nINPUT EVENT (type=${event.type}${event.role ? `, role=${event.role}` : ""})\nSOURCE ATOMS:\n${sourceText}`;

  const r = await fetchT("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      max_tokens: 2000,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
      tools: [buildTool(ontology)],
      tool_choice: { type: "tool", name: "record_understanding" },
    }),
  }, 45_000);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`extraction llm ${r.status}: ${t.slice(0, 200)}`);
  }
  const out = await r.json();
  const block = (out.content || []).find((b) => b.type === "tool_use" && b.name === "record_understanding");
  const input = (block && block.input) || {};
  return {
    claims: Array.isArray(input.claims) ? input.claims : [],
    decisions: Array.isArray(input.decisions) ? input.decisions : [],
    activations: Array.isArray(input.activations) ? input.activations : [],
    bonds: Array.isArray(input.bonds) ? input.bonds : [],
    residuals: Array.isArray(input.residuals) ? input.residuals : [],
    source_atoms: sourceAtoms,
    usage: out.usage || null,
  };
}
