import test from "node:test";
import assert from "node:assert/strict";
import { PacketWatchClient, parseCaptureId } from "../src/packet-watch-client.js";
import { createLiveTrace, appendLiveRecord, finalizeLiveFlush, tracePlayerStateAtTime } from "../src/protocol.js";

const id = "DRXPTJ.3CA5E6878769B9C53304";
const manifest = { schemaVersion: 1, sceneName: "Level_84", gameBuildId: "26155610", projectionVersion: 1,
  coordinateSpace: "unity-world-meters", identityMode: "session-player-id" };
const entry = (sequence, record = { type: "sample", playerId: "p1", t: sequence * 1000, pos: [sequence, 1, 2] }) => ({ sequence, record });
const payload = (fields = {}, status = "recording") => ({ capture: { roomCode: id.split(".")[0], featureCode: id.split(".")[1], status },
  live: { sceneEpoch: 1, manifest, records: [entry(1, { type: "participant", playerId: "p1", nickname: "Climber" }), entry(2)], lastSequence: 2, ...fields } });
const response = (body, status = 200) => ({ status, ok: status === 200, json: async () => body });
function fixture(handler = () => response(payload())) {
  const timers = new Map(), calls = [], snapshots = [], records = [], motions = [], states = [], connections = [];
  let next = 0, time = 1000;
  const client = new PacketWatchClient({ captureId: id, fetchImpl: async (url, options) => { calls.push({ url, options }); return handler(url, options); },
    onSnapshot: data => snapshots.push(data), onRecord: data => records.push(data), onMotion: data => motions.push(data), onState: data => states.push(data),
    onConnection: (...data) => connections.push(data), now: () => time,
    setTimer: (fn, delay) => { const key = ++next; timers.set(key, { fn, delay }); return key; }, clearTimer: key => timers.delete(key) });
  return { client, calls, snapshots, records, motions, states, connections, timers, setTime: value => { time = value; },
    async tick() { assert.equal(timers.size, 1); const [key, timer] = [...timers][0]; timers.delete(key); await timer.fn(); } };
}

test("capture identity accepts only a room and feature, never arbitrary watch endpoints", () => {
  assert.equal(parseCaptureId(id.toLowerCase()), id);
  for (const bad of ["../../private", "Q12345." + "A".repeat(20), id + "?key=secret", "https://remote/" + id]) assert.equal(parseCaptureId(bad), null);
});

test("polled player movement is read at the playhead for the same epoch, actor and stage, then expires", () => {
  const { client } = fixture();
  const current = { ...manifest, gameBuildId: "26542162", participants: [{ playerId: "p1" }] };
  const move = (t, movement) => ({ playerId: "p1", activeSegment: 1, movement, t });
  client.consume(payload({ manifest: current, movements: [move(2000, "grounded")] }));
  client.consume(payload({ manifest: current, movements: [move(3100, "climbing")] }));
  assert.equal(client.movementAt("p1", 1.9, 1), null);
  assert.equal(client.movementAt("p1", 2.9, 1), "grounded");
  assert.equal(client.movementAt("p1", 3.1, 1), "climbing");
  assert.equal(client.movementAt("p1", 4.601, 1), null);
  assert.equal(client.movementAt("p2", 3.1, 1), null);
  assert.equal(client.movementAt("p1", 3.1, 0), null);
  client.consume(payload({ sceneEpoch: 2, manifest: current, movements: [move(2000, "private")] }));
  assert.equal(client.movementAt("p1", 3.1, 1), null);
});

test("one second cookie polling snapshots first, emits only new records, and preserves freshness on duplicates", async () => {
  let value = payload(); const f = fixture(() => response(value));
  await f.client.start(); assert.equal(f.snapshots.length, 1); assert.equal(f.records.length, 0);
  assert.equal(f.calls[0].url, `/api/navigation/captures/${id.replace(".", "/")}/live?motion=1`);
  assert.equal(f.calls[0].options.credentials, "same-origin"); assert.equal(f.calls[0].options.redirect, "error");
  assert.equal([...f.timers.values()][0].delay, 1000);
  f.setTime(2000); await f.tick(); assert.equal(f.states.at(-1).lastRecordAt, 1000);
  value = payload({ records: [...value.live.records, entry(3)], lastSequence: 3 });
  await f.tick(); assert.deepEqual(f.records.map(record => record.seq), [3]); assert.equal(f.states.at(-1).lastRecordAt, 2000);
  f.client.stop(); assert.equal(f.timers.size, 0);
});

const liveUrl = `/api/navigation/captures/${id.replace(".", "/")}/live`;
const pose = (seq, t) => [seq, t, -3.5, 1.25, 12, 45];
const motionSnapshot = (fields = {}) => payload({ delivery: "snapshot", lastMotionSequence: 9,
  motion: [["p1", 0, [pose(8, 1500.125), pose(9, 1520)]]], ...fields });
const motionDelta = (fields = {}) => payload({ delivery: "delta", baseSequence: 2, lastSequence: 2,
  baseMotionSequence: 9, lastMotionSequence: 11, records: [], motion: [["p2", null, [pose(11, 2020)]]], ...fields });

test("both cursors advance independently and motion callbacks follow regular records in the same poll", async () => {
  let value = motionSnapshot();
  const f = fixture(() => response(value)), applied = [];
  for (const name of ["onMotion", "onRecord", "onSnapshot", "onState"]) {
    const callback = f.client[name];
    f.client[name] = data => { applied.push(name); callback(data); };
  }
  await f.client.start();
  assert.deepEqual(applied.splice(0), ["onSnapshot", "onMotion", "onState"]);
  assert.equal(f.motions[0].reset, true);
  assert.deepEqual(f.motions[0].samples[0], { playerId: "p1", t: 1.500125, pos: [-3.5, 1.25, 12], yaw: 45, activeSegment: 0 });
  f.setTime(2000);
  value = motionDelta();
  await f.tick();
  assert.equal(f.calls.at(-1).url, liveUrl + "?motion=1&epoch=1&after=2&afterMotion=9");
  assert.deepEqual(applied.splice(0), ["onMotion", "onState"]);
  assert.equal(f.motions.at(-1).reset, false); assert.equal(f.motions.at(-1).samples[0].activeSegment, null);
  assert.equal(f.states.at(-1).lastRecordAt, 2000);
  value = motionDelta({ baseMotionSequence: 11, lastMotionSequence: 13, records: [entry(5)], lastSequence: 5,
    motion: [["p2", 1, [pose(13, 3020)]], ["p1", 0, [pose(12, 3010)]]] });
  await f.tick();
  assert.equal(f.calls.at(-1).url, liveUrl + "?motion=1&epoch=1&after=2&afterMotion=11");
  assert.deepEqual(applied.splice(0), ["onRecord", "onMotion", "onState"]);
  assert.equal(f.snapshots.length, 1); assert.equal(f.records.at(-1).seq, 5);
  f.setTime(3100);
  value = motionDelta({ baseSequence: 5, lastSequence: 5, baseMotionSequence: 13, lastMotionSequence: 13, motion: [] });
  await f.tick();
  assert.deepEqual(applied, ["onState"]);
  assert.equal(f.states.at(-1).lastRecordAt, 2000);
  f.client.stop();
});

test("bad base cursors, epoch, map or supplemental rows are rejected atomically and trigger a cold resync", async () => {
  for (const fields of [
    { baseSequence: 1 }, { baseMotionSequence: 8 }, { sceneEpoch: 2 }, { manifest: { ...manifest, sceneName: "Level_85" } },
    { motion: [["p1", 0, [pose(10, 2100)]], ["p2", 0, [pose(10, 2101)]]] },
    { motion: [["p1", 0, [pose(12, 2100)]]] }, { motion: [["p1", 0, [pose(9, 2100)]]] },
    { motion: [["p1", 0, [[10, 2100, null, 0, 0, 0]]]] },
  ]) {
    let value = motionSnapshot(); const f = fixture(() => response(value)); await f.client.start();
    value = motionDelta({ records: [entry(3)], lastSequence: 3, ...fields }); await f.tick();
    assert.equal(f.connections.at(-1)[0], "reconnecting");
    assert.equal(f.records.length, 0); assert.equal(f.motions.length, 1); assert.equal(f.client.seq, 2);
    value = motionSnapshot({ sceneEpoch: 2, lastMotionSequence: 0, motion: [] }); await f.tick();
    assert.equal(f.calls.at(-1).url, liveUrl + "?motion=1");
    assert.equal(f.snapshots.length, 2); assert.deepEqual(f.motions.at(-1), { reset: true, samples: [] });
    f.client.stop();
  }
});

test("network retries keep their cursor, and an expired cursor or older archive resets the previous motion window", async () => {
  let reply = response(motionSnapshot()); const f = fixture(() => reply); await f.client.start();
  reply = response(null, 503); await f.tick();
  const cursorUrl = f.calls.at(-1).url;
  reply = response(motionSnapshot({ lastMotionSequence: 51, motion: [["p3", 1, [pose(51, 4500)]]] })); await f.tick();
  assert.equal(f.calls.at(-1).url, cursorUrl); assert.equal(f.snapshots.length, 2);
  assert.equal(f.motions.at(-1).reset, true); assert.deepEqual(f.motions.at(-1).samples.map(p => p.playerId), ["p3"]);
  reply = response(payload({}, "completed")); await f.tick();
  assert.equal(f.snapshots.length, 3); assert.deepEqual(f.motions.at(-1), { reset: true, samples: [] });
  assert.equal(f.connections.at(-1)[0], "ended"); assert.equal(f.timers.size, 0);
});

test("an older bridge rejecting the opt-in query is polled on the legacy endpoint", async () => {
  const f = fixture(url => url.includes("?") ? response(null, 400) : response(payload()));
  await f.client.start(); await f.tick();
  assert.deepEqual(f.calls.map(call => call.url), [liveUrl + "?motion=1", liveUrl, liveUrl]);
  assert.equal(f.snapshots.length, 1); assert.equal(f.connections.at(-1)[0], "connected");
  f.client.stop();
});

test("projection callbacks feed the existing trace parser and renderer data unchanged", async () => {
  const f = fixture(); await f.client.start();
  const snapshot = f.snapshots[0]; const trace = createLiveTrace({ ...snapshot.manifest, sessionId: snapshot.sessionId });
  for (const { record } of snapshot.snapshot.records) appendLiveRecord(trace, record);
  finalizeLiveFlush(trace);
  assert.equal(trace.manifest.gameBuildId, "26155610"); assert.equal(trace.manifest.sceneName, "Level_84");
  assert.equal(trace.participants[0].nickname, "Climber"); assert.equal(trace.sampleCount, 1);
  f.client.stop();
});

test("scene changes and retention gaps rebuild rather than append across unrelated maps", () => {
  const f = fixture(); f.client.consume(payload());
  f.client.consume(payload({ sceneEpoch: 2, manifest: { ...manifest, sceneName: "Level_85" }, records: [entry(3)], lastSequence: 3 }));
  f.client.consume(payload({ sceneEpoch: 2, manifest: { ...manifest, sceneName: "Level_85" }, records: [entry(200)], lastSequence: 200 }));
  assert.equal(f.snapshots.length, 3); assert.equal(f.records.length, 0);
  assert.equal(f.snapshots[2].snapshot.records[0].seq, 200);
});

test("late navigation opens with retained appearances and later clears the correct player", () => {
  const host = { type: "appearance", playerId: "p1", t: 1000, appearance: { eyesIndex: 7, mouthIndex: 11, ready: true } };
  const teammate = { type: "appearance", playerId: "p2", t: 1500, appearance: { eyesIndex: 4, mouthIndex: 2, ready: true } };
  const clear = { type: "appearance", playerId: "p2", t: 4000, appearanceReady: false, appearance: null };
  const f = fixture();
  f.client.consume(payload({ appearanceBaselines: [host], records: [entry(9, teammate), entry(10)], lastSequence: 10 }));
  const snapshot = f.snapshots[0], trace = createLiveTrace({ ...snapshot.manifest, sessionId: snapshot.sessionId });
  for (const { record } of snapshot.snapshot.records) appendLiveRecord(trace, record);
  finalizeLiveFlush(trace);
  assert.equal(tracePlayerStateAtTime(trace, "p1", 2).appearance.eyesIndex, 7);
  assert.equal(tracePlayerStateAtTime(trace, "p2", 1).appearance, null);
  assert.equal(tracePlayerStateAtTime(trace, "p2", 2).appearance.mouthIndex, 2);
  f.client.consume(payload({ appearanceBaselines: [host], records: [entry(9, teammate), entry(10), entry(11, clear)], lastSequence: 11 }));
  assert.deepEqual(f.records.map(value => value.record), [clear]);
  appendLiveRecord(trace, f.records[0].record);
  finalizeLiveFlush(trace);
  assert.equal(tracePlayerStateAtTime(trace, "p2", 4).appearance.ready, false);
  assert.equal(tracePlayerStateAtTime(trace, "p1", 4).appearance.eyesIndex, 7);
});

test("unknown scene supplies a null snapshot, never a made-up manifest or daily map", () => {
  const f = fixture(); f.client.consume(payload());
  f.client.consume(payload({ sceneEpoch: 2, manifest: null, records: [], lastSequence: 2 }));
  assert.equal(f.snapshots.at(-1).manifest, null); assert.deepEqual(f.snapshots.at(-1).snapshot.records, []);
  assert.equal(f.states.at(-1).lastRecordAt, null); assert.equal(f.connections.at(-1)[0], "waiting");
  assert.throws(() => f.client.consume(payload({ manifest: {} })));
});

test("waiting polls distinguish the verified airport from other scenes and builds without inventing a climbing map", () => {
  const f = fixture();
  for (const [sceneName, gameBuildId, airport, available] of [
    [null, null, false, false], ["Airport", "26542162", true, true],
    ["Airport", "other", true, false], ["MainMenu", "26542162", false, false],
  ]) {
    f.client.consume(payload({ manifest: null, records: [], lastSequence: 0, sceneName, gameBuildId }));
    assert.equal(f.states.at(-1).airport, airport);
    assert.equal(f.states.at(-1).airportModelAvailable, available);
    assert.equal(f.states.at(-1).manifest, null);
  }
});

test("unauthorized and missing captures stop polling and never expose upstream errors", async () => {
  for (const [status, connection] of [[401, "unauthorized"], [404, "error"], [410, "error"]]) {
    const f = fixture(() => response({ message: "SECRET" }, status)); await f.client.start();
    assert.equal(f.connections.at(-1)[0], connection); assert.equal(f.timers.size, 0);
    assert.equal(JSON.stringify(f.connections).includes("SECRET"), false);
  }
});

test("completed capture leaves its final snapshot available and does not keep polling", async () => {
  const f = fixture(() => response(payload({}, "completed"))); await f.client.start();
  assert.equal(f.snapshots.length, 1); assert.equal(f.states[0].status, "ended");
  assert.equal(f.connections.at(-1)[0], "ended"); assert.equal(f.timers.size, 0);
});

test("malformed identities and sequence ordering do not advance the cursor", async () => {
  let value = payload({ records: [entry(2), entry(1)] }); const f = fixture(() => response(value));
  await f.client.start(); assert.equal(f.client.seq, 0); assert.equal(f.snapshots.length, 0);
  value = payload(); value.capture.roomCode = "ABC123"; await f.tick(); assert.equal(f.client.seq, 0);
  value = payload(); await f.tick(); assert.equal(f.client.seq, 2); f.client.stop();
});

test("request deadline aborts and retries; disposing aborts without leaving timers", async () => {
  const f = fixture((url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("SECRET")))));
  const pending = f.client.start(); assert.equal([...f.timers.values()][0].delay, 10000);
  [...f.timers.values()][0].fn(); await pending;
  assert.equal(f.connections.at(-1)[0], "reconnecting"); assert.equal(f.timers.size, 1);
  const retry = f.tick(); f.client.stop(); await retry;
  assert.equal(f.timers.size, 0); assert.equal(f.calls.at(-1).options.signal.aborted, true);
});
