import { cutsSectionPoint } from "./section-plane.js";
import { cutsSectionModule } from "./section-module.js";

// Camera-only queries against the same static triangles the map renders. Bounds
// prune the search; they are never returned as a substitute collision surface.
// Per-batch visibility wrappers share immutable triangle buffers. Weak keys
// share their BVH too, without retaining unloaded geometry or modifying it.
const positionTrees = new WeakMap();
const LEAF_SIZE = 8;
const FRONT_SIDE = 0, DOUBLE_SIDE = 2;
// Source shader evidence, not a name/biome guess. The recorded shore route
// passes through GD/FoliageGD leaves at centimetre distances; treating these
// decorative surfaces as hard mountain walls traps the spectator at its torso.
// This policy affects camera queries only, never the rendered vegetation.
const SOFT_FOLIAGE_SHADERS = new Set(["GD/FoliageGD"]);

function emptyBounds() { return [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; }
function grow(bounds, source, offset = 0) {
  for (let axis = 0; axis < 3; axis++) {
    bounds[axis] = Math.min(bounds[axis], source[offset + axis]);
    bounds[axis + 3] = Math.max(bounds[axis + 3], source[offset + axis + 3]);
  }
}

// In-place median partition avoids repeated whole-array sorting/copying on
// large shared static-batch meshes. Centroid ties are ordered by primitive ID.
function partitionMedian(ids, first, last, middle, bounds, axis) {
  const compare = (a, b) => (bounds[a * 6 + axis] + bounds[a * 6 + axis + 3])
    - (bounds[b * 6 + axis] + bounds[b * 6 + axis + 3]) || a - b;
  let left = first, right = last - 1;
  while (left < right) {
    const pivot = ids[(left + right) >>> 1];
    let i = left, j = right;
    while (i <= j) {
      while (compare(ids[i], pivot) < 0) i++;
      while (compare(ids[j], pivot) > 0) j--;
      if (i <= j) { const temp = ids[i]; ids[i++] = ids[j]; ids[j--] = temp; }
    }
    if (middle <= j) right = j;
    else if (middle >= i) left = i;
    else return;
  }
}

function buildTree(ids, bounds, start = 0, end = ids.length) {
  if (end <= start) return null;
  const node = { bounds: emptyBounds(), start, end, left: null, right: null };
  for (let i = start; i < end; i++) grow(node.bounds, bounds, ids[i] * 6);
  if (end - start <= LEAF_SIZE) return node;
  let axis = 0;
  for (let a = 1; a < 3; a++) {
    if (node.bounds[a + 3] - node.bounds[a] > node.bounds[axis + 3] - node.bounds[axis]) axis = a;
  }
  const middle = (start + end) >>> 1;
  partitionMedian(ids, start, end, middle, bounds, axis);
  node.left = buildTree(ids, bounds, start, middle);
  node.right = buildTree(ids, bounds, middle, end);
  return node;
}

// Returns the ray's entry distance, not a hit. Zero components and rays starting
// within a box need explicit treatment to avoid 0 * Infinity / NaN at edges.
function boxEntry(bounds, origin, direction, limit) {
  let near = 0, far = limit;
  for (let axis = 0; axis < 3; axis++) {
    const p = origin.getComponent(axis), d = direction.getComponent(axis);
    if (d === 0) {
      if (p < bounds[axis] || p > bounds[axis + 3]) return Infinity;
    } else {
      const a = (bounds[axis] - p) / d, b = (bounds[axis + 3] - p) / d;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far) return Infinity;
    }
  }
  return near;
}

function attributeVersion(attribute) {
  return attribute?.isInterleavedBufferAttribute ? attribute.data.version : attribute?.version;
}

function triangleTree(geometry) {
  const position = geometry.getAttribute("position"), index = geometry.getIndex();
  if (!position || position.itemSize < 3) return null;
  let byIndex = positionTrees.get(position);
  if (!byIndex) { byIndex = new WeakMap(); positionTrees.set(position, byIndex); }
  const key = index ?? position;
  const previous = byIndex.get(key);
  if (previous?.position === position && previous.index === index
      && previous.positionVersion === attributeVersion(position)
      && previous.indexVersion === attributeVersion(index)) return previous;
  const count = Math.floor((index?.count ?? position.count) / 3);
  const ids = new Uint32Array(count), bounds = new Float64Array(count * 6);
  let valid = 0;
  for (let triangle = 0; triangle < count; triangle++) {
    const offset = triangle * 6;
    for (let a = 0; a < 3; a++) { bounds[offset + a] = Infinity; bounds[offset + a + 3] = -Infinity; }
    for (let corner = 0; corner < 3; corner++) {
      const vertex = index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
      for (let a = 0; a < 3; a++) {
        const value = position.getComponent(vertex, a);
        bounds[offset + a] = Math.min(bounds[offset + a], value);
        bounds[offset + a + 3] = Math.max(bounds[offset + a + 3], value);
      }
    }
    if (bounds.subarray(offset, offset + 6).every(Number.isFinite)) ids[valid++] = triangle;
  }
  const tree = { position, index, positionVersion: attributeVersion(position), indexVersion: attributeVersion(index),
    ids: ids.subarray(0, valid), bounds };
  tree.root = buildTree(tree.ids, bounds);
  byIndex.set(key, tree);
  return tree;
}

function solidMaterial(material, ignoreSectionMaterials, frontFacing) {
  if (!material || material.visible === false || material.opacity === 0) return false;
  if (ignoreSectionMaterials && material.userData?.peakSectionPlane && material.userData?.peakSectionMode !== "module") return false;
  if (frontFacing !== undefined) {
    // Match the materials eligible for the GPU fade and Three's side culling.
    // Foliage may cover the fixed camera even though it is not a hard wall.
    return (material.isMeshStandardMaterial || material.isMeshBasicMaterial)
      && material.depthWrite && !material.userData?.peakSourceEffect
      && (material.side === DOUBLE_SIDE || (material.side === FRONT_SIDE) === frontFacing);
  }
  const sourceShader = material.userData?.peakTerrain?.sourceColors?.shader;
  if (SOFT_FOLIAGE_SHADERS.has(sourceShader)) return false;
  const effect = material.userData?.peakSourceEffect;
  if (["water", "fog"].includes(effect?.kind)) return false;
  // Additive particles, non-depth-writing translucent surfaces and source
  // effect placeholders must not become a solid camera wall.
  return !(material.transparent && (material.depthWrite === false || material.opacity < 0.98));
}

function visibleMesh(mesh) {
  for (let node = mesh; node; node = node.parent) if (node.visible === false) return false;
  return true;
}

function triangleIsSolid(mesh, offset, ignoreSectionMaterials = false, frontFacing) {
  const geometry = mesh.geometry, { start, count } = geometry.drawRange;
  if (offset < start || offset + 2 >= start + count) return false;
  if (!Array.isArray(mesh.material)) return solidMaterial(mesh.material, ignoreSectionMaterials, frontFacing);
  return geometry.groups.some((group) => offset >= group.start && offset + 2 < group.start + group.count
    && solidMaterial(mesh.material[group.materialIndex], ignoreSectionMaterials, frontFacing));
}

/**
 * setRoots after chapter load/unload, origin/height transform or geometry edits.
 * Object/ancestor visibility and material visibility are read on every cast.
 * Three's instanceMatrix.needsUpdate also refreshes the world index lazily, so
 * hiding a mine by a zero-scale instance and restoring it on rewind both work.
 * Results are renderer-world metres, normally two-sided, with normals facing
 * the ray. renderedFacesOnly respects material culling for the camera fade.
 * This is map visibility evidence, not recorded player collision/climb normals.
 * Source GD/FoliageGD leaves are soft decoration, not hard camera blockers.
 * Callers using this same query for framing will also ignore those leaves;
 * no separate soft-occlusion buffer is currently provided.
 */
export class FollowTerrainQuery {
  constructor(THREE) {
    this.THREE = THREE;
    this.roots = [];
    this.entries = [];
    this.instances = [];
    this.tree = null;
    this.ids = new Uint32Array();
    this.ray = new THREE.Ray();
    this.localRay = new THREE.Ray();
    this.a = new THREE.Vector3(); this.b = new THREE.Vector3(); this.c = new THREE.Vector3();
    this.localPoint = new THREE.Vector3(); this.localNormal = new THREE.Vector3();
    this.edge = new THREE.Vector3(); this.directionEnd = new THREE.Vector3();
    this.stats = { instances: 0, geometries: 0 };
    this.lastStats = { worldNodes: 0, instances: 0, triangleNodes: 0, triangles: 0 };
  }

  setRoots(roots = []) {
    this.roots = [...roots].filter(Boolean);
    this.entries = [];
    this.instances = [];
    const THREE = this.THREE, seen = new Set(), geometries = new Set();
    const instance = new THREE.Matrix4(), box = new THREE.Box3();
    for (const root of this.roots) {
      root.updateWorldMatrix(true, true);
      root.traverse((mesh) => {
        if (!mesh.isMesh || mesh.isSkinnedMesh || seen.has(mesh)) return;
        seen.add(mesh);
        // Include currently hidden meshes: later visibility changes need no
        // rebuild. The same applies to a material's visible flag.
        const geometry = triangleTree(mesh.geometry);
        if (!geometry?.root) return;
        geometries.add(geometry);
        if (mesh.isInstancedMesh) this.instances.push({ mesh, version: mesh.instanceMatrix.version, count: mesh.count });
        const count = mesh.isInstancedMesh ? mesh.count : 1;
        for (let index = 0; index < count; index++) {
          const matrix = mesh.matrixWorld.clone();
          if (mesh.isInstancedMesh) { mesh.getMatrixAt(index, instance); matrix.multiply(instance); }
          const determinant = matrix.determinant();
          if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-18) continue;
          const localBounds = geometry.root.bounds;
          box.min.fromArray(localBounds, 0); box.max.fromArray(localBounds, 3); box.applyMatrix4(matrix);
          this.entries.push({ mesh, instanceId: mesh.isInstancedMesh ? index : null, geometry, matrix,
            inverse: matrix.clone().invert(), normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix),
            bounds: [...box.min.toArray(), ...box.max.toArray()] });
        }
      });
    }
    const bounds = new Float64Array(this.entries.length * 6);
    this.ids = new Uint32Array(this.entries.length);
    this.entries.forEach((entry, index) => { this.ids[index] = index; bounds.set(entry.bounds, index * 6); });
    this.tree = buildTree(this.ids, bounds);
    this.stats = { instances: this.entries.length, geometries: geometries.size };
    return this;
  }

  cast(origin, direction, maxDistance, sectionPlane, options) {
    return this.castHits(origin, direction, maxDistance, sectionPlane, options, false);
  }

  // One nearest valid surface per output mesh/instance, ordered from the eye.
  // Rendering-only occlusion masks do not change this geometry evidence: a
  // hidden foreground module must remain detectable on the following frame.
  castAll(origin, direction, maxDistance, sectionPlane, options) {
    return this.castHits(origin, direction, maxDistance, sectionPlane, options, true);
  }

  castHits(origin, direction, maxDistance, sectionPlane,
    { renderedFacesOnly = false, minimumDistance = 0 } = {}, collectAll = false) {
    const hits = collectAll ? [] : null;
    this.lastStats = { worldNodes: 0, instances: 0, triangleNodes: 0, triangles: 0 };
    if (!Number.isFinite(maxDistance) || maxDistance < 0 || !origin || !direction
        || ![origin.x, origin.y, origin.z, direction.x, direction.y, direction.z].every(Number.isFinite)
        || direction.lengthSq() < 1e-20) return hits;
    if (this.instances.some(({ mesh, version, count }) => mesh.instanceMatrix.version !== version || mesh.count !== count)) {
      this.setRoots(this.roots);
    }
    if (!this.tree) return hits;
    this.ray.origin.copy(origin); this.ray.direction.copy(direction).normalize();
    let bestDistance = maxDistance, best = null;
    const stack = [this.tree];
    while (stack.length) {
      const node = stack.pop(); this.lastStats.worldNodes++;
      if (boxEntry(node.bounds, this.ray.origin, this.ray.direction, bestDistance) === Infinity) continue;
      if (node.left) {
        this.pushNearest(stack, node, this.ray, bestDistance);
        continue;
      }
      for (let index = node.start; index < node.end; index++) {
        const entry = this.entries[this.ids[index]];
        if (!visibleMesh(entry.mesh)
            || (renderedFacesOnly && entry.mesh.userData.followOcclusionProtected === true)
            || boxEntry(entry.bounds, this.ray.origin, this.ray.direction, bestDistance) === Infinity) continue;
        this.lastStats.instances++;
        const hit = this.castInstance(entry, bestDistance, sectionPlane, renderedFacesOnly, minimumDistance);
        if (hit && hit.distance <= bestDistance) {
          if (collectAll) hits.push(hit);
          else { best = hit; bestDistance = hit.distance; }
        }
      }
    }
    return collectAll ? hits.sort((a, b) => a.distance - b.distance) : best;
  }

  pushNearest(stack, node, ray, limit) {
    const a = boxEntry(node.left.bounds, ray.origin, ray.direction, limit);
    const b = boxEntry(node.right.bounds, ray.origin, ray.direction, limit);
    if (a < b) {
      if (b !== Infinity) stack.push(node.right);
      if (a !== Infinity) stack.push(node.left);
    } else {
      if (a !== Infinity) stack.push(node.left);
      if (b !== Infinity) stack.push(node.right);
    }
  }

  castInstance(entry, maxDistance, sectionPlane, renderedFacesOnly, minimumDistance) {
    if (cutsSectionModule(sectionPlane, entry.mesh, entry.instanceId)) return null;
    const local = this.localRay;
    local.origin.copy(this.ray.origin).applyMatrix4(entry.inverse);
    // Keep the world->local distance conversion, not just a normalized vector:
    // arbitrary affine scales/shear otherwise produce false near/far clipping.
    this.directionEnd.copy(this.ray.origin).add(this.ray.direction).applyMatrix4(entry.inverse);
    local.direction.copy(this.directionEnd).sub(local.origin);
    const localPerWorld = local.direction.length();
    if (!Number.isFinite(localPerWorld) || localPerWorld <= 0) return null;
    local.direction.divideScalar(localPerWorld);
    const localMinimum = minimumDistance * localPerWorld;
    let limit = maxDistance * localPerWorld, best = null;
    const { geometry, mesh } = entry, stack = [geometry.root];
    while (stack.length) {
      const node = stack.pop(); this.lastStats.triangleNodes++;
      if (boxEntry(node.bounds, local.origin, local.direction, limit) === Infinity) continue;
      if (node.left) { this.pushNearest(stack, node, local, limit); continue; }
      for (let index = node.start; index < node.end; index++) {
        const offset = geometry.ids[index] * 3;
        if (!renderedFacesOnly && !triangleIsSolid(mesh, offset)) continue;
        this.lastStats.triangles++;
        this.a.fromBufferAttribute(geometry.position, geometry.index ? geometry.index.getX(offset) : offset);
        this.b.fromBufferAttribute(geometry.position, geometry.index ? geometry.index.getX(offset + 1) : offset + 1);
        this.c.fromBufferAttribute(geometry.position, geometry.index ? geometry.index.getX(offset + 2) : offset + 2);
        if (!local.intersectTriangle(this.a, this.b, this.c, false, this.localPoint)) continue;
        const distance = this.localPoint.distanceTo(local.origin);
        if (distance > limit || distance < localMinimum) continue;
        this.localNormal.subVectors(this.b, this.a).cross(this.edge.subVectors(this.c, this.a));
        if (this.localNormal.lengthSq() < 1e-24) continue;
        const frontFacing = renderedFacesOnly ? this.localNormal.dot(local.direction) <= 0 : undefined;
        if (renderedFacesOnly && !triangleIsSolid(mesh, offset, false, frontFacing)) continue;
        this.localNormal.applyMatrix3(entry.normalMatrix).normalize();
        if (this.localNormal.dot(this.ray.direction) > 0) this.localNormal.negate();
        const point = this.localPoint.clone().applyMatrix4(entry.matrix);
        // Keep testing the next solid hit after a cut, including other
        // material slots and contact surfaces from the same original mesh.
        if (sectionPlane?.value.w && !triangleIsSolid(mesh, offset, true, frontFacing)
            && cutsSectionPoint(sectionPlane, point, this.localNormal)) continue;
        // Use the world point to remove accumulated inverse-transform error.
        const worldDistance = point.distanceTo(this.ray.origin);
        if (worldDistance > maxDistance + 1e-9) continue;
        best = { distance: worldDistance, point, normal: this.localNormal.clone(), mesh, instanceId: entry.instanceId };
        limit = distance;
      }
    }
    return best;
  }

  dispose() { this.roots = []; this.entries = []; this.instances = []; this.tree = null; this.ids = new Uint32Array(); }
}
