import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { decodeGeometryBytes, GEOMETRY_FORMATS } from "../src/geometry-bytes.js";
import { positiveInstanceTransform } from "../src/geometry-matrices.js";
import { getSourceEffectMaterial } from "../src/source-materials.js";
import { isExplosiveMineMaterial, recordedHiddenMineIndices } from "../src/mine-visibility.js";
import { sha256Hex } from "../src/sha256.js";
import { isProjectionProxyMaterial, shadowOnlyNodeIndices } from "../src/source-render-policy.js";

// Use the bundled Three implementation, replacing only network and GLTF parse
// ports so the loader and batching contracts run without a WebGL canvas.
const source = (await readFile(new URL("../src/geometry-loader.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export (?=(?:async )?function )/gm, "");
const compile = (ports = {}) => new Function(
  "THREE", "GLTFLoader", "MeshoptDecoder", "decodeGeometryBytes", "GEOMETRY_FORMATS", "positiveInstanceTransform", "getSourceEffectMaterial", "isExplosiveMineMaterial", "recordedHiddenMineIndices", "sha256Hex", "fetch", "crypto", "isProjectionProxyMaterial", "shadowOnlyNodeIndices",
  `${source}\nreturn { loadGameGeometry, batchStaticMeshes, updateRecordedMineVisibility, updateMapFogSurfaceVisibility, verifiableTopBlend };`,
)(THREE, ports.GLTFLoader, {}, ports.decode || decodeGeometryBytes, GEOMETRY_FORMATS, positiveInstanceTransform, getSourceEffectMaterial, isExplosiveMineMaterial, recordedHiddenMineIndices, sha256Hex, ports.fetch, ports.crypto || webcrypto, isProjectionProxyMaterial, ports.shadowOnlyNodeIndices || shadowOnlyNodeIndices);

test("audited shadow-only affine/GPU panels are omitted, same-name solid props remain", () => {
  const { batchStaticMeshes } = compile();
  const geometry = new THREE.PlaneGeometry();
  const material = new THREE.MeshStandardMaterial(); material.name = "Lit";
  const scene = new THREE.Group(); const associations = new Map();
  // A parent group also covers GLTFLoader's multi-primitive representation.
  const floor = new THREE.Group(); floor.add(new THREE.Mesh(geometry, material));
  associations.set(floor, { nodes: 83 }); scene.add(floor);
  const walls = new THREE.InstancedMesh(geometry, material, 3);
  for (let i = 0; i < 3; i++) walls.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 100, 0, 0));
  associations.set(walls, { nodes: 1609 }); scene.add(walls);
  const prop = new THREE.Mesh(geometry, material); prop.name = "Quad";
  associations.set(prop, { nodes: 84 }); scene.add(prop);
  const unknown = new THREE.Mesh(geometry, material); scene.add(unknown);
  const digest = "db142d322fc18bc65e85fff216e237d9ea32691fa31be651ba4233c40c0ae78c";
  const root = batchStaticMeshes(scene, "25306743", shadowOnlyNodeIndices(25306743, digest), associations);
  assert.equal(root.userData.omittedShadowOnlyInstances, 4);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].count, 2, "ordinary and unknown-identity surfaces survive even with shared geometry/material");
  geometry.dispose(); material.dispose(); walls.dispose(); root.children[0].dispose();
});

test("depth-projection balls are omitted while their real crystal and spherical props survive", () => {
  const { batchStaticMeshes } = compile();
  const material = new THREE.MeshStandardMaterial();
  material.name = "M_VFX_PetrifyDecal";
  material.userData.peakTerrain = { sourceMaterial: material.name, sourceColors: { shader: "Decal" } };
  const geometry = new THREE.SphereGeometry();
  const scene = new THREE.Group();
  const proxies = new THREE.InstancedMesh(geometry, material, 100);
  for (let i = 0; i < 100; i++) proxies.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i, 2, 0));
  scene.add(proxies);
  const realMaterial = new THREE.MeshStandardMaterial(); realMaterial.name = "M_Petrified_Stone_Evil";
  scene.add(new THREE.Mesh(geometry, realMaterial));
  const batched = batchStaticMeshes(scene, "25306743");
  assert.equal(batched.userData.omittedProjectionInstances, 100);
  assert.equal(batched.children.length, 1);
  assert.equal(batched.children[0].material, realMaterial);
  geometry.dispose(); material.dispose(); realMaterial.dispose(); proxies.dispose();
  batched.children.forEach((mesh) => mesh.dispose());
});

test("mixed meshes retain ordinary groups but never raycast against decal volume groups", () => {
  const { batchStaticMeshes } = compile();
  const proxy = new THREE.MeshStandardMaterial();
  proxy.name = "M_VFX_FireballDecal";
  proxy.userData.peakTerrain = { sourceColors: { shader: "Decal" } };
  const solid = new THREE.MeshStandardMaterial();
  const geometry = new THREE.BoxGeometry(); geometry.clearGroups();
  geometry.addGroup(0, 18, 0); geometry.addGroup(18, 18, 1);
  const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry, [proxy, solid]));
  const batched = batchStaticMeshes(scene, 25306743);
  assert.deepEqual(batched.children[0].geometry.groups, [{ start: 18, count: 18, materialIndex: 1 }]);
  assert.equal(geometry.groups.length, 2, "shared source geometry is untouched");
  geometry.dispose(); proxy.dispose(); solid.dispose();
  batched.children.forEach((mesh) => { mesh.geometry.dispose(); mesh.dispose(); });
});

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
    shadowOnlyNodeIndices: (build, digest) => {
      events.push("policy");
      assert.equal(build, "25306743");
      assert.equal(digest, sha(compressed), "policy receives the computed delivery digest");
      return new Set();
    },
  });
  const layer = { geometryUrl: "model.glb.gz", geometryFormat: "glb-instanced-v1+gzip", geometrySha256: sha(compressed) };
  await loadGameGeometry(layer, undefined, "25306743");
  assert.deepEqual(events, ["hash", "decode", "parse", "policy"]);
  assert.deepEqual(parsed, original);
  events.length = 0;
  await assert.rejects(loadGameGeometry({ ...layer, geometrySha256: sha(original) }, undefined, "25306743"), /哈希不匹配/);
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

test("shared foliage top colours never paint props teal, authored terrain tops keep their blend", () => {
  const { verifiableTopBlend, batchStaticMeshes } = compile();
  // Every GD/FoliageGD and W/Peak_Mirage material stores the same default _TopColor;
  // the build's survey capture keeps those props on their base colour (a tall cactus
  // crown stays pink), so the world-up blend is disabled for them only.
  assert.equal(verifiableTopBlend("GD/FoliageGD", 1), 0);
  assert.equal(verifiableTopBlend("W/Peak_Mirage", 0.8), 0);
  // A cyan top colour on desert stone contradicts the same capture that shows
  // sand-coloured tops on W/Peak_Rock.
  assert.equal(verifiableTopBlend("W/Peak_Petrified_Rock", 0.74), 0);
  assert.equal(verifiableTopBlend("W/Peak_Rock", 1), 1);
  assert.equal(verifiableTopBlend("W/Peak_Rock", 0.3), 0.3);
  assert.equal(verifiableTopBlend("W/Peak_Standard", undefined), 1);

  const material = new THREE.MeshStandardMaterial();
  material.userData.peakTerrain = { baseColor: [0.82, 0.62, 0.62], topColor: [0.11, 0.19, 0.19],
    tightness: [0.707, 0.765], amount: 1, topAlpha: 1, sourceMaterial: "M_Foliage_Cactus_tri",
    sourceColors: { shader: "GD/FoliageGD" } };
  const geometry = new THREE.BoxGeometry(); const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, material));
  const batch = batchStaticMeshes(scene);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader, {});
  assert.equal(shader.uniforms.peakAmount.value, 0, "the cactus crown keeps its own colour");
  assert.deepEqual(shader.uniforms.peakBase.value.toArray(), [0.82, 0.62, 0.62]);
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

test("recorded mine hiding is reversible with reflected matrices and shifted display origin", () => {
  const { batchStaticMeshes, updateRecordedMineVisibility } = compile();
  const fixture = effectFixture("M_SporeShroomExplo", "W/Peak_Standard");
  fixture.scene.children[0].position.set(-50, 20, 70);
  fixture.scene.children[0].scale.set(-2, 2, 2);
  const root = batchStaticMeshes(fixture.scene, "25306743");
  root.position.set(50, -20, -70);
  root.updateMatrixWorld(true);
  const mesh = root.children[0];
  const before = new THREE.Matrix4(); mesh.getMatrixAt(0, before);
  assert.deepEqual(mesh.userData.peakRecordedMines[0].center, [-50, 20, 70]);
  assert.equal(mesh.scale.x, -1);
  const events = [{ type: "mine_explosion", t: 10, pos: [-50, 20, 70] }];
  assert.equal(updateRecordedMineVisibility(root, [], events, 12), 1);
  const hidden = new THREE.Matrix4(); mesh.getMatrixAt(0, hidden);
  assert.equal(hidden.determinant(), 0);
  assert.equal(updateRecordedMineVisibility(root, [], events, 9), 0);
  const restored = new THREE.Matrix4(); mesh.getMatrixAt(0, restored);
  assert.deepEqual(restored.elements, before.elements);
  fixture.geometry.dispose(); fixture.material.dispose(); mesh.dispose();
});

test("mine bounds use referenced primitive indices, not unrelated static-batch vertices", () => {
  const { batchStaticMeshes } = compile();
  const fixture = effectFixture("M_SporeShroomExplo", "W/Peak_Standard");
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.5, 0, 0, 0.5, 0, 0, 0, 1, 0, 9999, 9999, 9999,
  ], 3));
  geometry.setIndex([0, 1, 2]);
  fixture.scene.children[0].geometry = geometry;
  const root = batchStaticMeshes(fixture.scene, "25306743");
  const mine = root.children[0].userData.peakRecordedMines[0];
  assert.deepEqual(mine.min, [-0.5, 0, 0]);
  assert.deepEqual(mine.max, [0.5, 1, 0]);
  fixture.geometry.dispose(); geometry.dispose(); fixture.material.dispose(); root.children[0].dispose();
});

test("map baseline fog replaces only matching chapter FogSurface batches and restores visibility", () => {
  const { batchStaticMeshes, updateMapFogSurfaceVisibility } = compile();
  const terrain = new THREE.Group();
  const fixtures = [];
  const add = (segment, name = "FogSurface", shader = "GD/FogSurface", build = "25306743") => {
    const fixture = effectFixture(name, shader); fixtures.push(fixture);
    const model = batchStaticMeshes(fixture.scene, build);
    const chapter = new THREE.Group(); chapter.userData.mapLayer = { segment }; chapter.add(model); terrain.add(chapter);
    return { mesh: model.children[0], chapter, model };
  };
  const swamp = add(3), temple = add(4), alreadyHidden = add(4);
  alreadyHidden.mesh.visible = false;
  temple.chapter.visible = false;
  const water = add(4, "M_Water_swamp", "GD/Water-GD"), voidFog = add(4, "FogSurface void");
  const otherBuild = add(4, "FogSurface", "GD/FogSurface", "other"), unknownChapter = add(undefined);
  const mixed = add(4); mixed.mesh.material = [mixed.mesh.material, water.mesh.material];
  const fog = (segment) => ({ kind: "sleep_fog", authority: "map-baseline", segment,
    surfaceMaterial: "FogSurface", surfaceShader: "GD/FogSurface", active: true });
  assert.equal(updateMapFogSurfaceVisibility(terrain, [fog(4)]), 2);
  assert.equal(swamp.mesh.visible, true);
  assert.equal(temple.mesh.visible, false);
  assert.equal(temple.chapter.visible, false, "the owning chapter's visibility must remain untouched");
  assert.equal(alreadyHidden.mesh.visible, false);
  for (const { mesh } of [water, voidFog, otherBuild, unknownChapter, mixed]) assert.equal(mesh.visible, true);
  assert.equal(updateMapFogSurfaceVisibility(terrain, [fog(3), fog(4)]), 3, "overview replaces each explicit chapter only");
  assert.equal(swamp.mesh.visible, false);
  updateMapFogSurfaceVisibility(terrain, [fog(3)]);
  assert.equal(temple.mesh.visible, true, "switching chapter restores the previous mesh, not its hidden group");
  assert.equal(temple.chapter.visible, false);
  assert.equal(alreadyHidden.mesh.visible, false, "an originally hidden mesh stays hidden after restoration");
  updateMapFogSurfaceVisibility(terrain, []);
  assert.equal(swamp.mesh.visible, true);
  assert.equal(swamp.mesh.userData.peakMapFogVisibility, undefined);
  for (const fixture of fixtures) { fixture.geometry.dispose(); fixture.material.dispose(); }
  terrain.traverse((mesh) => { if (mesh.isInstancedMesh) mesh.dispose(); });
});

test("recorded, inactive, ambiguous or wrong-source fog never hides static surfaces", () => {
  const { batchStaticMeshes, updateMapFogSurfaceVisibility } = compile();
  const fixture = effectFixture("FogSurface", "GD/FogSurface");
  const model = batchStaticMeshes(fixture.scene, "25306743");
  const chapter = new THREE.Group(); chapter.userData.segment = 3; chapter.add(model);
  const terrain = new THREE.Group(); terrain.add(chapter);
  const fog = { kind: "sleep_fog", authority: "map-baseline", segment: 3,
    surfaceMaterial: "FogSurface", surfaceShader: "GD/FogSurface" };
  for (const override of [{ authority: "recorded" }, { active: false }, { segment: null },
    { segment: "3" }, { kind: "safe_zone" }, { surfaceMaterial: "FogSurface void" }, { surfaceShader: "GD/Water-GD" }]) {
    assert.equal(updateMapFogSurfaceVisibility(terrain, [{ ...fog, ...override }]), 0);
    assert.equal(model.children[0].visible, true);
  }
  fixture.geometry.dispose(); fixture.material.dispose(); model.children[0].dispose();
});
