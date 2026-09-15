import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { decodeGeometryBytes, GEOMETRY_FORMATS } from "../src/geometry-bytes.js";
import { positiveInstanceTransform } from "../src/geometry-matrices.js";
import { getSourceEffectMaterial } from "../src/source-materials.js";

// Use the bundled Three implementation, replacing only network and GLTF parse
// ports so the loader and batching contracts run without a WebGL canvas.
const source = (await readFile(new URL("../src/geometry-loader.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export async function loadGameGeometry", "async function loadGameGeometry");
const compile = (ports = {}) => new Function(
  "THREE", "GLTFLoader", "MeshoptDecoder", "decodeGeometryBytes", "GEOMETRY_FORMATS", "positiveInstanceTransform", "getSourceEffectMaterial", "fetch", "crypto",
  `${source}\nreturn { loadGameGeometry, batchStaticMeshes };`,
)(THREE, ports.GLTFLoader, {}, ports.decode || decodeGeometryBytes, GEOMETRY_FORMATS, positiveInstanceTransform, getSourceEffectMaterial, ports.fetch, ports.crypto || webcrypto);

function glb() {
  const text = JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] });
  const json = Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text) / 4) * 4, " "));
  const bytes = Buffer.alloc(20 + json.length);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  return bytes;
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("loader validates the gzip delivery SHA before decompression and passes unchanged GLB to parsing", async () => {
  const original = glb(); const compressed = gzipSync(original);
  const events = []; let parsed;
  class Parser {
    setMeshoptDecoder() { return this; }
    async parseAsync(bytes) {
      events.push("parse"); parsed = Buffer.from(bytes);
      return { scene: new THREE.Group(), parser: { associations: new Map(), json: { nodes: [] } } };
    }
  }
  const { loadGameGeometry } = compile({
    GLTFLoader: Parser,
    fetch: async () => ({ ok: true, arrayBuffer: async () => compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) }),
    crypto: { subtle: { digest: async (...args) => { events.push("hash"); return webcrypto.subtle.digest(...args); } } },
    decode: async (...args) => { events.push("decode"); return decodeGeometryBytes(...args); },
  });
  const layer = { geometryUrl: "model.glb.gz", geometryFormat: "glb-instanced-v1+gzip", geometrySha256: sha(compressed) };
  await loadGameGeometry(layer);
  assert.deepEqual(events, ["hash", "decode", "parse"]);
  assert.deepEqual(parsed, original);
  events.length = 0;
  await assert.rejects(loadGameGeometry({ ...layer, geometrySha256: sha(original) }), /哈希不匹配/);
  assert.deepEqual(events, ["hash"]);
});

test("batching separates mirrored instances and preserves complete sheared world transforms", () => {
  const { batchStaticMeshes } = compile();
  const sourceScene = new THREE.Group();
  const geometry = new THREE.BoxGeometry(); const material = new THREE.MeshStandardMaterial();
  const matrices = [
    new THREE.Matrix4().set(2, 0.75, 0.2, 17, 0, 3, 0.6, 2, 0, 0, 4, 41, 0, 0, 0, 1),
    new THREE.Matrix4().set(-2, 0.75, 0.2, -17, 0, 3, 0.6, 2, 0, 0, 4, 41, 0, 0, 0, 1),
  ];
  for (const matrix of matrices) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrix.copy(matrix); mesh.matrixAutoUpdate = false; sourceScene.add(mesh);
  }
  const batched = batchStaticMeshes(sourceScene); batched.updateMatrixWorld(true);
  assert.equal(batched.children.length, 2);
  assert.deepEqual(batched.children.map((mesh) => mesh.scale.x), [1, -1]);
  for (const [index, mesh] of batched.children.entries()) {
    const local = new THREE.Matrix4(); mesh.getMatrixAt(0, local);
    assert.ok(local.determinant() > 0);
    const world = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, local);
    world.elements.forEach((value, element) => assert.ok(Math.abs(value - matrices[index].elements[element]) < 1e-6));
  }
  geometry.dispose(); material.dispose(); batched.children.forEach((mesh) => mesh.dispose());
});

test("terrain blending consumes the corrected inverse-transpose instance normal", () => {
  const { batchStaticMeshes } = compile();
  const material = new THREE.MeshStandardMaterial();
  material.userData.peakTerrain = { baseColor: [0.2, 0.3, 0.4], topColor: [0.6, 0.7, 0.8], tightness: [0.2, 0.9], amount: 1, topAlpha: 1 };
  const geometry = new THREE.BoxGeometry(); const sourceScene = new THREE.Group();
  sourceScene.add(new THREE.Mesh(geometry, material)); const batch = batchStaticMeshes(sourceScene);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader, {});
  const corrected = shader.vertexShader.indexOf("transformedNormal = normalMatrix * transpose(inverse(mat3(instanceMatrix)))");
  const blendNormal = shader.vertexShader.indexOf("vPeakUp = max(");
  assert.ok(corrected >= 0 && blendNormal > corrected);
  assert.match(shader.fragmentShader, /smoothstep\(peakRamp.x, peakRamp.y, vPeakUp\)/);
  geometry.dispose(); material.dispose(); batch.children.forEach((mesh) => mesh.dispose());
});

function effectFixture(name, shader) {
  const material = new THREE.MeshStandardMaterial();
  material.name = name;
  material.userData.peakTerrain = {
    baseColor: [1, 1, 1], topColor: [1, 1, 1], sourceMaterial: name, sourceColors: { shader },
  };
  const geometry = new THREE.BoxGeometry(); const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry, material));
  return { scene, material, geometry };
}

test("exact-build lava, water and fog source colors bypass the white generic terrain blend", () => {
  const { batchStaticMeshes } = compile();
  const cases = [["M_Lava", "Lava"], ["M_Water_forest", "GD/Water-GD"], ["FogSurface", "GD/FogSurface"]];
  const keys = new Set();
  for (const [name, shaderName] of cases) {
    const { scene, material, geometry } = effectFixture(name, shaderName);
    const expected = getSourceEffectMaterial("25306743", name, shaderName);
    const root = batchStaticMeshes(scene, "25306743");
    assert.deepEqual(material.color.toArray(), expected.baseColor);
    assert.deepEqual(material.emissive.toArray(), expected.emissive);
    assert.equal(material.opacity, expected.opacity);
    assert.equal(material.transparent, true);
    assert.equal(material.depthWrite, false);
    assert.equal(material.userData.peakSourceEffect.kind, expected.kind);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    material.onBeforeCompile(shader, {});
    assert.match(shader.vertexShader, /transpose\(inverse\(mat3\(instanceMatrix\)\)\)/);
    assert.doesNotMatch(shader.fragmentShader, /vPeakUp|peakBase/);
    assert.notEqual(material.customProgramCacheKey(), "peak-terrain-affine-normals-v1");
    keys.add(material.customProgramCacheKey());
    geometry.dispose(); material.dispose(); root.children.forEach((mesh) => mesh.dispose());
  }
  assert.equal(keys.size, 3);
});

test("source effect adaptation never guesses across build, name or shader mismatches", () => {
  const { batchStaticMeshes } = compile();
  for (const [build, name, shaderName] of [["other", "M_Lava", "Lava"], ["25306743", "M_LavaVine (Instance)", "Lava"], ["25306743", "M_Lava", "W/Vine"]]) {
    const { scene, material, geometry } = effectFixture(name, shaderName);
    const root = batchStaticMeshes(scene, build);
    assert.equal(material.userData.peakSourceEffect, undefined);
    assert.equal(material.customProgramCacheKey(), "peak-terrain-affine-normals-v1");
    geometry.dispose(); material.dispose(); root.children.forEach((mesh) => mesh.dispose());
  }
});

test("loadGameGeometry carries the explicit map build into material adaptation", async () => {
  const bytes = glb(); const fixture = effectFixture("M_Lava", "Lava");
  class Parser {
    setMeshoptDecoder() { return this; }
    async parseAsync() { return { scene: fixture.scene, parser: { associations: new Map(), json: { nodes: [] } } }; }
  }
  const { loadGameGeometry } = compile({
    GLTFLoader: Parser,
    fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
  });
  const root = await loadGameGeometry({ geometryUrl: "model.glb", geometryFormat: "glb-instanced-v1", geometrySha256: sha(bytes) }, undefined, "25306743");
  assert.equal(fixture.material.userData.peakSourceEffect.kind, "lava");
  assert.ok(fixture.material.emissive.r > 1);
  fixture.geometry.dispose(); fixture.material.dispose(); root.children.forEach((mesh) => mesh.dispose());
});
