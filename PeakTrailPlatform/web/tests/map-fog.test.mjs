import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeMapFog, mapFogStateAtTime } from '../src/map-fog.js';

const evidence = JSON.parse(await readFile(new URL('../../data/maps/fog.25306743.json', import.meta.url), 'utf8'));
const level17 = evidence.maps.find((entry) => entry.sceneName === 'Level_17');
const pack = { ...level17, gameBuildId: evidence.gameBuildId,
  source: { sceneSha256: level17.sourceSceneSha256 }, layers: [{ segment: 3, biome: 'Swamp' }, { segment: 4, biome: 'Swamp' }] };
const fog = { ...level17, schemaVersion: 1, gameBuildId: evidence.gameBuildId, authority: evidence.authority };

test('Level17 source configuration keeps island baseline and initially rising temple fog separate', () => {
  const normalized = normalizeMapFog(fog, pack);
  assert.ok(normalized);
  const island = normalized.volumes.find((entry) => entry.segment === 3);
  const temple = normalized.volumes.find((entry) => entry.segment === 4);
  assert.equal(island.topY, 784);
  assert.ok(Math.abs(island.pos[1] - 760.565) < 1e-4);
  assert.ok(Math.abs(temple.topY - 804.13) < 1e-4);
  assert.equal(temple.size[1], 718);
  assert.equal(island.runtimeSafeZonesUnknown, true);
  assert.equal(temple.runtimeHeightUnknown, true);
  assert.equal(normalized.volumes.length, 2);
});

test('baseline is chapter filtered and explicitly distinct from live recorded fog', () => {
  const normalized = normalizeMapFog(fog, pack);
  const state = mapFogStateAtTime(normalized, null, 100, 3);
  assert.equal(state.mode, 'map-baseline'); assert.equal(state.count, 1);
  assert.equal(state.objects[0].segment, 3);
  assert.match(state.note, /不是实录/);
  assert.equal(mapFogStateAtTime(normalized, null, 100, 1).count, 0);
  assert.equal(mapFogStateAtTime(normalized, null, 100, null).count, 2);
});

test('captured empty worlds and pre-first-sample times never fill gaps with baseline fog', () => {
  const normalized = normalizeMapFog(fog, pack);
  for (const time of [0, 10, 100]) {
    const state = mapFogStateAtTime(normalized, { captured: true, firstTime: 10 }, time, 3);
    assert.equal(state.mode, 'recorded'); assert.equal(state.count, 0); assert.deepEqual(state.objects, []);
  }
});

test('source metadata fails closed across build, pack, source hash, water and field shape mismatches', () => {
  for (const patch of [{ gameBuildId: 'other' }, { mapPackId: 'other' }, { sourceSceneSha256: '0'.repeat(64) },
    { sceneName: 'Level_1' }, { authority: 'recorded' }]) assert.equal(normalizeMapFog({ ...fog, ...patch }, pack), null);
  for (const patch of [{ surfaceMaterial: 'M_Water_swamp' }, { surfaceShader: 'GD/Water-GD' },
    { size: [-1, 1, 1] }, { topY: 0 }, { segment: 2 }, { authority: 'recorded' }]) {
    assert.equal(normalizeMapFog({ ...fog, volumes: [{ ...fog.volumes[0], ...patch }] }, pack), null);
  }
});

test('every shipped baseline is exactly scene-bound, and volcano maps have no invented Gloom', async () => {
  assert.equal(evidence.maps.length, 21);
  const branchByScene = new Map((JSON.parse(await readFile(new URL('../../data/maps/routes.25306743.json', import.meta.url), 'utf8'))).maps
    .map((entry) => [entry.sceneName, entry.route.branch]));
  for (const entry of evidence.maps) {
    assert.match(entry.mapPackId, /^sha256-[a-f0-9]{64}$/);
    assert.match(entry.sourceSceneSha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.volumes.every((volume) => [3, 4].includes(volume.segment) && volume.sourcePathId > 0));
    assert.equal(entry.volumes.length, branchByScene.get(entry.sceneName) === 'swamp-temple' ? 2 : 0);
  }
  assert.equal(evidence.maps.filter((entry) => entry.volumes.length === 2).length, 10);
  assert.equal(evidence.maps.filter((entry) => entry.volumes.length === 0).length, 11);
});
