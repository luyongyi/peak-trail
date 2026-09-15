import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { decodeGeometryBytes, GEOMETRY_FORMATS } from "./geometry-bytes.js";
import { positiveInstanceTransform } from "./geometry-matrices.js";
import { getSourceEffectMaterial } from "./source-materials.js";

function assertEmbeddedGlb(bytes) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67
      || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength
      || view.getUint32(16, true) !== 0x4e4f534a) throw new Error("地图模型不是有效 GLB 2.0");
  const length = view.getUint32(12, true);
  if (20 + length > bytes.byteLength) throw new Error("地图模型 JSON 长度无效");
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
  for (const resource of [...(document.buffers || []), ...(document.images || [])]) {
    if (resource.uri && !resource.uri.startsWith("data:")) throw new Error("地图模型不能引用包外部资源");
  }
}

function applySourceEffectMaterial(material, gameBuildId) {
  const terrain = material.userData?.peakTerrain;
  const effect = getSourceEffectMaterial(gameBuildId, terrain?.sourceMaterial || material.name, terrain?.sourceColors?.shader);
  if (!effect || !material.color || !material.emissive) return false;
  // These exact-build source colors approximate only the static effect surface,
  // not Unity's animated lava, depth-based water or volumetric fog shaders.
  material.color.fromArray(effect.baseColor);
  material.emissive.fromArray(effect.emissive);
  material.emissiveIntensity = effect.emissiveIntensity;
  material.opacity = effect.opacity;
  material.transparent = effect.transparent;
  material.depthWrite = effect.depthWrite;
  material.alphaTest = 0;
  material.userData.peakSourceEffect = effect;
  material.needsUpdate = true;
  return true;
}

function applyTerrainMaterial(material) {
  const terrain = material.userData?.peakTerrain;
  if (!terrain) return;
  const base = terrain.baseColor;
  const top = terrain.topColor;
  if (!Array.isArray(base) || !Array.isArray(top)) return;
  material.color.set(0xffffff);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.peakBase = { value: new THREE.Color(base[0], base[1], base[2]) };
    shader.uniforms.peakTop = { value: new THREE.Color(top[0], top[1], top[2]) };
    const ramp = Array.isArray(terrain.tightness) ? terrain.tightness : [0, 1];
    shader.uniforms.peakRamp = { value: new THREE.Vector2(Number(ramp[0]) || 0, Number(ramp[1]) || 1) };
    shader.uniforms.peakAmount = { value: Number.isFinite(terrain.amount) ? terrain.amount : 1 };
    shader.uniforms.peakTopAlpha = { value: Number.isFinite(terrain.topAlpha) ? terrain.topAlpha : 1 };
    shader.vertexShader = "varying float vPeakUp;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <defaultnormal_vertex>",
      "#include <defaultnormal_vertex>\nvPeakUp = max(inverseTransformDirection(normalize(transformedNormal), viewMatrix).y, 0.0);");
    shader.fragmentShader = "varying float vPeakUp;\nuniform vec3 peakBase;\nuniform vec3 peakTop;\nuniform vec2 peakRamp;\nuniform float peakAmount;\nuniform float peakTopAlpha;\n" + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>",
      "#include <color_fragment>\ndiffuseColor.rgb *= mix(peakBase, peakTop, smoothstep(peakRamp.x, peakRamp.y, vPeakUp) * peakAmount * peakTopAlpha);");
  };
  material.customProgramCacheKey = () => "peak-terrain-original-mesh-v1";
  material.needsUpdate = true;
}

function preserveAffineMatrices(gltf) {
  gltf.scene.traverse((object) => {
    const nodeIndex = gltf.parser.associations.get(object)?.nodes;
    const matrix = object.userData?.peaktrailAffineMatrix || gltf.parser.json.nodes?.[nodeIndex]?.matrix;
    if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(Number.isFinite)) return;
    // GLTFLoader applies node.matrix through TRS decomposition. Restore the
    // original serialized affine matrix before any world-matrix evaluation.
    object.matrix.fromArray(matrix);
    object.matrixAutoUpdate = false;
    object.matrixWorldNeedsUpdate = true;
  });
}

function useExactInstanceNormals(material) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace("#include <defaultnormal_vertex>",
      "#include <defaultnormal_vertex>\n#ifdef USE_INSTANCING\ntransformedNormal = normalMatrix * transpose(inverse(mat3(instanceMatrix))) * objectNormal;\n#ifdef FLIP_SIDED\ntransformedNormal = -transformedNormal;\n#endif\n#endif");
  };
  material.customProgramCacheKey = () => material.userData?.peakSourceEffect
    ? `peak-source-effect-${material.userData.peakSourceEffect.kind}-affine-normals-v1`
    : material.userData?.peakTerrain ? "peak-terrain-affine-normals-v1" : "peak-prop-affine-normals-v1";
  material.needsUpdate = true;
}

/** Keep every original triangle; share repeated rocks/trees and preserve full
 * matrixWorld, including shear that glTF's TRS instancing cannot represent. */
function batchStaticMeshes(scene, gameBuildId) {
  scene.updateMatrixWorld(true);
  const batches = new Map();
  const instance = new THREE.Matrix4();
  const prepared = new Set();
  scene.traverse((object) => {
    if (!object.isMesh || object.isSkinnedMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!prepared.has(material)) {
        if (!applySourceEffectMaterial(material, gameBuildId)) applyTerrainMaterial(material);
        useExactInstanceNormals(material);
        prepared.add(material);
      }
    }
    const addMatrix = (worldMatrix) => {
      const transform = positiveInstanceTransform(worldMatrix.elements);
      const key = `${object.geometry.uuid}:${materials.map((material) => material.uuid).join(":")}:${transform.reflected}`;
      if (!batches.has(key)) batches.set(key, { geometry: object.geometry, material: object.material, reflected: transform.reflected, matrices: [] });
      batches.get(key).matrices.push(new THREE.Matrix4().fromArray(transform.matrix));
    };
    if (object.isInstancedMesh) {
      for (let index = 0; index < object.count; index++) {
        object.getMatrixAt(index, instance);
        addMatrix(new THREE.Matrix4().multiplyMatrices(object.matrixWorld, instance));
      }
    } else addMatrix(object.matrixWorld);
  });
  const root = new THREE.Group();
  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
    mesh.scale.x = batch.reflected ? -1 : 1;
    batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    root.add(mesh);
  }
  root.userData.drawBatches = batches.size;
  scene.clear();
  return root;
}

export async function loadGameGeometry(layer, signal, gameBuildId) {
  if (!GEOMETRY_FORMATS.includes(layer.geometryFormat) || !layer.geometryUrl
      || !/^[a-f0-9]{64}$/i.test(layer.geometrySha256 || "")) throw new Error("此关缺少已校验的真实模型引用");
  const response = await fetch(layer.geometryUrl, { signal, cache: "force-cache" });
  if (!response.ok) throw new Error(`真实模型读取失败（${response.status}）`);
  let bytes = await response.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== layer.geometrySha256.toLowerCase()) throw new Error("真实模型内容哈希不匹配，已拒绝显示");
  bytes = await decodeGeometryBytes(bytes, layer.geometryFormat, signal);
  assertEmbeddedGlb(bytes);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, "");
  preserveAffineMatrices(gltf);
  return batchStaticMeshes(gltf.scene, gameBuildId);
}
