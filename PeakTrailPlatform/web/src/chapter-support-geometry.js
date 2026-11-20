// A bounded copy of real previous-chapter surfaces near recorded players.
// Output coordinates are renderer-world coordinates: mount root on the Scene,
// outside worldRoot, and clear it if origin/heightScale/map identity changes.
// No old Object3D, BufferGeometry or material is retained after capture returns.
import { FollowTerrainQuery } from './follow-terrain.js';
import { applyTerrainMaterial } from './terrain-material.js';

const DEFAULTS = Object.freeze({ radius: 12, below: 8, above: 2, lifetimeMs: 0,
  maxPlayers: 4, maxTriangles: 6000, maxMaterials: 12, maxTextureBytes: 16 * 1024 * 1024,
  maxCandidates: 2048, maxExaminedTriangles: 300000 });

function solid(material) {
  if (!material || material.visible === false || material.opacity === 0 || material.isShaderMaterial) return false;
  if (material.userData?.peakTerrain?.sourceColors?.shader === 'GD/FoliageGD') return false;
  if (['water', 'fog'].includes(material.userData?.peakSourceEffect?.kind)) return false;
  return !(material.transparent && (material.depthWrite === false || material.opacity < .98));
}

function point(THREE, value) {
  const values = value?.isVector3 ? value.toArray() : value;
  return Array.isArray(values) && values.length === 3 && values.every(Number.isFinite)
    ? new THREE.Vector3().fromArray(values) : null;
}

function clip(vertices, box) {
  let polygon = vertices;
  for (let axis = 0; axis < 3 && polygon.length; axis++) for (const sign of [1, -1]) {
    const bound = sign === 1 ? box.min.getComponent(axis) : box.max.getComponent(axis), next = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const da = sign * (a[axis] - bound), db = sign * (b[axis] - bound);
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        next.push(a.map((value, k) => value + (b[k] - value) * t));
      }
    }
    polygon = next;
  }
  return polygon;
}

function clipPlanes(vertices, planes) {
  let polygon = vertices;
  for (const plane of planes) {
    const next = [], distance = value => plane[0] * value[0] + plane[1] * value[1] + plane[2] * value[2] + plane[3];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], da = distance(a), db = distance(b);
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        next.push(a.map((value, k) => value + (b[k] - value) * t));
      }
    }
    polygon = next;
    if (!polygon.length) break;
  }
  return polygon;
}

// Fixed-size max heap: bounded temporary memory even for dense static batches.
function retainClosest(heap, entry, limit) {
  if (heap.length < limit) {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (heap[parent].distance >= heap[i].distance) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]]; i = parent;
    }
    return;
  }
  heap[0] = entry;
  for (let i = 0;;) {
    const left = i * 2 + 1, right = left + 1;
    if (left >= heap.length) break;
    const child = right < heap.length && heap[right].distance > heap[left].distance ? right : left;
    if (heap[i].distance >= heap[child].distance) break;
    [heap[i], heap[child]] = [heap[child], heap[i]]; i = child;
  }
}

function supportDistance([a, b, c], point, maxDrop) {
  const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
  const cx = c.x - a.x, cy = c.y - a.y, cz = c.z - a.z;
  const denominator = bx * cz - cx * bz;
  if (Math.abs(denominator) < 1e-12) return Infinity;
  const u = ((point.x - a.x) * cz - cx * (point.z - a.z)) / denominator;
  const v = (bx * (point.z - a.z) - (point.x - a.x) * bz) / denominator;
  if (u < 0 || v < 0 || u + v > 1) return Infinity;
  const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
  if (Math.abs(ny) < .25 * Math.hypot(nx, ny, nz)) return Infinity;
  const drop = point.y - (a.y + u * by + v * cy);
  return drop >= -.1 && drop <= maxDrop ? Math.max(0, drop) : Infinity;
}

function ranges(mesh) {
  const geometry = mesh.geometry, total = geometry.index?.count ?? geometry.attributes.position.count;
  const start = Math.max(0, geometry.drawRange.start), end = Math.min(total, start + geometry.drawRange.count);
  const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count: total, materialIndex: 0 }];
  return groups.map(group => ({ start: Math.max(start, group.start), end: Math.min(end, group.start + group.count),
    material: Array.isArray(mesh.material) ? mesh.material[group.materialIndex] : mesh.material }))
    .filter(range => solid(range.material) && range.end - range.start >= 3);
}

/** Capture synchronously before disposing the old chapter. positions and now
 * passed to update use the same renderer-world/monotonic clock as capture.
 * hasCurrentGround means every relevant player now has real new-chapter ground;
 * a merely downloaded chapter is insufficient. This root is display context,
 * not evidence for deciding whether the new chapter itself contains ground. */
export class ChapterSupportGeometry {
  constructor(THREE, options = {}) {
    this.THREE = THREE;
    this.options = { ...DEFAULTS, ...options };
    for (const key of Object.keys(DEFAULTS)) {
      if (!Number.isFinite(this.options[key]) || (key === 'lifetimeMs' ? this.options[key] < 0 : this.options[key] <= 0)) this.options[key] = DEFAULTS[key];
    }
    this.root = new THREE.Group();
    this.root.name = 'Nearby previous chapter surfaces';
    this.root.userData.chapterSupport = true;
    this.root.visible = false;
    this.materials = new Set(); this.textures = new Set();
    this.anchors = []; this.boxes = []; this.supportQuery = null;
    this.stats = {}; this.sourceGrounded = []; this.expiresAt = 0; this.disposed = false;
  }

  capture({ roots = [], positions = [], now = performance.now(), verticalScale = 1 } = {}) {
    this.clear();
    if (this.disposed || !Number.isFinite(now)) return false;
    const THREE = this.THREE, config = this.options;
    const yScale = Number.isFinite(verticalScale) && verticalScale > 0 ? verticalScale : 1;
    const parsed = positions.map(value => point(THREE, value));
    this.anchors = parsed.filter(Boolean).slice(0, config.maxPlayers);
    if (!this.anchors.length) return false;
    const regions = [];
    for (const anchor of this.anchors) {
      const nearby = regions.find(region => region.center.distanceToSquared(anchor) <= 9);
      const box = new THREE.Box3(
        anchor.clone().add(new THREE.Vector3(-config.radius, -config.below * yScale, -config.radius)),
        anchor.clone().add(new THREE.Vector3(config.radius, config.above * yScale, config.radius)));
      if (nearby) nearby.box.union(box);
      else regions.push({ center: anchor.clone(), box });
    }
    this.boxes = regions.map(region => region.box);
    // Separated players receive independent budgets. Voronoi clipping avoids
    // duplicate coplanar surfaces where their neighborhoods overlap.
    for (const region of regions) region.planes = regions.filter(other => other !== region).map(other => {
      const normal = region.center.clone().sub(other.center);
      return [...normal.toArray(), -(region.center.lengthSq() - other.center.lengthSq()) / 2];
    });
    this.stats = { triangles: 0, examinedTriangles: 0, candidates: 0, textureBytes: 0, materials: 0, limited: false };
    const candidates = [], bounds = new WeakMap(), seen = new Set(), instance = new THREE.Matrix4();
    for (const root of roots.filter(Boolean)) {
      root.updateWorldMatrix(true, true);
      root.traverse(mesh => {
        if (!mesh.isMesh || mesh.isSkinnedMesh || seen.has(mesh) || !mesh.geometry?.attributes.position) return;
        seen.add(mesh);
        // The caller can capture a just-deselected chapter group; hidden source
        // children (for example a spent mine) still stay hidden.
        for (let owner = mesh; owner && owner !== root; owner = owner.parent) if (!owner.visible) return;
        const selectedRanges = ranges(mesh);
        if (!selectedRanges.length) return;
        const geometry = mesh.geometry;
        if (!bounds.has(geometry)) bounds.set(geometry, geometry.boundingBox?.clone()
          ?? new THREE.Box3().setFromBufferAttribute(geometry.attributes.position));
        const local = bounds.get(geometry), count = mesh.isInstancedMesh ? mesh.count : 1;
        for (let index = 0; index < count; index++) {
          const matrix = mesh.matrixWorld.clone();
          if (mesh.isInstancedMesh) { mesh.getMatrixAt(index, instance); matrix.multiply(instance); }
          const determinant = matrix.determinant();
          if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-18) continue;
          const world = local.clone().applyMatrix4(matrix);
          if (!this.boxes.some(box => box.intersectsBox(world))) continue;
          if (candidates.length >= config.maxCandidates) { this.stats.limited = true; break; }
          candidates.push({ mesh, matrix, world, ranges: selectedRanges, reflected: determinant < 0,
            distance: Math.min(...this.anchors.map(anchor => world.distanceToPoint(anchor))) });
        }
      });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    this.stats.candidates = candidates.length;
    const batches = new Map(), clonedMaterials = new Map(), clonedTextures = new Map();
    const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const normal = new THREE.Vector3(), triangleBox = new THREE.Box3();
    this.stats.regions = regions.length;
    this.stats.regionTriangles = [];
    for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
      const region = regions[regionIndex], nearby = [];
      const triangleBudget = Math.floor(config.maxTriangles / regions.length) + (regionIndex < config.maxTriangles % regions.length ? 1 : 0);
      const materialBudget = Math.floor(config.maxMaterials / regions.length) + (regionIndex < config.maxMaterials % regions.length ? 1 : 0);
      const regionMaterials = new Set();
      const scanBudget = Math.floor(config.maxExaminedTriangles / regions.length);
      const pendingLimit = triangleBudget * 4 + 24;
      let examined = 0, emitted = 0;
      // First retain the nearest source triangles. Otherwise an early dense
      // mesh could consume the whole budget before the actual floor is visited.
      const ordered = candidates.filter(candidate => candidate.world.intersectsBox(region.box))
        .sort((a, b) => a.world.distanceToPoint(region.center) - b.world.distanceToPoint(region.center));
      scan: for (const candidate of ordered) {
        const { mesh, matrix } = candidate, geometry = mesh.geometry, index = geometry.index;
        const localBox = region.box.clone().applyMatrix4(matrix.clone().invert());
        for (const range of candidate.ranges) for (let offset = range.start; offset + 2 < range.end; offset += 3) {
          if (examined >= scanBudget) { this.stats.limited = true; break scan; }
          examined++; this.stats.examinedTriangles++;
          triangleBox.makeEmpty();
          // Reuse vectors and reject distant static-batch triangles before
          // allocating any vertex/UV/clipping arrays.
          for (let corner = 0; corner < 3; corner++) {
            corners[corner].fromBufferAttribute(geometry.attributes.position, index ? index.getX(offset + corner) : offset + corner);
            triangleBox.expandByPoint(corners[corner]);
          }
          if (!localBox.intersectsBox(triangleBox)) continue;
          triangleBox.makeEmpty();
          for (const corner of corners) triangleBox.expandByPoint(corner.applyMatrix4(matrix));
          if (!region.box.intersectsBox(triangleBox)) continue;
          // Entirely outside a player's nearest-center cell: it belongs to a
          // teammate's separate budget, even if the axis-aligned boxes overlap.
          if (region.planes.some(plane => corners.every(vertex => plane[0] * vertex.x + plane[1] * vertex.y + plane[2] * vertex.z + plane[3] < 0))) continue;
          const floorDistance = supportDistance(corners, region.center, 4 * yScale);
          // Reserve real foot contact before nearby walls/decoration can fill
          // a dense chapter's budget; the remaining patch is ordered by range.
          const distance = Number.isFinite(floorDistance) ? -2 + floorDistance / (4 * yScale + 1)
            : triangleBox.distanceToPoint(region.center);
          if (!Number.isFinite(distance)) continue;
          if (nearby.length >= pendingLimit && distance >= nearby[0].distance) { this.stats.limited = true; continue; }
          retainClosest(nearby, { candidate, range, offset, distance }, pendingLimit);
        }
      }
      nearby.sort((a, b) => a.distance - b.distance);
      for (const { candidate, range, offset } of nearby) {
        if (emitted >= triangleBudget) { this.stats.limited = true; break; }
        const { mesh, matrix } = candidate, geometry = mesh.geometry, index = geometry.index;
        candidate.normalMatrix ||= new THREE.Matrix3().getNormalMatrix(matrix);
        candidate.attributes ||= ['normal', 'uv', 'uv1', 'uv2', 'color'].filter(name => geometry.attributes[name])
          .map(name => ({ name, attribute: geometry.attributes[name], size: geometry.attributes[name].itemSize }));
        const attributes = candidate.attributes, stride = 3 + attributes.reduce((sum, attr) => sum + attr.size, 0);
        const vertices = [0, 1, 2].map(corner => {
          const vertexIndex = index ? index.getX(offset + corner) : offset + corner;
          corners[corner].fromBufferAttribute(geometry.attributes.position, vertexIndex).applyMatrix4(matrix);
          const values = corners[corner].toArray();
          for (const { name, attribute, size } of attributes) {
            if (name === 'normal') { normal.fromBufferAttribute(attribute, vertexIndex).applyMatrix3(candidate.normalMatrix).normalize(); values.push(...normal.toArray()); }
            else for (let k = 0; k < size; k++) values.push(attribute.getComponent(vertexIndex, k));
          }
          return values;
        });
        if (!vertices.every(vertex => vertex.every(Number.isFinite))) continue;
        if (candidate.reflected) [vertices[1], vertices[2]] = [vertices[2], vertices[1]];
        const polygon = clipPlanes(clip(vertices, region.box), region.planes);
        if (polygon.length < 3) continue;
        if (!regionMaterials.has(range.material) && regionMaterials.size >= materialBudget) { this.stats.limited = true; continue; }
        const key = `${range.material.uuid}:${attributes.map(attr => `${attr.name}:${attr.size}`).join(',')}`;
        if (!batches.has(key)) {
          if (!clonedMaterials.has(range.material)) {
            if (clonedMaterials.size >= config.maxMaterials) { this.stats.limited = true; continue; }
            clonedMaterials.set(range.material, this.copyMaterial(range.material, clonedTextures));
          }
          batches.set(key, { values: [], attributes, stride, material: clonedMaterials.get(range.material) });
        }
        regionMaterials.add(range.material);
        const batch = batches.get(key);
        for (let i = 1; i + 1 < polygon.length; i++) {
          if (emitted >= triangleBudget) { this.stats.limited = true; break; }
          batch.values.push(...polygon[0], ...polygon[i], ...polygon[i + 1]);
          emitted++; this.stats.triangles++;
        }
      }
      this.stats.regionTriangles.push(emitted);
    }
    for (const batch of batches.values()) {
      if (!batch.values.length) continue;
      const geometry = new THREE.BufferGeometry(), count = batch.values.length / batch.stride;
      let offset = 0;
      for (const { name, size } of [{ name: 'position', size: 3 }, ...batch.attributes]) {
        const values = new Float32Array(count * size);
        for (let vertex = 0; vertex < count; vertex++) for (let k = 0; k < size; k++) values[vertex * size + k] = batch.values[vertex * batch.stride + offset + k];
        geometry.setAttribute(name, new THREE.BufferAttribute(values, size)); offset += size;
      }
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      geometry.normalizeNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, batch.material);
      mesh.userData.chapterSupport = true;
      this.root.add(mesh);
    }
    this.stats.materials = this.materials.size;
    // Players can remain at the lit campfire for minutes. A wall-clock timeout
    // must not erase ground underneath a still-present recorded player.
    this.expiresAt = config.lifetimeMs > 0 ? now + config.lifetimeMs : Infinity;
    this.root.visible = this.stats.triangles > 0;
    if (this.root.visible) {
      this.supportQuery = new FollowTerrainQuery(THREE).setRoots([this.root]);
      this.sourceGrounded = this.covered(parsed, yScale);
      this.root.visible = this.sourceGrounded.some(Boolean);
    }
    this.root.userData.supportStats = { ...this.stats, sourceGrounded: [...this.sourceGrounded] };
    if (!this.root.visible) this.clear();
    return this.root.visible;
  }

  copyMaterial(source, textures) {
    const material = source.clone();
    // Do not retain source shader closures; they can own old texture/uniform
    // graphs. Static native terrain colors are reconstructed from plain data.
    for (const key of Object.keys(material)) {
      const texture = material[key];
      if (!texture?.isTexture) continue;
      if (!textures.has(texture)) {
        const image = texture.image, bytes = (image?.width || 0) * (image?.height || 0) * 4;
        if (!bytes || this.stats.textureBytes + bytes > this.options.maxTextureBytes) {
          textures.set(texture, null); this.stats.limited = true;
        } else {
          const copy = texture.clone(); copy.needsUpdate = true;
          textures.set(texture, copy); this.textures.add(copy); this.stats.textureBytes += bytes;
        }
      }
      material[key] = textures.get(texture);
    }
    if (!material.userData?.peakSourceEffect) applyTerrainMaterial(this.THREE, material);
    this.materials.add(material);
    return material;
  }

  get hasSupport() { return this.root.visible && this.root.children.length > 0; }

  covered(positions = [], verticalScale = 1) {
    const yScale = Number.isFinite(verticalScale) && verticalScale > 0 ? verticalScale : 1;
    if (!this.hasSupport || !this.supportQuery) return positions.map(() => false);
    return this.probeGround({ positions, query: this.supportQuery, maxDrop: 4 * yScale, rise: .5 * yScale });
  }

  probeGround({ positions = [], query, maxDrop = 4, rise = .5 } = {}) {
    // Caller supplies a query containing only current-chapter real geometry.
    // Returning positional booleans lets the caller keep each player's identity
    // without this helper storing participants or the query/its chapter roots.
    const down = new this.THREE.Vector3(0, -1, 0);
    return positions.map(value => {
      const position = point(this.THREE, value);
      if (!position || typeof query?.cast !== 'function' || !(maxDrop > 0) || !(rise >= 0)) return false;
      const hit = query.cast(position.clone().addScaledVector(down, -rise), down, maxDrop + rise);
      return Boolean(hit?.point && hit?.normal && hit.point.y <= position.y + .1
        && hit.point.y >= position.y - maxDrop && hit.normal.y >= .25);
    });
  }

  update({ positions = [], now = performance.now(), hasCurrentGround = false } = {}) {
    if (!this.root.visible) return false;
    const current = positions.map(value => point(this.THREE, value)).filter(Boolean);
    if (hasCurrentGround || !Number.isFinite(now) || now >= this.expiresAt || !current.length
        || !current.some(position => this.boxes.some(box => box.containsPoint(position)))) this.clear();
    return this.root.visible;
  }

  clear() {
    this.supportQuery?.dispose(); this.supportQuery = null;
    for (const mesh of this.root.children) mesh.geometry?.dispose();
    this.root.clear(); this.root.visible = false;
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.materials.clear(); this.textures.clear(); this.anchors = []; this.boxes = []; this.sourceGrounded = [];
    this.stats = { triangles: 0, examinedTriangles: 0, candidates: 0, textureBytes: 0, materials: 0, limited: false };
    this.expiresAt = 0; this.root.userData.supportStats = null;
  }

  dispose() { this.clear(); this.disposed = true; this.root.removeFromParent(); }
}
