// =============================================================================
//  FOAAP Engine API — local server. Wraps the edge-style handler (api/v1.js:
//  Request in, Response out) in node:http so Phases A+B run standalone on
//  localhost. Env via `node --env-file=.env`.
//
//  Node-side responsibilities (kept OUT of api/v1.js so it stays edge-portable):
//    - request logging → requests.log (JSONL, one line per API call)
//    - GET /api/v1/logs (API-key gated) → last N log lines
//    - GET / → source-reference README
// =============================================================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler, { verifyApiKey } from "./api/v1.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const LOG_FILE = path.join(__dirname, "requests.log");

function logRequest({ method, url, status, ms, keyPrefix }) {
  const line = JSON.stringify({ ts: new Date().toISOString(), method, path: url, status, ms, key: keyPrefix || null });
  fs.appendFile(LOG_FILE, line + "\n", () => {});
}

function readLogTail(limit = 100) {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n");
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

// ---- rate limiting — fixed 60s window per bearer token ----------------------
// Reads 120/min, writes 20/min, unauthenticated 30/min. In-memory is correct
// for the single-process local server; swap for a table/Redis on deploy.
const RATE = { GET: 120, POST: 20, DELETE: 20, ANON: 30, WINDOW_MS: 60_000 };
const buckets = new Map();
function rateCheck(token, method) {
  const now = Date.now();
  const k = token || "anon";
  let b = buckets.get(k);
  if (!b || now - b.start > RATE.WINDOW_MS) { b = { start: now, counts: {} }; buckets.set(k, b); }
  const cls = !token ? "ANON" : (method === "GET" || method === "HEAD" ? "GET" : "POST");
  b.counts[cls] = (b.counts[cls] || 0) + 1;
  const limit = RATE[cls];
  const remaining = Math.max(0, limit - b.counts[cls]);
  const retryAfter = Math.ceil((b.start + RATE.WINDOW_MS - now) / 1000);
  return { ok: b.counts[cls] <= limit, limit, remaining, retryAfter };
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/, "") || null;
  const keyPrefix = bearer ? bearer.slice(0, 16) : null;
  try {
    // The public reference ships the API and documentation, without the private console.
    if (req.method === "GET" && ["/", "/docs"].includes(req.url.split("?")[0])) {
      const readme = fs.readFileSync(path.join(__dirname, "README.md"));
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(readme);
    }

    // Rate limit every /api/* call (except CORS preflight).
    if (req.url.startsWith("/api/") && req.method !== "OPTIONS") {
      const rl = rateCheck(bearer, req.method);
      if (!rl.ok) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(rl.retryAfter),
          "x-ratelimit-limit": String(rl.limit),
          "x-ratelimit-remaining": "0",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ error: { type: "rate_limit", message: `Rate limit exceeded (${rl.limit}/min). Retry in ${rl.retryAfter}s.` } }));
        logRequest({ method: req.method, url: req.url, status: 429, ms: Date.now() - t0, keyPrefix });
        return;
      }
      res.setHeader("x-ratelimit-limit", String(rl.limit));
      res.setHeader("x-ratelimit-remaining", String(rl.remaining));
    }

    // GET /api/v1/logs — key-gated request log tail.
    if (req.method === "GET" && req.url.startsWith("/api/v1/logs")) {
      const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: "GET", headers: req.headers });
      const auth = await verifyApiKey(request);
      const status = auth ? 200 : 401;
      const body = auth
        ? { data: readLogTail(Number(new URL(request.url).searchParams.get("limit")) || 100) }
        : { error: { type: "auth", message: "Provide a valid API key." } };
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      logRequest({ method: req.method, url: req.url, status, ms: Date.now() - t0, keyPrefix });
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = !["GET", "HEAD"].includes(req.method) && chunks.length > 0;
    const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
    if (req.url.startsWith("/api/")) {
      logRequest({ method: req.method, url: req.url, status: response.status, ms: Date.now() - t0, keyPrefix });
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "server", message: String((e && e.message) || e).slice(0, 200) } }));
    logRequest({ method: req.method, url: req.url, status: 500, ms: Date.now() - t0, keyPrefix });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`FOAAP Engine API listening on http://localhost:${PORT}/api/v1`);
});
