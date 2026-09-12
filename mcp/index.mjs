#!/usr/bin/env node
// =============================================================================
//  foaap-mcp v2 — SOVEREIGN-NATIVE. A socket, not a sermon.
//
//  No prompts inside. No models inside. The HOST agent (the frontier model
//  calling these tools) is the extractor AND the judge; FOAAP records,
//  guards, and explains. Tool descriptions are one mechanical line each —
//  the protocol lives in the SHAPE of the returned data: a docket in hand
//  demands verdicts; a typed contradiction demands the human.
//
//  Config:
//    FOAAP_API_KEY   required — your own Engine deployment
//    FOAAP_SPACE     optional — space id (defaults to first space / auto-creates)
//    FOAAP_BASE_URL  optional — defaults to http://localhost:8787/api/v1
// =============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.FOAAP_BASE_URL || "http://localhost:8787/api/v1").replace(/\/+$/, "");
const KEY = process.env.FOAAP_API_KEY || "";

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.error?.message || `${method} ${path} → ${r.status}`);
  return json;
}

let spaceId = process.env.FOAAP_SPACE || null;
async function space() {
  if (spaceId) return spaceId;
  const list = await api("GET", "/spaces");
  const existing = (list.data || [])[0];
  if (existing) { spaceId = existing.id; return spaceId; }
  const created = await api("POST", "/spaces", { name: "mcp-default" });
  spaceId = created.id;
  return spaceId;
}

let adaptersCache = null;
async function adapters() {
  if (adaptersCache) return adaptersCache;
  const r = await fetch(`${BASE}/adapters?ontology=venture`);
  adaptersCache = await r.json();
  return adaptersCache;
}

// One mechanical line per tool. ~150 tokens total, not ~1,000.
const TOOLS = [
  {
    name: "get_ontology",
    description: "The space's ontology as data (axes, catalog, projection rules) — sliceable. Call once, then extract claims natively into it.",
    inputSchema: {
      type: "object",
      properties: {
        axes: { type: "array", items: { type: "string" }, description: "Only these axes (default: all)" },
        include: { type: "array", items: { type: "string", enum: ["axes", "catalog", "rules"] }, description: "Sections to return (default: all)" },
      },
    },
  },
  {
    name: "whats_true",
    description: "Typed canonical state scoped to a query: core, active contradictions, next_action. Returns pairs still awaiting verdicts, if any.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are about to work on" },
        budget_tokens: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "remember_this",
    description: "Conserve source atoms into typed structure or explicit residuals. Returns coverage plus pairs_to_judge.",
    inputSchema: {
      type: "object",
      properties: {
        source_atoms: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
            },
            required: ["id", "text"],
          },
          description: "Atomic source spans. When supplied, every id must be cited by structure or residuals.",
        },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              axis: { type: "string" },
              node: { type: "string" },
              statement: { type: "string" },
              interpretation: { type: "string" },
              kind: { type: "string", enum: ["commitment", "constraint", "definition", "insight"] },
              source_atom_ids: { type: "array", items: { type: "string" } },
            },
            required: ["axis", "statement", "kind"],
          },
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              axis: { type: "string" },
              text: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              source_atom_ids: { type: "array", items: { type: "string" } },
            },
            required: ["axis", "text"],
          },
        },
        activations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              axis: { type: "string" },
              label: { type: "string" },
              catalog_id: { type: "string" },
              why_now: { type: "string" },
              source_atom_ids: { type: "array", items: { type: "string" } },
            },
            required: ["axis", "label", "why_now"],
          },
        },
        bonds: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subject: {},
              relation: { type: "string" },
              object: {},
              context: { type: "object" },
              valid_from: { type: "string" },
              valid_until: { type: "string" },
              source_atom_ids: { type: "array", items: { type: "string" } },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    polarity: { type: "string", enum: ["support", "opposition"] },
                    statement: { type: "string" },
                    why: { type: "string" },
                    source_id: { type: "string" },
                    independence_key: { type: "string" },
                    source_atom_ids: { type: "array", items: { type: "string" } },
                  },
                  required: ["polarity", "statement"],
                },
              },
              predictions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    statement: { type: "string" },
                    success_criteria: { type: "string" },
                    due_at: { type: "string" },
                    source_atom_ids: { type: "array", items: { type: "string" } },
                  },
                  required: ["statement"],
                },
              },
            },
            required: ["subject", "relation", "object"],
          },
        },
        bond_evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              bond_id: { type: "string" },
              polarity: { type: "string", enum: ["support", "opposition"] },
              statement: { type: "string" },
              why: { type: "string" },
              source_id: { type: "string" },
              independence_key: { type: "string" },
              source_atom_ids: { type: "array", items: { type: "string" } },
            },
            required: ["bond_id", "polarity", "statement"],
          },
        },
        predictions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              bond_id: { type: "string" },
              key: { type: "string" },
              statement: { type: "string" },
              success_criteria: { type: "string" },
              due_at: { type: "string" },
              source_atom_ids: { type: "array", items: { type: "string" } },
            },
            required: ["bond_id", "statement"],
          },
        },
        outcomes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              bond_id: { type: "string" },
              prediction_id: { type: "string" },
              prediction_key: { type: "string" },
              observed: { type: "string" },
              result: { type: "string", enum: ["confirmed", "refuted", "mixed", "inconclusive"] },
              observed_at: { type: "string" },
              source_atom_ids: { type: "array", items: { type: "string" } },
            },
            required: ["bond_id", "observed", "result"],
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
    },
  },
  {
    name: "submit_verdicts",
    description: "Return your judgment on a docket: relation (contradicts|refines|unrelated), confidence, and a one-sentence why per pair.",
    inputSchema: {
      type: "object",
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              a_id: { type: "string" },
              b_id: { type: "string" },
              relation: { type: "string", enum: ["contradicts", "refines", "unrelated"] },
              confidence: { type: "number" },
              severity: { type: "string", enum: ["high", "medium", "low"] },
              why: { type: "string" },
            },
            required: ["a_id", "b_id", "relation", "confidence", "why"],
          },
        },
      },
      required: ["verdicts"],
    },
  },
  {
    name: "resolve_contradiction",
    description: "Record the HUMAN's resolution of a contradiction (retires the losing side, writes the supersede edge with their reason).",
    inputSchema: {
      type: "object",
      properties: {
        contradiction_id: { type: "string" },
        reason: { type: "string", description: "The human's decision, their words" },
      },
      required: ["contradiction_id", "reason"],
    },
  },
  {
    name: "why_is_this_true",
    description: "Explain claim/decision lineage or a semantic bond's support, opposition, predictions, outcomes, and validity.",
    inputSchema: {
      type: "object",
      properties: {
        ref_id: { type: "string" },
        ref_type: { type: "string", enum: ["claim", "decision", "bond"] },
      },
      required: ["ref_id"],
    },
  },
];

function out(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
}

// The judge protocol travels IN the data, not in tool descriptions.
async function docketEnvelope(pairs) {
  const a = await adapters();
  return {
    pairs_to_judge: pairs,
    judge: {
      test: "For each pair: can A and B be FULLY TRUE at the same time? No → contradicts (severity: high|medium|low). Yes and B deepens A → refines. Otherwise → unrelated.",
      gates: a?.judge?.gates || { contradicts_min_confidence: 0.7, refines_min_confidence: 0.6, why_required: true },
      submit_with: "submit_verdicts",
    },
  };
}

async function call(name, args) {
  const sp = await space();

  if (name === "get_ontology") {
    const a = await adapters();
    const ont = a?.extraction ? { id: a.ontology, version: a.version } : {};
    // Reconstruct data sections from the published adapter (system carries the
    // ontology text; the tool schema carries the axes enum + catalog ids).
    const schema = a?.extraction?.tool_schema?.input_schema;
    const axesAll = schema?.properties?.claims?.items?.properties?.axis?.enum || [];
    const wantAxes = Array.isArray(args.axes) && args.axes.length ? args.axes.filter((x) => axesAll.includes(x)) : axesAll;
    const include = Array.isArray(args.include) && args.include.length ? args.include : ["axes", "catalog", "rules"];
    const sliced = { ...ont, axes: wantAxes };
    if (include.includes("catalog") || include.includes("rules")) {
      const sys = a?.extraction?.system || "";
      const section = sys.split("ONTOLOGY FOR THIS SPACE")[1] || "";
      if (include.includes("rules")) sliced.projection_rules = (section.split("projection rules:")[1] || "").split("CATALOG")[0].trim();
      if (include.includes("catalog")) {
        sliced.catalog = (section.split("CATALOG (for activations.catalog_id):")[1] || "")
          .trim().split("\n").map((l) => l.trim()).filter(Boolean)
          .filter((l) => wantAxes.some((ax) => l.includes(`(${ax})`)));
      }
    }
    sliced.claim_kinds = ["commitment", "constraint", "definition", "insight"];
    return out(sliced);
  }

  if (name === "whats_true") {
    const budget = Math.min(Math.max(args.budget_tokens || 1500, 300), 6000);
    const ctx = await api("GET", `/spaces/${sp}/context?q=${encodeURIComponent(args.query)}&budget_tokens=${budget}`);
    return out({
      core: ctx.structured?.core || null,
      contradictions_active: ctx.structured?.contradictions_active || [],
      relevant: ctx.structured?.relevant || [],
      next_action: ctx.structured?.next_action || null,
    });
  }

  if (name === "remember_this") {
    const body = {};
    if (Array.isArray(args.source_atoms) && args.source_atoms.length) body.source_atoms = args.source_atoms;
    if (Array.isArray(args.claims) && args.claims.length) body.claims = args.claims;
    if (Array.isArray(args.decisions) && args.decisions.length) body.decisions = args.decisions;
    if (Array.isArray(args.activations) && args.activations.length) body.activations = args.activations;
    if (Array.isArray(args.bonds) && args.bonds.length) body.bonds = args.bonds;
    if (Array.isArray(args.bond_evidence) && args.bond_evidence.length) body.bond_evidence = args.bond_evidence;
    if (Array.isArray(args.predictions) && args.predictions.length) body.predictions = args.predictions;
    if (Array.isArray(args.outcomes) && args.outcomes.length) body.outcomes = args.outcomes;
    if (Array.isArray(args.residuals) && args.residuals.length) body.residuals = args.residuals;
    if (
      !body.claims && !body.decisions && !body.activations && !body.bonds
      && !body.bond_evidence && !body.predictions && !body.outcomes && !body.residuals
    ) {
      throw new Error("send typed structure, semantic bonds/evidence/outcomes, and/or residuals");
    }
    const ev = await api("POST", `/spaces/${sp}/events`, body);
    const u = ev.understood || {};
    const result = {
      mode: ev.mode,
      recorded: {
        claims: (u.claims || []).map((c) => ({
          id: c.id, axis: c.axis, statement: c.statement,
          source_atom_ids: c.source_atom_ids || [],
        })),
        decisions: (u.decisions || []).map((d) => ({
          id: d.id, axis: d.axis, text: d.text,
          source_atom_ids: d.source_atom_ids || [],
        })),
        nodes: u.nodes || [],
        bonds: u.bonds || [],
        bond_evidence: u.bond_evidence || [],
        predictions: u.predictions || [],
        outcomes: u.outcomes || [],
      },
      lineage: u.lineage || [],
      residuals: u.residuals || [],
      coverage: u.coverage || { status: "unverified", ratio: null },
      next_action: u.next_action || null,
    };
    if (ev.pairs_to_judge?.length) Object.assign(result, await docketEnvelope(ev.pairs_to_judge));
    return out(result);
  }

  if (name === "submit_verdicts") {
    const r = await api("POST", `/spaces/${sp}/verdicts`, { verdicts: args.verdicts });
    return out({
      applied: r.applied,
      skipped: r.skipped,
      next_action: r.next_action,
      ...(r.applied?.contradictions?.length
        ? { note: "contradictions are open — surface them to the human; resolve_contradiction records their choice" }
        : {}),
    });
  }

  if (name === "resolve_contradiction") {
    const r = await api("POST", `/spaces/${sp}/contradictions/${encodeURIComponent(args.contradiction_id)}/resolve`, { reason: args.reason });
    return out({ resolved: r.contradiction?.id, supersede_edge: r.supersede_edge, next_action: r.next_action });
  }

  if (name === "why_is_this_true") {
    const ref = encodeURIComponent(args.ref_id);
    return out(await api("GET", args.ref_type === "bond" || args.ref_id.startsWith("sb_")
      ? `/spaces/${sp}/bonds/${ref}`
      : `/spaces/${sp}/claims/${ref}/lineage`));
  }

  throw new Error(`unknown tool ${name}`);
}

const server = new Server(
  { name: "foaap", version: "0.3.0" },
  {
    capabilities: { tools: {} },
    instructions: "FOAAP maintains this project's accepted state across sessions and models. You extract; you judge your own dockets; humans resolve conflicts.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await call(req.params.name, req.params.arguments || {});
  } catch (e) {
    return { content: [{ type: "text", text: `FOAAP error: ${e.message}` }], isError: true };
  }
});

if (!KEY) {
  console.error("foaap-mcp: FOAAP_API_KEY is required — get one at your own Engine deployment");
  process.exit(1);
}
await server.connect(new StdioServerTransport());
