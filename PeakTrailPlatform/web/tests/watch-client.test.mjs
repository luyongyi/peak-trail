import assert from "node:assert/strict";
import test from "node:test";
import { WatchClient, parseWatchId, isEmptyWatchSnapshot } from "../src/watch-client.js";

const id = "a".repeat(32);
function fixture({ response = { ok: true, json: async () => ({ status: "live" }) } } = {}) {
  const streams = [], requests = [], timers = new Map(), snapshots = [], records = [], states = [], connections = [];
  let time = 0, nextTimer = 0;
  class FakeSource {
    constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    close() { this.closed = true; }
    emit(type, data) { this.listeners[type]?.({ data: JSON.stringify(data) }); }
  }
  const client = new WatchClient({ watchId: id, EventSourceImpl: FakeSource,
    fetchImpl: async url => { requests.push(url); return typeof response === "function" ? response() : response; },
    onSnapshot: data => snapshots.push(data), onRecord: data => records.push(data),
    onState: data => states.push(data), onConnection: (...args) => connections.push(args),
    now: () => time, setTimer: (fn, delay) => { const key = ++nextTimer; timers.set(key, { fn, delay }); return key; },
    clearTimer: key => timers.delete(key) });
  return { client, streams, requests, snapshots, records, states, connections, timers,
    runTimer(key) { const timer = timers.get(key); timers.delete(key); time += timer.delay; return timer.fn(); } };
}
const hello = (epoch = 1, seq = 8) => ({ sessionId: "s", watchId: id, epoch, status: "live", snapshotSeq: seq,
  lastSeq: seq, manifest: {}, snapshot: { records: [{ seq: 1, record: {} }, { seq, record: {} }] } });
const waiting = (status = "waiting") => ({ sessionId: "s", watchId: id, watchCode: 'ABCD', epoch: 0, status,
  manifest: null, lastSeq: 0, snapshotSeq: 0, snapshot: { records: [] } });

test('reserved rooms accept empty epoch zero and activate on the same socket with the same code', async () => {
  const f = fixture({ response: { ok: true, json: async () => waiting() } }); await f.client.start();
  const socket = f.streams[0]; socket.emit('hello', waiting());
  assert.equal(f.client.epoch, 0); assert.equal(f.client.seq, 0); assert.equal(f.records.length, 0);
  socket.emit('ping', {}); socket.emit('state', { epoch: 0, status: 'waiting' });
  assert.equal(f.states.at(-1).status, 'waiting');
  socket.emit('hello', { ...hello(1, 0), watchCode: 'ABCD', snapshot: { records: [] } });
  socket.emit('record', { epoch: 1, seq: 1, record: { type: 'participant' } });
  assert.equal(f.streams.length, 1); assert.equal(f.snapshots.length, 2);
  assert.equal(f.snapshots[0].watchCode, f.snapshots[1].watchCode);
  assert.equal(f.client.epoch, 1); assert.equal(f.client.seq, 1); assert.equal(f.records.length, 1);
  f.client.stop();
});

test('waiting reconnects carry an explicit zero cursor and can then receive activation hello', async () => {
  const f = fixture(); await f.client.start(); f.streams[0].emit('hello', waiting());
  f.streams[0].onerror(); await f.runTimer(f.client.retryTimer);
  assert.equal(f.streams[1].url, `/api/live/v2/watch/${id}/stream?epoch=0&after=0`);
  f.streams[1].emit('resumed', { epoch: 0, status: 'waiting', lastSeq: 0 });
  f.streams[1].emit('hello', hello()); assert.equal(f.client.epoch, 1); f.client.stop();
});

test('an unused room can end with no manifest, and a live room cannot regress to an empty waiting snapshot', async () => {
  const f = fixture(); await f.client.start(); f.streams[0].emit('hello', waiting('ended'));
  assert.equal(f.snapshots.length, 1); assert.equal(f.client.ended, true); assert.equal(f.streams[0].closed, true);
  assert.equal(f.timers.size, 0);
  const g = fixture(); await g.client.start(); g.streams[0].emit('hello', hello()); g.streams[0].emit('hello', waiting());
  assert.equal(g.snapshots.length, 1); assert.equal(g.client.epoch, 1); assert.equal(g.client.seq, 8); g.client.stop();
});

test('epoch-zero records and nonempty or malformed waiting snapshots cannot fabricate a game world', async () => {
  for (const extra of [{ manifest: {} }, { status: 'live' }, { epoch: 1 }, { lastSeq: 1 }, { snapshotSeq: 1 }, { snapshot: { records: [{ seq: 1, record: {} }] } }]) {
    const data = { ...waiting(), ...extra };
    assert.equal(isEmptyWatchSnapshot(data), false);
    const f = fixture(); await f.client.start(); f.streams[0].emit('hello', data);
    assert.equal(f.snapshots.length, 0); assert.equal(f.client.seq, 0); assert.equal(f.streams[0].closed, true); f.client.stop();
  }
  const f = fixture(); await f.client.start(); f.streams[0].emit('hello', waiting());
  f.streams[0].emit('record', { epoch: 0, seq: 1, record: {} });
  assert.equal(f.records.length, 0); assert.equal(f.client.seq, 0); f.client.stop();
});

test('expired waiting rooms stop retrying without claiming a path was received', async () => {
  let reads = 0;
  const f = fixture({ response: () => ++reads === 1 ? { ok: true, json: async () => waiting() } : { ok: false, status: 404 } });
  await f.client.start(); f.streams[0].emit('hello', waiting());
  for (let n = 0; n < 3; n++) { f.streams.at(-1).onerror(); await f.runTimer(f.client.retryTimer); }
  assert.equal(f.client.closed, true); assert.deepEqual(f.connections.at(-1), ['error', '链接不存在或已过期']);
});

test("all default browser ports retain native receivers through connect, retry and cleanup", async () => {
  const original = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout, EventSource: globalThis.EventSource };
  const requests = [], streams = [], connections = [], timers = new Map();
  let nextTimer = 0;
  globalThis.fetch = async function(url) {
    // Browser Web IDL functions can throw Illegal invocation on a class receiver.
    assert.equal(this, globalThis);
    requests.push(url);
    return { ok: true, json: async () => ({ status: "live" }) };
  };
  class BrowserSource {
    constructor(url) { assert.ok(new.target); this.url = url; streams.push(this); }
    addEventListener() {}
    close() {}
  }
  globalThis.EventSource = BrowserSource;
  globalThis.setTimeout = function(fn, delay) {
    assert.equal(this, globalThis);
    const key = ++nextTimer; timers.set(key, { fn, delay }); return key;
  };
  globalThis.clearTimeout = function(key) {
    assert.equal(this, globalThis);
    timers.delete(key);
  };
  // Do not inject fetch/timers/EventSource: exercise the same defaults as the page.
  const client = new WatchClient({ watchId: id, onConnection: (...args) => connections.push(args) });
  try {
    await client.start();
    assert.equal(requests.length, 1);
    assert.equal(streams.length, 1, "metadata succeeds and the browser stream is constructed");
    assert.ok(!connections.some(([state]) => state === "error"));
    assert.equal(timers.size, 1, "the native default watchdog was scheduled");
    streams[0].onerror();
    assert.equal(timers.size, 1, "retry cancels its watchdog before scheduling a timer");
    const retry = timers.get(client.retryTimer); timers.delete(client.retryTimer);
    await retry.fn();
    assert.equal(streams.length, 2);
    client.stop();
    assert.equal(timers.size, 0, "cleanup uses the native default clearTimeout");
  } finally { client.stop(); Object.assign(globalThis, original); }
});

test("watch input accepts only a complete opaque id or an HTTP watch link", () => {
  assert.equal(parseWatchId(`https://example.test/?watch=${id}`), id);
  assert.equal(parseWatchId(id.toUpperCase()), id);
  assert.equal(parseWatchId("abcd"), null);
  assert.equal(parseWatchId(`javascript:alert(1)?watch=${id}`), null);
  assert.equal(parseWatchId("https://example.test/?token=publisher"), null);
});

test("initial watch uses private metadata and replaces sparse snapshot before accepting deltas", async () => {
  const f = fixture(); await f.client.start();
  assert.deepEqual(f.requests, [`/api/live/v2/watch/${id}`]);
  assert.equal(f.streams[0].url, `/api/live/v2/watch/${id}/stream`);
  f.streams[0].emit("hello", hello());
  f.streams[0].emit("record", { epoch: 1, seq: 8, record: {} });
  f.streams[0].emit("record", { epoch: 1, seq: 9, record: {} });
  f.streams[0].emit("record", { epoch: 1, seq: 9, record: {} });
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.records.length, 1);
  assert.equal(f.client.seq, 9);
});

test("explicit reconnect carries epoch and cursor and rejects queued callbacks from the old source", async () => {
  const f = fixture(); await f.client.start();
  const old = f.streams[0]; old.emit("hello", hello());
  old.onerror(); assert.equal(old.closed, true);
  old.emit("record", { epoch: 1, seq: 9, record: {} });
  assert.equal(f.records.length, 0);
  f.runTimer(f.client.retryTimer);
  assert.equal(f.streams[1].url, `/api/live/v2/watch/${id}/stream?epoch=1&after=8`);
  f.streams[1].emit("resumed", { epoch: 1, lastSeq: 9, status: "live" });
  f.streams[1].emit("record", { epoch: 1, seq: 9, record: {} });
  assert.equal(f.records.length, 1);
});

test("a sequence gap does not silently advance the cursor or splice disconnected paths", async () => {
  const f = fixture(); await f.client.start();
  f.streams[0].emit("hello", hello());
  f.streams[0].emit("record", { epoch: 1, seq: 10, record: {} });
  assert.equal(f.client.seq, 8); assert.equal(f.records.length, 0);
  f.runTimer(f.client.retryTimer);
  assert.match(f.streams[1].url, /after=8$/);
});

test("publisher epoch takeover replaces snapshot and restarts its sequence space", async () => {
  const f = fixture(); await f.client.start();
  f.streams[0].emit("hello", hello(1, 100));
  f.streams[0].emit("hello", hello(2, 4));
  f.streams[0].emit("record", { epoch: 2, seq: 5, record: {} });
  assert.equal(f.snapshots.length, 2); assert.equal(f.client.epoch, 2); assert.equal(f.client.seq, 5);
});

test("ended sessions display their final snapshot and close instead of reconnecting forever", async () => {
  const f = fixture({ response: { ok: true, json: async () => ({ status: "ended" }) } });
  await f.client.start();
  f.streams[0].emit("hello", { ...hello(), status: "ended" });
  assert.equal(f.snapshots.length, 1); assert.equal(f.streams[0].closed, true);
  f.streams[0].onerror();
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.connections.at(-1), ["ended"]);
});

test("missing or expired links show an explicit error without opening a stream", async () => {
  const f = fixture({ response: { ok: false, status: 404 } }); await f.client.start();
  assert.equal(f.streams.length, 0);
  assert.deepEqual(f.connections.at(-1), ["error", "链接不存在或已过期"]);
});

test("silent stalled sockets reconnect with the existing cursor; leaving cancels all work", async () => {
  const f = fixture(); await f.client.start(); f.streams[0].emit("hello", hello());
  f.runTimer(f.client.watchdog); f.runTimer(f.client.watchdog); f.runTimer(f.client.watchdog);
  assert.equal(f.streams[0].closed, true);
  assert.ok(f.timers.has(f.client.retryTimer));
  f.client.stop(); assert.equal(f.timers.size, 0);
});

for (const status of [404, 410]) test(`repeated stream failures probe metadata and stop on ${status}, preserving the received snapshot`, async () => {
  let reads = 0;
  const f = fixture({ response: () => ++reads === 1
    ? { ok: true, json: async () => ({ status: "live" }) }
    : { ok: false, status } });
  await f.client.start();
  f.streams[0].emit("hello", hello());
  for (let attempt = 0; attempt < 3; attempt++) {
    f.streams.at(-1).onerror();
    await f.runTimer(f.client.retryTimer);
  }
  assert.equal(reads, 2);
  assert.equal(f.streams.length, 3, "the metadata probe prevents a fourth doomed SSE");
  assert.equal(f.client.closed, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.snapshots.length, 1, "expiry does not replace the final visible snapshot");
  assert.equal(f.client.seq, 8);
  assert.deepEqual(f.connections.at(-1), ["error", "链接不存在或已过期，已保留最后收到的路径"]);
});

test("a successful retry metadata probe resumes the same cursor instead of resetting buffered history", async () => {
  const f = fixture(); await f.client.start(); f.streams[0].emit("hello", hello());
  for (let attempt = 0; attempt < 3; attempt++) {
    f.streams.at(-1).onerror();
    await f.runTimer(f.client.retryTimer);
  }
  assert.equal(f.requests.length, 2);
  assert.equal(f.streams.length, 4);
  assert.equal(f.streams.at(-1).url, `/api/live/v2/watch/${id}/stream?epoch=1&after=8`);
  assert.equal(f.snapshots.length, 1);
});

test("leaving during a retry metadata probe cannot reopen a stream or change the visible state", async () => {
  let resolveProbe, reads = 0;
  const f = fixture({ response: () => ++reads === 1
    ? { ok: true, json: async () => ({ status: "live" }) }
    : new Promise(resolve => { resolveProbe = resolve; }) });
  await f.client.start(); f.streams[0].emit("hello", hello());
  for (let attempt = 0; attempt < 2; attempt++) {
    f.streams.at(-1).onerror(); await f.runTimer(f.client.retryTimer);
  }
  f.streams.at(-1).onerror(); const probe = f.runTimer(f.client.retryTimer);
  const connections = f.connections.length, states = f.states.length;
  f.client.stop();
  resolveProbe({ ok: false, status: 404 });
  await probe;
  assert.equal(f.connections.length, connections); assert.equal(f.states.length, states);
  assert.equal(f.streams.length, 3); assert.equal(f.timers.size, 0);
});
