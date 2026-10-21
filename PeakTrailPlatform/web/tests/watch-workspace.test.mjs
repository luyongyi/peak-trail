import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { appendLiveRecord, createLiveTrace, finalizeLiveFlush } from "../src/protocol.js";
import { trimWatchTrace } from "../src/watch-window.js";
import { parseWatchId, parseWatchCode, watchCodeFromState } from "../src/watch-client.js";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
function functions(names, ports) {
  ports = { itemEventPanel: { sync() {} }, watchText: value => value, tr: value => value, formatNumber: String, ...ports };
  return new Function(...Object.keys(ports), names.map(name => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(match, name); return match[0];
  }).join("\n") + `\nreturn {${names.join(",")}};`)(...Object.values(ports));
}
const manifest = { schemaVersion: 1, sessionId: "s", sceneName: "Level_1",
  coordinateSpace: "unity-world-meters", identityMode: "session-player-id" };
const makeTrace = (id = "p1") => {
  const trace = createLiveTrace(manifest);
  appendLiveRecord(trace, { type: "participant", playerId: id, nickname: id });
  appendLiveRecord(trace, { type: "sample", playerId: id, t: 1000, pos: [0, 0, 0] });
  return trace;
};

test("watch flush updates events, chapter progression and growing timeline while preserving scroll position", () => {
  const trace = makeTrace();
  const state = { trace, currentTime: 1, watch: { active: true, trace, dirty: true, playerKey: "" }, segmentTimeline: [] };
  appendLiveRecord(trace, { type: "event", event: "segment_change", t: 2000, activeSegment: 2 });
  const elements = { eventList: { scrollTop: 38 }, timeline: {}, totalTime: {}, sampleCount: {} };
  const calls = { events: 0, chapters: 0, tracks: 0, players: 0 };
  const api = functions(["flushWatch"], { state, elements, finalizeLiveFlush, trimWatchTrace,
    buildSegmentTimeline: trace => trace.events.filter(e => e.type === "segment_change"),
    viewer: { refreshTracks: () => calls.tracks++ }, updatePlayers: () => calls.players++,
    updateEvents: () => { calls.events++; elements.eventList.scrollTop = 0; },
    formatTime: String, updatePlaybackTime() {}, syncSegmentToPlayback: () => calls.chapters++,
    updatePlayerTelemetry() {}, updateWatchStatus() {} });
  api.flushWatch();
  assert.equal(state.segmentTimeline[0].activeSegment, 2);
  assert.equal(calls.events, 1); assert.equal(calls.chapters, 1); assert.equal(calls.tracks, 1);
  assert.equal(calls.players, 1); assert.equal(elements.eventList.scrollTop, 38);
  assert.equal(elements.timeline.max, "2");
});

test("watch snapshot asynchronously loading an old map cannot replace a newer publisher epoch", async () => {
  const first = makeTrace("old"), second = makeTrace("new");
  const state = { traceSelectionRevision: 0, watch: { active: true }, mapPack: null };
  let resolveOld;
  const oldMap = new Promise(resolve => { resolveOld = resolve; });
  const rendered = [];
  const api = functions(["applyWatchSnapshot"], { state, createLiveTrace, appendLiveRecord, finalizeLiveFlush, trimWatchTrace,
    elements: { appShell: { classList: { add() {}, remove() {} } } },
    LIVE_TRAIL_S: .3, resetSegmentNavigation() {}, viewer: { setFollowTarget() {} }, setPlaying() {},
    syncGameAssetsForTrace() {}, syncMapForTrace: trace => trace === first ? oldMap : Promise.resolve(),
    clearAutomaticMap: async () => {}, assessCompatibility: () => ({}),
    renderData: async () => rendered.push(state.trace), updateTraceUI() {}, updateMapUI() {},
    updateCompatibilityUI() {}, flushWatch() {}, updatePlaybackTime() {} });
  const oldAttach = api.applyWatchSnapshot({ epoch: 1 }, first);
  await api.applyWatchSnapshot({ epoch: 2 }, second);
  resolveOld(); await oldAttach;
  assert.equal(state.trace, second);
  assert.equal(state.watch.epoch, 2);
  assert.deepEqual(rendered, [second]);
  assert.deepEqual(state.trace.participants.map(p => p.id), ["new"]);
});

test("live time-follow is separate from paused replay and does not depend on the disabled legacy feature", () => {
  const trace = makeTrace();
  const state = { trace, watch: { active: true, trace, following: true, status: "live" }, live: {} };
  const api = functions(["isLiveFollowing"], { state, elements: {} });
  assert.equal(api.isLiveFollowing(), true);
  state.watch.following = false; assert.equal(api.isLiveFollowing(), false);
  state.watch.following = true; state.watch.status = "ended"; assert.equal(api.isLiveFollowing(), false);
  state.watch.status = "live"; state.watch.initializing = true; assert.equal(api.isLiveFollowing(), false);
});

test('ended watch snapshots expose retained Nadir facts while only confirmed durable sessions claim automatic saving', async () => {
  const { watchProgressLabel } = await import('../src/watch-window.js');
  const trace = makeTrace();
  appendLiveRecord(trace, { type: 'event', event: 'segment_change', t: 1000, activeSegment: 5 });
  appendLiveRecord(trace, { type: 'event', event: 'nadir-wall', t: 1000, playerId: 'p1', activeSegment: 5 });
  appendLiveRecord(trace, { type: 'event', event: 'nadir-chase', t: 1000, playerId: 'p1', activeSegment: 5 });
  appendLiveRecord(trace, { type: 'event', event: 'nadir', t: 2000, playerId: 'p1', activeSegment: 5 });
  appendLiveRecord(trace, { type: 'event', event: 'run_end', t: 3000, activeSegment: 5 });
  appendLiveRecord(trace, { type: 'sample', t: 200000, playerId: 'p1', pos: [1, 2, 3], activeSegment: 5 });
  finalizeLiveFlush(trace); trimWatchTrace(trace);
  trace.manifest.recorderVersion = '0.8.2';
  const state = { currentTime: trace.duration, trace,
    watch: { active: true, trace, status: 'ended', connection: 'connected', following: true } };
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, { dataset: {} }); return nodes.get(id); };
  const api = functions(['updateWatchStatus'], { state, $, watchProgressLabel, updateWatchShareUI() {},
    elements: { playButton: { classList: { toggle() {} }, setAttribute() {} } } });
  api.updateWatchStatus();
  assert.match($('watchStatusText').textContent, /直播已结束.*天底通关/);
  assert.doesNotMatch($('watchStatusText').textContent, /登顶/);
  assert.doesNotMatch($('watchTimeStatus').textContent, /自动保存/, 'recorder version alone is not persistence evidence');
  state.watch.persistence = 'memory'; api.updateWatchStatus();
  assert.doesNotMatch($('watchTimeStatus').textContent, /自动保存/);
  state.watch.persistence = 'durable'; api.updateWatchStatus();
  assert.match($('watchTimeStatus').textContent, /自动保存/);
  assert.deepEqual(trace.milestones.map(e => e.type), ['segment_change', 'nadir_wall', 'nadir_chase', 'nadir', 'run_end']);
  assert.equal(watchProgressLabel({ milestones: [{ type: 'run_end', t: 3 }] }), '攀登结束');
});

function watchNodes() {
  const nodes = new Map(), classes = new Set();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { dataset: {}, classList: { toggle() {} }, setAttribute() {} }); return nodes.get(id); };
  const appShell = { classList: { add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }, toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } } };
  return { $, classes, elements: { appShell, playButton: $('play'), segmentNavigator: $('navigator') } };
}

test('waiting UI explains airport preparation without showing a map, replay window, or persistence claim', () => {
  const f = watchNodes(), state = { currentTime: 0, trace: null, playing: false,
    watch: { active: true, awaitingRun: true, trace: null, status: 'waiting', connection: 'connected', persistence: 'durable', following: true } };
  const api = functions(['updateWatchStatus'], { ...f, state, updateWatchShareUI() {}, watchProgressLabel: () => '' });
  api.updateWatchStatus();
  assert.equal(f.classes.has('watch-empty'), true);
  assert.equal(f.$('watchStatusText').textContent, '等待主播入图');
  assert.match(f.$('watchNoticeText').textContent, /机场.*自动开始观战/);
  assert.equal(f.$('watchTimeStatus').textContent, '');
  assert.equal(f.$('watchCamera').hidden, true); assert.equal(f.$('watchTimebar').hidden, true);
  state.watch.status = 'ended'; api.updateWatchStatus();
  assert.equal(f.$('watchStatusText').textContent, '等待已结束');
  assert.equal(f.$('watchNoticeText').textContent, '等待已结束，本次尚未开始攀登');
  assert.equal(f.$('watchTimeStatus').textContent, '');
  state.watch.trace = makeTrace(); state.watch.awaitingRun = false; state.watch.status = 'live'; api.updateWatchStatus();
  assert.equal(f.classes.has('watch-empty'), false); assert.equal(f.$('watchCamera').hidden, false);
});

test('waiting does not request a wake lock, while activated live playback retains the existing policy', () => {
  const desired = [], state = { watch: { active: true, status: 'waiting', awaitingRun: true, trace: null }, live: {}, playing: false };
  const api = functions(['syncWakeLock'], { state, wakeLock: { setDesired: value => desired.push(value) }, syncWakeLockChip() {} });
  api.syncWakeLock();
  Object.assign(state.watch, { status: 'live', trace: makeTrace(), awaitingRun: false }); api.syncWakeLock();
  state.watch.status = 'ended'; api.syncWakeLock();
  assert.deepEqual(desired, [false, true, false]);
});

test('empty waiting renders clear the old scene without mounting or requesting a cached daily map', async () => {
  const f = watchNodes(), calls = [], cached = { mapPackId: 'previous-map', layers: [] };
  const state = { workspaceMode: 'watch', trace: null, mapPack: cached, usingCompatibleMap: true, segmentOptions: [1] };
  const api = functions(['renderDataNow'], { ...f, state, resolveReplayRoute: map => { assert.equal(map, null); return { layers: [] }; },
    viewer: { setData: async input => calls.push(input) }, updateEmptyState() {}, syncCommunityContext() {},
    populateSegmentControls() { throw new Error('Reserved room must not derive a chapter from the cached map'); } });
  await api.renderDataNow(); await api.renderDataNow();
  assert.deepEqual(calls, [{ mapPack: null, trace: null, useMap: false, activeSegment: null }]);
  assert.equal(state.mapPack, cached, 'cached metadata can later be matched against the real manifest');
  assert.equal(state.usingCompatibleMap, false); assert.deepEqual(state.segmentOptions, []);
  assert.equal(f.elements.segmentNavigator.hidden, true);
});

test('empty snapshots invalidate an old map selection without constructing a trace or loading a map', async () => {
  const f = watchNodes(), old = makeTrace(), state = { trace: old, traceCollection: {}, currentTime: 5, traceSelectionRevision: 7, mapRequestRevision: 8,
    watch: { active: true, trace: old, epoch: 2, initializing: true, dirty: true } };
  let renders = 0;
  const api = functions(['applyEmptyWatchSnapshot'], { ...f, state, setPlaying() {}, viewer: { setFollowTarget() {} }, updateWatchStatus() {}, syncWakeLock() {}, renderData: async () => renders++ });
  await api.applyEmptyWatchSnapshot({ status: 'waiting', epoch: 0 });
  assert.equal(state.trace, null); assert.equal(state.watch.trace, null); assert.equal(state.watch.awaitingRun, true);
  assert.equal(state.watch.epoch, 0); assert.equal(state.currentTime, 0);
  assert.equal(state.traceSelectionRevision, 8); assert.equal(state.mapRequestRevision, 9); assert.equal(renders, 1);
});

test('app keeps the waiting session and code while activation creates only the real trace and starts the existing map flow', async () => {
  const f = watchNodes(), state = { watch: {}, live: {}, mapPack: null, traceSelectionRevision: 0, mapRequestRevision: 0 };
  const id = 'a'.repeat(32), activated = [], parsed = [];
  const waiting = { status: 'waiting', epoch: 0, manifest: null, sessionId: 'session', watchCode: 'ABCD', watchId: id, lastSeq: 0, snapshotSeq: 0, snapshot: { records: [] } };
  let callbacks;
  class Client {
    constructor(options) { callbacks = options; }
    async start() { callbacks.onState(waiting); callbacks.onSnapshot(waiting); }
  }
  const api = functions(['startWatch', 'applyEmptyWatchSnapshot'], { ...f, state,
    parseWatchId, parseWatchCode, watchCodeFromState, WatchClient: Client,
    cancelWatchJoin() {}, stopWatch() {}, disconnectLive() {}, setPlaying() {}, resetSegmentNavigation() {},
    viewer: { setFollowTarget() {} }, syncWorkspaceState() {}, dismissGate() {}, renderData: async () => {},
    updateWatchStatus() {}, syncWakeLock() {}, createTrailEstimator: () => ({}), setInterval: () => 1,
    flushWatch() {}, updatePlaybackTime() {}, appendLiveRecord,
    createLiveTrace: (...args) => { parsed.push(args[0]); return createLiveTrace(...args); },
    applyWatchSnapshot: async (data, trace) => { activated.push(data); state.watch.trace = trace; state.watch.awaitingRun = false; },
    elements: { ...f.elements, modeChip: {} } });
  await api.startWatch(id, { replaceUrl: false, watchCode: 'ABCD' });
  assert.equal(parsed.length, 0); assert.equal(state.watch.awaitingRun, true); assert.equal(state.watch.code, 'ABCD');
  const client = state.watch.client;
  const live = { ...waiting, status: 'live', epoch: 1, manifest, snapshot: { records: [{ seq: 1, record: { type: 'sample', t: 1000, playerId: 'p1', pos: [1, 2, 3] } }] } };
  callbacks.onSnapshot(live); callbacks.onState(live);
  assert.equal(parsed.length, 1); assert.equal(parsed[0].sceneName, 'Level_1'); assert.equal(activated.length, 1);
  assert.equal(state.watch.client, client); assert.equal(state.watch.id, id); assert.equal(state.watch.code, 'ABCD');
  assert.equal(state.watch.awaitingRun, false); assert.equal(state.watch.trace.sampleCount, 1);
});
