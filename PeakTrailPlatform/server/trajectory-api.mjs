import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, problem, validHash } from "./trajectory-contract.mjs";

export function createTrajectoryApi({ root = null, catalogPath = null, trustedProxy = false,
  workerFactory = (url, options) => new Worker(url, options), workerTimeoutMs = 45_000 } = {}) {
  root = root ? resolve(root) : null;
  // The published catalog and its immutable packs are staged together in this
  // release. Source metadata alone does not include the model/landmark evidence.
  catalogPath = catalogPath ?? fileURLToPath(new URL("../site-dist/data/maps/catalog.json", import.meta.url));
  let active = 0, uploading = false, closed = false, migratedPending = false, tail = Promise.resolve(); const workers = new Set(), rate = new Map();
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type,content-encoding,x-trajectory-format" };
  function json(res, code, value) { if (!res.destroyed && !res.writableEnded) { res.writeHead(code, headers); res.end(typeof value === "string" ? value : JSON.stringify(value)); } }
  function runJob(data) {
    if (closed) return Promise.reject(problem("trajectory service stopped", 503));
    return new Promise((done, reject) => {
      const worker = workerFactory(new URL("./trajectory-worker.mjs", import.meta.url), { workerData: { ...data, root, catalogPath, migratePending: !migratedPending }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
      workers.add(worker);
      let result, failure;
      // Neither terminate() nor the error event guarantees that the thread's heap
      // has been released. Keep the queue occupied until its actual exit event.
      const timeout = setTimeout(() => { failure = problem("trajectory worker timed out", 503); worker.terminate(); }, workerTimeoutMs);
      worker.once("message", (message) => { result = message; });
      worker.once("error", (error) => { clearTimeout(timeout); failure ??= problem(`trajectory worker failed: ${error.message}`, 503); });
      worker.once("exit", (code) => { clearTimeout(timeout); workers.delete(worker);
        if (result?.migrationComplete === true && code === 0 && !failure) migratedPending = true;
        if (failure) reject(failure);
        else if (code !== 0 || !result) reject(problem("trajectory worker stopped", 503));
        else if (result.error) reject(problem(result.error, result.statusCode)); else done(result); });
    });
  }
  function job(data) { const next = tail.then(() => runJob(data)); tail = next.catch(() => {}); return next; }
  function limited(req) {
    const address = trustedProxy ? String(req.headers["x-real-ip"] ?? req.socket.remoteAddress) : req.socket.remoteAddress;
    const key = `${req.method}:${address}`;
    const now = Date.now(), entry = rate.get(key);
    if (!entry || now - entry.since >= 60_000) rate.set(key, { since: now, count: 1 });
    else if (++entry.count > (req.method === "POST" ? 20 : 120)) return true;
    if (rate.size > 10_000) for (const [ip, value] of rate) if (now - value.since > 60_000) rate.delete(ip);
    if (rate.size > 10_000) return true;
    return false;
  }
  async function body(req) {
    const length = Number(req.headers["content-length"]);
    if (Number.isFinite(length) && length > LIMITS.compressedBytes) throw problem("compressed body exceeds 12 MiB", 413);
    const chunks = []; let bytes = 0;
    req.setTimeout(20_000, () => req.destroy(problem("upload request timed out", 408)));
    for await (const chunk of req) { bytes += chunk.length; if (bytes > LIMITS.compressedBytes) throw problem("compressed body exceeds 12 MiB", 413); chunks.push(chunk); }
    req.setTimeout(0); return Buffer.concat(chunks, bytes);
  }
  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost"), path = url.pathname;
    if (path !== "/api/route-uploads" && path !== "/api/route-groups" && !path.startsWith("/api/route-groups/")) return false;
    if (req.method === "OPTIONS") { res.writeHead(204, headers).end(); return true; }
    if (!root) { json(res, 503, { error: "route-storage-unconfigured" }); return true; }
    if (limited(req) || active >= 4 || (req.method === "POST" && uploading)) { json(res, 429, { error: "route-service-busy", retryAfterSeconds: 5 }); return true; }
    active += 1;
    if (req.method === "POST") uploading = true;
    try {
      if (path === "/api/route-uploads" && req.method === "POST") {
        if (String(req.headers["content-type"] ?? "").split(";")[0].toLowerCase() !== "application/json" || req.headers["content-encoding"] !== "gzip") throw problem("gzip application/json required", 415);
        if (req.headers["x-trajectory-format"] && req.headers["x-trajectory-format"] !== "trajectory-v1") throw problem("unsupported trajectory format", 415);
        const result = await job({ operation: "upload", body: await body(req) }); json(res, result.duplicate ? 200 : 201, result.json);
      } else if (path === "/api/route-groups" && req.method === "GET") json(res, 200, (await job({ operation: "groups" })).json);
      else {
        const inspection = path.match(/^\/api\/route-groups\/([a-f0-9]{64})\/uploads\/([a-f0-9]{64})\/stages\/(\d+)\/inspection$/);
        const match = path.match(/^\/api\/route-groups\/([a-f0-9]{64})\/stages\/(\d+)\/(routes|heatmap)$/);
        if (req.method !== "GET") throw problem("method not allowed", 405);
        if (inspection) {
          json(res, 200, (await job({ operation: "inspection", group: inspection[1], upload: inspection[2], stage: Number(inspection[3]) })).json);
          return true;
        }
        if (!match || !validHash(match[1])) throw problem("unknown route endpoint", 404);
        const limit = Number(url.searchParams.get("limit") ?? 200);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw problem("limit must be 1..200");
        const difficulty = url.searchParams.get("difficulty") ?? "";
        if (difficulty.length > 100) throw problem("invalid difficulty filter");
        json(res, 200, (await job({ operation: match[3] === "heatmap" ? "heatmap" : "routes", group: match[1], stage: Number(match[2]), difficulty, limit })).json);
      }
    } catch (error) { json(res, error.statusCode ?? 500, { error: error.message }); }
    finally { active -= 1; if (req.method === "POST") uploading = false; }
    return true;
  }
  return { handle, close: () => { closed = true; for (const worker of workers) worker.terminate(); } };
}
