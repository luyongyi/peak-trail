import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from '../../vendor/three/0.180.0/build/three.module.js';
import { createNativeCampfireMatcher, nativeCampfireSpec, retainNativeCampfire } from '../src/native-campfire.js';
import { loadCampfireSourceData } from '../src/campfire-source-data.js';

const mapPackId = 'sha256-' + 'a'.repeat(64);
const geometrySha256 = 'b'.repeat(64);
const template = { sourceRootName: 'Beach_Campfire', instanceCount: 4, ranges: [[1, 3, 2], [1, 7, 1], [9, 0, 1]] };
const index = { byGeometry: { [geometrySha256]: 'beach' },
  templates: { beach: template } };
const pack = { mapPackId, gameBuildId: '26542162', identityVersion: 3 };
const layer = { segment: 0, geometrySha256 };

test('shared renderer selection is bound to the verified build, original GLB and a campfire chapter', () => {
  assert.equal(nativeCampfireSpec(index, pack, layer), template);
  assert.equal(nativeCampfireSpec(index, { ...pack, gameBuildId: '26155610' }, layer), template);
  assert.equal(nativeCampfireSpec(index, { ...pack, gameBuildId: '25306743' }, layer), null);
  assert.equal(nativeCampfireSpec(index, { ...pack, mapPackId: '' }, layer), null);
  assert.equal(nativeCampfireSpec(index, pack, { ...layer, geometrySha256: 'f'.repeat(64) }), null);
  assert.equal(nativeCampfireSpec(index, pack, { ...layer, segment: 4 }), null);
  assert.equal(nativeCampfireSpec({ ...index, byGeometry: { [geometrySha256]: null } }, pack, layer), null);
  assert.equal(nativeCampfireSpec(null, pack, layer), null);
});

test('cold node filters and resident instance masks use the same source indices', () => {
  const matcher = createNativeCampfireMatcher(template);
  assert.equal(matcher.includedInNextEnclosure, false);
  const contained = createNativeCampfireMatcher({ ...template, includedInNextEnclosure: true, enclosureSha256: 'd'.repeat(64) });
  assert.equal(contained.includedInNextEnclosure, true);
  assert.equal(contained.enclosureSha256, 'd'.repeat(64));
  assert.equal(createNativeCampfireMatcher({ ...template, includedInNextEnclosure: true }), null);
  assert.equal(matcher.includesNode(1), true);
  assert.equal(matcher.includesNode(9), true);
  assert.equal(matcher.includesNode(2), false);
  assert.deepEqual([0, 2, 3, 4, 5, 6, 7, 8].map(i => matcher.matches(1, i)),
    [false, false, true, true, false, false, true, false]);
  assert.equal(matcher.matches(9), true);
  assert.equal(matcher.matches(2), false);
  assert.equal(createNativeCampfireMatcher({ ...template, instanceCount: 5 }), null);
  assert.equal(createNativeCampfireMatcher({ ...template, instanceCount: 2, ranges: [[1, 0, 1], [1, 0, 1]] }), null);
  assert.equal(createNativeCampfireMatcher({ ...template, ranges: [[1, 2, 0], ...template.ranges] }), null);
});

function countDisposals(resource) {
  let count = 0;
  resource.addEventListener('dispose', () => count++);
  return () => count;
}

test('pruning a chapter retains complete campfire instances, their shader, and original transforms', () => {
  const root = new THREE.Group(), model = new THREE.Group(), discardedEnclosure = new THREE.Group();
  root.add(model, discardedEnclosure);
  model.position.set(2, 4, -10); model.scale.set(1, 2, -1);
  const sharedGeometry = new THREE.BoxGeometry(), onlyOldGeometry = new THREE.SphereGeometry();
  const texture = new THREE.Texture(), onlyOldTexture = new THREE.Texture();
  const sharedMaterial = new THREE.MeshStandardMaterial({ map: texture });
  const oldMaterial = new THREE.MeshStandardMaterial({ map: texture, alphaMap: onlyOldTexture });
  sharedMaterial.onBeforeCompile = () => {};
  const keep = new THREE.InstancedMesh(sharedGeometry, sharedMaterial, 2);
  keep.userData.nativeCampfire = true;
  keep.setMatrixAt(0, new THREE.Matrix4().makeTranslation(80, 0, -12));
  keep.setMatrixAt(1, new THREE.Matrix4().makeRotationY(1.2));
  const drop = new THREE.InstancedMesh(sharedGeometry, [oldMaterial, sharedMaterial], 3);
  model.add(keep, drop);
  discardedEnclosure.add(new THREE.Mesh(onlyOldGeometry, oldMaterial));
  const kept = [keep, sharedMaterial, sharedGeometry, texture].map(countDisposals);
  const removed = [drop, oldMaterial, onlyOldGeometry, onlyOldTexture].map(countDisposals);
  root.updateWorldMatrix(true, true);
  const oldMatrix = keep.matrixWorld.clone(), oldInstances = keep.instanceMatrix, originalShader = sharedMaterial.onBeforeCompile;
  assert.deepEqual(retainNativeCampfire(root), { batches: 1, instances: 2 });
  root.updateWorldMatrix(true, true);
  assert.deepEqual(root.children, [model]);
  assert.deepEqual(model.children, [keep]);
  assert.equal(keep.geometry, sharedGeometry);
  assert.equal(keep.material.onBeforeCompile, originalShader);
  assert.equal(keep.instanceMatrix, oldInstances);
  assert.deepEqual(keep.matrixWorld, oldMatrix);
  assert.deepEqual(kept.map(read => read()), [0, 0, 0, 0]);
  assert.deepEqual(removed.map(read => read()), [1, 1, 1, 1]);
  assert.deepEqual(retainNativeCampfire(root), { batches: 1, instances: 2 });
  assert.deepEqual(removed.map(read => read()), [1, 1, 1, 1]);
});

test('unclassified source layers release their whole model', () => {
  const root = new THREE.Group(), model = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const disposed = countDisposals(mesh.geometry);
  model.add(mesh); root.add(model);
  assert.deepEqual(retainNativeCampfire(root), { batches: 0, instances: 0 });
  assert.deepEqual(root.children, []);
  assert.equal(disposed(), 1);
});

test('all 208 verified maps bind each crossover to complete source instances or the existing Citadel exterior', async () => {
  const maps = new URL('../../data/maps/', import.meta.url);
  const catalog = JSON.parse(await readFile(new URL('catalog.json', maps), 'utf8'));
  const enclosures = JSON.parse(await readFile(new URL('enclosures.26542162.json', maps), 'utf8'));
  const entries = catalog.mapPacks.filter(item => String(item.gameBuildId) === '26542162');
  assert.equal(entries.length, 208);
  const packs = await Promise.all(entries.map(async item => JSON.parse(await readFile(
    new URL(`verified-builds/26542162/manifests/${item.mapPackId}/map-pack.json`, maps), 'utf8'))));
  let nativeCampfires = 0, containedInExterior = 0;
  for (const map of packs) {
    const index = await loadCampfireSourceData(map);
    assert.ok(index, map.sceneName);
    for (const source of map.layers.filter(item => item.segment < 4)) {
      const label = `${map.sceneName} chapter ${source.segment}`;
      assert.ok(Object.hasOwn(index.byGeometry, source.geometrySha256), label);
      const spec = nativeCampfireSpec(index, map, source);
      const matcher = createNativeCampfireMatcher(spec);
      assert.ok(matcher, label);
      for (const [node, start, count] of spec.ranges) {
        assert.ok(matcher.includesNode(node), label);
        assert.ok(matcher.matches(node, start) && matcher.matches(node, start + count - 1), label);
      }
      const alreadyInExterior = source.segment === 3 && map.route.branch === 'swamp-temple';
      assert.equal(matcher.includedInNextEnclosure, alreadyInExterior, label);
      if (alreadyInExterior) {
        const destination = enclosures.maps.find(entry => entry.mapPackId === map.mapPackId)
          .enclosures.find(entry => entry.sourceRootName === 'Gloom Temple' && entry.segment === source.segment + 1);
        assert.equal(matcher.enclosureSha256, destination.geometrySha256, label);
        containedInExterior++;
      } else nativeCampfires++;
    }
  }
  assert.equal(nativeCampfires, 728);
  assert.equal(containedInExterior, 104);
});

test('the canonical build reuses exactly the verified GLB selection for the same map', async () => {
  const root = new URL('../../data/maps/', import.meta.url);
  const catalog = JSON.parse(await readFile(new URL('catalog.json', root), 'utf8'));
  const find = build => catalog.mapPacks.find(pack => String(pack.gameBuildId) === build && pack.sceneName === 'Level_107');
  const load = async build => JSON.parse(await readFile(new URL(
    `verified-builds/${build}/manifests/${find(build).mapPackId}/map-pack.json`, root), 'utf8'));
  const [canonical, current] = await Promise.all(['26155610', '26542162'].map(load));
  const [sourceIndex, targetIndex] = await Promise.all([canonical, current].map(loadCampfireSourceData));
  assert.ok(sourceIndex && targetIndex);
  for (const layer of canonical.layers.filter(item => item.segment < 4)) {
    const target = current.layers.find(row => row.segment === layer.segment);
    assert.equal(layer.geometrySha256, target.geometrySha256);
    assert.deepEqual(nativeCampfireSpec(sourceIndex, canonical, layer), nativeCampfireSpec(targetIndex, current, target));
  }
});
