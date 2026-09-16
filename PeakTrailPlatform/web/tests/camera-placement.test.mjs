import assert from "node:assert/strict";
import test from "node:test";
import { chooseRecordedInteriorPose, isInteriorLayer } from "../src/camera-placement.js";

const bounds = { min: [0, 100, 200], max: [50, 150, 250] };
const layer = { segment: 4, biome: "Swamp", minX: 0, maxX: 50, minY: 100, maxY: 150, minZ: 200, maxZ: 250 };
const sample = (t, pos = [20, 110, 220], extra = {}) => ({ t, pos, yaw: 42, ...extra });
const trace = (tracks, events = []) => ({ tracks: new Map(Object.entries(tracks)), events, manifest: { sampleHz: 5 } });

test("exact serialized roots distinguish enclosed endings from outdoor branches", () => {
  for (const name of ["Temple_Segment", "Volcano_Segment", "Temple_Segment(Clone)"]) {
    assert.equal(isInteriorLayer({ name }), true, name);
  }
  for (const name of ["Caldera_Segment", "Swamp_Segment", "Temple", "Volcano", "Swamp", "Temple_Segment_Statue"]) {
    assert.equal(isInteriorLayer({ name }), false, name);
  }
  assert.equal(isInteriorLayer({ sourcePath: "Level_17/Map/Temple_Segment/Geometry" }), true);
  assert.equal(isInteriorLayer({ source: { rootName: "Volcano_Segment" } }), true);
  assert.equal(isInteriorLayer({ root: "Level_0\\Caldera_Segment" }), false);
  assert.equal(isInteriorLayer(null), false);
});

test("known route and final chapter disambiguate legacy repeated biome labels", () => {
  const swamp = { branch: "swamp-temple", segments: [
    { index: 3, biome: "Swamp", name: "source-root" }, { index: 4, biome: "Swamp", name: "source-root" },
  ] };
  const volcano = { branch: "volcano-kiln", segments: [
    { index: 3, biome: "Volcano", name: "Caldera_Segment" }, { index: 4, biome: "Volcano", name: "Volcano_Segment" },
  ] };
  assert.equal(isInteriorLayer(layer, swamp), true);
  assert.equal(isInteriorLayer({ ...layer, segment: 3 }, swamp), false);
  assert.equal(isInteriorLayer({ segment: 4, biome: "Volcano" }, volcano), true);
  assert.equal(isInteriorLayer({ segment: 3, biome: "Volcano" }, volcano), false);
  assert.equal(isInteriorLayer(layer, { ...swamp, branch: "unknown" }), false);
  assert.equal(isInteriorLayer(layer), false);
  assert.equal(isInteriorLayer({ ...layer, name: "Swamp_Segment" }, swamp), false);
  assert.equal(isInteriorLayer({ ...layer, biome: "Volcano" }, swamp), false);
});

test("current pose is exact recorded XYZ and yaw, not an interpolated future position", () => {
  const value = trace({ p: [sample(2), sample(10, [30, 120, 230], { yaw: 90 })] });
  assert.deepEqual(chooseRecordedInteriorPose(value, 5, layer), { pos: [20, 110, 220], yaw: 42, t: 2, playerId: "p" });
  assert.deepEqual(chooseRecordedInteriorPose(value, 10, bounds), { pos: [30, 120, 230], yaw: 90, t: 10, playerId: "p" });
});

test("scrubbing before the first interior visit never uses future positions", () => {
  const value = trace({ p: [sample(0, [-1, 110, 220]), sample(10)] });
  assert.equal(chooseRecordedInteriorPose(value, 9.99, bounds), null);
  assert.equal(chooseRecordedInteriorPose(value, -10, bounds), null);
  assert.equal(chooseRecordedInteriorPose(trace({ p: [sample(50)] }), 0, bounds), null);
});

test("global activeSegment and assigned segment never substitute for actual bounds", () => {
  const value = trace({ p: [sample(2, [500, 500, 500], { activeSegment: 4, segment: 4 })],
    q: [sample(1, [20, 110, 220], { activeSegment: 0, segment: null })] });
  assert.equal(chooseRecordedInteriorPose(value, 2, layer).playerId, "q");
  assert.equal(chooseRecordedInteriorPose(trace({ p: value.tracks.get("p") }), 2, layer), null);
});

test("current alive player takes priority over a later dead player's historical sample", () => {
  const value = trace({ living: [sample(9.5)], dead: [sample(9.9)] }, [{ type: "death", t: 10, playerId: "dead" }]);
  assert.equal(chooseRecordedInteriorPose(value, 10, bounds).playerId, "living");
  assert.equal(chooseRecordedInteriorPose(value, 10, bounds, { preferredPlayerId: "dead" }).playerId, "living");
});

test("hidden players do not take placement priority or supply historical fallback", () => {
  const value = trace({ hidden: [sample(10)], shown: [sample(4)] });
  const options = { playerVisibility: new Map([["hidden", false]]) };
  assert.equal(chooseRecordedInteriorPose(value, 10, bounds, options).playerId, "shown");
  options.playerVisibility.set("shown", false);
  assert.equal(chooseRecordedInteriorPose(value, 10, bounds, options), null);
});

test("preferred player wins among current poses but not stale historical visits", () => {
  const value = trace({ preferred: [sample(9)], recent: [sample(10)] });
  assert.equal(chooseRecordedInteriorPose(value, 10, bounds, { preferredPlayerId: "preferred" }).playerId, "preferred");
  assert.equal(chooseRecordedInteriorPose(value, 15, bounds, { preferredPlayerId: "preferred" }).playerId, "recent");
});

test("historical fallback is nearest valid past point after players exit this room", () => {
  const value = trace({ a: [sample(2), sample(3, [100, 110, 220])], b: [sample(1)] });
  assert.equal(chooseRecordedInteriorPose(value, 10, layer).t, 2);
});

test("dead and disconnected spectator samples are rejected until revive or rejoin", () => {
  const events = [{ type: "death", t: 3, playerId: "p" }, { type: "revive", t: 8, playerId: "p" },
    { type: "leave", t: 10, playerId: "p" }, { type: "join", t: 15, playerId: "p" }];
  const value = trace({ p: [sample(2), sample(4), sample(8), sample(11), sample(15)] }, events);
  assert.equal(chooseRecordedInteriorPose(value, 6, bounds).t, 2);
  assert.equal(chooseRecordedInteriorPose(value, 8, bounds).t, 8);
  assert.equal(chooseRecordedInteriorPose(value, 12, bounds).t, 8);
  assert.equal(chooseRecordedInteriorPose(value, 15, bounds).t, 15);
});

test("future lifecycle events and events for other players do not alter earlier placement", () => {
  const value = trace({ p: [sample(3)] }, [{ type: "death", t: 2, playerId: "other" },
    { type: "leave", t: 2, playerId: null }, { type: "death", t: 4, playerId: "p" }]);
  assert.equal(chooseRecordedInteriorPose(value, 3, bounds).t, 3);
});

test("all three bounds axes are respected and inclusive boundary samples are accepted", () => {
  for (const pos of [[-1, 110, 220], [20, 99, 220], [20, 110, 251]]) {
    assert.equal(chooseRecordedInteriorPose(trace({ p: [sample(0, pos)] }), 0, bounds), null);
  }
  for (const pos of [bounds.min, bounds.max]) {
    assert.deepEqual(chooseRecordedInteriorPose(trace({ p: [sample(0, pos)] }), 0, bounds).pos, pos);
  }
});

test("selection is deterministic, handles unsorted inputs, and does not mutate traces", () => {
  const points = [sample(10), sample(2), sample(8)];
  const value = trace({ b: points, a: [sample(10)] });
  const result = chooseRecordedInteriorPose(value, 10, bounds);
  assert.equal(result.playerId, "a");
  assert.equal(chooseRecordedInteriorPose(value, 9, bounds).t, 8);
  assert.deepEqual(points.map((p) => p.t), [10, 2, 8]);
  result.pos[0] = 999;
  assert.equal(value.tracks.get("a")[0].pos[0], 20);
});

test("missing or malformed data returns no placement instead of inventing coordinates", () => {
  for (const invalid of [null, {}, { tracks: [] }]) assert.equal(chooseRecordedInteriorPose(invalid, 0, bounds), null);
  const value = trace({ p: [sample(0, [NaN, 1, 2]), sample(Infinity), sample(0, [1, 2])] });
  assert.equal(chooseRecordedInteriorPose(value, 0, bounds), null);
  for (const invalid of [null, {}, { min: [1, 1, 1], max: [0, 0, 0] }, { min: [0, 0, 0], max: [1, Infinity, 1] }]) {
    assert.equal(chooseRecordedInteriorPose(trace({ p: [sample(0)] }), 0, invalid), null);
  }
  assert.equal(chooseRecordedInteriorPose(trace({ p: [sample(0)] }), NaN, bounds), null);
});
