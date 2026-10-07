import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn, setTimeout as pause } from "node:timers/promises";
import { createLiveServer } from "../../server/live-server.mjs";
import { createTrajectoryApi } from "../../server/trajectory-api.mjs";
import { digest, validateTrajectory, extractStageRoutes, aggregateHeatmap } from "../../server/trajectory-contract.mjs";
import { moderate, ingestUpload, mapMatch } from "../../server/trajectory-store.mjs";

function fixture(change = {}) {
  return { format: "trajectory-v1", recordingId: digest("recording-1"), runKey: digest("run-1"), timeOriginMs: 1000000,
    startedUtc: "2026-10-07T08:00:00Z", durationMs: 2000, sampleHz: 10, coordinateUnit: "cm",
    map: { buildId: "25306743", scene: "Level_0", levelIndex: 42, layoutKey: digest("layout"), route: ["Shore", "Roots"],
      stages: [{ index: 0, name: "Shore", enterZCm: 0, exitZCm: 1000 }, { index: 1, name: "Roots", enterZCm: 1000, exitZCm: 2000 }] },
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
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, mapPacks: [{ gameBuildId: catalogBuild, sceneName: "Level_0", mapPackId: `sha256-${digest("map")}`, enabled: true }] }));
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
  const workers = []; let running = 0, peakRunning = 0;
  class HeldWorker extends EventEmitter {
    constructor() { super(); this.terminateCount = 0; this.exited = false; running += 1; peakRunning = Math.max(peakRunning, running); }
    // Deliberately resolve termination before exit to guard against treating the
    // promise or error notification as proof that the worker stopped.
    terminate() { this.terminateCount += 1; return Promise.resolve(1); }
    exit(code) { if (!this.exited) { this.exited = true; running -= 1; this.emit("exit", code); } }
  }
  const api = createTrajectoryApi({ root: tmpdir(), workerTimeoutMs: timeoutMs,
    workerFactory: () => { const worker = new HeldWorker(); workers.push(worker); return worker; } });
  const request = () => ({ url: "/api/route-groups", method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } });
  const response = () => ({ destroyed: false, writableEnded: false,
    writeHead(status) { this.status = status; }, end(json) { this.body = JSON.parse(json); this.writableEnded = true; } });
  return { api, workers, request, response, peak: () => peakRunning,
    close: () => { api.close(); for (const worker of workers) worker.exit(1); } };
}
async function until(predicate) {
  for (let turn = 0; turn < 1000 && !predicate(); turn += 1) await nextTurn();
  assert.ok(predicate(), "expected lifecycle condition did not arrive");
}

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

test("real HTTP upload is private pending, idempotent, approved routes are visible, hiding removes heat", async () => {
  await isolated(async ({ root, base }) => {
    const first = await post(base, fixture()); assert.equal(first.status, 201); assert.match(first.body.uploadId, /^[a-f0-9]{64}$/);
    assert.equal(first.body.moderationStatus, "pending"); assert.equal(first.body.mapCompatibility, "matched");
    assert.equal(first.body.stages[0].stages[0].completion, "complete");
    assert.deepEqual((await get(base, "/api/route-groups")).body.groups, []);
    const duplicate = await post(base, fixture()); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
    assert.equal((await readdir(join(root, "index"))).length, 1);
    await moderate(root, first.body.uploadId, "approved");
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
    assert.deepEqual(await readdir(root), ["catalog.json"]);
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
