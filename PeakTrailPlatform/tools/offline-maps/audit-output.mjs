import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyMapPackIdentity } from '../lib/map-pack-identity.mjs';

const root = resolve(process.argv[2] || fileURLToPath(new URL('../../../local/assets/maps/working/legacy/25306743/',import.meta.url)));
const expected = Number(process.argv[3] || 21);
const folders = (await readdir(root)).filter((name) => /^Level_\d+$/.test(name));
if (folders.length !== expected) throw new Error(`Expected ${expected} scene folders, found ${folders.length}`);
const sceneHashes = new Set(), mapIds = new Set(), surfaceHashes = new Set();
let bytes = 0, layers = 0, finiteSamples = 0;
const builds = new Set(), versions = new Set();
for (const folder of folders) {
  const directory = join(root, folder);
  const manifestBytes = await readFile(join(directory, 'map-pack.json'));
  const manifest = JSON.parse(manifestBytes);
  verifyMapPackIdentity(manifest);
  if (manifest.sceneName !== folder) throw new Error(`Scene folder mismatch: ${folder}`);
  if (manifest.layers.length !== 6) throw new Error(`Expected six source layers: ${folder}`);
  builds.add(manifest.gameBuildId); versions.add(manifest.gameVersion);
  sceneHashes.add(manifest.source.sceneSha256); mapIds.add(manifest.mapPackId);
  surfaceHashes.add(manifest.layers.filter((layer) => layer.biome !== 'Void').map((layer) => layer.heightSha256).join('/'));
  bytes += manifestBytes.length;
  for (const layer of manifest.layers) {
    const texture = await readFile(join(directory, layer.texture));
    const height = await readFile(join(directory, layer.height));
    for (const [kind, buffer] of [['texture', texture], ['height', height]]) {
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (hash !== layer[`${kind}Sha256`]) throw new Error(`${folder}/${layer.id}: ${kind} digest mismatch`);
    }
    if (!texture.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid PNG signature');
    if (height.length !== layer.rows * layer.columns * 4) throw new Error('Invalid height dimensions');
    let valid = 0;
    for (let index = 0; index < height.length; index += 4) {
      const value = height.readFloatLE(index);
      if (Number.isFinite(value)) {
        valid++;
        if (value < layer.minY - 0.01 || value > layer.maxY + 0.01) throw new Error('Height lies outside declared bounds');
      } else if (!Number.isNaN(value)) throw new Error('Infinity is not a supported no-data value');
    }
    if (valid !== layer.validHeightSamples || valid === 0) throw new Error('Invalid finite sample count');
    bytes += texture.length + height.length; layers++; finiteSamples += valid;
  }
}
if (sceneHashes.size !== expected || mapIds.size !== expected || surfaceHashes.size !== expected) throw new Error('Duplicate scene/map/terrain fingerprints');
console.log(JSON.stringify({maps:folders.length,layers,builds:[...builds],versions:[...versions],distinctSceneHashes:sceneHashes.size,distinctMountainHeightFields:surfaceHashes.size,finiteSamples,totalBytes:bytes,totalMiB:Number((bytes/1024/1024).toFixed(2))},null,2));
