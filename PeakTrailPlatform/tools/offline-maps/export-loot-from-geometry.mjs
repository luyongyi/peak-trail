import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MeshoptDecoder } from '../../vendor/three/0.180.0/examples/jsm/libs/meshopt_decoder.module.js';

const localizedLabels = JSON.parse(await readFile(new URL('../../data/maps/loot-labels.zh-CN.json', import.meta.url), 'utf8'));
if (localizedLabels.schemaVersion !== 1 || localizedLabels.locale !== 'zh-CN') throw new Error('Invalid native Chinese marker labels');
function nativeMarkerName(id) {
  const name = localizedLabels.labels[id]?.name;
  if (typeof name !== 'string' || !name.trim()) throw new Error(`Missing native Chinese marker label: ${id}`);
  return name;
}
function englishMarkerName(id) {
  const name = localizedLabels.labels[id]?.nameEn;
  if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new Error(`Missing English marker label: ${id}`);
  return name;
}

// Exact body meshes, never lids, handles, clasps, decorative mushrooms, or
// inferred nearby pickups. Identity proof is recorded in the survey notes.
export const lootGeometryTypes = [
  { id: 'chest-small', category: 'chest', color: '#65d9ed', meshName: 'Luggage_Small' },
  { id: 'chest-large', category: 'chest', color: '#f2c777', meshName: 'Luggage_large' },
  { id: 'chest-epic', category: 'chest', color: '#c69cff', meshName: 'Epic Luggage' },
  { id: 'chest-ancient', category: 'chest', color: '#f09a72', meshName: 'ancient Luggage' },
  { id: 'chest-trick', category: 'chest', color: '#f08dbc', meshName: 'Luggage_Trick' },
  { id: 'item-bird-nest', category: 'item', color: '#9ee3a7', meshName: 'BirdNest' },
  { id: 'item-shelf-shroom', category: 'item', color: '#75d8bb', meshName: 'ShelfShroom' },
  { id: 'item-piton', category: 'item', color: '#9cb9dc', meshName: 'pickaxe' },
  { id: 'item-napberry', category: 'item', color: '#b7b7f6', meshName: 'Nap Berry' },
  { id: 'item-climbing-spike', category: 'item', color: '#c2dceb', meshName: 'Spike', materialName: 'M_ClimbingSpike' },
  // FakeAmulet's scene models mark AmuletSpawner reference sites. They are
  // candidate sites rather than a promise that the run produces an amulet.
  { id: 'item-amulet-bird', category: 'item', color: '#d7d4a1', meshName: 'Medallion_Bird', materialName: 'Tarnished Gold Medallion', placement: 'randomized-candidate' },
  { id: 'item-amulet-goat', category: 'item', color: '#b6c9e0', meshName: 'Medallion_Goat', materialName: 'Tarnished Gold Medallion', placement: 'randomized-candidate' },
  { id: 'item-amulet-turtle', category: 'item', color: '#a7d1af', meshName: 'Medallion_Turtle', materialName: 'Tarnished Gold Medallion', placement: 'randomized-candidate' },
  { id: 'item-amulet-bingbong', category: 'item', color: '#cfabe0', meshName: 'Medallion_BingBong', materialName: 'Tarnished Gold Medallion', placement: 'randomized-candidate' },
  // The original body has the generic mesh name Cube. Require its exact
  // authenticated material; M_Capybara Mirage is a different mesa prop.
  { id: 'animal-capybara', category: 'animal', color: '#e6ac69', meshName: 'Cube', materialName: 'M_Capybara' },
].map(type => ({ ...type, name: nativeMarkerName(type.id), nameEn: englishMarkerName(type.id) }));

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

function accessorReader(glb, index, views = new Map()) {
  const accessor = glb.json.accessors[index];
  const componentBytes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[accessor?.componentType];
  if (!accessor || !componentBytes || accessor.sparse || !Number.isInteger(accessor.count) || accessor.count < 1) throw new Error(`Unsupported accessor ${index}`);
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
  if (!components) throw new Error(`Unsupported accessor type ${accessor.type}`);
  if (!views.has(accessor.bufferView)) {
    const view = glb.json.bufferViews?.[accessor.bufferView], compressed = view?.extensions?.EXT_meshopt_compression;
    if (!view) throw new Error(`Missing accessor buffer view ${index}`);
    let bytes, stride;
    if (compressed) {
      if (compressed.buffer !== 0) throw new Error('External compressed buffer unsupported');
      const output = new Uint8Array(compressed.count * compressed.byteStride);
      const input = glb.binary.subarray(compressed.byteOffset || 0, (compressed.byteOffset || 0) + compressed.byteLength);
      if (input.length !== compressed.byteLength) throw new Error('Compressed accessor outside buffer');
      MeshoptDecoder.decodeGltfBuffer(output, compressed.count, compressed.byteStride, input, compressed.mode, compressed.filter || 'NONE');
      bytes = Buffer.from(output); stride = compressed.byteStride;
    } else {
      if (view.buffer !== 0) throw new Error('External accessor buffer unsupported');
      bytes = glb.binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength); stride = view.byteStride;
      if (bytes.length !== view.byteLength) throw new Error('Accessor outside buffer view');
    }
    views.set(accessor.bufferView, { bytes, stride });
  }
  const { bytes, stride: viewStride } = views.get(accessor.bufferView);
  const offset = accessor.byteOffset || 0, stride = viewStride || components * componentBytes;
  if (!Number.isInteger(offset) || offset < 0 || stride < components * componentBytes
      || offset + (accessor.count - 1) * stride + components * componentBytes > bytes.length) throw new Error('Accessor outside buffer view');
  const read = accessor.componentType === 5126 ? 'readFloatLE' : accessor.componentType === 5125 ? 'readUInt32LE'
    : accessor.componentType === 5123 ? 'readUInt16LE' : 'readUInt8';
  return { accessor, components, get: (item, component = 0) => bytes[read](offset + item * stride + component * componentBytes) };
}

export function readFloatAccessor(glb, index) {
  if (glb.json.accessors[index]?.componentType !== 5126) throw new Error(`Unsupported float accessor ${index}`);
  const { accessor, components, get } = accessorReader(glb, index);
  return Array.from({ length: accessor.count }, (_, item) => Array.from({ length: components }, (_, component) => get(item, component)));
}

function referencedPrimitiveBounds(glb, primitive, views, boundsCache) {
  const key = `${primitive.attributes.POSITION}:${primitive.indices ?? 'all'}`;
  if (boundsCache.has(key)) return boundsCache.get(key);
  const positions = accessorReader(glb, primitive.attributes.POSITION, views), source = positions.accessor;
  if (source.componentType !== 5126 || source.type !== 'VEC3' || !source.min || !source.max) throw new Error('Missing named body bounds or position data');
  const indices = primitive.indices === undefined ? null : accessorReader(glb, primitive.indices, views);
  if (indices && (indices.accessor.type !== 'SCALAR' || ![5121, 5123, 5125].includes(indices.accessor.componentType))) throw new Error('Unsupported primitive indices');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let item = 0, count = indices?.accessor.count ?? source.count; item < count; item++) {
    const vertex = indices ? indices.get(item) : item;
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= source.count) throw new Error('Primitive index outside position accessor');
    for (let axis = 0; axis < 3; axis++) {
      const value = positions.get(vertex, axis);
      if (!Number.isFinite(value)) throw new Error('Invalid body vertex');
      min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
  }
  const bounds = { min, max }; boundsCache.set(key, bounds); return bounds;
}

export function geometryMarkers(glb, layer) {
  const definitions = new Map();
  for (const type of lootGeometryTypes) {
    if (!definitions.has(type.meshName)) definitions.set(type.meshName, []);
    definitions.get(type.meshName).push(type);
  }
  const markers = [], parents = new Map(), matrices = new Map(), views = new Map(), boundsCache = new Map();
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
    const mesh = glb.json.meshes[node.mesh], types = mesh && definitions.get(mesh.name);
    if (!types) return;
    for (const type of types) {
      const primitives = type.materialName ? mesh.primitives.filter(primitive => glb.json.materials?.[primitive.material]?.name === type.materialName) : mesh.primitives;
      if (!primitives.length) continue;
      // Static batches can share a POSITION accessor with unrelated scenery.
      // The primitive's referenced vertices alone identify this physical body.
      const bounds = primitives.map(primitive => referencedPrimitiveBounds(glb, primitive, views, boundsCache));
      const min = [0, 1, 2].map(axis => Math.min(...bounds.map(a => a.min[axis])));
      const max = [0, 1, 2].map(axis => Math.max(...bounds.map(a => a.max[axis])));
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
          segment: layer.segment, layerId: layer.id, placement: type.placement ?? (type.category === 'chest' ? 'randomized-candidate' : 'fixed'),
          source: { geometrySha256: layer.geometrySha256, meshName: mesh.name, meshIndex: node.mesh, nodeName: node.name || '', nodeIndex,
            instanceIndex: instancing ? instanceIndex : null, anchor: 'geometry-bounds-center', modelOrigin: point(matrix, [0, 0, 0]),
            ...(type.materialName ? { materialName: type.materialName } : {}) },
        });
      }
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

/** Add placements recovered from the exact build's serialized scene components. */
export function mergeSceneLoot(geometry, sceneLoot) {
  const fail = reason => { throw new Error(`Scene loot survey mismatch: ${reason}`); };
  if (sceneLoot?.schemaVersion !== 1 || String(sceneLoot.gameBuildId) !== String(geometry.gameBuildId)
      || sceneLoot.source?.kind !== 'serialized-scene-item-survey' || !Array.isArray(sceneLoot.maps)
      || !Array.isArray(sceneLoot.types) || sceneLoot.types.length > 256) fail('build or schema');
  const types = new Map(geometry.types.map(type => [type.id, type]));
  const sceneTypes = new Set();
  for (const type of sceneLoot.types) {
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(type?.id || '') || sceneTypes.has(type.id) || type.category !== 'item'
        || typeof type.name !== 'string' || !type.name.trim() || type.name.length > 100
        || (type.nameEn !== undefined && (typeof type.nameEn !== 'string' || !type.nameEn.trim() || type.nameEn.length > 128))
        || !/^#[a-f0-9]{6}$/i.test(type.color || '')) fail('type definition');
    const existing = types.get(type.id);
    if (existing && (existing.name !== type.name || existing.category !== type.category || existing.color !== type.color)) fail(`type ${type.id}`);
    if (existing?.nameEn !== undefined && type.nameEn !== undefined && existing.nameEn !== type.nameEn) fail(`type ${type.id} English label`);
    const nameEn = type.nameEn ?? existing?.nameEn;
    sceneTypes.add(type.id); types.set(type.id, { id: type.id, category: type.category, name: type.name,
      ...(nameEn === undefined ? {} : { nameEn }), color: type.color });
  }
  const removeTypes = sceneLoot.removeTypes || [];
  if (!Array.isArray(removeTypes) || new Set(removeTypes).size !== removeTypes.length
      || removeTypes.some(id => geometry.types.find(type => type.id === id)?.category !== 'item' || !sceneTypes.has(id))) fail('replacement types');
  const expected = new Map(geometry.maps.map(map => [map.mapPackId, map])), additions = new Map();
  for (const map of sceneLoot.maps) {
    const target = expected.get(map?.mapPackId);
    if (!target || additions.has(map.mapPackId) || map.sceneName !== target.sceneName || map.mapSlot !== target.mapSlot
        || map.sourceSceneSha256 !== target.sourceSceneSha256 || !Array.isArray(map.layers) || map.layers.length !== target.layers.length
        || !Array.isArray(map.markers) || map.markers.length > 50000) fail(`map ${map?.sceneName}`);
    const layers = new Map(target.layers.map(layer => [layer.id, layer]));
    const seenLayers = new Set();
    for (const layer of map.layers) {
      const bound = layers.get(layer?.id);
      if (!bound || seenLayers.has(layer.id) || layer.segment !== bound.segment || layer.geometrySha256 !== bound.geometrySha256) fail(`layer ${layer?.id}`);
      seenLayers.add(layer.id);
    }
    const ids = new Set(target.markers.filter(marker => !removeTypes.includes(marker.type)).map(marker => marker.id));
    const markers = map.markers.map(marker => {
      const type = types.get(marker?.type), layer = layers.get(marker?.layerId), source = marker?.source;
      const validScope = marker?.scope === 'global'
        ? marker.segment === -1 && marker.layerId === 'global' && source?.scopeRoot === 'MapHandler.globalParent'
          && !Object.hasOwn(source, 'geometrySha256')
        : marker?.scope === undefined && layer && marker.segment === layer.segment
          && source?.geometrySha256 === layer.geometrySha256 && source?.scopeRoot !== 'MapHandler.globalParent';
      const validAnchor = source?.component === 'ScoutStatue' || marker?.type === 'item-scout-statue-reward'
        ? marker?.type === 'item-scout-statue-reward' && marker.scope === undefined && marker.placement === 'randomized-candidate'
          && source?.component === 'ScoutStatue' && source.anchor === 'referenced-transform-world-position'
          && source.transformField === 'gemSpot' && typeof source.transformPathId === 'string' && /^-?[1-9]\d{0,18}$/.test(source.transformPathId)
        : source?.anchor === 'component-world-position';
      if (!type || !sceneTypes.has(marker.type) || marker.category !== 'item' || marker.name !== type.name
          || typeof marker.id !== 'string' || !marker.id || marker.id.length > 180 || ids.has(marker.id)
          || !Array.isArray(marker.pos) || marker.pos.length !== 3 || !marker.pos.every(value => Number.isFinite(value) && Math.abs(value) < 100000)
          || !validScope || !['fixed', 'randomized-candidate'].includes(marker.placement)
          || source?.sourceKind !== 'serialized-scene-component' || typeof source.component !== 'string' || !source.component
          || source.component.length > 100 || typeof source.componentPathId !== 'string' || !/^-?\d{1,20}$/.test(source.componentPathId)
          || !validAnchor || source.sceneSha256 !== target.sourceSceneSha256) fail(`marker ${marker?.id}`);
      ids.add(marker.id);
      return { ...marker, pos: [...marker.pos], source: { ...source } };
    });
    if (ids.size > 50000) fail('merged marker limit');
    additions.set(map.mapPackId, markers);
  }
  if (removeTypes.length && additions.size !== expected.size) fail('replacement requires every map');
  return { ...geometry, types: [...types.values()], source: { ...geometry.source,
    componentCoverage: sceneLoot.source.description || sceneLoot.source.itemCoverage
      || 'Additional fixed or candidate item placements from matching serialized scene components.' },
  maps: geometry.maps.map(map => ({ ...map, markers: [
    ...map.markers.filter(marker => !removeTypes.includes(marker.type)), ...(additions.get(map.mapPackId) || []),
  ] })) };
}

export async function exportGeometryLoot({ catalogPath, packsPath, outputPath, gameBuildId, sceneLoot, sceneLootPath, compact = false, split = false }) {
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
  let result = { schemaVersion: 1, gameBuildId: build,
    source: { kind: 'canonical-map-geometry-survey', anchor: 'geometry-bounds-center',
      positions: 'World AABB center of each named body mesh after its complete node hierarchy and GPU instance transform. Original model origins are retained per marker.',
      chestCoverage: 'All five identifiable luggage body meshes in every enabled canonical map. These meshes are also used by mirages and traps; scene placements are reference candidates, never a guarantee of a real chest or its contents.',
      itemCoverage: 'Authenticated named fixed resource or climbing landmark meshes: egg nests, shelf fungi, hammered pitons, climbing spikes, sleep-berry sites and four amulet reference sites. Amulet models are candidate sites, not guaranteed pickups. Nap Berry is also used by a fixed sleep-effect FakeItem. Spawned loose items and random item-spawner contents are absent from static map geometry.',
      animalCoverage: 'Individual fixed Capybara bodies identified by the exact Cube mesh and M_Capybara material in every canonical map. M_Capybara Mirage bodies are excluded. These are original map placements, not live animal state.',
      excluded: 'Unqualified generic mesh names, capybara mirages, chest lids and hardware, decorative props, unverified pickup locations, and data from another game build.' },
    types: lootGeometryTypes.map(({ meshName, materialName, placement, ...definition }) => definition), maps };
  if (!maps.length) throw new Error('No canonical maps selected');
  if (sceneLoot && sceneLootPath) throw new Error('Choose a scene loot object or path');
  if (sceneLootPath) sceneLoot = JSON.parse(await readFile(sceneLootPath, 'utf8'));
  if (sceneLoot) result = mergeSceneLoot(result, sceneLoot);
  await mkdir(dirname(outputPath), { recursive: true });
  if (split) {
    const directory = resolve(dirname(outputPath), 'loot', build);
    await mkdir(directory, { recursive: true });
    const index = { schemaVersion: 1, kind: 'map-loot-index', gameBuildId: build, source: result.source, maps: [] };
    for (const map of result.maps) {
      const used = new Set(map.markers.map(marker => marker.type));
      const chunk = { schemaVersion: 1, gameBuildId: build, source: result.source,
        types: result.types.filter(type => used.has(type.id)), maps: [map] };
      const bytes = Buffer.from(`${JSON.stringify(chunk)}\n`, 'utf8');
      const filename = `${map.mapPackId}.json`;
      await writeFile(resolve(directory, filename), bytes);
      index.maps.push({ mapPackId: map.mapPackId, sceneName: map.sceneName, mapSlot: map.mapSlot,
        sourceSceneSha256: map.sourceSceneSha256, path: `loot/${build}/${filename}`,
        sha256: sha256(bytes), size: bytes.length });
    }
    await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  } else {
    await writeFile(outputPath, `${JSON.stringify(result, null, compact ? undefined : 2)}\n`, 'utf8');
  }
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
    sceneLootPath: option('--scene-loot', null),
    compact: args.includes('--compact'),
    split: args.includes('--split'),
    packsPath: resolve(option('--packs', resolve(platformRoot, '../local/assets/maps/packs'))),
    outputPath: resolve(option('--output', resolve(platformRoot, `data/maps/loot.${gameBuildId}.json`))),
  });
}
