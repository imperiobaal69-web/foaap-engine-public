// =============================================================================
//  Substrate writes — Voyage embed + venture_substrate upsert, mirroring
//  foaap-new/api/substrate/insert.js (same table, same idempotency contract:
//  unique on user_id,venture_id,event_type,source_id).
//
//  Batch-first: one Voyage call embeds up to 128 rows, one PostgREST call
//  inserts them — a 100-message substance batch costs 2 round-trips, not 200.
//  Falls back to the per-row path (with one retry each) if the bulk path
//  hiccups, because a dropped row is a SILENT recall gap.
// =============================================================================

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const VOYAGE_KEY = process.env.VOYAGE_API_KEY || "";

async function fetchT(url, opts, ms = 30_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}


function supaHeaders(extra = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...extra };
}

async function embedMany(texts) {
  const r = await fetchT("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "voyage-3", input: texts.map((t) => String(t).slice(0, 4000)), input_type: "document" }),
  });
  if (!r.ok) throw new Error(`voyage ${r.status}`);
  const o = await r.json();
  const vecs = (o?.data || []).map((d) => d.embedding);
  if (vecs.length !== texts.length || vecs.some((v) => !Array.isArray(v))) throw new Error("voyage bad shape");
  return vecs;
}

function toRecord(userId, spaceId, row, embedding) {
  return {
    user_id: userId,
    venture_id: spaceId,
    event_type: row.event_type,
    source_id: row.source_id || null,
    pillar: row.axis || null,
    subnode_id: row.node_id || null,
    text: String(row.text).slice(0, 32768),
    metadata: row.metadata || {},
    embedding,
  };
}

async function insertBulk(records) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/venture_substrate?on_conflict=user_id,venture_id,event_type,source_id`, {
    method: "POST",
    headers: supaHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(records),
  });
  if (!r.ok) throw new Error(`substrate bulk ${r.status}`);
}

async function pushRow(userId, spaceId, row) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 400));
      const [embedding] = await embedMany([row.text]);
      const conflict = row.source_id ? "user_id,venture_id,event_type,source_id" : null;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/venture_substrate${conflict ? `?on_conflict=${conflict}` : ""}`, {
        method: "POST",
        headers: supaHeaders({ Prefer: conflict ? "resolution=merge-duplicates" : "return=minimal" }),
        body: JSON.stringify(toRecord(userId, spaceId, row, embedding)),
      });
      if (!r.ok) throw new Error(`substrate ${r.status}`);
      return null;
    } catch (e) {
      if (attempt === 1) return { event_type: row.event_type, source_id: row.source_id || null, error: String((e && e.message) || e).slice(0, 120) };
    }
  }
  return null;
}

// rows: [{event_type, source_id, axis, node_id, text, metadata}]
// Universal grammar in, legacy column names out: `axis` is stored in the
// `pillar` column and `node_id` in `subnode_id` (table shape unchanged —
// the schema's venture-era CHECK constraints are dropped instead).
export async function pushSubstrate({ userId, spaceId, rows }) {
  if (!VOYAGE_KEY || !rows.length) return { ok: false, inserted: 0, failed: [] };
  const failed = [];
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 96) {
    const chunk = rows.slice(i, i + 96);
    try {
      const vecs = await embedMany(chunk.map((r) => r.text));
      await insertBulk(chunk.map((r, j) => toRecord(userId, spaceId, r, vecs[j])));
      inserted += chunk.length;
    } catch {
      // Bulk hiccup — recover row by row so one bad row can't sink the batch.
      for (const row of chunk) {
        const fail = await pushRow(userId, spaceId, row);
        if (fail) failed.push(fail); else inserted += 1;
      }
    }
  }
  return { ok: true, inserted, failed };
}
