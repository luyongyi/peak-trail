import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../../vendor/three/0.180.0/build/three.module.js';
import { normalizeMapWater, sourceWaterVisible } from '../src/map-water.js';
import { loadMapPackUrl } from '../src/protocol.js';
import { computeMapPackId } from '../../tools/lib/map-pack-identity.mjs';

const evidence = JSON.parse(await readFile(new URL('../../data/maps/water.25306743.json', import.meta.url), 'utf8'));
const entry = evidence.maps.find(value => value.sceneName === 'Level_17');
const pack = { ...entry, gameBuildId: evidence.gameBuildId, source: { sceneSha256: entry.sourceSceneSha256 },
  layers: [{ segment: 0, biome: 'Shore' }, { segment: 4, biome: 'Swamp' }] };
const water = { ...entry, schemaVersion: 1, gameBuildId: evidence.gameBuildId, authority: evidence.authority };
pack.mapWater = water;

test('all 21 shipped sources independently confirm visible global ocean outside chapter roots', () => {
  assert.equal(evidence.maps.length, 21);
  assert.equal(new Set(evidence.maps.map(value => value.sceneName)).size, 21);
  for (const value of evidence.maps) {
    assert.match(value.sourceSceneSha256, /^[a-f0-9]{64}$/);
    assert.equal(value.surfaces.length, 1);
    const surface = value.surfaces[0];
    assert.deepEqual(surface.sourceHierarchy, ['Misc', 'Water', 'Collision']);
    assert.equal(surface.sourceMesh, 'Plane');
    assert.equal(surface.sourceVertices, 121);
    assert.equal(surface.sourceTriangles, 200);
    assert.equal(surface.segment, 0);
    assert.equal(surface.material.name, 'M_WaterTest');
    assert.equal(surface.material.shader, 'GD/Water-GD');
    assert.ok(surface.corners.every(point => Math.abs(point[1] + 1) < 1e-9));
  }
});

test('ocean remains exactly scene-bound; malformed geometry or unknown material source fails closed', () => {
  assert.ok(normalizeMapWater(water, pack));
  for (const patch of [{ gameBuildId: 'next' }, { mapPackId: 'other' }, { sceneName: 'Level_1' },
    { sourceSceneSha256: '0'.repeat(64) }, { authority: 'guess' }]) {
    assert.equal(normalizeMapWater({ ...water, ...patch }, pack), null);
  }
  const source = water.surfaces[0];
  for (const patch of [{ segment: 4 }, { source: 'collider' }, { kind: 'fog' },
    { corners: [[0, 0, 0], [1, 1, 0], [1, 0, 1], [0, 0, 1]] },
    { corners: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [1, 0, 0]] },
    { material: { ...source.material, shader: 'guess' } },
    { material: { ...source.material, linearColor: [NaN, 0, 0] } }]) {
    assert.equal(normalizeMapWater({ ...water, surfaces: [{ ...source, ...patch }] }, pack), null);
  }
  assert.equal(normalizeMapWater({ ...water, surfaces: [source, source] }, pack), null);
});

test('global ocean is shown for shore and overview only, never in citadel, swamp or void', () => {
  const surface = water.surfaces[0];
  assert.equal(sourceWaterVisible(surface, 0), true);
  assert.equal(sourceWaterVisible(surface, null), true);
  for (const segment of [1, 2, 3, 4, 5]) assert.equal(sourceWaterVisible(surface, segment), false);
});

test('remote hydration preserves verified water without changing canonical map identity or terrain bounds', async t => {
  const vector = JSON.parse(await readFile(new URL('../../schema/test-vectors/map-pack-identity-v2.json', import.meta.url), 'utf8'));
  const manifest = { ...vector, identityVersion: 3, source: { sceneSha256: entry.sourceSceneSha256 },
    layers: vector.layers.map(layer => ({ ...layer, biome: layer.segment === 0 ? 'Shore' : layer.biome, geometry: `${layer.id}.glb`,
      geometrySha256: 'a'.repeat(64), geometryFormat: 'glb-instanced-v1' })) };
  manifest.mapPackId = computeMapPackId(manifest);
  manifest.mapWater = { ...water, mapPackId: manifest.mapPackId, sceneName: manifest.sceneName,
    gameBuildId: manifest.gameBuildId, mapSlot: manifest.mapSlot };
  assert.equal(computeMapPackId(manifest), manifest.mapPackId);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url)); return { ok: true, url: String(url), json: async () => manifest };
  });
  const loaded = await loadMapPackUrl('https://example.test/maps/map-pack.json');
  assert.deepEqual(loaded.mapWater, manifest.mapWater);
  assert.equal(requests.length, 1);
  assert.equal(loaded.bounds.min[0], Math.min(...manifest.layers.map(layer => layer.minX)));
  manifest.mapWater.sourceSceneSha256 = '0'.repeat(64);
  assert.equal((await loadMapPackUrl('https://example.test/maps/map-pack.json')).mapWater, null);
});

const source = (await readFile(new URL('../src/source-water-renderer.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export class SourceWaterRenderer', 'class SourceWaterRenderer');
const SourceWaterRenderer = new Function('THREE', 'normalizeMapWater', 'sourceWaterVisible', `${source}\nreturn SourceWaterRenderer;`)(THREE, normalizeMapWater, sourceWaterVisible);

test('actual renderer preserves world level, depth occlusion, origin and independent ownership', () => {
  const renderer = new SourceWaterRenderer();
  const origin = new THREE.Vector3(3, 700, 900);
  assert.equal(renderer.setMap(pack, origin), true);
  const mesh = renderer.root.children[0];
  renderer.root.updateMatrixWorld(true);
  const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), 0).applyMatrix4(mesh.matrixWorld);
  assert.equal(point.y, -701);
  assert.equal(point.x, -2503);
  assert.equal(mesh.userData.sourceWater, true);
  assert.equal(mesh.material.userData.peakSourceEffect.kind, 'water');
  assert.equal(mesh.material.depthWrite, true);
  assert.equal(mesh.material.opacity, 1); // source alpha zero belongs to its depth shader
  assert.deepEqual(mesh.material.color.toArray(), water.surfaces[0].material.linearColor);
  renderer.setSegment(4); assert.equal(mesh.visible, false);
  renderer.setSegment(0); assert.equal(mesh.visible, true);
  let geometries = 0, materials = 0;
  mesh.geometry.addEventListener('dispose', () => geometries++);
  mesh.material.addEventListener('dispose', () => materials++);
  assert.equal(renderer.setMap(null, origin), false);
  assert.equal(renderer.root.children.length, 0);
  assert.equal(geometries, 1); assert.equal(materials, 1);
  renderer.dispose();
  assert.equal(geometries, 1); assert.equal(materials, 1);
});
