import test from "node:test";
import assert from "node:assert/strict";
import { PacketWatchClient, parseCaptureId } from "../src/packet-watch-client.js";
import { createLiveTrace, appendLiveRecord, finalizeLiveFlush } from "../src/protocol.js";

const id = "DRXPTJ.3CA5E6878769B9C53304";
const manifest = { schemaVersion: 1, sceneName: "Level_84", gameBuildId: "26155610", projectionVersion: 1,
  coordinateSpace: "unity-world-meters", identityMode: "session-player-id" };
const entry = (sequence, record = { type: "sample", playerId: "p1", t: sequence * 1000, pos: [sequence, 1, 2] }) => ({ sequence, record });
const payload = (fields = {}, status = "recording") => ({ capture: { roomCode: id.split(".")[0], featureCode: id.split(".")[1], status },
  live: { sceneEpoch: 1, manifest, records: [entry(1, { type: "participant", playerId: "p1", nickname: "Climber" }), entry(2)], lastSequence: 2, ...fields } });
const response = (body, status = 200) => ({ status, ok: status === 200, json: async () => body });
function fixture(handler = () => response(payload())) {
  const timers = new Map(), calls = [], snapshots = [], records = [], states = [], connections = [];
  let next = 0, time = 1000;
  const client = new PacketWatchClient({ captureId: id, fetchImpl: async (url, options) => { calls.push({ url, options }); return handler(url, options); },
    onSnapshot: data => snapshots.push(data), onRecord: data => records.push(data), onState: data => states.push(data),
    onConnection: (...data) => connections.push(data), now: () => time,
    setTimer: (fn, delay) => { const key = ++next; timers.set(key, { fn, delay }); return key; }, clearTimer: key => timers.delete(key) });
  return { client, calls, snapshots, records, states, connections, timers, setTime: value => { time = value; },
    async tick() { assert.equal(timers.size, 1); const [key, timer] = [...timers][0]; timers.delete(key); await timer.fn(); } };
}

test("capture identity accepts only a room and feature, never arbitrary watch endpoints", () => {
  assert.equal(parseCaptureId(id.toLowerCase()), id);
  for (const bad of ["../../private", "Q12345." + "A".repeat(20), id + "?key=secret", "https://remote/" + id]) assert.equal(parseCaptureId(bad), null);
});

test("one second cookie polling snapshots first, emits only new records, and preserves freshness on duplicates", async () => {
  let value = payload(); const f = fixture(() => response(value));
  await f.client.start(); assert.equal(f.snapshots.length, 1); assert.equal(f.records.length, 0);
  assert.equal(f.calls[0].url, `/api/navigation/captures/${id.replace(".", "/")}/live`);
  assert.equal(f.calls[0].options.credentials, "same-origin"); assert.equal(f.calls[0].options.redirect, "error");
  assert.equal([...f.timers.values()][0].delay, 1000);
  f.setTime(2000); await f.tick(); assert.equal(f.states.at(-1).lastRecordAt, 1000);
  value = payload({ records: [...value.live.records, entry(3)], lastSequence: 3 });
  await f.tick(); assert.deepEqual(f.records.map(record => record.seq), [3]); assert.equal(f.states.at(-1).lastRecordAt, 2000);
  f.client.stop(); assert.equal(f.timers.size, 0);
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

test("unknown scene supplies a null snapshot, never a made-up manifest or daily map", () => {
  const f = fixture(); f.client.consume(payload());
  f.client.consume(payload({ sceneEpoch: 2, manifest: null, records: [], lastSequence: 2 }));
  assert.equal(f.snapshots.at(-1).manifest, null); assert.deepEqual(f.snapshots.at(-1).snapshot.records, []);
  assert.equal(f.states.at(-1).lastRecordAt, null); assert.equal(f.connections.at(-1)[0], "waiting");
  assert.throws(() => f.client.consume(payload({ manifest: {} })));
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
