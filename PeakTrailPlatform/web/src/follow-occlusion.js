// Hide an original renderer instance, including all of its material primitives.
// Keep the mask independent of instanceMatrix so CPU queries still see hidden
// obstructions and unrelated instances in the same batch stay solid.
export function applyFollowOcclusion(material, subject) {
  if ((!material.isMeshStandardMaterial && !material.isMeshBasicMaterial)
      || !material.depthWrite || material.userData.peakSourceEffect) return;
  const compile = material.onBeforeCompile, key = material.customProgramCacheKey();
  material.defaultAttributeValues = { ...material.defaultAttributeValues, peakFollowHidden: [0] };
  material.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.peakFollowSubject = subject;
    shader.vertexShader = `
      varying float vPeakFollowHidden;
      #ifdef USE_INSTANCING
        attribute float peakFollowHidden;
      #endif
    ` + shader.vertexShader.replace("#include <begin_vertex>", `
      #include <begin_vertex>
      vPeakFollowHidden = 0.0;
      #ifdef USE_INSTANCING
        vPeakFollowHidden = peakFollowHidden;
      #endif
    `);
    shader.fragmentShader = "uniform vec4 peakFollowSubject;\nvarying float vPeakFollowHidden;\n" +
      shader.fragmentShader.replace("#include <clipping_planes_fragment>", `
        #include <clipping_planes_fragment>
        if (peakFollowSubject.w > 0.0 && vPeakFollowHidden > 0.5) discard;
      `);
  };
  material.customProgramCacheKey = () => `${key}-follow-module-v1`;
}

export function prepareFollowOcclusionMesh(mesh, THREE) {
  if (!mesh.isInstancedMesh) return;
  // Batches share immutable vertex/index buffers, never their visibility mask.
  const source = mesh.geometry, geometry = new THREE.BufferGeometry();
  geometry.name = source.name;
  geometry.setIndex(source.index);
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
  geometry.morphAttributes = source.morphAttributes;
  geometry.morphTargetsRelative = source.morphTargetsRelative;
  geometry.groups = source.groups.map(group => ({ ...group }));
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  geometry.boundingBox = source.boundingBox?.clone() ?? null;
  geometry.boundingSphere = source.boundingSphere?.clone() ?? null;
  geometry.userData = { ...source.userData };
  geometry.setAttribute("peakFollowHidden", new THREE.InstancedBufferAttribute(new Float32Array(mesh.count), 1)
    .setUsage(THREE.DynamicDrawUsage));
  mesh.geometry = geometry;
}

const SAMPLE_OFFSETS = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1],
  [-.707, -.707], [-.707, .707], [.707, -.707], [.707, .707]];
const CONTACT_MARGIN = .65;

export class FollowOcclusionModules {
  constructor(THREE) {
    this.modules = new Map();
    this.hidden = new Set();
    this.elapsed = Infinity;
    this.right = new THREE.Vector3(); this.up = new THREE.Vector3();
    this.ray = new THREE.Vector3(); this.target = new THREE.Vector3();
    this.lastEye = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.lastAnchor = this.lastEye.clone();
  }

  setRoots(roots) {
    this.reset();
    this.modules.clear();
    const seen = new Set();
    for (const root of roots) root.traverse(mesh => {
      if (seen.has(mesh) || mesh.userData.followOcclusionProtected) return;
      seen.add(mesh);
      const attribute = mesh.geometry?.getAttribute("peakFollowHidden");
      const modules = mesh.userData.followModules;
      if (!attribute || !modules) return;
      modules.forEach((module, index) => {
        if (!this.modules.has(module)) this.modules.set(module, []);
        this.modules.get(module).push({ attribute, index });
      });
    });
  }

  update({ query, camera, anchor, section, radius, deltaSeconds = Infinity }) {
    this.elapsed += Math.max(0, deltaSeconds);
    // This coarse object decision runs at 15 Hz, immediately after teleports,
    // and on root resets. Position interpolation and camera rendering stay full rate.
    if (this.elapsed < 1 / 15 && this.lastEye.distanceToSquared(camera.position) < 4
      && this.lastAnchor.distanceToSquared(anchor) < 4) return this.hidden.size;
    this.elapsed = 0;
    this.lastEye.copy(camera.position); this.lastAnchor.copy(anchor);
    const next = new Set();
    this.right.setFromMatrixColumn(camera.matrixWorld, 0);
    this.up.setFromMatrixColumn(camera.matrixWorld, 1);
    const depth = this.ray.copy(anchor).sub(camera.position).length();
    if (depth > CONTACT_MARGIN && radius > 0) for (const [x, y] of SAMPLE_OFFSETS) {
      this.target.copy(anchor).addScaledVector(this.right, x * radius).addScaledVector(this.up, y * radius);
      this.ray.copy(this.target).sub(camera.position);
      // Side rays stop in the same plane before the player, not behind their
      // contact surface just because the diagonal ray is longer.
      const limit = this.ray.length() * (1 - CONTACT_MARGIN / depth);
      const hits = query.castAll(camera.position, this.ray, limit, section,
        { renderedFacesOnly: true, minimumDistance: camera.near });
      for (const { mesh, instanceId } of hits) {
        const module = mesh.userData.followModules?.[instanceId];
        if (this.modules.has(module)) next.add(module);
      }
    }
    const changed = new Set();
    const write = (module, hidden) => {
      for (const { attribute, index } of this.modules.get(module) || []) {
        attribute.setX(index, hidden); changed.add(attribute);
      }
    };
    for (const module of this.hidden) if (!next.has(module)) write(module, 0);
    for (const module of next) if (!this.hidden.has(module)) write(module, 1);
    for (const attribute of changed) attribute.needsUpdate = true;
    this.hidden = next;
    return next.size;
  }

  reset() {
    const changed = new Set();
    for (const module of this.hidden) for (const { attribute, index } of this.modules.get(module) || []) {
      attribute.setX(index, 0); changed.add(attribute);
    }
    for (const attribute of changed) attribute.needsUpdate = true;
    this.hidden.clear();
    this.elapsed = Infinity;
  }

  dispose() { this.reset(); this.modules.clear(); }
}
