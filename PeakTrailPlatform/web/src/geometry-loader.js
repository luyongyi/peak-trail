import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { decodeGeometryBytes, GEOMETRY_FORMATS } from "./geometry-bytes.js";
import { positiveInstanceTransform } from "./geometry-matrices.js";
import { getSourceEffectMaterial } from "./source-materials.js";
import { isExplosiveMineMaterial, recordedHiddenMineIndices } from "./mine-visibility.js";

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

function indexedBounds(geometry) {
  const bounds = new THREE.Box3();
  const position = geometry.getAttribute("position");
  const vertex = new THREE.Vector3();
  const index = geometry.getIndex();
  // Shared Unity static-batch vertex buffers may contain an entire scene. Only
  // the vertices addressed by this primitive's index buffer belong to this mine.
  const count = index?.count ?? position.count;
  for (let i = 0; i < count; i++) bounds.expandByPoint(vertex.fromBufferAttribute(position, index ? index.getX(i) : i));
  return bounds;
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
    const mine = materials.length > 0 && materials.every((material) => {
      const source = material.userData?.peakTerrain;
      return isExplosiveMineMaterial(gameBuildId, source?.sourceMaterial || material.name, source?.sourceColors?.shader);
    });
    const mineBounds = mine ? indexedBounds(object.geometry) : null;
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
      if (!batches.has(key)) batches.set(key, { geometry: object.geometry, material: object.material, reflected: transform.reflected, matrices: [], mines: [] });
      const batch = batches.get(key);
      batch.matrices.push(new THREE.Matrix4().fromArray(transform.matrix));
      if (mineBounds) {
        // Record original Unity-world bounds BEFORE reflection factoring and
        // before scene.js subtracts its display origin from the loaded root.
        const bounds = mineBounds.clone().applyMatrix4(worldMatrix);
        batch.mines.push({ index: batch.matrices.length - 1, center: bounds.getCenter(new THREE.Vector3()).toArray(),
          min: bounds.min.toArray(), max: bounds.max.toArray() });
      }
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
    if (batch.mines.length) mesh.userData.peakRecordedMines = batch.mines.map((mine) => ({
      ...mine, originalMatrix: batch.matrices[mine.index].clone(), hidden: false,
    }));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    root.add(mesh);
  }
  root.userData.drawBatches = batches.size;
  scene.clear();
  return root;
}

/** Reversible static geometry overlay driven only by observed mine state/events.
 * Missing world samples never hide anything. Scrubbing back restores exact
 * original affine matrices, including mirrored instances and scene offsets. */
export function updateRecordedMineVisibility(terrainRoot, objects = [], events = [], time = 0) {
  const candidates = [];
  terrainRoot?.traverse((mesh) => {
    for (const mine of mesh.userData?.peakRecordedMines || []) candidates.push({ ...mine, mesh, mine });
  });
  const hidden = recordedHiddenMineIndices(candidates, objects, events, time);
  const collapsed = new THREE.Matrix4();
  candidates.forEach(({ mesh, mine }, index) => {
    const shouldHide = hidden.has(index);
    if (mine.hidden === shouldHide) return;
    if (shouldHide) {
      collapsed.copy(mine.originalMatrix).scale(new THREE.Vector3(0, 0, 0));
      mesh.setMatrixAt(mine.index, collapsed);
    } else mesh.setMatrixAt(mine.index, mine.originalMatrix);
    mine.hidden = shouldHide;
    mesh.instanceMatrix.needsUpdate = true;
  });
  return hidden.size;
}

/** Replace only a chapter's known static FogSurface with its source-map fog
 * volume. Recorded fog without a verified static-surface identity must not
 * hide geometry by proximity, or infer a chapter from the current camera. */
export function updateMapFogSurfaceVisibility(terrainRoot, fogObjects = []) {
  const segments = new Set(fogObjects.filter((object) => object?.kind === "sleep_fog"
    && object.authority === "map-baseline" && object.active !== false
    && Number.isInteger(object.segment) && object.segment >= 0
    && object.surfaceMaterial === "FogSurface" && object.surfaceShader === "GD/FogSurface")
    .map((object) => object.segment));
  let hidden = 0;
  terrainRoot?.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // A mixed batch cannot be hidden wholesale: it could include water or
    // ordinary terrain. Adaptation metadata also binds the source build.
    const sourceFog = materials.length > 0 && materials.every((material) => {
      const effect = material?.userData?.peakSourceEffect;
      return effect?.kind === "fog" && effect.source?.material === "FogSurface"
        && effect.source?.shader === "GD/FogSurface" && String(effect.source?.buildId) === "25306743";
    });
    let segment;
    for (let owner = mesh; owner && owner !== terrainRoot; owner = owner.parent) {
      const candidate = owner.userData?.mapLayer?.segment ?? owner.userData?.segment;
      if (Number.isInteger(candidate)) { segment = candidate; break; }
    }
    const shouldHide = sourceFog && segments.has(segment);
    const saved = mesh.userData.peakMapFogVisibility;
    if (shouldHide) {
      if (!saved) mesh.userData.peakMapFogVisibility = { visible: mesh.visible };
      mesh.visible = false;
      hidden++;
    } else if (saved) {
      mesh.visible = saved.visible;
      delete mesh.userData.peakMapFogVisibility;
    }
  });
  return hidden;
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
