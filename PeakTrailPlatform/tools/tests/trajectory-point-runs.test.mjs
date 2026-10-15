import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { encodePointRuns, encodeTrajectoryPointRuns, decodeTrajectoryPointRuns, MAX_EXPANDED_POINTS } from "../../server/trajectory-point-runs.mjs";
import { validateTrajectory, digest, groupId, aggregateHeatmap, extractStageRoutes, extractInspectionStage, playerSummitCompleted } from "../../server/trajectory-contract.mjs";

function fixture() {
  return { format: "trajectory-v1", recordingId: "a".repeat(64), runKey: "b".repeat(64), timeOriginMs: -17,
    startedUtc: "2026-10-15T00:00:00Z", durationMs: 5200, sampleHz: 10, coordinateUnit: "cm",
    map: { buildId: 25306743, scene: "Level_0", route: ["Shore", "Roots"], stages: [
      { index: 0, name: "Shore", enterZCm: 0, exitZCm: 1000 }, { index: 1, name: "Roots", enterZCm: 1000, exitZCm: 2000 }] },
    difficulty: { ascent: 3, custom: false, mini: false }, players: [{ key: "c".repeat(64), name: "Synthetic stationary scout", owner: true, evidence: "native-state",
      points: [17, 128, 239, 350, 453, 553, 675, 2500, 2611, 2722, 2833, 5000, 5100, 5200]
        .map(time => [time, 10, 20, time < 2500 ? 0 : time < 5000 ? 900 : 2000]),
      events: [{ tMs: 17, kind: "join" }, { tMs: 17, kind: "game-stage", stageIndex: 0 },
        { tMs: 453, kind: "leave" }, { tMs: 553, kind: "join" }, { tMs: 675, kind: "dead" }, { tMs: 675, kind: "break" },
        { tMs: 2500, kind: "revive" }, { tMs: 2611, kind: "warp" }, { tMs: 2833, kind: "game-stage", stageIndex: 1 },
        { tMs: 2833, kind: "checkpoint", stageIndex: 0 }, { tMs: 5200, kind: "finish", stageIndex: 1 }, { tMs: 5200, kind: "summit", stageIndex: 1 }] }] };
}

function equivalent(v1, v2) {
  const first = validateTrajectory(v1), second = validateTrajectory(v2);
  assert.deepEqual(second, first);
  assert.equal(second.trajectory.format, "trajectory-v1");
  assert.equal(digest(JSON.stringify(second.trajectory)), digest(JSON.stringify(first.trajectory)));
  assert.equal(groupId(second.trajectory.map), groupId(first.trajectory.map));
  assert.deepEqual(aggregateHeatmap(second.trajectory.players.map(player => player.points)), aggregateHeatmap(first.trajectory.players.map(player => player.points)));
  for (let index = 0; index < first.trajectory.players.length; index++) {
    const a = first.trajectory.players[index], b = second.trajectory.players[index];
    assert.equal(playerSummitCompleted(second.trajectory, b), playerSummitCompleted(first.trajectory, a));
    for (const stage of first.trajectory.map.stages) {
      assert.deepEqual(extractStageRoutes(second.trajectory, b, stage), extractStageRoutes(first.trajectory, a, stage));
      assert.deepEqual(extractInspectionStage(second.trajectory, b, stage), extractInspectionStage(first.trajectory, a, stage));
    }
  }
  return second;
}

test("stationary golden wire stores exact irregular sample times, coordinates and a real gap", () => {
  const points = [17, 128, 239, 350, 453, 553, 675, 2500, 2600, 2700].map(time => [time, 1, 2, time < 2500 ? 3 : 4]);
  const encoded = encodePointRuns(points);
  assert.deepEqual(encoded, [[17, 1, 2, 3, 111, 4], [453, 1, 2, 3], [553, 1, 2, 3], [675, 1, 2, 3], [2500, 1, 2, 4, 100, 3]]);
  assert.deepEqual(decodeTrajectoryPointRuns(encoded, { durationMs: 2700 }), points);
});

test("v1 and v2 retain canonical upload identity, every event, heatmaps, stage results and native completion", () => {
  const source = fixture(), before = structuredClone(source), wire = encodeTrajectoryPointRuns(source);
  assert.equal(wire.format, "trajectory-v2");
  assert.ok(wire.players[0].points.some(point => point.length === 6));
  equivalent(source, wire);
  assert.deepEqual(source, before);
  assert.deepEqual(wire.players[0].events, source.players[0].events);
  assert.deepEqual(new Set(wire.players[0].events.map(event => event.kind)), new Set(["join", "leave", "dead", "break", "revive", "warp", "game-stage", "checkpoint", "finish", "summit"]));
});

test("three-minute stationary interval expands all samples and never becomes a false 1.5-second disconnect", () => {
  const source = fixture(); source.durationMs = 180000;
  source.players[0].points = Array.from({ length: 1801 }, (_, index) => [index * 100, 1, 2, 100]);
  source.players[0].events = [{ tMs: 0, kind: "join" }, { tMs: 0, kind: "game-stage", stageIndex: 0 }];
  const wire = encodeTrajectoryPointRuns(source);
  assert.deepEqual(wire.players[0].points, [[0, 1, 2, 100, 100, 1801]]);
  assert.ok(JSON.stringify(wire).length < JSON.stringify(source).length / 10);
  const { trajectory, totalPoints } = equivalent(source, wire);
  assert.equal(totalPoints, 1801);
  const inspection = extractInspectionStage(trajectory, trajectory.players[0], trajectory.map.stages[0]);
  assert.equal(inspection.points.length, 1801);
  assert.deepEqual(inspection.breaks, [0]); // The actual initial join remains; no later false gap is added.
});

test("same-bucket terminal death timestamp survives run encoding rather than snapping to a 100ms tick", () => {
  const source = fixture(); source.durationMs = 300;
  source.players[0].points = [[75, 1, 2, 100], [100, 1, 2, 100], [200, 1, 2, 100], [300, 1, 2, 100]];
  source.players[0].events = [{ tMs: 0, kind: "join" }, { tMs: 0, kind: "game-stage", stageIndex: 0 },
    { tMs: 75, kind: "dead" }, { tMs: 75, kind: "break" }, { tMs: 100, kind: "revive" }];
  const { trajectory } = equivalent(source, encodeTrajectoryPointRuns(source));
  assert.equal(trajectory.players[0].points[0][0], 75);
  assert.ok(extractInspectionStage(trajectory, trajectory.players[0], trajectory.map.stages[0]).points.some(point => point[0] === 75));
});

test("sparse stationary observations retain their real gaps instead of inventing 10Hz continuity", () => {
  const source = fixture(); source.durationMs = 4000;
  source.players[0].points = [[0, 1, 2, 100], [2000, 1, 2, 100], [4000, 1, 2, 100]];
  source.players[0].events = [{ tMs: 0, kind: "game-stage", stageIndex: 0 }];
  const { trajectory } = equivalent(source, encodeTrajectoryPointRuns(source));
  const inspection = extractInspectionStage(trajectory, trajectory.players[0], trajectory.map.stages[0]);
  assert.deepEqual(inspection.points.map(point => point[0]), [0, 2000, 4000]);
  assert.deepEqual(inspection.breaks, [2000, 4000]);
});

test("pure point codec losslessly covers moving, stationary, irregular and sparse deterministic routes", () => {
  let state = 12345, time = 17, position = [1, 2, 3];
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const points = [];
  for (let index = 0; index < 5000; index++) {
    if (random() % 7 === 0) position = [random() % 1000 - 500, random() % 1000 - 500, random() % 1000 - 500];
    points.push([time, ...position]);
    time += [100, 111, 237, 2000][random() % 4];
  }
  assert.deepEqual(decodeTrajectoryPointRuns(encodePointRuns(points), { durationMs: time }), points);
  assert.deepEqual(encodePointRuns([]), []);
  assert.deepEqual(decodeTrajectoryPointRuns([], { durationMs: 0 }), []);
});

test("strict v2 whitelist retains old v1 semantics and rejects mixed point encodings under v1", () => {
  const raw = fixture(), wire = encodeTrajectoryPointRuns(raw);
  wire.format = "trajectory-v1";
  assert.throws(() => validateTrajectory(wire), /point:/);
  const invalid = encodeTrajectoryPointRuns(raw); invalid.players[0].pointRuns = [];
  assert.throws(() => validateTrajectory(invalid), /unexpected field/);
  const future = fixture(); future.format = "trajectory-v3";
  assert.throws(() => validateTrajectory(future), /unsupported/);
});

test("point-run rejects malformed shape, non-integer values, invalid coordinates and invalid temporal math", () => {
  const invalid = [null, {}, [0, 1], [0, 1, 2, 3, 100], [0, 1, 2, 3, 100, 3, 0],
    [0, 1, 2, 3, 0, 3], [0, 1, 2, 3, -100, 3], [0, 1, 2, 3, 100.5, 3],
    [0, 1, 2, 3, 100, 2], [0, 1, 2, 3, 100, 3.5], [0, 1, 2, 3, 100, NaN],
    [0, 100_000_001, 2, 3], [0, 1, -100_000_001, 3], [0, 1, 2, 3, 100, Infinity],
    [901, 1, 2, 3, 100, 3], [-1, 1, 2, 3], [1001, 1, 2, 3]];
  for (const entry of invalid) assert.throws(() => decodeTrajectoryPointRuns([entry], { durationMs: 1000 }), error => error.statusCode === 400);
});

test("ordered point validation checks both inside a run and across run boundaries", () => {
  for (const entries of [ [[0, 1, 2, 3, 50, 3]], [[0, 1, 2, 3, 100, 3], [200, 1, 2, 3]],
    [[0, 1, 2, 3, 100, 3], [150, 1, 2, 3]], [[0, 1, 2, 3, 100, 3], [250, 1, 2, 3]] ]) {
    assert.throws(() => decodeTrajectoryPointRuns(entries, { durationMs: 1000 }), /ordered|bucket/);
  }
});

test("tiny oversized runs are rejected before expansion and player budgets accumulate across one package", () => {
  for (const count of [144002, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => decodeTrajectoryPointRuns([[0, 1, 2, 3, 100, count]], { durationMs: 14400000 }), error => error.statusCode === 413);
  }
  const budget = { points: 0, maxPoints: 5 };
  assert.equal(decodeTrajectoryPointRuns([[0, 1, 2, 3, 100, 3]], { durationMs: 300, budget }).length, 3);
  assert.equal(budget.points, 3);
  assert.throws(() => decodeTrajectoryPointRuns([[0, 1, 2, 3, 100, 3]], { durationMs: 300, budget }), error => error.statusCode === 413);
  assert.equal(budget.points, 3);
  assert.equal(MAX_EXPANDED_POINTS, 932067);
});

test("internal relative storage windows can defer bucket checks but wire validation never does", () => {
  const points = [[0, 1, 2, 3], [90, 1, 2, 3], [190, 1, 2, 3]];
  assert.throws(() => decodeTrajectoryPointRuns(points, { durationMs: 59999, maxPoints: 601 }), /bucket/);
  assert.deepEqual(decodeTrajectoryPointRuns(points, { durationMs: 59999, maxPoints: 601, checkBuckets: false }), points);
  const invalid = fixture(); invalid.format = "trajectory-v2"; invalid.players[0].points = points;
  assert.throws(() => validateTrajectory(invalid), /bucket/);
});

test("C# exported v2 fixture has the identical Node canonical SHA, heatmap, events and stage behavior", {
  skip: !process.env.PEAK_POINT_RUN_FIXTURE_DIR && "Set PEAK_POINT_RUN_FIXTURE_DIR to the synthetic C# --point-run-fixture-dir output for the cross-runtime check",
}, async () => {
  const root = process.env.PEAK_POINT_RUN_FIXTURE_DIR;
  const source = JSON.parse(await readFile(join(root, "canonical-v1.json"), "utf8"));
  const wire = JSON.parse(await readFile(join(root, "wire-v2.json"), "utf8"));
  assert.deepEqual(wire, encodeTrajectoryPointRuns(source));
  equivalent(source, wire);
});
