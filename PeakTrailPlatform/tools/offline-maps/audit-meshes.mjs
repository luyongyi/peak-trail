// Independent readback of final compressed GLB geometry, material flags and hashes.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MeshoptDecoder } from './gltf-deps/node_modules/meshoptimizer/index.js';
await MeshoptDecoder.ready;
const args=process.argv.slice(2), reportIndex=args.indexOf('--report');
const reportPath=reportIndex<0?null:args[reportIndex+1];
if(reportIndex>=0)args.splice(reportIndex,2);
const root = args[0] || fileURLToPath(new URL('../../../local/assets/maps/working/mesh-v3/25306743/',import.meta.url));
let totalBytes = 0, totalUncompressedBytes=0, totalTriangles = 0, embeddedImageBytes=0, scenes=0;
const uniqueImages=new Map();
const reports = [];
let folders;
try {
  await fs.access(path.join(root,'map-pack.json'));
  folders=[{directory:path.basename(root),folder:root}];
} catch(error) {
  if(error.code!=='ENOENT')throw error;
  folders=(await fs.readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>({directory:entry.name,folder:path.join(root,entry.name)}));
}
for (const {directory,folder} of folders.sort((a,b)=>a.directory.localeCompare(b.directory,undefined,{numeric:true}))) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(folder, 'map-pack.json'), 'utf8')); }
  catch(error) { if(error.code==='ENOENT')continue;throw error; }
  if(!manifest.layers.some(layer=>layer.geometry))continue;
  if(args[1] && `${manifest.mapSlot}`!==args[1] && manifest.sceneName!==`Level_${args[1]}`)continue;
  scenes++;
  for (const layer of manifest.layers) {
    if(!['glb-instanced-v1','glb-instanced-v1+gzip'].includes(layer.geometryFormat))throw new Error(`Unsupported native geometry format ${directory}/${layer.id}`);
    const stored = await fs.readFile(path.join(folder, layer.geometry));
    const sha = crypto.createHash('sha256').update(stored).digest('hex');
    if (sha !== layer.geometrySha256) throw new Error(`SHA mismatch ${directory}/${layer.geometry}`);
    // Authenticate the bytes on disk/wire before decompression; bound expansion.
    const bytes=layer.geometryFormat.endsWith('+gzip')?gunzipSync(stored,{maxOutputLength:128*1024*1024}):stored;
    if(bytes.length>128*1024*1024)throw new Error(`GLB exceeds 128 MiB limit ${directory}/${layer.id}`);
    if(bytes.toString('ascii',0,4)!=='glTF' || bytes.readUInt32LE(4)!==2 || bytes.readUInt32LE(8)!==bytes.length)throw new Error(`Invalid GLB header ${directory}/${layer.id}`);
    const jsonLength = bytes.readUInt32LE(12);
    const doc = JSON.parse(bytes.subarray(20, 20+jsonLength));
    const bin = bytes.subarray(28+jsonLength);
    const views = new Map();
    const view = (id) => {
      if (views.has(id)) return views.get(id);
      const v = doc.bufferViews[id], ext = v.extensions?.EXT_meshopt_compression;
      let data;
      if (ext) {
        data = new Uint8Array(ext.count*ext.byteStride);
        MeshoptDecoder.decodeGltfBuffer(data, ext.count, ext.byteStride, bin.subarray(ext.byteOffset, ext.byteOffset+ext.byteLength), ext.mode, ext.filter || 'NONE');
      } else data = bin.subarray(v.byteOffset || 0, (v.byteOffset || 0)+v.byteLength);
      views.set(id, data); return data;
    };
    const arrays = new Map();
    const array = id => {
      if (arrays.has(id)) return arrays.get(id);
      const a = doc.accessors[id], raw = view(a.bufferView), n = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
      const size = {5121:1,5123:2,5125:4,5126:4}[a.componentType], stride = doc.bufferViews[a.bufferView].byteStride || n*size;
      const output = new Float64Array(a.count*n), data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const method = {5121:'getUint8',5123:'getUint16',5125:'getUint32',5126:'getFloat32'}[a.componentType];
      for (let i=0;i<a.count;i++) for(let c=0;c<n;c++) {
        const value = data[method]((a.byteOffset || 0)+i*stride+c*size, true);
        if (!Number.isFinite(value)) throw new Error(`Nonfinite accessor ${directory}/${layer.id}/${id}`);
        output[i*n+c] = value;
      }
      arrays.set(id, output); return output;
    };
    let triangles=0, positive=0, negative=0, positiveArea=0, negativeArea=0, mirrored=0;
    const checked=new Set();
    for (const mesh of doc.meshes) for (const primitive of mesh.primitives) {
      const key = [primitive.attributes.POSITION,primitive.attributes.NORMAL,primitive.indices].join('/');
      if(checked.has(key)) continue; checked.add(key);
      const p = array(primitive.attributes.POSITION), n = array(primitive.attributes.NORMAL), ix = array(primitive.indices);
      for(let i=0;i<ix.length;i+=3) {
        const a=ix[i]*3,b=ix[i+1]*3,c=ix[i+2]*3;
        if(Math.max(a,b,c)+2>=p.length) throw new Error(`Index out of bounds ${directory}/${layer.id}`);
        const ux=p[b]-p[a],uy=p[b+1]-p[a+1],uz=p[b+2]-p[a+2];
        const vx=p[c]-p[a],vy=p[c+1]-p[a+1],vz=p[c+2]-p[a+2];
        const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
        const dot=nx*(n[a]+n[b]+n[c])+ny*(n[a+1]+n[b+1]+n[c+1])+nz*(n[a+2]+n[b+2]+n[c+2]);
        const area=Math.hypot(nx,ny,nz);
        triangles++;
        if(dot>1e-10) {positive++;positiveArea+=area;}
        if(dot<-1e-10) {negative++;negativeArea+=area;}
      }
    }
    for (const node of doc.nodes) {
      if(node.matrix) {
        const m=node.matrix;
        const det=m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5]);
        if(det<0) mirrored++;
      } else if(node.extensions?.EXT_mesh_gpu_instancing) {
        const s=array(node.extensions.EXT_mesh_gpu_instancing.attributes.SCALE);
        for(let i=0;i<s.length;i+=3) if(s[i]*s[i+1]*s[i+2]<0)mirrored++;
      } else if(node.scale?.reduce((a,b)=>a*b,1)<0)mirrored++;
    }
    for(const image of doc.images) {
      const data=view(image.bufferView), hash=crypto.createHash('sha256').update(data).digest('hex');
      embeddedImageBytes+=data.byteLength; uniqueImages.set(hash,data.byteLength);
    }
    const report = {scene:manifest.sceneName,packDirectory:directory,layer:layer.id,geometryFormat:layer.geometryFormat,sha256:sha,bytes:stored.length,uncompressedBytes:bytes.length,triangles,normalFacingPositive:positive/(positive+negative),negativeAreaFraction:positiveArea+negativeArea>0?negativeArea/(positiveArea+negativeArea):0,mirroredInstances:mirrored,sourceColorMetadata:doc.materials.every(m=>m.extras?.peakTerrain?.sourceColors)};
    reports.push(report); totalBytes += stored.length; totalUncompressedBytes+=bytes.length; totalTriangles += triangles;
    console.log(JSON.stringify(report));
  }
}
if(!reports.length)throw new Error(`No native mesh packs found in ${root}`);
const summary={scenes,layers:reports.length,totalBytes,totalUncompressedBytes,totalTriangles,minNormalFacingPositive:Math.min(...reports.map(r=>r.normalFacingPositive)),maxNegativeAreaFraction:Math.max(...reports.map(r=>r.negativeAreaFraction)),mirroredInstances:reports.reduce((s,r)=>s+r.mirroredInstances,0),allSourceColorMetadata:reports.every(r=>r.sourceColorMetadata),embeddedImageBytes,uniqueImages:uniqueImages.size,uniqueImageBytes:[...uniqueImages.values()].reduce((a,b)=>a+b,0)};
console.log(JSON.stringify(summary));
if(reportPath)await fs.writeFile(reportPath,JSON.stringify({summary,layers:reports},null,2));
