import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = "foaap_contract_test_key";
const SPACE_ID = "space_contract";

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

function toolData(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.content?.[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

test("foaap-mcp honors the API contract end to end", async (t) => {
  const requests = [];
  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://contract.test");
    const body = await bodyOf(req);
    requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      authorization: req.headers.authorization,
      body,
    });

    if (url.pathname !== "/api/v1/adapters") {
      assert.equal(req.headers.authorization, `Bearer ${API_KEY}`);
    }

    if (req.method === "GET" && url.pathname === "/api/v1/spaces") {
      return json(res, 200, { data: [{ id: SPACE_ID, name: "Contract space" }] });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/adapters") {
      assert.equal(url.searchParams.get("ontology"), "venture");
      return json(res, 200, {
        ontology: "venture",
        version: "2.0.0",
        extraction: {
          system: [
            "ONTOLOGY FOR THIS SPACE",
            "projection rules:",
            "- Preserve the user's meaning.",
            "CATALOG (for activations.catalog_id):",
            "- product-definition (product)",
            "- operating-principle (foundations)",
          ].join("\n"),
          tool_schema: {
            input_schema: {
              properties: {
                claims: {
                  items: {
                    properties: {
                      axis: { enum: ["foundations", "product", "go-to-market", "capital"] },
                    },
                  },
                },
              },
            },
          },
        },
        judge: {
          gates: {
            contradicts_min_confidence: 0.7,
            refines_min_confidence: 0.6,
            why_required: true,
          },
        },
      });
    }

    if (req.method === "GET" && url.pathname === `/api/v1/spaces/${SPACE_ID}/context`) {
      assert.equal(url.searchParams.get("q"), "launch readiness");
      assert.equal(url.searchParams.get("budget_tokens"), "300");
      return json(res, 200, {
        structured: {
          core: { claims: [{ id: "claim_old", statement: "Launch in September" }] },
          contradictions_active: [],
          relevant: [{ ref_id: "claim_old", score: 0.91 }],
          next_action: { type: "keep", ref_id: "claim_old" },
        },
      });
    }

    if (req.method === "POST" && url.pathname === `/api/v1/spaces/${SPACE_ID}/events`) {
      if (body.bonds) {
        assert.deepEqual(body, {
          source_atoms: [{ id: "atom_growth", text: "Community-led growth reduced CAC in the pilot." }],
          bonds: [{
            subject: "community-led growth",
            relation: "reduces",
            object: "customer acquisition cost",
            source_atom_ids: ["atom_growth"],
            evidence: [{
              polarity: "support",
              statement: "The pilot reduced CAC.",
              independence_key: "pilot-1",
              source_atom_ids: ["atom_growth"],
            }],
            predictions: [{
              key: "growth-test",
              statement: "CAC remains below €80 next month.",
              source_atom_ids: ["atom_growth"],
            }],
          }],
        });
        return json(res, 200, {
          mode: "sovereign",
          understood: {
            claims: [],
            decisions: [],
            nodes: [],
            bonds: [{
              id: "sb_growth",
              subject: { label: "community-led growth" },
              relation: "reduces",
              object: { label: "customer acquisition cost" },
              status: "supported",
              strength: { total_signals: 1, support_signals: 1, opposition_signals: 0 },
              created: true,
            }],
            predictions: [{ id: "pred_growth", bond_id: "sb_growth", key: "growth-test", status: "open" }],
            coverage: { status: "complete", ratio: 1 },
            next_action: { type: "keep", ref_id: "sb_growth" },
          },
          pairs_to_judge: [],
        });
      }
      assert.deepEqual(body, {
        source_atoms: [
          { id: "atom_launch", text: "Launch in October." },
          { id: "atom_tone", text: "The team sounded optimistic." },
        ],
        claims: [{
          axis: "product",
          node: "launch",
          statement: "Launch in October",
          interpretation: "The launch date moved by one month.",
          kind: "commitment",
          source_atom_ids: ["atom_launch"],
        }],
        decisions: [{
          axis: "product",
          text: "Prepare the October release",
          confidence: "high",
          source_atom_ids: ["atom_launch"],
        }],
        residuals: [{
          source_atom_id: "atom_tone",
          reason: "Tone is preserved but does not mutate canonical venture state.",
        }],
      });
      return json(res, 200, {
        mode: "sovereign",
        understood: {
          claims: [{ id: "claim_new", axis: "product", statement: "Launch in October" }],
          decisions: [{ id: "decision_new", axis: "product", text: "Prepare the October release" }],
          lineage: [{ from: "event_new", to: "claim_new", relation: "derived" }],
          residuals: [{
            source_atom_id: "atom_tone",
            reason: "Tone is preserved but does not mutate canonical venture state.",
          }],
          coverage: {
            status: "complete",
            source_atoms: 2,
            projected_atoms: 1,
            residual_atoms: 1,
            accounted_atoms: 2,
            ratio: 1,
            unaccounted_atom_ids: [],
            invalid_source_refs: [],
          },
          next_action: { type: "judge", ref_id: "claim_new" },
        },
        pairs_to_judge: [{
          a_id: "claim_old",
          a_statement: "Launch in September",
          b_id: "claim_new",
          b_statement: "Launch in October",
        }],
      });
    }

    if (req.method === "POST" && url.pathname === `/api/v1/spaces/${SPACE_ID}/verdicts`) {
      assert.deepEqual(body, {
        verdicts: [{
          a_id: "claim_old",
          b_id: "claim_new",
          relation: "contradicts",
          confidence: 0.94,
          severity: "high",
          why: "The venture cannot launch for the first time in both September and October.",
        }],
      });
      return json(res, 200, {
        applied: { contradictions: [{ id: "contradiction_1" }], refinements: [] },
        skipped: [],
        next_action: { type: "resolve", ref_id: "contradiction_1" },
      });
    }

    if (
      req.method === "POST"
      && url.pathname === `/api/v1/spaces/${SPACE_ID}/contradictions/contradiction_1/resolve`
    ) {
      assert.deepEqual(body, { reason: "October is the human-approved launch date." });
      return json(res, 200, {
        contradiction: { id: "contradiction_1", status: "resolved" },
        supersede_edge: {
          from: "claim_new",
          to: "claim_old",
          relation: "supersedes",
          why: "October is the human-approved launch date.",
        },
        next_action: { type: "keep", ref_id: "claim_new" },
      });
    }

    if (
      req.method === "GET"
      && url.pathname === `/api/v1/spaces/${SPACE_ID}/claims/claim_new/lineage`
    ) {
      return json(res, 200, {
        ref_id: "claim_new",
        ancestry: [{ from: "event_new", to: "claim_new", relation: "derived" }],
        contradictions: [{ id: "contradiction_1", status: "resolved" }],
      });
    }

    if (
      req.method === "GET"
      && url.pathname === `/api/v1/spaces/${SPACE_ID}/bonds/sb_growth`
    ) {
      return json(res, 200, {
        id: "sb_growth",
        subject: { label: "community-led growth" },
        relation: "reduces",
        object: { label: "customer acquisition cost" },
        support: [{ id: "evi_growth", independence_key: "pilot-1" }],
        opposition: [],
        predictions: [{ id: "pred_growth", key: "growth-test", status: "open" }],
        outcomes: [],
        view: {
          status: "supported",
          applicability: "active",
          strength: { total_signals: 1, support_signals: 1, opposition_signals: 0 },
        },
      });
    }

    return json(res, 404, { error: { message: `Unexpected contract request: ${req.method} ${url.pathname}` } });
  });

  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));

  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["index.mjs"],
    cwd: MCP_DIR,
    stderr: "pipe",
    env: {
      FOAAP_API_KEY: API_KEY,
      FOAAP_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
    },
  });
  const client = new Client({ name: "foaap-contract-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      "get_ontology",
      "whats_true",
      "remember_this",
      "submit_verdicts",
      "resolve_contradiction",
      "why_is_this_true",
    ],
  );
  const rememberSchema = listed.tools.find((tool) => tool.name === "remember_this").inputSchema;
  assert.deepEqual(rememberSchema.properties.claims.items.required, ["axis", "statement", "kind"]);
  assert.deepEqual(
    rememberSchema.properties.claims.items.properties.kind.enum,
    ["commitment", "constraint", "definition", "insight"],
  );
  const verdictSchema = listed.tools.find((tool) => tool.name === "submit_verdicts").inputSchema;
  assert.deepEqual(
    verdictSchema.properties.verdicts.items.properties.relation.enum,
    ["contradicts", "refines", "unrelated"],
  );

  const ontology = toolData(await client.callTool({
    name: "get_ontology",
    arguments: { axes: ["product"], include: ["axes", "catalog", "rules"] },
  }));
  assert.equal(ontology.id, "venture");
  assert.equal(ontology.version, "2.0.0");
  assert.deepEqual(ontology.axes, ["product"]);
  assert.deepEqual(ontology.catalog, ["- product-definition (product)"]);
  assert.match(ontology.projection_rules, /Preserve the user's meaning/);

  const context = toolData(await client.callTool({
    name: "whats_true",
    arguments: { query: "launch readiness", budget_tokens: 100 },
  }));
  assert.equal(context.core.claims[0].id, "claim_old");
  assert.equal(context.relevant[0].ref_id, "claim_old");
  assert.equal(context.next_action.type, "keep");

  const remembered = toolData(await client.callTool({
    name: "remember_this",
    arguments: {
      source_atoms: [
        { id: "atom_launch", text: "Launch in October." },
        { id: "atom_tone", text: "The team sounded optimistic." },
      ],
      claims: [{
        axis: "product",
        node: "launch",
        statement: "Launch in October",
        interpretation: "The launch date moved by one month.",
        kind: "commitment",
        source_atom_ids: ["atom_launch"],
      }],
      decisions: [{
        axis: "product",
        text: "Prepare the October release",
        confidence: "high",
        source_atom_ids: ["atom_launch"],
      }],
      residuals: [{
        source_atom_id: "atom_tone",
        reason: "Tone is preserved but does not mutate canonical venture state.",
      }],
    },
  }));
  assert.equal(remembered.mode, "sovereign");
  assert.equal(remembered.recorded.claims[0].id, "claim_new");
  assert.equal(remembered.recorded.decisions[0].id, "decision_new");
  assert.equal(remembered.pairs_to_judge[0].a_id, "claim_old");
  assert.equal(remembered.judge.gates.contradicts_min_confidence, 0.7);
  assert.equal(remembered.judge.submit_with, "submit_verdicts");
  assert.equal(remembered.coverage.status, "complete");
  assert.equal(remembered.coverage.ratio, 1);
  assert.equal(remembered.residuals[0].source_atom_id, "atom_tone");

  const compounded = toolData(await client.callTool({
    name: "remember_this",
    arguments: {
      source_atoms: [{ id: "atom_growth", text: "Community-led growth reduced CAC in the pilot." }],
      bonds: [{
        subject: "community-led growth",
        relation: "reduces",
        object: "customer acquisition cost",
        source_atom_ids: ["atom_growth"],
        evidence: [{
          polarity: "support",
          statement: "The pilot reduced CAC.",
          independence_key: "pilot-1",
          source_atom_ids: ["atom_growth"],
        }],
        predictions: [{
          key: "growth-test",
          statement: "CAC remains below €80 next month.",
          source_atom_ids: ["atom_growth"],
        }],
      }],
    },
  }));
  assert.equal(compounded.recorded.bonds[0].id, "sb_growth");
  assert.equal(compounded.recorded.bonds[0].status, "supported");
  assert.equal(compounded.recorded.predictions[0].id, "pred_growth");
  assert.equal(compounded.coverage.ratio, 1);

  const verdict = toolData(await client.callTool({
    name: "submit_verdicts",
    arguments: {
      verdicts: [{
        a_id: "claim_old",
        b_id: "claim_new",
        relation: "contradicts",
        confidence: 0.94,
        severity: "high",
        why: "The venture cannot launch for the first time in both September and October.",
      }],
    },
  }));
  assert.equal(verdict.applied.contradictions[0].id, "contradiction_1");
  assert.match(verdict.note, /surface them to the human/);
  assert.equal(verdict.next_action.type, "resolve");

  const resolved = toolData(await client.callTool({
    name: "resolve_contradiction",
    arguments: {
      contradiction_id: "contradiction_1",
      reason: "October is the human-approved launch date.",
    },
  }));
  assert.equal(resolved.resolved, "contradiction_1");
  assert.equal(resolved.supersede_edge.relation, "supersedes");
  assert.equal(resolved.next_action.type, "keep");

  const lineage = toolData(await client.callTool({
    name: "why_is_this_true",
    arguments: { ref_id: "claim_new" },
  }));
  assert.equal(lineage.ref_id, "claim_new");
  assert.equal(lineage.ancestry[0].relation, "derived");
  assert.equal(lineage.contradictions[0].status, "resolved");

  const bond = toolData(await client.callTool({
    name: "why_is_this_true",
    arguments: { ref_id: "sb_growth" },
  }));
  assert.equal(bond.id, "sb_growth");
  assert.equal(bond.view.status, "supported");
  assert.equal(bond.support[0].independence_key, "pilot-1");

  assert.deepEqual(
    requests.map(({ method, path }) => `${method} ${path}`),
    [
      "GET /api/v1/spaces",
      "GET /api/v1/adapters",
      `GET /api/v1/spaces/${SPACE_ID}/context`,
      `POST /api/v1/spaces/${SPACE_ID}/events`,
      `POST /api/v1/spaces/${SPACE_ID}/events`,
      `POST /api/v1/spaces/${SPACE_ID}/verdicts`,
      `POST /api/v1/spaces/${SPACE_ID}/contradictions/contradiction_1/resolve`,
      `GET /api/v1/spaces/${SPACE_ID}/claims/claim_new/lineage`,
      `GET /api/v1/spaces/${SPACE_ID}/bonds/sb_growth`,
    ],
  );
});
