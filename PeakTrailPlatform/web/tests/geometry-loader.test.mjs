import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { decodeGeometryBytes, GEOMETRY_FORMATS, readGeometryResponse, checkGeometryAbort, reportGeometryProgress, yieldGeometryTask } from "../src/geometry-bytes.js";
import { positiveInstanceTransform } from "../src/geometry-matrices.js";
import { getSourceEffectMaterial, supportsSourceEffect } from "../src/source-materials.js";
import { isExplosiveMineMaterial, recordedHiddenMineIndices } from "../src/mine-visibility.js";
import { sectionMaterial } from "../src/section-material.js";
import { isInteriorLayer } from "../src/camera-placement.js";
import { sha256Hex } from "../src/sha256.js";
import { isProjectionProxyMaterial, shadowOnlyNodeIndices } from "../src/source-render-policy.js";
import { applyTerrainMaterial as applySharedTerrainMaterial, verifiableTopBlend as sharedVerifiableTopBlend } from "../src/terrain-material.js";

// Use the bundled Three implementation, replacing only network and GLTF parse
// ports so the loader and batching contracts run without a WebGL canvas.
const source = (await readFile(new URL("../src/geometry-loader.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export (?=(?:async )?function )/gm, "");
const waterSource = (await readFile(new URL("../src/source-water-material.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export (?=function )/gm, "");
const applySourceWaterDepth = new Function("THREE", "supportsSourceEffect", `${waterSource}\nreturn applySourceWaterDepth;`)(THREE, supportsSourceEffect);
const compile = (ports = {}) => new Function(
  "THREE", "GLTFLoader", "MeshoptDecoder", "decodeGeometryBytes", "GEOMETRY_FORMATS", "positiveInstanceTransform", "getSourceEffectMaterial", "supportsSourceEffect", "isExplosiveMineMaterial", "recordedHiddenMineIndices", "sha256Hex", "fetch", "crypto", "isProjectionProxyMaterial", "shadowOnlyNodeIndices", "applySourceWaterDepth", "readGeometryResponse", "checkGeometryAbort", "reportGeometryProgress", "yieldGeometryTask", "applySharedTerrainMaterial", "sharedVerifiableTopBlend", "sectionMaterial", "isInteriorLayer",
  `${source}\nreturn { loadGameGeometry, batchStaticMeshes, sourceFacade, updateRecordedMineVisibility, updateMapFogSurfaceVisibility, verifiableTopBlend };`,
)(THREE, ports.GLTFLoader, {}, ports.decode || decodeGeometryBytes, GEOMETRY_FORMATS, positiveInstanceTransform, getSourceEffectMaterial, supportsSourceEffect, isExplosiveMineMaterial, recordedHiddenMineIndices, sha256Hex, ports.fetch, ports.crypto || webcrypto, isProjectionProxyMaterial, ports.shadowOnlyNodeIndices || shadowOnlyNodeIndices, applySourceWaterDepth, readGeometryResponse, checkGeometryAbort, reportGeometryProgress, yieldGeometryTask, applySharedTerrainMaterial, sharedVerifiableTopBlend, sectionMaterial, isInteriorLayer);

test("only the verified original split shell participates in facade removal", () => {
  const { sourceFacade } = compile();
  const template = { segment: 4, objectId: "map-enclosure:BuildPlayer-Level_1:16118", sourceRootName: "Gloom Temple",
    sourceModelName: "Temple Structure Outer", sourceOriginalRendererEnabled: false, sourceActiveSplitRenderers: 2 };
  const document = { nodes: [{ mesh: 2 }, { mesh: 0 }, { mesh: 1 }, { mesh: 3 }, { mesh: 4 }],
    meshes: ["Generated mesh 0,0,0", "Generated mesh 3,2,1", "Stair large", "TempleCampfire", "Arrow Shooter"].map(name => ({ name })) };
  const result = sourceFacade(template, "26542162", document);
  assert.deepEqual([...result.nodes], [1, 2]);
  assert.equal(result.coreRadius, 60);
  assert.equal(sourceFacade({ ...template, sourceRootName: "VolcanoModel", sourceModelName: "Pipe" }, "26542162", document).coreRadius, 3.25);
  for (const override of [{ segment: 3 }, { objectId: "chapter" }, { sourceRootName: "Other" },
    { sourceModelName: "Stair large" }, { sourceActiveSplitRenderers: 3 }, { sourceOriginalRendererEnabled: true }]) {
    assert.equal(sourceFacade({ ...template, ...override }, "26542162", document), null);
  }
  assert.equal(sourceFacade(template, "unknown", document), null);
});

test("an exterior shell can be hidden without dropping the interior shaft, crossing floor, or a same-material stair", () => {
  const { batchStaticMeshes } = compile();
  const scene = new THREE.Group(), split = new THREE.Group(), geometry = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 1,            // inside the shaft
    -20, -10, 0, 20, -10, 0, 0, 20, 0,     // floor spanning the shaft, all edges outside
    -5, 0, 1, 5, 0, 1, -5, 3, 1,           // crossing ledge
    9, 0, 0, 10, 0, 0, 9, 1, 1,            // separate exterior wall panel
  ], 3);
  geometry.setAttribute("position", position);
  geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const stone = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  stone.userData.peakTerrain = { sourceColors: { cull: 2 } };
  split.add(new THREE.Mesh(geometry, stone)); split.position.set(0, 818, 2050);
  const stair = new THREE.Mesh(geometry, stone);
  const associations = new Map([[split, { nodes: 3 }], [stair, { nodes: 4 }]]);
  scene.add(split, stair);
  const root = batchStaticMeshes(scene, "26542162", new Set(), associations, { facade: { nodes: new Set([3]), coreRadius: 2 } });
  assert.equal(root.children.length, 3);
  const exterior = root.children.find(mesh => mesh.userData.exteriorFacade), originalStair = root.children.find(mesh => mesh.geometry === geometry);
  const core = root.children.find(mesh => mesh !== exterior && mesh !== originalStair);
  assert.deepEqual([...exterior.geometry.index.array], [9, 10, 11]);
  assert.deepEqual([...core.geometry.index.array], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(core.geometry.getAttribute("position"), position);
  assert.equal(exterior.geometry.getAttribute("position"), position);
  assert.equal(core.material.side, THREE.FrontSide);
  assert.equal(exterior.material, stone); assert.equal(originalStair.material, stone); assert.equal(stone.side, THREE.DoubleSide);
  assert.deepEqual(exterior.boundingBox.min.toArray(), [9, 818, 2050]);
  exterior.visible = false;
  assert.equal(core.visible, true); assert.equal(originalStair.visible, true);
});

test("both native entrance ramps keep their whole walking surface on either side of the cut", () => {
  const { batchStaticMeshes, sourceFacade } = compile();
  for (const sample of [
    { root: "Gloom Temple", model: "Temple Structure Outer", x: 3.505, y: 114.328, z: 0.78025064,
      floor: [[4.50848389, 111.40821075, 0.61593628], [4.50848389, 116.2855072, 0.89041138], [0, 113.84629059, 0.75314224]] },
    { root: "VolcanoModel", model: "Pipe", x: 0, y: 8, z: -1.85819150,
      floor: [[0.00024396, 8.02425671, -1.86827517], [-0.00199413, 7.98607206, -1.85335374], [0.01259902, 8.02140236, -1.86072874]] },
  ]) {
    // Exact source triangles in model space (local Z up). The Citadel sample
    // is under a recorded player in Level_107, more than 114m from its axis.
    const layer = { objectId: "map-enclosure:fixture", segment: 4, sourceRootName: sample.root, sourceModelName: sample.model,
      sourceOriginalRendererEnabled: false, sourceActiveSplitRenderers: 1 };
    const facade = sourceFacade(layer, "26542162", { nodes: [{ mesh: 0 }], meshes: [{ name: "Generated mesh 0,0,0" }] });
    const geometry = new THREE.BufferGeometry(), stone = new THREE.MeshStandardMaterial();
    stone.userData.peakTerrain = { sourceMaterial: sample.model === "Pipe" ? "M_Rock_Volcano" : "M_temple_stone_Citadel",
      sourceColors: { cull: 2, shader: "W/Peak_Rock" } };
    const roof = sample.floor.map(([x, y, z]) => [x, y, z + 25]);
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([...sample.floor.flat(), ...roof.flat()], 3));
    geometry.setIndex([0, 1, 2, 3, 4, 5, 2, 1, 0]); // Floor, upper roof, downward-facing stone.
    const mesh = new THREE.Mesh(geometry, stone), scene = new THREE.Group();
    scene.add(mesh);
    const sectionPlane = { value: new THREE.Vector4(0, 1, 0, 1), footing: { value: new THREE.Vector4() } };
    const root = batchStaticMeshes(scene, "26542162", new Set(), new Map([[mesh, { nodes: 0 }]]),
      { facade, sectionPlane, sectionMeshNames: ["Generated mesh 0,0,0"] });
    const floor = root.children.filter(draw => !draw.userData.exteriorFacade && !draw.material.userData.peakSectionPlane);
    assert.equal(floor.length, 1);
    assert.deepEqual([...floor[0].geometry.index.array], [0, 1, 2]);
    const shell = root.children.find(draw => draw.userData.exteriorFacade);
    assert.equal(shell.visible, true);
    assert.equal(shell.userData.kilnOuterSkin === true, sample.model === "Pipe");
    assert.notEqual(floor[0].userData.kilnOuterSkin, true);
    assert.equal(shell.material.userData.peakSectionPlane, true);
    const ray = new THREE.Raycaster(new THREE.Vector3(sample.x, sample.y, sample.z + 1), new THREE.Vector3(0, 0, -1));
    const [hit] = ray.intersectObjects(floor);
    assert.ok(hit && Math.abs(hit.point.z - sample.z) < 0.00001, sample.root);
  }
});

test("the Kiln entrance lining stays with the shaft even where the outer mountainside nearly touches it", () => {
  const { batchStaticMeshes, sourceFacade } = compile();
  const name = "Generated mesh 1,0,3", document = { nodes: [{ mesh: 0 }], meshes: [{ name }] };
  const facade = sourceFacade({ objectId: "map-enclosure:fixture", segment: 4, sourceRootName: "VolcanoModel",
    sourceModelName: "Pipe", sourceOriginalRendererEnabled: false, sourceActiveSplitRenderers: 1 }, "26542162", document);
  const geometry = new THREE.BufferGeometry(), rock = new THREE.MeshStandardMaterial();
  rock.userData.peakTerrain = { sourceMaterial: "M_Rock_Volcano", sourceColors: { shader: "W/Peak_Rock", cull: 2 } };
  // Original Pipe faces. At (0, 10.77) the mouth ceiling and the overlying
  // mountain are just 0.317 model units apart and use the same rock material.
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    .01952, 5.31445, -.21670, .01333, 5.22687, -.19084, -.00135, 5.22587, -.19439,
    -.02428, 10.79116, .95163, .02495, 10.79666, .94058, -.00742, 10.70792, .80480,
    .08658, 10.71294, 1.36210, .06275, 10.86562, 1.05493, -.07376, 10.81156, 1.11876,
    // Pixel probes on the original doorway lip and the outdoor slope below it.
    -.796, 11.097, -1.591, -.771, 11.107, -1.615, -.804, 11.179, -1.662,
    -3.083, 12.702, -4.238, -3.365, 13.193, -4.833, -3.982, 12.825, -4.734,
    -.016, 12.98, -3.049, -.078, 12.798, -2.988, -.003, 12.807, -3.009,
  ], 3));
  geometry.setIndex(Array.from({ length: 18 }, (_, i) => i));
  const scene = new THREE.Group(), mesh = new THREE.Mesh(geometry, rock);
  scene.add(mesh);
  const sectionPlane = { value: new THREE.Vector4(), footing: { value: new THREE.Vector4() } };
  const root = batchStaticMeshes(scene, "26542162", new Set(), new Map([[mesh, { nodes: 0 }]]),
    { facade, sectionPlane, sectionMeshNames: [name] });
  const skin = root.children.find(draw => draw.userData.kilnOuterSkin);
  const lining = root.children.find(draw => !draw.userData.exteriorFacade && draw.material.userData.peakSectionPlane);
  const doorway = root.children.find(draw => !draw.userData.exteriorFacade && !draw.material.userData.peakSectionPlane);
  assert.deepEqual([...lining.geometry.index.array], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...doorway.geometry.index.array], [9, 10, 11]);
  assert.deepEqual([...skin.geometry.index.array], [6, 7, 8, 12, 13, 14, 15, 16, 17]);
});

test("only verified original structural draws use the shared section plane, even for shared stone", () => {
  const { batchStaticMeshes } = compile();
  const geometry = new THREE.BoxGeometry(), stone = new THREE.MeshStandardMaterial();
  stone.name = "M_temple_stone_Citadel";
  stone.userData.peakTerrain = { sourceMaterial: stone.name, sourceColors: { shader: "W/Peak_Rock" } };
  const scene = new THREE.Group(), associations = new Map();
  const names = ["Central Tower Entry", "Central Tower Entry", "Central Tower Spike Floor", "Stair large", "TempleCampfire"];
  names.forEach((name, index) => {
    const owner = new THREE.Group(); owner.add(new THREE.Mesh(geometry, stone));
    associations.set(owner, { nodes: index }); scene.add(owner);
  });
  const sectionPlane = { value: new THREE.Vector4(), footing: { value: new THREE.Vector4() } };
  const result = batchStaticMeshes(scene, "26542162", new Set(), associations, { sectionPlane, sectionMeshNames: names });
  const marked = result.children.filter(mesh => mesh.material.userData.peakSectionPlane);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].count, 2);
  assert.equal(result.children.find(mesh => mesh.material === stone).count, 3);
  assert.equal(stone.userData.peakSectionPlane, undefined);
  const material = marked[0].material;
  assert.notEqual(material.customProgramCacheKey(), stone.customProgramCacheKey());
  const shader = { uniforms: {}, fragmentShader: "#include <clipping_planes_fragment>", vertexShader: "#include <defaultnormal_vertex>" };
  material.onBeforeCompile(shader, {});
  assert.match(shader.vertexShader, /inverse\(mat3\(instanceMatrix\)\)/, "keeps the signed map's affine normal correction");
  assert.equal(shader.uniforms.peakSectionPlane, sectionPlane);
  assert.equal(shader.uniforms.peakSectionFooting, sectionPlane.footing);
  assert.ok(!shader.fragmentShader.includes("gl_FragCoord"), "the cut is fixed in building space at any viewport size");
  const version = material.version;
  sectionPlane.value.set(0.6, 0.8, -38, 1);
  sectionPlane.footing.value.set(8, 730, -12, 3);
  assert.equal(shader.uniforms.peakSectionPlane.value.w, 1);
  assert.equal(shader.uniforms.peakSectionFooting.value.y, 730);
  assert.equal(material.version, version);
  sectionPlane.value.w = 0;
  assert.equal(shader.uniforms.peakSectionPlane.value.w, 0);
});

test("transparent surfaces, lava, crystals and unverified rocks never receive the section plane", () => {
  const stone = new THREE.MeshStandardMaterial();
  const plane = { value: new THREE.Vector4(), footing: { value: new THREE.Vector4() } };
  function classify(name, shader, mesh, edits = {}, splitShell = false) {
    const mat = stone.clone(); Object.assign(mat, edits);
    mat.userData.peakTerrain = { sourceMaterial: name, sourceColors: { shader } };
    return sectionMaterial(mat, mesh, splitShell, plane, new Map()).userData.peakSectionPlane === true;
  }
  assert.equal(classify("M_Rock_Volcano", "W/Peak_Rock", "RockFinal"), true);
  assert.equal(classify("M_Lava", "Lava", "CirclePlane"), false);
  assert.equal(classify("M_Rock_Crystal", "W/Peak_Standard", "heart"), false);
  assert.equal(classify("M_Rock_Volcano", "W/Peak_Rock", "RockFinal", { transparent: true }), false);
  assert.equal(classify("M_Rock_Volcano", "OtherShader", "RockFinal"), false);
  assert.equal(classify("M_Rock_Volcano", "W/Peak_Rock", "Rock_Hold1"), false);
  assert.equal(classify("M_Rock_peak", "W/Peak_Rock", "Rock_Platform"), false);
  assert.equal(classify("Tarnished Gold Carving", "W/Peak_Standard", "Bridge Structure"), true);
  assert.equal(classify("Tarnished Gold Carving", "W/Peak_Standard", "Bridge Stairs"), false);
  assert.equal(classify("M_RopeBridgeWood", "W/Peak_Standard", "Generated mesh 1,2,0", {}, true), true);
  assert.equal(classify("M_RopeBridgeWood", "W/Peak_Standard", "Bridge"), false);
});

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

test("full and cold campfire loads select the same intact instances of a multi-primitive node", () => {
  const { batchStaticMeshes } = compile();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  const matcher = { includesNode: node => node === 23, matches: (node, i) => node === 23 && i === 1 };
  function build(campOnly) {
    const scene = new THREE.Group(), sourceNode = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const primitive = new THREE.InstancedMesh(geometry, material, 3);
      for (let j = 0; j < 3; j++) primitive.setMatrixAt(j, new THREE.Matrix4().makeTranslation(j * 10, i, -5));
      sourceNode.add(primitive);
    }
    scene.add(sourceNode);
    return batchStaticMeshes(scene, "26542162", new Set(), new Map([[sourceNode, { nodes: 23 }]]),
      { campfire: matcher, campOnly });
  }
  const full = build(false), cold = build(true);
  assert.equal(full.children.filter(mesh => !mesh.userData.nativeCampfire).reduce((n, mesh) => n + mesh.count, 0), 4);
  assert.equal(cold.children.length, 1);
  const warm = full.children.find(mesh => mesh.userData.nativeCampfire);
  const held = cold.children[0];
  assert.equal(held.userData.nativeCampfire, true);
  assert.equal(held.count, 2);
  assert.equal(held.geometry, geometry);
  assert.equal(held.material, material);
  assert.deepEqual(held.instanceMatrix.array, warm.instanceMatrix.array);
});

test("pit fade boxes are excluded from rendering and terrain raycasts without hiding real cubes", () => {
  const { batchStaticMeshes } = compile();
  const geometry = new THREE.BoxGeometry();
  const fade = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  fade.name = "DarkFade";
  fade.userData.peakTerrain = { sourceMaterial: "DarkFade", sourceColors: { shader: "DarkFade" } };
  const solid = new THREE.MeshStandardMaterial(); solid.name = "M_DesertSand";
  const scene = new THREE.Group();
  const affine = new THREE.Mesh(geometry, fade); affine.name = "Cube-affine";
  affine.position.set(0, 4, 0); scene.add(affine);
  const instances = new THREE.InstancedMesh(geometry, fade, 3);
  for (let i = 0; i < 3; i++) instances.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 4, 2, 0));
  scene.add(instances);
  const terrain = new THREE.Mesh(geometry, solid); terrain.name = "Cube"; scene.add(terrain);
  const batched = batchStaticMeshes(scene, 26155610); batched.updateMatrixWorld(true);
  assert.equal(batched.userData.omittedProjectionInstances, 4);
  assert.equal(batched.children.length, 1);
  assert.equal(batched.children[0].material, solid);
  const hits = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0))
    .intersectObject(batched, true);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit) => Math.abs(hit.point.y - 0.5) < 1e-6), "only the genuine ground remains pickable");
  assert.equal(geometry.index.count, 36, "shared cube geometry keeps every original triangle");
  geometry.dispose(); fade.dispose(); solid.dispose(); instances.dispose();
  batched.children.forEach((mesh) => mesh.dispose());
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

test("forest rock top colour replaces UV0 noise instead of inheriting its stripes", () => {
  const { batchStaticMeshes } = compile();
  const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), alphaTest: 0.4 });
  material.userData.peakTerrain = { baseColor: [0.183, 0.226, 0.264], topColor: [0.347, 0.419, 0.050],
    tightness: [0.707, 0.765], amount: 1, topAlpha: 1, sourceMaterial: "M_Forest_rock",
    sourceColors: { shader: "W/Peak_Rock" } };
  const geometry = new THREE.PlaneGeometry(); const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, material)); const batch = batchStaticMeshes(scene);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader, {});
  // Execute the actual injected scalar channel expression. Distinct noise
  // texels model the forest mesh's u=0, varying-v UVs, including a black texel.
  const statement = shader.fragmentShader.match(/#include <color_fragment>\s*(diffuseColor\.rgb[^;]+;)/)?.[1];
  assert.ok(statement);
  const shade = new Function("diffuseColor", "peakBase", "peakTop", "peakRamp", "vPeakUp", "peakAmount", "peakTopAlpha", "mix", "smoothstep",
    `${statement}\nreturn diffuseColor;`);
  const mix = (a, b, t) => a * (1 - t) + b * t;
  const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const sample = (texel, up, amount = 1, alpha = 1) => shade({ rgb: texel, a: 0.37 },
    0.183, 0.347, { x: 0.707, y: 0.765 }, up, amount, alpha, mix, smoothstep);
  for (const texel of [0, 0.12, 0.9, 1]) {
    assert.equal(sample(texel, 1).rgb, 0.347, "grass-covered tops must not carry bottom-layer noise");
    assert.equal(sample(texel, 0).rgb, texel * 0.183, "walls retain the original base texture");
    assert.ok(Math.abs(sample(texel, 0.736).rgb - mix(texel * 0.183, 0.347, 0.5)) < 1e-12);
    assert.equal(sample(texel, 1, 0).rgb, texel * 0.183);
    assert.equal(sample(texel, 1, 1, 0).rgb, texel * 0.183);
    assert.equal(sample(texel, 1).a, 0.37, "source cutout opacity is preserved");
  }
  assert.match(shader.fragmentShader, /#include <map_fragment>/);
  assert.match(shader.fragmentShader, /#include <alphatest_fragment>/);
  // Different blend equations cannot share a cached GPU program.
  const vine = new THREE.MeshStandardMaterial();
  vine.userData.peakTerrain = { ...material.userData.peakTerrain, sourceColors: { shader: "W/Vine" } };
  const vineScene = new THREE.Group(); vineScene.add(new THREE.Mesh(geometry, vine));
  const vineBatch = batchStaticMeshes(vineScene);
  const vineShader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  vine.onBeforeCompile(vineShader, {});
  assert.match(vineShader.fragmentShader, /diffuseColor\.rgb \*= mix\(peakBase, peakTop,/);
  assert.notEqual(material.customProgramCacheKey(), vine.customProgramCacheKey());
  material.map.dispose(); geometry.dispose(); material.dispose(); vine.dispose();
  [...batch.children, ...vineBatch.children].forEach((mesh) => mesh.dispose());
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

test("legacy palm cards recover UV0 and source double-sided cutouts without changing shared textures", () => {
  const { batchStaticMeshes } = compile();
  const fixture = effectFixture("M_Foliage_Palmtree 5", "GD/FoliageGD");
  const original = new THREE.Texture(); original.flipY = false;
  original.wrapS = original.wrapT = THREE.RepeatWrapping;
  fixture.material.map = original; fixture.material.alphaTest = 0.5;
  fixture.material.userData.peakTerrain.sourceCutout = { textureProperty: "_Shape", cull: 2, alphaCutoff: 0.5 };
  const root = batchStaticMeshes(fixture.scene, "25306743");
  assert.equal(fixture.material.side, THREE.DoubleSide);
  assert.equal(fixture.material.alphaTest, 0.5);
  assert.notEqual(fixture.material.map, original);
  assert.deepEqual(original.repeat.toArray(), [1, 1]);
  const corrected = fixture.material.map; corrected.updateMatrix();
  for (const [u, v] of [[0, 0], [1, 1], [0.17, 0.83], [0.91, 0.23]]) {
    const recovered = corrected.transformUv(new THREE.Vector2(12 * u, 1 - 12 * v));
    assert.ok(Math.abs(recovered.x - u) < 1e-6);
    assert.ok(Math.abs(recovered.y - (1 - v)) < 1e-6);
  }
  assert.equal(corrected.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(corrected.wrapT, THREE.ClampToEdgeWrapping);
  // Reusing the material during batching must not divide its UVs twice.
  const scene = new THREE.Group(); scene.add(new THREE.Mesh(fixture.geometry, fixture.material));
  const second = batchStaticMeshes(scene, "25306743");
  assert.equal(fixture.material.map, corrected);
  fixture.geometry.dispose(); fixture.material.dispose(); original.dispose(); corrected.dispose();
  for (const mesh of [...root.children, ...second.children]) mesh.dispose();
});

test("corrected exports and unrelated materials do not receive legacy palm UV repair", () => {
  const { batchStaticMeshes } = compile();
  for (const [build, name, shader, cutout] of [
    ["other", "M_Foliage_Palmtree 5", "GD/FoliageGD", { textureProperty: "_Shape" }],
    ["25306743", "M_Foliage_Palmtree 5", "Other/Foliage", { textureProperty: "_Shape" }],
    ["25306743", "M_Foliage_Palmtree 5", "GD/FoliageGD", undefined],
    ["25306743", "M_Foliage_Pine", "GD/FoliageGD", { textureProperty: "_Shape" }],
    ["25306743", "M_Foliage_Palmtree 5", "GD/FoliageGD", { textureProperty: "_Shape", cullSource: "shader-pass", uvTransform: "mesh-uv0" }],
  ]) {
    const fixture = effectFixture(name, shader); const map = new THREE.Texture(); fixture.material.map = map;
    fixture.material.userData.peakTerrain.sourceCutout = cutout;
    const root = batchStaticMeshes(fixture.scene, build);
    assert.equal(fixture.material.map, map);
    assert.deepEqual(map.repeat.toArray(), [1, 1]);
    assert.equal(fixture.material.userData.peakSourceCutout, undefined);
    fixture.geometry.dispose(); fixture.material.dispose(); map.dispose(); root.children[0].dispose();
  }
});

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

test("swamp depth hook survives affine batching and cannot share ordinary water's shader program", () => {
  const sourceScene = new THREE.Group();
  const materials = ["M_Water_swamp", "M_Water_forest"].map(name => {
    const material = new THREE.MeshStandardMaterial(); material.name = name;
    material.userData.peakTerrain = { sourceMaterial: name, sourceColors: { shader: "GD/Water-GD" } };
    sourceScene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));
    return material;
  });
  compile().batchStaticMeshes(sourceScene, "25306743");
  const [swamp, forest] = materials;
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  swamp.onBeforeCompile(shader, {});
  assert.equal(shader.uniforms.sceneDepth, swamp.uniforms.sceneDepth);
  assert.match(shader.fragmentShader, /peakWaterTint/);
  assert.match(shader.vertexShader, /transpose\(inverse\(mat3\(instanceMatrix\)\)\)/);
  assert.notEqual(swamp.customProgramCacheKey(), forest.customProgramCacheKey());
  assert.ok(swamp.color.r < .05, "missing final tint must not restore the bright yellow primary");
  assert.equal(forest.userData.peakWaterDepth, undefined);
  sourceScene.children.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); });
});

test("fungal correction requires the archived neutral Tint and never recolours pale bell submeshes", () => {
  const { batchStaticMeshes } = compile();
  const normal = effectFixture("M_Mushroom_tree", "W/Peak_Standard");
  const pale = effectFixture("M_MushroomBase", "W/Peak_Standard");
  const source = normal.material.userData.peakTerrain.sourceColors;
  Object.assign(source, { baseProperty: "_Tint", baseFlags: 16,
    baseStored: [0.4842766523361206, 0.4842766523361206, 0.4842766523361206] });
  const scene = new THREE.Group();
  // One original object can have both a pale outer shell and a cap-coloured rim.
  normal.geometry.addGroup(0, 6, 0); normal.geometry.addGroup(6, 6, 1);
  scene.add(new THREE.Mesh(normal.geometry, [pale.material, normal.material]));
  const batch = batchStaticMeshes(scene, "25306743");
  assert.deepEqual(batch.children[0].material, [pale.material, normal.material]);
  assert.equal(pale.material.userData.peakSourceEffect, undefined);
  assert.equal(normal.material.userData.peakSourceEffect.kind, "fungus");
  assert.deepEqual(normal.material.color.toArray(), getSourceEffectMaterial("25306743", "M_Mushroom_tree", "W/Peak_Standard").baseColor);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  normal.material.onBeforeCompile(shader, {});
  assert.doesNotMatch(shader.fragmentShader, /peakBase|peakTop/, "obsolete saved top colour cannot repaint caps white");
  for (const altered of [
    { baseStored: [0.1, 0.2, 0.3] }, { baseFlags: 0 }, { baseStored: [NaN, 0.4842766523361206, 0.4842766523361206] },
    { baseProperty: "_BaseColor" },
  ]) {
    const fixture = effectFixture("M_Mushroom_tree", "W/Peak_Standard");
    Object.assign(fixture.material.userData.peakTerrain.sourceColors, source, altered);
    const root = batchStaticMeshes(fixture.scene, "25306743");
    assert.equal(fixture.material.userData.peakSourceEffect, undefined,
      "changed source or newly exported primary colours must not be overwritten");
    fixture.geometry.dispose(); fixture.material.dispose(); root.children.forEach((mesh) => mesh.dispose());
  }
  normal.geometry.dispose(); pale.geometry.dispose(); normal.material.dispose(); pale.material.dispose();
  batch.children.forEach((mesh) => mesh.dispose());
});

test("Jelly loads with its purple source color and original pass without altering sea urchins", () => {
  const { batchStaticMeshes } = compile();
  for (const name of ["Jelly", "M_Urchin"]) {
    const fixture = effectFixture(name, name === "Jelly" ? "Jelly" : "W/Peak_Standard");
    fixture.material.side = THREE.DoubleSide;
    const root = batchStaticMeshes(fixture.scene, "25306743");
    if (name === "Jelly") {
      assert.deepEqual(fixture.material.color.toArray(), getSourceEffectMaterial("25306743", "Jelly", "Jelly").baseColor);
      assert.ok(fixture.material.color.b > fixture.material.color.g);
      assert.ok(fixture.material.color.r > fixture.material.color.g);
      assert.equal(fixture.material.side, THREE.FrontSide);
      assert.equal(fixture.material.transparent, true);
      assert.equal(fixture.material.depthWrite, true);
      assert.equal(fixture.material.opacity, 1, "refraction mixing alpha is not surface opacity");
      const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
      fixture.material.onBeforeCompile(shader, {});
      assert.doesNotMatch(shader.fragmentShader, /peakBase|peakTop/);
    } else {
      assert.equal(fixture.material.userData.peakSourceEffect, undefined);
      assert.equal(fixture.material.side, THREE.DoubleSide);
      assert.equal(fixture.material.transparent, false);
    }
    fixture.geometry.dispose(); fixture.material.dispose(); root.children[0].dispose();
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
  const swamp = add(3), temple = add(4, "FogSurface", "GD/FogSurface", "26542162"), alreadyHidden = add(4);
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

test("current exported materials keep tinted swamp depth, fog replacement and primary fungal colours", () => {
  const { batchStaticMeshes, updateMapFogSurfaceVisibility } = compile();
  for (const build of ['25739797', '26134529', '26155610']) {
    const swamp = effectFixture('M_Water_swamp', 'GD/Water-GD');
    const waterModel = batchStaticMeshes(swamp.scene, build);
    assert.ok(swamp.material.userData.peakWaterDepth);
    assert.ok(swamp.material.color.r < .05);
    const fog = effectFixture('FogSurface', 'GD/FogSurface');
    const fogModel = batchStaticMeshes(fog.scene, build);
    const chapter = new THREE.Group(); chapter.userData.segment = 3; chapter.add(fogModel);
    const terrain = new THREE.Group(); terrain.add(chapter);
    assert.equal(updateMapFogSurfaceVisibility(terrain, [{ kind: 'sleep_fog', authority: 'map-baseline', segment: 3,
      surfaceMaterial: 'FogSurface', surfaceShader: 'GD/FogSurface' }]), 1);
    assert.equal(fogModel.children[0].visible, false);
    const fungus = effectFixture('M_Mushroom_tree', 'W/Peak_Standard');
    const color = [.26041290266199724, .023338885548048083, .03023184798988776];
    Object.assign(fungus.material.userData.peakTerrain, { baseColor: color, topColor: [1, 1, 1], amount: 0,
      sourceColors: { shader: 'W/Peak_Standard', baseProperty: '_BaseColor', baseFlags: 16 } });
    const fungusModel = batchStaticMeshes(fungus.scene, build);
    assert.equal(fungus.material.userData.peakSourceEffect, undefined, 'new export must not reapply legacy Tint correction');
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    fungus.material.onBeforeCompile(shader, {});
    assert.deepEqual(shader.uniforms.peakBase.value.toArray(), color);
    assert.equal(shader.uniforms.peakAmount.value, 0, 'stale white top colour cannot repaint the new cap');
    for (const fixture of [swamp, fog, fungus]) { fixture.geometry.dispose(); fixture.material.dispose(); }
    for (const model of [waterModel, fogModel, fungusModel]) model.children.forEach(mesh => mesh.dispose());
  }
});
