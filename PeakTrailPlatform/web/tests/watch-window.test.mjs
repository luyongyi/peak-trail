import assert from "node:assert/strict";
import test from "node:test";
import { createLiveTrace, appendLiveRecord, finalizeLiveFlush, tracePlayerStateAtTime } from "../src/protocol.js";
import { trimWatchTrace } from "../src/watch-window.js";
import { worldObjectsAtTime } from "../src/world-timeline.js";

const manifest = { schemaVersion: 1, sessionId: "session", sceneName: "Level_1",
  coordinateSpace: "unity-world-meters", identityMode: "session-player-id", timeUnit: "milliseconds" };
test("anonymous live identities normalize without requiring platform identifiers", () => {
  const trace = createLiveTrace(manifest);
  appendLiveRecord(trace, { type: "sample", t: 1000, playerId: "p1", pos: [0, 0, 0] });
  appendLiveRecord(trace, { type: "participant", t: 1001, playerId: "p1", nickname: "Climber" });
  assert.equal(trace.participants[0].nickname, "Climber");
  assert.equal(trace.participants[0].id, "p1");
});

test("a long live run retains a bounded path window and the correct old life/state baseline", () => {
  const trace = createLiveTrace(manifest);
  appendLiveRecord(trace, { type: "event", event: "death", playerId: "p1", t: 500 });
  appendLiveRecord(trace, { type: "state", playerId: "p1", t: 1000, stamina: 20, maxStamina: 100 });
  for (let i = 0; i <= 10000; i++) appendLiveRecord(trace,
    { type: "sample", playerId: "p1", t: i * 50, pos: [i * .01, 0, 0], activeSegment: 2 });
  finalizeLiveFlush(trace); trimWatchTrace(trace); finalizeLiveFlush(trace);
  assert.equal(trace.windowStart, 380);
  assert.ok(trace.tracks.get("p1").length <= 2402);
  assert.equal(trace.telemetryTracks.get("p1").length, 1);
  assert.equal(tracePlayerStateAtTime(trace, "p1", 400).life, "dead");
  assert.ok(trace.events.some(e => e.type === "death"));
});

test("world state is compacted into a boundary snapshot instead of forgetting stationary objects", () => {
  const trace = createLiveTrace(manifest);
  appendLiveRecord(trace, { type: "world_snapshot", t: 1000, complete: true,
    objects: [{ objectId: "rope", kind: "item", pos: [1, 2, 3] }] });
  appendLiveRecord(trace, { type: "sample", t: 200000, playerId: "p1", pos: [1, 2, 3] });
  finalizeLiveFlush(trace); trimWatchTrace(trace); finalizeLiveFlush(trace);
  assert.equal(trace.worldRecords[0].t, 80);
  assert.equal(worldObjectsAtTime(trace.worldTimeline, 90)[0].objectId, "rope");
});

test("dense event and sample bursts have hard caps as well as a time window", () => {
  const trace = createLiveTrace(manifest);
  for (let i = 0; i < 9000; i++) {
    appendLiveRecord(trace, { type: "sample", t: i, playerId: "p1", pos: [0, 0, 0] });
    appendLiveRecord(trace, { type: "event", event: "item_acquired", t: i, playerId: "p1" });
  }
  finalizeLiveFlush(trace); trimWatchTrace(trace);
  assert.equal(trace.tracks.get("p1").length, 6000);
  assert.equal(trace.events.length, 2000);
});

test('the rolling window retains chapter, end and separate same-frame Nadir phases without retaining old path samples', () => {
  const trace = createLiveTrace(manifest);
  for (const event of ['segment_change', 'native-checkpoint', 'nadir-ready', 'nadir-entry', 'nadir-wall', 'nadir-chase', 'nadir', 'run_end']) {
    appendLiveRecord(trace, { type: 'event', event, t: 1000, activeSegment: 5, playerId: 'p1', source: 'native-state' });
  }
  for (let i = 0; i <= 1000; i++) appendLiveRecord(trace, { type: 'sample', t: i * 1000, playerId: 'p1', pos: [0, 0, 0], activeSegment: 5 });
  finalizeLiveFlush(trace); trimWatchTrace(trace);
  assert.equal(trace.windowStart, 880);
  assert.ok(trace.tracks.get('p1').length < 125);
  assert.deepEqual(trace.milestones.map(event => event.type), ['segment_change', 'native_checkpoint', 'nadir_ready', 'nadir_entry', 'nadir_wall', 'nadir_chase', 'nadir', 'run_end']);
  assert.ok(trace.events.some(event => event.type === 'run_end'));
  trimWatchTrace(trace);
  assert.equal(trace.milestones.length, 8, 'repeated pruning does not duplicate retained facts');
});
