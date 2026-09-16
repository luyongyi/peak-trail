import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mapsDirectory = new URL('../../data/maps/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog.json', mapsDirectory), 'utf8'));
const evidence = JSON.parse(await readFile(new URL('routes.25306743.json', mapsDirectory), 'utf8'));

test('audited routes bind one-to-one to all current exact-build catalog packs', () => {
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.gameBuildId, '25306743');
  const entries = catalog.mapPacks.filter(entry => entry.enabled !== false && String(entry.gameBuildId) === evidence.gameBuildId);
  assert.equal(evidence.maps.length, 21);
  assert.equal(entries.length, evidence.maps.length);
  assert.equal(new Set(evidence.maps.map(map => map.mapPackId)).size, evidence.maps.length);
  for (const map of evidence.maps) {
    const entry = entries.find(entry => entry.mapPackId === map.mapPackId);
    assert.ok(entry, map.sceneName);
    assert.equal(map.sceneName, entry.sceneName);
    assert.equal(map.mapSlot, entry.mapSlot);
    assert.match(map.sourceSceneSha256, /^[a-f0-9]{64}$/);
    assert.equal(map.route.authority, 'serialized-map-handler');
  }
});

test('terminal route stages are mutually exclusive without changing their original enum values', () => {
  const branches = new Set();
  for (const map of evidence.maps) {
    const { branch, segments } = map.route;
    branches.add(branch);
    assert.deepEqual(segments.map(stage => stage.index), [0, 1, 2, 3, 4]);
    const terminals = segments.slice(3);
    if (branch === 'volcano-kiln') {
      assert.deepEqual(terminals.map(stage => stage.biome), ['Volcano', 'Volcano']);
      assert.deepEqual(terminals.map(stage => stage.biomeId), [3, 3]);
      assert.deepEqual(terminals.map(stage => stage.name), ['Caldera_Segment', 'Volcano_Segment']);
      assert.deepEqual(terminals.map(stage => stage.displayName), ['火山', '熔炉']);
    } else {
      assert.equal(branch, 'swamp-temple');
      assert.deepEqual(terminals.map(stage => stage.biome), ['Swamp', 'Swamp']);
      assert.deepEqual(terminals.map(stage => stage.biomeId), [8, 8]);
      assert.deepEqual(terminals.map(stage => stage.name), ['Swamp_Segment', 'Temple_Segment']);
      assert.deepEqual(terminals.map(stage => stage.displayName), ['雾岛', '城塞']);
    }
  }
  assert.deepEqual([...branches].sort(), ['swamp-temple', 'volcano-kiln']);
});
