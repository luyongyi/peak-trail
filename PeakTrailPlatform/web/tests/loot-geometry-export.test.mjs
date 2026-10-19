import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { MeshoptDecoder } from '../../vendor/three/0.180.0/examples/jsm/libs/meshopt_decoder.module.js';
import { geometryMarkers, mergeSceneLoot, multiplyMatrices, parseGlb, readFloatAccessor, transformMatrix, worldBoundsCenter }
  from '../../tools/offline-maps/export-loot-from-geometry.mjs';

await MeshoptDecoder.ready;
const layer = { id: 'segment-04-swamp', segment: 4, geometrySha256: 'a'.repeat(64) };
const near = (actual, expected) => actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-10, `${actual} != ${expected}`));
function fixture(nodes, extra = {}) {
  const glb = { json: { nodes, meshes: [{ name: 'Luggage_Small', primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [], bufferViews: [], ...extra }, binary: Buffer.alloc(0) };
  boundsAccessor(glb, [0, 0, 0], [2, 2, 2]); return glb;
}
function appendAccessor(glb, values, type = 'VEC3', componentType = 5126) {
  const components = { SCALAR: 1, VEC3: 3 }[type], bytesPerComponent = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[componentType];
  const binary = Buffer.alloc(values.length * components * bytesPerComponent);
  const write = { 5121: 'writeUInt8', 5123: 'writeUInt16LE', 5125: 'writeUInt32LE', 5126: 'writeFloatLE' }[componentType];
  values.flat().forEach((value, index) => binary[write](value, index * bytesPerComponent));
  const bufferView = glb.json.bufferViews.length;
  glb.json.bufferViews.push({ buffer: 0, byteOffset: glb.binary.length, byteLength: binary.length });
  glb.binary = Buffer.concat([glb.binary, binary]);
  const accessor = { componentType, type, count: values.length, bufferView };
  if (type === 'VEC3') {
    accessor.min = [0, 1, 2].map(axis => Math.min(...values.map(value => value[axis])));
    accessor.max = [0, 1, 2].map(axis => Math.max(...values.map(value => value[axis])));
  }
  glb.json.accessors.push(accessor); return glb.json.accessors.length - 1;
}
function boundsAccessor(glb, min, max) {
  return appendAccessor(glb, [min, max]);
}

test('hierarchy, rotation and nonuniform scale preserve Unity XYZ without a second Z reflection', () => {
  const parent = transformMatrix({ translation: [10, 20, 30], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 3, 4] });
  const child = transformMatrix({ translation: [1, 2, 3] });
  near(worldBoundsCenter(multiplyMatrices(parent, child), [0, 0, 0], [2, 2, 2]), [26, 29, 26]);
  const glb = fixture([{ matrix: parent, children: [1] }, { mesh: 0, translation: [1, 2, 3] }]);
  const marker = geometryMarkers(glb, layer)[0];
  near(marker.pos, [26, 29, 26]);
  near(marker.source.modelOrigin, [22, 26, 28]);
  assert.equal(marker.layerId, layer.id);
  assert.equal(marker.segment, 4);
});

test('static-batched vertex bounds anchor the actual body even when its node is at world origin', () => {
  const glb = fixture([{ mesh: 0, name: 'Luggage_Small-affine' }]);
  glb.json.meshes[0].primitives[0].attributes.POSITION = boundsAccessor(glb, [99, 198, -304], [101, 202, -296]);
  const marker = geometryMarkers(glb, layer)[0];
  assert.deepEqual(marker.pos, [100, 200, -300]);
  assert.deepEqual(marker.source.modelOrigin, [0, 0, 0]);
});

test('compressed GPU instances each produce their own exact body position', () => {
  // meshoptimizer 1.2 ATTRIBUTES vector: two float32 VEC3 rows [2,3,4], [-1,5,6].
  const binary = Buffer.from('oAAAATAAAAD/ATAAAAD+AAABMAAAAMAAAAABMAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAABAQAAAgEA=', 'base64');
  const glb = fixture([{ mesh: 0, translation: [10, 20, 30], extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } }]);
  glb.json.accessors.push({ componentType: 5126, type: 'VEC3', count: 2, bufferView: 1 });
  glb.json.bufferViews.push({ extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: glb.binary.length, byteLength: binary.length, count: 2, byteStride: 12, mode: 'ATTRIBUTES' } } });
  glb.binary = Buffer.concat([glb.binary, binary]);
  assert.deepEqual(readFloatAccessor(glb, 1), [[2, 3, 4], [-1, 5, 6]]);
  const markers = geometryMarkers(glb, layer);
  assert.deepEqual(markers.map(marker => marker.pos), [[13, 24, 35], [10, 26, 37]]);
  assert.deepEqual(markers.map(marker => marker.source.instanceIndex), [0, 1]);
});

test('generic lids and repeated material bodies do not create extra chest markers', () => {
  const glb = fixture([{ mesh: 0 }, { mesh: 1 }, { mesh: 0 }]);
  glb.json.meshes.push({ name: 'Lid', primitives: [{ attributes: { POSITION: 0 } }] });
  const markers = geometryMarkers(glb, layer);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'chest-small');
  assert.equal(markers[0].placement, 'randomized-candidate');
});

test('capybara body requires its exact material and ignores mirages and unrelated primitive bounds', () => {
  const glb = fixture([{ mesh: 0, translation: [10, 20, 30] }, { mesh: 1 }, { mesh: 2 }, { mesh: 3 }]);
  glb.json.materials = [{ name: 'M_Capybara' }, { name: 'M_Capybara Mirage' }, { name: 'Rock' }];
  boundsAccessor(glb, [-100, -100, -100], [100, 100, 100]);
  glb.json.meshes = [
    { name: 'Cube', primitives: [{ material: 0, attributes: { POSITION: 0 } }, { material: 2, attributes: { POSITION: 1 } }] },
    { name: 'Cube', primitives: [{ material: 1, attributes: { POSITION: 0 } }] },
    { name: 'Cube', primitives: [{ material: 2, attributes: { POSITION: 0 } }] },
    { name: 'Cube.001', primitives: [{ material: 0, attributes: { POSITION: 0 } }] },
  ];
  const markers = geometryMarkers(glb, layer);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'animal-capybara');
  assert.equal(markers[0].category, 'animal');
  assert.equal(markers[0].name, '豚豚崽');
  assert.equal(markers[0].placement, 'fixed');
  assert.equal(markers[0].source.materialName, 'M_Capybara');
  assert.deepEqual(markers[0].pos, [11, 21, 31]);
});

test('material-selected bodies use their own index ranges within a shared POSITION accessor', () => {
  const glb = fixture([{ mesh: 0 }, { mesh: 1 }]);
  glb.json.materials = [{ name: 'M_Capybara' }, { name: 'M_Capybara Mirage' }];
  const position = appendAccessor(glb, [[-200, -200, -200], [2, 4, 6], [4, 6, 8], [40, 50, 60], [42, 52, 62], [300, 300, 300]]);
  const first = appendAccessor(glb, [1, 2, 1], 'SCALAR', 5123), second = appendAccessor(glb, [3, 4, 3], 'SCALAR', 5125);
  glb.json.meshes = [first, second].map(indices => ({ name: 'Cube', primitives: [
    { material: 0, indices, attributes: { POSITION: position } },
    { material: 1, attributes: { POSITION: position } },
  ] }));
  assert.deepEqual(geometryMarkers(glb, layer).map(marker => marker.pos), [[3, 5, 7], [41, 51, 61]]);
});

test('compressed index buffers also restrict bodies to their referenced vertices', () => {
  const glb = fixture([{ mesh: 0 }]);
  const position = appendAccessor(glb, [[1, 2, 3], [3, 4, 5], [2, 3, 4], [500, 500, 500]]);
  // meshoptimizer INDICES vector: three uint16 indices [0, 1, 2].
  const binary = Buffer.from('0QAEBAAAAAA=', 'base64'), bufferView = glb.json.bufferViews.length;
  glb.json.bufferViews.push({ extensions: { EXT_meshopt_compression: {
    buffer: 0, byteOffset: glb.binary.length, byteLength: binary.length, count: 3, byteStride: 2, mode: 'INDICES',
  } } });
  glb.binary = Buffer.concat([glb.binary, binary]);
  const indices = glb.json.accessors.push({ bufferView, componentType: 5123, count: 3, type: 'SCALAR' }) - 1;
  glb.json.meshes[0].primitives[0] = { attributes: { POSITION: position }, indices };
  assert.deepEqual(geometryMarkers(glb, layer)[0].pos, [2, 3, 4]);
});

test('climbing spikes require the authenticated climbing material and exclude ice scenery', () => {
  const glb = fixture([{ mesh: 0 }, { mesh: 1, translation: [100, 100, 100] }]);
  glb.json.materials = [{ name: 'M_ClimbingSpike' }, { name: 'M_Rock_ice' }];
  glb.json.meshes = [0, 1].map(material => ({ name: 'Spike', primitives: [{ material, attributes: { POSITION: 0 } }] }));
  const markers = geometryMarkers(glb, layer);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'item-climbing-spike');
  assert.equal(markers[0].source.materialName, 'M_ClimbingSpike');
});

test('amulet model sites retain candidate placement and exact metal material provenance', () => {
  const glb = fixture([{ mesh: 0 }, { mesh: 1, translation: [10, 20, 30] }, { mesh: 2 }]);
  glb.json.materials = [{ name: 'Tarnished Gold Medallion' }, { name: 'Rock' }, { name: 'Crystal_Seagull' }];
  const unrelated = boundsAccessor(glb, [-500, -500, -500], [500, 500, 500]);
  glb.json.meshes = [
    { name: 'Medallion_Bird', primitives: [{ material: 0, attributes: { POSITION: 0 } }, { material: 2, attributes: { POSITION: unrelated } }] },
    { name: 'Medallion_Goat', primitives: [{ material: 0, attributes: { POSITION: 0 } }] },
    { name: 'Medallion_Turtle', primitives: [{ material: 1, attributes: { POSITION: 0 } }] },
  ];
  const markers = geometryMarkers(glb, layer);
  assert.deepEqual(markers.map(marker => marker.type), ['item-amulet-bird', 'item-amulet-goat']);
  assert.deepEqual(markers.map(marker => marker.pos), [[1, 1, 1], [11, 21, 31]]);
  assert.ok(markers.every(marker => marker.placement === 'randomized-candidate' && marker.source.materialName === 'Tarnished Gold Medallion'));
});

test('invalid indices and missing vertex data fail instead of using broad accessor bounds', () => {
  const glb = fixture([{ mesh: 0 }]);
  glb.json.meshes[0].primitives[0].indices = appendAccessor(glb, [0, 2, 0], 'SCALAR', 5121);
  assert.throws(() => geometryMarkers(glb, layer), /index outside/);
  delete glb.json.meshes[0].primitives[0].indices;
  delete glb.json.accessors[0].bufferView;
  assert.throws(() => geometryMarkers(glb, layer), /buffer view/);
});

test('missing mesh bounds, cyclic parents and corrupted instance ranges fail closed', () => {
  const missingBounds = fixture([{ mesh: 0 }]);
  delete missingBounds.json.accessors[0].max;
  assert.throws(() => geometryMarkers(missingBounds, layer), /bounds/);
  assert.throws(() => geometryMarkers(fixture([{ mesh: 0, children: [1] }, { children: [0] }]), layer), /cycle/);
  const malformed = { json: { accessors: [{ componentType: 5126, type: 'VEC3', count: 2, bufferView: 0 }],
    bufferViews: [{ buffer: 0, byteLength: 12 }] }, binary: Buffer.alloc(12) };
  assert.throws(() => readFloatAccessor(malformed, 0), /outside/);
});

test('gzip and ordinary GLB parse identically, and invalid source headers are rejected', () => {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }).padEnd(32));
  const bytes = Buffer.alloc(20 + json.length + 8 + 4);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  bytes.writeUInt32LE(4, 20 + json.length); bytes.writeUInt32LE(0x004e4942, 24 + json.length);
  assert.deepEqual(parseGlb(gzipSync(bytes)), parseGlb(bytes));
  const broken = Buffer.from(bytes); broken.writeUInt32LE(1, 4);
  assert.throws(() => parseGlb(broken), /header/);
});

function surveys() {
  const type = { id: 'item-bird-nest', category: 'item', name: '鸟蛋巢', color: '#9ee3a7' };
  const identity = { mapPackId: `sha256-${'b'.repeat(64)}`, sceneName: 'Level_0', mapSlot: 0, sourceSceneSha256: 'c'.repeat(64), layers: [layer] };
  const geometry = { schemaVersion: 1, gameBuildId: '25739797', source: { kind: 'canonical-map-geometry-survey' },
    types: [type], maps: [{ ...identity, markers: [{ id: 'geometry-nest', type: type.id, category: 'item', pos: [1, 2, 3] }] }] };
  const sceneType = { id: 'item-backpack', category: 'item', name: '背包生成点', color: '#84bfe6' };
  const scene = { schemaVersion: 1, gameBuildId: '25739797', source: { kind: 'serialized-scene-item-survey' },
    types: [sceneType], maps: [{ ...identity, markers: [{ id: 'component-123', type: sceneType.id, category: 'item', name: sceneType.name,
      pos: [11, 22, 33], segment: layer.segment, layerId: layer.id, placement: 'randomized-candidate',
      source: { sourceKind: 'serialized-scene-component', component: 'SingleItemSpawner', componentPathId: '123',
        anchor: 'component-world-position', geometrySha256: layer.geometrySha256, sceneSha256: identity.sourceSceneSha256,
        conditions: { spawnChance: 0.5 } } }] }] };
  return { geometry, scene };
}

test('serialized scene placements merge only within matching map identities and retain candidate provenance', () => {
  const { geometry, scene } = surveys(), result = mergeSceneLoot(geometry, scene);
  assert.equal(result.types.length, 2);
  assert.equal(result.maps[0].markers.length, 2);
  const marker = result.maps[0].markers[1];
  assert.equal(marker.placement, 'randomized-candidate');
  assert.deepEqual(marker.source.conditions, { spawnChance: 0.5 });
  assert.equal(geometry.maps[0].markers.length, 1);
  assert.equal(geometry.types.length, 1);
});

function globalSurvey() {
  const { geometry, scene } = surveys(), marker = scene.maps[0].markers[0];
  marker.scope = 'global'; marker.segment = -1; marker.layerId = 'global';
  marker.source.scopeRoot = 'MapHandler.globalParent';
  delete marker.source.geometrySha256;
  return { geometry, scene, marker };
}

test('global-parent item placements bind to the scene without inventing a chapter or layer hash', () => {
  const { geometry, scene } = globalSurvey();
  const marker = mergeSceneLoot(geometry, scene).maps[0].markers[1];
  assert.equal(marker.scope, 'global');
  assert.equal(marker.segment, -1);
  assert.equal(marker.layerId, 'global');
  assert.equal(marker.source.scopeRoot, 'MapHandler.globalParent');
  assert.equal(marker.source.sceneSha256, geometry.maps[0].sourceSceneSha256);
  assert.equal(Object.hasOwn(marker.source, 'geometrySha256'), false);
});

test('global scope rejects forged roots, layer claims, source hashes, categories and unknown scopes', () => {
  const mutations = [
    marker => { marker.scope = 'whole-map'; },
    marker => { delete marker.scope; },
    marker => { marker.segment = 0; },
    marker => { marker.layerId = layer.id; },
    marker => { delete marker.source.scopeRoot; },
    marker => { marker.source.scopeRoot = 'MapHandler._segmentParent'; },
    marker => { marker.source.geometrySha256 = layer.geometrySha256; },
    marker => { marker.source.geometrySha256 = undefined; },
    marker => { marker.source.sceneSha256 = 'd'.repeat(64); },
    marker => { marker.source.sourceKind = 'unverified-scene'; },
    marker => { marker.category = 'animal'; },
  ];
  for (const mutate of mutations) {
    const { geometry, scene, marker } = globalSurvey(); mutate(marker);
    assert.throws(() => mergeSceneLoot(geometry, scene), /Scene loot survey mismatch/);
  }
  const { geometry, scene } = surveys();
  scene.maps[0].markers[0].source.scopeRoot = 'MapHandler.globalParent';
  assert.throws(() => mergeSceneLoot(geometry, scene), /Scene loot survey mismatch/);
});

function scoutSurvey() {
  const { geometry, scene } = surveys(), marker = scene.maps[0].markers[0];
  scene.types[0] = { id: 'item-scout-statue-reward', category: 'item', name: '终局雕像奖励点', color: '#b9d998' };
  marker.type = scene.types[0].id; marker.name = scene.types[0].name;
  Object.assign(marker.source, { component: 'ScoutStatue', anchor: 'referenced-transform-world-position',
    transformField: 'gemSpot', transformPathId: '456' });
  return { geometry, scene, marker };
}

test('ScoutStatue rewards retain the gemSpot transform anchor as conditional item candidates', () => {
  const { geometry, scene } = scoutSurvey(), marker = mergeSceneLoot(geometry, scene).maps[0].markers[1];
  assert.equal(marker.type, 'item-scout-statue-reward');
  assert.equal(marker.placement, 'randomized-candidate');
  assert.equal(marker.source.anchor, 'referenced-transform-world-position');
  assert.equal(marker.source.transformField, 'gemSpot');
  assert.equal(marker.source.transformPathId, '456');
});

test('gemSpot anchors reject other types, components, fields, zero transform IDs and fixed guarantees', () => {
  const mutations = [
    marker => { marker.source.component = 'SingleItemSpawner'; },
    marker => { marker.source.anchor = 'component-world-position'; },
    marker => { marker.source.transformField = 'm_Transform'; },
    marker => { marker.source.transformPathId = '0'; },
    marker => { marker.source.transformPathId = 456; },
    marker => { delete marker.source.transformPathId; },
    marker => { marker.placement = 'fixed'; },
    marker => { marker.type = 'item-bird-nest'; marker.name = '鸟蛋巢'; },
    marker => { marker.scope = 'global'; marker.segment = -1; marker.layerId = 'global';
      marker.source.scopeRoot = 'MapHandler.globalParent'; delete marker.source.geometrySha256; },
  ];
  for (const mutate of mutations) {
    const { geometry, scene, marker } = scoutSurvey(); mutate(marker);
    assert.throws(() => mergeSceneLoot(geometry, scene), /Scene loot survey mismatch/);
  }
  const { geometry, scene } = surveys();
  scene.maps[0].markers[0].source.anchor = 'referenced-transform-world-position';
  scene.maps[0].markers[0].source.transformField = 'gemSpot';
  scene.maps[0].markers[0].source.transformPathId = '456';
  assert.throws(() => mergeSceneLoot(geometry, scene), /Scene loot survey mismatch/);
});

test('component merges reject another build, scene, layer, provenance, type collision or duplicate marker', () => {
  const mutations = [
    scene => { scene.gameBuildId = '25306743'; },
    scene => { scene.maps[0].sourceSceneSha256 = 'd'.repeat(64); },
    scene => { scene.maps[0].mapSlot = 1; },
    scene => { scene.maps[0].layers = [{ ...layer, geometrySha256: 'd'.repeat(64) }]; },
    scene => { scene.maps[0].markers[0].source.sceneSha256 = 'd'.repeat(64); },
    scene => { scene.maps[0].markers[0].source.geometrySha256 = 'd'.repeat(64); },
    scene => { scene.maps[0].markers[0].source.componentPathId = 123; },
    scene => { scene.maps[0].markers[0].pos[0] = NaN; },
    scene => { scene.types.push({ id: 'item-bird-nest', category: 'item', name: 'wrong type', color: '#9ee3a7' }); },
    scene => { scene.maps[0].markers.push({ ...scene.maps[0].markers[0] }); },
  ];
  for (const mutate of mutations) {
    const { geometry, scene } = surveys(); mutate(scene);
    assert.throws(() => mergeSceneLoot(geometry, scene), /Scene loot survey mismatch/);
  }
});

test('explicit component replacement requires the same type definition and complete map coverage', () => {
  const { geometry, scene } = surveys();
  scene.types.push(geometry.types[0]); scene.removeTypes = ['item-bird-nest'];
  const marker = scene.maps[0].markers[0];
  marker.type = 'item-bird-nest'; marker.name = '鸟蛋巢';
  assert.deepEqual(mergeSceneLoot(geometry, scene).maps[0].markers.map(marker => marker.id), ['component-123']);
  geometry.maps.push({ ...geometry.maps[0], mapPackId: `sha256-${'e'.repeat(64)}`, sceneName: 'Level_1', mapSlot: 1 });
  assert.throws(() => mergeSceneLoot(geometry, scene), /replacement requires every map/);
});
