import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { MeshoptDecoder } from '../../vendor/three/0.180.0/examples/jsm/libs/meshopt_decoder.module.js';
import { geometryMarkers, multiplyMatrices, parseGlb, readFloatAccessor, transformMatrix, worldBoundsCenter }
  from '../../tools/offline-maps/export-loot-from-geometry.mjs';

await MeshoptDecoder.ready;
const layer = { id: 'segment-04-swamp', segment: 4, geometrySha256: 'a'.repeat(64) };
const near = (actual, expected) => actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-10, `${actual} != ${expected}`));
function fixture(nodes, extra = {}) {
  return { json: { nodes, meshes: [{ name: 'Luggage_Small', primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: [0, 0, 0], max: [2, 2, 2] }], ...extra }, binary: Buffer.alloc(0) };
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
  glb.json.accessors[0] = { min: [99, 198, -304], max: [101, 202, -296] };
  const marker = geometryMarkers(glb, layer)[0];
  assert.deepEqual(marker.pos, [100, 200, -300]);
  assert.deepEqual(marker.source.modelOrigin, [0, 0, 0]);
});

test('compressed GPU instances each produce their own exact body position', () => {
  // meshoptimizer 1.2 ATTRIBUTES vector: two float32 VEC3 rows [2,3,4], [-1,5,6].
  const binary = Buffer.from('oAAAATAAAAD/ATAAAAD+AAABMAAAAMAAAAABMAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAABAQAAAgEA=', 'base64');
  const glb = fixture([{ mesh: 0, translation: [10, 20, 30], extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } }]);
  glb.binary = binary;
  glb.json.accessors.push({ componentType: 5126, type: 'VEC3', count: 2, bufferView: 0 });
  glb.json.bufferViews = [{ extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: binary.length, count: 2, byteStride: 12, mode: 'ATTRIBUTES' } } }];
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
  glb.json.accessors.push({ min: [-100, -100, -100], max: [100, 100, 100] });
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
