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

/** Scene-depth input for analytic fog. Does not own the scene or fog materials. */
export class FogDepthPass {
  constructor(THREE) {
    this.THREE = THREE;
    this.target = null;
    this.size = new THREE.Vector2();
    this.viewProjection = new THREE.Matrix4();
    this.frustum = new THREE.Frustum();
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

  intersectsVisibleFog(entry, camera) {
    if (!visibleInHierarchy(entry.group)) return false;
    let visible = false;
    entry.group.traverse((object) => {
      if (visible || !object.isMesh || !visibleInHierarchy(object) || !object.layers.test(camera.layers)) return;
      if (object.frustumCulled === false || this.frustum.intersectsObject(object)) visible = true;
    });
    return visible;
  }

  render({ renderer, scene, camera, fogEntries = [], hiddenRoots = [] }) {
    this.disableMaterials();
    if (this.disposed) return false;
    const entries = [...fogEntries].filter((entry) => entry?.group && entry.fogMaterial);
    for (const entry of entries) {
      uniform(entry.fogMaterial, "hasSceneDepth", false);
      uniform(entry.fogMaterial, "sceneDepth", null);
    }
    if (!entries.length) return false;
    // Frustum tests must see the same current transforms as the real render.
    scene.updateMatrixWorld(true);
    camera.updateWorldMatrix(true, false);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection, camera.coordinateSystem,
      Boolean(renderer.capabilities?.reversedDepthBuffer));
    const visible = entries.filter((entry) => this.intersectsVisibleFog(entry, camera));
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
      renderer.render(scene, camera);
    } finally {
      for (const [root, wasVisible] of visibility) root.visible = wasVisible;
      renderer.autoClear = autoClear;
      // Three restores the previous target's viewport/scissor at the same time.
      renderer.setRenderTarget(previousTarget, cubeFace, mipLevel);
    }
    for (const entry of visible) {
      const material = entry.fogMaterial;
      uniform(material, "hasSceneDepth", true);
      uniform(material, "sceneDepth", target.depthTexture);
      copyUniform(material, "depthResolution", this.size);
      copyUniform(material, "projectionInverse", camera.projectionMatrixInverse);
      copyUniform(material, "cameraWorld", camera.matrixWorld);
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
