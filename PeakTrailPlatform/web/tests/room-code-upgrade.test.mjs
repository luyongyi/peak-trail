import assert from "node:assert/strict";
import test from "node:test";
import { NavigationClient, PacketRecorder, validRoom, validCurrentRoom, capturePresentation } from "../src/packet-recorder.js";
import { parseCaptureId } from "../src/packet-watch-client.js";
import { parseReplaySearch } from "../src/replay-search.js";

const legacy = "DRXPTJ", current = "DYILUS97", feature = "A".repeat(20);
const capture = (roomCode, status = "completed") => ({ roomCode, featureCode: feature, status,
  bytes: 120, events: 2, archiveAvailable: status === "completed", hostName: "Host",
  startedUtc: "2026-11-16T00:00:00Z", completedUtc: status === "completed" ? "2026-11-16T00:01:00Z" : null });
const response = value => ({ ok: true, status: 200, json: async () => value });

function fixture(handler, Client = NavigationClient) {
  const calls = [], stored = new Map(), timers = new Map();
  let next = 0;
  const client = new Client({ storage: { getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
  fetchImpl: async (path, options) => { calls.push({ path, ...options }); return response(await handler(path, options)); },
  makeId: () => "test-request-upgrade-00001", setTimer: fn => { const id = ++next; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id) });
  return { client, calls, stored };
}

test("current admission and retained identity use distinct bounded room-code rules", () => {
  for (const room of [legacy, current]) {
    assert.equal(validRoom(room), true);
    assert.equal(parseCaptureId(`${room.toLowerCase()}.${feature}`), `${room}.${feature}`);
    assert.equal(capturePresentation(capture(room), { operator: false }).download, `/api/navigation/replays/${room}/${feature}/archive.zip`);
  }
  assert.equal(validCurrentRoom(legacy), false); assert.equal(validCurrentRoom(current), true);
  for (const room of ["DYILUS90", "D1ILUS97", "QYILUS97", "DYILUS9", "DYILUS977", "DY/../97", current + "\n"])
    assert.equal(validRoom(room), false, room);
});

test("fresh navigation requests no global listing; empty legacy lookup never joins", async t => {
  const f = fixture(path => path.endsWith("/session") ? { configured: true, captures: [] }
    : { roomCode: legacy, active: null, history: [], hasMore: false });
  t.after(() => f.client.dispose());
  await f.client.initialize();
  assert.deepEqual(f.calls.map(call => call.path), ["/api/navigation/session"]);
  assert.equal(await f.client.findRoom(" drxptj "), true);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/navigation/session", "/api/navigation/rooms/lookup"]);
  assert.equal(f.client.state.pendingRoom, null);
  assert.match(f.client.state.error, /旧房间.*8 位/);
});

test("legacy lookup recovers an archive; direct admission rejects old codes before requesting", async t => {
  const f = fixture(path => path.endsWith("/session") ? { configured: true, captures: [] }
    : { roomCode: legacy, active: null, history: [capture(legacy)], hasMore: false });
  t.after(() => f.client.dispose()); await f.client.initialize();
  assert.equal(await f.client.findRoom(legacy), true);
  assert.equal(f.client.state.capture.roomCode, legacy);
  assert.equal(f.client.state.navigationHistory[0].roomCode, legacy);
  const before = f.calls.length;
  assert.equal(await f.client.start(legacy), false);
  assert.equal(f.calls.length, before);
  assert.match(f.client.state.error, /旧 6 位仅用于查询/);
});

test("entering a reused room code starts the new capture even when an archive exists", async t => {
  const old = { ...capture(current), featureCode: "ABBCCDD0011223344556" };
  const f = fixture(path => path.endsWith("/session") ? { configured: true, captures: [] }
    : path.endsWith("/lookup") ? { roomCode: current, active: null, history: [old], hasMore: false }
    : { capture: capture(current, "recording"), reused: false });
  t.after(() => f.client.dispose()); await f.client.initialize();
  assert.equal(await f.client.findRoom(current.toLowerCase()), true);
  assert.equal(f.client.state.capture.featureCode, old.featureCode);
  assert.equal(f.calls.some(call => call.path === "/api/navigation/rooms"), false);
  assert.equal(await f.client.findRoom(current.toLowerCase(), { enter: true }), true);
  assert.equal(f.client.state.capture.featureCode, feature);
  assert.equal(f.client.state.roomResult.history[0].featureCode, old.featureCode);
  assert.equal(await f.client.start(current), true);
  assert.equal(f.client.state.reused, true);
  const starts = f.calls.filter(call => call.path === "/api/navigation/rooms");
  assert.equal(starts.length, 1); assert.deepEqual(JSON.parse(starts[0].body), { roomCode: current });
});

test("entering a shared room selects the live capture and does not start it again", async t => {
  const f = fixture(path => path.endsWith("/session") ? { configured: true, captures: [] }
    : { roomCode: current, active: capture(current, "recording"), history: [], hasMore: false });
  t.after(() => f.client.dispose()); await f.client.initialize();
  assert.equal(await f.client.findRoom(current, { enter: true }), true);
  assert.equal(f.client.state.capture.status, "recording");
  assert.equal(f.client.state.reused, true);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/navigation/session", "/api/navigation/rooms/lookup"]);
});

test("administrator cannot create an old room, but restored identities still locate it", async t => {
  const f = fixture(path => path.endsWith("/session") ? { configured: true, authenticated: true } : capture(legacy), PacketRecorder);
  t.after(() => f.client.dispose()); await f.client.initialize();
  const before = f.calls.length; assert.equal(await f.client.start(legacy), false); assert.equal(f.calls.length, before);
  assert.equal(await f.client.lookup(legacy, feature), true);
  assert.equal(f.calls.at(-1).path, `/api/packet-replay/captures/${legacy}/${feature}`);
});

test("nickname lists and local navigation history preserve both generations", async t => {
  const results = [capture(legacy), { ...capture(current), zipBytes: 800 }].map(item => ({ ...item, zipBytes: 800 }));
  assert.deepEqual(parseReplaySearch({ hostName: "Host", history: results, hasMore: false }, "Host").history.map(item => item.roomCode), [legacy, current]);
  const f = fixture(() => ({ configured: true, captures: [] })); t.after(() => f.client.dispose());
  f.stored.set("peak-navigation:history", JSON.stringify(results));
  assert.deepEqual(f.client.loadHistory().map(item => item.roomCode), [legacy, current]);
});
