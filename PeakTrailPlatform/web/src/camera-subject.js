// Camera composition only: these bounds must never change source geometry,
// collision queries, player visibility, or the bounds used to clip trails.
const geometryBoundsCache = new WeakMap();

function validBounds(bounds) {
  return bounds && [bounds.min, bounds.max].every((point) => Array.isArray(point)
    && point.length === 3 && point.every(Number.isFinite))
    && bounds.min.every((value, axis) => value <= bounds.max[axis]);
}

function unionBounds(target, bounds) {
  for (let axis = 0; axis < 3; axis++) {
    target.min[axis] = Math.min(target.min[axis], bounds.min[axis]);
    target.max[axis] = Math.max(target.max[axis], bounds.max[axis]);
  }
}

function emptyBounds() { return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; }
function spans(bounds) { return bounds.max.map((value, axis) => value - bounds.min[axis]); }
function diagonal(bounds) { return Math.hypot(...spans(bounds)); }
function separationSquared(a, b) {
  let distance = 0;
  for (let axis = 0; axis < 3; axis++) {
    distance += Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]) ** 2;
  }
  return distance;
}

/**
 * Exclude only small, distant components around an unambiguous dense subject.
 * Connected towers remain whole; large separate islands are protected by both
 * extent and area. Nearby small objects (including a detached exit campfire)
 * stay in the framing. Ambiguous or malformed scenes retain every input part.
 * Returned entries are the original objects, in their original order.
 */
export function selectCameraSubjectParts(parts, { interior = false } = {}) {
  if (!Array.isArray(parts)) return [];
  if (parts.length < 8 || parts.some((part) => !validBounds(part?.bounds))) return parts.slice();
  const metrics = parts.map((part) => {
    const size = spans(part.bounds);
    // A surface measure also counts floors; volume would give a plane no vote.
    return { bounds: part.bounds, weight: size[0] * size[1] + size[1] * size[2] + size[2] * size[0] };
  });
  const lengths = metrics.map((part) => diagonal(part.bounds)).filter((size) => size > 0).sort((a, b) => a - b);
  const totalWeight = metrics.reduce((sum, part) => sum + part.weight, 0);
  if (!lengths.length || !(totalWeight > 0) || !Number.isFinite(totalWeight)) return parts.slice();
  const gap = lengths[Math.floor(lengths.length / 2)] * 0.1;
  const parents = parts.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) { const next = parents[index]; parents[index] = root; index = next; }
    return root;
  };
  const ordered = parts.map((_, index) => index).sort((a, b) => metrics[a].bounds.min[0] - metrics[b].bounds.min[0]);
  let active = [];
  for (const index of ordered) {
    const bounds = metrics[index].bounds;
    active = active.filter((other) => metrics[other].bounds.max[0] + gap >= bounds.min[0]);
    for (const other of active) {
      const a = find(index), b = find(other);
      if (a !== b && separationSquared(bounds, metrics[other].bounds) <= gap * gap) parents[a] = b;
    }
    active.push(index);
  }
  const components = new Map();
  metrics.forEach((part, index) => {
    const root = find(index);
    if (!components.has(root)) components.set(root, { root, count: 0, weight: 0, bounds: emptyBounds() });
    const component = components.get(root);
    component.count++;
    component.weight += part.weight;
    unionBounds(component.bounds, part.bounds);
  });
  const ranked = [...components.values()].sort((a, b) => b.weight - a.weight);
  const main = ranked[0];
  // Repeated small details must not select one of several legitimate islands.
  if (ranked.length === 1 || main.weight < totalWeight * 0.95
      || main.count < Math.max(8, parts.length * 0.75)) return parts.slice();
  const mainDiagonal = diagonal(main.bounds);
  if (!(mainDiagonal > 0)) return parts.slice();
  const significant = ranked.filter((component) => {
    if (component === main) return true;
    const componentDiagonal = diagonal(component.bounds);
    // Enclosed chapters can contain many copies of a small rock far from the
    // building. Repetition gives that fragment surface weight without making
    // it a second subject. Keep the same strict dominant-subject guards above,
    // and still protect sizeable islands and components near the main shell.
    if (interior && componentDiagonal < mainDiagonal * 0.15
        && separationSquared(component.bounds, main.bounds) > mainDiagonal ** 2) return false;
    return component.weight >= totalWeight * 0.005 || componentDiagonal >= mainDiagonal * 0.15;
  });
  // A long, low chapter needs room for a detached exit along its length, but
  // that length must not also grant floating rocks hundreds of metres of
  // vertical tolerance. Use an ellipsoid following each subject's own axes.
  const nearby = (component, subject) => {
    const size = spans(subject.bounds);
    let distance = 0;
    for (let axis = 0; axis < 3; axis++) {
      const separation = Math.max(0, component.bounds.min[axis] - subject.bounds.max[axis],
        subject.bounds.min[axis] - component.bounds.max[axis]);
      distance += (separation / Math.max(size[axis] * 0.12, gap)) ** 2;
    }
    return distance <= 1;
  };
  const retained = new Set(ranked.filter((component) => significant.includes(component)
    || significant.some((subject) => nearby(component, subject)))
    .map((component) => component.root));
  return parts.filter((_, index) => retained.has(find(index)));
}

function localIndexedBounds(THREE, geometry) {
  const position = geometry?.getAttribute?.("position");
  if (!position || position.itemSize < 3) return null;
  const index = geometry.getIndex();
  const start = Math.max(0, Math.floor(geometry.drawRange?.start || 0));
  const available = index?.count ?? position.count;
  const count = geometry.drawRange?.count ?? Infinity;
  const end = Math.min(available, start + Math.max(0, count));
  const groups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: available }];
  const signature = `${position.version}:${index?.version}:${start}:${end}:${groups.map((group) => `${group.start},${group.count}`).join(";")}`;
  const cached = geometryBoundsCache.get(geometry);
  if (cached?.signature === signature && cached.position === position && cached.index === index) return cached.bounds;
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const group of groups) {
    const first = Math.max(start, group.start), last = Math.min(end, group.start + group.count);
    for (let offset = first; offset < last; offset++) {
      const vertex = index ? index.getX(offset) : offset;
      if (!Number.isInteger(vertex) || vertex < 0 || vertex >= position.count) continue;
      point.fromBufferAttribute(position, vertex);
      if ([point.x, point.y, point.z].every(Number.isFinite)) bounds.expandByPoint(point);
    }
  }
  const result = bounds.isEmpty() ? null : bounds;
  geometryBoundsCache.set(geometry, { signature, position, index, bounds: result });
  return result;
}

/**
 * Collect per-instance bounds and fit points in original Unity-world coordinates. The chapter
 * group sits above the model's -origin translation and below display scaling /
 * Z reflection. Removing group.matrixWorld and adding origin restores that
 * source coordinate space without changing any object or geometry bounds.
 * The transformed local box corners retain its orientation for camera fitting;
 * the enclosing world-axis bounds remain available for subject clustering.
 * Indexed draw ranges are essential: Unity static batches can share a position
 * buffer containing unrelated geometry far outside the primitive being drawn.
 */
export function collectCameraParts(THREE, group, origin) {
  if (!group?.updateWorldMatrix || !group?.traverseVisible) return [];
  group.updateWorldMatrix(true, true);
  if (!Number.isFinite(group.matrixWorld.determinant()) || group.matrixWorld.determinant() === 0) return [];
  const inverse = group.matrixWorld.clone().invert();
  const offset = new THREE.Vector3(origin?.x ?? origin?.[0] ?? 0, origin?.y ?? origin?.[1] ?? 0, origin?.z ?? origin?.[2] ?? 0);
  const local = new THREE.Matrix4(), instance = new THREE.Matrix4(), relative = new THREE.Matrix4();
  const corner = new THREE.Vector3();
  const parts = [];
  group.traverseVisible((mesh) => {
    if (!mesh.isMesh) return;
    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (sourceMaterials.length && sourceMaterials.every((material) => material?.visible === false)) return;
    const bounds = localIndexedBounds(THREE, mesh.geometry);
    if (!bounds) return;
    const materials = sourceMaterials.filter(Boolean).map((material) => ({
      name: material.userData?.peakTerrain?.sourceMaterial || material.name,
      shader: material.userData?.peakTerrain?.sourceColors?.shader,
    }));
    local.multiplyMatrices(inverse, mesh.matrixWorld);
    for (let index = 0; index < (mesh.isInstancedMesh ? mesh.count : 1); index++) {
      if (mesh.isInstancedMesh) { mesh.getMatrixAt(index, instance); relative.multiplyMatrices(local, instance); }
      else relative.copy(local);
      const world = bounds.clone().applyMatrix4(relative);
      world.min.add(offset); world.max.add(offset);
      const result = { min: world.min.toArray(), max: world.max.toArray() };
      if (!validBounds(result) || diagonal(result) <= 0) continue;
      const points = [];
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        points.push(corner.set(x, y, z).applyMatrix4(relative).add(offset).toArray());
      }
      parts.push({ bounds: result, points, materials });
    }
  });
  return parts;
}
