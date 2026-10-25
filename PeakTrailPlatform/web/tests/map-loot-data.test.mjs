import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lootGeometryTypes } from '../../tools/offline-maps/export-loot-from-geometry.mjs';
import { readMapLootSource } from '../../tools/lib/map-loot-source.mjs';
import { readVerifiedMapBuild } from '../../tools/lib/verified-map-input.mjs';
import { normalizeMapLoot } from '../src/map-loot.js';
import { fileURLToPath } from 'node:url';

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const catalog = await readJson('../../data/maps/catalog.json');
const localization = await readJson('../../data/maps/loot-labels.zh-CN.json');
const builds = ['25306743', '25739797'];
const currentIndex = await readJson('../../data/maps/loot.26134529.json');
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
  ['item-climbing-spike', 'Spike'], ['item-amulet-bird', 'Medallion_Bird'],
  ['item-amulet-goat', 'Medallion_Goat'], ['item-amulet-turtle', 'Medallion_Turtle'],
  ['item-amulet-bingbong', 'Medallion_BingBong'],
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

test(`all ${build} markers retain authenticated geometry or component provenance and finite Unity coordinates`, () => {
  const types = new Map(survey.types.map(type => [type.id, type]));
  assert.equal(types.size, survey.types.length);
  for (const id of expectedMeshes.keys()) assert.ok(types.has(id), id);
  if (build === '25306743') assert.equal(types.size, expectedMeshes.size);
  for (const type of types.values()) {
    assert.ok(['chest', 'item', 'animal'].includes(type.category));
    assert.match(type.color, /^#[0-9a-f]{6}$/i);
    assert.ok(type.name.length > 0);
    assert.equal(type.name, localization.labels[type.id]?.name, `native Chinese label: ${type.id}`);
    assert.equal(type.nameEn, localization.labels[type.id]?.nameEn, `native English label: ${type.id}`);
    assert.ok(type.nameEn.length > 0 && type.nameEn.length <= 128);
  }
  for (const map of survey.maps) {
    assert.equal(map.layers.length, 6);
    const layers = new Map(map.layers.map(layer => [layer.id, layer]));
    const ids = new Set(), locations = new Set();
    for (const marker of map.markers) {
      const type = types.get(marker.type), layer = layers.get(marker.layerId);
      assert.ok(type && (layer || marker.scope === 'global'), `${map.sceneName}: ${marker.id}`);
      assert.equal(marker.category, type.category);
      assert.equal(marker.name, type.name);
      assert.equal(Object.hasOwn(marker, 'nameEn'), false, 'English labels are stored once per type');
      assert.equal(marker.pos.length, 3);
      assert.ok(marker.pos.every(Number.isFinite));
      if (marker.scope === 'global') {
        assert.equal(marker.layerId, 'global');
        assert.equal(marker.segment, -1);
        assert.equal(marker.source.scopeRoot, 'MapHandler.globalParent');
        assert.equal(marker.source.geometrySha256, undefined);
        assert.equal(marker.source.sourceKind, 'serialized-scene-component');
      } else {
        assert.equal(marker.segment, layer.segment);
        assert.match(marker.source.geometrySha256, hash);
        assert.equal(marker.source.geometrySha256, layer.geometrySha256);
      }
      if (marker.source.sourceKind === 'serialized-scene-component') {
        assert.equal(build, '25739797', 'new components cannot be reused for an unauthenticated old scene');
        assert.equal(marker.category, 'item');
        assert.equal(marker.source.sceneSha256, map.sourceSceneSha256);
        assert.match(marker.source.componentPathId, /^-?[1-9]\d{0,19}$/);
        assert.ok(['SingleItemSpawner', 'EndgameFlareSpawner', 'BerryBush', 'BerryVine',
          'GroundPlaceSpawner', 'Spawner', 'ScoutStatue'].includes(marker.source.component));
        if (marker.type === 'item-scout-statue-reward') {
          assert.equal(marker.source.component, 'ScoutStatue');
          assert.equal(marker.source.anchor, 'referenced-transform-world-position');
          assert.equal(marker.source.transformField, 'gemSpot');
          assert.match(marker.source.transformPathId, /^-?[1-9]\d{0,19}$/);
          assert.equal(marker.placement, 'randomized-candidate');
        } else assert.equal(marker.source.anchor, 'component-world-position');
        assert.equal(marker.source.modelOrigin, undefined);
      } else {
        assert.equal(marker.source.modelOrigin.length, 3);
        assert.ok(marker.source.modelOrigin.every(Number.isFinite));
        assert.equal(marker.source.meshName, expectedMeshes.get(marker.type));
        assert.equal(marker.source.anchor, 'geometry-bounds-center');
        assert.ok(Number.isInteger(marker.source.meshIndex) && marker.source.meshIndex >= 0);
        assert.ok(Number.isInteger(marker.source.nodeIndex) && marker.source.nodeIndex >= 0);
        assert.ok(marker.source.instanceIndex === null || Number.isInteger(marker.source.instanceIndex) && marker.source.instanceIndex >= 0);
        if (marker.type === 'item-climbing-spike') assert.equal(marker.source.materialName, 'M_ClimbingSpike');
        if (marker.type.startsWith('item-amulet-')) assert.equal(marker.source.materialName, 'Tarnished Gold Medallion');
      }
      if (marker.category === 'animal') {
        assert.equal(marker.type, 'animal-capybara');
        assert.equal(marker.source.materialName, 'M_Capybara');
        assert.equal(marker.segment, 2);
      }
      assert.equal(ids.has(marker.id), false, `duplicate ID: ${map.sceneName}/${marker.id}`);
      ids.add(marker.id);
      const location = `${marker.type}:${marker.pos.map(value => Math.round(value * 10000)).join(',')}`;
      assert.equal(locations.has(location), false, `duplicate body: ${map.sceneName}/${location}`);
      locations.add(location);
    }
  }
});

test(`survey ${build} distinguishes candidate sites and preserves audited geometry coverage`, () => {
  assert.equal(survey.source.kind, 'canonical-map-geometry-survey');
  assert.match(survey.source.chestCoverage, /candidate/i);
  assert.match(survey.source.itemCoverage, /loose|spawn/i);
  assert.match(survey.source.animalCoverage, /Mirage.*excluded/);
  const counts = new Map();
  for (const map of survey.maps) for (const marker of map.markers) {
    assert.equal(Object.hasOwn(marker, 'contents'), false);
    assert.equal(Object.hasOwn(marker, 'isOpen'), false);
    if (marker.source.sourceKind === 'serialized-scene-component') {
      const conditions = marker.source.conditions;
      assert.equal(typeof conditions, 'object');
      if (!['SingleItemSpawner'].includes(marker.source.component) || conditions.runtimeActivation
          || conditions.playersInRoomRequirement > 0 || (conditions.belowAscentRequirement ?? -1) !== -1
          || conditions.normalRunsOnly) assert.equal(marker.placement, 'randomized-candidate');
      continue;
    }
    assert.equal(marker.placement, marker.category === 'chest' || marker.type.startsWith('item-amulet-') ? 'randomized-candidate' : 'fixed');
    counts.set(marker.type, (counts.get(marker.type) || 0) + 1);
  }
  // Audited body counts catch dropped GPU instances, accidentally selecting lids,
  // or losing one of the two terminal routes during future exporter changes.
  const expectedCounts = build === '25306743' ? {
    'chest-small': 1890, 'chest-large': 805, 'chest-epic': 275,
    'chest-ancient': 104, 'item-bird-nest': 460, 'item-shelf-shroom': 3131,
    'item-piton': 254, 'item-napberry': 66, 'chest-trick': 9,
    'animal-capybara': 53, 'item-climbing-spike': 1411,
    'item-amulet-bird': 21, 'item-amulet-goat': 21, 'item-amulet-turtle': 21, 'item-amulet-bingbong': 21,
  } : {
    'chest-small': 1877, 'chest-large': 781, 'chest-epic': 290,
    'chest-ancient': 117, 'chest-trick': 11, 'item-bird-nest': 490,
    'item-shelf-shroom': 3310, 'item-piton': 247, 'item-napberry': 66,
    'animal-capybara': 53, 'item-climbing-spike': 1319,
    'item-amulet-bird': 21, 'item-amulet-goat': 21, 'item-amulet-turtle': 21, 'item-amulet-bingbong': 21,
  };
  assert.deepEqual(Object.fromEntries(counts), expectedCounts);
});
}

test('marker labels use the game Chinese names and keep descriptive site categories explicit', () => {
  assert.equal(localization.locale, 'zh-CN');
  assert.equal(localization.source.textAsset, 'SerializedTermsData');
  assert.equal(localization.source.language, 'SimplifiedChinese');
  assert.equal(localization.source.languageIndex, 9);
  assert.match(localization.source.sha256, hash);
  for (const [id, key, name] of [
    ['item-spawn-flare', 'NAME_FLARE', '照明棒生成点'],
    ['item-spawn-healing-puff', 'NAME_REMEDY FUNGUS', '灵药菇生成点'],
    ['item-spawn-warp-fungus', 'NAME_WARP FUNGUS', '曲迁菇生成点'],
    ['item-napberry', 'NAME_NAPBERRY', '晚安莓点'],
    ['item-piton', 'PICKAXE', '鹤嘴锄（固定）'],
    ['item-climbing-spike', 'NAME_PITON', '岩钉（固定）'],
    ['item-amulet-bird', 'NAME_AMULET_DOUBLEJUMP', '童军的进取点'],
  ]) {
    const label = localization.labels[id];
    assert.equal(label.name, name);
    assert.equal(label.terms[0].key, key);
    assert.ok(label.name.includes(label.terms[0].zh));
  }
  assert.equal(localization.labels['item-cactus-growth'].kind, 'resource-group');
  assert.equal(localization.labels['item-cactus-growth'].name, '刺莓生长点');
  assert.equal(localization.labels['item-ground-forage'].kind, 'map-description');
  assert.equal(localization.prefabTypes.AntiRopeSpool, undefined, 'unverified prefab aliases cannot get invented Chinese names');
});

test('English generator metadata matches the shared native terms and keeps map category descriptions explicit', () => {
  for (const definition of lootGeometryTypes) {
    assert.equal(definition.nameEn, localization.labels[definition.id].nameEn);
    for (const { survey } of surveys) assert.equal(survey.types.find(type => type.id === definition.id).nameEn, definition.nameEn);
  }
  for (const label of Object.values(localization.labels)) {
    assert.equal(typeof label.nameEn, 'string');
    assert.ok(label.nameEn.trim() && label.nameEn.length <= 128);
  }
  assert.equal(localization.labels['item-spawn-healing-puff'].nameEn, 'REMEDY FUNGUS spawn site');
  assert.equal(localization.labels['item-spawn-warp-fungus'].nameEn, 'WARP FUNGUS spawn site');
  assert.equal(localization.labels['item-spawn-cattail-food'].nameEn, 'HOT DOG spawn site');
  assert.match(localization.labels['item-cactus-growth'].nameEn, /Prickleberr/i);
  assert.doesNotMatch(localization.labels['item-cactus-growth'].nameEn, /Cactus/i);
  assert.doesNotMatch(localization.labels['chest-trick'].nameEn, /Clown/i);
});

test('current scene components restore the complete audited set of fixed spawn and growth reference sites', () => {
  const { survey } = surveys.find(entry => entry.build === '25739797');
  const sites = survey.maps.flatMap(map => map.markers.filter(marker => marker.source.sourceKind === 'serialized-scene-component'));
  assert.equal(survey.types.length, 53);
  assert.equal(sites.length, 42585);
  assert.equal(survey.maps.flatMap(map => map.markers).filter(marker => marker.category === 'item').length, 48101);
  assert.match(survey.source.componentCoverage, /reference points/);
  const counts = new Map();
  for (const marker of sites) counts.set(marker.source.component, (counts.get(marker.source.component) || 0) + 1);
  assert.deepEqual(Object.fromEntries([...counts].sort()), {
    BerryBush: 30292, BerryVine: 2417, EndgameFlareSpawner: 168,
    GroundPlaceSpawner: 6146, ScoutStatue: 21, SingleItemSpawner: 3478, Spawner: 63,
  });
  assert.equal(sites.filter(marker => marker.placement === 'fixed').length, 2811);
  for (const map of survey.maps) {
    assert.equal(map.markers.filter(marker => marker.scope === 'global').length, 30, map.sceneName);
    assert.equal(map.markers.filter(marker => marker.type === 'item-scout-statue-reward').length, 1, map.sceneName);
    assert.ok(map.markers.some(marker => marker.segment === 0 && marker.type === 'item-shore-berry-growth'), map.sceneName);
    assert.ok(map.markers.some(marker => marker.segment === 1 && marker.source.component === 'BerryVine'), map.sceneName);
  }
  assert.equal(surveys[0].survey.source.componentCoverage, undefined);
});

test('every catalog map has its own versioned survey without reusing another build identity', async () => {
  const enabled = catalog.mapPacks.filter(entry => entry.enabled !== false);
  const verified = await readMapLootSource(fileURLToPath(new URL('../../data/maps/', import.meta.url)), '26155610');
  assert.ok(verified);
  const surveyed = [...surveys.flatMap(({ survey }) => survey.maps), ...currentIndex.maps, ...verified.raw.maps];
  assert.equal(enabled.length, 458);
  assert.equal(surveyed.length, 458);
  assert.deepEqual(surveyed.map(map => map.mapPackId).sort(), enabled.map(map => map.mapPackId).sort());
  assert.equal(new Set(surveyed.map(map => map.mapPackId)).size, 458);
  assert.equal(String(catalog.activeGameBuildId), '26155610');
  const [older, current] = surveys.map(({ survey }) => survey);
  for (const map of current.maps) {
    const oldMap = older.maps.find(old => old.sceneName === map.sceneName);
    assert.notEqual(map.sourceSceneSha256, oldMap.sourceSceneSha256);
    assert.notDeepEqual(map.markers.filter(marker => marker.category === 'animal').map(marker => marker.pos),
      oldMap.markers.filter(marker => marker.category === 'animal').map(marker => marker.pos));
  }
});

test('all 208 verified maps expose independent loot identities while representative source marker coordinates remain exact', async () => {
  const directory = fileURLToPath(new URL('../../data/maps/', import.meta.url));
  const verified = await readVerifiedMapBuild('26155610', { mapsDirectory: directory });
  const source = await readMapLootSource(directory, '26134529');
  const rebound = await readMapLootSource(directory, '26155610');
  assert.ok(verified && source && rebound);
  assert.equal(verified.plan.packs.length, 208);
  assert.equal(rebound.raw.gameBuildId, '26155610');
  assert.equal(rebound.raw.maps.length, 208);
  assert.deepEqual(rebound.raw.maps.map(map => map.mapPackId).sort(), verified.plan.packs.map(map => map.mapPackId).sort());
  assert.deepEqual(verified.plan.packs.map(map => map.sourceMapPackId).sort(), currentIndex.maps.map(map => map.mapPackId).sort());
  const ids = new Set(currentIndex.maps.map(map => map.mapPackId));
  assert.ok(rebound.raw.maps.every(map => !ids.has(map.mapPackId)));
  for (const mapping of [verified.plan.packs[0], verified.plan.packs.at(-1)]) {
    const old = await source.readMap(mapping.sourceMapPackId), next = await rebound.readMap(mapping.mapPackId);
    assert.equal(next.gameBuildId, '26155610');
    assert.equal(next.maps[0].mapPackId, mapping.mapPackId);
    assert.equal(old.maps[0].mapPackId, mapping.sourceMapPackId);
    assert.equal(next.maps[0].sceneName, old.maps[0].sceneName);
    assert.equal(next.maps[0].sourceSceneSha256, old.maps[0].sourceSceneSha256);
    assert.deepEqual(next.maps[0].layers, old.maps[0].layers);
    assert.deepEqual(next.maps[0].markers, old.maps[0].markers);
  }
  await assert.rejects(readFile(new URL('../../data/maps/loot.26155610.json', import.meta.url)), { code: 'ENOENT' });
});

test('all 208 new scene surveys authenticate their own coordinates, labels and source components', async () => {
  const build = '26134529';
  const expected = catalog.mapPacks.filter(entry => entry.enabled !== false && String(entry.gameBuildId) === build);
  assert.equal(expected.length, 208);
  assert.equal(currentIndex.kind, 'map-loot-index');
  assert.equal(currentIndex.maps.length, 208);
  assert.deepEqual(expected.map(entry => entry.mapSlot).sort((a, b) => a - b), Array.from({ length: 208 }, (_, i) => i));
  const source = await readMapLootSource(fileURLToPath(new URL('../../data/maps/', import.meta.url)), build);
  const routes = await readJson('../../data/maps/routes.26134529.json');
  for (const entry of expected) {
    const raw = await source.readMap(entry.mapPackId);
    const map = raw.maps[0];
    const route = routes.maps.find(item => item.mapPackId === entry.mapPackId);
    assert.equal(map.sceneName, entry.sceneName);
    assert.equal(map.mapSlot, entry.mapSlot);
    assert.equal(map.sourceSceneSha256, route?.sourceSceneSha256);
    const normalized = normalizeMapLoot(raw, { ...entry, source: { sceneSha256: map.sourceSceneSha256 }, layers: map.layers });
    assert.ok(normalized, `${entry.sceneName}: source and geometry identities`);
    assert.ok(normalized.markers.some(marker => marker.category === 'chest'), entry.sceneName);
    assert.ok(normalized.markers.some(marker => marker.source?.sourceKind === 'serialized-scene-component'), entry.sceneName);
    for (const type of normalized.types) {
      assert.equal(type.name, localization.labels[type.id]?.name);
      assert.equal(type.nameEn, localization.labels[type.id]?.nameEn);
    }
  }
});
