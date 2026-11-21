import * as THREE from "three";
import { applyTerrainMaterial as applySharedTerrainMaterial, verifiableTopBlend as sharedVerifiableTopBlend } from "./terrain-material.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { decodeGeometryBytes, GEOMETRY_FORMATS, readGeometryResponse, checkGeometryAbort, reportGeometryProgress, yieldGeometryTask } from "./geometry-bytes.js";
import { positiveInstanceTransform } from "./geometry-matrices.js";
import { getSourceEffectMaterial, supportsSourceEffect } from "./source-materials.js";
import { applySourceWaterDepth } from "./source-water-material.js";
import { isExplosiveMineMaterial, recordedHiddenMineIndices } from "./mine-visibility.js";
import { sha256Hex } from "./sha256.js";
import { isProjectionProxyMaterial, shadowOnlyNodeIndices } from "./source-render-policy.js";
import { sectionMaterial } from "./section-material.js";
import { isInteriorLayer } from "./camera-placement.js";

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
  if (effect.kind === "fungus") {
    // Correct only legacy packs that exported the verified neutral _Tint as
    // albedo. A newly authored primary colour must not be multiplied twice.
    const source = terrain?.sourceColors;
    const tint = effect.source.tintProperty;
    if (source?.baseProperty !== "_Tint" || source.baseFlags !== tint.propertyFlags
        || !Array.isArray(source.baseStored) || source.baseStored.length !== 3
        || !source.baseStored.every((value, i) => Number.isFinite(value)
          && Math.abs(value - tint.storedColor[i]) < 1e-7)) return false;
  }
  // These exact-build source colors approximate only the static effect surface,
  // not Unity's animated lava, depth-based water or volumetric fog shaders.
  material.color.fromArray(effect.baseColor);
  material.emissive.fromArray(effect.emissive);
  material.emissiveIntensity = effect.emissiveIntensity;
  material.opacity = effect.opacity;
  material.transparent = effect.transparent;
  material.depthWrite = effect.depthWrite;
  material.alphaTest = 0;
  if (effect.source.cull === 2) material.side = THREE.FrontSide;
  material.userData.peakSourceEffect = effect;
  applySourceWaterDepth(material, effect);
  if (effect.kind === "antisphere") {
    // Unity's AntiSphere Forward pass is alpha-blended. Its output alpha comes
    // from view/depth/noise controls, not _BaseColor.a. Preserve the real two
    // shells and approximate the missing animated/depth shader as a Fresnel
    // edge instead of turning both into opaque white balls.
    material.onBeforeCompile = (shader) => {
      const shape = effect.source.alphaShape;
      shader.uniforms.peakAntiPower = { value: shape._Power };
      shader.uniforms.peakAntiSoftInverse = { value: shape._SoftInverse };
      shader.fragmentShader = "uniform float peakAntiPower;\nuniform float peakAntiSoftInverse;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>",
        "#include <normal_fragment_maps>\nfloat peakAntiRim = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));\npeakAntiRim = pow(clamp(peakAntiRim, 0.0, 1.0), peakAntiPower);\ndiffuseColor.a *= smoothstep(peakAntiSoftInverse, 1.0, peakAntiRim);");
    };
  }
  material.needsUpdate = true;
  return true;
}

function applyTerrainMaterial(material) { applySharedTerrainMaterial(THREE, material); }

export function verifiableTopBlend(shader, amount) { return sharedVerifiableTopBlend(shader, amount); }

function applySourceCutoutMaterial(material, gameBuildId) {
  const terrain = material.userData?.peakTerrain;
  const cutout = terrain?.sourceCutout;
  if (String(gameBuildId) !== "25306743" || cutout?.textureProperty !== "_Shape"
      || !["GD/FoliageGD", "W/Vine"].includes(terrain.sourceColors?.shader)) return;
  // These compiled passes are Cull Off. Old packs copied an undeclared,
  // obsolete saved _Cull=2 instead. Keep their original alpha-test silhouette.
  // Evidence: tools/offline-maps/source-palm-material.25306743.json.
  if (cutout.cullSource !== "shader-pass") material.side = THREE.DoubleSide;
  if (terrain.sourceMaterial === "M_Foliage_Palmtree 5" && material.map
      && cutout.uvTransform !== "mesh-uv0" && !material.userData.peakSourceCutout) {
    // Old packs baked u'=12*u, v'=1-12*v. The shader has no _Shape_ST
    // parameter, so recover glTF UV0: u=u'/12, v=(v'+11)/12.
    // Clone the texture to avoid changing another material sharing its image.
    const map = material.map.clone();
    map.repeat.set(1 / 12, 1 / 12);
    map.offset.set(0, 11 / 12);
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.needsUpdate = true;
    material.map = map;
    material.userData.peakSourceCutout = { buildId: "25306743", recoveredUv: "mesh-uv0" };
  }
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
    ? `peak-source-effect-${material.userData.peakSourceEffect.kind}${material.userData.peakWaterDepth ? '-swamp-depth-v1' : ''}-affine-normals-v1`
    : material.userData?.peakTerrain
      ? material.userData.peakTerrain.sourceColors?.shader === "W/Peak_Rock"
        ? "peak-terrain-rock-base-map-affine-normals-v2" : "peak-terrain-affine-normals-v1"
      : "peak-prop-affine-normals-v1";
  material.needsUpdate = true;
}

function setInstanceBounds(mesh, primitiveBounds) {
  const box = new THREE.Box3(), transformed = new THREE.Box3(), matrix = new THREE.Matrix4();
  for (let i = 0; i < mesh.count; i++) {
    // Read the float32 matrices actually sent to the GPU. Transform a box,
    // not a sphere's radius: shear can exceed the longest matrix column.
    mesh.getMatrixAt(i, matrix);
    box.union(transformed.copy(primitiveBounds).applyMatrix4(matrix));
  }
  mesh.boundingBox = box;
  mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
}

function indexedBounds(geometry, useGroups = false) {
  const bounds = new THREE.Box3(), vertex = new THREE.Vector3();
  const position = geometry.getAttribute("position"), index = geometry.getIndex();
  if (!position) return bounds;
  // Unity static-batch positions can cover the entire scene. Visit only this
  // primitive's actual draw range; array materials additionally select groups.
  const count = index?.count ?? position.count;
  const start = Math.max(0, geometry.drawRange.start);
  const end = Math.min(count, start + geometry.drawRange.count);
  const ranges = useGroups ? geometry.groups.map(group => [Math.max(start, group.start),
    Math.min(end, group.start + group.count)]) : [[start, end]];
  ranges.sort((a, b) => a[0] - b[0]);
  let visitedEnd = start;
  for (const [from, to] of ranges) {
    for (let i = Math.max(from, visitedEnd); i < to; i++) {
      bounds.expandByPoint(vertex.fromBufferAttribute(position, index ? index.getX(i) : i));
    }
    visitedEnd = Math.max(visitedEnd, to);
  }
  return bounds;
}

// Both source structures have a vertical local Z axis. Their pre-split meshes
// include the interior shaft as well as the surrounding facade. In model units
// the gap between the shaft and the exterior contains r=3.25 for Pipe (about
// 64 world metres), and r=60 for Temple Structure Outer (60 world metres).
// Bind these measurements to the audited source mesh, never to a chapter-wide
// material: real stairs, platforms and mechanisms can use the same rock.
const CITADEL_PASSAGE = { coreRadius: 60, floorMin: [-28, 0, -4], floorMax: [28, 185, 6] };
// The open-air hillside is part of Pipe too. Its floor exemption ends a few
// metres beyond the mouth (local y≈10.9), at the original entrance lip.
const KILN_PASSAGE = { coreRadius: 3.25, floorMin: [-1.7, 1.1, -2.25], floorMax: [1.65, 11.3, -0.8], kilnOuterSkin: true };
const auditedFinaleBuilds = new Set(["25306743", "25739797", "26134529", "26155610", "26542162"]);

function sourceFacade(layer, build, document) {
  if (!auditedFinaleBuilds.has(String(build))
      || layer?.segment !== 4 || !layer.objectId?.startsWith("map-enclosure:")
      || layer.sourceOriginalRendererEnabled !== false || !Number.isInteger(layer.sourceActiveSplitRenderers)
      || layer.sourceActiveSplitRenderers <= 0) return null;
  let passage;
  if (layer.sourceRootName === "VolcanoModel" && layer.sourceModelName === "Pipe") passage = KILN_PASSAGE;
  else if (layer.sourceRootName === "Gloom Temple" && layer.sourceModelName === "Temple Structure Outer") passage = CITADEL_PASSAGE;
  else return null;
  const nodes = new Set();
  document.nodes?.forEach((node, index) => {
    if (/^Generated mesh \d+,\d+,\d+$/.test(document.meshes?.[node.mesh]?.name)) nodes.add(index);
  });
  return nodes.size === layer.sourceActiveSplitRenderers ? { ...passage, nodes } : null;
}

function edgeTouchesCore(ax, ay, bx, by, radiusSquared) {
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return x * x + y * y <= radiusSquared;
}

// Past the inner shaft, Pipe has a second bore running along model +Y.
// Cross-sections of the source mesh put its lining in this narrow X/Z range.
// At the flared mouth the outside mountain enters the same box: only keep
// faces oriented into the bore there. The entrance floor is handled separately.
function kilnTunnelLining(pos, a, b, c) {
  const ay = pos.getY(a), by = pos.getY(b), cy = pos.getY(c), y = (ay + by + cy) / 3;
  if (y < 2.9 || y > 11.3) return false;
  const ax = pos.getX(a), bx = pos.getX(b), cx = pos.getX(c), x = (ax + bx + cx) / 3;
  if (x < -1.7 || x > 1.65) return false;
  const az = pos.getZ(a), bz = pos.getZ(b), cz = pos.getZ(c), z = (az + bz + cz) / 3;
  if (z < -2.25 || z > 1.5) return false;
  if (y < 10.25) return true;
  const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return nx * (-0.1 - x) + nz * (-0.7 - z) > 0;
}

// A triangle crossing the core stays whole, including large floors/bridges
// whose three corners may all lie outside the cylinder. The original indices,
// attributes and winding are retained. CPU work occurs once per geometry load.
function partitionFacade(geometry, { coreRadius, floorMin, floorMax, kilnOuterSkin }) {
  const index = geometry.index, pos = geometry.getAttribute("position");
  if (!index || !pos || geometry.groups.length || geometry.drawRange.start !== 0
      || geometry.drawRange.count < index.count || index.count % 3) return [{ geometry }];
  const inside = [], outside = [], passage = [], r2 = coreRadius * coreRadius;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i+1), c = index.getX(i+2);
    const ax = pos.getX(a), ay = pos.getY(a), bx = pos.getX(b), by = pos.getY(b), cx = pos.getX(c), cy = pos.getY(c);
    const ab = ax * by - ay * bx, bc = bx * cy - by * cx, ca = cx * ay - cy * ax;
    const containsAxis = (ab > 0 && bc > 0 && ca > 0) || (ab < 0 && bc < 0 && ca < 0);
    const keep = containsAxis || edgeTouchesCore(ax, ay, bx, by, r2) || edgeTouchesCore(bx, by, cx, cy, r2)
      || edgeTouchesCore(cx, cy, ax, ay, r2);
    // The authored +Y entrance extends beyond the shaft in both models. Keep
    // its upward-facing floor and adjoining landing even when the walls are
    // hidden. The Citadel ramp spans y=39..163, z=0..5; the Kiln passage
    // descends into the mountain. The roof and tunnel ceiling are separate
    // faces. Keep whole triangles at the edges of the measured footprint.
    if (floorMin && ab + bc + ca > 0
        && Math.min(ax, bx, cx) <= floorMax[0] && Math.max(ax, bx, cx) >= floorMin[0]
        && Math.min(ay, by, cy) <= floorMax[1] && Math.max(ay, by, cy) >= floorMin[1]) {
      const az = pos.getZ(a), bz = pos.getZ(b), cz = pos.getZ(c);
      if (Math.min(az, bz, cz) >= floorMin[2] && Math.max(az, bz, cz) <= floorMax[2]) {
        passage.push(a, b, c);
        continue;
      }
    }
    const lining = keep || (kilnOuterSkin && kilnTunnelLining(pos, a, b, c));
    (lining ? inside : outside).push(a, b, c);
  }
  function subset(indices) {
    if (indices.length === index.count) return geometry;
    const result = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) result.setAttribute(name, attribute);
    result.setIndex(indices);
    result.boundingBox = indexedBounds(result);
    return result;
  }
  const parts = [];
  if (inside.length) parts.push({ geometry: subset(inside), core: true });
  if (outside.length) parts.push({ geometry: subset(outside), exterior: true });
  if (passage.length) parts.push({ geometry: subset(passage), core: true, passage: true });
  return parts;
}

// Keep the synchronous entry for offline geometry audits. The browser drains
// the same builder cooperatively, without dropping triangles or instances.
function batchStaticMeshes(...args) {
  const work = buildStaticMeshes(...args);
  for (;;) { const next = work.next(); if (next.done) return next.value; }
}

async function batchStaticMeshesAsync(scene, build, shadowOnly, associations, context, signal) {
  const work = buildStaticMeshes(scene, build, shadowOnly, associations, context);
  let deadline = performance.now() + 8;
  try {
    for (;;) {
      checkGeometryAbort(signal);
      const next = work.next();
      if (next.done) return next.value;
      if (performance.now() >= deadline) {
        await yieldGeometryTask(signal);
        deadline = performance.now() + 8;
      }
    }
  } finally { work.return(); }
}

/** Keep every visible source triangle; share repeated rocks/trees and preserve full
 * matrixWorld, including shear that glTF's TRS instancing cannot represent. */
function* buildStaticMeshes(scene, gameBuildId, shadowOnlyNodes = new Set(), associations = new Map(), context = {}) {
  scene.updateMatrixWorld(true);
  const batches = new Map();
  const instance = new THREE.Matrix4();
  const prepared = new Set();
  const facadePartitions = new Map(), coreMaterials = new Map();
  const sectionMaterials = new Map();
  const boundsCache = new Map(), groupBoundsCache = new Map(), preciseBoundsCache = new Map();
  const cachedBounds = (geometry, grouped = false, precise = false) => {
    const cache = grouped ? groupBoundsCache : precise ? preciseBoundsCache : boundsCache;
    if (!cache.has(geometry)) {
      const count = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
      const existing = geometry.boundingBox;
      // GLTFLoader normally supplies conservative accessor min/max bounds.
      // Reuse them for a full primitive rather than adding a new index scan.
      const reusable = !grouped && !precise && geometry.drawRange.start === 0
        && geometry.drawRange.count >= count && existing && !existing.isEmpty()
        && [...existing.min.toArray(), ...existing.max.toArray()].every(Number.isFinite);
      cache.set(geometry, reusable ? existing : indexedBounds(geometry, grouped));
    }
    return cache.get(geometry);
  };
  let omittedProjectionInstances = 0;
  let omittedShadowOnlyInstances = 0;
  const objects = [];
  scene.traverse(object => { if (object.isMesh && !object.isSkinnedMesh) objects.push(object); });
  objects: for (const object of objects) {
    if (!object.isMesh || object.isSkinnedMesh) continue objects;
    // Multi-primitive glTF nodes can own child meshes. Resolve their associated
    // node before batching; hidden panels must not affect camera/trail raycasts.
    let nodeIndex;
    for (let owner = object; owner && owner !== scene; owner = owner.parent) {
      const node = associations.get(owner)?.nodes;
      if (Number.isInteger(node)) nodeIndex ??= node;
      if (shadowOnlyNodes.has(node)) {
        omittedShadowOnlyInstances += object.isInstancedMesh ? object.count : 1;
        continue objects;
      }
    }
    if (context.campOnly && !context.campfire?.includesNode(nodeIndex)) continue;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const proxyMaterials = materials.map((material) => isProjectionProxyMaterial(gameBuildId, material));
    let geometry = object.geometry;
    if (proxyMaterials.every(Boolean)) {
      // A Unity depth-projection volume rendered as an opaque glTF surface
      // becomes a huge false ball. Keep the separate original crystal/prop.
      omittedProjectionInstances += object.isInstancedMesh ? object.count : 1;
      continue objects;
    }
    if (proxyMaterials.some(Boolean)) {
      // GLTFLoader normally splits primitives. Preserve unrelated material
      // groups if a caller supplies a combined mesh, including for raycasts.
      const groups = geometry.groups.filter((group) => !proxyMaterials[group.materialIndex]);
      if (!groups.length) continue objects;
      geometry = geometry.clone(); geometry.clearGroups();
      for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    }
    const mine = materials.length > 0 && materials.every((material) => {
      const source = material.userData?.peakTerrain;
      return isExplosiveMineMaterial(gameBuildId, source?.sourceMaterial || material.name, source?.sourceColors?.shader);
    });
    const mineBounds = mine ? cachedBounds(geometry, Array.isArray(object.material), true) : null;
    for (const material of materials) {
      if (!prepared.has(material)) {
        applySourceCutoutMaterial(material, gameBuildId);
        if (!applySourceEffectMaterial(material, gameBuildId)) applyTerrainMaterial(material);
        useExactInstanceNormals(material);
        prepared.add(material);
      }
    }
    let parts = [{ geometry }];
    if (context.facade?.nodes.has(nodeIndex) && !Array.isArray(object.material)) {
      if (!facadePartitions.has(geometry)) facadePartitions.set(geometry, partitionFacade(geometry, context.facade));
      parts = facadePartitions.get(geometry);
    }
    // The shaft's wall faces point into the shaft. Use the source's Cull Back
    // on those faces so the observer sees the far wall and climbing surfaces.
    // Its same-material exterior, stairs and other props keep their own draws.
    let coreMaterial = object.material;
    if (parts.some(part => part.core) && coreMaterial.userData?.peakTerrain?.sourceColors?.cull === 2
        && coreMaterial.side !== THREE.FrontSide) {
      if (!coreMaterials.has(coreMaterial)) {
        const clone = coreMaterial.clone();
        clone.onBeforeCompile = coreMaterial.onBeforeCompile;
        clone.customProgramCacheKey = coreMaterial.customProgramCacheKey;
        clone.side = THREE.FrontSide;
        coreMaterials.set(coreMaterial, clone);
      }
      coreMaterial = coreMaterials.get(coreMaterial);
    }
    let drawMaterial = object.material, sectionCoreMaterial = coreMaterial;
    const sourceMesh = context.sectionMeshNames?.[nodeIndex];
    if (sourceMesh) {
      const adapt = material => sectionMaterial(material, sourceMesh, context.facade?.nodes.has(nodeIndex) === true,
        context.sectionPlane, sectionMaterials);
      drawMaterial = Array.isArray(drawMaterial) ? drawMaterial.map(adapt) : adapt(drawMaterial);
      sectionCoreMaterial = coreMaterial === object.material ? drawMaterial : adapt(coreMaterial);
    }
    const addMatrix = (worldMatrix, instanceIndex) => {
      const campfire = context.campfire?.matches(nodeIndex, instanceIndex) === true;
      if (context.campOnly && !campfire) return;
      const transform = positiveInstanceTransform(worldMatrix.elements);
      for (const part of parts) {
        const material = part.passage ? coreMaterial : part.core ? sectionCoreMaterial : drawMaterial;
        const materialKey = Array.isArray(material) ? material.map(item => item.uuid).join(":") : material.uuid;
        const key = `${part.geometry.uuid}:${materialKey}:${transform.reflected}:${campfire}:${part.exterior === true}`;
        if (!batches.has(key)) batches.set(key, { geometry: part.geometry, material, exterior: part.exterior,
          reflected: transform.reflected, campfire, matrices: [], mines: [] });
        const batch = batches.get(key);
        batch.matrices.push(new THREE.Matrix4().fromArray(transform.matrix));
        if (mineBounds) {
          // Record original Unity-world bounds BEFORE reflection factoring and
          // before scene.js subtracts its display origin from the loaded root.
          const bounds = mineBounds.clone().applyMatrix4(worldMatrix);
          batch.mines.push({ index: batch.matrices.length - 1, center: bounds.getCenter(new THREE.Vector3()).toArray(),
            min: bounds.min.toArray(), max: bounds.max.toArray() });
        }
      }
    };
    if (object.isInstancedMesh) {
      for (let index = 0; index < object.count; index++) {
        object.getMatrixAt(index, instance);
        addMatrix(new THREE.Matrix4().multiplyMatrices(object.matrixWorld, instance), index);
        if ((index & 127) === 127) yield;
      }
    } else addMatrix(object.matrixWorld, 0);
    yield;
  }
  const root = new THREE.Group();
  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
    if (batch.campfire) mesh.userData.nativeCampfire = true;
    if (batch.exterior) {
      mesh.userData.exteriorFacade = true;
      if (context.facade?.kilnOuterSkin) mesh.userData.kilnOuterSkin = true;
    }
    mesh.scale.x = batch.reflected ? -1 : 1;
    batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    if (batch.mines.length) mesh.userData.peakRecordedMines = batch.mines.map((mine) => ({
      ...mine, originalMatrix: batch.matrices[mine.index].clone(), hidden: false,
    }));
    mesh.instanceMatrix.needsUpdate = true;
    setInstanceBounds(mesh, cachedBounds(batch.geometry, Array.isArray(batch.material)));
    root.add(mesh);
    yield;
  }
  root.userData.drawBatches = batches.size;
  root.userData.omittedProjectionInstances = omittedProjectionInstances;
  root.userData.omittedShadowOnlyInstances = omittedShadowOnlyInstances;
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
        && supportsSourceEffect(effect.source.mapBuildId ?? effect.source.buildId, effect.source.material, effect.source.shader);
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

export async function loadGameGeometry(layer, signal, gameBuildId, context = {}) {
  if (!GEOMETRY_FORMATS.includes(layer.geometryFormat) || !layer.geometryUrl
      || !/^[a-f0-9]{64}$/i.test(layer.geometrySha256 || "")) throw new Error("此关缺少已校验的真实模型引用");
  let lastProgressStage, lastProgressTime = -Infinity;
  const progress = event => {
    const now = performance.now();
    if (event.stage !== lastProgressStage || now - lastProgressTime >= 100
        || (event.totalBytes !== undefined && event.loadedBytes === event.totalBytes)) {
      lastProgressStage = event.stage; lastProgressTime = now;
      context.onProgress?.(event);
    }
  };
  checkGeometryAbort(signal);
  reportGeometryProgress(progress, "download", 0);
  const response = await fetch(layer.geometryUrl, { signal, cache: "force-cache" });
  if (!response.ok) throw new Error(`真实模型读取失败（${response.status}）`);
  let bytes = await readGeometryResponse(response, signal, progress);
  reportGeometryProgress(progress, "hash", bytes.byteLength, bytes.byteLength);
  await yieldGeometryTask(signal);
  const digest = await sha256Hex(new Uint8Array(bytes), crypto?.subtle);
  checkGeometryAbort(signal);
  if (digest !== layer.geometrySha256.toLowerCase()) throw new Error("真实模型内容哈希不匹配，已拒绝显示");
  reportGeometryProgress(progress, "decompress");
  await yieldGeometryTask(signal);
  bytes = await decodeGeometryBytes(bytes, layer.geometryFormat, signal, progress);
  assertEmbeddedGlb(bytes);
  reportGeometryProgress(progress, "parse", bytes.byteLength, bytes.byteLength);
  await yieldGeometryTask(signal);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  if (context.campOnly) {
    // The signed chapter GLBs store independently placed nodes as scene
    // roots. Keep original node indices for loader associations. A nested
    // root is left intact and its individual draws are filtered in batching.
    loader.register(parser => ({
      name: "PeakNativeCampfire",
      beforeRoot() {
        for (const scene of parser.json.scenes) {
          scene.nodes = (scene.nodes || []).filter(index =>
            parser.json.nodes[index]?.children?.length || context.campfire.includesNode(index));
        }
      },
    }));
  }
  const gltf = await loader.parseAsync(bytes, "");
  checkGeometryAbort(signal);
  reportGeometryProgress(progress, "batch");
  await yieldGeometryTask(signal);
  preserveAffineMatrices(gltf);
  const document = gltf.parser.json, facade = sourceFacade(layer, gameBuildId, document);
  const terminalSection = context.sectionPlane && !context.campOnly && auditedFinaleBuilds.has(String(gameBuildId))
    && layer.segment === 4 && (facade || (layer === context.chapterLayer && isInteriorLayer(layer, context.route)));
  const sectionMeshNames = terminalSection ? document.nodes?.map(node => document.meshes?.[node.mesh]?.name) : null;
  const root = await batchStaticMeshesAsync(gltf.scene, gameBuildId,
    shadowOnlyNodeIndices(gameBuildId, digest), gltf.parser.associations,
    { ...context, geometryLayer: layer, facade, sectionMeshNames }, signal);
  reportGeometryProgress(progress, "ready");
  return root;
}
