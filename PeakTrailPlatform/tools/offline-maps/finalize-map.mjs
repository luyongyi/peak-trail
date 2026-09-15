import { readFile, writeFile } from 'node:fs/promises';
import { computeMapPackId } from '../lib/map-pack-identity.mjs';
const path = process.argv[2];
if (!path) throw new Error('Expected map-pack.json path');
const manifest = JSON.parse(await readFile(path, 'utf8'));
manifest.mapPackId = computeMapPackId(manifest);
await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest.mapPackId);
