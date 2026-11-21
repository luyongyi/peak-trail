import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { normalizeMapEnclosures, enclosureGeometryReference, chapterEnclosures, followLayerAtPosition } from '../src/map-enclosures.js';

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

function contextualFixture() {
  const { pack, evidence } = fixture();
  pack.identityVersion = 3;
  pack.layers = [{ segment: 3, biome: 'Swamp' }, { segment: 4, biome: 'Swamp' }];
  pack.route = { authority: 'serialized-map-handler', branch: 'swamp-temple', segments: [
    { index: 3, biome: 'Swamp', stageId: 'swamp', name: 'Swamp_Segment' },
    { index: 4, biome: 'Swamp', stageId: 'temple', name: 'Temple_Segment' },
  ] };
  pack.mapEnclosures = evidence;
  evidence.enclosures[0].geometryUrl = '/data/maps/enclosures/citadel.glb.gz';
  return pack;
}

test('single-chapter Swamp reuses the exact adjacent Citadel exterior without rewriting stage or coordinates', () => {
  const pack = contextualFixture(), before = JSON.stringify(pack);
  const result = chapterEnclosures(pack, pack.layers[0], { includeContext: true });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], pack.mapEnclosures.enclosures[0]);
  assert.equal(result[0].segment, 4);
  assert.equal(result[0].geometryUrl, '/data/maps/enclosures/citadel.glb.gz');
  result[0].interiorReference[0] = 999;
  result[0].meshBounds.max[1] = 999;
  assert.equal(JSON.stringify(pack), before);
});

test('current source build retains the adjacent native Citadel context with the same strict sidecar identity', () => {
  for (const build of ['25739797', '26134529', '26155610', '26542162']) {
    const pack = contextualFixture(); pack.gameBuildId = pack.mapEnclosures.gameBuildId = build;
    const result = chapterEnclosures(pack, pack.layers[0], { includeContext: true });
    assert.equal(result.length, 1);
    assert.equal(result[0].sourceRootName, 'Gloom Temple');
    assert.equal(result[0].segment, 4);
    pack.mapEnclosures.sourceSceneSha256 = 'd'.repeat(64);
    assert.deepEqual(chapterEnclosures(pack, pack.layers[0], { includeContext: true }), []);
  }
});

test('overview and the Citadel chapter keep one native shell, with no contextual duplication', () => {
  const pack = contextualFixture();
  assert.deepEqual(chapterEnclosures(pack, pack.layers[0]), []);
  for (const includeContext of [false, true]) {
    const result = chapterEnclosures(pack, pack.layers[1], { includeContext });
    assert.equal(result.length, 1);
    assert.equal(new Set(result.map(entry => entry.objectId)).size, result.length);
  }
  const overview = pack.layers.flatMap(layer => chapterEnclosures(pack, layer));
  assert.equal(overview.length, 1);
});

test('contextual exterior is restricted to the audited source build, branch, roots and adjacent stages', () => {
  const mutations = [
    pack => pack.gameBuildId = pack.mapEnclosures.gameBuildId = '25739798',
    pack => pack.gameBuildId = pack.mapEnclosures.gameBuildId = '26155611',
    pack => pack.gameBuildId = pack.mapEnclosures.gameBuildId = '26542163',
    pack => pack.identityVersion = 2,
    pack => pack.route.authority = 'guessed-calendar',
    pack => pack.route.branch = 'volcano-kiln',
    pack => pack.route.branch = 'unknown',
    pack => pack.route.segments[0].stageId = 'caldera',
    pack => pack.route.segments[1].stageId = 'kiln',
    pack => pack.route.segments[0].name = 'Caldera_Segment',
    pack => pack.route.segments[1].name = 'Volcano_Segment',
    pack => pack.route.segments[0].biome = 'Volcano',
    pack => pack.route.segments[1].biome = 'Volcano',
    pack => pack.route.segments[1].index = 5,
    pack => pack.layers[0].biome = 'Volcano',
    pack => pack.layers[1].biome = 'Volcano',
    pack => pack.layers.pop(),
    pack => pack.mapEnclosures.enclosures[0].sourceRootName = 'VolcanoModel',
    pack => pack.mapEnclosures.sourceSceneSha256 = 'd'.repeat(64),
    pack => pack.mapEnclosures.mapPackId = `sha256-${'d'.repeat(64)}`,
  ];
  for (const mutate of mutations) {
    const pack = contextualFixture(); mutate(pack);
    assert.deepEqual(chapterEnclosures(pack, pack.layers[0], { includeContext: true }), [], mutate.toString());
  }
  assert.deepEqual(chapterEnclosures(contextualFixture(), { segment: 9, biome: 'Swamp' }, { includeContext: true }), []);
  assert.deepEqual(chapterEnclosures(null, null, { includeContext: true }), []);
});

test('native shells remain supported outside the contextual build while malformed duplicate sidecars fail closed', () => {
  const pack = contextualFixture();
  pack.gameBuildId = pack.mapEnclosures.gameBuildId = '25739797';
  assert.equal(chapterEnclosures(pack, pack.layers[1], { includeContext: true }).length, 1);
  pack.mapEnclosures.enclosures.push({ ...pack.mapEnclosures.enclosures[0] });
  assert.deepEqual(chapterEnclosures(pack, pack.layers[1], { includeContext: true }), []);
});

test('all 208 verified 3.1 exits expose exactly their own adjacent terminal shell', async () => {
  const read = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const [catalog, sidecars, receipt] = await Promise.all([
    read('../../data/maps/catalog.json'),
    read('../../data/maps/enclosures.26542162.json'),
    read('../../data/maps/verified-builds/26542162/equivalence.json'),
  ]);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.targetBuildId, '26542162');
  const entries = catalog.mapPacks.filter(entry => String(entry.gameBuildId) === '26542162');
  assert.equal(entries.length, 208);
  const packs = await Promise.all(entries.map(async entry => {
    const pack = await read(`../../data/maps/verified-builds/26542162/manifests/${entry.mapPackId}/map-pack.json`);
    const matched = sidecars.maps.filter(item => item.mapPackId === pack.mapPackId);
    assert.equal(matched.length, 1, entry.sceneName);
    pack.mapEnclosures = { ...matched[0], schemaVersion: sidecars.schemaVersion, authority: sidecars.authority };
    assert.ok(normalizeMapEnclosures(pack.mapEnclosures, pack), entry.sceneName);
    return pack;
  }));
  let swampExits = 0, volcanoExits = 0;
  for (const pack of packs) {
    const before = JSON.stringify(pack);
    const exit = pack.layers.find(layer => layer.segment === 3);
    const terminal = pack.layers.find(layer => layer.segment === 4);
    const context = chapterEnclosures(pack, exit, { includeContext: true });
    assert.deepEqual(chapterEnclosures(pack, exit), [], `${pack.sceneName}: adjacency must be opt-in`);
    if (pack.route.branch === 'swamp-temple') {
      swampExits++;
      assert.equal(context.length, 1, pack.sceneName);
      assert.equal(context[0].sourceRootName, 'Gloom Temple');
      assert.equal(context[0].segment, 4);
      assert.deepEqual(context[0], pack.mapEnclosures.enclosures[0]);
    } else {
      assert.equal(pack.route.branch, 'volcano-kiln');
      volcanoExits++;
      assert.deepEqual(context, [pack.mapEnclosures.enclosures[0]], pack.sceneName);
      assert.equal(context[0].sourceRootName, 'VolcanoModel');
      assert.equal(context[0].sourceModelName, 'Pipe');
      assert.deepEqual(context[0].sourceHierarchy, ['Map', 'Biome_4', 'Caldera', 'VolcanoModel']);
    }
    for (const includeContext of [false, true]) {
      const own = chapterEnclosures(pack, terminal, { includeContext });
      assert.equal(own.length, 1, `${pack.sceneName}: terminal keeps one native shell`);
      assert.deepEqual(own[0], pack.mapEnclosures.enclosures[0]);
    }
    const overview = pack.layers.flatMap(layer => chapterEnclosures(pack, layer));
    assert.equal(overview.length, 1, `${pack.sceneName}: overview never duplicates its shell`);
    assert.equal(JSON.stringify(pack), before, `${pack.sceneName}: source identity and bounds remain unchanged`);
  }
  assert.equal(swampExits, 104);
  assert.equal(volcanoExits, 104);

  const kiln = packs.find(pack => pack.route.branch === 'volcano-kiln');
  const caldera = kiln.layers.find(layer => layer.segment === 3);
  for (const mutate of [
    shell => { shell.sourceModelName = 'other'; }, shell => { shell.sourceRootName = 'inactive volcano'; },
    shell => { shell.sourceHierarchy = ['Map', 'Caldera', 'VolcanoModel']; },
    shell => { shell.sourceHierarchy = 'Map/Biome_4/Caldera/VolcanoModel'; },
  ]) {
    const invalid = structuredClone(kiln);
    mutate(invalid.mapEnclosures.enclosures[0]);
    assert.deepEqual(chapterEnclosures(invalid, caldera, { includeContext: true }), []);
  }

  // Live Level_107 stood on this source enclosure at the Swamp campfire,
  // before the base Temple layer's Z bounds. A chapter switch must not be
  // required just to draw the existing adjacent entrance platform.
  const sample = packs.find(pack => pack.sceneName === 'Level_107');
  const ground = [10.513298, 805.9373, 1977.15759];
  const terminal = sample.layers.find(layer => layer.segment === 4);
  assert.ok(ground[2] < terminal.minZ);
  const [shell] = chapterEnclosures(sample, sample.layers.find(layer => layer.segment === 3), { includeContext: true });
  assert.equal(shell.geometrySha256, 'c1eaef35acdb037dad2fd2d53fa58dbe0c7a7304dcb24789470ebaaac3240476');
  assert.ok(ground.every((value, axis) => value >= shell.meshBounds.min[axis] && value <= shell.meshBounds.max[axis]));
});
