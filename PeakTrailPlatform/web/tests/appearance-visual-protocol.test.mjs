import assert from "node:assert/strict";
import test from "node:test";
import { createLiveTrace, appendLiveRecord, finalizeLiveFlush, loadTraceBundle, tracePlayerStateAtTime } from "../src/protocol.js";

const manifest = { schemaVersion: 1, sessionId: "synthetic-visual-evidence", sceneName: "Level_10",
  gameBuildId: "25739797", timeUnit: "milliseconds", coordinateSpace: "unity-world-meters" };
const appearanceRecord = (t, appearance) => ({ type: "appearance", t, playerId: "p1", appearance });
const active = () => ({ ready: true, authority: "synthetic-native-observation", formReady: true, form: "ghost",
  ghostReady: true, ghostActive: true, ghostVisible: false, ghostPosition: [100, 50, -20], ghostRotation: [0, 0, 0, 1],
  petrificationReady: true, petrificationActive: true, petrificationAmount: .625,
  petrificationTriggered: true, petrificationProgress: .5, blindnessReady: true, blindnessActive: true });
const cleared = () => ({ ready: true, formReady: true, form: "normal", ghostReady: true, ghostActive: false, ghostVisible: false,
  petrificationReady: true, petrificationActive: false, petrificationTriggered: false, blindnessReady: true, blindnessActive: false });
function live(records) {
  const trace = createLiveTrace(manifest);
  for (const record of [{ type: "sample", t: 0, playerId: "p1", pos: [1, 2, 3] }, ...records]) appendLiveRecord(trace, record);
  return finalizeLiveFlush(trace);
}
const at = (trace, seconds) => tracePlayerStateAtTime(trace, "p1", seconds).appearance;

test("native ghost and state visuals follow full snapshots, explicit clear, unknown and playback rewind", async () => {
  const records = [{ ...appearanceRecord(1000, active()), activeSegment: 2 }, { ...appearanceRecord(2000, cleared()), activeSegment: 3 },
    appearanceRecord(3000, { ready: false, formReady: false, ghostReady: false, ghostActive: null,
      petrificationReady: false, petrificationActive: null, blindnessReady: false, blindnessActive: null })];
  const file = (name, value) => ({ name, text: async () => value });
  const offline = await loadTraceBundle([file("manifest.json", JSON.stringify(manifest)), file("stream.ndjson",
    [{ type: "sample", t: 0, playerId: "p1", pos: [1, 2, 3] }, ...records].map(JSON.stringify).join("\n"))]);
  for (const trace of [live(records), offline]) {
    assert.equal(at(trace, .99), null);
    const first = at(trace, 1.5);
    assert.equal(first.form, "ghost"); assert.equal(first.ghostActive, true); assert.equal(first.ghostVisible, false);
    assert.deepEqual(first.ghostPosition, [100, 50, -20]); assert.deepEqual(first.ghostRotation, [0, 0, 0, 1]);
    assert.equal(first.petrificationAmount, .625); assert.equal(first.petrificationProgress, .5);
    assert.equal(first.petrificationTriggered, true); assert.equal(first.blindnessActive, true);
    assert.equal(tracePlayerStateAtTime(trace, "p1", 1.5).appearanceActiveSegment, 2);
    const clear = at(trace, 2.5);
    assert.equal(clear.form, "normal"); assert.equal(clear.ghostActive, false); assert.equal(clear.ghostPosition, null);
    assert.equal(clear.ghostRotation, null); assert.equal(clear.petrificationActive, false);
    assert.equal(clear.petrificationAmount, null); assert.equal(clear.petrificationProgress, null); assert.equal(clear.blindnessActive, false);
    assert.equal(tracePlayerStateAtTime(trace, "p1", 2.5).appearanceActiveSegment, 3);
    const unknown = at(trace, 3);
    assert.equal(unknown.form, "unknown"); assert.equal(unknown.ghostReady, false); assert.equal(unknown.ghostActive, null);
    assert.equal(unknown.petrificationActive, null); assert.equal(unknown.blindnessActive, null);
    assert.equal(tracePlayerStateAtTime(trace, "p1", 3).appearanceActiveSegment, null, "old absent segment must remain unknown");
    assert.equal(at(trace, 1).ghostActive, true, "rewind reads the observation at that time");
    assert.deepEqual(trace.tracks.get("p1")[0].pos, [1, 2, 3], "ghost pose never replaces sampled character position");
    assert.equal(trace.tracks.get("p1").length, 1);
  }
});

test("old logs, death and affliction amounts do not manufacture visual evidence", () => {
  const trace = live([appearanceRecord(0, { ready: true, skinIndex: 2 }),
    { type: "event", t: 100, playerId: "p1", event: "death" },
    { type: "status", t: 100, playerId: "p1", status: { ready: true, dead: true, values: [
      { id: 13, type: "Petrify", amount: 1 }, { id: 14, type: "Blind", amount: 1 }] } }]);
  const value = at(trace, 1);
  for (const key of ["ghostReady", "ghostActive", "ghostVisible", "ghostPosition", "ghostRotation", "petrificationReady",
    "petrificationActive", "petrificationAmount", "petrificationTriggered", "petrificationProgress", "blindnessReady", "blindnessActive"])
    assert.equal(value[key], null, key);
  assert.equal(value.form, "unknown");
});

test("invalid visual values remain unknown, while finite shader observations are not clamped to progress", () => {
  const source = active(), trace = live([appearanceRecord(0, source)]);
  source.ghostPosition[0] = 999; source.ghostRotation[3] = 0;
  assert.deepEqual(at(trace, 0).ghostPosition, [100, 50, -20]);
  assert.deepEqual(at(trace, 0).ghostRotation, [0, 0, 0, 1]);
  for (const [key, value] of [["ghostPosition", ["1", 2, 3]], ["ghostPosition", [0, Infinity, 3]],
    ["ghostRotation", [0, 0, 0]], ["ghostRotation", [0, 0, 0, 1.01]],
    ["petrificationAmount", "0.6"], ["petrificationAmount", Infinity], ["petrificationAmount", 1001],
    ["petrificationProgress", 1.1], ["petrificationProgress", null], ["ghostActive", 1], ["blindnessActive", "true"]]) {
    const valueAtTime = at(live([appearanceRecord(0, { ...active(), [key]: value })]), 0);
    assert.equal(valueAtTime[key], null, `${key}: ${value}`);
  }
  assert.equal(at(live([appearanceRecord(0, { ...active(), petrificationAmount: 1.25 })]), 0).petrificationAmount, 1.25);
  const unavailable = at(live([appearanceRecord(0, { ...active(), ghostReady: false, petrificationReady: false, blindnessReady: false })]), 0);
  for (const key of ["ghostActive", "ghostVisible", "ghostPosition", "petrificationActive", "petrificationAmount", "petrificationTriggered", "petrificationProgress", "blindnessActive"])
    assert.equal(unavailable[key], null, key);
});
