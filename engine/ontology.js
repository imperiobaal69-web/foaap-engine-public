// =============================================================================
//  Ontology — the projection layer, as DATA.
//
//  The engine understands inputs in a UNIVERSAL GRAMMAR (claims, decisions,
//  constraints, contradictions, nodes, next actions) and then projects that
//  grammar into a selected ontology: the axes that structure a domain, the
//  catalog of known workstreams, and the hints that guide projection.
//
//  "venture" ships as the default template, built from the original catalogs
//  in lib/. Adding a domain (legal, health, product ops…) = adding an object
//  here (or, later, a row in an `ontologies` table) — zero engine code changes.
// =============================================================================

import { PATTERNS } from "../lib/subnode-patterns.js";
import { resolveArchetype } from "../lib/venture-archetypes.js";

const VENTURE = {
  id: "venture",
  label: "Venture",
  // The structural axes of the domain (was: the 4 pillars).
  axes: [
    { id: "foundations", label: "Foundations" },
    { id: "product", label: "Product" },
    { id: "go-to-market", label: "Go-to-Market" },
    { id: "capital", label: "Capital" },
  ],
  // Guidance the extractor uses to project claims onto axes.
  projection_hints:
    "manufacturing/supply/ops/product scope → product; legal/team/identity/location → foundations; " +
    "customers/channels/pricing-to-market/competition → go-to-market; funding/runway/investors/costs → capital.",
  // Known workstreams (was: the 28 subnode patterns). id, axis, label, prerequisites.
  catalog: PATTERNS.map((p) => ({
    id: p.id,
    axis: p.pillar,
    label: p.label,
    prerequisites: p.prerequisites || [],
    first_question: p.firstQuestion || null,
  })),
};

const REGISTRY = { venture: VENTURE };

export function listOntologies() {
  return Object.keys(REGISTRY);
}

export function getOntology(id) {
  return REGISTRY[id] || REGISTRY.venture;
}

// Lens resolution — venture keeps its archetype system; other ontologies can
// omit lenses entirely (resolveLens then returns an empty lens).
export function resolveLens(ontology, lensId) {
  if (ontology.id === "venture") {
    const a = resolveArchetype(lensId);
    return { id: a?.id || null, deemphasize: Array.isArray(a?.deemphasize) ? a.deemphasize : [] };
  }
  return { id: lensId || null, deemphasize: [] };
}

// Universal claim kinds — the grammar, not the domain.
export const CLAIM_KINDS = ["commitment", "constraint", "definition", "insight"];
