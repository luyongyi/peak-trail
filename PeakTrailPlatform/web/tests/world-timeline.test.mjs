import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorldObject, normalizeWorldRecord, buildWorldTimeline, worldObjectsAtTime,
  worldObjectVisible, worldObjectInBounds, worldWarning, worldEffectsAtTime, worldTelemetryNote } from "../src/world-timeline.js";
import { loadTraceBundle } from "../src/protocol.js";

const object = (id = "qa:item", fields = {}) => normalizeWorldObject({ objectId: id, kind: "item", pos: [1, 2, 3], activity: "dropped", ...fields });
const snapshot = (t, objects, complete = true) => normalizeWorldRecord({ type: "world_snapshot", complete, objects }, t);
const delta = (t, upserts = [], removed = []) => normalizeWorldRecord({ type: "world_delta", upserts, removed }, t);
const ids = (timeline, t) => worldObjectsAtTime(timeline, t).map((entry) => entry.objectId);
const file = (name, text) => ({ name, text: async () => text });
async function imported(records, extraManifest = {}) {
  const manifest = { schemaVersion: 1, sessionId: "synthetic-world-unit-test", sceneName: "Level_17",
    coordinateSpace: "unity-world-meters", timeUnit: "milliseconds", segmentResolution: "unassigned", ...extraManifest };
  return loadTraceBundle([file("manifest.json", JSON.stringify(manifest)),
    file("stream.ndjson", records.map((record) => JSON.stringify(record)).join("\n"))]);
}

test("world snapshots and deltas replay spawn, movement, despawn and rewind without future leakage", () => {
  const timeline = buildWorldTimeline([snapshot(2, [object()]), delta(4, [object("qa:item", { pos: [3, 4, 5] })]), delta(6, [], ["qa:item"])]);
  assert.deepEqual(ids(timeline, 1.99), []);
  assert.deepEqual(worldObjectsAtTime(timeline, 2)[0].pos, [1, 2, 3]);
  assert.deepEqual(worldObjectsAtTime(timeline, 5)[0].pos, [3, 4, 5]);
  assert.deepEqual(ids(timeline, 6), []);
  assert.deepEqual(worldObjectsAtTime(timeline, 3)[0].pos, [1, 2, 3]);
  assert.deepEqual(ids(timeline, 0), []);
});

test("complete empty snapshots clear the world while partial empty snapshots preserve it", () => {
  const timeline = buildWorldTimeline([snapshot(0, [object("a"), object("b")]), snapshot(1, [], false), snapshot(2, [object("b")]), snapshot(3, [])]);
  assert.deepEqual(ids(timeline, 1), ["a", "b"]);
  assert.deepEqual(ids(timeline, 2), ["b"]);
  assert.deepEqual(ids(timeline, 3), []);
  assert.deepEqual(ids(timeline, 0), ["a", "b"]);
});

test("malformed full snapshot is not mistaken for authoritative removal of old objects", () => {
  const malformed = snapshot(2, [{ objectId: "bad", kind: "item", pos: [NaN, 0, 0] }]);
  assert.equal(malformed.complete, false);
  const timeline = buildWorldTimeline([snapshot(0, [object()]), malformed]);
  assert.deepEqual(ids(timeline, 2), ["qa:item"]);
});

test("duplicate unchanged observations are compacted and same-ID respawns retain history", () => {
  const timeline = buildWorldTimeline([snapshot(0, [object()]), snapshot(1, [object()]), delta(2, [], ["qa:item"]), delta(3, [object()])]);
  assert.equal(timeline.tracks.get("qa:item").length, 3);
  assert.deepEqual(ids(timeline, 2), []);
  assert.deepEqual(ids(timeline, 3), ["qa:item"]);
});

test("timeline sorts out-of-order records without mutating source order", () => {
  const records = [delta(3, [], ["qa:item"]), snapshot(1, [object()]), delta(2, [object("second")])];
  const timeline = buildWorldTimeline(records);
  assert.deepEqual(records.map((entry) => entry.t), [3, 1, 2]);
  assert.deepEqual(ids(timeline, 2), ["qa:item", "second"]);
  assert.deepEqual(ids(timeline, 3), ["second"]);
});

test("held, stored, spent and inactive objects cannot appear as placed world objects", () => {
  for (const activity of ["held", "inventory", "stored", "destroyed", "inactive", "exploded", "spent", "consumed"]) {
    assert.equal(worldObjectVisible(object("held", { activity })), false, activity);
  }
  assert.equal(worldObjectVisible(object("hidden", { active: false })), false);
  assert.equal(worldObjectVisible(object()), true);
});

test("world objects are clipped against all spatial axes rather than progression index", () => {
  const bounds = { min: [0, 0, 0], max: [10, 10, 10] };
  assert.equal(worldObjectInBounds(object(), bounds), true);
  assert.equal(worldObjectInBounds(object("far", { pos: [14, 2, 3], activeSegment: 0 }), bounds), false);
  assert.equal(worldObjectInBounds(object("far", { pos: [1, 14, 3] }), bounds), false);
  assert.equal(worldObjectInBounds(object("far", { pos: [1, 2, -4] }), bounds), false);
  assert.equal(worldObjectInBounds(object(), null), true);
});

test("enemy warning uses recorded activation radius plus a documented 20m viewing margin", () => {
  const zombie = object("z", { kind: "zombie", pos: [0, 0, 0], activationRadius: 12, activity: "dormant" });
  const warning = worldWarning(zombie, [{ pos: [32, 0, 0] }]);
  assert.equal(warning.range, 32);
  assert.equal(warning.distance, 32);
  assert.equal(warning.active, false);
  assert.equal(worldWarning(zombie, [{ pos: [32.01, 0, 0] }]), null);
  assert.equal(worldWarning({ ...zombie, activity: "chasing" }, [{ pos: [20, 0, 0] }]).active, true);
});

test("explicit warning range takes precedence and distance uses the nearest player in 3D", () => {
  const zombie = object("z", { kind: "zombie_spawn", pos: [0, 0, 0], activationRadius: 30, warningRadius: 20 });
  const warning = worldWarning(zombie, [{ pos: [100, 0, 0] }, { pos: [0, 12, 16] }]);
  assert.equal(warning.range, 20);
  assert.equal(warning.distance, 20);
  assert.equal(worldWarning(zombie, [{ pos: [0, 20.01, 0] }]), null);
});

test("unknown ranges never assume the user's illustrative 30m or manufacture an enemy warning", () => {
  const zombie = object("z", { kind: "zombie", pos: [0, 0, 0] });
  assert.equal(zombie.activationRadius, null);
  assert.equal(zombie.warningRadius, null);
  assert.equal(worldWarning(zombie, [{ pos: [1, 0, 0] }]), null);
  assert.equal(worldWarning(object(), [{ pos: [1, 2, 3] }]), null);
  assert.equal(worldWarning({ ...zombie, activationRadius: 5 }, []), null);
  assert.equal(worldWarning({ ...zombie, activationRadius: 5, active: false }, [{ pos: [0, 0, 0] }]), null);
});

test("negative or non-finite radii remain unknown instead of generating a false warning", () => {
  for (const radius of [-1, NaN, Infinity, "30"]) {
    const zombie = object("z", { kind: "zombie", radius, activationRadius: radius, warningRadius: radius });
    assert.equal(zombie.radius, null);
    assert.equal(zombie.activationRadius, null);
    assert.equal(zombie.warningRadius, null);
    assert.equal(worldWarning(zombie, [{ pos: [0, 0, 0] }]), null);
  }
});

test("recorded explosion effects have exact start/end timing and rewind safely", () => {
  const events = [{ type: "mine_explosion", t: 10, objectId: "mine", pos: [1, 2, 3] },
    { type: "spore_explosion", t: 11, pos: [1, 2, 3] }, { type: "death", t: 10, pos: [1, 2, 3] },
    { type: "mine_exploded", t: 10, pos: null }];
  assert.deepEqual(worldEffectsAtTime(events, 9.99), []);
  assert.equal(worldEffectsAtTime(events, 10)[0].progress, 0);
  assert.equal(worldEffectsAtTime(events, 11.5)[0].progress, 0.5);
  assert.equal(worldEffectsAtTime(events, 13).length, 1);
  assert.deepEqual(worldEffectsAtTime(events, 14), []);
  assert.deepEqual(worldEffectsAtTime(events, 0), []);
});

test("old logs and times before first capture explicitly report unknown world state", () => {
  assert.match(worldTelemetryNote(buildWorldTimeline(), 100), /未采集.*未知/);
  const timeline = buildWorldTimeline([snapshot(10, [])]);
  assert.equal(timeline.captured, true);
  assert.match(worldTelemetryNote(timeline, 0), /尚无.*不提前/);
  assert.match(worldTelemetryNote(timeline, 10), /示意/);
});

test("malformed normalization inputs are rejected without throwing or inventing positions", () => {
  for (const input of [null, {}, { kind: "item", pos: [0, 0, 0] }, { objectId: "x", kind: "unknown", pos: [0, 0, 0] },
    { objectId: "x", kind: "mine", pos: [0, NaN, 0] }, { objectId: "x", kind: "mine", pos: [0, 0] }]) {
    assert.equal(normalizeWorldObject(input), null);
  }
  for (const input of [null, {}, { type: "world_snapshot", objects: null }, { type: "sample", objects: [] }]) {
    assert.equal(normalizeWorldRecord(input, 0), null);
  }
  assert.equal(normalizeWorldRecord({ type: "world_snapshot", objects: [] }, -1), null);
  assert.equal(normalizeWorldRecord({ type: "world_snapshot", objects: [] }, NaN), null);
});

test("object normalization copies coordinate arrays and preserves world semantic metadata", () => {
  const pos = [1, 2, 3];
  const raw = { objectId: "z", kind: "zombie", pos, rot: [0, 0, 0, 1], scale: [1, 1, 1], prefabName: "Zombie (Clone)", activationRadius: 12 };
  const normalized = normalizeWorldObject(raw);
  normalized.pos[0] = 999;
  assert.equal(pos[0], 1);
  assert.equal(normalized.prefabName, raw.prefabName);
  assert.equal(normalized.activationRadius, 12);
});

test("invalid fog dimensions stay unknown while valid mirror scales remain allowed", () => {
  for (const size of [[-1, 2, 3], [1, NaN, 3], [1, 2], "10"]) {
    assert.equal(object("fog", { kind: "sleep_fog", size }).size, null);
  }
  assert.deepEqual(object("fog", { kind: "sleep_fog", size: [0, 2, 3] }).size, [0, 2, 3]);
  assert.deepEqual(object("mirror", { scale: [-1, 1, 1] }).scale, [-1, 1, 1]);
});

test("protocol import preserves world timelines and actual world-event metadata with millisecond conversion", async () => {
  const value = await imported([
    { type: "sample", t: 0, playerId: "qa", pos: [1, 2, 3] },
    { type: "world_snapshot", t: 1000, complete: true, objects: [object("mine", { kind: "mine" })] },
    { type: "world_event", event: "mine_explosion", t: 1500, objectId: "mine", kind: "mine", pos: [1, 2, 3], radius: 4, source: "qa-not-gameplay" },
    { type: "world_delta", t: 2000, upserts: [], removed: ["mine"] },
    { type: "sample", t: 3000, playerId: "qa", pos: [2, 2, 3] },
  ]);
  assert.equal(value.worldTimeline.firstTime, 1);
  assert.equal(value.worldTimeline.lastTime, 2);
  assert.deepEqual(ids(value.worldTimeline, 0), []);
  assert.deepEqual(ids(value.worldTimeline, 1), ["mine"]);
  assert.deepEqual(ids(value.worldTimeline, 2), []);
  const event = value.events.find((entry) => entry.type === "mine_explosion");
  assert.equal(event.t, 1.5);
  assert.equal(event.objectId, "mine");
  assert.equal(event.kind, "mine");
  assert.equal(event.radius, 4);
  assert.equal(event.source, "qa-not-gameplay");
});

test("world-only changes after the final position sample remain reachable on playback timeline", async () => {
  const value = await imported([{ type: "sample", t: 0, playerId: "qa", pos: [1, 2, 3] },
    { type: "world_snapshot", t: 10000, complete: true, objects: [object()] }]);
  assert.equal(value.duration, 10);
});

test("legacy inventory drop event is not promoted to a recorded placed model", async () => {
  const value = await imported([{ type: "sample", t: 0, playerId: "qa", pos: [1, 2, 3] },
    { type: "event", event: "item_drop", t: 1000, playerId: "qa", pos: [1, 2, 3], item: { itemId: "1", prefabName: "Mushroom" } }]);
  assert.equal(value.worldTimeline.captured, false);
  assert.deepEqual(ids(value.worldTimeline, 1), []);
  assert.match(worldTelemetryNote(value.worldTimeline, 1), /未知/);
});
