import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../../vendor/three/0.180.0/build/three.module.js';
import { FollowOcclusionModules, prepareFollowOcclusionMesh, applyFollowOcclusion } from '../src/follow-occlusion.js';
import { FollowTerrainQuery } from '../src/follow-terrain.js';

function fixture() {
  const root = new THREE.Group(), original = new THREE.BoxGeometry(1, 1, .4);
  const shared = {}, neighbour = {}, rear = {};
  const meshes = [];
  function batch(points, modules, { protectedFloor = false, geometry = original } = {}) {
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), points.length);
    points.forEach((point, index) => mesh.setMatrixAt(index, new THREE.Matrix4().makeTranslation(...point)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.followModules = modules;
    mesh.userData.followOcclusionProtected = protectedFloor;
    prepareFollowOcclusionMesh(mesh, THREE);
    root.add(mesh); meshes.push(mesh); return mesh;
  }
  const front = batch([[0, 0, 6], [5, 0, 6]], [shared, neighbour]);
  const secondFace = batch([[4, 3, 6]], [shared]);
  const behind = batch([[0, 0, 3]], [rear]);
  const contact = batch([[0, 0, .1]], [{}]);
  const passage = batch([[0, 0, 4]], [{}], { protectedFloor: true });
  const camera = new THREE.PerspectiveCamera(40, 1, .08, 100);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const anchor = new THREE.Vector3(), query = new FollowTerrainQuery(THREE).setRoots([root]);
  const controller = new FollowOcclusionModules(THREE); controller.setRoots([root]);
  const options = { query, camera, anchor, radius: 2 };
  const mask = mesh => [...mesh.geometry.getAttribute('peakFollowHidden')?.array || []];
  return { root, original, front, secondFace, behind, contact, passage, camera, anchor, query, controller, options, mask };
}

test('hide every blocking module with its other faces, but not another instance or contact floor', () => {
  const f = fixture();
  assert.equal(f.controller.update(f.options), 2);
  assert.deepEqual(f.mask(f.front), [1, 0]);
  assert.deepEqual(f.mask(f.secondFace), [1], 'a second primitive hides even outside the ray footprint');
  assert.deepEqual(f.mask(f.behind), [1], 'the next object behind the first obstruction hides in the same update');
  assert.deepEqual(f.mask(f.contact), [0]);
  assert.deepEqual(f.mask(f.passage), [0], 'protected passage always binds a visible mask');
});

test('hidden masks never change geometry queries or instance matrices, and unchanged masks are not uploaded again', () => {
  const f = fixture(), tree = f.query.tree, version = f.front.instanceMatrix.version;
  const matrix = [...f.front.instanceMatrix.array];
  f.controller.update(f.options);
  const maskVersion = f.front.geometry.getAttribute('peakFollowHidden').version;
  for (let frame = 0; frame < 60; frame++) assert.equal(f.controller.update({ ...f.options, deltaSeconds: 1/60 }), 2);
  assert.equal(f.query.tree, tree);
  assert.equal(f.front.instanceMatrix.version, version);
  assert.deepEqual([...f.front.instanceMatrix.array], matrix);
  assert.equal(f.front.geometry.getAttribute('peakFollowHidden').version, maskVersion);
  assert.deepEqual(f.mask(f.front), [1, 0]);
});

test('moving the view away, resetting follow, and changing roots restore complete modules', () => {
  const f = fixture(); f.controller.update(f.options);
  f.camera.position.x = 20; f.anchor.x = 20; f.camera.updateMatrixWorld();
  assert.equal(f.controller.update({ ...f.options, deltaSeconds: 0 }), 0, 'teleport bypasses throttling');
  assert.deepEqual(f.mask(f.front), [0, 0]);
  f.camera.position.x = 0; f.anchor.x = 0; f.camera.updateMatrixWorld();
  f.controller.update(f.options); f.controller.reset();
  assert.deepEqual(f.mask(f.front), [0, 0]); assert.deepEqual(f.mask(f.secondFace), [0]);
  f.controller.update(f.options); f.controller.setRoots([]);
  assert.deepEqual(f.mask(f.behind), [0]); assert.equal(f.controller.modules.size, 0);
  f.controller.setRoots([f.root]); f.controller.update(f.options); f.controller.dispose();
  assert.deepEqual(f.mask(f.front), [0, 0]); assert.equal(f.controller.modules.size, 0);
});

test('module masks are batch-local while all large vertex/index buffers remain shared', () => {
  const f = fixture();
  assert.notEqual(f.front.geometry, f.secondFace.geometry);
  assert.equal(f.front.geometry.attributes.position, f.original.attributes.position);
  assert.equal(f.front.geometry.index, f.original.index);
  assert.notEqual(f.front.geometry.attributes.peakFollowHidden, f.secondFace.geometry.attributes.peakFollowHidden);
  assert.equal(f.original.attributes.peakFollowHidden, undefined);
  assert.deepEqual(f.front.geometry.groups, f.original.groups);
});

test('side rays catch foreground beside the anchor but stop before contact surfaces', () => {
  const f = fixture();
  f.front.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1.2, 0, 5));
  f.front.instanceMatrix.needsUpdate = true;
  f.behind.visible = false;
  assert.equal(f.controller.update(f.options), 1);
  assert.deepEqual(f.mask(f.front), [1, 0]);
  assert.deepEqual(f.mask(f.contact), [0]);
  f.front.visible = false;
  assert.equal(f.controller.update(f.options), 0, 'actual visibility still applies to hidden modules');
});

test('a removed recorded instance is not revived by resetting camera visibility', () => {
  const f = fixture(); f.controller.update(f.options);
  f.front.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0)); f.front.instanceMatrix.needsUpdate = true;
  f.controller.update(f.options); f.controller.reset();
  const matrix = new THREE.Matrix4(); f.front.getMatrixAt(0, matrix);
  assert.equal(matrix.determinant(), 0);
  assert.equal(f.front.visible, true);
});

test('opaque Standard and Basic shaders discard entire instances without edge gradients', () => {
  for (const Material of [THREE.MeshStandardMaterial, THREE.MeshBasicMaterial]) {
    const material = new Material(), subject = { value: new THREE.Vector4(0, 0, -10, 2) };
    applyFollowOcclusion(material, subject);
    const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <clipping_planes_fragment>' };
    material.onBeforeCompile(shader);
    assert.equal(shader.uniforms.peakFollowSubject, subject);
    assert.match(shader.vertexShader, /vPeakFollowHidden = peakFollowHidden/);
    assert.match(shader.fragmentShader, /vPeakFollowHidden > 0.5\) discard/);
    assert.doesNotMatch(shader.fragmentShader, /smoothstep|vViewPosition|Bayer|radius/);
    assert.deepEqual(material.defaultAttributeValues.peakFollowHidden, [0]);
    assert.equal(material.transparent, false); assert.equal(material.depthWrite, true);
  }
});
