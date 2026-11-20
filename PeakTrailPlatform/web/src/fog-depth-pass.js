function visibleInHierarchy(object) {
  for (let node = object; node; node = node.parent) if (node.visible === false) return false;
  return Boolean(object);
}

function uniform(material, name, value) {
  material.uniforms ||= {};
  if (!material.uniforms[name]) material.uniforms[name] = { value };
  else material.uniforms[name].value = value;
}

function copyUniform(material, name, value) {
  if (material.uniforms?.[name]?.value?.copy) material.uniforms[name].value.copy(value);
  else uniform(material, name, value.clone());
}

/** Shared opaque depth for fog and audited water. Does not own their materials. */
export class FogDepthPass {
  constructor(THREE) {
    this.THREE = THREE;
    this.target = null;
    this.size = new THREE.Vector2();
    this.viewProjection = new THREE.Matrix4();
    this.frustum = new THREE.Frustum();
    this.depthCamera = new THREE.PerspectiveCamera();
    this.sourceProjection = new THREE.Matrix4();
    this.surfaceBounds = new THREE.Sphere();
    this.boundMaterials = new Set();
    this.disposed = false;
  }

  disableMaterials() {
    for (const material of this.boundMaterials) {
      uniform(material, "hasSceneDepth", false);
      uniform(material, "sceneDepth", null);
    }
    this.boundMaterials.clear();
  }

  ensureTarget(width, height) {
    const THREE = this.THREE;
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
      });
      this.target.texture.generateMipmaps = false;
      this.target.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
      this.target.depthTexture.name = "PEAK replay opaque scene depth";
    } else if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
      this.target.depthTexture.image.width = width;
      this.target.depthTexture.image.height = height;
      this.target.depthTexture.needsUpdate = true;
    }
    return this.target;
  }

  nearestEffectDepth(entry, camera) {
    if (!visibleInHierarchy(entry.group)) return Infinity;
    let nearest = Infinity;
    entry.group.traverseVisible(object => {
      if (!object.isMesh || !object.layers.test(camera.layers)) return;
      const bounds = object.boundingSphere === undefined ? object.geometry : object;
      if (bounds.boundingSphere === null) bounds.computeBoundingSphere();
      const sphere = this.surfaceBounds.copy(bounds.boundingSphere).applyMatrix4(object.matrixWorld);
      if (object.frustumCulled && !this.frustum.intersectsSphere(sphere)) return;
      const depth = -sphere.center.applyMatrix4(camera.matrixWorldInverse).z - sphere.radius;
      nearest = Math.min(nearest, depth);
    });
    return nearest;
  }

  waterDepthCamera(camera, nearest) {
    // At 2 km, a 0.05 m near plane quantizes 24-bit depth in metre steps.
    // The swamp's entire shallow/deep transition is only 1.596 m wide.
    // Only tighten the prepass if ALL sampled surfaces are farther than 10 m.
    // A closer solid occludes those surfaces in the main pass's depth test.
    const near = Math.min(10, camera.far * 0.5);
    if (!camera.isPerspectiveCamera || nearest <= near || near <= camera.near) return camera;
    const probe = this.depthCamera;
    if (!this.sourceProjection.equals(camera.projectionMatrix)) {
      this.sourceProjection.copy(camera.projectionMatrix);
      probe.copy(camera, false);
      probe.matrixAutoUpdate = false;
      probe.near = near;
      probe.updateProjectionMatrix();
    }
    probe.layers.mask = camera.layers.mask;
    probe.matrix.copy(camera.matrixWorld);
    probe.updateMatrixWorld(true);
    return probe;
  }

  render({ renderer, scene, camera, fogEntries = [], depthEntries = [], hiddenRoots = [] }) {
    this.disableMaterials();
    if (this.disposed) return false;
    const entries = [...fogEntries, ...depthEntries].filter((entry) => entry?.group
      && (entry.fogMaterial || entry.depthMaterial)).map((entry) => ({
        group: entry.group, material: entry.fogMaterial || entry.depthMaterial, water: Boolean(entry.depthMaterial),
      }));
    for (const entry of entries) {
      uniform(entry.material, "hasSceneDepth", false);
      uniform(entry.material, "sceneDepth", null);
    }
    if (!entries.length) return false;
    // Frustum tests must see the same current transforms as the real render.
    scene.updateMatrixWorld(true);
    camera.updateWorldMatrix(true, false);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection, camera.coordinateSystem,
      Boolean(renderer.capabilities?.reversedDepthBuffer));
    let nearest = Infinity;
    const visible = entries.filter(entry => {
      const depth = this.nearestEffectDepth(entry, camera);
      nearest = Math.min(nearest, depth);
      return depth < Infinity;
    });
    if (!visible.length) return false;
    renderer.getDrawingBufferSize(this.size);
    const width = Math.floor(this.size.x), height = Math.floor(this.size.y);
    if (!Number.isFinite(width + height) || width < 1 || height < 1) return false;
    this.size.set(width, height);
    const target = this.ensureTarget(width, height);
    const previousTarget = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace?.() ?? 0;
    const mipLevel = renderer.getActiveMipmapLevel?.() ?? 0;
    const autoClear = renderer.autoClear;
    const visibility = new Map();
    const depthCamera = visible.some(entry => entry.water) ? this.waterDepthCamera(camera, nearest) : camera;
    for (const root of [...entries.map((entry) => entry.group), ...hiddenRoots]) {
      if (!root || visibility.has(root)) continue;
      visibility.set(root, root.visible);
      root.visible = false;
    }
    try {
      // setRenderTarget applies this target's full-buffer viewport and scissor.
      // No renderer-global viewport/scissor state is changed by this pass.
      renderer.setRenderTarget(target);
      renderer.autoClear = false;
      renderer.clear(true, true, false);
      renderer.render(scene, depthCamera);
    } finally {
      for (const [root, wasVisible] of visibility) root.visible = wasVisible;
      renderer.autoClear = autoClear;
      // Three restores the previous target's viewport/scissor at the same time.
      renderer.setRenderTarget(previousTarget, cubeFace, mipLevel);
    }
    for (const entry of visible) {
      const material = entry.material;
      uniform(material, "hasSceneDepth", true);
      uniform(material, "sceneDepth", target.depthTexture);
      copyUniform(material, "depthResolution", this.size);
      copyUniform(material, "projectionInverse", depthCamera.projectionMatrixInverse);
      copyUniform(material, "cameraWorld", depthCamera.matrixWorld);
      this.boundMaterials.add(material);
    }
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disableMaterials();
    this.target?.dispose();
    this.target?.depthTexture?.dispose();
    this.target = null;
    this.disposed = true;
  }
}
