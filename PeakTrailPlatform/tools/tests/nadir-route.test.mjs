import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { digest, validateTrajectory, extractStageRoutes, extractInspectionStage, playerNadirCompleted, playerSummitCompleted } from "../../server/trajectory-contract.mjs";
import { ingestUpload, moderate, listTeams, queryTeamRoutes, queryRoutes, verifyStoredEntry } from "../../server/trajectory-store.mjs";
import { prepareTrajectoryStorage } from "../prepare-trajectory-storage.mjs";

function fixture() {
  return { format: "trajectory-v1", recordingId: digest("nadir-recording"), runKey: digest("nadir-run"), timeOriginMs: 1000,
    startedUtc: "2026-10-21T00:00:00Z", durationMs: 2000, sampleHz: 10, coordinateUnit: "cm",
    map: { buildId: "25739797", scene: "Level_9", route: ["Shore", "Void"], stages: [
      { index: 0, name: "Shore", enterZCm: 0, exitZCm: 10000 }, { index: 1, name: "Void" }] },
    difficulty: { ascent: 0, custom: false, mini: false },
    players: [{ key: digest("nadir-player"), name: "天底玩家", owner: true, evidence: "native-state",
      points: Array.from({ length: 21 }, (_, i) => [i * 100, i * 10, 0, i < 5 ? i * 100 : 30000 + i * 50]),
      events: [{ tMs: 0, kind: "game-stage", stageIndex: 0 }, { tMs: 500, kind: "warp", stageIndex: 1 },
        { tMs: 500, kind: "game-stage", stageIndex: 1 }, { tMs: 500, kind: "nadir-entry", stageIndex: 1, positionCm: [50, 0, 30250] },
        { tMs: 1025, kind: "nadir-wall", stageIndex: 1, positionCm: [100, 0, 30500] },
        { tMs: 1025, kind: "nadir-chase", stageIndex: 1, positionCm: [100, 0, 30500] },
        { tMs: 2000, kind: "nadir", stageIndex: 1, positionCm: [200, 0, 31000] }] }] };
}
test("Nadir entry, same-frame phases and native individual ending remain distinct, lossless and stage scoped", () => {
  const raw = fixture(), { trajectory } = validateTrajectory(raw), player = trajectory.players[0];
  assert.equal(playerNadirCompleted(trajectory, player), true);
  assert.equal(playerSummitCompleted(trajectory, player), false);
  assert.deepEqual(player.events, raw.players[0].events);
  assert.equal(extractStageRoutes(trajectory, player, trajectory.map.stages[0]).routes.length, 0);
  assert.equal(extractStageRoutes(trajectory, player, trajectory.map.stages[1]).completion, "complete");
  assert.equal(extractInspectionStage(trajectory, player, trajectory.map.stages[1]).gameCompleted, true);
  for (const kind of ["nadir-entry", "nadir-wall", "nadir-chase", "nadir-ready"]) {
    const copy = structuredClone(raw); copy.players[0].events = copy.players[0].events.filter(event => event.kind !== "nadir");
    copy.players[0].events.push({ tMs: 2000, kind, stageIndex: 1 });
    const value = validateTrajectory(copy).trajectory;
    assert.equal(playerNadirCompleted(value, value.players[0]), false, kind);
  }
});
test("Nadir wins cannot turn a dead, warped, missing-entry or gapped path into complete heat", () => {
  for (const change of ["death", "warp", "gap", "entry", "inactive"]) {
    const raw = fixture(), player = raw.players[0];
    if (change === "death") player.events.splice(6, 0, { tMs: 1500, kind: "dead" }, { tMs: 1800, kind: "revive" });
    if (change === "warp") player.events.splice(6, 0, { tMs: 1500, kind: "warp" });
    if (change === "gap") player.points = player.points.filter(point => point[0] <= 500 || point[0] >= 2100);
    if (change === "entry") player.events = player.events.filter(event => event.kind !== "nadir-entry");
    if (change === "inactive") player.events.unshift({ tMs: 0, kind: "dead" });
    const value = validateTrajectory(raw).trajectory, actual = value.players[0];
    assert.equal(extractStageRoutes(value, actual, value.map.stages[1]).routes.length, 0, change);
    assert.equal(playerNadirCompleted(value, actual), change !== "inactive", change);
  }
  const raw = fixture(); raw.players[0].events.splice(6, 0, { tMs: 2000, kind: "dead" });
  const value = validateTrajectory(raw).trajectory;
  assert.equal(playerNadirCompleted(value, value.players[0]), false);
});
test("Nadir event contract rejects fabricated stages, legacy evidence and malformed marker coordinates", () => {
  for (const mutate of [raw => { raw.players[0].evidence = "legacy-unknown"; },
    raw => { raw.players[0].events.at(-1).stageIndex = 0; },
    raw => { raw.players[0].events.at(-1).positionCm = [1, 2]; },
    raw => { raw.players[0].events.at(-1).positionCm = [1, 2, NaN]; }]) {
    const raw = fixture(); mutate(raw); assert.throws(() => validateTrajectory(raw));
  }
});
test("delayed local native checkpoint seals an observed campfire path without inventing teammate progress", () => {
  const raw = fixture(); raw.durationMs = 2100;
  raw.map.route[1] = "Roots"; raw.map.stages[1] = { index: 1, name: "Roots", enterZCm: 10000, exitZCm: 20000 };
  raw.players[0].points = Array.from({ length: 22 }, (_, i) => [i * 100, 0, 0, i * 200]);
  raw.players[0].events = [{ tMs: 0, kind: "game-stage", stageIndex: 0 },
    { tMs: 1500, kind: "game-stage", stageIndex: 1 }, { tMs: 2000, kind: "native-checkpoint", stageIndex: 0, positionCm: [0, 0, 4000] }];
  let value = validateTrajectory(raw).trajectory;
  assert.equal(extractStageRoutes(value, value.players[0], value.map.stages[0]).completion, "complete");
  assert.equal(extractInspectionStage(value, value.players[0], value.map.stages[0]).gameCompleted, true);
  const absent = structuredClone(raw); absent.players[0].events.pop();
  value = validateTrajectory(absent).trajectory;
  assert.equal(extractStageRoutes(value, value.players[0], value.map.stages[0]).completion, "partial");
  const broken = structuredClone(raw); broken.players[0].events.splice(1, 0, { tMs: 1000, kind: "warp" });
  value = validateTrajectory(broken).trajectory;
  assert.equal(extractStageRoutes(value, value.players[0], value.map.stages[0]).completion, "partial");
  assert.equal(extractInspectionStage(value, value.players[0], value.map.stages[0]).gameCompleted, true);
  for (const mutate of [copy => { copy.players[0].owner = false; }, copy => { copy.players[0].evidence = "legacy-unknown"; },
    copy => { copy.map.route[0] = copy.map.stages[0].name = "Void"; }]) {
    const copy = structuredClone(raw); mutate(copy); assert.throws(() => validateTrajectory(copy));
  }
});
test("sealed prefixes survive restart, dedupe heat, retain milestone anchors and inherit a recording withdrawal", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-nadir-")), catalog = join(root, "absent-catalog.json");
  const post = raw => ingestUpload(root, gzipSync(JSON.stringify(raw)), catalog);
  try {
    const raw = fixture(), first = await post(raw);
    const longer = structuredClone(raw); longer.durationMs = 2100; longer.players[0].points.push([2100, 210, 0, 31050]);
    const second = await post(longer); assert.notEqual(first.uploadId, second.uploadId);
    assert.equal((await post(longer)).duplicate, true);
    const team = (await listTeams(root)).teams[0];
    assert.equal(team.nadirCompleted, true); assert.equal(team.summitCompleted, false);
    assert.deepEqual(team.nadirFinisherKeys, [raw.players[0].key]);
    const view = await queryTeamRoutes(root, catalog, team.id, 1);
    assert.equal(view.nadirCompleted, true); assert.equal(view.routes[0].nadirCompleted, true);
    assert.equal(view.routes[0].milestones.filter(event => event.tMs === 1025).length, 2);
    assert.deepEqual(view.routes[0].milestones.at(-1).positionCm, [200, 0, 31000]);
    const heat = await queryRoutes(root, catalog, first.groupId, 1, "", 200, true);
    assert.equal(heat.routeCount, 1);
    const entry = JSON.parse(await readFile(join(root, "index", `${second.uploadId}.json`), "utf8"));
    await verifyStoredEntry(root, entry);
    await moderate(root, first.uploadId, "hidden"); await moderate(root, second.uploadId, "hidden");
    const newest = structuredClone(longer); newest.durationMs = 2200; newest.players[0].points.push([2200, 220, 0, 31100]);
    assert.equal((await post(newest)).moderationStatus, "hidden");
    assert.deepEqual((await listTeams(root)).teams, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("trajectory-only offline preparation refuses to omit a durable live archive before creating a destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-archive-migration-"));
  try {
    const source = join(root, "source"), destination = join(root, "prepared");
    await mkdir(join(source, "live-archive"), { recursive: true });
    await writeFile(join(source, "live-archive", "retained.ndjson"), "private durable route\n");
    await assert.rejects(prepareTrajectoryStorage(source, destination), /live archives require a complete separate backup/);
    await assert.rejects(stat(destination), { code: "ENOENT" });
    assert.equal(await readFile(join(source, "live-archive", "retained.ndjson"), "utf8"), "private durable route\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("a terminal sealed prefix wins when the final milestone shares the previous sampling bucket", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-terminal-prefix-")), catalog = join(root, "missing.json");
  try {
    const raw = fixture(); raw.durationMs = 1950; raw.players[0].points.pop();
    raw.players[0].events.pop();
    await ingestUpload(root, gzipSync(JSON.stringify(raw)), catalog);
    const finished = structuredClone(raw); finished.players[0].events.push({ tMs: 1950, kind: "nadir", stageIndex: 1, positionCm: [195, 0, 30975] });
    const receipt = await ingestUpload(root, gzipSync(JSON.stringify(finished)), catalog);
    const team = (await listTeams(root)).teams[0], view = await queryTeamRoutes(root, catalog, team.id, 1);
    assert.equal(view.routes[0].uploadId, receipt.uploadId);
    assert.equal(view.routes[0].nadirCompleted, true);
    assert.equal(view.routes[0].milestones.at(-1).kind, "nadir");
  } finally { await rm(root, { recursive: true, force: true }); }
});
