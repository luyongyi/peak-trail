// A map pack binds the native renderer selection to the exact chapter GLB.
// Original glTF node and instance indices survive multi-primitive nodes,
// duplicate mesh names, co-located terrain, and display/world transforms.
export function nativeCampfireSpec(index, mapPack, layer) {
  // 26155610 is the independently verified source of the 3.1 GLBs.
  if (mapPack?.identityVersion !== 3 || !['26542162', '26155610'].includes(String(mapPack.gameBuildId))
      || !/^sha256-[0-9a-f]{64}$/.test(mapPack.mapPackId)
      || !Number.isInteger(layer?.segment) || layer.segment < 0 || layer.segment > 3
      || !/^[0-9a-f]{64}$/.test(layer.geometrySha256)) return null;
  const id = index?.byGeometry?.[layer.geometrySha256];
  if (typeof id !== 'string' || !index.templates || !Object.hasOwn(index.templates, id)) return null;
  return index.templates[id];
}

export function createNativeCampfireMatcher(template) {
  if (!template?.sourceRootName || !Array.isArray(template.ranges) || !template.ranges.length) return null;
  const includedInNextEnclosure = template.includedInNextEnclosure === true;
  if (includedInNextEnclosure && !/^[0-9a-f]{64}$/.test(template.enclosureSha256)) return null;
  const nodes = new Map();
  let instanceCount = 0;
  for (const range of template.ranges) {
    if (!Array.isArray(range) || range.length !== 3 || !range.every(Number.isSafeInteger)) return null;
    const [node, start, count] = range;
    if (node < 0 || start < 0 || count <= 0 || !Number.isSafeInteger(start + count)) return null;
    if (!nodes.has(node)) nodes.set(node, []);
    nodes.get(node).push([start, start + count]);
    instanceCount += count;
  }
  if (instanceCount !== template.instanceCount) return null;
  for (const intervals of nodes.values()) {
    intervals.sort((a, b) => a[0] - b[0]);
    if (intervals.some(([start], i) => i > 0 && start < intervals[i - 1][1])) return null;
  }
  return {
    includedInNextEnclosure,
    enclosureSha256: includedInNextEnclosure ? template.enclosureSha256 : null,
    includesNode(node) { return nodes.has(node); },
    matches(node, instance = 0) {
      const intervals = nodes.get(node);
      if (!intervals || !Number.isSafeInteger(instance)) return false;
      // Ranges within a node are small and contiguous in the source export.
      return intervals.some(([start, end]) => instance >= start && instance < end);
    },
  };
}

function collectResources(mesh, geometries, materials, textures) {
  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (mesh.geometry) geometries.add(mesh.geometry);
  for (const material of list) {
    if (!material || materials.has(material)) continue;
    materials.add(material);
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
  }
}

// The chapter loader batches whole instances, partitioned by native campfire
// membership. Several batches can use the very same GPU buffers or textures.
// Retain original batches and their ancestor transforms, relinquishing each
// discarded resource exactly once, including resources shared across batches.
export function retainNativeCampfire(root) {
  const ancestors = new Set([root]), keptGeometry = new Set(), keptMaterials = new Set(), keptTextures = new Set();
  let batches = 0, instances = 0;
  root.traverse(mesh => {
    if (!mesh.isMesh || mesh.userData.nativeCampfire !== true) return;
    batches++;
    instances += mesh.isInstancedMesh ? mesh.count : 1;
    collectResources(mesh, keptGeometry, keptMaterials, keptTextures);
    for (let owner = mesh; owner && !ancestors.has(owner); owner = owner.parent) ancestors.add(owner);
  });
  const geometries = new Set(), materials = new Set(), textures = new Set(), detach = [];
  root.traverse(node => {
    if (ancestors.has(node)) return;
    if (ancestors.has(node.parent)) detach.push(node);
    if (node.isMesh) collectResources(node, geometries, materials, textures);
    if (node.isInstancedMesh) node.dispose();
  });
  for (const node of detach) node.removeFromParent();
  for (const geometry of geometries) if (!keptGeometry.has(geometry)) geometry.dispose();
  for (const material of materials) if (!keptMaterials.has(material)) material.dispose();
  for (const texture of textures) if (!keptTextures.has(texture)) texture.dispose();
  return { batches, instances };
}
