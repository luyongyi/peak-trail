import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMapEnclosures, enclosureGeometryReference, followLayerAtPosition } from '../src/map-enclosures.js';

const fixture = () => {
  const pack = { mapPackId: `sha256-${'a'.repeat(64)}`, gameBuildId: '25306743', sceneName: 'Level_17', mapSlot: 17,
    source: { sceneSha256: 'b'.repeat(64) }, layers: [{ segment: 4 }] };
  const evidence = { schemaVersion: 1, authority: 'serialized-map-enclosure', gameBuildId: pack.gameBuildId,
    mapPackId: pack.mapPackId, sceneName: pack.sceneName, mapSlot: pack.mapSlot, sourceSceneSha256: pack.source.sceneSha256,
    enclosures: [{ segment: 4, objectId: 'map-enclosure:Level_17:18936', sourceRootPathId: 18936,
      sourceRootName: 'Gloom Temple', geometry: `${'c'.repeat(64)}.glb.gz`, geometrySha256: 'c'.repeat(64),
      geometryFormat: 'glb-instanced-v1+gzip', meshBounds: { min: [-100, 800, 2000], max: [100, 1300, 2200] },
      interiorReference: [7, 805, 2092.5], interiorReferenceSource: 'source-model-axis' }] };
  return { pack, evidence };
};

test('enclosure metadata binds exact original scene and preserves source coordinates without modifying the pack', () => {
  const { pack, evidence } = fixture(), original = JSON.stringify({ pack, evidence });
  const result = normalizeMapEnclosures(evidence, pack);
  assert.deepEqual(result, evidence);
  assert.equal(enclosureGeometryReference(result.enclosures[0]), `../../enclosures/${'c'.repeat(64)}.glb.gz`);
  result.enclosures[0].interiorReference[0] = 90;
  result.enclosures[0].meshBounds.min[0] = -500;
  assert.equal(JSON.stringify({ pack, evidence }), original);
});

test('wrong identity, malformed geometry and invented reference sources are rejected', () => {
  const mutations = [
    value => value.gameBuildId = 'other', value => value.mapPackId = `sha256-${'d'.repeat(64)}`,
    value => value.sceneName = 'Level_16', value => value.mapSlot = 16,
    value => value.sourceSceneSha256 = 'd'.repeat(64), value => value.authority = 'guessed-cylinder',
    value => value.enclosures.push(value.enclosures[0]), value => value.enclosures[0].segment = 3,
    value => value.enclosures[0].geometry = '../private.glb.gz', value => value.enclosures[0].geometry = 'https://example.org/a.glb.gz',
    value => value.enclosures[0].geometrySha256 = 'd'.repeat(64), value => value.enclosures[0].geometryFormat = 'other',
    value => value.enclosures[0].meshBounds.max[0] = -101, value => value.enclosures[0].sourceRootPathId = 0,
    value => value.enclosures[0].interiorReference = [NaN, 0, 0], value => value.enclosures[0].interiorReference[0] = 1001,
    value => value.enclosures[0].interiorReferenceSource = 'guessed-bbox-center',
  ];
  for (const mutate of mutations) {
    const { pack, evidence } = fixture(); mutate(evidence);
    assert.equal(normalizeMapEnclosures(evidence, pack), null, mutate.toString());
  }
  assert.equal(normalizeMapEnclosures(null, fixture().pack), null);
});

test('overview identifies only spatially unambiguous chapters, never the shared progression index', () => {
  const layer = (segment, minY, maxY) => ({ segment, biome: 'Swamp', minX: -10, maxX: 10, minY, maxY, minZ: -10, maxZ: 10 });
  const pack = { layers: [layer(3, 100, 220), layer(4, 200, 500), { ...layer(5, -9999, 9999), biome: 'Void' }] };
  assert.equal(followLayerAtPosition(pack, null, [0, 300, 0]).segment, 4);
  assert.equal(followLayerAtPosition(pack, null, [0, 150, 0]).segment, 3);
  assert.equal(followLayerAtPosition(pack, null, [0, 210, 0]), null);
  assert.equal(followLayerAtPosition(pack, null, [1000, 300, 0]), null);
  assert.equal(followLayerAtPosition(pack, 4, [0, 210, 0]).segment, 4);
  assert.equal(followLayerAtPosition(pack, 9, [0, 300, 0]), null);
});
