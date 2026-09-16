import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { FogDepthPass } from "../src/fog-depth-pass.js";

function fixture() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1.5, 0.05, 100);
  camera.position.set(0, 0, 5);
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  group.add(mesh); scene.add(group);
  const fogMaterial = { uniforms: {} };
  const fog = { group, fogMaterial };
  const solid = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const trail = new THREE.Group();
  const grid = new THREE.Group(); grid.visible = false;
  scene.add(solid, trail, grid);
  const previousTarget = new THREE.WebGLRenderTarget(7, 9);
  const renderer = {
    width: 900, height: 600, target: previousTarget, autoClear: true, calls: 0, cleared: [],
    viewport: previousTarget.viewport.clone(), scissor: previousTarget.scissor.clone(),
    getDrawingBufferSize(target) { return target.set(this.width, this.height); },
    getRenderTarget() { return this.target; }, getActiveCubeFace() { return 2; }, getActiveMipmapLevel() { return 3; },
    setRenderTarget(target, face, mip) {
      this.target = target; this.face = face; this.mip = mip;
      this.viewport.copy(target?.viewport || new THREE.Vector4(0, 0, this.width, this.height));
      this.scissor.copy(target?.scissor || this.viewport);
    },
    clear(...args) { this.cleared.push(args); },
    render() {
      this.calls++;
      assert.equal(group.visible, false);
      assert.equal(trail.visible, false);
      assert.equal(grid.visible, false);
      assert.equal(solid.visible, true, "opaque items/terrain must remain in the depth pass");
      assert.equal(this.autoClear, false);
    },
  };
  const pass = new FogDepthPass(THREE);
  const options = { renderer, scene, camera, fogEntries: [fog], hiddenRoots: [trail, grid] };
  return { pass, options, scene, camera, fog, solid, trail, grid, renderer, previousTarget };
}

test("visible fog receives full-resolution depth and current camera matrices while solids stay visible", () => {
  const { pass, options, camera, fog, renderer } = fixture();
  assert.equal(pass.render(options), true);
  assert.equal(renderer.calls, 1);
  assert.deepEqual(renderer.cleared, [[true, true, false]]);
  assert.equal(pass.target.width, 900); assert.equal(pass.target.height, 600);
  assert.equal(pass.target.depthTexture.isDepthTexture, true);
  const u = fog.fogMaterial.uniforms;
  assert.equal(u.hasSceneDepth.value, true);
  assert.equal(u.sceneDepth.value, pass.target.depthTexture);
  assert.deepEqual(u.depthResolution.value.toArray(), [900, 600]);
  assert.deepEqual(u.projectionInverse.value.elements, camera.projectionMatrixInverse.elements);
  assert.deepEqual(u.cameraWorld.value.elements, camera.matrixWorld.elements);
});

test("visibility, target, face, mip, viewport/scissor and autoClear are restored", () => {
  const { pass, options, fog, trail, grid, renderer, previousTarget } = fixture();
  options.hiddenRoots.push(fog.group, trail); // Duplicate roots must preserve the original visibility once.
  pass.render(options);
  assert.equal(fog.group.visible, true); assert.equal(trail.visible, true); assert.equal(grid.visible, false);
  assert.equal(renderer.target, previousTarget); assert.equal(renderer.face, 2); assert.equal(renderer.mip, 3);
  assert.deepEqual(renderer.viewport.toArray(), [0, 0, 7, 9]);
  assert.deepEqual(renderer.scissor.toArray(), [0, 0, 7, 9]);
  assert.equal(renderer.autoClear, true);
});

test("no fog, hidden fog and fog behind a hidden ancestor skip allocation and extra rendering", () => {
  const { pass, options, fog, scene, renderer } = fixture();
  assert.equal(pass.render({ ...options, fogEntries: [] }), false);
  fog.group.visible = false;
  assert.equal(pass.render(options), false);
  fog.group.visible = true;
  const parent = new THREE.Group(); parent.visible = false; parent.add(fog.group); scene.add(parent);
  assert.equal(pass.render(options), false);
  assert.equal(renderer.calls, 0);
  assert.equal(pass.target, null);
});

test("frustum culling skips offscreen fog but preserves fog containing the camera", () => {
  const { pass, options, fog, camera, renderer } = fixture();
  fog.group.position.set(10000, 0, 0);
  assert.equal(pass.render(options), false);
  fog.group.position.copy(camera.position);
  fog.group.scale.setScalar(10);
  assert.equal(pass.render(options), true);
  assert.equal(renderer.calls, 1);
});

test("resizing reuses the target while resizing its depth texture and updating resolution", () => {
  const { pass, options, renderer, fog } = fixture();
  pass.render(options);
  const target = pass.target;
  renderer.width = 1600; renderer.height = 900;
  pass.render(options);
  assert.equal(pass.target, target);
  assert.equal(target.width, 1600); assert.equal(target.depthTexture.image.width, 1600);
  assert.equal(target.height, 900); assert.equal(target.depthTexture.image.height, 900);
  assert.deepEqual(fog.fogMaterial.uniforms.depthResolution.value.toArray(), [1600, 900]);
});

test("hidden/offscreen frames disable old depth uniforms instead of reusing stale matrices", () => {
  const { pass, options, fog, renderer } = fixture();
  pass.render(options);
  fog.group.visible = false;
  assert.equal(pass.render(options), false);
  assert.equal(renderer.calls, 1);
  assert.equal(fog.fogMaterial.uniforms.hasSceneDepth.value, false);
  assert.equal(fog.fogMaterial.uniforms.sceneDepth.value, null);
});

test("exceptions restore visibility and renderer state, leaving scene depth disabled", () => {
  const { pass, options, fog, trail, grid, renderer, previousTarget } = fixture();
  pass.render(options);
  renderer.render = () => { throw new Error("GPU test failure"); };
  renderer.autoClear = false;
  assert.throws(() => pass.render(options), /GPU test failure/);
  assert.equal(fog.group.visible, true); assert.equal(trail.visible, true); assert.equal(grid.visible, false);
  assert.equal(renderer.target, previousTarget); assert.equal(renderer.autoClear, false);
  assert.equal(fog.fogMaterial.uniforms.hasSceneDepth.value, false);
});

test("non-fog entries are not hidden and empty drawing buffers do not render", () => {
  const { pass, options, solid, renderer } = fixture();
  options.fogEntries.push({ group: solid });
  renderer.width = 0;
  assert.equal(pass.render(options), false);
  assert.equal(solid.visible, true);
  assert.equal(renderer.calls, 0);
});

test("dispose releases target/depth texture once and disables bound uniforms", () => {
  const { pass, options, fog, renderer } = fixture();
  pass.render(options);
  let targets = 0, textures = 0;
  pass.target.addEventListener("dispose", () => targets++);
  pass.target.depthTexture.addEventListener("dispose", () => textures++);
  pass.dispose(); pass.dispose();
  assert.equal(targets, 1); assert.equal(textures, 1); assert.equal(pass.target, null);
  assert.equal(fog.fogMaterial.uniforms.hasSceneDepth.value, false);
  assert.equal(fog.fogMaterial.uniforms.sceneDepth.value, null);
  assert.equal(pass.render(options), false);
  assert.equal(renderer.calls, 1);
});

test("Map.values iterator is consumed once and matrix uniforms are reused between frames", () => {
  const { pass, options, fog, camera } = fixture();
  const entries = new Map([["fog", fog]]);
  assert.equal(pass.render({ ...options, fogEntries: entries.values() }), true);
  const matrix = fog.fogMaterial.uniforms.cameraWorld.value;
  const resolution = fog.fogMaterial.uniforms.depthResolution.value;
  camera.position.x = 1;
  assert.equal(pass.render({ ...options, fogEntries: entries.values() }), true);
  assert.equal(fog.fogMaterial.uniforms.cameraWorld.value, matrix);
  assert.equal(fog.fogMaterial.uniforms.depthResolution.value, resolution);
  assert.equal(matrix.elements[12], 1);
});
