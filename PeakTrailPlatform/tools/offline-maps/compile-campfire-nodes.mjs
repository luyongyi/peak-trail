import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

function positionKey(position) {
  return position.map(Math.fround).join(',');
}

function signature(mesh, gltf) {
  const vertexCount = gltf.accessors[mesh.primitives[0].attributes.POSITION].count;
  const primitives = mesh.primitives.map(primitive => {
    assert.equal(gltf.accessors[primitive.attributes.POSITION].count, vertexCount);
    return [gltf.accessors[primitive.indices].count, gltf.materials[primitive.material].name];
  });
  return JSON.stringify([mesh.name, vertexCount, primitives]);
}

function viewBytes(gltf, buffer, index, decoder) {
  const view = gltf.bufferViews[index];
  const ext = view.extensions?.EXT_meshopt_compression;
  if (ext) {
    assert.equal(ext.buffer, 0);
    const bytes = new Uint8Array(ext.count * ext.byteStride);
    decoder.decodeGltfBuffer(bytes, ext.count, ext.byteStride,
      buffer.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength), ext.mode, ext.filter);
    return bytes;
  }
  assert.equal(view.buffer, 0);
  return buffer.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
}

function translations(gltf, buffer, node, decoder) {
  const attributes = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
  if (!attributes) return [node.matrix?.slice(12, 15) || node.translation || [0, 0, 0]];
  assert.ok(!node.matrix && !node.translation && !node.rotation && !node.scale);
  const accessor = gltf.accessors[attributes.TRANSLATION];
  assert.equal(accessor.type, 'VEC3');
  assert.equal(accessor.componentType, 5126);
  const view = gltf.bufferViews[accessor.bufferView];
  assert.equal(view.extensions?.EXT_meshopt_compression?.byteStride ?? view.byteStride ?? 12, 12);
  const bytes = viewBytes(gltf, buffer, accessor.bufferView, decoder);
  const positions = [], values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < accessor.count; i++) {
    const offset = (accessor.byteOffset || 0) + i * (view.byteStride || 12);
    positions.push([0, 4, 8].map(k => values.getFloat32(offset + k, true)));
  }
  return positions;
}

function unpack(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonEnd = 20 + bytes.readUInt32LE(12);
  return { gltf: JSON.parse(bytes.toString('utf8', 20, jsonEnd)), buffer: bytes.subarray(jsonEnd + 8) };
}

export function selectCampfireNodes(bytes, template, decoder) {
  const { gltf, buffer } = unpack(bytes);
  const expected = new Map(), matches = new Map(), ranges = [];
  let instanceCount = 0;
  for (const [name, vertices, materials, points] of template.groups) {
    const group = JSON.stringify([name, vertices, materials]);
    assert.ok(!expected.has(group));
    const counts = new Map();
    for (const p of points) counts.set(positionKey(p), (counts.get(positionKey(p)) || 0) + 1);
    expected.set(group, counts);
    matches.set(group, new Map());
    instanceCount += points.length;
  }
  const keys = gltf.meshes.map(mesh => signature(mesh, gltf));
  for (const nodeId of gltf.scenes[gltf.scene].nodes) {
    const node = gltf.nodes[nodeId];
    assert.ok(!node.children?.length, 'Expected original flat source mesh instances');
    const group = keys[node.mesh], wanted = expected.get(group);
    if (!wanted) continue;
    const observed = matches.get(group);
    let run;
    for (const [i, xyz] of translations(gltf, buffer, node, decoder).entries()) {
      const key = positionKey(xyz);
      if (!wanted.has(key)) { run = null; continue; }
      observed.set(key, (observed.get(key) || 0) + 1);
      if (run) run[2]++;
      else { run = [nodeId, i, 1]; ranges.push(run); }
    }
  }
  const mismatches = [];
  for (const [group, positions] of expected) {
    for (const [key, wanted] of positions) {
      const actual = matches.get(group).get(key) || 0;
      if (wanted !== actual) mismatches.push({ group, key, wanted, actual });
    }
  }
  if (mismatches.length) throw new Error(JSON.stringify(mismatches.slice(0, 8)));
  assert.equal(ranges.reduce((sum, range) => sum + range[2], 0), instanceCount);
  return { sourceRootName: template.sourceRootName, instanceCount, ranges };
}

// These 104 Gloom Temple subtrees each contain one standalone renderer. Prove
// both independently published copies share the complete authored transform,
// triangles, vertex attributes and material before suppressing either copy.
function enclosureMember(bytes, mask, decoder) {
  const { gltf, buffer } = unpack(bytes);
  assert.equal(mask.instanceCount, 1);
  const [[nodeId, start, count]] = mask.ranges;
  assert.equal(start, 0);
  assert.equal(count, 1);
  const node = gltf.nodes[nodeId];
  assert.ok(!node.extensions?.EXT_mesh_gpu_instancing);
  const hashView = index => createHash('sha256').update(viewBytes(gltf, buffer, index, decoder)).digest('hex');
  function attribute(id) {
    const { bufferView, ...info } = gltf.accessors[id];
    return { ...info, bytesSha256: hashView(bufferView) };
  }
  function material(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(material);
    const result = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, material(v)]));
    if (Number.isInteger(value.index)) {
      const texture = gltf.textures[value.index];
      const image = gltf.images[texture.source];
      assert.equal(image.uri, undefined);
      result.index = { imageSha256: hashView(image.bufferView), sampler: gltf.samplers[texture.sampler] };
    }
    return result;
  }
  return {
    transform: [node.matrix, node.translation, node.rotation, node.scale],
    mesh: gltf.meshes[node.mesh].primitives.map(p => ({
      attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, id]) => [k, attribute(id)])),
      indices: attribute(p.indices), material: material(gltf.materials[p.material]), mode: p.mode,
    })),
  };
}

export async function compileMap(row, site, decoder) {
  assert.match(row.mapPackId, /^sha256-[a-f0-9]{64}$/);
  const dir = path.join(site, 'data/maps/packs', row.mapPackId);
  const manifest = JSON.parse(await readFile(path.join(dir, 'map-pack.json'), 'utf8'));
  assert.equal(manifest.mapPackId, row.mapPackId);
  const result = [];
  for (const [stage, [digest, template]] of row.chapters.entries()) {
    const layer = manifest.layers[stage];
    assert.equal(layer.segment, stage);
    assert.equal(layer.geometrySha256, digest);
    assert.ok(template, `Missing native campfire evidence for ${manifest.sceneName}/${stage}`);
    try {
      assert.match(layer.geometry, /^[\w.-]+$/);
      const stored = await readFile(path.join(dir, layer.geometry));
      assert.equal(createHash('sha256').update(stored).digest('hex'), digest);
      const bytes = layer.geometryFormat === 'glb-instanced-v1+gzip'
        ? gunzipSync(stored, { maxOutputLength: 128 * 1024 * 1024 }) : stored;
      const mask = selectCampfireNodes(bytes, template, decoder);
      if (template.enclosureSha256) {
        assert.match(template.enclosureSha256, /^[a-f0-9]{64}$/);
        const enclosure = await readFile(path.join(site, 'data/maps/enclosures', template.enclosureSha256 + '.glb.gz'));
        assert.equal(createHash('sha256').update(enclosure).digest('hex'), template.enclosureSha256);
        const uncompressed = gunzipSync(enclosure, { maxOutputLength: 128 * 1024 * 1024 });
        const inside = selectCampfireNodes(uncompressed, template, decoder);
        assert.deepEqual(enclosureMember(bytes, mask, decoder), enclosureMember(uncompressed, inside, decoder));
        mask.includedInNextEnclosure = true;
        mask.enclosureSha256 = template.enclosureSha256;
      }
      result.push([digest, mask]);
    } catch (error) {
      throw new Error(`${manifest.sceneName}/${stage}: ${error.message}`);
    }
  }
  return { mapPackId: row.mapPackId, mapSlot: manifest.mapSlot, chapters: result };
}

export async function decoderFromSite(site) {
  const url = pathToFileURL(path.join(site, 'vendor/three/0.180.0/examples/jsm/libs/meshopt_decoder.module.js'));
  const { MeshoptDecoder } = await import(url.href);
  await MeshoptDecoder.ready;
  return MeshoptDecoder;
}

export async function writeShards(compiled, output, builds) {
  const bySlot = new Map(compiled.map(row => [row.mapSlot, row]));
  assert.equal(bySlot.size, 208);
  const receipt = JSON.parse(await readFile(path.join(builds, '26542162/equivalence.json'), 'utf8'));
  assert.equal(receipt.verified, true);
  assert.equal(receipt.sourceBuildId, '26155610');
  assert.equal(receipt.targetBuildId, '26542162');
  const legacyBySlot = new Map(receipt.maps.map(map => [map.mapSlot, map]));
  await mkdir(output, { recursive: true });
  for (let start = 0; start < 208; start += 8) {
    const entries = [];
    for (let slot = start; slot < start + 8; slot++) {
      const row = bySlot.get(slot);
      assert.ok(row, `Missing verified map slot ${slot}`);
      const source = legacyBySlot.get(slot);
      const legacy = await readFile(path.join(builds, '26155610/manifests', source.sourceMapPackId, 'map-pack.json'));
      assert.equal(createHash('sha256').update(legacy).digest('hex'), source.sourceManifestSha256);
      const manifest = JSON.parse(legacy);
      assert.equal(manifest.mapSlot, slot);
      assert.equal(manifest.mapPackId, source.sourceMapPackId);
      assert.equal(row.chapters.length, 4);
      assert.ok(row.chapters.every(([, mask]) => mask?.instanceCount > 0));
      assert.deepEqual(manifest.layers.slice(0, 4).map(l => l.geometrySha256), row.chapters.map(([digest]) => digest));
      entries.push([row.mapPackId, manifest.mapPackId, row.chapters]);
    }
    const name = String(start / 8).padStart(2, '0');
    const members = entries.map(entry => '  ' + JSON.stringify(entry));
    const source = '// Generated from verified native campfire and published mesh identities.\n'
      + 'export default [\n' + members.join(',\n') + '\n];\n';
    await writeFile(path.join(output, name + '.js'), source);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [input, site, output, builds] = process.argv.slice(2);
  if (!input || !site || !output || !builds) throw new Error('Usage: node compile-campfire-nodes.mjs NATIVE_ROWS.jsonl STAGED_SITE OUTPUT_DIRECTORY VERIFIED_BUILDS_DIRECTORY');
  const decoder = await decoderFromSite(site), compiled = [];
  for (const line of (await readFile(input, 'utf8')).trim().split(/\r?\n/)) {
    compiled.push(await compileMap(JSON.parse(line), site, decoder));
  }
  await writeShards(compiled, output, builds);
}
