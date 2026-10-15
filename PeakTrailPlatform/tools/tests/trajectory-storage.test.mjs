import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { digest, validateTrajectory, extractInspectionStage, extractStageRoutes, groupId } from "../../server/trajectory-contract.mjs";
import { ingestUpload, moderate, queryInspection, queryRoutes, queryTeamRoutes, loadIndex, verifyStoredEntry, autoApprovePending } from "../../server/trajectory-store.mjs";
import { planTrajectoryStorage, missingPointBlockBytes, readStoredTrajectory, sourceRoute, makeInspectionSources } from "../../server/trajectory-storage.mjs";
import { teamIdentity } from "../../server/team-index.mjs";
import { prepareTrajectoryStorage } from "../prepare-trajectory-storage.mjs";

function fixture(recording = "first") {
  const points = Array.from({ length: 1200 }, (_, index) => [index * 100,
    Math.round(20000 * Math.sin(index * .037)) || 0, Math.round(8000 * Math.sin(index * .021)) || 0, index * 100]);
  return { format: "trajectory-v1", recordingId: digest(recording), runKey: digest("same-run"), timeOriginMs: 0,
    startedUtc: "2026-10-07T08:00:00Z", durationMs: 120000, sampleHz: 10, coordinateUnit: "cm",
    map: { buildId: "25306743", scene: "Level_0", route: ["Shore"], stages: [{ index: 0, name: "Shore", enterZCm: 0, exitZCm: 100000 }] },
    difficulty: { ascent: 1, custom: false, mini: false },
    players: [{ key: digest("same-player"), name: "本人", owner: true, evidence: "native-state", points,
      events: [{ tMs: 0, kind: "game-stage", stageIndex: 0 }] }] };
}
async function isolated(fn) {
  const parent = await mkdtemp(join(tmpdir(), "peak-storage-test-")), root = join(parent, "store"), catalog = join(parent, "missing-catalog.json");
  try { await fn({ parent, root, catalog }); } finally { await rm(parent, { recursive: true, force: true }); }
}
const upload = (root, raw, catalog) => ingestUpload(root, gzipSync(JSON.stringify(raw)), catalog);
async function logicalLocation(root, hash) {
  for (const file of await readdir(join(root, "point-bases"))) if (/^context-[a-f0-9]{64}\.json$/.test(file)) {
    const path = join(root, "point-bases", file), index = JSON.parse(await readFile(path, "utf8"));
    if (index.blocks[hash]) return { path, index, ref: index.blocks[hash] };
  }
  throw new Error("logical test block unavailable");
}
async function readLogicalBytes(root, hash) {
  const { ref } = await logicalLocation(root, hash), bytes = await readFile(join(root, "point-blocks", `${ref.packHash}.pack`));
  return bytes.subarray(ref.offset, ref.offset + ref.length);
}
async function writeLogicalBytes(root, hash, bytes) {
  const { path, index, ref } = await logicalLocation(root, hash), hashBytes = body => createHash("sha256").update(body).digest("hex"), packHash = hashBytes(bytes);
  await writeFile(join(root, "point-blocks", `${packHash}.pack`), bytes);
  index.blocks[hash] = { ...ref, packHash, offset: 0, length: bytes.length, recordSha256: hashBytes(bytes) };
  await writeFile(path, JSON.stringify(index));
}
async function compressedJson(path) {
  const match = basename(path).match(/^([a-f0-9]{64})\.json\.gz$/), packed = dirname(path).endsWith("point-blocks") && match;
  const bytes = packed ? await readLogicalBytes(dirname(dirname(path)), match[1]) : await readFile(path);
  return JSON.parse(gunzipSync(bytes).toString("utf8"));
}
async function blockFiles(root) {
  const files = [];
  for (const file of await readdir(join(root, "point-bases"))) if (/^context-[a-f0-9]{64}\.json$/.test(file)) {
    const index = JSON.parse(await readFile(join(root, "point-bases", file), "utf8")); files.push(...Object.keys(index.blocks).map(hash => `${hash}.json.gz`));
  }
  return files.sort();
}
async function storageBytes(root) {
  let total = 0;
  for (const child of ["index", "uploads", "routes", "point-blocks", "point-bases"]) for (const file of await readdir(join(root, child)).catch(() => [])) total += (await lstat(join(root, child, file))).size;
  return total;
}

test("same run/player exact observations share physical coordinates while each source retains owner, events and SHA", async () => isolated(async ({ root, catalog }) => {
  const first = fixture(), a = await upload(root, first, catalog), initialBlocks = await blockFiles(root), before = await storageBytes(root);
  const other = fixture("remote"); other.players[0].owner = false; other.players[0].name = "队友观测";
  other.players[0].events.push({ tMs: 43210, kind: "break" });
  const b = await upload(root, other, catalog), after = await storageBytes(root);
  assert.deepEqual(await blockFiles(root), initialBlocks);
  assert.deepEqual((await readStoredTrajectory(root, a.uploadId)).trajectory, validateTrajectory(first).trajectory);
  assert.deepEqual((await readStoredTrajectory(root, b.uploadId)).trajectory, validateTrajectory(other).trajectory);
  assert.deepEqual(await readdir(join(root, "routes")), [], "derived routes contain no second coordinate copy");
  const index = await loadIndex(root);
  assert.ok(index.flatMap(entry => entry.routes).every(route => route.source && !route.file));
  const plain = gzipSync(JSON.stringify(validateTrajectory(other).trajectory)).byteLength;
  assert.ok(after - before < plain, "second source stores metadata rather than full coordinates");
  const queried = await queryTeamRoutes(root, catalog, teamIdentity(index[0]).id, 0);
  assert.equal(queried.routes[0].name, "本人");
  for (const entry of index) await verifyStoredEntry(root, entry);
}));

test("nearby network observations use only profitable one-level lossless deltas, preserving exact jitter", async () => isolated(async ({ root, catalog }) => {
  const base = fixture(), first = await upload(root, base, catalog), other = fixture("jitter"); other.players[0].owner = false;
  other.players[0].points = other.players[0].points.map((point, index) => [point[0] + index % 7, point[1] + index % 3 - 1, point[2] + index % 5 - 2, point[3] + index % 3]);
  const independentlyCompact = planTrajectoryStorage(validateTrajectory(other).trajectory);
  const plan = planTrajectoryStorage(validateTrajectory(other).trajectory), extra = await missingPointBlockBytes(root, plan);
  assert.ok(plan.statistics.deltaBlocks > 0);
  const originalBytes = [...independentlyCompact.blocks.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  assert.ok(extra < originalBytes * .65, `delta ${extra} should save against compact ${originalBytes}`);
  const second = await upload(root, other, catalog);
  const blocks = await Promise.all((await blockFiles(root)).map(file => compressedJson(join(root, "point-blocks", file))));
  for (const block of blocks.filter(value => value.version === 2)) {
    const parent = await compressedJson(join(root, "point-blocks", `${block.baseHash}.json.gz`)); assert.equal(parent.version, 1);
  }
  assert.deepEqual((await readStoredTrajectory(root, first.uploadId)).trajectory, validateTrajectory(base).trajectory);
  assert.deepEqual((await readStoredTrajectory(root, second.uploadId)).trajectory, validateTrajectory(other).trajectory);
}));

test("static runs use compact plain blocks when a delta would cost more", async () => isolated(async ({ root, catalog }) => {
  const base = fixture(); base.players[0].points = base.players[0].points.map(point => [point[0], 42, 0, 100]);
  await upload(root, base, catalog);
  const other = structuredClone(base); other.recordingId = digest("other-static"); other.players[0].points = other.players[0].points.map(point => [point[0],43,0,100]);
  const plan = planTrajectoryStorage(validateTrajectory(other).trajectory); await missingPointBlockBytes(root, plan);
  assert.equal(plan.statistics.deltaBlocks, 0); assert.equal(plan.statistics.plainBlocks, 2);
  const second = await upload(root, other, catalog);
  assert.deepEqual((await readStoredTrajectory(root, second.uploadId)).trajectory, validateTrajectory(other).trajectory);
}));

test("shared clock shifts and negative anchors retain exact recording samples without inventing bucket points", async () => isolated(async ({ root, catalog }) => {
  const base = fixture(); base.timeOriginMs = -37;
  base.players[0].points = base.players[0].points.map((point, index) => [point[0] + (index % 2 ? 1 : 99), ...point.slice(1)]);
  const first = await upload(root, base, catalog);
  const other = structuredClone(base); other.recordingId = digest("shifted"); other.timeOriginMs -= 100;
  other.players[0].points = other.players[0].points.map(point => [point[0] + 100, ...point.slice(1)]);
  other.durationMs += 100;
  const before = await blockFiles(root), second = await upload(root, other, catalog);
  assert.deepEqual(await blockFiles(root), before);
  assert.deepEqual((await readStoredTrajectory(root, first.uploadId)).trajectory, validateTrajectory(base).trajectory);
  assert.deepEqual((await readStoredTrajectory(root, second.uploadId)).trajectory, validateTrajectory(other).trajectory);
}));

test("different run, player, map, difficulty or unproven clock never share identity blocks", async () => isolated(async ({ root, catalog }) => {
  const base = fixture(); await upload(root, base, catalog); let count = (await blockFiles(root)).length;
  for (const [index, mutate] of [
    raw => { raw.runKey = digest("other-run"); }, raw => { raw.players[0].key = digest("other-player"); },
    raw => { raw.map.scene = "Level_1"; }, raw => { raw.difficulty.ascent = 2; }, raw => { delete raw.timeOriginMs; },
  ].entries()) {
    const raw = fixture(`identity-${index}`); mutate(raw); const result = await upload(root, raw, catalog);
    assert.equal((await blockFiles(root)).length, count + 2); count += 2;
    assert.deepEqual((await readStoredTrajectory(root, result.uploadId)).trajectory, validateTrajectory(raw).trajectory);
  }
}));

test("partial attempts, death, revival, warp, gaps and distinct full attempts keep original events and inspection", async () => isolated(async ({ root, catalog }) => {
  const raw = fixture(); raw.players[0].events.push({ tMs: 9000, kind: "dead" }, { tMs: 23000, kind: "revive" },
    { tMs: 26000, kind: "warp" }, { tMs: 42000, kind: "break" });
  raw.players[0].points = raw.players[0].points.filter(point => point[0] < 50000 || point[0] > 54000);
  const result = await upload(root, raw, catalog), canonical = validateTrajectory(raw).trajectory;
  const inspection = await queryInspection(root, catalog, result.groupId, result.uploadId, 0);
  const expected = extractInspectionStage(canonical, canonical.players[0], canonical.map.stages[0]);
  assert.deepEqual(inspection.routes[0].points, expected.points); assert.deepEqual(inspection.routes[0].breaks, expected.breaks);
  assert.deepEqual((await readStoredTrajectory(root, result.uploadId)).trajectory.players[0].events, canonical.players[0].events);
  const separate = fixture("second-attempt"); separate.timeOriginMs += 200000;
  const second = await upload(root, separate, catalog);
  assert.notEqual(result.uploadId, second.uploadId); assert.equal((await loadIndex(root)).length, 2);
}));

test("damaged point/delta/base content and altered source ranges fail closed including pending auto-review", async () => isolated(async ({ root, catalog }) => {
  const raw = fixture(), first = await upload(root, raw, catalog), other = fixture("delta-damage");
  other.players[0].points = other.players[0].points.map((point, index) => [point[0],point[1] + index % 3,point[2],point[3]]);
  const second = await upload(root, other, catalog), files = await blockFiles(root);
  const deltaFile = (await Promise.all(files.map(async file => ({ file, value: await compressedJson(join(root, "point-blocks", file)) })))).find(item => item.value.version === 2);
  assert.ok(deltaFile);
  const hash = deltaFile.file.slice(0, -8), bytes = await readLogicalBytes(root, hash);
  const plainBaseHash = deltaFile.value.baseHash, baseBytes = await readLogicalBytes(root, plainBaseHash);
  deltaFile.value.baseHash = deltaFile.file.slice(0, -8);
  await writeLogicalBytes(root, hash, gzipSync(JSON.stringify(deltaFile.value)));
  await assert.rejects(() => readStoredTrajectory(root, second.uploadId), /delta|checksum/);
  await writeLogicalBytes(root, hash, bytes);
  // Even a different valid delta is not allowed to become the base of a chain.
  await writeLogicalBytes(root, plainBaseHash, bytes);
  await assert.rejects(() => readStoredTrajectory(root, second.uploadId), /delta|overlapping point pack/);
  await writeLogicalBytes(root, plainBaseHash, baseBytes);
  const baseObject = JSON.parse(gunzipSync(baseBytes).toString("utf8")); baseObject.points[0][1] += 7;
  await writeLogicalBytes(root, plainBaseHash, gzipSync(JSON.stringify(baseObject)));
  await assert.rejects(() => readStoredTrajectory(root, second.uploadId), /checksum/);
  await assert.rejects(() => upload(root, fixture("damaged-reuse"), catalog), /checksum/);
  await writeLogicalBytes(root, plainBaseHash, baseBytes);
  const entry = (await loadIndex(root)).find(value => value.id === second.uploadId);
  entry.moderationStatus = "pending"; delete entry.reviewedUtc; delete entry.reviewMethod;
  entry.routes[0].source.first += 1;
  await writeFile(join(root, "index", `${second.uploadId}.json`), JSON.stringify(entry));
  assert.equal((await autoApprovePending(root)).invalid, 1);
  const firstEntry = (await loadIndex(root)).find(value => value.id === first.uploadId);
  assert.deepEqual((await readStoredTrajectory(root, first.uploadId)).trajectory, validateTrajectory(raw).trajectory);
  await verifyStoredEntry(root, firstEntry);
  const missing = await logicalLocation(root, plainBaseHash); await rm(join(root, "point-blocks", `${missing.ref.packHash}.pack`));
  await assert.rejects(() => readStoredTrajectory(root, second.uploadId), /ENOENT/);
  await assert.rejects(() => upload(root, fixture("missing-base"), catalog), /base unavailable|ENOENT/);
}));

test("unreferenced block and base files count toward capacity", async () => isolated(async ({ root, catalog }) => {
  await mkdir(join(root, "point-blocks"), { recursive: true });
  const path = join(root, "point-blocks", "orphan.bin"), file = await open(path, "w"); await file.truncate(2 * 1024 * 1024 * 1024); await file.close();
  await assert.rejects(() => upload(root, fixture(), catalog), /capacity/);
  assert.deepEqual(await readdir(join(root, "uploads")), []);
}));

test("offline preparation preserves legacy IDs, moderation, semantic queries and source bytes with no live switch", async () => isolated(async ({ parent, root, catalog }) => {
  const firstRaw = fixture(), a = await upload(root, firstRaw, catalog), b = await upload(root, fixture("second-legacy"), catalog);
  await moderate(root, b.uploadId, "hidden");
  for (const entry of await loadIndex(root)) {
    const trajectory = (await readStoredTrajectory(root, entry.id)).trajectory;
    await writeFile(join(root, "uploads", `${entry.id}.json.gz`), gzipSync(JSON.stringify(trajectory)));
    for (let i = 0; i < entry.routes.length; i++) {
      const route = entry.routes[i], file = `${entry.id}-p0-s0-a${i}.json.gz`;
      await writeFile(join(root, "routes", file), gzipSync(JSON.stringify(sourceRoute(trajectory, route))));
      delete route.source; route.file = file;
    }
    delete entry.storageManifestSha256;
    delete entry.inspectionSources;
    await writeFile(join(root, "index", `${entry.id}.json`), JSON.stringify(entry));
  }
  const expected = await queryRoutes(root, catalog, a.groupId, 0), beforeIndex = await Promise.all((await loadIndex(root)).map(entry => readFile(join(root, "index", `${entry.id}.json`))));
  const destination = join(parent, "prepared"), result = await prepareTrajectoryStorage(root, destination);
  assert.equal(result.complete, true); assert.equal(result.uploadCount, 2); assert.equal(result.sourceUnchanged, true); assert.equal(result.liveSwitchPerformed, false);
  assert.deepEqual(await queryRoutes(destination, catalog, a.groupId, 0), expected);
  assert.deepEqual(await readdir(join(destination, "routes")), []);
  const originalIndex = await loadIndex(root), preparedIndex = await loadIndex(destination);
  for (let index = 0; index < originalIndex.length; index++) {
    const original = originalIndex[index], prepared = preparedIndex.find(entry => entry.id === original.id);
    assert.equal(prepared.moderationStatus, original.moderationStatus); assert.equal(prepared.receivedUtc, original.receivedUtc);
    assert.deepEqual(prepared.routes.map(route => route.id), original.routes.map(route => route.id));
    assert.deepEqual(await readFile(join(root, "index", `${original.id}.json`)), beforeIndex[index]);
  }
  await assert.rejects(() => prepareTrajectoryStorage(root, destination), /EEXIST/);
  await assert.rejects(() => prepareTrajectoryStorage(root, join(root, "nested")), /separate/);
  await assert.rejects(() => prepareTrajectoryStorage(root, join(root, "..prepared")), /separate/);
}));

test("a synchronized shifted range cannot pass source identity checks and manifest capacity is checked before writes", async () => isolated(async ({ root, catalog }) => {
  const result = await upload(root, fixture(), catalog), entry = (await loadIndex(root))[0], original = structuredClone(entry.routes[0]);
  entry.routes[0].source.first += 1; entry.routes[0].source.after += 1;
  await writeFile(join(root, "index", `${result.uploadId}.json`), JSON.stringify(entry));
  await assert.rejects(() => queryRoutes(root, catalog, result.groupId, 0), /unavailable/);
  const trajectory = (await readStoredTrajectory(root, result.uploadId)).trajectory;
  assert.throws(() => sourceRoute(trajectory, entry.routes[0]), /interval identity/);
  assert.throws(() => planTrajectoryStorage(trajectory, { maxManifestDecodedBytes: 100 }), /decoded capacity/);
  assert.throws(() => planTrajectoryStorage(trajectory, { maxManifestCompressedBytes: 100 }), /compressed capacity/);
  assert.deepEqual(sourceRoute(trajectory, original).points, extractStageRoutes(trajectory, trajectory.players[0], trajectory.map.stages[0]).routes[0].points);
}));

test("complete route reads only the approved player's needed blocks while complete audit still verifies every source block", async () => isolated(async ({ root, catalog }) => {
  const raw = fixture(); raw.map.stages[0].exitZCm = 40000;
  raw.players[0].events.push({ tMs: 40000, kind: "leave" });
  const result = await upload(root, raw, catalog), expected = await queryRoutes(root, catalog, result.groupId, 0);
  const entry = (await loadIndex(root))[0], team = teamIdentity(entry).id;
  const expectedInspection = await queryInspection(root, catalog, result.groupId, result.uploadId, 0), expectedTeam = await queryTeamRoutes(root, catalog, team, 0);
  const manifest = await compressedJson(join(root, "uploads", `${result.uploadId}.json.gz`)), last = manifest.trajectory.players[0].pointBlocks.at(-1);
  await writeLogicalBytes(root, last.hash, Buffer.from("damaged unrelated later block"));
  assert.deepEqual(await queryRoutes(root, catalog, result.groupId, 0), expected);
  assert.deepEqual(await queryInspection(root, catalog, result.groupId, result.uploadId, 0), expectedInspection);
  assert.deepEqual(await queryTeamRoutes(root, catalog, team, 0), expectedTeam);
  await assert.rejects(() => readStoredTrajectory(root, result.uploadId));
}));

test("scoped inspection source spans, breaks, completion and manifest identity are checksum-verified and bounded", async () => isolated(async ({ root, catalog }) => {
  const raw = fixture(); raw.players[0].events.push({ tMs: 10000, kind: "dead" }, { tMs: 15000, kind: "revive" }, { tMs: 17000, kind: "break" });
  const result = await upload(root, raw, catalog), entry = (await loadIndex(root))[0], path = join(root, "index", `${entry.id}.json`);
  const expected = await queryInspection(root, catalog, result.groupId, result.uploadId, 0), expectedTeam = await queryTeamRoutes(root, catalog, teamIdentity(entry).id, 0);
  assert.ok(entry.inspectionSources[0].source.spans.length > 1);
  assert.ok(!JSON.stringify(entry.inspectionSources).includes('"points":'), "inspection metadata stores no coordinates");
  for (const mutate of [
    source => { source.source.spans[0][0] += 1; source.pointCount -= 1; },
    source => { source.source.breaks = []; }, source => { source.completion = "unknown"; },
    source => { source.gameCompleted = !source.gameCompleted; }, source => { source.source.manifestSha256 = digest("wrong-manifest"); },
    source => { source.source.logicalSha256 = digest("wrong-logical-data"); },
  ]) {
    const changed = structuredClone(entry); mutate(changed.inspectionSources[0]); await writeFile(path, JSON.stringify(changed));
    await assert.rejects(() => queryInspection(root, catalog, result.groupId, result.uploadId, 0), /checksum|metadata|counts/);
  }
  await writeFile(path, JSON.stringify(entry));
  const restored = (await readStoredTrajectory(root, result.uploadId)).trajectory;
  assert.throws(() => makeInspectionSources(restored, entry.storageManifestSha256, { maxMetadataBytes: 100 }), /capacity/);
  const fallback = structuredClone(entry); delete fallback.inspectionSources; await writeFile(path, JSON.stringify(fallback));
  assert.deepEqual(await queryInspection(root, catalog, result.groupId, result.uploadId, 0), expected);
  assert.deepEqual(await queryTeamRoutes(root, catalog, teamIdentity(entry).id, 0), expectedTeam);
}));

test("unavailable legacy stage boundaries stay explicit rather than becoming invented scoped coordinates", async () => isolated(async ({ root, catalog }) => {
  const raw = fixture(); delete raw.map.stages[0].enterZCm; delete raw.map.stages[0].exitZCm; raw.players[0].events = [];
  const result = await upload(root, raw, catalog), entry = (await loadIndex(root))[0];
  assert.equal(entry.inspectionSources[0].available, false);
  await assert.rejects(() => queryInspection(root, catalog, result.groupId, result.uploadId, 0), /stage boundaries unavailable/);
  const team = await queryTeamRoutes(root, catalog, teamIdentity(entry).id, 0);
  assert.deepEqual(team.routes[0].points, []); assert.equal(team.routes[0].completion, "unknown");
}));
