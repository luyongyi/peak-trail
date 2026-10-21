import test from 'node:test';
import assert from 'node:assert/strict';
import { createItemEventPanel } from '../src/item-event-panel.js';
import { setLocale } from '../src/i18n.js';
const hash = n => n.toString(16).padStart(64, '0');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Element extends EventTarget {
  constructor() { super(); this.attributes = {}; this.hidden = false; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
}
function harness(options = {}) {
  const nodes = new Map(), root = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); } };
  let context = { enabled: false }, input;
  const scene = { setItemEvents(value) { input = value; }, selectItemEvent() {}, focusItemEvent() {} };
  const panel = createItemEventPanel({ root, getContext: () => context, getScene: () => scene, loadAssets: async () => null, ...options });
  return { panel, nodes, scene, setContext(value) { context = value; panel.sync(); }, get input() { return input; } };
}
const history = { enabled: true, live: false, ready: true, teamId: hash(1), groupId: hash(2), teamRevision: hash(3), mapPackId: `sha256-${hash(4)}`, alignmentId: hash(5), stageIndex: 2 };
const body = { ...history, mapCompatibility: 'matched', mapAlignment: { id: history.alignmentId, status: 'verified' }, coordinateSpace: 'canonical-map-world-cm', events: [{ id: hash(8), kind: 'item-spawn', tMs: 1000, stageIndex: 2, positionCm: [100, 200, 300], item: { name: 'Shelf' } }], truncated: false, nextCursor: null };

test('a late historical request cannot overwrite live facts or restore a cleared home screen', async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const h = harness({ fetchImpl: () => pending });
  h.setContext(history);
  const live = [{ id: hash(9), item: { name: 'Cloud' } }];
  h.setContext({ enabled: true, live: true, trace: { itemEvents: live }, stageIndex: 2 });
  resolve({ ok: true, text: async () => JSON.stringify(body) }); await tick();
  assert.deepEqual(h.input.events, live);
  h.setContext({ enabled: false }); assert.equal(h.input.enabled, false); assert.deepEqual(h.input.events, []);
  assert.equal(h.nodes.get('itemEventsToggle').hidden, true); h.panel.dispose();
});

test('exact-build asset loading cannot attach an old build after a newer scene; fallback requires matching build', async () => {
  let resolveOld;
  const old = new Promise(done => { resolveOld = done; });
  const h = harness({ loadAssets: build => build === 'old' ? old : Promise.resolve(null) });
  h.setContext({ enabled: true, live: true, trace: {}, gameBuildId: 'old' });
  h.setContext({ enabled: true, live: true, trace: {}, gameBuildId: 'new', fallbackPack: { gameBuildId: 'old' } });
  await tick(); assert.equal(h.input.pack, null);
  resolveOld({ gameBuildId: 'old' }); await tick(); assert.equal(h.input.pack, null);
  h.panel.dispose();
});

test('locale changes update controls without fetching again and memory-only sessions make no saving claim', async () => {
  let calls = 0;
  const h = harness({ fetchImpl: async () => { ++calls; return { ok: true, text: async () => JSON.stringify(body) }; } });
  h.setContext(history); await tick(); assert.equal(calls, 1); assert.equal(h.input.events.length, 1);
  setLocale('en'); assert.equal(h.nodes.get('itemEventsToggle').textContent, 'Item events'); assert.equal(calls, 1);
  setLocale('zh-CN');
  h.setContext({ enabled: true, live: true, trace: { itemEvents: [], itemEventsTruncated: true }, persistence: 'memory' });
  assert.doesNotMatch(h.nodes.get('itemEventStatus').textContent, /保存/);
  h.nodes.get('itemEventsToggle').dispatchEvent(new Event('click')); assert.equal(h.input.enabled, false);
  h.panel.dispose();
});

test('a same-build regular asset pack arriving after a dedicated-pack miss becomes available without cross-build substitution', async () => {
  const h = harness(), trace = {};
  h.setContext({ enabled: true, live: true, trace, gameBuildId: 'old' }); await tick();
  assert.equal(h.input.pack, null);
  const fallbackPack = { gameBuildId: 'old' };
  h.setContext({ enabled: true, live: true, trace, gameBuildId: 'old', fallbackPack });
  assert.equal(h.input.pack, fallbackPack); h.panel.dispose();
});

test('dedicated asset miss resolves against the current exact-build fallback instead of its stale request context', async () => {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const h = harness({ loadAssets: () => pending }), trace = {}, fallbackPack = { gameBuildId: 'old' };
  h.setContext({ enabled: true, live: true, trace, gameBuildId: 'old' });
  h.setContext({ enabled: true, live: true, trace, gameBuildId: 'old', fallbackPack });
  resolve(null); await tick(); assert.equal(h.input.pack, fallbackPack); h.panel.dispose();
});
