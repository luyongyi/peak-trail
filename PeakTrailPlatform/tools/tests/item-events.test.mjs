import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { digest, validateTrajectory, ITEM_EVENT_LIMITS } from "../../server/trajectory-contract.mjs";
import { ingestUpload, listTeams, queryTeamItemEvents, queryRoutes, moderate, verifyStoredEntry } from "../../server/trajectory-store.mjs";
import { readStoredTrajectory, createReferencedRouteReader } from "../../server/trajectory-storage.mjs";
import { createLiveServer } from "../../server/live-server.mjs";
import { prepareTrajectoryStorage } from "../prepare-trajectory-storage.mjs";

function fixture() {
  return { format: "trajectory-v1", recordingId: digest("item-recording"), runKey: digest("item-run"), timeOriginMs: 1000,
    startedUtc: "2026-10-23T00:00:00Z", durationMs: 2000, sampleHz: 10, coordinateUnit: "cm",
    map: { buildId: "25739797", scene: "Level_0", route: ["Shore", "Roots"],
      stages: [{ index: 0, name: "Shore", enterZCm: 0, exitZCm: 1000 }, { index: 1, name: "Roots", enterZCm: 1000, exitZCm: 2000 }],
      alignment: { version: 1, coordinateSpace: "unity-world-cm", landmarks: [
        { key: "progress-point:0", kind: "progress-point", stageIndex: 0, name: "Entry", positionCm: [0, 0, 0] },
        { key: "progress-point:1", kind: "progress-point", stageIndex: 1, name: "Roots", positionCm: [1000, 1000, 1000] },
        { key: "progress-point:peak", kind: "progress-point", name: "Peak", positionCm: [0, 1000, 2000] }] } },
    difficulty: { ascent: 1, custom: false, mini: false }, players: [{ key: digest("item-player"), name: "Scout", owner: true, evidence: "native-state",
      points: Array.from({ length: 21 }, (_, i) => [i * 100, 0, 0, i * 100]), events: [] }] };
}
function event(n, extra = {}) {
  return { id: digest(`item-${n}`), actionId: digest("action"), kind: n === 0 ? "item-use" : "item-spawn",
    tMs: n, stageIndex: 0, positionCm: [n, 200, 300], item: { itemId: 7, name: "Campfire", prefabName: "Campfire" }, ...extra };
}
async function isolated(t, { http = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "peak-items-")), catalog = join(root, "catalog.json");
  const mapPackId = `sha256-${digest("item-map")}`, sourceSceneSha256 = digest("item-scene");
  await mkdir(join(root, "packs", mapPackId), { recursive: true });
  await writeFile(join(root, "packs", mapPackId, "map-pack.json"), JSON.stringify({ mapPackId, gameBuildId: "25739797", sceneName: "Level_0",
    coordinateSpace: "unity-world-meters", source: { sceneSha256: sourceSceneSha256 } }));
  await writeFile(join(root, "landmarks.25739797.json"), JSON.stringify({ schemaVersion: 1, gameBuildId: "25739797", authority: "serialized-map-landmarks",
    sourceGameAssemblyMvid: "a".repeat(32), sourceGameAssemblySha256: digest("assembly"), maps: [{ sceneName: "Level_0", mapPackId, sourceSceneSha256, alignment: fixture().map.alignment }] }));
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, mapPacks: [{ gameBuildId: "25739797", sceneName: "Level_0", mapPackId,
    path: `./packs/${mapPackId}/map-pack.json`, route: fixture().map.route, enabled: true }] }));
  let live, base;
  if (http) { live = createLiveServer({ trajectoryDir: root, catalogPath: catalog }); await new Promise(done => live.server.listen(0, "127.0.0.1", done)); base = `http://127.0.0.1:${live.server.address().port}`; }
  t.after(async () => { if (live) { live.server.closeAllConnections(); await new Promise(done => live.server.close(done)); await live.liveV2.close(); }
    await rm(root, { recursive: true, force: true }); });
  const post = raw => ingestUpload(root, gzipSync(JSON.stringify(raw)), catalog);
  const team = async () => (await listTeams(root)).teams[0];
  const get = async path => { const response = await fetch(base + path); return { status: response.status, body: await response.json() }; };
  return { root, catalog, post, team, get, base };
}

test("optional item events preserve the old canonical identity and accept only the two explicit states", () => {
  const raw = fixture(), old = validateTrajectory(raw).trajectory;
  assert.equal(Object.hasOwn(old, "itemEvents"), false);
  // Golden hash from the 7dd1448 validator before itemEvents existed.
  assert.equal(digest(JSON.stringify(old)), "51ebd3e07f3d01baee269284c26341c186077e7a451d640310f0afdaa3e30eaa");
  raw.itemEvents = [event(1), event(0, { playerKey: raw.players[0].key })];
  const next = validateTrajectory(raw).trajectory;
  assert.deepEqual(next.itemEvents, [raw.itemEvents[1], raw.itemEvents[0]]);
  assert.deepEqual(next.players, old.players); assert.deepEqual(next.map, old.map);
  assert.notEqual(digest(JSON.stringify(next)), digest(JSON.stringify(old)));
  assert.equal(Object.hasOwn(next.itemEvents[1], "playerKey"), false);
  raw.itemEvents = [event(0, { item: { prefabName: "OnlyPrefab" } })]; assert.equal(validateTrajectory(raw).trajectory.itemEvents.length, 1);
});

test("item contract rejects unknown fields, unstable identities, bad positions, references, duplicates and excess", () => {
  for (const mutate of [e => { e.id = "bad"; }, e => { e.actionId = "bad"; }, e => { e.kind = "item-impact"; },
    e => { e.tMs = 2001; }, e => { e.tMs = 1.5; }, e => { e.stageIndex = 2; }, e => { e.playerKey = digest("stranger"); },
    e => { e.positionCm = [1, 2]; }, e => { e.positionCm[0] = 0.1; }, e => { e.positionCm[0] = 100_000_001; },
    e => { e.item.itemId = -1; }, e => { e.item.itemId = "7"; }, e => { e.item.name = "x".repeat(101); },
    e => { e.item.prefabName = "\nunsafe"; }, e => { e.item.instanceId = "secret"; }, e => { e.item = { name: "NoIdentity" }; },
    e => { e.rotation = [0, 0, 0, 1]; }, e => { e.world = {}; }]) {
    const raw = fixture(); raw.itemEvents = [event(0)]; mutate(raw.itemEvents[0]); assert.throws(() => validateTrajectory(raw));
  }
  const raw = fixture(); raw.itemEvents = [event(0), event(0)]; assert.throws(() => validateTrajectory(raw), /unique SHA256/);
  raw.itemEvents = Array.from({ length: 4097 }, (_, n) => event(n % 2000, { id: digest(`over-${n}`) }));
  assert.throws(() => validateTrajectory(raw), /itemEvents: invalid array/);
});

test("item events survive durable storage, verification and offline preparation without changing route or heat counts", async t => {
  const f = await isolated(t), raw = fixture(), old = await f.post(raw);
  const heatBefore = await queryRoutes(f.root, f.catalog, old.groupId, 0, "", 200, true);
  raw.itemEvents = [event(0), event(1)]; const posted = await f.post(raw);
  assert.equal((await f.post(raw)).duplicate, true);
  const stored = await readStoredTrajectory(f.root, posted.uploadId);
  assert.deepEqual(stored.trajectory.itemEvents, raw.itemEvents);
  const entry = JSON.parse(await readFile(join(f.root, "index", `${posted.uploadId}.json`), "utf8")); await verifyStoredEntry(f.root, entry);
  assert.deepEqual(await queryRoutes(f.root, f.catalog, old.groupId, 0, "", 200, true), heatBefore);
  const target = await mkdtemp(join(tmpdir(), "peak-items-prepare-")), destination = join(target, "prepared");
  t.after(() => rm(target, { recursive: true, force: true }));
  await prepareTrajectoryStorage(f.root, destination);
  assert.deepEqual((await readStoredTrajectory(destination, posted.uploadId)).trajectory.itemEvents, raw.itemEvents);
  const view = await queryTeamItemEvents(f.root, f.catalog, (await f.team()).id, 0);
  assert.equal(view.events.length, 2); assert.equal(view.truncated, false); assert.equal(view.nextCursor, null);
});

test("all approved observations contribute exact IDs; repeated prefixes dedupe, conflicting IDs fail closed and withdrawal is immediate", async t => {
  const f = await isolated(t), raw = fixture(); raw.itemEvents = [event(0, { playerKey: raw.players[0].key })]; const first = await f.post(raw);
  const longer = structuredClone(raw); longer.durationMs = 2100; longer.itemEvents.push(event(1)); const second = await f.post(longer);
  const observer = fixture(); observer.recordingId = digest("other-observer"); observer.players[0].owner = false;
  observer.itemEvents = [event(2)]; const third = await f.post(observer);
  const team = await f.team(); const initial = await queryTeamItemEvents(f.root, f.catalog, team.id, 0);
  assert.equal(initial.events.length, 3); assert.equal(initial.events.find(e => e.id === event(0).id).playerName, "Scout");
  assert.equal(Object.hasOwn(initial.events.find(e => e.id === event(2).id), "playerName"), false);
  await moderate(f.root, second.uploadId, "hidden");
  const hidden = await queryTeamItemEvents(f.root, f.catalog, team.id, 0); assert.equal(hidden.events.length, 2); assert.notEqual(hidden.teamRevision, initial.teamRevision);
  const conflict = fixture(); conflict.recordingId = digest("conflict"); conflict.itemEvents = [event(0, { positionCm: [99, 2, 3] })];
  const bad = await f.post(conflict); await assert.rejects(queryTeamItemEvents(f.root, f.catalog, team.id, 0), /conflicting item event sources/);
  await moderate(f.root, bad.uploadId, "rejected"); assert.equal((await queryTeamItemEvents(f.root, f.catalog, team.id, 0)).events.length, 2);
  await moderate(f.root, first.uploadId, "hidden"); await moderate(f.root, third.uploadId, "hidden");
  await assert.rejects(queryTeamItemEvents(f.root, f.catalog, team.id, 0), { statusCode: 404 });
  longer.durationMs = 2200; assert.equal((await f.post(longer)).moderationStatus, "hidden");
});

test("selected-member reads retain other item owners without expanding their coordinates", async t => {
  const f = await isolated(t), raw = fixture();
  raw.players.push({ ...structuredClone(raw.players[0]), key: digest("other-item-owner"), name: "Other", owner: false });
  raw.itemEvents = [event(0, { playerKey: raw.players[1].key })];
  const upload = await f.post(raw), entry = JSON.parse(await readFile(join(f.root, "index", `${upload.uploadId}.json`), "utf8"));
  const selected = await createReferencedRouteReader(f.root).player(entry, raw.players[0].key);
  assert.deepEqual(selected.points, raw.players[0].points); assert.equal(selected.key, raw.players[0].key);
  const page = await queryTeamItemEvents(f.root, f.catalog, (await f.team()).id, 0);
  assert.equal(page.events[0].playerName, "Other");
});

test("HTTP item pages use the exact route alignment, preserve original archives, separate stages and leave unmatched coordinates raw", async t => {
  const f = await isolated(t, { http: true }), raw = fixture(), offset = [2300, -600, 7400];
  for (const point of raw.players[0].points) for (let axis = 0; axis < 3; axis++) point[axis + 1] += offset[axis];
  for (const mark of raw.map.alignment.landmarks) mark.positionCm = mark.positionCm.map((value, axis) => value + offset[axis]);
  for (const stage of raw.map.stages) { stage.enterZCm += offset[2]; stage.exitZCm += offset[2]; }
  raw.itemEvents = [event(0, { positionCm: [2400, -400, 7700] }), event(1, { stageIndex: 1 })];
  const response = await fetch(f.base + "/api/route-uploads", { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: gzipSync(JSON.stringify(raw)) });
  assert.equal(response.status, 201); const upload = await response.json(), team = await f.team();
  const path = `/api/route-teams/${team.id}/stages/0/item-events`, view = await f.get(path);
  assert.equal(view.status, 200); assert.equal(view.body.coordinateSpace, "canonical-map-world-cm"); assert.equal(view.body.events.length, 1);
  assert.deepEqual(view.body.events[0].positionCm, [100, 200, 300]);
  assert.deepEqual((await readStoredTrajectory(f.root, upload.uploadId)).trajectory.itemEvents[0].positionCm, [2400, -400, 7700]);
  assert.equal((await f.get(`/api/route-teams/${team.id}/stages/1/item-events`)).body.events.length, 1);
  assert.equal((await f.get(path + "?cursor=bad")).status, 400);
  assert.equal((await f.get(`/api/route-teams/${team.id}/stages/7/item-events`)).status, 404);
  await writeFile(f.catalog, JSON.stringify({ schemaVersion: 1, mapPacks: [] }));
  const unmatched = await f.get(path); assert.equal(unmatched.body.coordinateSpace, "recording-world-cm");
  assert.deepEqual(unmatched.body.events[0].positionCm, [2400, -400, 7700]);
  await moderate(f.root, upload.uploadId, "hidden"); assert.equal((await f.get(path)).status, 404);
});

test("item pagination follows every event under both count and byte budgets without silent truncation", async t => {
  const f = await isolated(t), raw = fixture(); raw.players[0].name = "队".repeat(100);
  raw.itemEvents = Array.from({ length: 900 }, (_, n) => event(n, { playerKey: raw.players[0].key,
    item: { itemId: 7, name: "名".repeat(100), prefabName: "物".repeat(100) } }));
  await f.post(raw); const team = await f.team(), ids = [], counts = []; let cursor = "", revision;
  do {
    const page = await queryTeamItemEvents(f.root, f.catalog, team.id, 0, { cursor });
    assert.equal(page.truncated, false); assert.ok(page.events.length <= ITEM_EVENT_LIMITS.pageCount);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= ITEM_EVENT_LIMITS.pageBytes);
    revision ??= page.teamRevision; assert.equal(page.teamRevision, revision);
    ids.push(...page.events.map(e => e.id)); counts.push(page.events.length); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 900); assert.equal(new Set(ids).size, 900); assert.deepEqual(ids, [...ids].sort());
  assert.ok(counts[0] < 512, "large Unicode fields trigger the byte budget first");
  await assert.rejects(queryTeamItemEvents(f.root, f.catalog, team.id, 0, { cursor: digest("unknown") }), /unknown item event page cursor/);
});

test("damaged durable item manifest cannot bypass its approved checksum", async t => {
  const f = await isolated(t), raw = fixture(); raw.itemEvents = [event(0)]; const upload = await f.post(raw), team = await f.team();
  const path = join(f.root, "uploads", `${upload.uploadId}.json.gz`), stored = JSON.parse(gunzipSync(await readFile(path)));
  stored.trajectory.itemEvents[0].item.name = "changed"; await writeFile(path, gzipSync(JSON.stringify(stored)));
  await assert.rejects(queryTeamItemEvents(f.root, f.catalog, team.id, 0), /stored item events unavailable/);
});
