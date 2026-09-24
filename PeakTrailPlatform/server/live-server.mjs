// PeakTrail live relay v1 — zero-dependency Node server for real-time run sharing.
//
// Contract (v1, intentionally minimal):
//   - The recorder derives a 4-character code from the room-shared RunId
//     (server/run-code.mjs). Every modded client in the same run derives the SAME
//     code; the server "confirms" it by re-deriving, and merges all uploads for
//     one runId into one run (multi-producer deduplication).
//   - No authentication beyond the code. This is the agreed v1 trade-off: deploy
//     behind a reverse proxy with access control until a token lands.
//
// Endpoints:
//   GET  /api/health                   safe deployment liveness probe
//   POST /api/runs                     {code, runId, manifest?} -> confirm/register
//   POST /api/runs/:code/records?producer=ID   body: NDJSON records -> dedupe + fan out
//   GET  /api/runs                     active runs
//   GET  /api/runs/:code               manifest + meta
//   GET  /api/runs/:code/snapshot      latest per-player state for late joiners
//   GET  /api/runs/:code/stream?after=SEQ     SSE: hello(snapshot) + record events
//   GET  /                             status page, /watch/:code raw live tail
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { deriveRunCode, isValidRunCode, normalizeRunId, runCodeMatches } from "./run-code.mjs";
import { resolveDaily } from "./peak-daily.mjs";

const MAX_RUNS = 200;
const MAX_RECORDS_PER_RUN = 20_000;      // ~10 minutes of a 6-player session in memory
const MAX_DEDUPE_KEYS_PER_RUN = 300_000;
const MAX_BATCH_LINES = 500;
const MAX_BODY_BYTES = 1_000_000;
const MAX_VIEWERS_PER_RUN = 50;
// The recorder flushes every 100 ms while live-streaming at 20 Hz (~600
// batches/min per producer); the limit must sit comfortably above that while
// still capping a runaway producer.
const MAX_BATCHES_PER_MINUTE = 1_200;
const PRODUCER_ACTIVE_MS = 60_000;
const GRACE_MS = 30_000;                 // keep a run listed briefly after the last upload
const BACKFILL_LIMIT = 5_000;

const TRIMMED_TYPES = new Set(["sample", "state", "inventory", "appearance", "status"]);

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function createLiveServer(options = {}) {
  const persistenceDir = options.persistenceDir ? resolve(options.persistenceDir) : null;
  if (persistenceDir) mkdirSync(persistenceDir, { recursive: true });
  const dailyResolver = options.dailyResolver ?? resolveDaily;
  const dailyNow = options.dailyNow ?? Date.now;
  const pingIntervalMs = Math.max(100, Number(options.pingIntervalMs) || 15_000);
  // The relay owns the daily rotation now (no GitHub Action dependency): it
  // proxies PEAK's login API with a short cache so every viewer sees fresh data.
  const DAILY_CACHE_MS = 10 * 60_000;
  let dailyCache = { at: 0, data: null, error: null };
  let dailyRefresh = null;

  function dailyPayload() {
    const expiresAt = Date.parse(dailyCache.data?.nextChangeAtUtc);
    if (dailyCache.data && dailyNow() - dailyCache.at < DAILY_CACHE_MS
      && Number.isFinite(expiresAt) && dailyNow() < expiresAt) return Promise.resolve(dailyCache.data);
    // Coalesce concurrent cold requests: every viewer booting during a refresh
    // awaits the same in-flight fetch instead of each hitting PEAK's login API
    // (a cold cache otherwise stalls every first page open for the full upstream
    // round-trip).
    if (!dailyRefresh) {
      dailyRefresh = (async () => {
        const data = await dailyResolver();
        // Even if upstream briefly returns the previous rotation at the boundary,
        // its expired deadline prevents this response becoming a fresh 10m cache.
        dailyCache = { at: dailyNow(), data, error: null };
        return data;
      })().finally(() => { dailyRefresh = null; });
    }
    return dailyRefresh;
  }

  // CLI-only: keep the cache warm in the background so the first viewer after
  // a relay start never pays the upstream round-trip on the critical boot path.
  // Tests build the server directly and must stay offline, so this is never
  // started by createLiveServer itself.
  function startDailyPrewarm() {
    const warm = () => { dailyPayload().catch(() => {}); };
    warm();
    const timer = setInterval(warm, Math.floor(DAILY_CACHE_MS / 2));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  const runs = new Map();       // code -> run
  const codeByRunId = new Map();

  function runAlive(run) {
    return Date.now() - run.lastSeenAt <= GRACE_MS;
  }

  function sweepRuns() {
    const now = Date.now();
    for (const [code, run] of runs) {
      if (now - run.lastSeenAt > GRACE_MS && run.viewers.size === 0) {
        run.viewers.forEach((viewer) => viewer.res.end());
        runs.delete(code);
        codeByRunId.delete(run.runId);
      }
    }
  }
  const sweeper = setInterval(sweepRuns, 10_000);
  sweeper.unref?.();

  function registerRun(body) {
    const runId = normalizeRunId(body?.runId);
    const code = String(body?.code ?? "");
    if (!runId) return { status: 400, json: { error: "runId-required" } };
    if (!isValidRunCode(code)) return { status: 400, json: { error: "code-format" } };
    if (!runCodeMatches(runId, code)) return { status: 400, json: { error: "code-does-not-match-runId" } };

    const existingCode = codeByRunId.get(runId);
    if (existingCode) {
      const run = runs.get(existingCode);
      run.lastSeenAt = Date.now();
      if (body?.manifest && typeof body.manifest === "object") run.manifest = body.manifest;
      return { status: 200, json: { code: run.code, runId: run.runId, confirmed: true, mergedIntoExisting: true } };
    }
    if (runs.has(code)) {
      // A different runId hashed to the same code. The recorder walks its
      // deterministic attempt sequence, so every client of that run converges
      // on the same next code — no coordination needed.
      return { status: 409, json: { error: "code-collision", retryWithNextAttempt: true } };
    }
    if (runs.size >= MAX_RUNS) return { status: 503, json: { error: "too-many-runs" } };

    const run = {
      code, runId,
      manifest: typeof body?.manifest === "object" && body.manifest ? body.manifest : null,
      createdAt: Date.now(), lastSeenAt: Date.now(),
      nextSeq: 1, records: [], dedupe: new Map(),
      streamOpens: 0,
      roomTsBase: null,       // first-seen shared room clock; every served t is roomTs - base
      droppedForCapacity: 0, rejectedLines: 0, duplicateLines: 0, acceptedLines: 0,
      producers: new Map(),   // producerKey -> lastSeenAt
      viewers: new Set(),
      batchTimestamps: [],
      persistencePath: null,
    };
    if (persistenceDir) {
      run.persistencePath = join(persistenceDir, `${code}-${runId.slice(0, 8)}.ndjson`);
    }
    runs.set(code, run);
    codeByRunId.set(runId, code);
    return { status: 201, json: { code, runId, confirmed: true, mergedIntoExisting: false } };
  }

  function touchProducer(run, producer) {
    if (!producer) return;
    run.producers.set(producer, Date.now());
  }

  function activeProducers(run) {
    const now = Date.now();
    let count = 0;
    for (const seenAt of run.producers.values()) if (now - seenAt <= PRODUCER_ACTIVE_MS) count += 1;
    return count;
  }

  function rateLimited(run) {
    const now = Date.now();
    run.batchTimestamps = run.batchTimestamps.filter((time) => now - time < 60_000);
    if (run.batchTimestamps.length >= MAX_BATCHES_PER_MINUTE) return true;
    run.batchTimestamps.push(now);
    return false;
  }

  function publishToViewers(run, entry) {
    for (const viewer of run.viewers) {
      if (entry.seq <= viewer.cursor) continue;
      try {
        viewer.res.write(`id: ${entry.seq}\nevent: record\ndata: ${JSON.stringify({ seq: entry.seq, serverTs: entry.serverTs, record: servedRecord(run, entry.record) })}\n\n`);
        viewer.cursor = entry.seq;
      } catch {
        run.viewers.delete(viewer);
      }
    }
  }

  function ingestRecords(run, producer, text) {
    const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return { status: 400, json: { error: "empty-body" } };
    if (lines.length > MAX_BATCH_LINES) return { status: 413, json: { error: "too-many-lines", max: MAX_BATCH_LINES } };
    touchProducer(run, producer);
    run.lastSeenAt = Date.now();

    let accepted = 0, duplicates = 0, rejected = 0;
    let truncated = false;
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        rejected += 1;
        continue;
      }
      if (!record || typeof record !== "object" || typeof record.type !== "string"
          || !Number.isFinite(record.t)) {
        rejected += 1;
        continue;
      }
      // Multi-producer deduplication. The shared room clock (roomTs, added by the
      // recorder) makes the same game event carry the same key from every
      // producer; without it the key falls back to per-producer scope, which is
      // always unique and simply never deduplicates (graceful degradation).
      const roomTs = Number.isFinite(record.roomTs) ? record.roomTs : null;
      const key = `${record.type}|${record.playerId ?? ""}|${roomTs !== null ? roomTs : `${producer ?? ""}:${record.t}`}`;
      if (run.dedupe.has(key)) {
        duplicates += 1;
        continue;
      }
      if (run.dedupe.size >= MAX_DEDUPE_KEYS_PER_RUN) {
        // FIFO eviction: Map preserves insertion order.
        const excess = Math.floor(MAX_DEDUPE_KEYS_PER_RUN / 3);
        let removed = 0;
        for (const oldest of run.dedupe.keys()) {
          run.dedupe.delete(oldest);
          if (++removed >= excess) break;
        }
      }
      run.dedupe.set(key, true);

      // The room clock is shared by the whole room but starts wherever the
      // master server's uptime happens to be (often a large negative int).
      // Anchoring the run at the first-seen value keeps every served record on
      // one small positive timeline; serving from stored raw records means a
      // later, smaller anchor still fixes everything already buffered.
      if (roomTs !== null && (run.roomTsBase === null || roomTs < run.roomTsBase)) {
        run.roomTsBase = roomTs;
      }
      const entry = { seq: run.nextSeq++, serverTs: Date.now(), record };
      run.records.push(entry);
      if (run.records.length > MAX_RECORDS_PER_RUN) {
        run.records.splice(0, run.records.length - MAX_RECORDS_PER_RUN);
        run.droppedForCapacity += 1;
        truncated = true;
      }
      run.acceptedLines += 1;
      accepted += 1;
      if (run.persistencePath) {
        try {
          appendFileSync(run.persistencePath, `${JSON.stringify(entry)}\n`);
        } catch { /* persistence is best-effort in v1 */ }
      }
      publishToViewers(run, entry);
    }
    run.rejectedLines += rejected;
    run.duplicateLines += duplicates;
    return {
      status: 200,
      json: { accepted, duplicates, rejected, truncatedSinceConnect: truncated,
        seq: run.nextSeq - 1, producers: activeProducers(run) },
    };
  }

  /** Served view of a stored record: `t` moves onto the run's shared, rebased
   * room timeline (the raw producer-local clock is kept as `localT`). */
  function servedRecord(run, record) {
    const roomTs = Number.isFinite(record?.roomTs) ? record.roomTs : null;
    if (roomTs === null || run.roomTsBase === null) return record;
    return { ...record, t: roomTs - run.roomTsBase, localT: record.t };
  }

  function snapshot(run) {
    const players = new Map();
    let route = null, activeSegment = null;
    for (const stored of run.records) {
      const record = servedRecord(run, stored.record);
      const type = record.type;
      if (TRIMMED_TYPES.has(type) && record.playerId) {
        const player = players.get(record.playerId) ?? {};
        player[type] = record;
        players.set(record.playerId, player);
      } else if (type === "route") {
        route = record;
      } else if (type === "event" && record.event === "segment_change") {
        activeSegment = record;
      }
    }
    return { players: Object.fromEntries(players), route, activeSegment };
  }

  function runSummary(run) {
    return {
      code: run.code, runId: run.runId,
      sceneName: run.manifest?.sceneName ?? null,
      mapSlot: run.manifest?.mapSlot ?? null,
      gameBuildId: run.manifest?.gameBuildId ?? null,
      recorderVersion: run.manifest?.recorderVersion ?? null,
      participants: Array.isArray(run.manifest?.participants) ? run.manifest.participants.length : null,
      records: run.records.length, acceptedLines: run.acceptedLines,
      duplicateLines: run.duplicateLines, rejectedLines: run.rejectedLines,
      droppedForCapacity: run.droppedForCapacity, streamOpens: run.streamOpens,
      producers: activeProducers(run), viewers: run.viewers.size,
      createdAt: new Date(run.createdAt).toISOString(),
      lastSeenAt: new Date(run.lastSeenAt).toISOString(),
      alive: runAlive(run),
    };
  }

  function startSse(res, run, after, lastEventId = null) {
    if (run.viewers.size >= MAX_VIEWERS_PER_RUN) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "too-many-viewers" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write("retry: 2000\n");
    // A reconnecting EventSource replays its Last-Event-ID: resume from that seq
    // instead of rebuilding everything (a full replay stalls the page).
    const resumeSeq = Number.isFinite(lastEventId) && lastEventId >= 0 ? lastEventId : after;
    const isResume = resumeSeq > 0 && resumeSeq <= run.nextSeq - 1;
    run.streamOpens += 1;
    if (!isResume) {
      // Late joiners get the current state first, then only deltas.
      const snapshotPayload = { code: run.code, runId: run.runId, manifest: run.manifest,
        lastSeq: run.nextSeq - 1, snapshot: snapshot(run),
        droppedForCapacity: run.droppedForCapacity };
      res.write(`event: hello\ndata: ${JSON.stringify(snapshotPayload)}\n\n`);
    } else {
      res.write(`event: resumed\ndata: ${JSON.stringify({ lastSeq: run.nextSeq - 1 })}\n\n`);
    }
    const fromSeq = resumeSeq;
    let replayed = 0, partial = false;
    for (const entry of run.records) {
      if (entry.seq <= fromSeq) continue;
      if (++replayed > BACKFILL_LIMIT) { partial = true; break; }
      res.write(`id: ${entry.seq}\nevent: record\ndata: ${JSON.stringify({ seq: entry.seq, serverTs: entry.serverTs, record: servedRecord(run, entry.record) })}\n\n`);
    }
    const viewer = { res, cursor: Math.max(fromSeq + replayed, run.nextSeq - 1) };
    if (partial) {
      res.write(`event: notice\ndata: ${JSON.stringify({ partialBackfill: true, backfillLimit: BACKFILL_LIMIT })}\n\n`);
    }
    run.viewers.add(viewer);
    const heartbeat = setInterval(() => {
      try {
        // The comment line keeps intermediaries fed; the named ping event is
        // what the viewer's stall watchdog can actually observe — an SSE
        // comment fires no DOM event, so a silently-dead socket would
        // otherwise look "OPEN but quiet" forever and freeze the page.
        res.write(": keepalive\n\nevent: ping\ndata: {}\n\n");
      } catch { /* cleaned up on close */ }
    }, pingIntervalMs);
    heartbeat.unref?.();
    res.on("close", () => {
      clearInterval(heartbeat);
      run.viewers.delete(viewer);
    });
  }

  function readBody(req, limit = MAX_BODY_BYTES) {
    return new Promise((resolveBody, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(Object.assign(new Error("body-too-large"), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const json = (status, payload, headers = {}) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        ...headers,
      });
      if (method !== "HEAD") res.end(JSON.stringify(payload));
      else res.end();
    };

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    if (method === "GET" && path === "/api/health") {
      return json(200, { ok: true, service: "peak-trail-live" });
    }

    if (method === "POST" && path === "/api/runs") {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: "invalid-json" }); }
      const result = registerRun(body);
      return json(result.status, result.json);
    }

    const recordsMatch = path.match(/^\/api\/runs\/([a-z0-9]{4})\/records$/);
    if (method === "POST" && recordsMatch) {
      const run = runs.get(recordsMatch[1]);
      if (!run) return json(404, { error: "unknown-run" });
      if (rateLimited(run)) return json(429, { error: "rate-limited" });
      let body;
      try { body = await readBody(req); } catch (error) {
        return json(error.statusCode ?? 400, { error: error.message });
      }
      const result = ingestRecords(run, url.searchParams.get("producer"), body);
      return json(result.status, result.json);
    }

    if (method === "GET" && path === "/api/runs") {
      const list = [...runs.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(runSummary);
      return json(200, { runs: list, now: new Date().toISOString() });
    }

    const runMatch = path.match(/^\/api\/runs\/([a-z0-9]{4})$/);
    if (method === "GET" && runMatch) {
      const run = runs.get(runMatch[1]);
      if (!run) return json(404, { error: "unknown-run" });
      return json(200, { ...runSummary(run), manifest: run.manifest, persistencePath: run.persistencePath ? true : false });
    }

    const snapshotMatch = path.match(/^\/api\/runs\/([a-z0-9]{4})\/snapshot$/);
    if (method === "GET" && snapshotMatch) {
      const run = runs.get(snapshotMatch[1]);
      if (!run) return json(404, { error: "unknown-run" });
      return json(200, { code: run.code, lastSeq: run.nextSeq - 1, ...snapshot(run) });
    }

    const streamMatch = path.match(/^\/api\/runs\/([a-z0-9]{4})\/stream$/);
    if (method === "GET" && streamMatch) {
      const run = runs.get(streamMatch[1]);
      if (!run) return json(404, { error: "unknown-run" });
      const after = Number(url.searchParams.get("after"));
      const lastEventId = Number(req.headers["last-event-id"]);
      startSse(res, run, Number.isFinite(after) ? after : 0,
        Number.isFinite(lastEventId) ? lastEventId : null);
      return;
    }

    if (method === "GET" && path === "/api/daily") {
      try {
        return json(200, await dailyPayload());
      } catch (error) {
        return json(502, { error: "daily-unavailable", message: error.message });
      }
    }

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(statusPage());
      return;
    }
    const watchMatch = path.match(/^\/watch\/([a-z0-9]{4})$/);
    if (method === "GET" && watchMatch) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(watchPage(watchMatch[1]));
      return;
    }

    json(404, { error: "not-found" });
  }

  function statusPage() {
    const list = [...runs.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const rows = list.map((run) => {
      const summary = runSummary(run);
      return `<tr><td><a href="/watch/${summary.code}">${summary.code}</a></td>`
        + `<td>${htmlEscape(summary.sceneName ?? "?")}</td>`
        + `<td>${summary.producers}</td><td>${summary.viewers}</td>`
        + `<td>${summary.records}</td><td>${summary.duplicateLines}</td>`
        + `<td>${summary.alive ? "live" : "grace"}</td></tr>`;
    }).join("");
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PeakTrail live</title>
<style>body{font:14px/1.6 system-ui;background:#0b1918;color:#dff;padding:24px}
table{border-collapse:collapse}td,th{padding:4px 12px;border-bottom:1px solid #234}
a{color:#7dd}small{color:#8aa}</style>
<h1>PeakTrail live runs</h1>
<table><tr><th>code</th><th>scene</th><th>producers</th><th>viewers</th><th>records</th><th>deduped</th><th>state</th></tr>
${rows || '<tr><td colspan="7">暂无活跃 run</td></tr>'}</table>
<p><small>v1：run 码由录像端从 RunId 派生并经服务器确认；同一局多个 mod 客户端自动合并。刷新每 5 秒。</small></p>
<script>setTimeout(() => location.reload(), 5000);</script></html>`;
  }

  function watchPage(code) {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>run ${htmlEscape(code)}</title>
<style>body{font:13px/1.6 Consolas,monospace;background:#0b1918;color:#dff;padding:16px}
table{border-collapse:collapse;margin:8px 0}td,th{padding:2px 10px;border-bottom:1px solid #234;text-align:left}
#log{white-space:pre-wrap;color:#9bd;font-size:11px;max-height:40vh;overflow:auto}</style>
<h1>run <span id="code">${htmlEscape(code)}</span> <span id="state"></span></h1>
<div id="meta"></div>
<table id="players"><tr><th>player</th><th>pos</th><th>yaw</th><th>stamina</th><th>更新</th></tr></table>
<div id="log"></div>
<script>
const es = new EventSource('/api/runs/${htmlEscape(code)}/stream');
es.addEventListener('hello', (event) => {
  const hello = JSON.parse(event.data);
  document.getElementById('state').textContent = 'connected';
  document.getElementById('meta').textContent = JSON.stringify({runId: hello.runId, sceneName: hello.manifest?.sceneName, lastSeq: hello.lastSeq});
  for (const [playerId, player] of Object.entries(hello.snapshot.players)) upsert(playerId, player);
});
es.addEventListener('record', (event) => {
  const entry = JSON.parse(event.data);
  const record = entry.record;
  if (['sample','state','inventory','appearance','status'].includes(record.type) && record.playerId) {
    upsert(record.playerId, { [record.type]: record });
  }
  const log = document.getElementById('log');
  log.textContent = '[' + entry.seq + '] ' + record.type + ' ' + (record.playerId ?? '') + ' t=' + record.t + '\\n' + log.textContent;
  if (log.childNodes.length > 400) log.textContent = log.textContent.slice(0, log.textContent.indexOf('\\n', 20000));
});
es.onerror = () => { document.getElementById('state').textContent = 'reconnecting…'; };
const rows = new Map();
function upsert(playerId, player) {
  let row = rows.get(playerId);
  if (!row) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td>';
    document.getElementById('players').append(tr);
    row = { tr, cells: tr.querySelectorAll('td'), latest: {} };
    rows.set(playerId, row);
  }
  Object.assign(row.latest, player);
  const sample = row.latest.sample, state = row.latest.state ?? sample;
  row.cells[0].textContent = (row.latest.appearance?.appearance?.outfitName ?? '') + ' ' + playerId.slice(-4);
  row.cells[1].textContent = sample ? sample.pos.map((v) => v.toFixed(1)).join(', ') : '—';
  row.cells[2].textContent = sample ? (sample.yaw ?? 0).toFixed(0) : '—';
  row.cells[3].textContent = state.stamina01 != null ? Math.round(state.stamina01 * 100) + '%' : '—';
  row.cells[4].textContent = sample ? 't=' + sample.t : '—';
}
</script></html>`;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(error.statusCode ?? 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      } else res.end();
    });
  });
  return { server, runs, codeByRunId, startDailyPrewarm };
}

export function startCli(argv = process.argv.slice(2)) {
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const port = Number(flag("port", 8787));
  const host = flag("host", "127.0.0.1");
  const dir = flag("dir", null);
  const { server, startDailyPrewarm } = createLiveServer({ persistenceDir: dir });
  startDailyPrewarm();
  server.listen(port, host, () => {
    console.log(`PeakTrail live relay on http://${host}:${port}/ (code-confirmed runs, multi-producer dedupe)`);
    if (host !== "127.0.0.1") {
      console.log("WARNING: bound beyond loopback — anyone who guesses the 4-character code can read live positions. Put access control in front (reverse proxy) until token auth lands.");
    }
  });
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  startCli();
}
