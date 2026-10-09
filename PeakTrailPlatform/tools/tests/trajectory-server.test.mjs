import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn, setTimeout as pause } from "node:timers/promises";
import { createLiveServer } from "../../server/live-server.mjs";
import { createTrajectoryApi } from "../../server/trajectory-api.mjs";
import { digest, validateTrajectory, extractStageRoutes, extractInspectionStage, aggregateHeatmap } from "../../server/trajectory-contract.mjs";
import { moderate, ingestUpload, mapMatch, autoApprovePending } from "../../server/trajectory-store.mjs";

function fixture(change = {}) {
  return { format: "trajectory-v1", recordingId: digest("recording-1"), runKey: digest("run-1"), timeOriginMs: 1000000,
    startedUtc: "2026-10-07T08:00:00Z", durationMs: 2000, sampleHz: 10, coordinateUnit: "cm",
    map: { buildId: "25306743", scene: "Level_0", levelIndex: 42, layoutKey: digest("layout"), route: ["Shore", "Roots"],
      stages: [{ index: 0, name: "Shore", enterZCm: 0, exitZCm: 1000 }, { index: 1, name: "Roots", enterZCm: 1000, exitZCm: 2000 }],
      alignment: { version: 1, coordinateSpace: "unity-world-cm", landmarks: [
        { key: "progress-point:0", kind: "progress-point", stageIndex: 0, name: "Beach_Entry", positionCm: [0, 0, 0] },
        { key: "progress-point:1", kind: "progress-point", stageIndex: 1, name: "Roots_Entry", positionCm: [1000, 1000, 1000] },
        { key: "progress-point:peak", kind: "progress-point", name: "Peak", positionCm: [0, 1000, 2000] },
      ] } },
    difficulty: { ascent: 1, custom: false, mini: false }, players: [{ key: digest("run1-player1"), name: "同名", owner: true, evidence: "native-state",
      points: Array.from({ length: 21 }, (_, index) => [index * 100, 0, 0, index * 100]), events: [] }], ...change };
}
async function start(root = null, catalogPath = null) {
  const live = createLiveServer({ trajectoryDir: root, catalogPath });
  await new Promise((done) => live.server.listen(0, "127.0.0.1", done));
  return { live, base: `http://127.0.0.1:${live.server.address().port}`, close: () => new Promise((done) => {
    live.server.closeAllConnections?.(); live.server.close(done);
  }) };
}
async function isolated(fn, catalogBuild = "25306743") {
  const root = await mkdtemp(join(tmpdir(), "peak-trajectory-test-")), catalogPath = join(root, "catalog.json");
  const mapPackId = `sha256-${digest("map")}`, sourceSceneSha256 = digest("source-scene");
  const packDirectory = join(root, "packs", mapPackId); await mkdir(packDirectory, { recursive: true });
  await writeFile(join(packDirectory, "map-pack.json"), JSON.stringify({ mapPackId, gameBuildId: catalogBuild, sceneName: "Level_0", coordinateSpace: "unity-world-meters", source: { sceneSha256: sourceSceneSha256 } }));
  await writeFile(join(root, `landmarks.${catalogBuild}.json`), JSON.stringify({ schemaVersion: 1, gameBuildId: catalogBuild, authority: "serialized-map-landmarks",
    sourceGameAssemblyMvid: "a".repeat(32), sourceGameAssemblySha256: digest("source-assembly"),
    maps: [{ sceneName: "Level_0", mapPackId, sourceSceneSha256, alignment: fixture().map.alignment }] }));
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, mapPacks: [{ gameBuildId: catalogBuild, sceneName: "Level_0", mapPackId, path: `./packs/${mapPackId}/map-pack.json`, route: fixture().map.route, enabled: true }] }));
  const server = await start(root, catalogPath);
  try { await fn({ root, catalogPath, ...server }); }
  finally { await server.close(); await rm(root, { recursive: true, force: true }); }
}
async function post(base, raw, compressed = null) {
  const response = await fetch(`${base}/api/route-uploads`, { method: "POST", headers: {
    "content-type": "application/json", "content-encoding": "gzip", "x-trajectory-format": "trajectory-v1" }, body: compressed ?? gzipSync(JSON.stringify(raw)) });
  return { status: response.status, body: await response.json() };
}
async function get(base, path) { const response = await fetch(base + path); return { status: response.status, body: await response.json() }; }

function heldWorkerHarness(timeoutMs) {
  const workers = [], jobs = []; let running = 0, peakRunning = 0;
  class HeldWorker extends EventEmitter {
    constructor() { super(); this.terminateCount = 0; this.exited = false; running += 1; peakRunning = Math.max(peakRunning, running); }
    // Deliberately resolve termination before exit to guard against treating the
    // promise or error notification as proof that the worker stopped.
    terminate() { this.terminateCount += 1; return Promise.resolve(1); }
    exit(code) { if (!this.exited) { this.exited = true; running -= 1; this.emit("exit", code); } }
  }
  const api = createTrajectoryApi({ root: tmpdir(), workerTimeoutMs: timeoutMs,
    workerFactory: (_url, options) => { jobs.push(options.workerData); const worker = new HeldWorker(); workers.push(worker); return worker; } });
  const request = () => ({ url: "/api/route-groups", method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } });
  const response = () => ({ destroyed: false, writableEnded: false,
    writeHead(status) { this.status = status; }, end(json) { this.body = JSON.parse(json); this.writableEnded = true; } });
  return { api, workers, jobs, request, response, peak: () => peakRunning,
    close: () => { api.close(); for (const worker of workers) worker.exit(1); } };
}
test("default route worker uses this release's staged catalog and explicit test catalogs remain authoritative", async () => {
  for (const catalogPath of [null, join(tmpdir(), "explicit-trajectory-catalog.json")]) {
    let options;
    const worker = new EventEmitter(); worker.terminate = () => Promise.resolve(0);
    const api = createTrajectoryApi({ root: tmpdir(), catalogPath, workerFactory: (_url, value) => { options = value; return worker; } });
    const res = { destroyed: false, writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
    const job = api.handle({ url: "/api/route-groups", method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } }, res);
    await until(() => options);
    assert.equal(options.workerData.catalogPath, catalogPath ?? fileURLToPath(new URL("../../site-dist/data/maps/catalog.json", import.meta.url)));
    worker.emit("message", { json: '{"groups":[]}', migrationComplete: true }); worker.emit("exit", 0);
    await job; api.close();
  }
});
async function until(predicate) {
  for (let turn = 0; turn < 1000 && !predicate(); turn += 1) await nextTurn();
  assert.ok(predicate(), "expected lifecycle condition did not arrive");
}

test("historical migration runs once after a completed first worker, even when that request is invalid", async () => {
  const h = heldWorkerHarness(1000), first = h.response(), second = h.response();
  try {
    const firstJob = h.api.handle(h.request(), first), secondJob = h.api.handle(h.request(), second);
    await until(() => h.workers.length === 1); assert.equal(h.jobs[0].migratePending, true);
    h.workers[0].emit("message", { error: "invalid request", statusCode: 400, migrationComplete: true }); h.workers[0].exit(0);
    await until(() => h.workers.length === 2); assert.equal(h.jobs[1].migratePending, false);
    h.workers[1].emit("message", { json: '{"groups":[]}', migrationComplete: true }); h.workers[1].exit(0);
    await Promise.all([firstJob, secondJob]); assert.equal(first.status, 400); assert.equal(second.status, 200);
  } finally { h.close(); }
});

test("worker error holds the serial queue until actual exit, preserving one live heap", async () => {
  const h = heldWorkerHarness(1000), first = h.response(), second = h.response();
  try {
    const firstJob = h.api.handle(h.request(), first), secondJob = h.api.handle(h.request(), second);
    await until(() => h.workers.length === 1);
    h.workers[0].emit("error", new Error("injected worker failure"));
    await nextTurn(); await nextTurn();
    assert.equal(h.workers.length, 1); assert.equal(first.writableEnded, false);
    h.workers[0].exit(1);
    await until(() => h.workers.length === 2);
    assert.equal(first.status, 503); assert.match(first.body.error, /injected worker failure/);
    h.workers[1].emit("message", { json: '{"groups":[]}' }); h.workers[1].exit(0);
    await Promise.all([firstJob, secondJob]);
    assert.equal(second.status, 200); assert.equal(h.peak(), 1);
  } finally { h.close(); }
});

test("worker timeout requests termination but cannot release the queue before exit", async () => {
  const h = heldWorkerHarness(20), first = h.response(), second = h.response();
  try {
    const firstJob = h.api.handle(h.request(), first), secondJob = h.api.handle(h.request(), second);
    await until(() => h.workers.length === 1);
    await pause(30);
    assert.equal(h.workers[0].terminateCount, 1); assert.equal(h.workers.length, 1); assert.equal(first.writableEnded, false);
    h.workers[0].exit(1);
    await until(() => h.workers.length === 2);
    assert.equal(first.status, 503); assert.match(first.body.error, /timed out/);
    h.workers[1].emit("message", { json: '{"groups":[]}' }); h.workers[1].exit(0);
    await Promise.all([firstJob, secondJob]);
    assert.equal(second.status, 200); assert.equal(h.peak(), 1);
  } finally { h.close(); }
});

test("trajectory whitelist rejects sensitive extra fields at every accepted object boundary", () => {
  for (const mutate of [
    (v) => { v.steamId = "76561190000000000"; }, (v) => { v.inventory = []; },
    (v) => { v.map.texture = "private.bundle"; }, (v) => { v.map.stages[0].objects = []; },
    (v) => { v.difficulty.loot = true; }, (v) => { v.players[0].steamId = "76561190000000000"; },
    (v) => { v.players[0].events.push({ tMs: 0, kind: "join", chat: "secret" }); },
  ]) { const raw = fixture(); mutate(raw); assert.throws(() => validateTrajectory(raw), /unexpected field/); }
});

test("bounded format validates hashes, difficulty, gates, sorted times and 10 Hz without upsampling", () => {
  assert.equal(validateTrajectory(fixture()).totalPoints, 21);
  for (const mutate of [
    (v) => { v.recordingId = "76561190000000000"; }, (v) => { v.map.layoutKey = "platform-id"; },
    (v) => { v.map.stages[0].exitZCm = -1; }, (v) => { delete v.map.stages[0].exitZCm; },
    (v) => { v.map.route.reverse(); }, (v) => { v.sampleHz = 60; }, (v) => { v.durationMs = 14400001; },
    (v) => { v.players[0].points[1][0] = 50; }, (v) => { v.players[0].points[1][1] = NaN; },
    (v) => { delete v.players[0].evidence; }, (v) => { v.players[0].key = "76561190000000000"; },
    (v) => { v.players[0].events = [{ tMs: 100, kind: "dead" }, { tMs: 0, kind: "revive" }]; },
  ]) { const raw = fixture(); mutate(raw); assert.throws(() => validateTrajectory(raw)); }
  const sparse = fixture(); sparse.players[0].points = sparse.players[0].points.filter((_, index) => index % 2 === 0);
  assert.equal(validateTrajectory(sparse).totalPoints, 11);
});

test("completion belongs to each living continuous player, never a team progression flag", () => {
  const raw = fixture(), player = raw.players[0], stage = raw.map.stages[0];
  assert.equal(extractStageRoutes(raw, player, stage).completion, "complete");
  for (const kind of ["dead", "leave", "break", "warp"]) {
    const interrupted = structuredClone(player); interrupted.events = [{ tMs: 500, kind }, { tMs: 1900, kind: "finish", stageIndex: 0 }];
    assert.equal(extractStageRoutes(raw, interrupted, stage).completion, "partial", kind);
  }
  const late = structuredClone(player); late.points = late.points.slice(6);
  assert.equal(extractStageRoutes(raw, late, stage).completion, "partial");
  const legacy = { ...player, evidence: "legacy-unknown" };
  assert.equal(extractStageRoutes(raw, legacy, stage).completion, "unknown");
  assert.equal(extractStageRoutes(raw, player, { index: 0, name: "Shore" }).completion, "unknown");
  const gap = structuredClone(player); gap.points = [gap.points[0], gap.points[20]];
  assert.equal(extractStageRoutes(raw, gap, stage).completion, "partial");
});

test("heatmap counts each route once per voxel, retains height and never bridges discontinuities", () => {
  const cells = aggregateHeatmap([[[0, 0, 0, 0], [100, 0, 0, 10], [200, 0, 0, 20]], [[0, 0, 400, 0], [100, 0, 400, 20]]]);
  assert.deepEqual(cells, [[0, 0, 0, 1], [0, 2, 0, 1]]);
  assert.deepEqual(aggregateHeatmap([[[0, 0, 0, 0], [2000, 2000, 0, 0]]]), [[0, 0, 0, 1], [10, 0, 0, 1]]);
  assert.equal(aggregateHeatmap([[[0, 0, 0, 0]], [[0, 0, 0, 0]]])[0][3], 2);
});

test("default memoir service automatically approves valid uploads while old live stays retired", async () => {
  await isolated(async ({ root, base, live }) => {
    assert.equal((await get(base, "/api/runs")).status, 410);
    const retired = await fetch(base + "/api/runs", { method: "POST", body: "old live registration" });
    assert.equal(retired.status, 410);
    assert.equal(live.runs.size, 0);
    const first = await post(base, fixture()); assert.equal(first.status, 201); assert.match(first.body.uploadId, /^[a-f0-9]{64}$/);
    assert.equal(first.body.moderationStatus, "approved"); assert.equal(first.body.mapCompatibility, "matched");
    assert.equal(first.body.stages[0].stages[0].completion, "complete");
    const immediatelyPublic = (await get(base, "/api/route-groups")).body.groups;
    assert.equal(immediatelyPublic.length, 1); assert.equal(first.body.groupId, immediatelyPublic[0].id);
    assert.equal(immediatelyPublic[0].firstStartedUtc, fixture().startedUtc); assert.equal(immediatelyPublic[0].lastStartedUtc, fixture().startedUtc);
    const duplicate = await post(base, fixture()); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
    assert.equal((await readdir(join(root, "index"))).length, 1);
    const index = JSON.parse(await readFile(join(root, "index", `${first.body.uploadId}.json`), "utf8"));
    assert.equal(index.reviewMethod, "automatic-contract-v1"); assert.ok(index.reviewedUtc); assert.equal(index.startedUtc, fixture().startedUtc);
    const group = (await get(base, "/api/route-groups")).body.groups[0]; assert.equal(group.stageSummaries[0].routeCount, 1);
    const [routes, heat] = await Promise.all([get(base, `/api/route-groups/${group.id}/stages/0/routes`), get(base, `/api/route-groups/${group.id}/stages/0/heatmap`)]);
    assert.equal(routes.status, 200); assert.equal(heat.status, 200);
    assert.equal(routes.body.routes[0].name, "同名"); assert.equal(heat.body.routeCount, 1); assert.ok(heat.body.cells.every((cell) => cell[3] === 1));
    const difficulty = group.difficulties[0].key;
    assert.equal((await get(base, `/api/route-groups/${group.id}/stages/0/routes?difficulty=${difficulty}`)).body.routes.length, 1);
    assert.equal((await get(base, `/api/route-groups/${group.id}/stages/0/routes?difficulty=unknown`)).body.routes.length, 0);
    await moderate(root, first.body.uploadId, "hidden");
    assert.deepEqual((await get(base, "/api/route-groups")).body.groups, []);
    assert.equal((await get(base, `/api/route-groups/${group.id}/stages/0/heatmap`)).status, 404);
    assert.equal((await post(base, fixture())).body.moderationStatus, "hidden");
  });
});

async function legacyPending(root, id) {
  const path = join(root, "index", `${id}.json`), entry = JSON.parse(await readFile(path, "utf8"));
  entry.moderationStatus = "pending"; delete entry.reviewedUtc; delete entry.reviewMethod; delete entry.startedUtc;
  await writeFile(path, JSON.stringify(entry)); return entry;
}

test("historical untouched pending submissions migrate after restart using their recording date", async () => {
  await isolated(async ({ root, base, catalogPath, close }) => {
    const upload = await post(base, fixture()); await legacyPending(root, upload.body.uploadId);
    await close(); const restarted = await start(root, catalogPath);
    try {
      const groups = (await get(restarted.base, "/api/route-groups")).body.groups;
      assert.equal(groups.length, 1); assert.equal(groups[0].id, upload.body.groupId);
      assert.equal(groups[0].firstStartedUtc, fixture().startedUtc);
      const index = JSON.parse(await readFile(join(root, "index", `${upload.body.uploadId}.json`), "utf8"));
      assert.equal(index.moderationStatus, "approved"); assert.equal(index.reviewMethod, "automatic-contract-v1");
      assert.equal(index.startedUtc, fixture().startedUtc); const reviewedUtc = index.reviewedUtc;
      assert.equal((await post(restarted.base, fixture())).body.moderationStatus, "approved");
      await get(restarted.base, "/api/route-groups");
      assert.equal(JSON.parse(await readFile(join(root, "index", `${upload.body.uploadId}.json`), "utf8")).reviewedUtc, reviewedUtc);
      // Migration runs once per service. A later administrative hold cannot be
      // reinterpreted as a newly discovered original pending submission.
      await moderate(root, upload.body.uploadId, "pending");
      assert.deepEqual((await get(restarted.base, "/api/route-groups")).body.groups, []);
    } finally { await restarted.close(); }
  });
});

test("automatic migration preserves hidden, rejected and explicitly held pending submissions", async () => {
  await isolated(async ({ root, base }) => {
    const entries = [];
    for (const [i, status] of ["hidden", "rejected", "pending"].entries()) {
      const upload = await post(base, fixture({ recordingId: digest(`manual-${i}`) }));
      await moderate(root, upload.body.uploadId, status);
      entries.push({ id: upload.body.uploadId, status, bytes: await readFile(join(root, "index", `${upload.body.uploadId}.json`)) });
    }
    assert.deepEqual(await autoApprovePending(root), { approved: 0, invalid: 0, busy: 0 });
    for (const entry of entries) {
      const bytes = await readFile(join(root, "index", `${entry.id}.json`));
      assert.deepEqual(bytes, entry.bytes); assert.equal(JSON.parse(bytes).moderationStatus, entry.status);
    }
    assert.deepEqual((await get(base, "/api/route-groups")).body.groups, []);
  });
});

test("automatic migration fails closed on altered payload, index or derived route", async () => {
  await isolated(async ({ root, base }) => {
    for (const [i, damage] of ["gzip", "sha", "private-field", "index", "route", "missing-route"].entries()) {
      const raw = fixture({ recordingId: digest(`damaged-${i}`) }), upload = await post(base, raw);
      const entry = await legacyPending(root, upload.body.uploadId), indexPath = join(root, "index", `${entry.id}.json`);
      const uploadPath = join(root, "uploads", `${entry.id}.json.gz`), routePath = join(root, "routes", entry.routes[0].file);
      if (damage === "gzip") await writeFile(uploadPath, "damaged gzip");
      if (damage === "sha") { raw.players[0].name = "changed"; await writeFile(uploadPath, gzipSync(JSON.stringify(raw))); }
      if (damage === "private-field") { raw.players[0].steamId = "76561190000000000"; await writeFile(uploadPath, gzipSync(JSON.stringify(raw))); }
      if (damage === "index") { entry.routes[0].stageIndex = 1; await writeFile(indexPath, JSON.stringify(entry)); }
      if (damage === "route") await writeFile(routePath, gzipSync(JSON.stringify({ points: [[0,0,0,0],[100,0,0,1000]], breaks: [] })));
      if (damage === "missing-route") await rm(routePath);
    }
    assert.deepEqual(await autoApprovePending(root), { approved: 0, invalid: 6, busy: 0 });
    for (const file of await readdir(join(root, "index"))) {
      const entry = JSON.parse(await readFile(join(root, "index", file), "utf8"));
      assert.equal(entry.moderationStatus, "pending"); assert.equal(Object.hasOwn(entry, "reviewedUtc"), false);
    }
    assert.deepEqual((await get(base, "/api/route-groups")).body.groups, []);
  });
});

test("automatic review and administrative withdrawal share an exclusive index lock", async () => {
  await isolated(async ({ root, base }) => {
    const upload = await post(base, fixture()), entry = await legacyPending(root, upload.body.uploadId);
    const lockPath = join(root, "index", `${entry.id}.json.review-lock`);
    await writeFile(lockPath, "held by another reviewer", { flag: "wx" });
    const withdrawing = moderate(root, entry.id, "hidden");
    assert.deepEqual(await autoApprovePending(root), { approved: 0, invalid: 0, busy: 1 });
    await rm(lockPath); await withdrawing;
    assert.deepEqual(await autoApprovePending(root), { approved: 0, invalid: 0, busy: 0 });
    assert.equal(JSON.parse(await readFile(join(root, "index", `${entry.id}.json`), "utf8")).moderationStatus, "hidden");
    assert.equal((await readdir(join(root, "index"))).some(file => file.endsWith("review-lock")), false);
  });
});

test("approved inspection shows incomplete volcanic travel without changing complete route or heat totals", async () => {
  await isolated(async ({ root, base }) => {
    const raw = fixture({ durationMs: 3500 }); delete raw.map.alignment;
    raw.map.route = ["Shore", "Roots", "Mesa", "Volcano", "Kiln"];
    raw.map.stages = raw.map.route.map((name, index) => ({ index, name, enterZCm: index * 1000, exitZCm: (index + 1) * 1000 }));
    raw.players[0].points = Array.from({ length: 36 }, (_, i) => [i * 100, 0, 0, i * 100]);
    raw.players[0].events = [{ tMs: 2500, kind: "warp" }, { tMs: 3200, kind: "break" }];
    const upload = await post(base, raw); assert.equal(upload.body.moderationStatus, "approved");
    const group = (await get(base, "/api/route-groups")).body.groups[0];
    assert.deepEqual(group.stageSummaries.map(stage => stage.routeCount), [1,1,0,0,0]);
    const normalPath = `/api/route-groups/${group.id}/stages/3`, inspectionPath = `/api/route-groups/${group.id}/uploads/${upload.body.uploadId}/stages/3/inspection`;
    const [beforeRoutes, beforeHeat, inspection] = await Promise.all([get(base, normalPath + "/routes"), get(base, normalPath + "/heatmap"), get(base, inspectionPath)]);
    assert.equal(inspection.status, 200); assert.equal(inspection.body.inspection, true); assert.equal(inspection.body.excludedFromAggregation, true);
    assert.equal(inspection.body.groupId, group.id); assert.equal(inspection.body.uploadId, upload.body.uploadId);
    assert.equal(inspection.body.routes.length, 1); assert.equal(inspection.body.routes[0].completion, "partial"); assert.equal(inspection.body.routes[0].completed, false);
    assert.deepEqual(inspection.body.routes[0].breaks, [3200]); assert.ok(inspection.body.routes[0].points.length > 1);
    assert.deepEqual((await get(base, normalPath + "/routes")).body, beforeRoutes.body);
    assert.deepEqual((await get(base, normalPath + "/heatmap")).body, beforeHeat.body);
    assert.equal(beforeRoutes.body.routes.length, 0); assert.equal(beforeHeat.body.routeCount, 0);
    assert.equal((await get(base, `/api/route-groups/${digest("other-group")}/uploads/${upload.body.uploadId}/stages/3/inspection`)).status, 404);
    await moderate(root, upload.body.uploadId, "hidden"); assert.equal((await get(base, inspectionPath)).status, 404);
  });
});

test("inspection retains real interruptions, sampling gaps, excessive movement and re-entry breaks", () => {
  const raw = fixture({ durationMs: 5000 }), player = raw.players[0], stage = raw.map.stages[0];
  player.points = [[0,0,0,0],[100,0,0,100],[200,2000,0,200],[300,2000,0,300],
    [400,2000,0,3000],[500,2000,0,400],[2200,2000,0,500],[2300,2000,0,600]];
  player.events = [{ tMs: 250, kind: "warp" }, { tMs: 2000, kind: "dead" }, { tMs: 2250, kind: "revive" }];
  const result = extractInspectionStage(raw, player, stage);
  assert.deepEqual(result.points, player.points.filter(point => point[3] <= 1300));
  assert.deepEqual(result.breaks, [200,250,500,2000,2200,2250]); assert.equal(result.completion, "partial");
});

test("inspection uses the same verified landmark transform and refuses damaged approved stored coordinates", async () => {
  await isolated(async ({ root, base }) => {
    const raw = fixture(), offset = [5000,-3000,8000];
    raw.map.alignment.landmarks.forEach(item => { item.positionCm = item.positionCm.map((value, axis) => value + offset[axis]); });
    raw.map.stages.forEach(stage => { stage.enterZCm += offset[2]; stage.exitZCm += offset[2]; });
    raw.players[0].points.forEach(point => { for (let axis = 0; axis < 3; axis++) point[axis+1] += offset[axis]; });
    const upload = await post(base, raw), path = `/api/route-groups/${upload.body.groupId}/uploads/${upload.body.uploadId}/stages/0/inspection`;
    const result = await get(base, path);
    assert.equal(result.status, 200); assert.equal(result.body.coordinateSpace, "canonical-map-world-cm");
    assert.equal(result.body.mapAlignment.id, upload.body.mapAlignment.id);
    assert.deepEqual(result.body.routes[0].points, fixture().players[0].points.slice(0,14));
    await writeFile(join(root, "uploads", `${upload.body.uploadId}.json.gz`), gzipSync(JSON.stringify(fixture())));
    assert.equal((await get(base, path)).status, 503);
    await moderate(root, upload.body.uploadId, "rejected"); assert.equal((await get(base, path)).status, 404);
  });
});

test("two people with the same name stay separate, dead player has no complete route", async () => {
  await isolated(async ({ root, base }) => {
    const raw = fixture(); raw.players.push({ ...structuredClone(raw.players[0]), key: digest("run1-player2"), owner: false });
    const upload = await post(base, raw); await moderate(root, upload.body.uploadId, "approved");
    const group = (await get(base, "/api/route-groups")).body.groups[0];
    assert.equal((await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body.routes.length, 2);
    const raw2 = fixture({ recordingId: digest("another-run"), runKey: digest("run2") });
    raw2.players[0].events.push({ tMs: 500, kind: "dead" });
    const partial = await post(base, raw2); assert.equal(partial.body.stages[0].stages[0].completion, "partial");
    await moderate(root, partial.body.uploadId, "approved");
    assert.equal((await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body.routes.length, 2);
  });
});

test("shared run/player/clock dedup prefers owner, separate attempts and no shared clock remain separate", async () => {
  await isolated(async ({ root, base }) => {
    const a = fixture(); a.players[0].owner = false; a.players[0].name = "远端观测";
    const b = fixture({ recordingId: digest("recording-2") }); b.players[0].name = "本机记录";
    for (const raw of [a, b]) { const upload = await post(base, raw); await moderate(root, upload.body.uploadId, "approved"); }
    const group = (await get(base, "/api/route-groups")).body.groups[0];
    const result = (await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body;
    assert.equal(result.routes.length, 1); assert.equal(result.routes[0].name, "本机记录");
    const c = fixture({ recordingId: digest("recording-3"), timeOriginMs: 1100000 });
    const next = await post(base, c); await moderate(root, next.body.uploadId, "approved");
    assert.equal((await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body.routes.length, 2);
    const d = fixture({ recordingId: digest("recording-4") }); delete d.timeOriginMs;
    const separate = await post(base, d); await moderate(root, separate.body.uploadId, "approved");
    assert.equal((await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body.routes.length, 3);
    const limited = (await get(base, `/api/route-groups/${group.id}/stages/0/routes?limit=1`)).body;
    assert.equal(limited.routes.length, 1); assert.equal(limited.totalRouteCount, 3); assert.equal(limited.truncated, true);
  });
});

test("legacy unknown and missing gates upload successfully without public complete routes", async () => {
  await isolated(async ({ root, base }) => {
    const raw = fixture(); raw.players[0].evidence = "legacy-unknown";
    const upload = await post(base, raw); assert.equal(upload.status, 201); assert.equal(upload.body.stages[0].stages[0].completion, "unknown");
    await moderate(root, upload.body.uploadId, "approved"); assert.deepEqual((await get(base, "/api/route-groups")).body.groups, []);
    const absent = fixture({ recordingId: digest("missing-gates") }); for (const stage of absent.map.stages) { delete stage.enterZCm; delete stage.exitZCm; }
    const old = await post(base, absent); assert.equal(old.status, 201); assert.equal(old.body.stages[0].stages[0].completion, "unknown");
  });
});

test("negative native timer anchor retains initial points and deduplicates shifted shared recordings", async () => {
  await isolated(async ({ root, base }) => {
    const a = fixture({ timeOriginMs: -2000 });
    const b = fixture({ recordingId: digest("negative-anchor-copy"), timeOriginMs: -2100, durationMs: 2100 });
    b.players[0].points = b.players[0].points.map(([t, ...xyz]) => [t + 100, ...xyz]);
    for (const raw of [a, b]) {
      const upload = await post(base, raw); assert.equal(upload.status, 201);
      await moderate(root, upload.body.uploadId, "approved");
      const metadata = JSON.parse(await readFile(join(root, "index", `${upload.body.uploadId}.json`), "utf8"));
      assert.equal(metadata.routes[0].dedupe.startMs, -2000);
    }
    const group = (await get(base, "/api/route-groups")).body.groups[0];
    const routes = (await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body.routes;
    assert.equal(routes.length, 1); assert.equal(routes[0].points[0][3], 0);
  });
});

test("audited terminal variants match native Kiln names but conflicting selected branches wait for a map", async () => {
  await isolated(async ({ catalogPath }) => {
    const map = fixture().map;
    map.route = ["Shore", "Roots", "Alpine", "Volcano", "Kiln"];
    map.stages = map.route.map((name, index) => ({ index, name, enterZCm: index * 1000, exitZCm: (index + 1) * 1000 }));
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    catalog.mapPacks[0].route = { branch: "volcano-kiln", segments: ["Shore", "Roots", "Alpine", "Volcano", "Volcano"].map((biome, index) => ({ index, biome })) };
    await writeFile(catalogPath, JSON.stringify(catalog));
    assert.equal((await mapMatch(map, catalogPath)).mapCompatibility, "matched");
    map.route[4] = "Temple"; map.stages[4].name = "Temple";
    assert.equal((await mapMatch(map, catalogPath)).mapCompatibility, "waiting-map");
    map.route[4] = "Kiln"; map.stages[4].name = "Kiln"; map.route[1] = "Tropics"; map.stages[1].name = "Tropics";
    assert.equal((await mapMatch(map, catalogPath)).mapCompatibility, "waiting-map");
  });
});

test("wrong game build waits for map and exposes approved bare XYZ rather than old geometry", async () => {
  await isolated(async ({ root, base }) => {
    const raw = fixture(); raw.map.buildId = "25667990";
    const upload = await post(base, raw); assert.equal(upload.body.mapCompatibility, "waiting-map"); assert.equal(upload.body.mapPackId, null);
    await moderate(root, upload.body.uploadId, "approved");
    const group = (await get(base, "/api/route-groups")).body.groups[0]; assert.equal(group.mapCompatibility, "waiting-map");
    const routes = (await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body;
    assert.equal(routes.routes.length, 1); assert.equal(routes.mapPackId, null);
  });
});

test("canonical route responses and heatmap aggregation use the same proven global translation", async () => {
  await isolated(async ({ root, base, catalogPath }) => {
    const raw = fixture(), offset = [5000,-3000,8000];
    raw.map.alignment.landmarks.forEach(item => { item.positionCm = item.positionCm.map((value, axis) => value + offset[axis]); });
    raw.map.stages.forEach(stage => { stage.enterZCm += offset[2]; stage.exitZCm += offset[2]; });
    raw.players[0].points.forEach(point => { for (let axis = 0; axis < 3; axis++) point[axis+1] += offset[axis]; });
    const upload = await post(base, raw);
    assert.equal(upload.status, 201); assert.equal(upload.body.mapAlignment.status, "verified"); assert.equal(upload.body.mapAlignment.method, "rigid");
    await moderate(root, upload.body.uploadId, "approved");
    const group = (await get(base, "/api/route-groups")).body.groups[0];
    const routes = (await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body;
    const heat = (await get(base, `/api/route-groups/${group.id}/stages/0/heatmap`)).body;
    assert.equal(routes.coordinateSpace, "canonical-map-world-cm"); assert.equal(routes.mapAlignment.id, group.mapAlignment.id);
    assert.equal(heat.mapAlignment.id, routes.mapAlignment.id); assert.equal(heat.coordinateSpace, routes.coordinateSpace);
    assert.deepEqual(routes.routes[0].points, fixture().players[0].points.slice(0,11));
    assert.deepEqual(heat.cells, aggregateHeatmap([routes.routes[0].points]));
    const index = JSON.parse(await readFile(join(root, "index", `${upload.body.uploadId}.json`), "utf8"));
    assert.deepEqual(index.map.alignment, validateTrajectory(raw).trajectory.map.alignment, "stored recording-world evidence is not replaced by the fitted source map");
    const original = await post(base, fixture()); await moderate(root, original.body.uploadId, "approved");
    const groups = (await get(base, "/api/route-groups")).body.groups;
    assert.equal(groups.length, 2, "different recorded layouts are selectable, never merged through a shared source model");
    assert.ok(groups.every(value => value.mapCompatibility === "matched"));
    assert.equal((await mapMatch(raw.map, catalogPath)).mapAlignment.method, "rigid");
  });
});

test("legacy missing landmarks remain stored and publicly queryable without claiming verified map coordinates", async () => {
  await isolated(async ({ root, base }) => {
    const raw = fixture(); delete raw.map.alignment;
    const upload = await post(base, raw); assert.equal(upload.status, 201); assert.equal(upload.body.mapAlignment.reason, "recording-landmarks-missing");
    await moderate(root, upload.body.uploadId, "approved");
    const group = (await get(base, "/api/route-groups")).body.groups[0];
    assert.equal(group.stageSummaries[0].routeCount, 1); assert.equal(group.mapCompatibility, "waiting-map");
    const routes = (await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body;
    assert.equal(routes.coordinateSpace, "recording-world-cm"); assert.equal(routes.mapAlignment.status, "pending");
    assert.deepEqual(routes.routes[0].points, raw.players[0].points.slice(0,11));
  });
});

test("source scene SHA, exact landmarks and native gate positions reject wrong model/layout evidence", async () => {
  await isolated(async ({ root, catalogPath }) => {
    const raw = fixture(); raw.map.stages[0].exitZCm += 1;
    assert.throws(() => validateTrajectory(raw), /gates disagree/);
    const displaced = fixture().map; displaced.alignment.landmarks[1].positionCm[0] += 500;
    assert.equal((await mapMatch(displaced, catalogPath)).mapAlignment.reason, "non-rigid-layout");
    const path = join(root, "landmarks.25306743.json"), sidecar = JSON.parse(await readFile(path, "utf8"));
    sidecar.maps[0].sourceSceneSha256 = digest("different-scene"); await writeFile(path, JSON.stringify(sidecar));
    assert.equal((await mapMatch(fixture().map, catalogPath)).mapAlignment.reason, "source-evidence-mismatch");
    sidecar.maps[0].sourceSceneSha256 = digest("source-scene"); sidecar.maps[0].alignment.landmarks[1].name = "Wrong native branch";
    await writeFile(path, JSON.stringify(sidecar));
    assert.equal((await mapMatch(fixture().map, catalogPath)).mapAlignment.reason, "landmark-identity-mismatch");
    sidecar.gameBuildId = "25739797"; await writeFile(path, JSON.stringify(sidecar));
    assert.equal((await mapMatch(fixture().map, catalogPath)).mapAlignment.reason, "source-evidence-mismatch");
  });
});

test("audited legacy layout hashes prove only the exact original identity and retain old accepted recordings", async () => {
  await isolated(async ({ root, base, catalogPath }) => {
    const path = join(root, "landmarks.25306743.json"), sidecar = JSON.parse(await readFile(path, "utf8"));
    sidecar.maps[0].expectedLegacyLayoutKey = fixture().map.layoutKey;
    sidecar.maps[0].legacyRootTransformPolicy = "static-no-runtime-trs-writes";
    await writeFile(path, JSON.stringify(sidecar));
    const raw = fixture(); delete raw.map.alignment;
    const upload = await post(base, raw); assert.equal(upload.status, 201); assert.equal(upload.body.mapAlignment.method, "legacy-layout-key");
    await moderate(root, upload.body.uploadId, "approved");
    const group = (await get(base, "/api/route-groups")).body.groups[0];
    assert.equal(group.mapAlignment.method, "legacy-layout-key");
    const routes = (await get(base, `/api/route-groups/${group.id}/stages/0/routes`)).body;
    assert.equal(routes.coordinateSpace, "canonical-map-world-cm"); assert.deepEqual(routes.routes[0].points, raw.players[0].points.slice(0,11));
    const changedHash = structuredClone(raw.map); changedHash.layoutKey = digest("different-layout");
    assert.equal((await mapMatch(changedHash, catalogPath)).mapAlignment.status, "pending");
    const changedGate = structuredClone(raw.map); changedGate.stages[0].exitZCm += 1;
    assert.equal((await mapMatch(changedGate, catalogPath)).mapAlignment.status, "pending");
    delete sidecar.maps[0].legacyRootTransformPolicy; await writeFile(path, JSON.stringify(sidecar));
    assert.equal((await mapMatch(raw.map, catalogPath)).mapAlignment.status, "pending");
    sidecar.maps[0].legacyRootTransformPolicy = "static-no-runtime-trs-writes"; delete sidecar.sourceGameAssemblyMvid;
    await writeFile(path, JSON.stringify(sidecar)); assert.equal((await mapMatch(raw.map, catalogPath)).mapAlignment.status, "pending");
  });
});

test("persistent upload and moderation recover across real HTTP service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-trajectory-restart-")), catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, mapPacks: [] }));
  let server = await start(root, catalogPath);
  try {
    const upload = await post(server.base, fixture()); await moderate(root, upload.body.uploadId, "approved");
    await server.close(); server = await start(root, catalogPath);
    const groups = (await get(server.base, "/api/route-groups")).body.groups; assert.equal(groups.length, 1);
    assert.equal((await post(server.base, fixture())).body.moderationStatus, "approved");
    const data = JSON.parse(await readFile(join(root, "index", `${upload.body.uploadId}.json`), "utf8")); assert.equal(data.playerCount, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("malformed gzip, private fields, oversized decoded body and unsupported media leave no stored upload", async () => {
  await isolated(async ({ root, base }) => {
    assert.equal((await post(base, null, Buffer.from("not gzip"))).status, 400);
    const raw = fixture(); raw.players[0].steamId = "76561190000000000";
    assert.equal((await post(base, raw)).status, 400);
    const huge = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 32));
    assert.equal((await post(base, null, huge)).status, 413);
    const plain = await fetch(`${base}/api/route-uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(plain.status, 415);
    assert.deepEqual((await readdir(root)).sort(), ["catalog.json", "index", "landmarks.25306743.json", "packs", "routes", "uploads"]);
    for (const child of ["index", "routes", "uploads"]) assert.deepEqual(await readdir(join(root, child)), []);
  });
});

test("existing orphan bytes count against capacity before any new blob is written", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-trajectory-capacity-"));
  try {
    await mkdir(join(root, "uploads"));
    const { open } = await import("node:fs/promises"); const orphan = await open(join(root, "uploads", "orphan.gz"), "w");
    await orphan.truncate(2 * 1024 * 1024 * 1024); await orphan.close();
    await assert.rejects(() => ingestUpload(root, gzipSync(JSON.stringify(fixture())), join(root, "catalog.json")), /capacity/);
    assert.equal((await readdir(join(root, "index"))).length, 0);
    assert.deepEqual(await readdir(join(root, "uploads")), ["orphan.gz"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
