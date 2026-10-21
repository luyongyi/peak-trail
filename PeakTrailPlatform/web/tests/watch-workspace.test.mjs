import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { appendLiveRecord, createLiveTrace, finalizeLiveFlush } from "../src/protocol.js";
import { trimWatchTrace } from "../src/watch-window.js";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
function functions(names, ports) {
  ports = { watchText: value => value, tr: value => value, formatNumber: String, ...ports };
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
