import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const catalog = await readJson('../../data/maps/catalog.json');
const builds = ['25306743', '25739797'];
const surveys = await Promise.all(builds.map(async build => ({
  build,
  survey: await readJson(`../../data/maps/loot.${build}.json`),
  routes: await readJson(`../../data/maps/routes.${build}.json`),
})));
const hash = /^[a-f0-9]{64}$/;
const expectedMeshes = new Map([
  ['chest-small', 'Luggage_Small'], ['chest-large', 'Luggage_large'],
  ['chest-epic', 'Epic Luggage'], ['chest-ancient', 'ancient Luggage'],
  ['chest-trick', 'Luggage_Trick'], ['item-bird-nest', 'BirdNest'],
  ['item-shelf-shroom', 'ShelfShroom'], ['item-piton', 'pickaxe'],
  ['item-napberry', 'Nap Berry'], ['animal-capybara', 'Cube'],
]);

for (const { build, survey, routes } of surveys) {
test(`loot survey ${build} covers all 21 enabled canonical maps with exact scene identity`, () => {
  assert.equal(survey.schemaVersion, 1);
  assert.equal(survey.gameBuildId, build);
  const expected = catalog.mapPacks.filter(entry => entry.enabled !== false && String(entry.gameBuildId) === survey.gameBuildId);
  assert.equal(expected.length, 21);
  assert.deepEqual(survey.maps.map(entry => entry.mapPackId).sort(), expected.map(entry => entry.mapPackId).sort());
  assert.equal(new Set(survey.maps.map(entry => entry.sceneName)).size, 21);
  for (const map of survey.maps) {
    const pack = expected.find(entry => entry.mapPackId === map.mapPackId);
    const sourceRoute = routes.maps.find(entry => entry.mapPackId === map.mapPackId);
    assert.equal(map.sceneName, pack.sceneName);
    assert.equal(map.mapSlot, pack.mapSlot);
    assert.match(map.sourceSceneSha256, hash);
    assert.equal(map.sourceSceneSha256, sourceRoute.sourceSceneSha256);
    assert.ok(map.markers.some(marker => marker.category === 'chest'), map.sceneName);
    assert.ok(map.markers.some(marker => marker.category === 'item'), map.sceneName);
    const animals = map.markers.filter(marker => marker.category === 'animal');
    assert.equal(animals.length, map.layers.some(layer => layer.id === 'segment-02-alpine') ? 3 : 2, map.sceneName);
  }
});

test(`all ${build} markers retain complete geometry provenance, layer ownership and finite Unity coordinates`, () => {
  const types = new Map(survey.types.map(type => [type.id, type]));
  assert.equal(types.size, expectedMeshes.size);
  assert.deepEqual([...types.keys()].sort(), [...expectedMeshes.keys()].sort());
  for (const type of types.values()) {
    assert.ok(['chest', 'item', 'animal'].includes(type.category));
    assert.match(type.color, /^#[0-9a-f]{6}$/i);
    assert.ok(type.name.length > 0);
  }
  for (const map of survey.maps) {
    assert.equal(map.layers.length, 6);
    const layers = new Map(map.layers.map(layer => [layer.id, layer]));
    const ids = new Set(), locations = new Set();
    for (const marker of map.markers) {
      const type = types.get(marker.type), layer = layers.get(marker.layerId);
      assert.ok(type && layer, `${map.sceneName}: ${marker.id}`);
      assert.equal(marker.category, type.category);
      assert.equal(marker.name, type.name);
      assert.equal(marker.segment, layer.segment);
      assert.equal(marker.pos.length, 3);
      assert.ok(marker.pos.every(Number.isFinite));
      assert.equal(marker.source.modelOrigin.length, 3);
      assert.ok(marker.source.modelOrigin.every(Number.isFinite));
      assert.match(marker.source.geometrySha256, hash);
      assert.equal(marker.source.geometrySha256, layer.geometrySha256);
      assert.equal(marker.source.meshName, expectedMeshes.get(marker.type));
      if (marker.category === 'animal') {
        assert.equal(marker.type, 'animal-capybara');
        assert.equal(marker.source.materialName, 'M_Capybara');
        assert.equal(marker.segment, 2);
      }
      assert.equal(marker.source.anchor, 'geometry-bounds-center');
      assert.ok(Number.isInteger(marker.source.meshIndex) && marker.source.meshIndex >= 0);
      assert.ok(Number.isInteger(marker.source.nodeIndex) && marker.source.nodeIndex >= 0);
      assert.ok(marker.source.instanceIndex === null || Number.isInteger(marker.source.instanceIndex) && marker.source.instanceIndex >= 0);
      assert.equal(ids.has(marker.id), false, `duplicate ID: ${map.sceneName}/${marker.id}`);
      ids.add(marker.id);
      const location = `${marker.type}:${marker.pos.map(value => Math.round(value * 10000)).join(',')}`;
      assert.equal(locations.has(location), false, `duplicate body: ${map.sceneName}/${location}`);
      locations.add(location);
    }
  }
});

test(`survey ${build} distinguishes candidate chests, fixed resource sites and absent spawned loose items`, () => {
  assert.equal(survey.source.kind, 'canonical-map-geometry-survey');
  assert.match(survey.source.chestCoverage, /candidate/i);
  assert.match(survey.source.itemCoverage, /loose|spawn/i);
  assert.match(survey.source.animalCoverage, /Mirage.*excluded/);
  const counts = new Map();
  for (const map of survey.maps) for (const marker of map.markers) {
    assert.equal(marker.placement, marker.category === 'chest' ? 'randomized-candidate' : 'fixed');
    assert.equal(Object.hasOwn(marker, 'contents'), false);
    assert.equal(Object.hasOwn(marker, 'isOpen'), false);
    counts.set(marker.type, (counts.get(marker.type) || 0) + 1);
  }
  // Audited body counts catch dropped GPU instances, accidentally selecting lids,
  // or losing one of the two terminal routes during future exporter changes.
  const expectedCounts = build === '25306743' ? {
    'chest-small': 1890, 'chest-large': 805, 'chest-epic': 275,
    'chest-ancient': 104, 'item-bird-nest': 460, 'item-shelf-shroom': 3131,
    'item-piton': 254, 'item-napberry': 66, 'chest-trick': 9,
    'animal-capybara': 53,
  } : {
    'chest-small': 1877, 'chest-large': 781, 'chest-epic': 290,
    'chest-ancient': 117, 'chest-trick': 11, 'item-bird-nest': 490,
    'item-shelf-shroom': 3310, 'item-piton': 247, 'item-napberry': 66,
    'animal-capybara': 53,
  };
  assert.deepEqual(Object.fromEntries(counts), expectedCounts);
});
}

test('every catalog map has its own versioned survey without reusing another build identity', () => {
  const enabled = catalog.mapPacks.filter(entry => entry.enabled !== false);
  const surveyed = surveys.flatMap(({ survey }) => survey.maps);
  assert.equal(enabled.length, 42);
  assert.equal(surveyed.length, 42);
  assert.deepEqual(surveyed.map(map => map.mapPackId).sort(), enabled.map(map => map.mapPackId).sort());
  assert.equal(new Set(surveyed.map(map => map.mapPackId)).size, 42);
  assert.ok(builds.includes(String(catalog.activeGameBuildId)));
  const [older, current] = surveys.map(({ survey }) => survey);
  for (const map of current.maps) {
    const oldMap = older.maps.find(old => old.sceneName === map.sceneName);
    assert.notEqual(map.sourceSceneSha256, oldMap.sourceSceneSha256);
    assert.notDeepEqual(map.markers.filter(marker => marker.category === 'animal').map(marker => marker.pos),
      oldMap.markers.filter(marker => marker.category === 'animal').map(marker => marker.pos));
  }
});
