// Read-only audit of every currently registered original-mesh pack. No trace,
// credentials, game state, asset files or catalog identities are changed.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { isSourceProjectionProxy } from '../../web/src/source-render-policy.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const catalog = JSON.parse(await readFile(resolve(repository, 'PeakTrailPlatform/data/maps/catalog.json'), 'utf8'));
const rows = [];
for (const entry of catalog.mapPacks) {
  const directory = resolve(repository, 'local/assets/maps/packs', entry.mapPackId);
  const pack = JSON.parse(await readFile(resolve(directory, 'map-pack.json'), 'utf8'));
  for (const layer of pack.layers) {
    const published = await readFile(resolve(directory, layer.geometry));
    if (createHash('sha256').update(published).digest('hex') !== layer.geometrySha256)
      throw new Error(`Geometry digest mismatch: ${entry.sceneName}/${layer.id}`);
    const bytes = layer.geometryFormat.endsWith('+gzip') ? gunzipSync(published) : published;
    if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error('Expected original-mesh GLB');
    const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
    const counts = new Map(); let crystals = 0;
    for (const node of gltf.nodes) {
      if (node.mesh === undefined) continue;
      const instanceAttribute = Object.values(node.extensions?.EXT_mesh_gpu_instancing?.attributes || {})[0];
      const instances = instanceAttribute === undefined ? 1 : gltf.accessors[instanceAttribute].count;
      for (const primitive of gltf.meshes[node.mesh].primitives) {
        const material = gltf.materials[primitive.material];
        const terrain = material?.extras?.peakTerrain;
        if (isSourceProjectionProxy(pack.gameBuildId, terrain?.sourceMaterial || material?.name, terrain?.sourceColors?.shader))
          counts.set(material.name, (counts.get(material.name) || 0) + instances);
        if (gltf.meshes[node.mesh].name === 'Wall Petrified Stone' && material.name === 'M_Petrified_Stone_Evil') crystals += instances;
      }
    }
    if (counts.size) rows.push({ scene: entry.sceneName, layer: layer.id, omitted: Object.fromEntries(counts), retainedCrystals: crystals });
  }
}
console.log(JSON.stringify({ checkedPacks: catalog.mapPacks.length, affectedLayers: rows.length, rows }, null, 2));
