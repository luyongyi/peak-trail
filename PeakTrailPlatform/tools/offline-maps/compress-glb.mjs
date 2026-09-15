import { readFile, writeFile } from 'node:fs/promises';
import { MeshoptEncoder, MeshoptDecoder } from './gltf-deps/node_modules/meshoptimizer/index.js';

// Only lossless byte compression: no quantization, reordering, weld or decimate.
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
const input = process.argv[2], output = process.argv[3] || input;
const source = await readFile(input);
if (source.toString('ascii', 0, 4) !== 'glTF') throw new Error('Expected GLB');
const jsonLength = source.readUInt32LE(12);
const json = JSON.parse(source.toString('utf8', 20, 20 + jsonLength));
const binaryStart = 20 + jsonLength + 8;
const original = source.subarray(binaryStart);
const chunks = []; let offset = 0, compressedViews = 0;
const append = (buffer) => {
  const aligned = (4 - offset % 4) % 4;
  if (aligned) { chunks.push(Buffer.alloc(aligned)); offset += aligned; }
  const start = offset; chunks.push(buffer); offset += buffer.length; return start;
};
const accessorsByView = new Map(json.accessors.map((accessor) => [accessor.bufferView, accessor]));
for (const [index, view] of json.bufferViews.entries()) {
  const bytes = original.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  const accessor = accessorsByView.get(index);
  if (!accessor || accessor.sparse) {
    view.buffer = 0; view.byteOffset = append(bytes); continue;
  }
  const componentSize = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
  const stride = componentSize * components;
  const mode = view.target === 34963 ? 'INDICES' : 'ATTRIBUTES';
  if (mode === 'ATTRIBUTES' && stride % 4 !== 0) throw new Error('Unexpected non-aligned source attribute');
  if (bytes.length !== accessor.count * stride) throw new Error('View is not a tightly packed single accessor');
  const encoded = MeshoptEncoder.encodeGltfBuffer(bytes, accessor.count, stride, mode);
  const decoded = new Uint8Array(bytes.length);
  MeshoptDecoder.decodeGltfBuffer(decoded, accessor.count, stride, encoded, mode, 'NONE');
  if (!Buffer.from(decoded).equals(bytes)) throw new Error('Compression changed source bytes');
  view.buffer = 1;
  view.extensions = { EXT_meshopt_compression: { buffer: 0, byteOffset: append(encoded), byteLength: encoded.length, byteStride: stride, count: accessor.count, mode, filter: 'NONE' } };
  compressedViews++;
}
let binary = Buffer.concat(chunks);
binary = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
json.buffers = [{ byteLength: binary.length }, { byteLength: original.length, extensions: { EXT_meshopt_compression: { fallback: true } } }];
json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'EXT_meshopt_compression'])];
json.extensionsRequired = [...new Set([...(json.extensionsRequired || []), 'EXT_mesh_gpu_instancing', 'EXT_meshopt_compression'])];
let text = Buffer.from(JSON.stringify(json));
text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + text.length + binary.length, 8); header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
const binaryHeader = Buffer.alloc(8); binaryHeader.writeUInt32LE(binary.length); binaryHeader.writeUInt32LE(0x004e4942, 4);
const result = Buffer.concat([header, text, binaryHeader, binary]);
await writeFile(output, result);
console.log(JSON.stringify({ sourceBytes: source.length, compressedBytes: result.length, ratio: +(result.length/source.length).toFixed(3), compressedViews, losslessViewsVerified: compressedViews }));
