import test from 'node:test';
import assert from 'node:assert/strict';
import { appendLiveRecord, createLiveTrace, finalizeLiveFlush } from '../src/protocol.js';
import { trimWatchTrace } from '../src/watch-window.js';
import { normalizeItemEvent, retainLiveItemEvents, relatedUseEvent, visibleItemEvents, loadTeamItemEvents } from '../src/item-events.js';

const hash = n => Number(n).toString(16).padStart(64, '0');
const raw = (n, extra = {}) => ({ id: hash(n), kind: 'item-spawn', actionId: hash(5000), tMs: n, stageIndex: 2, positionCm: [100, 507500, 200], item: { itemId: 42, name: 'Shelf', prefabName: 'ShelfShroomSpawn' }, playerKey: hash(99), ...extra });
const event = (n, extra) => normalizeItemEvent(raw(n, extra));
const context = { teamId: hash(1), groupId: hash(2), teamRevision: hash(3), mapPackId: `sha256-${hash(4)}`, alignmentId: hash(5), stageIndex: 2 };
const page = (values, cursor = null, extra = {}) => ({ teamId: context.teamId, groupId: context.groupId, teamRevision: context.teamRevision, mapPackId: context.mapPackId, stageIndex: 2, mapCompatibility: 'matched', mapAlignment: { id: context.alignmentId, status: 'verified' }, coordinateSpace: 'canonical-map-world-cm', events: values, nextCursor: cursor, truncated: false, ...extra });
const response = body => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) });

test('item facts require explicit kinds, bounded real positions and stable ids; unknown actors stay unknown', () => {
  assert.deepEqual(event(1).pos, [1, 5075, 2]);
  assert.equal(normalizeItemEvent(raw(1, { kind: 'inventory' })), null);
  for (const extra of [{ id: 'x' }, { actionId: 'x' }, { positionCm: [NaN, 0, 0] }, { positionCm: [1.5, 0, 0] }, { positionCm: [1e10, 0, 0] }, { tMs: -1 }, { stageIndex: 64 }, { item: { name: '\u0000' } }]) assert.equal(normalizeItemEvent(raw(1, extra)), null);
  assert.equal(event(1, { playerKey: null, playerName: 'guess' }).playerName, null);
});

test('live use and spawn survive the 120-second path trim with their IDs and actual positions', () => {
  const trace = createLiveTrace({ schemaVersion: 1, sessionId: 'session', sceneName: 'Level_0', coordinateSpace: 'unity-world-meters', identityMode: 'session-player-id' });
  appendLiveRecord(trace, { type: 'event', event: 'item-use', id: hash(1), actionId: hash(5000), t: 1000, playerId: 'p1', activeSegment: 2, pos: [1, 5075, 2], item: { itemId: 42 } });
  appendLiveRecord(trace, { type: 'event', event: 'item-spawn', id: hash(2), actionId: hash(5000), t: 1100, playerId: 'p1', activeSegment: 2, pos: [4, 5075, 5], item: { itemId: 42, prefabName: 'ShelfShroomSpawn' } });
  appendLiveRecord(trace, { type: 'sample', t: 200000, playerId: 'p1', pos: [0, 0, 0] });
  finalizeLiveFlush(trace); trimWatchTrace(trace);
  assert.equal(trace.events.some(e => e.type === 'item_spawn'), false);
  assert.deepEqual(trace.itemEvents.map(e => e.kind), ['item-use', 'item-spawn']);
  assert.deepEqual(relatedUseEvent(trace.itemEvents, trace.itemEvents[1]).pos, [1, 5075, 2]);
  assert.equal(visibleItemEvents(trace.itemEvents).length, 1);
  trimWatchTrace(trace); assert.equal(trace.itemEvents.length, 2);
  const nextEpoch = { events: [], duration: 0 }; retainLiveItemEvents(nextEpoch); assert.deepEqual(nextEpoch.itemEvents, []);
});

test('long live runs and sparse visible markers have hard bounds, without fabricating use associations', () => {
  const trace = { itemEvents: Array.from({ length: 1300 }, (_, i) => event(i + 1)), events: [] };
  retainLiveItemEvents(trace); assert.equal(trace.itemEvents.length, 1024); assert.equal(trace.itemEventsTruncated, true);
  assert.equal(visibleItemEvents(trace.itemEvents).length, 512);
  assert.equal(visibleItemEvents(trace.itemEvents, { visiblePlayers: new Set() }).length, 0);
  assert.equal(visibleItemEvents(trace.itemEvents, { stageIndex: 1 }).length, 0);
  assert.equal(visibleItemEvents(trace.itemEvents, { timeMs: 0 }).length, 0);
  const use = event(1, { kind: 'item-use' });
  assert.equal(relatedUseEvent([use], event(2, { stageIndex: 1 })), null);
  assert.equal(relatedUseEvent([use], event(2, { playerKey: hash(100) })), null);
  assert.equal(relatedUseEvent([use], event(2, { actionId: hash(5001) })), null);
  assert.equal(visibleItemEvents(Array.from({ length: 50 }, (_, i) => event(i + 1, { kind: 'item-use', actionId: null }))).length, 32);
});

test('historical pagination rejects revision/map drift and repeated cursors rather than mixing teams', async () => {
  const urls = [], pages = [page([raw(1)], hash(1)), page([raw(2)])];
  const result = await loadTeamItemEvents(context, { fetchImpl: async url => { urls.push(url); return response(pages.shift()); } });
  assert.equal(result.events.length, 2); assert.equal(result.truncated, false); assert.match(urls[1], new RegExp(`cursor=${hash(1)}`));
  for (const extra of [{ teamRevision: hash(8) }, { mapPackId: 'other' }, { coordinateSpace: 'unity-world-meters' }, { mapAlignment: { id: hash(8), status: 'verified' } }, { stageIndex: 3 }]) {
    await assert.rejects(loadTeamItemEvents(context, { fetchImpl: async () => response(page([raw(1)], null, extra)) }));
  }
  await assert.rejects(loadTeamItemEvents(context, { fetchImpl: async () => response(page([raw(1)], hash(1))) }));
});

test('byte-limited uneven final pages disclose discarded markers even when no next cursor remains', async () => {
  const counts = [400, 400, 300]; let n = 0;
  const result = await loadTeamItemEvents(context, { fetchImpl: async () => {
    const count = counts.shift(), values = Array.from({ length: count }, () => raw(++n));
    return response(page(values, counts.length ? hash(n) : null));
  } });
  assert.equal(n, 1100); assert.equal(result.events.length, 1024); assert.equal(result.truncated, true);
});
