// =============================================================================
//  FOAAP Engine API v1 — Phase A (read path). Single edge catch-all.
//
//    POST /api/v1/keys                       (Supabase JWT) → create key, shown ONCE
//    GET  /api/v1/spaces                     (API key) → list spaces
//    GET  /api/v1/spaces/:id/model           → full typed model + version
//    GET  /api/v1/spaces/:id/synthesis       → current synthesis + journal
//    GET  /api/v1/spaces/:id/graph           → pattern states + transitive unlock roots
//    GET  /api/v1/spaces/:id/context?q=&budget_tokens=   ⭐ canonical core +
//         substrate top-K + contradictions → prompt_block + structured
//    GET  /api/v1/spaces/:id/export          → sovereignty export (manifest + model)
//
//  Auth: `Authorization: Bearer sk_foaap_live_…` — sha-256 looked up in
//  api_keys (revoked_at null). Phase A tenancy: workspace → owner's auth user;
//  a space = one of the owner's venture_models rows (space id = venture_id).
//
//  See README.md and the contract tests for the public reference. Phase B adds the ingest (events),
//  C turns/jobs, D ontology-as-config.
// =============================================================================

export const config = { runtime: "edge" };

// Engine core: universal grammar (model) + ontology projection + extraction.
import {
  newModel, normalizeModel, appendEvent, addClaim, addDecision, addContradiction,
  addNode, resolveContradiction, deriveNextAction, recordSupersede, claimLineage,
  applyVerdicts,
} from "../engine/model.js";
import { getOntology, listOntologies, resolveLens, CLAIM_KINDS } from "../engine/ontology.js";
import { extractFromEvent, extractionAdapter, MAX_EXTRACTION_SOURCE_CHARS } from "../engine/extract.js";
import { judgePairs, JUDGE_ADAPTER } from "../engine/contradict.js";
import { pushSubstrate } from "../engine/substrate.js";
import { normalizeSourceAtoms, semanticCoverage } from "../engine/coverage.js";
import { freshSemanticDrafts, freshSemanticRefs } from "../engine/semantic.js";
import {
  addSemanticBond, addBondEvidence, addBondPrediction, recordBondOutcome,
  getSemanticBond, semanticBondViews,
} from "../engine/bonds.js";

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const VOYAGE_KEY = process.env.VOYAGE_API_KEY || "";

// CORS — the API is consumed from browsers (foaap.app is client #1). Auth is
// bearer-key, never cookies, so a wildcard origin is safe.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-foaap-api-version": "2026-07-03",
      ...CORS,
    },
  });
}
function err(status, type, message) {
  return json(status, { error: { type, message } });
}
function supaHeaders(extra = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...extra };
}
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(s) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// ---- auth: Supabase JWT (key creation only) --------------------------------
async function verifyJwt(req) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token || token.startsWith("sk_foaap_")) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    const uid = u && (u.id || u.user_id);
    return uid ? String(uid) : null;
  } catch { return null; }
}

// ---- auth: API key ----------------------------------------------------------
export async function verifyApiKey(req) {
  const h = req.headers.get("authorization") || "";
  const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!key.startsWith("sk_foaap_")) return null;
  const hash = await sha256Hex(key);
  const url = `${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${hash}&revoked_at=is.null&select=id,workspace_id,scopes,prefix,workspaces(owner_user_id)&limit=1`;
  const r = await fetch(url, { headers: supaHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  const row = Array.isArray(rows) && rows[0];
  if (!row || !row.workspaces) return null;
  // Touch last_used_at, fire-and-forget.
  fetch(`${SUPABASE_URL}/rest/v1/api_keys?id=eq.${row.id}`, {
    method: "PATCH", headers: supaHeaders(), body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});
  const scopes = row.scopes || ["read"];
  // Per-key space restriction, encoded as "space:<venture_id>" scope entries
  // (no dedicated column needed). Empty list = whole workspace.
  const spaceIds = scopes.filter((s) => s.startsWith("space:")).map((s) => s.slice(6));
  return { keyId: row.id, workspaceId: row.workspace_id, ownerUserId: row.workspaces.owner_user_id, scopes, spaceIds, prefix: row.prefix ?? null };
}

// 404 (not 403) outside the allowed set — a restricted key must not be able
// to enumerate which other spaces exist.
function spaceAllowed(auth, ventureId) {
  return !auth.spaceIds.length || auth.spaceIds.includes(ventureId);
}

// ---- data reads -------------------------------------------------------------
async function getSpaceRow(ownerUserId, ventureId) {
  const url = `${SUPABASE_URL}/rest/v1/venture_models?user_id=eq.${encodeURIComponent(ownerUserId)}&venture_id=eq.${encodeURIComponent(ventureId)}&select=model,synthesis,synthesis_at,updated_at,version&limit=1`;
  const r = await fetch(url, { headers: supaHeaders() });
  if (!r.ok) throw new Error(`model read ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// ---- writes: version-CAS save (same RPC contract as api/memory/save.js) -----
async function saveModel({ userId, ventureId, model, baseVersion }) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/save_venture_model`, {
    method: "POST",
    headers: supaHeaders(),
    body: JSON.stringify({
      p_user: userId,
      p_venture: ventureId,
      p_model: model,
      p_base: Number.isInteger(baseVersion) ? baseVersion : -1,
    }),
  });
  if (!r.ok) throw new Error(`cas save ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const rows = await r.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { status: row?.out_status, version: row?.out_version, model: row?.out_model };
}

// ---- the LINE: engine_events table (append-only, built for volume) -----------
// Raw messages are SUBSTANCE — they land here and in the substrate with zero
// LLM work and zero state contention. Knots are born when substance distills.
async function insertLineEvents(userId, ventureId, rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/engine_events`, {
    method: "POST",
    headers: supaHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(rows.map((x) => ({
      user_id: userId, venture_id: ventureId,
      kind: x.kind || "ingest", type: x.type || "message", role: x.role || "user",
      text: String(x.text || "").slice(0, 16384),
      idem_key: x.idem_key || null,
      payload: x.payload || {},
      distilled_at: x.distilled_at || null,
      occurred_at: x.occurred_at || new Date().toISOString(),
    }))),
  });
  if (!r.ok) throw new Error(`line insert ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120)}`);
  return await r.json();
}

async function lineIdemLookup(userId, ventureId, idem) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/engine_events?user_id=eq.${encodeURIComponent(userId)}&venture_id=eq.${encodeURIComponent(ventureId)}&idem_key=eq.${encodeURIComponent(idem)}&select=id,payload&limit=1`, { headers: supaHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return rows?.[0] || null;
}

async function fetchUndistilled(userId, ventureId, limit = 50) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/engine_events?user_id=eq.${encodeURIComponent(userId)}&venture_id=eq.${encodeURIComponent(ventureId)}&distilled_at=is.null&kind=eq.ingest&select=id,type,role,text,occurred_at&order=created_at.asc&limit=${limit}`, { headers: supaHeaders() });
  if (!r.ok) return [];
  return (await r.json().catch(() => [])) || [];
}

async function countUndistilled(userId, ventureId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/engine_events?user_id=eq.${encodeURIComponent(userId)}&venture_id=eq.${encodeURIComponent(ventureId)}&distilled_at=is.null&kind=eq.ingest&select=id`, {
    method: "HEAD", headers: supaHeaders({ Prefer: "count=exact" }),
  });
  const range = r.headers.get("content-range") || "";
  const n = parseInt(range.split("/")[1] || "0", 10);
  return Number.isFinite(n) ? n : 0;
}

async function markDistilled(ids, payload) {
  if (!ids.length) return;
  await fetch(`${SUPABASE_URL}/rest/v1/engine_events?id=in.(${ids.map(encodeURIComponent).join(",")})`, {
    method: "PATCH",
    headers: supaHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({ distilled_at: new Date().toISOString(), payload: payload || {} }),
  }).catch(() => {});
}

// Background writes (logging/metering) must survive the response on edge
// runtimes: fire-and-forget promises are killed when the isolate returns.
// Every background task registers here; the handler drains the list into
// ctx.waitUntil when available (Vercel), or lets them float locally (Node).
let _background = [];
function bg(promise) { _background.push(promise.catch(() => {})); }
function drainBackground(ctx) {
  const tasks = _background; _background = [];
  if (ctx && typeof ctx.waitUntil === "function" && tasks.length) ctx.waitUntil(Promise.all(tasks));
}

// Request logging into request_logs (cloud path — locally server.js writes
// requests.log instead and intercepts GET /logs).
function logRequestRow({ keyPrefix, method, path, status, ms }) {
  bg(fetch(`${SUPABASE_URL}/rest/v1/request_logs`, {
    method: "POST",
    headers: supaHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({ key_prefix: keyPrefix, method, path: path.slice(0, 300), status, ms }),
  }));
}

// Best-effort in-isolate rate limiting for serverless (Vercel). The local
// server has its own authoritative limiter in server.js; this one only runs
// when VERCEL=1. Per-isolate, so it's a soft cap — good enough for v0.
const RATE = { GET: 120, POST: 20, ANON: 30, WINDOW_MS: 60_000 };
const rateBuckets = new Map();
function rateCheck(token, method) {
  const now = Date.now();
  const k = token || "anon";
  let b = rateBuckets.get(k);
  if (!b || now - b.start > RATE.WINDOW_MS) { b = { start: now, counts: {} }; rateBuckets.set(k, b); }
  const cls = !token ? "ANON" : (method === "GET" || method === "HEAD" ? "GET" : "POST");
  b.counts[cls] = (b.counts[cls] || 0) + 1;
  return { ok: b.counts[cls] <= RATE[cls], limit: RATE[cls], retryAfter: Math.ceil((b.start + RATE.WINDOW_MS - now) / 1000) };
}

// Metering into the existing usage_events table (background-safe).
function meterUsage({ userId, eventType, amount = 1, metadata = {} }) {
  bg(fetch(`${SUPABASE_URL}/rest/v1/usage_events`, {
    method: "POST",
    headers: supaHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({ user_id: userId, surface: "engine_api", event_type: eventType, amount, metadata }),
  }));
}

function hasScope(auth, scope) {
  return Array.isArray(auth.scopes) && (auth.scopes.includes(scope) || auth.scopes.includes("admin"));
}

// ---- canonical state (neutral core, projected through the space's ontology) --
function canonicalCore(model, ontology) {
  const p = (model && model.profile) || {};
  const lines = [];
  lines.push("CANONICAL STATE — binding constraints for ANY output grounded in this space.");
  if (p.name)      lines.push(`  name: ${p.name}`);
  lines.push(`  ontology: ${ontology.id}${p.lens ? ` · lens: ${p.lens}` : ""}`);
  if (p.one_liner) lines.push(`  one-liner: ${p.one_liner}`);
  const claims = (Array.isArray(model?.claims) ? model.claims : []).filter((c) => c && !c.archived_at);
  for (const a of ontology.axes) {
    const latest = claims
      .filter((c) => (c.axis || "").toLowerCase() === a.id)
      .sort((x, y) => (y.ts || 0) - (x.ts || 0))[0];
    if (latest) lines.push(`  ${a.label} (latest): ${String(latest.statement || "").replace(/\s+/g, " ").slice(0, 180)}`);
  }
  // A resolved contradiction retires its losing claim: the "a" (older) side
  // must stop appearing as a live commitment — that's what resolution MEANS.
  const superseded = new Set(
    (Array.isArray(model?.contradictions) ? model.contradictions : [])
      .filter((c) => c && c.resolved_at && c.source_ids?.a?.type === "decision" && c.source_ids.a.id)
      .map((c) => c.source_ids.a.id)
  );
  const decs = (Array.isArray(model?.decisions) ? model.decisions : [])
    .filter((d) => d && !superseded.has(d.id))
    .slice(-5);
  if (decs.length) {
    lines.push("  committed decisions (do NOT contradict):");
    for (const d of decs) lines.push(`    - ${String(d.text || "").replace(/\s+/g, " ").slice(0, 160)}`);
  }
  const bonds = semanticBondViews(model)
    .filter((bond) => bond.applicability === "active")
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, 12);
  if (bonds.length) {
    lines.push("  semantic bonds (evidence conserved; contested means inspect both sides):");
    for (const bond of bonds) {
      lines.push(
        `    - [${bond.status}] ${bond.subject?.label || "?"} ${bond.relation || "?"} ${bond.object?.label || "?"}`
        + ` · support ${bond.strength.support_signals} / opposition ${bond.strength.opposition_signals}`,
      );
    }
  }
  const structured = {
    name: p.name || null,
    ontology: ontology.id,
    lens: p.lens || null,
    one_liner: p.one_liner || null,
    commitments: decs.map((d) => ({ id: d.id, text: d.text, ts: d.ts, axis: d.axis || null, confidence: d.confidence || null })),
    semantic_bonds: bonds,
  };
  return { block: lines.length > 1 ? lines.join("\n") : "", structured };
}

// ---- graph (prerequisite closure over the space's ontology catalog) ----------
function computeGraph(model, ontology) {
  const nodes = model?.nodes || {};
  const lens = resolveLens(ontology, model?.profile?.lens);
  const deemph = new Set(lens.deemphasize);
  const completed = new Set(); const active = new Set();
  for (const axis of Object.keys(nodes)) {
    for (const n of nodes[axis] || []) {
      if (!n || !n.catalog_id || n.archived_at) continue;
      const st = String(n.status || "").toUpperCase();
      if (st === "COMPLETED") completed.add(n.catalog_id);
      else active.add(n.catalog_id);
    }
  }
  const satisfied = new Set([...completed, ...active]);
  const byId = {}; for (const p of ontology.catalog) byId[p.id] = p;
  const memo = new Map();
  function unmetChain(id, stack = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return new Set();
    stack.add(id);
    const out = new Set();
    for (const req of (byId[id]?.prerequisites || [])) {
      if (satisfied.has(req)) continue;
      out.add(req);
      for (const d of unmetChain(req, stack)) out.add(d);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  }
  const states = {}; const blocked = [];
  for (const p of ontology.catalog) {
    let status;
    if (completed.has(p.id)) status = "COMPLETED";
    else if (active.has(p.id)) status = "ACTIVE";
    else {
      const missing = (p.prerequisites || []).filter((r) => !satisfied.has(r));
      if (missing.length > 0) {
        status = "LOCKED";
        const chain = [...unmetChain(p.id)];
        blocked.push({
          id: p.id, axis: p.axis,
          blocked_by: missing,
          unlock_first: chain.filter((id) => (byId[id]?.prerequisites || []).every((r) => satisfied.has(r))),
        });
      } else status = deemph.has(p.id) ? "DEEMPH" : "READY";
    }
    states[p.id] = status;
  }
  const ready = ontology.catalog.filter((p) => states[p.id] === "READY").map((p) => p.id);
  // Emergent nodes (no catalog_id) are real graph citizens too.
  const emergent = [];
  for (const axis of Object.keys(nodes)) {
    for (const n of nodes[axis] || []) {
      if (n && !n.catalog_id && !n.archived_at) {
        emergent.push({ id: n.id, axis: n.axis || axis, label: n.label || n.id, status: String(n.status || "ACTIVE").toUpperCase() });
      }
    }
  }
  return {
    ontology: ontology.id,
    lens: lens.id || null,
    states,
    blocked,
    ready,
    emergent,
    semantic_bonds: semanticBondViews(model),
  };
}

// ---- substrate retrieval (same voyage + RPC contract as api/substrate) ------
async function retrieveRelevant({ userId, ventureId, q, k = 20 }) {
  if (!q || !VOYAGE_KEY) return [];
  const MIN_SCORE = 0.35; // relevance floor — weak matches read as noise, not memory
  const er = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "voyage-3", input: [String(q).slice(0, 2000)], input_type: "query" }),
  });
  if (!er.ok) return [];
  const eo = await er.json().catch(() => null);
  const embedding = eo?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) return [];
  const mr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_venture_substrate`, {
    method: "POST", headers: supaHeaders(),
    body: JSON.stringify({
      query_embedding: embedding, filter_user_id: userId, filter_venture_id: ventureId,
      match_count: Math.min(Math.max(1, k), 40),
      filter_pillar: null, filter_subnode_id: null, filter_event_type: null,
    }),
  });
  if (!mr.ok) return [];
  const rows = await mr.json().catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      kind: r.event_type, ts: r.created_at || null, axis: r.pillar || null,
      text: String(r.text || "").slice(0, 400), score: typeof r.similarity === "number" ? Math.round(r.similarity * 100) / 100 : null,
    }))
    .filter((m) => m.score === null || m.score >= MIN_SCORE);
}

// ---- abuse quotas (public signup means anyone can mint a key) ---------------
// Caps what costs US money: house-key LLM work, Voyage embeds, space churn.
// Sovereign writes (structured + own verdicts) stay effectively uncapped —
// that is the door we WANT wide open. Resets at 00:00 UTC.
const QUOTAS = {
  llm_day: parseInt(process.env.QUOTA_LLM_PER_DAY || "50", 10),
  substance_day: parseInt(process.env.QUOTA_SUBSTANCE_PER_DAY || "2000", 10),
  spaces_day: parseInt(process.env.QUOTA_SPACES_PER_DAY || "20", 10),
};
const UNLIMITED_WORKSPACES = new Set(
  (process.env.FOAAP_UNLIMITED_WORKSPACES || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
);
const quotaCache = new Map(); // workspaceId → { at, counts }
async function todayCounts(userId, workspaceId) {
  const hit = quotaCache.get(workspaceId);
  if (hit && Date.now() - hit.at < 60_000) return hit.counts;
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const url = `${SUPABASE_URL}/rest/v1/usage_events?user_id=eq.${encodeURIComponent(userId)}&surface=eq.engine_api&created_at=gte.${since.toISOString()}&select=event_type,metadata&limit=5000`;
  const r = await fetch(url, { headers: supaHeaders() });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  const counts = { llm: 0, substance: 0, spaces: 0 };
  for (const x of rows) {
    if (x.event_type === "space_created") counts.spaces += 1;
    else if (x.event_type === "substance_stored") counts.substance += (x.metadata?.stored || 1);
    else if (x.event_type === "compare_call") counts.llm += 1;
    else if (x.event_type === "event_ingested" && x.metadata?.mode === "house") counts.llm += 1;
  }
  quotaCache.set(workspaceId, { at: Date.now(), counts });
  return counts;
}
async function checkQuota(auth, kind, amount = 1) {
  if (UNLIMITED_WORKSPACES.has(auth.workspaceId)) return null;
  const counts = await todayCounts(auth.ownerUserId, auth.workspaceId);
  const over = (used, limit, label) =>
    err(429, "quota_exceeded", `daily ${label} quota reached (${used}/${limit} today) — resets 00:00 UTC. Sovereign ingest (structured claims + your own verdicts, see GET /adapters) is not LLM-capped.`);
  if (kind === "llm" && counts.llm + amount > QUOTAS.llm_day) return over(counts.llm, QUOTAS.llm_day, "managed-LLM");
  if (kind === "substance" && counts.substance + amount > QUOTAS.substance_day) return over(counts.substance, QUOTAS.substance_day, "substance");
  if (kind === "spaces" && counts.spaces + amount > QUOTAS.spaces_day) return over(counts.spaces, QUOTAS.spaces_day, "space-creation");
  const c = quotaCache.get(auth.workspaceId);
  if (c) c.counts[kind === "llm" ? "llm" : kind === "substance" ? "substance" : "spaces"] += amount;
  return null;
}

// ---- semantic candidate pool for the pair judge ------------------------------
// Recency is a dumb criterion for "what could this conflict with": a new claim
// must be judged against the claims that talk about the SAME THING, however
// old. One Voyage call embeds all fresh texts; per fresh item the substrate
// returns its nearest claims/decisions from the FULL history. Returns a set of
// source_ids to pull from the model (the model stays the source of truth for
// text/ts — substrate rows may lag).
async function semanticNeighborIds({ userId, ventureId, freshTexts, kPerItem = 6 }) {
  if (!VOYAGE_KEY || !freshTexts.length) return new Set();
  try {
    const er = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${VOYAGE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "voyage-3", input: freshTexts.map((t) => String(t).slice(0, 2000)), input_type: "query" }),
    });
    if (!er.ok) return new Set();
    const eo = await er.json().catch(() => null);
    const embeddings = (eo?.data || []).map((d) => d.embedding).filter(Array.isArray);
    const ids = new Set();
    await Promise.all(embeddings.map(async (embedding) => {
      const mr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_venture_substrate`, {
        method: "POST", headers: supaHeaders(),
        body: JSON.stringify({
          query_embedding: embedding, filter_user_id: userId, filter_venture_id: ventureId,
          match_count: kPerItem,
          filter_pillar: null, filter_subnode_id: null, filter_event_type: null,
        }),
      });
      if (!mr.ok) return;
      const rows = await mr.json().catch(() => []);
      for (const r of Array.isArray(rows) ? rows : []) {
        if ((r.event_type === "claim" || r.event_type === "decision") && r.source_id && (r.similarity ?? 1) >= 0.3) {
          ids.add(r.source_id);
        }
      }
    }));
    return ids;
  } catch {
    return new Set(); // judge falls back to the recency pool alone
  }
}

// ---- handlers ----------------------------------------------------------------
async function handleCreateKey(req) {
  const userId = await verifyJwt(req);
  if (!userId) return err(401, "auth", "A logged-in Supabase session (JWT) is required to create API keys.");
  let body = {}; try { body = await req.json(); } catch { /* optional */ }

  // Find-or-create the caller's workspace.
  let ws;
  const wr = await fetch(`${SUPABASE_URL}/rest/v1/workspaces?owner_user_id=eq.${userId}&select=id,name&limit=1`, { headers: supaHeaders() });
  const wrows = wr.ok ? await wr.json().catch(() => []) : [];
  if (Array.isArray(wrows) && wrows[0]) ws = wrows[0];
  else {
    const cr = await fetch(`${SUPABASE_URL}/rest/v1/workspaces`, {
      method: "POST", headers: supaHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({ owner_user_id: userId, name: body.workspace_name || "default" }),
    });
    if (!cr.ok) return err(500, "server", "workspace create failed");
    ws = (await cr.json())[0];
  }

  // Generate the key — plaintext returned exactly once. Self-service keys are
  // read+write by default: it is the caller's OWN engine (their workspace,
  // their spaces, their line) — write access to it is the whole point.
  const scopes = Array.isArray(body.scopes) && body.scopes.length
    ? body.scopes.filter((s) => ["read", "write"].includes(s))
    : ["read", "write"];
  if (!scopes.length) return err(400, "invalid_request", "scopes must be a subset of [read, write]");
  const rand = toHex(crypto.getRandomValues(new Uint8Array(20)));
  const key = `sk_foaap_live_${rand}`;
  const hash = await sha256Hex(key);
  const kr = await fetch(`${SUPABASE_URL}/rest/v1/api_keys`, {
    method: "POST", headers: supaHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({
      workspace_id: ws.id, key_hash: hash, prefix: key.slice(0, 16),
      scopes, label: body.label || null,
    }),
  });
  if (!kr.ok) return err(500, "server", "key create failed");
  const krow = (await kr.json())[0];
  return json(201, {
    key,                                   // ← shown ONCE; only the hash is stored
    key_id: krow.id, workspace_id: ws.id, scopes: krow.scopes,
    note: "Store this key now — it cannot be retrieved again.",
  });
}

// ---- key management (JWT-gated, self-service) --------------------------------
// A leaked key must be revocable without talking to a human.
async function handleListKeys(req) {
  const userId = await verifyJwt(req);
  if (!userId) return err(401, "auth", "A logged-in session (JWT) is required to manage keys.");
  const wr = await fetch(`${SUPABASE_URL}/rest/v1/workspaces?owner_user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`, { headers: supaHeaders() });
  const ws = wr.ok ? (await wr.json().catch(() => []))[0] : null;
  if (!ws) return json(200, { data: [] });
  const kr = await fetch(`${SUPABASE_URL}/rest/v1/api_keys?workspace_id=eq.${ws.id}&select=id,prefix,label,scopes,created_at,revoked_at&order=created_at.desc`, { headers: supaHeaders() });
  const rows = kr.ok ? await kr.json().catch(() => []) : [];
  return json(200, {
    data: rows.map((k) => ({
      id: k.id, prefix: k.prefix, label: k.label,
      scopes: (k.scopes || []).filter((x) => !x.startsWith("space:")),
      created_at: k.created_at, revoked: !!k.revoked_at,
    })),
  });
}

async function handleRevokeKey(req, keyId) {
  const userId = await verifyJwt(req);
  if (!userId) return err(401, "auth", "A logged-in session (JWT) is required to manage keys.");
  const wr = await fetch(`${SUPABASE_URL}/rest/v1/workspaces?owner_user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`, { headers: supaHeaders() });
  const ws = wr.ok ? (await wr.json().catch(() => []))[0] : null;
  if (!ws) return err(404, "invalid_request", "no workspace for this account");
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/api_keys?id=eq.${encodeURIComponent(keyId)}&workspace_id=eq.${ws.id}`, {
    method: "PATCH",
    headers: supaHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  const rows = pr.ok ? await pr.json().catch(() => []) : [];
  if (!rows.length) return err(404, "invalid_request", "key not found in your workspace");
  return json(200, { revoked: rows[0].id, prefix: rows[0].prefix });
}

async function handleSpaces(auth) {
  const url = `${SUPABASE_URL}/rest/v1/venture_models?user_id=eq.${encodeURIComponent(auth.ownerUserId)}&select=venture_id,updated_at,version,ontology:model->>ontology`;
  const r = await fetch(url, { headers: supaHeaders() });
  if (!r.ok) return err(500, "server", "spaces read failed");
  const rows = await r.json();
  return json(200, {
    data: (rows || [])
      .filter((x) => spaceAllowed(auth, x.venture_id))
      .map((x) => ({ id: x.venture_id, ontology: x.ontology || "venture", updated_at: x.updated_at, model_version: x.version ?? 0 })),
  });
}

// GET /usage?days=N — metrics: totals + daily series + transaction history.
// Costs are ESTIMATES from stored LLM token usage (extraction) plus flat
// figures for detection/embeds — good for dashboards, not for invoicing.
const COST_USD = {
  event_ingested: (m) => {
    // Sovereign/BYOK ingest burns no house-key tokens — near-zero to serve.
    if (m && m.sovereign) return 0.0002;
    const u = (m && m.llm_usage) || {};
    return ((u.input_tokens || 1900) * 3 + (u.output_tokens || 400) * 15) / 1e6 + 0.002;
  },
  context_call: () => 0.0001,
  lineage_call: () => 0.0001,
  verdict_call: () => 0.0001,
  substance_stored: (m) => ((m && m.stored) || 1) * 0.00003 + 0.0001, // embeds only
  compare_call: () => 0.012,
};
async function handleUsage(auth, urlObj) {
  const days = Math.min(Math.max(parseInt(urlObj?.searchParams?.get("days") || "7", 10) || 7, 1), 90);
  const since = new Date(Date.now() - (days - 1) * 86400_000);
  since.setUTCHours(0, 0, 0, 0);
  const url = `${SUPABASE_URL}/rest/v1/usage_events?user_id=eq.${encodeURIComponent(auth.ownerUserId)}&surface=eq.engine_api&created_at=gte.${since.toISOString()}&select=event_type,amount,metadata,created_at&order=created_at.desc&limit=5000`;
  const r = await fetch(url, { headers: supaHeaders() });
  if (!r.ok) return err(500, "server", "usage read failed");
  const rows = await r.json().catch(() => []);
  const usage = {}; const byDay = {}; let cost = 0;
  for (const x of rows) {
    usage[x.event_type] = (usage[x.event_type] || 0) + (x.amount || 1);
    const day = (x.created_at || "").slice(0, 10);
    if (!byDay[day]) byDay[day] = { date: day, transactions: 0, cost_usd: 0 };
    const c = (COST_USD[x.event_type] || (() => 0))(x.metadata);
    byDay[day].transactions += 1;
    byDay[day].cost_usd += c;
    cost += c;
  }
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const row = byDay[d] || { date: d, transactions: 0, cost_usd: 0 };
    row.cost_usd = Math.round(row.cost_usd * 10000) / 10000;
    daily.push(row);
  }
  const transactions = rows.slice(0, 25).map((x) => ({
    ts: x.created_at, type: x.event_type, space: (x.metadata && x.metadata.space) || null,
    cost_usd: Math.round(((COST_USD[x.event_type] || (() => 0))(x.metadata)) * 10000) / 10000,
  }));
  return json(200, {
    workspace_id: auth.workspaceId, days,
    totals: {
      transactions: rows.length,
      cost_usd: Math.round(cost * 1000) / 1000,
      avg_daily_usd: Math.round((cost / days) * 1000) / 1000,
    },
    usage, daily, transactions,
  });
}

// GET /key — introspection for the presented key (console auth chip, debugging).
function handleKeyIntrospect(auth) {
  return json(200, {
    key_id: auth.keyId,
    prefix: auth.prefix,
    workspace_id: auth.workspaceId,
    scopes: auth.scopes.filter((s) => !s.startsWith("space:")),
    spaces: auth.spaceIds.length ? auth.spaceIds : "all",
  });
}

// ---- writes: POST /spaces ---------------------------------------------------
async function handleCreateSpace(auth, req) {
  let body = {}; try { body = await req.json(); } catch { /* optional */ }
  const ontologyId = body.ontology ? String(body.ontology).slice(0, 40) : "venture";
  if (!listOntologies().includes(ontologyId)) {
    return err(400, "invalid_request", `unknown ontology "${ontologyId}" — available: ${listOntologies().join(", ")}`);
  }
  const ontology = getOntology(ontologyId);
  const q = await checkQuota(auth, "spaces");
  if (q) return q;
  const spaceId = `sp_${toHex(crypto.getRandomValues(new Uint8Array(5)))}`;
  const model = newModel({
    name: body.name ? String(body.name).slice(0, 80) : null,
    ontology: ontologyId,
    lens: (body.lens || body.archetype) ? String(body.lens || body.archetype).slice(0, 40) : null,
    axes: ontology.axes,
  });
  appendEvent(model, { kind: "space_created", type: "system", text: body.name || spaceId, ts: Date.now() });
  const saved = await saveModel({ userId: auth.ownerUserId, ventureId: spaceId, model, baseVersion: -1 });
  meterUsage({ userId: auth.ownerUserId, eventType: "space_created", metadata: { space: spaceId } });
  return json(201, { id: spaceId, ontology: ontologyId, lens: model.profile.lens, model_version: saved.version ?? 1 });
}

// ---- writes: POST /spaces/:id/events — THE ingest (Phase B) ------------------
async function handleIngestEvent(auth, ventureId, req) {
  if (!spaceAllowed(auth, ventureId)) return err(404, "invalid_request", `space "${ventureId}" not found`);
  let body = {}; try { body = await req.json(); } catch { return err(400, "invalid_request", "JSON body required"); }
  const type = ["message", "decision", "document", "signal"].includes(body.type) ? body.type : "message";
  const text = String(body.text || "").trim();
  if (text.length > 16384) {
    return err(413, "invalid_request", "text must be at most 16384 characters; split long input instead of truncating it");
  }
  const structured = Array.isArray(body.claims) || Array.isArray(body.decisions)
    || Array.isArray(body.activations) || Array.isArray(body.bonds)
    || Array.isArray(body.bond_evidence) || Array.isArray(body.predictions)
    || Array.isArray(body.outcomes) || Array.isArray(body.residuals);
  // SUBSTANCE: events[] is the firehose door — raw messages that are not yet
  // knots. They land on the line + the substrate (zero LLM, zero contention)
  // and distill into knots later, in one extraction per window.
  const batchInput = Array.isArray(body.events)
    ? body.events.filter((e) => e && String(e.text || "").trim())
    : null;
  if (batchInput && batchInput.length > 100) {
    return err(413, "invalid_request", "events[] accepts at most 100 items per request; split the batch instead of truncating it");
  }
  if (batchInput && batchInput.some((event) => String(event.text || "").trim().length > 16384)) {
    return err(413, "invalid_request", "each events[].text must be at most 16384 characters; split long events instead of truncating them");
  }
  const batch = batchInput;
  if (Array.isArray(body.source_atoms) && body.source_atoms.length > 200) {
    return err(413, "invalid_request", "source_atoms accepts at most 200 items; split the event instead of truncating it");
  }
  if (Array.isArray(body.source_atoms) && body.source_atoms.some((atom) => String(atom?.text || "").trim().length > 16384)) {
    return err(413, "invalid_request", "each source atom must be at most 16384 characters; split long atoms instead of truncating them");
  }
  const suppliedSourceAtoms = normalizeSourceAtoms(body.source_atoms);
  if (Array.isArray(body.source_atoms) && suppliedSourceAtoms.length !== body.source_atoms.length) {
    return err(400, "invalid_request", "every source atom needs a unique non-empty id and non-empty text");
  }
  if (!text && !structured && !(batch && batch.length)) {
    return err(400, "invalid_request", "send text, events[] substance, or typed structure/bonds/evidence/outcomes — see GET /adapters");
  }
  const role = body.role === "assistant" ? "assistant" : "user";
  const idem = (req.headers.get("idempotency-key") || "").trim().slice(0, 80) || null;
  // BYOK: the builder's own model key. Pass-through only — never stored,
  // never logged. In sovereign-strict deployments the house key is dead code.
  const modelKey = (req.headers.get("x-model-key") || "").trim() || null;
  const strict = process.env.SOVEREIGN_STRICT === "1";
  // The key any server-side LLM call would use. Structured ingest without a
  // BYOK key deliberately gets NONE: their model judges, via the docket.
  const serverKey = modelKey || (structured || strict ? null : (process.env.ANTHROPIC_API_KEY || null));

  const row = await getSpaceRow(auth.ownerUserId, ventureId);
  if (!row) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const ontology = getOntology(row.model?.ontology || "venture");
  const model = normalizeModel(row.model, ontology.axes);

  // Idempotency — a retried POST must not ingest twice. Primary lookup is the
  // line table; the blob check covers pre-table events.
  if (idem) {
    const priorLine = await lineIdemLookup(auth.ownerUserId, ventureId, idem);
    if (priorLine) {
      return json(200, {
        event_id: priorLine.id, replayed: true,
        understood: priorLine.payload?.understood || null,
        ...(priorLine.payload?.substance ? { stored: priorLine.payload.substance, mode: "substance" } : {}),
        model_version: row.version ?? 0,
      });
    }
    const prior = (model.events || []).find((e) => e && e.payload && e.payload.idem === idem);
    if (prior) {
      return json(200, { event_id: prior.id, replayed: true, understood: prior.payload.understood || null, model_version: row.version ?? 0 });
    }
  }
  const ts = body.occurred_at ? Date.parse(body.occurred_at) || Date.now() : Date.now();

  // ---- substance branch: store the batch, index it, maybe distill ----------
  if (batch && batch.length) {
    const q = await checkQuota(auth, "substance", batch.length);
    if (q) return q;
    const inserted = await insertLineEvents(auth.ownerUserId, ventureId, batch.map((e, i) => ({
      type: ["message", "decision", "document", "signal"].includes(e.type) ? e.type : "message",
      role: e.role === "assistant" ? "assistant" : "user",
      text: e.text,
      occurred_at: e.occurred_at || undefined,
      idem_key: i === 0 ? idem : null,
      payload: i === 0 && idem ? { substance: batch.length } : {},
    })));
    const sub = await pushSubstrate({
      userId: auth.ownerUserId, spaceId: ventureId,
      rows: inserted.map((r) => ({ event_type: "raw_turn", source_id: r.id, text: `${r.role}: ${r.text}`, metadata: { via: "engine_api", type: r.type, substance: true } })),
    });
    const undistilled = await countUndistilled(auth.ownerUserId, ventureId);
    meterUsage({
      userId: auth.ownerUserId, eventType: "substance_stored",
      metadata: { space: ventureId, stored: inserted.length, indexed: sub.inserted, undistilled, sovereign: true },
    });
    const distillKey = modelKey || (strict ? null : (process.env.ANTHROPIC_API_KEY || null));
    const shouldDistill = body.distill === "now" || (body.distill !== "hold" && undistilled >= DISTILL_THRESHOLD);
    let distilled = null;
    if (shouldDistill && distillKey) distilled = await runDistill({ auth, ventureId, modelKey });
    return json(201, {
      mode: "substance",
      stored: inserted.length,
      indexed: sub.inserted,
      undistilled: distilled ? distilled.remaining : undistilled,
      distilled: distilled && distilled.body ? { event_id: distilled.body.event_id, understood: distilled.body.understood, pairs_to_judge: distilled.body.pairs_to_judge || undefined } : null,
      ...(shouldDistill && !distillKey ? { note: "substance held — distilling needs an X-Model-Key header, or POST structure directly (see /adapters)" } : {}),
    });
  }

  // 1. STRUCTURE IN. Sovereign path: the builder's model already ran the
  // extraction adapter — we validate against the grammar and the ontology,
  // zero LLM. Managed path: prose in, the extraction adapter runs server-side
  // with the BYOK key (or the house key, local dogfood only).
  let extracted;
  if (structured) {
    const axisSet = new Set(ontology.axes.map((a) => a.id));
    const claimsIn = Array.isArray(body.claims) ? body.claims : [];
    const decisionsIn = Array.isArray(body.decisions) ? body.decisions : [];
    const activationsIn = Array.isArray(body.activations) ? body.activations : [];
    const bondsIn = Array.isArray(body.bonds) ? body.bonds : [];
    const bondEvidenceIn = Array.isArray(body.bond_evidence) ? body.bond_evidence : [];
    const predictionsIn = Array.isArray(body.predictions) ? body.predictions : [];
    const outcomesIn = Array.isArray(body.outcomes) ? body.outcomes : [];
    const residualsIn = Array.isArray(body.residuals) ? body.residuals : [];
    const sourceAtomsIn = suppliedSourceAtoms;
    if (
      claimsIn.length > 100 || decisionsIn.length > 100 || activationsIn.length > 50
      || bondsIn.length > 100 || bondEvidenceIn.length > 200
      || predictionsIn.length > 100 || outcomesIn.length > 100
      || residualsIn.length > 200 || sourceAtomsIn.length > 200
    ) {
      return err(413, "invalid_request", "semantic batch too large — split the event instead of truncating it");
    }
    for (const c of claimsIn) {
      if (!c || !String(c.statement || "").trim()) return err(400, "invalid_request", "every claim needs a statement");
      if (!axisSet.has(c.axis)) return err(400, "invalid_request", `claim axis "${c?.axis}" is not in ontology "${ontology.id}" (${[...axisSet].join(" | ")})`);
      if (c.kind && !CLAIM_KINDS.includes(c.kind)) return err(400, "invalid_request", `claim kind "${c.kind}" — allowed: ${CLAIM_KINDS.join(" | ")}`);
    }
    for (const d of decisionsIn) {
      if (!d || !String(d.text || "").trim()) return err(400, "invalid_request", "every decision needs text");
      if (!axisSet.has(d.axis)) return err(400, "invalid_request", `decision axis "${d?.axis}" is not in ontology "${ontology.id}"`);
    }
    for (const a of activationsIn) {
      if (!a || !axisSet.has(a.axis)) return err(400, "invalid_request", "every activation needs a valid axis");
    }
    for (const bond of bondsIn) {
      const subject = typeof bond?.subject === "object" ? (bond.subject.label || bond.subject.name || bond.subject.id) : bond?.subject;
      const object = typeof bond?.object === "object" ? (bond.object.label || bond.object.name || bond.object.id) : bond?.object;
      if (!String(subject || "").trim() || !String(bond?.relation || "").trim() || !String(object || "").trim()) {
        return err(400, "invalid_request", "every bond needs subject, relation, and object");
      }
    }
    for (const evidence of bondEvidenceIn) {
      if (!String(evidence?.bond_id || "").trim() || !String(evidence?.statement || evidence?.why || "").trim()) {
        return err(400, "invalid_request", "every bond_evidence item needs bond_id and statement/why");
      }
      if (evidence.polarity && !["support", "opposition"].includes(evidence.polarity)) {
        return err(400, "invalid_request", "bond evidence polarity must be support or opposition");
      }
    }
    for (const prediction of predictionsIn) {
      if (!String(prediction?.bond_id || "").trim() || !String(prediction?.statement || prediction?.expected || "").trim()) {
        return err(400, "invalid_request", "every prediction needs bond_id and statement");
      }
    }
    for (const outcome of outcomesIn) {
      if (!String(outcome?.bond_id || "").trim() || !String(outcome?.observed || outcome?.statement || "").trim()) {
        return err(400, "invalid_request", "every outcome needs bond_id and observed");
      }
      if (outcome.result && !["confirmed", "refuted", "mixed", "inconclusive"].includes(outcome.result)) {
        return err(400, "invalid_request", "outcome result must be confirmed, refuted, mixed, or inconclusive");
      }
    }
    for (const r of residualsIn) {
      if (!r || !String(r.source_atom_id || "").trim() || !String(r.reason || "").trim()) {
        return err(400, "invalid_request", "every residual needs source_atom_id and reason");
      }
    }
    extracted = {
      claims: claimsIn,
      decisions: decisionsIn,
      activations: activationsIn,
      bonds: bondsIn,
      bond_evidence: bondEvidenceIn,
      predictions: predictionsIn,
      outcomes: outcomesIn,
      residuals: residualsIn,
      source_atoms: sourceAtomsIn,
      usage: null,
    };
  } else {
    if (!serverKey) return err(400, "invalid_request", "sovereign mode: prose ingest needs an X-Model-Key header (your key runs the extraction adapter server-side), or send structure directly — GET /adapters has both prompts");
    if (!modelKey) {
      const q = await checkQuota(auth, "llm");
      if (q) return q;
    }
    extracted = await extractFromEvent({
      model,
      event: { type, role, text, source_atoms: suppliedSourceAtoms },
      ontology,
      apiKey: serverKey,
    });
  }

  // Semantic conservation gate. Old clients remain readable as "unverified",
  // but whenever source atoms are supplied every one must be projected into
  // structure or explicitly preserved as a residual.
  const sourceAtoms = normalizeSourceAtoms(extracted.source_atoms);
  const coverage = semanticCoverage({
    sourceAtoms,
    claims: extracted.claims,
    decisions: extracted.decisions,
    activations: extracted.activations,
    bonds: extracted.bonds,
    bondEvidence: extracted.bond_evidence,
    predictions: extracted.predictions,
    outcomes: extracted.outcomes,
    residuals: extracted.residuals,
  });
  if (coverage.status === "incomplete") {
    return json(422, {
      error: {
        type: "semantic_coverage",
        message: "every source atom must be cited by structure or declared as a residual",
        coverage,
      },
    });
  }

  // 2. Pair judging — new commitments vs existing committed state.
  // The pool is semantic-first: the substrate returns each fresh claim's
  // nearest neighbors from the FULL history (a conflict with a 3-month-old
  // commitment must still surface), topped up with the recency pool so brand
  // new spaces and substrate lag are covered. Anything retired by a resolved
  // contradiction is excluded — resolution means the loser stops competing.
  const retired = new Set(
    (model.contradictions || [])
      .filter((c) => c && c.resolved_at && c.source_ids?.a?.id)
      .map((c) => c.source_ids.a.id)
  );
  const axesWithDecisions = new Set((model.decisions || []).filter(Boolean).map((d) => d.axis));
  const latestClaimByAxis = {};
  for (const c of (model.claims || []).filter((c) => c && !c.archived_at && !retired.has(c.id))) {
    if (axesWithDecisions.has(c.axis)) continue;
    const cur = latestClaimByAxis[c.axis];
    if (!cur || (c.ts || 0) > (cur.ts || 0)) latestClaimByAxis[c.axis] = c;
  }
  const liveDecisions = (model.decisions || []).filter((d) => d && !retired.has(d.id));
  const recencyPool = [
    ...liveDecisions.map((d) => ({ ref_type: "decision", ref_id: d.id, axis: d.axis, text: d.text, ts: d.ts })),
    ...Object.values(latestClaimByAxis).map((c) => ({ ref_type: "claim", ref_id: c.id, axis: c.axis, text: c.statement, ts: c.ts })),
  ];
  const freshDrafts = freshSemanticDrafts(extracted, ts);
  const freshTexts = freshDrafts.map((item) => item.text).filter(Boolean);
  const freshAxes = new Set(freshDrafts.map((item) => item.axis).filter(Boolean));
  const neighborIds = await semanticNeighborIds({ userId: auth.ownerUserId, ventureId, freshTexts });
  const semanticPool = [];
  if (neighborIds.size) {
    for (const d of liveDecisions) {
      if (neighborIds.has(d.id)) semanticPool.push({ ref_type: "decision", ref_id: d.id, axis: d.axis, text: d.text, ts: d.ts });
    }
    for (const c of (model.claims || []).filter((c) => c && !c.archived_at && !retired.has(c.id))) {
      if (neighborIds.has(c.id)) semanticPool.push({ ref_type: "claim", ref_id: c.id, axis: c.axis, text: c.statement, ts: c.ts });
    }
  }
  // Same-axis state is a deterministic recall floor: embeddings may fail or
  // lag, but a new product commitment must still meet every live product
  // commitment. Semantic neighbors add cross-axis relations.
  const axisPool = [
    ...liveDecisions
      .filter((d) => freshAxes.has(d.axis))
      .map((d) => ({ ref_type: "decision", ref_id: d.id, axis: d.axis, text: d.text, ts: d.ts })),
    ...(model.claims || [])
      .filter((c) => c && !c.archived_at && !retired.has(c.id) && freshAxes.has(c.axis))
      .map((c) => ({ ref_type: "claim", ref_id: c.id, axis: c.axis, text: c.statement, ts: c.ts })),
  ];
  const seenIds = new Set(semanticPool.map((x) => x.ref_id));
  const existing = [
    ...semanticPool,
    ...axisPool.filter((x) => {
      if (seenIds.has(x.ref_id)) return false;
      seenIds.add(x.ref_id);
      return true;
    }),
    ...recencyPool.filter((x) => {
      if (seenIds.has(x.ref_id)) return false;
      seenIds.add(x.ref_id);
      return true;
    }),
  ];
  const fresh = freshDrafts;
  // Judge server-side only when a key is available (BYOK or, non-strict prose
  // path, the house key). Otherwise the pairs come back as the DOCKET and the
  // builder's model judges them via POST /verdicts — their intelligence, our
  // grammar.
  const wantsDocket = !serverKey;
  const judged = !wantsDocket && existing.length && fresh.length
    ? await judgePairs({ existing, fresh, apiKey: serverKey })
    : { contradictions: [], lineage: [] };
  let detected = judged.contradictions;
  // Deduplicate exact pairs, never cap semantic conflicts silently.
  const byPair = new Map();
  for (const c of detected) {
    const k = `${c.source_ids?.a?.id || c.claim_a}::${c.source_ids?.b?.id || c.claim_b}`;
    if (!byPair.has(k) || (c.confidence || 0) > (byPair.get(k).confidence || 0)) byPair.set(k, c);
  }
  detected = [...byPair.values()].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  // Lineage edges by fresh text: which existing claims each new item refines.
  const lineageByText = new Map();
  for (const l of judged.lineage) {
    const k = l.fresh_text;
    if (!lineageByText.has(k)) lineageByText.set(k, []);
    lineageByText.get(k).push({ id: l.existing.id, relation: l.relation, confidence: l.confidence, why: l.why });
  }
  const edgesFor = (t) => lineageByText.get(String(t || "").slice(0, 280)) || null;

  // 3. Mutate the model (pure functions), then CAS-save with one retry.
  const event = appendEvent(model, {
    kind: "ingest",
    type,
    text,
    payload: {
      role,
      idem,
      source_atom_ids: sourceAtoms.map((atom) => atom.id),
      residuals: extracted.residuals || [],
      coverage,
    },
    ts,
  });
  const claims = extracted.claims.map((c) => addClaim(model, { ...c, derived_from: edgesFor(c.statement), ts }));
  const decisions = extracted.decisions.map((d) => {
    const dec = addDecision(model, { ...d, ts });
    const edges = edgesFor(d.text);
    if (edges) dec.derived_from = edges;
    return dec;
  });
  const nodes = extracted.activations.map((a) => addNode(model, ontology, { ...a, ts })).filter(Boolean);
  const bondResults = (extracted.bonds || [])
    .map((bond) => addSemanticBond(model, bond, ts))
    .filter(Boolean);
  const bondEvidenceResults = [];
  for (const evidence of extracted.bond_evidence || []) {
    const result = addBondEvidence(model, String(evidence.bond_id), evidence, ts);
    if (!result) return err(400, "invalid_request", `semantic bond "${evidence.bond_id}" not found`);
    bondEvidenceResults.push(result);
  }
  const predictionResults = [];
  for (const prediction of extracted.predictions || []) {
    const result = addBondPrediction(model, String(prediction.bond_id), prediction, ts);
    if (!result) return err(400, "invalid_request", `semantic bond "${prediction.bond_id}" not found`);
    predictionResults.push(result);
  }
  const outcomeResults = [];
  for (const outcome of extracted.outcomes || []) {
    const result = recordBondOutcome(model, String(outcome.bond_id), outcome, ts);
    if (!result) return err(400, "invalid_request", `semantic bond "${outcome.bond_id}" not found`);
    outcomeResults.push(result);
  }
  const contradictions = detected.map((c) => {
    // Wire the new side of the trail to the just-created decision/claim ids.
    const newRef = decisions.find((d) => d.text === c.claim_b) || claims.find((k) => k.statement === c.claim_b);
    if (newRef && c.source_ids?.b) c.source_ids.b.id = newRef.id;
    return addContradiction(model, { ...c, ts });
  });
  // The docket — built only when nothing judged server-side: every fresh item
  // (now with a real id) against the curated pool. Their model answers via
  // POST /verdicts.
  const freshRefs = freshSemanticRefs({ claims, decisions });
  const pairs_to_judge = [];
  if (wantsDocket) {
    for (const f of freshRefs) {
      for (const e of existing) {
        pairs_to_judge.push({
          a: { id: e.ref_id, type: e.ref_type, axis: e.axis || null, text: String(e.text || "").slice(0, 280) },
          b: { id: f.id, type: f.type, text: String(f.text || "").slice(0, 280) },
        });
      }
    }
  }

  // Every born arrow goes into the immutable log WITH its intention — the
  // line records not just the knots but the edges and their why.
  const lineage_edges = [...claims, ...decisions]
    .filter((x) => Array.isArray(x.derived_from) && x.derived_from.length)
    .flatMap((x) => x.derived_from.map((e) => ({ from: x.id, to: e.id, relation: e.relation, confidence: e.confidence ?? null, why: e.why || null })));

  // Stamp a replay summary onto the event so an idempotent retry can answer.
  event.payload.understood = {
    claims: claims.map((c) => c.id),
    decisions: decisions.map((d) => d.id),
    contradictions: contradictions.map((c) => c.id),
    nodes: nodes.map((n) => n.id),
    bonds: bondResults.map((result) => result.bond.id),
    bond_evidence: bondEvidenceResults.map((result) => result.evidence?.id).filter(Boolean),
    predictions: predictionResults.map((result) => result.prediction.id),
    outcomes: outcomeResults.map((result) => result.outcome.id),
    lineage: lineage_edges,
    coverage,
  };

  let saved = await saveModel({ userId: auth.ownerUserId, ventureId, model, baseVersion: row.version ?? -1 });
  if (saved.status === "conflict") {
    // Someone wrote concurrently — replay mutations onto the server's model once.
    const server = normalizeModel(saved.model && typeof saved.model === "object" ? saved.model : model, ontology.axes);
    server.events = [...(server.events || []), event];
    server.claims = [...(server.claims || []), ...claims];
    server.decisions = [...(server.decisions || []), ...decisions];
    server.contradictions = [...(server.contradictions || []), ...contradictions];
    const touchedBondIds = new Set([
      ...bondResults.map((result) => result.bond.id),
      ...bondEvidenceResults.map((result) => result.bond.id),
      ...predictionResults.map((result) => result.bond.id),
      ...outcomeResults.map((result) => result.bond.id),
    ]);
    const touchedBonds = new Map(
      (model.bonds || []).filter((bond) => touchedBondIds.has(bond.id)).map((bond) => [bond.id, bond]),
    );
    server.bonds = (server.bonds || []).map((bond) => touchedBonds.get(bond.id) || bond);
    for (const [bondId, bond] of touchedBonds) {
      if (!server.bonds.some((item) => item.id === bondId)) server.bonds.push(bond);
    }
    for (const n of nodes) {
      const have = (server.nodes?.[n.axis] || []).some((x) => x && x.id === n.id && !x.archived_at);
      if (!have) server.nodes = { ...server.nodes, [n.axis]: [...(server.nodes?.[n.axis] || []), n] };
    }
    saved = await saveModel({ userId: auth.ownerUserId, ventureId, model: server, baseVersion: saved.version });
    if (saved.status === "conflict") return err(409, "conflict", "concurrent write — retry the event");
  }

  // Mirror the understanding onto the LINE table (the blob keeps only knots;
  // the table is the durable, queryable line). Distill digests skip the
  // raw_turn embed — their source turns are already in the substrate.
  const lineKind = body.line_kind === "distill" ? "distill" : "ingest";
  try {
    await insertLineEvents(auth.ownerUserId, ventureId, [{
      kind: lineKind, type, role,
      text: text || "(structured)",
      idem_key: idem,
      payload: { understood: event.payload.understood, source_atoms: sourceAtoms },
      distilled_at: new Date().toISOString(),
    }]);
  } catch { /* the blob event already records this understanding */ }

  // 4. Substrate embeds (best-effort, awaited so the demo is immediately queryable).
  await pushSubstrate({
    userId: auth.ownerUserId,
    spaceId: ventureId,
    rows: [
      ...(lineKind === "distill" ? [] : sourceAtoms.map((atom) => ({
        event_type: "raw_turn",
        source_id: `${event.id}:${atom.id}`,
        text: `${role}: ${atom.text}`,
        metadata: { via: "engine_api", type, atom_id: atom.id },
      }))),
      ...decisions.map((d) => ({ event_type: "decision", source_id: d.id, axis: d.axis, text: d.text, metadata: { confidence: d.confidence } })),
      ...claims.map((c) => ({ event_type: "claim", source_id: c.id, axis: c.axis, text: c.statement, metadata: { interpretation: c.interpretation, kind: c.kind } })),
      ...bondResults.map((result) => ({
        event_type: "semantic_bond",
        source_id: result.bond.id,
        text: `${result.bond.subject.label} ${result.bond.relation} ${result.bond.object.label}`,
        metadata: { status: result.view.status, applicability: result.view.applicability },
      })),
      ...outcomeResults.map((result) => ({
        event_type: "bond_outcome",
        source_id: result.outcome.id,
        text: result.outcome.observed,
        metadata: { bond_id: result.bond.id, result: result.outcome.result },
      })),
    ],
  });

  const mode = modelKey ? "byok" : (wantsDocket ? "sovereign" : "house");
  meterUsage({
    userId: auth.ownerUserId,
    eventType: "event_ingested",
    metadata: {
      space: ventureId, mode, sovereign: mode !== "house",
      claims: claims.length, decisions: decisions.length, contradictions: contradictions.length,
      bonds: bondResults.length, outcomes: outcomeResults.length,
      llm_usage: extracted.usage,
    },
  });

  return json(201, {
    event_id: event.id,
    mode,
    understood: {
      claims: claims.map((c) => ({
        id: c.id, axis: c.axis, node: c.node, statement: c.statement,
        interpretation: c.interpretation, kind: c.kind,
        source_atom_ids: c.source_atom_ids || [],
        derived_from: c.derived_from || null,
      })),
      decisions: decisions.map((d) => ({
        id: d.id, axis: d.axis, text: d.text, confidence: d.confidence,
        source_atom_ids: d.source_atom_ids || [],
        derived_from: d.derived_from || null,
      })),
      contradictions: contradictions.map((c) => ({
        id: c.id, severity: c.severity, confidence: c.confidence, why: c.why || null,
        claim_a: c.claim_a, claim_b: c.claim_b, source_ids: c.source_ids, trail: c.trail,
      })),
      nodes: nodes.map((n) => ({
        id: n.id, axis: n.axis, label: n.label, source: n.source,
        source_atom_ids: n.source_atom_ids || [],
        why_now: n.why_now,
      })),
      bonds: bondResults.map((result) => ({ ...result.view, created: result.created })),
      bond_evidence: bondEvidenceResults.map((result) => ({
        id: result.evidence?.id || null,
        bond_id: result.bond.id,
        duplicate: !result.evidence,
        view: result.view,
      })),
      predictions: predictionResults.map((result) => ({
        ...result.prediction,
        bond_id: result.bond.id,
        created: result.created,
      })),
      outcomes: outcomeResults.map((result) => ({
        ...result.outcome,
        bond_id: result.bond.id,
        created: result.created,
        view: result.view,
      })),
      lineage: lineage_edges,
      residuals: extracted.residuals || [],
      coverage,
      next_action: deriveNextAction(model, ontology),
      model_version: saved.version,
    },
    ...(wantsDocket ? {
      pairs_to_judge,
      judge: pairs_to_judge.length
        ? { adapter: "GET /api/v1/adapters (judge.system)", submit: `POST /api/v1/spaces/${ventureId}/verdicts` }
        : undefined,
    } : {}),
  });
}

// ---- distillation: substance → knots, one extraction per window --------------
// Reuses the full ingest pipeline via a synthetic request: the window digest
// becomes ONE "document" event, so the blob gains one distillation knot-event
// (not N message events) and every downstream guarantee (judge/docket, CAS,
// lineage, idempotency) applies unchanged.
const DISTILL_THRESHOLD = 8;
async function runDistill({ auth, ventureId, modelKey }) {
  const window = await fetchUndistilled(auth.ownerUserId, ventureId, 50);
  if (!window.length) return { body: null, remaining: 0, status: 200 };
  const sourceAtoms = [];
  const used = [];
  for (const r of window) {
    const atom = {
      id: String(r.id),
      text: `[${r.type || "message"} · ${r.role || "user"}] ${String(r.text || "")}`,
    };
    const nextSize = sourceAtoms.reduce((sum, item) => sum + item.id.length + item.text.length + 5, 0)
      + atom.id.length + atom.text.length + 5;
    if (sourceAtoms.length && nextSize > MAX_EXTRACTION_SOURCE_CHARS) break;
    if (nextSize > MAX_EXTRACTION_SOURCE_CHARS) {
      return {
        body: {
          error: {
            type: "semantic_coverage",
            message: `source event ${r.id} exceeds the extraction window; split it before distillation`,
          },
        },
        remaining: window.length,
        status: 413,
      };
    }
    sourceAtoms.push(atom);
    used.push(r);
  }
  const digest = sourceAtoms.map((atom) => `[${atom.id}] ${atom.text}`).join("\n\n");
  const headers = new Headers({ "Content-Type": "application/json" });
  if (modelKey) headers.set("x-model-key", modelKey);
  const synthetic = new Request("http://internal/distill", {
    method: "POST", headers,
    body: JSON.stringify({
      type: "document",
      role: "user",
      text: digest,
      source_atoms: sourceAtoms,
      line_kind: "distill",
    }),
  });
  const res = await handleIngestEvent(auth, ventureId, synthetic);
  const resBody = await res.json().catch(() => null);
  if (res.status === 201 && resBody) {
    await markDistilled(used.map((r) => r.id), { distill_event: resBody.event_id });
  }
  const remaining = await countUndistilled(auth.ownerUserId, ventureId);
  return { body: resBody, remaining, status: res.status };
}

// POST /spaces/:id/distill — turn accumulated substance into knots on demand.
async function handleDistillRoute(auth, ventureId, req) {
  if (!spaceAllowed(auth, ventureId)) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const modelKey = (req.headers.get("x-model-key") || "").trim() || null;
  const strict = process.env.SOVEREIGN_STRICT === "1";
  const distillKey = modelKey || (strict ? null : (process.env.ANTHROPIC_API_KEY || null));
  if (!distillKey) return err(400, "invalid_request", "distilling runs the extraction adapter — send an X-Model-Key header, or POST structure to /events instead (see /adapters)");
  const out = await runDistill({ auth, ventureId, modelKey });
  if (out.status >= 400) return json(out.status, out.body || { error: { type: "server", message: "distill failed" } });
  return json(200, {
    distilled_event: out.body ? out.body.event_id : null,
    understood: out.body ? out.body.understood : null,
    remaining_undistilled: out.remaining,
  });
}

// ---- writes: POST /spaces/:id/verdicts — the sovereign judge return path -----
// THEIR model ran the judge adapter over the docket; our grammar records the
// outcome. Zero LLM calls: validation + pure mutations + CAS.
async function handleVerdicts(auth, ventureId, req) {
  if (!spaceAllowed(auth, ventureId)) return err(404, "invalid_request", `space "${ventureId}" not found`);
  let body = {}; try { body = await req.json(); } catch { return err(400, "invalid_request", "JSON body required"); }
  const verdicts = Array.isArray(body.verdicts) ? body.verdicts : null;
  if (!verdicts || !verdicts.length) return err(400, "invalid_request", "verdicts[] required: [{a_id, b_id, relation, confidence, severity?, why}]");
  if (verdicts.length > 500) {
    return err(413, "invalid_request", "verdicts[] accepts at most 500 items; split the docket instead of truncating it");
  }

  const row = await getSpaceRow(auth.ownerUserId, ventureId);
  if (!row) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const ontology = getOntology(row.model?.ontology || "venture");

  const mutate = (m) => {
    const ts = Date.now();
    const applied = applyVerdicts(m, verdicts, ts);
    const event = appendEvent(m, { kind: "verdicts", type: "signal", text: `${verdicts.length} external verdicts`, payload: {}, ts });
    event.payload.understood = {
      contradictions: applied.contradictions.map((c) => c.id),
      lineage: applied.lineage,
    };
    return applied;
  };

  let model = normalizeModel(row.model, ontology.axes);
  let applied = mutate(model);
  let saved = await saveModel({ userId: auth.ownerUserId, ventureId, model, baseVersion: row.version ?? -1 });
  if (saved.status === "conflict") {
    // Concurrent write — verdicts are pure inputs and applyVerdicts dedupes,
    // so re-running the whole mutation on the server's model is safe.
    model = normalizeModel(saved.model && typeof saved.model === "object" ? saved.model : model, ontology.axes);
    applied = mutate(model);
    saved = await saveModel({ userId: auth.ownerUserId, ventureId, model, baseVersion: saved.version });
    if (saved.status === "conflict") return err(409, "conflict", "concurrent write — retry the verdicts");
  }

  meterUsage({
    userId: auth.ownerUserId,
    eventType: "verdict_call",
    metadata: { space: ventureId, submitted: verdicts.length, contradictions: applied.contradictions.length, edges: applied.lineage.length, skipped: applied.skipped.length },
  });

  return json(200, {
    applied: {
      contradictions: applied.contradictions.map((c) => ({
        id: c.id, severity: c.severity, confidence: c.confidence, why: c.why,
        claim_a: c.claim_a, claim_b: c.claim_b, source_ids: c.source_ids,
      })),
      lineage: applied.lineage,
    },
    skipped: applied.skipped,
    next_action: deriveNextAction(model, ontology),
    model_version: saved.version,
  });
}

// ---- writes: POST /spaces/:id/contradictions/:cid/resolve --------------------
async function handleResolve(auth, ventureId, contradictionId, req) {
  if (!spaceAllowed(auth, ventureId)) return err(404, "invalid_request", `space "${ventureId}" not found`);
  let body = {}; try { body = await req.json(); } catch { /* optional */ }
  const row = await getSpaceRow(auth.ownerUserId, ventureId);
  if (!row) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const ontology = getOntology(row.model?.ontology || "venture");
  const model = normalizeModel(row.model, ontology.axes);
  const resolved = resolveContradiction(model, contradictionId, body.reason || "resolved via api", Date.now());
  if (!resolved) return err(404, "invalid_request", `contradiction "${contradictionId}" not found or already resolved`);
  // The winning side now DERIVES from the losing side — the supersede edge is
  // what lets lineage explain later why the old commitment stopped being true.
  const supersede_edge = recordSupersede(model, resolved, Date.now());
  const saved = await saveModel({ userId: auth.ownerUserId, ventureId, model, baseVersion: row.version ?? -1 });
  if (saved.status === "conflict") return err(409, "conflict", "concurrent write — retry");
  meterUsage({ userId: auth.ownerUserId, eventType: "contradiction_resolved", metadata: { space: ventureId, id: contradictionId } });
  return json(200, { ok: true, contradiction: resolved, supersede_edge, next_action: deriveNextAction(model, ontology), model_version: saved.version });
}

async function handleSpaceResource(auth, ventureId, resource, urlObj) {
  if (!spaceAllowed(auth, ventureId)) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const row = await getSpaceRow(auth.ownerUserId, ventureId);
  if (!row) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const ontology = getOntology(row.model?.ontology || "venture");
  // The stored model may be legacy venture-shaped; the API always speaks
  // the universal grammar — normalize on the way out.
  const model = normalizeModel(row.model, ontology.axes);

  if (resource === "model") {
    return json(200, { id: ventureId, ontology: ontology.id, model_version: row.version ?? 0, updated_at: row.updated_at, model });
  }
  if (resource === "export") {
    return json(200, {
      manifest: { format: "foaap.space-export", schema_version: 3, ontology: ontology.id, exported_at: new Date().toISOString(), via: "api" },
      model,
    });
  }
  if (resource === "synthesis") {
    return json(200, {
      current: row.synthesis || null,
      computed_at: row.synthesis_at || null,
      journal: Array.isArray(model.journal) ? model.journal.slice(-12) : [],
    });
  }
  if (resource === "graph") {
    return json(200, computeGraph(model, ontology));
  }
  if (resource === "context") {
    const q = urlObj.searchParams.get("q") || "";
    const budget = Math.min(Math.max(parseInt(urlObj.searchParams.get("budget_tokens") || "1500", 10) || 1500, 300), 6000);
    const payload = await buildContextPayload({ auth, ventureId, model, ontology, q, budget });
    meterUsage({ userId: auth.ownerUserId, eventType: "context_call", metadata: { space: ventureId, q: q.slice(0, 80), retrieved: payload.usage.retrieved } });
    return json(200, payload);
  }
  if (resource === "line") {
    // The raw line — their engine, their data, straight from the events table.
    const limit = Math.min(Math.max(parseInt(urlObj.searchParams.get("limit") || "100", 10) || 100, 1), 200);
    const undistilledOnly = urlObj.searchParams.get("undistilled") === "1";
    const q = `${SUPABASE_URL}/rest/v1/engine_events?user_id=eq.${encodeURIComponent(auth.ownerUserId)}&venture_id=eq.${encodeURIComponent(ventureId)}${undistilledOnly ? "&distilled_at=is.null" : ""}&select=id,kind,type,role,text,distilled_at,occurred_at,payload&order=created_at.desc&limit=${limit}`;
    const lr = await fetch(q, { headers: supaHeaders() });
    const data = lr.ok ? await lr.json().catch(() => []) : [];
    return json(200, { data, undistilled: await countUndistilled(auth.ownerUserId, ventureId) });
  }
  return err(404, "invalid_request", `unknown resource "${resource}"`);
}

// GET /spaces/:id/claims/:refId/lineage — the drill-down that makes
// compounding lossless. /context serves the compounded title; this walks one
// statement's ancestry: prior versions, refine/supersede edges, the
// contradictions that forged it, and the events that created each hop.
// Accepts claim ids AND decision ids (both are lineage citizens).
async function handleLineage(auth, ventureId, refId) {
  if (!spaceAllowed(auth, ventureId)) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const row = await getSpaceRow(auth.ownerUserId, ventureId);
  if (!row) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const ontology = getOntology(row.model?.ontology || "venture");
  const model = normalizeModel(row.model, ontology.axes);
  const lineage = claimLineage(model, refId);
  if (!lineage) return err(404, "invalid_request", `claim or decision "${refId}" not found in this space`);
  meterUsage({ userId: auth.ownerUserId, eventType: "lineage_call", metadata: { space: ventureId, ref: refId, depth: lineage.chain.length } });
  return json(200, lineage);
}

// GET /spaces/:id/bonds/:bondId — complete conserved relationship: both
// evidence directions, predictions, outcomes, validity, and derived view.
async function handleSemanticBond(auth, ventureId, bondId) {
  if (!spaceAllowed(auth, ventureId)) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const row = await getSpaceRow(auth.ownerUserId, ventureId);
  if (!row) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const ontology = getOntology(row.model?.ontology || "venture");
  const model = normalizeModel(row.model, ontology.axes);
  const bond = getSemanticBond(model, bondId);
  if (!bond) return err(404, "invalid_request", `semantic bond "${bondId}" not found in this space`);
  meterUsage({
    userId: auth.ownerUserId,
    eventType: "lineage_call",
    metadata: { space: ventureId, ref: bondId, type: "semantic_bond", signals: bond.view.strength.total_signals },
  });
  return json(200, bond);
}

// The /context payload, as a reusable function (also powers /compare).
async function buildContextPayload({ auth, ventureId, model, ontology, q, budget }) {
  const core = canonicalCore(model, ontology);
  const relevant = await retrieveRelevant({ userId: auth.ownerUserId, ventureId, q, k: 20 });
  const contras = (Array.isArray(model.contradictions) ? model.contradictions : [])
    .filter((c) => c && !c.resolved_at)
    .map((c) => ({ id: c.id, severity: c.severity || "medium", text: String(c.text || "").slice(0, 240) }));
  const journal = Array.isArray(model.journal) ? model.journal.slice(-3) : [];
  const graph = computeGraph(model, ontology);

  // Assemble the prompt block within the token budget (≈4 chars/token).
  // The core is never trimmed; relevant memories are, oldest-scored first.
  const charBudget = budget * 4;
  const parts = [];
  if (core.block) parts.push(`<canonical_core>\n${core.block}\n</canonical_core>`);
  if (contras.length) {
    parts.push(`<contradictions_active>\n${contras.map((c) => `  - [${c.severity}] ${c.text}`).join("\n")}\n</contradictions_active>`);
  }
  if (journal.length) {
    parts.push(`<synthesis_journal>\n${journal.map((j) => `  - ${j.state_line || j.move || ""}`).join("\n")}\n</synthesis_journal>`);
  }
  let used = parts.join("\n").length;
  const memLines = [];
  for (const m of relevant) {
    const line = `  - [${m.kind}${m.axis ? ` · ${m.axis}` : ""}] ${m.text.replace(/\s+/g, " ")}`;
    if (used + line.length > charBudget) break;
    memLines.push(line); used += line.length;
  }
  if (memLines.length) parts.splice(1, 0, `<relevant_memory>\n${memLines.join("\n")}\n</relevant_memory>`);
  const prompt_block = parts.join("\n");

  return {
    prompt_block,
    structured: {
      core: core.structured,
      relevant,
      contradictions_active: contras,
      ready_nodes: graph.ready.slice(0, 6),
      blocked: graph.blocked.slice(0, 6),
      next_action: deriveNextAction(model, ontology),
    },
    usage: { retrieved: relevant.length, included: memLines.length, budget_tokens: budget, block_tokens: Math.ceil(prompt_block.length / 4) },
  };
}

// POST /spaces/:id/compare — the "does it work?" proof: the same question
// answered WITHOUT and WITH the FOAAP context block, side by side. This is
// how a builder tests that FOAAP sitting before the model changes behavior.
const COMPARE_MODEL = "claude-sonnet-4-6";
async function askLLM(system, question) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: COMPARE_MODEL, max_tokens: 500, temperature: 0.4,
      system, messages: [{ role: "user", content: question }],
    }),
  });
  if (!r.ok) return `(llm error ${r.status})`;
  const out = await r.json().catch(() => null);
  return out?.content?.find((b) => b.type === "text")?.text || "(empty)";
}
async function handleCompare(auth, ventureId, req) {
  if (!spaceAllowed(auth, ventureId)) return err(404, "invalid_request", `space "${ventureId}" not found`);
  let body = {}; try { body = await req.json(); } catch { return err(400, "invalid_request", "JSON body required"); }
  const q = String(body.q || "").trim();
  if (!q) return err(400, "invalid_request", "q is required");
  const quota = await checkQuota(auth, "llm");
  if (quota) return quota;
  const row = await getSpaceRow(auth.ownerUserId, ventureId);
  if (!row) return err(404, "invalid_request", `space "${ventureId}" not found`);
  const ontology = getOntology(row.model?.ontology || "venture");
  const model = normalizeModel(row.model, ontology.axes);
  const ctx = await buildContextPayload({ auth, ventureId, model, ontology, q, budget: Math.min(Math.max(parseInt(body.budget_tokens || 1500, 10) || 1500, 300), 6000) });

  const BASE_SYSTEM = "You are an AI assistant helping with this project. Answer concisely (under 150 words).";
  const [without_foaap, with_foaap] = await Promise.all([
    askLLM(BASE_SYSTEM, q),
    askLLM(`${BASE_SYSTEM}\n\nCanonical project state — respect it, flag conflicts before acting:\n\n${ctx.prompt_block}`, q),
  ]);

  meterUsage({ userId: auth.ownerUserId, eventType: "compare_call", metadata: { space: ventureId, q: q.slice(0, 80) } });
  return json(200, {
    question: q,
    without_foaap,
    with_foaap,
    context: {
      block_tokens: ctx.usage.block_tokens,
      contradictions_active: ctx.structured.contradictions_active.length,
      next_action: ctx.structured.next_action,
    },
  });
}

// GET /logs — cloud path reads request_logs, scoped to the calling key's prefix.
async function handleLogs(auth, urlObj) {
  const limit = Math.min(Math.max(parseInt(urlObj.searchParams.get("limit") || "100", 10) || 100, 1), 200);
  const url = `${SUPABASE_URL}/rest/v1/request_logs?key_prefix=eq.${encodeURIComponent(auth.prefix || "")}&select=ts,method,path,status,ms,key_prefix&order=ts.desc&limit=${limit}`;
  const r = await fetch(url, { headers: supaHeaders() });
  if (!r.ok) return json(200, { data: [] });
  const rows = await r.json().catch(() => []);
  return json(200, { data: (rows || []).map((x) => ({ ts: x.ts, method: x.method, path: x.path, status: x.status, ms: x.ms, key: x.key_prefix })) });
}

// ---- router -------------------------------------------------------------------
export default async function handler(req, vercelCtx) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const onVercel = process.env.VERCEL === "1";
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/, "") || null;
  if (onVercel) {
    const rl = rateCheck(bearer, req.method);
    if (!rl.ok) {
      return new Response(JSON.stringify({ error: { type: "rate_limit", message: `Rate limit exceeded (${rl.limit}/min). Retry in ${rl.retryAfter}s.` } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter), ...CORS },
      });
    }
  }
  const t0 = Date.now();
  const response = await routeRequest(req);
  if (onVercel) {
    const u = new URL(req.url);
    const shownPath = u.searchParams.get("__path") ? `/api/v1/${u.searchParams.get("__path")}` : u.pathname;
    logRequestRow({
      keyPrefix: bearer ? bearer.slice(0, 16) : null,
      method: req.method,
      path: shownPath,
      status: response.status,
      ms: Date.now() - t0,
    });
  }
  drainBackground(vercelCtx);
  return response;
}

async function routeRequest(req) {
  if (!SUPABASE_URL || !SERVICE_KEY) return err(500, "server", "server env missing");
  const url = new URL(req.url);
  // Path after /api/v1/. On Vercel the rewrite delivers it as ?__path=…
  // (filesystem catch-alls proved unreliable without a framework preset);
  // locally server.js passes the raw pathname through.
  const rewritten = url.searchParams.get("__path");
  const parts = (rewritten !== null ? rewritten : url.pathname.replace(/^\/api\/v1\/?/, ""))
    .split("/").filter(Boolean);

  try {
    // Key management — JWT-gated (the console session), not API-key-gated.
    if (parts[0] === "keys" && req.method === "POST" && parts.length === 1) return await handleCreateKey(req);
    if (parts[0] === "keys" && req.method === "GET" && parts.length === 1) return await handleListKeys(req);
    if (parts[0] === "keys" && req.method === "DELETE" && parts.length === 2) return await handleRevokeKey(req, decodeURIComponent(parts[1]));

    // GET /api/v1/adapters — the published protocol artifacts (public, like
    // docs): the exact instructions any vendor model runs to speak FOAAP.
    if (parts[0] === "adapters" && req.method === "GET") {
      const ontologyId = url.searchParams.get("ontology") || "venture";
      if (!listOntologies().includes(ontologyId)) {
        return err(400, "invalid_request", `unknown ontology "${ontologyId}" — available: ${listOntologies().join(", ")}`);
      }
      return json(200, {
        protocol: "foaap.adapters",
        version: "2026-07-26",
        ontology: ontologyId,
        extraction: extractionAdapter(getOntology(ontologyId)),
        judge: JUDGE_ADAPTER,
        note: "Run these on YOUR model — any vendor. FOAAP needs no model key of its own: POST structure to /spaces/:id/events and verdicts to /spaces/:id/verdicts. X-Model-Key on a prose event runs the same adapters server-side with YOUR key (pass-through, never stored).",
      });
    }

    // Everything else requires an API key.
    const auth = await verifyApiKey(req);
    if (!auth) return err(401, "auth", "Provide a valid API key: Authorization: Bearer sk_foaap_live_…");

    if (parts[0] === "logs" && req.method === "GET") return await handleLogs(auth, url);

    if (parts[0] === "usage" && req.method === "GET") return await handleUsage(auth, url);
    if (parts[0] === "key" && req.method === "GET") return handleKeyIntrospect(auth);

    if (parts[0] === "spaces" && req.method === "GET") {
      if (parts.length === 1) return await handleSpaces(auth);
      if (parts.length === 2) return await handleSpaceResource(auth, decodeURIComponent(parts[1]), "model", url);
      if (parts.length === 3) return await handleSpaceResource(auth, decodeURIComponent(parts[1]), parts[2], url);
      if (parts.length === 4 && parts[2] === "bonds") {
        return await handleSemanticBond(auth, decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
      }
      if (parts.length === 5 && parts[2] === "claims" && parts[4] === "lineage") {
        return await handleLineage(auth, decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
      }
    }

    if (parts[0] === "spaces" && req.method === "POST") {
      if (!hasScope(auth, "write")) return err(403, "auth", "This key lacks the 'write' scope.");
      if (parts.length === 1) return await handleCreateSpace(auth, req);
      if (parts.length === 3 && parts[2] === "events") {
        return await handleIngestEvent(auth, decodeURIComponent(parts[1]), req);
      }
      if (parts.length === 3 && parts[2] === "verdicts") {
        return await handleVerdicts(auth, decodeURIComponent(parts[1]), req);
      }
      if (parts.length === 3 && parts[2] === "distill") {
        return await handleDistillRoute(auth, decodeURIComponent(parts[1]), req);
      }
      if (parts.length === 3 && parts[2] === "compare") {
        return await handleCompare(auth, decodeURIComponent(parts[1]), req);
      }
      if (parts.length === 5 && parts[2] === "contradictions" && parts[4] === "resolve") {
        return await handleResolve(auth, decodeURIComponent(parts[1]), decodeURIComponent(parts[3]), req);
      }
    }
    return err(404, "invalid_request", `no route for ${req.method} /api/v1/${parts.join("/")}`);
  } catch (e) {
    return err(500, "server", String((e && e.message) || e).slice(0, 200));
  }
}
