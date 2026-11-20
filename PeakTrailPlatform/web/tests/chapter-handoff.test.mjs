import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../../vendor/three/0.180.0/build/three.module.js';
import { ChapterHandoff } from '../src/chapter-handoff.js';
import { ChapterSupportGeometry } from '../src/chapter-support-geometry.js';
import { FollowTerrainQuery } from '../src/follow-terrain.js';

// Native metres, translated origin, reflected Z and a stretched height axis.
const bounds = { min: [-20, 0, -20], max: [20, 2, 20] };
const sample = (x = 0) => ({ pos: [x, 1, 0], activeSegment: 1 });
function floor(x = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 12), new THREE.MeshBasicMaterial());
  mesh.position.set(x, -.5, 0);
  return mesh;
}
function fixture({ warm = false } = {}) {
  const terrainRoot = new THREE.Group(), origin = new THREE.Vector3(1, 7, -3);
  terrainRoot.scale.set(1, 2, -1);
  const [old, current] = [0, 1].map(segment => {
    const group = new THREE.Group();
    group.userData = { segment, loaded: segment === 1 || warm, mapLayer: { segment, meshBounds: bounds } };
    terrainRoot.add(group);
    return group;
  });
  function source() { const result = new THREE.Group(); result.add(floor()); return result; }
  function mount(group, model) { model.position.copy(origin).negate(); group.add(model); }
  if (warm) mount(old, source());
  const remoteFloor = new THREE.Group(); remoteFloor.add(floor(12)); mount(current, remoteFloor);
  const query = new FollowTerrainQuery(THREE).setRoots([current]);
  const requests = [], disposed = [];
  const viewer = {
    useMap: true, trace: {}, mapPack: { identityVersion: 3 }, activeSegment: 1, terrainRoot, heightScale: 2, origin,
    chapterSupport: new ChapterSupportGeometry(THREE), currentTerrainQuery: () => query,
    loadChapterGeometry(layer, signal) { return new Promise((resolve, reject) => requests.push({ layer, signal, resolve, reject })); },
  };
  const handoff = new ChapterHandoff(viewer, THREE, model => disposed.push(model));
  return { viewer, handoff, requests, disposed, source, support: viewer.chapterSupport };
}

test('advancing team keeps its real old campfire until the last nearby player reaches new terrain', () => {
  const { handoff, requests, support } = fixture({ warm: true });
  handoff.update([sample(), sample(2)], true);
  assert.deepEqual(support.sourceGrounded, [true, true]);
  handoff.update([sample(12), sample(2)], true);
  assert.equal(support.hasSupport, true);
  handoff.update([sample(12)], true);
  assert.equal(support.hasSupport, false);
  assert.equal(requests.length, 0);
});

test('opening or seeking into a campfire loads only the predecessor and releases its full source', async () => {
  const { handoff, requests, support, disposed, source, viewer } = fixture();
  handoff.update([sample(12)], true); // already on current terrain
  handoff.update([sample(99)], true); // outside previous bounds
  handoff.update([{ ...sample(), activeSegment: 0 }], true); // browsing another chapter
  assert.equal(requests.length, 0);
  handoff.update([sample()], true);
  handoff.update([sample()], true);
  assert.deepEqual(requests.map(r => r.layer.segment), [0]);
  const model = source(); requests[0].resolve(model);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.parent, null);
  assert.deepEqual(disposed, [model]);
  assert.equal(viewer.terrainRoot.children[0].children.length, 0);
  assert.deepEqual(support.sourceGrounded, [true]);
  handoff.update([sample()], true);
  assert.equal(requests.length, 1);
  handoff.update([], true);
  assert.equal(support.hasSupport, false);
});

test('a canceled source cannot overwrite the next seek or leak a full model', async () => {
  const { handoff, requests, support, disposed, source } = fixture();
  handoff.update([sample()], true);
  handoff.reset();
  handoff.update([sample()], true);
  assert.equal(requests[0].signal.aborted, true);
  const stale = source(), latest = source();
  requests[0].resolve(stale);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(support.hasSupport, false);
  requests[1].resolve(latest);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(disposed, [stale, latest]);
  assert.equal(support.hasSupport, true);
});

test('a partial replacement for a later arrival preserves an occupied campfire', async () => {
  const { viewer, handoff, requests, support, disposed } = fixture({ warm: true });
  handoff.update([sample()], true);
  assert.equal(support.hasSupport, true);
  const old = viewer.terrainRoot.children[0];
  old.clear(); old.userData.loaded = false;
  handoff.update([sample(), sample(-12)], true);
  const incomplete = new THREE.Group(); incomplete.add(floor(-12));
  requests[0].resolve(incomplete);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(viewer.chapterSupport, support);
  assert.equal(support.hasSupport, true);
  assert.deepEqual(disposed, [incomplete]);
});
