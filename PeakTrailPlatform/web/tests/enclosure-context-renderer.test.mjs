import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../../vendor/three/0.180.0/build/three.module.js';
import { EnclosureContextRenderer } from '../src/enclosure-context-renderer.js';

function packFixture(letter = 'a') {
  const pack = { identityVersion: 3, mapPackId: `sha256-${letter.repeat(64)}`, gameBuildId: '25306743',
    sceneName: 'Level_17', mapSlot: 17, source: { sceneSha256: 'b'.repeat(64) },
    layers: [{ segment: 3, biome: 'Swamp' }, { segment: 4, biome: 'Swamp' }],
    route: { authority: 'serialized-map-handler', branch: 'swamp-temple', segments: [
      { index: 3, biome: 'Swamp', stageId: 'swamp', name: 'Swamp_Segment' },
      { index: 4, biome: 'Swamp', stageId: 'temple', name: 'Temple_Segment' },
    ] } };
  pack.mapEnclosures = { schemaVersion: 1, authority: 'serialized-map-enclosure', gameBuildId: pack.gameBuildId,
    mapPackId: pack.mapPackId, sceneName: pack.sceneName, mapSlot: pack.mapSlot,
    sourceSceneSha256: pack.source.sceneSha256, enclosures: [{ segment: 4,
      objectId: 'map-enclosure:Level_17:18936', sourceRootPathId: 18936, sourceRootName: 'Gloom Temple',
      geometry: `${'c'.repeat(64)}.glb.gz`, geometrySha256: 'c'.repeat(64),
      geometryUrl: `/data/maps/enclosures/${'c'.repeat(64)}.glb.gz`, geometryFormat: 'glb-instanced-v1+gzip',
      meshBounds: { min: [-100, 800, 2000], max: [100, 1300, 2200] },
      interiorReference: [7, 805, 2092.5], interiorReferenceSource: 'source-model-axis' }] };
  return pack;
}

function fixture() {
  const requests = [];
  const renderer = new EnclosureContextRenderer({ THREE,
    loadGeometry: (layer, signal, build) => new Promise((resolve, reject) => requests.push({ layer, signal, build, resolve, reject })),
    disposeObject: object => { object.userData.disposeCount = (object.userData.disposeCount || 0) + 1; object.clear(); },
  });
  const pack = packFixture();
  const selection = options => renderer.setSelection(pack, pack.layers[0], { includeContext: true,
    origin: new THREE.Vector3(10, 20, 30), ...options });
  return { renderer, requests, pack, selection };
}

test('context loads original verified geometry and preserves source segment and height-scaled origin translation', async () => {
  const { renderer, requests, pack, selection } = fixture();
  const signal = new AbortController().signal;
  const before = JSON.stringify(pack), pending = selection({ signal });
  assert.equal(renderer.bounds, null);
  assert.equal(renderer.root.visible, false);
  assert.equal(renderer.root.userData.loaded, false);
  assert.equal(renderer.root.userData.loading, true);
  const source = pack.mapEnclosures.enclosures[0];
  assert.deepEqual(requests[0].layer, { ...source, id: source.objectId });
  assert.equal(requests[0].signal, signal);
  assert.equal(requests[0].build, '25306743');
  const model = new THREE.Group(); requests[0].resolve(model);
  assert.equal(await pending, true);
  assert.equal(renderer.root.visible, true);
  assert.equal(renderer.root.userData.loaded, true);
  assert.equal(renderer.root.userData.loading, false);
  assert.deepEqual(renderer.root.userData.sourceSegments, [4]);
  assert.equal(renderer.sourceSelectionSegment, 3);
  assert.equal(renderer.root.userData.sourceSelectionSegment, 3);
  assert.deepEqual(renderer.entries, [source]);
  assert.equal(model.userData.sourceSegment, 4);
  assert.equal(model.userData.sourceEnclosure, source.objectId);
  renderer.root.scale.y = 2;
  renderer.root.updateMatrixWorld(true);
  assert.deepEqual(new THREE.Vector3(7, 805, 2092.5).applyMatrix4(model.matrixWorld).toArray(), [-3, 1570, 2062.5]);
  assert.deepEqual(renderer.bounds, source.meshBounds);
  assert.equal(JSON.stringify(pack), before);
});

test('same loaded source identity reuses the model while applying the new display origin', async () => {
  const { renderer, requests, selection } = fixture();
  const pending = selection(), model = new THREE.Group(); requests[0].resolve(model); await pending;
  assert.equal(await selection({ origin: new THREE.Vector3(15, 25, 35) }), true);
  assert.equal(requests.length, 1);
  assert.equal(renderer.root.children[0], model);
  assert.deepEqual(model.position.toArray(), [-15, -25, -35]);
  assert.equal(model.userData.disposeCount, undefined);
});

test('overview or the Citadel selection immediately releases contextual geometry and loads no duplicate shell', async () => {
  const { renderer, requests, pack, selection } = fixture();
  assert.equal(await renderer.setSelection(pack, pack.layers[0], { includeContext: false }), false);
  assert.equal(requests.length, 0);
  const pending = selection(), model = new THREE.Group(); requests[0].resolve(model); await pending;
  const overview = renderer.setSelection(pack, null, { includeContext: true });
  assert.equal(renderer.root.visible, false);
  assert.equal(renderer.root.children.length, 0);
  assert.equal(renderer.root.userData.loading, false);
  assert.equal(renderer.root.userData.loaded, false);
  assert.equal(renderer.bounds, null);
  assert.deepEqual(renderer.entries, []);
  assert.equal(renderer.sourceSelectionSegment, null);
  assert.equal(model.userData.disposeCount, 1);
  assert.equal(await overview, false);
  assert.equal(await renderer.setSelection(pack, pack.layers[1], { includeContext: true }), false);
  assert.equal(requests.length, 1);
});

test('quick Swamp to overview to Swamp disposes the late first model and mounts the current selection once', async () => {
  const { renderer, requests, pack, selection } = fixture();
  const first = selection();
  await renderer.setSelection(pack, null, { includeContext: false });
  const latest = selection(), oldModel = new THREE.Group(), newModel = new THREE.Group();
  requests[1].resolve(newModel); assert.equal(await latest, true);
  requests[0].resolve(oldModel); assert.equal(await first, false);
  assert.equal(oldModel.userData.disposeCount, 1);
  assert.equal(newModel.userData.disposeCount, undefined);
  assert.deepEqual(renderer.root.children, [newModel]);
  assert.equal(renderer.root.userData.loaded, true);
});

test('changing the source scene invalidates a pending result even when the enclosure GLB is shared', async () => {
  const { renderer, requests, selection } = fixture();
  const first = selection(), nextPack = packFixture('d');
  const latest = renderer.setSelection(nextPack, nextPack.layers[0], { includeContext: true });
  const oldModel = new THREE.Group(), nextModel = new THREE.Group();
  requests[0].resolve(oldModel); assert.equal(await first, false);
  assert.equal(oldModel.userData.disposeCount, 1);
  requests[1].resolve(nextModel); assert.equal(await latest, true);
  assert.deepEqual(renderer.root.children, [nextModel]);
  assert.equal(renderer.root.userData.mapPackId, nextPack.mapPackId);
});

test('isCurrent rejects obsolete caller results without attaching geometry or reporting their failures', async () => {
  const { renderer, requests, selection } = fixture();
  let current = true;
  const first = selection({ isCurrent: () => current });
  current = false;
  const late = new THREE.Group(); requests[0].resolve(late);
  assert.equal(await first, false);
  assert.equal(late.userData.disposeCount, 1);
  assert.equal(renderer.root.visible, false);
  assert.equal(renderer.root.children.length, 0);
  assert.equal(await selection({ isCurrent: () => false }), false);
  assert.equal(requests.length, 1);
  current = true;
  const second = selection({ isCurrent: () => current });
  current = false; requests[1].reject(new Error('obsolete request'));
  assert.equal(await second, false);
  assert.equal(renderer.root.userData.loading, false);
});

test('an obsolete request failure cannot hide a newer loaded selection', async () => {
  const { renderer, requests, pack, selection } = fixture();
  const first = selection();
  await renderer.setSelection(pack, null);
  const second = selection(), currentModel = new THREE.Group();
  requests[1].resolve(currentModel); await second;
  requests[0].reject(new Error('obsolete request'));
  assert.equal(await first, false);
  assert.equal(renderer.root.visible, true);
  assert.equal(renderer.root.userData.loaded, true);
  assert.deepEqual(renderer.root.children, [currentModel]);
});

test('an aborted current selection releases its parsed result and propagates AbortError', async () => {
  const { renderer, requests, selection } = fixture();
  const controller = new AbortController(), model = new THREE.Group();
  const pending = selection({ signal: controller.signal });
  controller.abort(); requests[0].resolve(model);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(model.userData.disposeCount, 1);
  assert.equal(renderer.root.visible, false);
  assert.equal(renderer.root.userData.loaded, false);
  assert.equal(renderer.root.userData.loading, false);
});

test('a current geometry failure propagates for status reporting and leaves no loaded context', async () => {
  const { renderer, requests, selection } = fixture();
  const pending = selection(), error = new Error('verified enclosure unavailable');
  requests[0].reject(error);
  await assert.rejects(pending, error);
  assert.equal(renderer.root.visible, false);
  assert.equal(renderer.root.userData.loaded, false);
  assert.equal(renderer.root.userData.loading, false);
  assert.equal(renderer.root.children.length, 0);
  const retry = selection(), model = new THREE.Group(); requests[1].resolve(model);
  assert.equal(await retry, true);
});

test('clear and dispose invalidate parsing work and release models exactly once', async () => {
  const { renderer, requests, selection } = fixture();
  const first = selection(), firstModel = new THREE.Group();
  renderer.clear(); requests[0].resolve(firstModel);
  assert.equal(await first, false);
  assert.equal(firstModel.userData.disposeCount, 1);
  const second = selection(), secondModel = new THREE.Group(); requests[1].resolve(secondModel); await second;
  renderer.clear(); renderer.clear();
  assert.equal(secondModel.userData.disposeCount, 1);
  const third = selection(), late = new THREE.Group(); renderer.dispose(); requests[2].resolve(late);
  assert.equal(await third, false);
  assert.equal(late.userData.disposeCount, 1);
  assert.equal(renderer.root.visible, false);
  assert.equal(await selection(), false);
  assert.equal(requests.length, 3);
});

test('bounds unions only loaded visible context in original source coordinates and returns independent arrays', async () => {
  const { renderer, requests, pack, selection } = fixture();
  const first = pack.mapEnclosures.enclosures[0];
  const second = { ...first, objectId: 'map-enclosure:Level_17:19000', sourceRootPathId: 19000,
    meshBounds: { min: [-200, 750, 1900], max: [120, 1400, 2300] } };
  pack.mapEnclosures.enclosures.push(second);
  const pending = selection();
  assert.equal(renderer.bounds, null);
  requests[0].resolve(new THREE.Group());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renderer.bounds, null);
  requests[1].resolve(new THREE.Group()); await pending;
  assert.deepEqual(renderer.bounds, { min: [-200, 750, 1900], max: [120, 1400, 2300] });
  const bounds = renderer.bounds; bounds.min[0] = -99999;
  assert.equal(renderer.bounds.min[0], -200);
  renderer.root.visible = false;
  assert.equal(renderer.bounds, null);
  renderer.root.visible = true; renderer.clear();
  assert.equal(renderer.bounds, null);
  assert.deepEqual(renderer.entries, []);
  assert.equal(renderer.sourceSelectionSegment, null);
});
