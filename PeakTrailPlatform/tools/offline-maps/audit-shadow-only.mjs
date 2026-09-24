// Read-only audit of the original, immutable packs. This deliberately checks
// source-name candidates independently of the production digest/node allowlist.
// The candidate predicate below is NOT a safe general-purpose rendering policy.
// Run: node PeakTrailPlatform/tools/offline-maps/audit-shadow-only.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { shadowOnlyNodeIndices } from "../../web/src/source-render-policy.js";

const platformRoot = fileURLToPath(new URL("../../", import.meta.url));
const packsRoot = fileURLToPath(new URL("../../../local/assets/maps/packs/", import.meta.url));
const BUILD = "25306743";
const ALPINE_SLOTS = [2, 4, 5, 7, 8, 11, 12, 14, 17, 19, 20];
const MAX_GLB_BYTES = 128 * 1024 * 1024;
const catalog = JSON.parse(await fs.readFile(path.join(platformRoot, "data/maps/catalog.json"), "utf8"));
assert.equal(catalog.activeGameBuildId, BUILD, "This evidence audit is for one reviewed game build only");
const entries = catalog.mapPacks.filter(pack => String(pack.gameBuildId) === BUILD && pack.enabled);
assert.deepEqual(entries.map(pack => pack.mapSlot).sort((a, b) => a - b), Array.from({ length: 21 }, (_, i) => i));

function safeChild(root, relative) {
  const target = path.resolve(root, relative);
  assert.ok(target.startsWith(path.resolve(root) + path.sep), `Path escaped pack root: ${relative}`);
  return target;
}

function readGlb(stored, layer) {
  const bytes = layer.geometryFormat === "glb-instanced-v1+gzip"
    ? gunzipSync(stored, { maxOutputLength: MAX_GLB_BYTES }) : stored;
  assert.ok(["glb-instanced-v1", "glb-instanced-v1+gzip"].includes(layer.geometryFormat));
  assert.ok(bytes.length >= 20 && bytes.length <= MAX_GLB_BYTES);
  assert.equal(bytes.toString("ascii", 0, 4), "glTF");
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const end = 20 + bytes.readUInt32LE(12);
  assert.ok(end <= bytes.length);
  const document = JSON.parse(bytes.subarray(20, end));
  for (const resource of [...(document.buffers || []), ...(document.images || [])]) {
    assert.ok(!resource.uri || resource.uri.startsWith("data:"), "Audit must not fetch external GLB resources");
  }
  return { bytes, document };
}

function candidateNodeIndices(document) {
  const result = [];
  for (const [index, node] of document.nodes.entries()) {
    const mesh = document.meshes[node.mesh];
    if (mesh?.name !== "Quad" || mesh.primitives.length !== 1) continue;
    const primitive = mesh.primitives[0];
    const source = document.materials[primitive.material]?.extras?.peakTerrain;
    if (source?.sourceMaterial !== "Lit" || source.sourceColors?.shader !== "Universal Render Pipeline/Lit") continue;
    assert.equal(document.accessors[primitive.attributes.POSITION].count, 4);
    assert.equal(document.accessors[primitive.indices].count, 6);
    result.push(index);
  }
  return result;
}

function countNodeInstances(document, nodeIndex) {
  const node = document.nodes[nodeIndex];
  assert.ok(node, `Missing node ${nodeIndex}`);
  const attributes = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
  if (!attributes) {
    assert.equal(node.matrix?.length, 16, "Reviewed non-instanced shadow plane must retain its affine matrix");
    assert.equal(node.extras?.peaktrailFullAffine, true);
    return { affine: 1, gpu: 0 };
  }
  assert.deepEqual(Object.keys(attributes).sort(), ["ROTATION", "SCALE", "TRANSLATION"]);
  const counts = Object.values(attributes).map(index => document.accessors[index].count);
  assert.ok(counts.every(count => count === 3), "Reviewed GPU shadow-plane group contains three instances");
  return { affine: 0, gpu: counts[0] };
}

// Load the same vendored GLTFLoader as the web app, without modifying its files
// or launching a browser. Only module specifiers are rewritten for Node.
// Texture decoding is intentionally skipped: this audit verifies node/mesh
// associations and EXT_mesh_gpu_instancing, not image pixels or rendering.
async function geometryLoader() {
  const vendor = path.join(platformRoot, "vendor/three/0.180.0");
  const threeUrl = pathToFileURL(path.join(vendor, "build/three.module.js")).href;
  const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const utils = await fs.readFile(path.join(vendor, "examples/jsm/utils/BufferGeometryUtils.js"), "utf8");
  const utilsUrl = moduleUrl(utils.replaceAll("'three'", JSON.stringify(threeUrl)));
  const source = await fs.readFile(path.join(vendor, "examples/jsm/loaders/GLTFLoader.js"), "utf8");
  const loaderUrl = moduleUrl(source.replaceAll("'three'", JSON.stringify(threeUrl))
    .replace("'../utils/BufferGeometryUtils.js'", JSON.stringify(utilsUrl)));
  const [{ GLTFLoader }, { Texture }, { MeshoptDecoder }] = await Promise.all([
    import(loaderUrl), import(threeUrl),
    import(pathToFileURL(path.join(vendor, "examples/jsm/libs/meshopt_decoder.module.js")).href),
  ]);
  await MeshoptDecoder.ready;
  const geometryUrl = pathToFileURL(path.join(platformRoot, "web/src/geometry-loader.js"));
  const geometrySource = await fs.readFile(geometryUrl, "utf8");
  const auditedSource = geometrySource.replace(/from "([^"]+)"/g, (original, specifier) => {
    const resolved = specifier === "three" ? threeUrl
      : specifier === "three/addons/loaders/GLTFLoader.js" ? loaderUrl
      : specifier.startsWith("three/addons/") ? pathToFileURL(path.join(vendor, "examples/jsm", specifier.slice("three/addons/".length))).href
      : specifier.startsWith("./") ? new URL(specifier, geometryUrl).href : null;
    assert.ok(resolved, `Unreviewed geometry-loader dependency: ${specifier}`);
    return `from ${JSON.stringify(resolved)}`;
  });
  // Export private helpers in memory solely for this audit; production files
  // and module behavior are otherwise unchanged.
  const { batchStaticMeshes, preserveAffineMatrices } = await import(moduleUrl(
    auditedSource + "\nexport { batchStaticMeshes, preserveAffineMatrices };\n"));
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).register(() => ({
    name: "PEAK_audit_skip_texture_pixels",
    loadTexture() { return Promise.resolve(new Texture()); },
  }));
  return { loader, batchStaticMeshes, preserveAffineMatrices };
}

async function verifyLoadedAssociations(runtime, bytes, expectedNodes, sceneName) {
  const gltf = await runtime.loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  const found = new Map();
  let omittedInstances = 0, beforeInstances = 0;
  gltf.scene.traverse(object => {
    if (!object.isMesh || object.isSkinnedMesh) return;
    beforeInstances += object.isInstancedMesh ? object.count : 1;
    // GLTFLoader can attach the source node association to a parent Group
    // when a source mesh has multiple primitives. Walk ancestors just as the
    // rendering policy must do; never identify a mesh by display name alone.
    let owner = object;
    while (owner && !expectedNodes.has(gltf.parser.associations.get(owner)?.nodes)) owner = owner.parent;
    if (!owner) return;
    const nodeIndex = gltf.parser.associations.get(owner).nodes;
    const instances = object.isInstancedMesh ? object.count : 1;
    found.set(nodeIndex, (found.get(nodeIndex) || 0) + instances);
    omittedInstances += instances;
  });
  assert.deepEqual([...found.keys()].sort((a, b) => a - b), [...expectedNodes].sort((a, b) => a - b), `${sceneName}: loader lost an association`);
  assert.deepEqual([...found.values()].sort((a, b) => a - b), [1, 3], `${sceneName}: unexpected mesh instance counts`);
  assert.equal(omittedInstances, 4);
  runtime.preserveAffineMatrices(gltf);
  const root = runtime.batchStaticMeshes(gltf.scene, BUILD, expectedNodes, gltf.parser.associations);
  assert.equal(root.userData.omittedShadowOnlyInstances, 4, `${sceneName}: actual production batching did not omit the four planes`);
  assert.equal(root.userData.omittedProjectionInstances, 0, `${sceneName}: unexpected non-shadow omissions`);
  let afterInstances = 0;
  root.traverse(object => { if (object.isMesh) afterInstances += object.isInstancedMesh ? object.count : 1; });
  assert.equal(afterInstances, beforeInstances - 4, `${sceneName}: unrelated instances were lost`);
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const resource of [...geometries, ...materials, ...textures]) resource.dispose();
  return { scene: sceneName, sourceNodeIndices: [...found.keys()], instanceCounts: [...found.values()], beforeInstances, afterInstances,
    productionBatchVerified: true, texturePixelsVerified: false };
}

const loader = await geometryLoader();
const loaderChecks = [], alpine = [];
let layers = 0, storedBytes = 0, omittedInstances = 0, unaffectedLayers = 0;
for (const entry of entries) {
  const root = safeChild(packsRoot, entry.mapPackId);
  const pack = JSON.parse(await fs.readFile(path.join(root, "map-pack.json"), "utf8"));
  assert.equal(String(pack.gameBuildId), BUILD);
  assert.equal(pack.mapSlot, entry.mapSlot);
  for (const layer of pack.layers) {
    const stored = await fs.readFile(safeChild(root, layer.geometry));
    const digest = createHash("sha256").update(stored).digest("hex");
    assert.equal(digest, layer.geometrySha256, `${pack.sceneName}/${layer.id}: geometry hash mismatch`);
    const { bytes, document } = readGlb(stored, layer);
    const selected = shadowOnlyNodeIndices(BUILD, digest);
    assert.ok(selected instanceof Set, "Policy must return a Set");
    const candidates = candidateNodeIndices(document);
    assert.deepEqual([...selected].sort((a, b) => a - b), candidates, `${pack.sceneName}/${layer.id}: evidence/policy mismatch`);
    assert.equal(shadowOnlyNodeIndices("different-build", digest).size, 0);
    assert.equal(shadowOnlyNodeIndices(BUILD, "0".repeat(64)).size, 0);
    assert.equal(shadowOnlyNodeIndices(BUILD, undefined).size, 0);
    layers++; storedBytes += stored.length;
    if (layer.biome === "Alpine") {
      assert.equal(layer.segment, 2);
      assert.ok(ALPINE_SLOTS.includes(entry.mapSlot), `Unreviewed Alpine slot ${entry.mapSlot}`);
      assert.equal(selected.size, 2);
      const counts = [...selected].map(index => countNodeInstances(document, index));
      const affine = counts.reduce((sum, count) => sum + count.affine, 0);
      const gpu = counts.reduce((sum, count) => sum + count.gpu, 0);
      assert.deepEqual({ affine, gpu }, { affine: 1, gpu: 3 });
      omittedInstances += affine + gpu;
      const result = { slot: entry.mapSlot, scene: pack.sceneName, sha256: digest, nodeIndices: [...selected], affineInstances: affine, gpuInstances: gpu };
      alpine.push(result);
      console.log(JSON.stringify(result));
      if ([2, 4].includes(entry.mapSlot)) loaderChecks.push(await verifyLoadedAssociations(loader, bytes, selected, pack.sceneName));
    } else {
      assert.equal(selected.size, 0, `${pack.sceneName}/${layer.id}: unrelated layer selected`);
      unaffectedLayers++;
    }
  }
}
assert.deepEqual(alpine.map(result => result.slot).sort((a, b) => a - b), ALPINE_SLOTS);
assert.equal(layers, 126);
assert.equal(unaffectedLayers, 115);
assert.equal(omittedInstances, 44);
assert.equal(loaderChecks.length, 2);
console.log(JSON.stringify({ scenes: entries.length, layers, hashVerifiedBytes: storedBytes, alpineLayers: alpine.length,
  unaffectedLayers, omittedInstances, loaderChecks, readOnly: true }));
