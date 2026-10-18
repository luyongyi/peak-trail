import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MeshoptDecoder } from '../../vendor/three/0.180.0/examples/jsm/libs/meshopt_decoder.module.js';

// Exact body meshes, never lids, handles, clasps, decorative mushrooms, or
// inferred nearby pickups. Identity proof is recorded in the survey notes.
export const lootGeometryTypes = [
  { id: 'chest-small', category: 'chest', name: '小型行李箱', color: '#65d9ed', meshName: 'Luggage_Small' },
  { id: 'chest-large', category: 'chest', name: '大型行李箱', color: '#f2c777', meshName: 'Luggage_large' },
  { id: 'chest-epic', category: 'chest', name: '珍奇行李箱', color: '#c69cff', meshName: 'Epic Luggage' },
  { id: 'chest-ancient', category: 'chest', name: '古代行李箱', color: '#f09a72', meshName: 'ancient Luggage' },
  { id: 'chest-trick', category: 'chest', name: '恶作剧行李箱', color: '#f08dbc', meshName: 'Luggage_Trick' },
  { id: 'item-bird-nest', category: 'item', name: '鸟蛋巢', color: '#9ee3a7', meshName: 'BirdNest' },
  { id: 'item-shelf-shroom', category: 'item', name: '固定菌台', color: '#75d8bb', meshName: 'ShelfShroom' },
  { id: 'item-piton', category: 'item', name: '固定岩钉', color: '#9cb9dc', meshName: 'pickaxe' },
  { id: 'item-napberry', category: 'item', name: '睡眠浆果点', color: '#b7b7f6', meshName: 'Nap Berry' },
  // The original body has the generic mesh name Cube. Require its exact
  // authenticated material; M_Capybara Mirage is a different mesa prop.
  { id: 'animal-capybara', category: 'animal', name: '豚豚崽', color: '#e6ac69', meshName: 'Cube', materialName: 'M_Capybara' },
];

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function multiplyMatrices(left, right) {
  const result = Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let axis = 0; axis < 4; axis++) result[column * 4 + row] += left[axis * 4 + row] * right[column * 4 + axis];
    }
  }
  return result;
}

export function transformMatrix(node) {
  if (node.matrix) return [...node.matrix];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function point(matrix, value) {
  return [0, 1, 2].map(row => matrix[12 + row] + value[0] * matrix[row] + value[1] * matrix[4 + row] + value[2] * matrix[8 + row]);
}

export function worldBoundsCenter(matrix, min, max) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const p = point(matrix, [x, y, z]);
    for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], p[axis]); high[axis] = Math.max(high[axis], p[axis]); }
  }
  return low.map((value, axis) => (value + high[axis]) / 2);
}

export function parseGlb(bytes) {
  const buffer = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  if (buffer.toString('ascii', 0, 4) !== 'glTF' || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) throw new Error('Invalid GLB header');
  const length = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a) throw new Error('Missing GLB JSON');
  const json = JSON.parse(buffer.toString('utf8', 20, 20 + length));
  const binaryHeader = 20 + length;
  if (buffer.readUInt32LE(binaryHeader + 4) !== 0x004e4942) throw new Error('Missing GLB binary');
  return { json, binary: buffer.subarray(binaryHeader + 8, binaryHeader + 8 + buffer.readUInt32LE(binaryHeader)) };
}

export function readFloatAccessor(glb, index) {
  const accessor = glb.json.accessors[index];
  if (!accessor || accessor.componentType !== 5126 || accessor.sparse) throw new Error(`Unsupported float accessor ${index}`);
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
  if (!components) throw new Error(`Unsupported accessor type ${accessor.type}`);
  const view = glb.json.bufferViews[accessor.bufferView], compressed = view.extensions?.EXT_meshopt_compression;
  let bytes, stride;
  if (compressed) {
    if (compressed.buffer !== 0) throw new Error('External compressed buffer unsupported');
    const output = new Uint8Array(compressed.count * compressed.byteStride);
    const input = glb.binary.subarray(compressed.byteOffset || 0, (compressed.byteOffset || 0) + compressed.byteLength);
    MeshoptDecoder.decodeGltfBuffer(output, compressed.count, compressed.byteStride, input, compressed.mode, compressed.filter || 'NONE');
    bytes = Buffer.from(output); stride = compressed.byteStride;
  } else {
    if (view.buffer !== 0) throw new Error('Missing required meshopt decoder');
    bytes = glb.binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength); stride = view.byteStride || components * 4;
  }
  const offset = accessor.byteOffset || 0;
  if (offset + (accessor.count - 1) * stride + components * 4 > bytes.length) throw new Error('Accessor outside buffer view');
  return Array.from({ length: accessor.count }, (_, item) => Array.from({ length: components }, (_, component) => bytes.readFloatLE(offset + item * stride + component * 4)));
}

export function geometryMarkers(glb, layer) {
  const definitions = new Map(lootGeometryTypes.map(type => [type.meshName, type]));
  const markers = [], parents = new Map(), matrices = new Map();
  glb.json.nodes.forEach((node, parent) => (node.children || []).forEach(child => {
    if (parents.has(child)) throw new Error('Node has more than one parent');
    parents.set(child, parent);
  }));
  function worldMatrix(index, active = new Set()) {
    if (matrices.has(index)) return matrices.get(index);
    if (active.has(index)) throw new Error('GLB node cycle');
    active.add(index);
    const local = transformMatrix(glb.json.nodes[index]);
    const result = parents.has(index) ? multiplyMatrices(worldMatrix(parents.get(index), active), local) : local;
    active.delete(index); matrices.set(index, result); return result;
  }
  glb.json.nodes.forEach((node, nodeIndex) => {
    const mesh = glb.json.meshes[node.mesh], type = mesh && definitions.get(mesh.name);
    if (!type) return;
    const primitives = type.materialName ? mesh.primitives.filter(primitive => glb.json.materials?.[primitive.material]?.name === type.materialName) : mesh.primitives;
    if (!primitives.length) return;
    const accessors = primitives.map(primitive => glb.json.accessors[primitive.attributes.POSITION]);
    if (accessors.some(accessor => !accessor?.min || !accessor.max)) throw new Error(`Missing named body bounds: ${mesh.name}`);
    const min = [0, 1, 2].map(axis => Math.min(...accessors.map(a => a.min[axis])));
    const max = [0, 1, 2].map(axis => Math.max(...accessors.map(a => a.max[axis])));
    const instancing = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
    const translations = instancing?.TRANSLATION !== undefined ? readFloatAccessor(glb, instancing.TRANSLATION) : null;
    const rotations = instancing?.ROTATION !== undefined ? readFloatAccessor(glb, instancing.ROTATION) : null;
    const scales = instancing?.SCALE !== undefined ? readFloatAccessor(glb, instancing.SCALE) : null;
    const count = translations?.length ?? rotations?.length ?? scales?.length ?? 1;
    if ([translations, rotations, scales].some(values => values && values.length !== count)) throw new Error('Mismatched instance attributes');
    for (let instanceIndex = 0; instanceIndex < count; instanceIndex++) {
      const instance = instancing ? transformMatrix({ translation: translations?.[instanceIndex], rotation: rotations?.[instanceIndex], scale: scales?.[instanceIndex] }) : identity();
      const matrix = multiplyMatrices(worldMatrix(nodeIndex), instance), pos = worldBoundsCenter(matrix, min, max);
      if (!pos.every(value => Number.isFinite(value) && Math.abs(value) < 100000)) throw new Error('Invalid world placement');
      markers.push({
        id: `${layer.id}-${type.id}-${nodeIndex}-${instanceIndex}`, type: type.id, category: type.category, name: type.name, pos,
        segment: layer.segment, layerId: layer.id, placement: type.category === 'chest' ? 'randomized-candidate' : 'fixed',
        source: { geometrySha256: layer.geometrySha256, meshName: mesh.name, meshIndex: node.mesh, nodeName: node.name || '', nodeIndex,
          instanceIndex: instancing ? instanceIndex : null, anchor: 'geometry-bounds-center', modelOrigin: point(matrix, [0, 0, 0]),
          ...(type.materialName ? { materialName: type.materialName } : {}) },
      });
    }
  });
  // Render material groups may repeat one body; count its physical location once.
  const unique = new Map();
  for (const marker of markers) {
    const key = `${marker.type}:${marker.pos.map(value => Math.round(value * 10000)).join(',')}`;
    if (!unique.has(key)) unique.set(key, marker);
  }
  return [...unique.values()];
}

export async function exportGeometryLoot({ catalogPath, packsPath, outputPath, gameBuildId }) {
  await MeshoptDecoder.ready;
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const build = String(gameBuildId ?? catalog.activeGameBuildId), maps = [];
  for (const entry of catalog.mapPacks.filter(entry => entry.enabled !== false && String(entry.gameBuildId) === build).sort((a, b) => a.mapSlot - b.mapSlot)) {
    const folder = resolve(packsPath, entry.mapPackId), manifest = JSON.parse(await readFile(resolve(folder, 'map-pack.json'), 'utf8'));
    if (manifest.mapPackId !== entry.mapPackId || manifest.sceneName !== entry.sceneName || String(manifest.gameBuildId) !== build) throw new Error(`Canonical manifest mismatch: ${entry.sceneName}`);
    const markers = [];
    for (const layer of manifest.layers) {
      const bytes = await readFile(resolve(folder, layer.geometry));
      if (sha256(bytes) !== layer.geometrySha256) throw new Error(`Geometry checksum mismatch: ${entry.sceneName}/${layer.id}`);
      markers.push(...geometryMarkers(parseGlb(bytes), layer));
    }
    maps.push({ mapPackId: entry.mapPackId, sceneName: entry.sceneName, mapSlot: entry.mapSlot,
      sourceSceneSha256: manifest.source.sceneSha256,
      layers: manifest.layers.map(layer => ({ id: layer.id, segment: layer.segment, geometrySha256: layer.geometrySha256 })), markers });
    console.log(`${entry.sceneName}: ${markers.filter(marker => marker.category === 'chest').length} chest sites, ${markers.filter(marker => marker.category === 'item').length} fixed resource sites, ${markers.filter(marker => marker.category === 'animal').length} capybaras`);
  }
  const result = { schemaVersion: 1, gameBuildId: build,
    source: { kind: 'canonical-map-geometry-survey', anchor: 'geometry-bounds-center',
      positions: 'World AABB center of each named body mesh after its complete node hierarchy and GPU instance transform. Original model origins are retained per marker.',
      chestCoverage: 'All five identifiable luggage body meshes in every enabled canonical map. These meshes are also used by mirages and traps; scene placements are reference candidates, never a guarantee of a real chest or its contents.',
      itemCoverage: 'Authenticated named fixed resource or climbing landmark meshes: egg nests, shelf fungi, hammered pitons and sleep-berry sites. Nap Berry is also used by a fixed sleep-effect FakeItem. Spawned loose items and random item-spawner contents are absent from static map geometry.',
      animalCoverage: 'Individual fixed Capybara bodies identified by the exact Cube mesh and M_Capybara material in every canonical map. M_Capybara Mirage bodies are excluded. These are original map placements, not live animal state.',
      excluded: 'Unqualified generic mesh names, capybara mirages, chest lids and hardware, decorative props, unverified pickup locations, and data from another game build.' },
    types: lootGeometryTypes.map(({ meshName, materialName, ...definition }) => definition), maps };
  if (!maps.length) throw new Error('No canonical maps selected');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const args = process.argv.slice(2), option = (name, fallback) => {
    const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1];
  };
  const catalogPath = resolve(option('--catalog', resolve(platformRoot, 'data/maps/catalog.json')));
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const gameBuildId = String(option('--build', catalog.activeGameBuildId));
  await exportGeometryLoot({
    catalogPath, gameBuildId,
    packsPath: resolve(option('--packs', resolve(platformRoot, '../local/assets/maps/packs'))),
    outputPath: resolve(option('--output', resolve(platformRoot, `data/maps/loot.${gameBuildId}.json`))),
  });
}
