import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { compileMap, selectCampfireNodes } from '../offline-maps/compile-campfire-nodes.mjs';

// Generated terrain tiles throughout the chapter often have the same mesh
// name and transform. Preserve native vertex/index/material identity as well.
function tileFixture(nodeMeshes) {
  const meshes = [0, 1].map(i => ({ name: 'Generated mesh 0,0,0',
    primitives: [{ attributes: { POSITION: i }, indices: 2, material: i }] }));
  const doc = { scene: 0, scenes: [{ nodes: nodeMeshes.map((_, i) => i) }],
    nodes: nodeMeshes.map(mesh => ({ mesh })), meshes, materials: [{ name: 'Ash' }, { name: 'Sand' }],
    accessors: [{ count: 3 }, { count: 4 }, { count: 3 }] };
  const json = Buffer.from(JSON.stringify(doc)), bytes = Buffer.alloc(json.length + 28);
  bytes.write('glTF');
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12);
  json.copy(bytes, 20);
  return bytes;
}

const camp = { sourceRootName: 'Beach_Campfire',
  groups: [['Generated mesh 0,0,0', 4, [[3, 'Sand']], [[0, 0, 0]]]] };

test('equal-name native tiles at the same position select only the intended renderer', () => {
  const result = selectCampfireNodes(tileFixture([0, 1, 0]), camp);
  assert.deepEqual(result, { sourceRootName: 'Beach_Campfire', instanceCount: 1, ranges: [[1, 0, 1]] });
});

test('unmatched or ambiguous native renderer evidence rejects the entire chapter index', () => {
  assert.throws(() => selectCampfireNodes(tileFixture([0]), camp), /"wanted":1,"actual":0/);
  assert.throws(() => selectCampfireNodes(tileFixture([1, 1]), camp), /"wanted":1,"actual":2/);
});

function enclosureFixture(vertex) {
  const bytes = Buffer.alloc(44);
  bytes.writeFloatLE(vertex, 0);
  const doc = { scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [0, 0, 0] }],
    meshes: [{ name: 'Camp', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] }],
    materials: [{ name: 'Gold' }], accessors: [
      { bufferView: 0, type: 'VEC3', componentType: 5126, count: 3 },
      { bufferView: 1, type: 'SCALAR', componentType: 5123, count: 3 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    buffers: [{ byteLength: bytes.length }] };
  const json = Buffer.from(JSON.stringify(doc)), header = Buffer.alloc(20);
  const text = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const binHeader = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + text.length + bytes.length, 8);
  header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(bytes.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return gzipSync(Buffer.concat([header, text, binHeader, bytes]));
}

test('a second enclosure copy requires identical vertex data as well as matching selectors', async t => {
  const site = await mkdtemp(path.join(tmpdir(), 'peak-campfire-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  const mapPackId = 'sha256-' + '1'.repeat(64);
  const dir = path.join(site, 'data/maps/packs', mapPackId), shells = path.join(site, 'data/maps/enclosures');
  await Promise.all([mkdir(dir, { recursive: true }), mkdir(shells, { recursive: true })]);
  const hash = data => createHash('sha256').update(data).digest('hex');
  const source = enclosureFixture(1), digest = hash(source);
  await writeFile(path.join(dir, 'stage.glb.gz'), source);
  await writeFile(path.join(dir, 'map-pack.json'), JSON.stringify({ mapPackId, mapSlot: 0, sceneName: 'Level_0',
    layers: [{ segment: 0, geometry: 'stage.glb.gz', geometrySha256: digest, geometryFormat: 'glb-instanced-v1+gzip' }] }));
  async function compile(other) {
    const enclosureSha256 = hash(other);
    await writeFile(path.join(shells, enclosureSha256 + '.glb.gz'), other);
    return compileMap({ mapPackId, chapters: [[digest, { sourceRootName: 'Campfire-Temple', enclosureSha256,
      groups: [['Camp', 3, [[3, 'Gold']], [[0, 0, 0]]]] }]] }, site);
  }
  const equal = await compile(source);
  assert.equal(equal.chapters[0][1].includedInNextEnclosure, true);
  assert.deepEqual(equal.chapters[0][1].ranges, [[0, 0, 1]]);
  await assert.rejects(compile(enclosureFixture(2)), /Level_0\/0/);
});
