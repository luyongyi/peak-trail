import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../../vendor/three/0.180.0/build/three.module.js';
import { ChapterSupportGeometry } from '../src/chapter-support-geometry.js';
import { FollowTerrainQuery } from '../src/follow-terrain.js';
import { applyTerrainMaterial } from '../src/terrain-material.js';

const vec = (x, y, z) => new THREE.Vector3(x, y, z);
function floor(size = 5, material = new THREE.MeshStandardMaterial({ color: '#79634c' })) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-size, 0, -size, -size, 0, size, size, 0, -size], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0], 2));
  geometry.setIndex([0, 1, 2]); geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}
function almost(actual, expected, epsilon = 1e-5) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < epsilon, `${value} != ${expected[i]}`));
}

test('nearby copy preserves nested origin, height scale, reflected/sheared instance transforms and UVs', () => {
  const world = new THREE.Group(); world.scale.z = -1;
  const chapter = new THREE.Group(); chapter.scale.y = 2; world.add(chapter);
  const model = new THREE.Group(); model.position.set(-100, -200, -300); chapter.add(model);
  const primitive = floor(2), instances = new THREE.InstancedMesh(primitive.geometry, primitive.material, 2);
  const affine = new THREE.Matrix4().set(1, .2, .3, 102, .1, 1, .2, 203, .2, 0, 1, 304, 0, 0, 0, 1);
  instances.setMatrixAt(0, affine); instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1000, 200, 300)); model.add(instances);
  world.updateMatrixWorld(true);
  const transform = instances.matrixWorld.clone().multiply(affine);
  const expected = [0, 2, 1].map(index => vec(0, 0, 0).fromBufferAttribute(primitive.geometry.attributes.position, index).applyMatrix4(transform).toArray()).flat();
  const anchor = vec(-.5, 1, -.5).applyMatrix4(transform), support = new ChapterSupportGeometry(THREE);
  assert.equal(support.capture({ roots: [chapter], positions: [anchor], now: 0 }), true);
  assert.equal(support.stats.candidates, 1);
  assert.equal(support.root.children.length, 1);
  almost([...support.root.children[0].geometry.attributes.position.array], expected);
  almost([...support.root.children[0].geometry.attributes.uv.array], [0, 0, 1, 0, 0, 1]);
  assert.equal(support.root.parent, null, 'caller mounts a renderer-world root outside the reflected worldRoot');
  assert.equal(instances.count, 2);
});

test('large triangles are clipped to the nearby region without inventing the empty part of their bounds', () => {
  const support = new ChapterSupportGeometry(THREE, { radius: 2 }), source = floor(100);
  assert.equal(support.capture({ roots: [source], positions: [[0, 1, 0]], now: 0 }), true);
  const output = support.root.children[0].geometry;
  for (let i = 0; i < output.attributes.position.count; i++) {
    const p = vec(0, 0, 0).fromBufferAttribute(output.attributes.position, i);
    assert.ok(Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2); assert.equal(p.y, 0);
  }
  const query = new FollowTerrainQuery(THREE).setRoots([support.root]);
  assert.ok(query.cast(vec(-1, 2, -1), vec(0, -1, 0), 3));
  assert.equal(query.cast(vec(1, 2, 1), vec(0, -1, 0), 3), null, 'AABB space outside the original triangle remains empty');
});

test('draw range, material groups, hidden children, collapsed instances and source effect policy remain effective', () => {
  const source = floor(), geometry = source.geometry;
  geometry.setIndex([0, 1, 2, 0, 1, 2]); geometry.setDrawRange(3, 3);
  geometry.addGroup(0, 3, 0); geometry.addGroup(3, 3, 1);
  source.material = [new THREE.MeshStandardMaterial({ visible: false }), new THREE.MeshStandardMaterial({ color: 'red' })];
  const chapter = new THREE.Group(); chapter.add(source);
  const hidden = floor(); hidden.visible = false; chapter.add(hidden);
  for (const kind of ['water', 'fog']) {
    const mesh = floor(); mesh.material.userData.peakSourceEffect = { kind }; chapter.add(mesh);
  }
  const leaves = floor(); leaves.material.userData.peakTerrain = { sourceColors: { shader: 'GD/FoliageGD' } }; chapter.add(leaves);
  const collapsed = new THREE.InstancedMesh(geometry, source.material, 1);
  collapsed.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0)); chapter.add(collapsed);
  chapter.visible = false; // A deselected parent may still be captured explicitly.
  const support = new ChapterSupportGeometry(THREE);
  assert.equal(support.capture({ roots: [chapter], positions: [[-1, 1, -1]], now: 0 }), true);
  assert.equal(support.stats.triangles, 1); assert.equal(support.stats.materials, 1);
  assert.equal(support.root.children[0].material.color.getHexString(), 'ff0000');
});

test('copied buffers/materials/textures survive source disposal and clear only their owned resources', () => {
  const source = floor(), texture = new THREE.DataTexture(new Uint8Array(16), 2, 2);
  source.material.map = texture;
  let sourceGeometryDisposed = 0, sourceMaterialDisposed = 0, sourceTextureDisposed = 0;
  source.geometry.addEventListener('dispose', () => sourceGeometryDisposed++);
  source.material.addEventListener('dispose', () => sourceMaterialDisposed++);
  texture.addEventListener('dispose', () => sourceTextureDisposed++);
  const support = new ChapterSupportGeometry(THREE);
  support.capture({ roots: [source], positions: [[-1, 1, -1]], now: 0 });
  const copy = support.root.children[0], saved = [...copy.geometry.attributes.position.array];
  assert.notEqual(copy.geometry, source.geometry); assert.notEqual(copy.material, source.material);
  assert.notEqual(copy.material.map, texture); assert.equal(copy.material.map.image, texture.image);
  assert.equal(support.stats.textureBytes, 16);
  let ownGeometryDisposed = 0, ownMaterialDisposed = 0, ownTextureDisposed = 0;
  copy.geometry.addEventListener('dispose', () => ownGeometryDisposed++);
  copy.material.addEventListener('dispose', () => ownMaterialDisposed++);
  copy.material.map.addEventListener('dispose', () => ownTextureDisposed++);
  source.geometry.dispose(); source.material.dispose(); texture.dispose();
  source.geometry.attributes.position.array.fill(999);
  assert.deepEqual([...copy.geometry.attributes.position.array], saved);
  support.clear(); support.clear();
  assert.deepEqual([ownGeometryDisposed, ownMaterialDisposed, ownTextureDisposed], [1, 1, 1]);
  assert.deepEqual([sourceGeometryDisposed, sourceMaterialDisposed, sourceTextureDisposed], [1, 1, 1]);
  assert.equal(support.hasSupport, false);
  assert.equal(support.stats.triangles, 0); assert.equal(support.stats.textureBytes, 0);
});

test('triangle/material/texture budgets cap retained work and source material callbacks are not retained', () => {
  const chapter = new THREE.Group();
  for (let i = 0; i < 4; i++) { const mesh = floor(); mesh.position.y = i * .1; chapter.add(mesh); }
  const source = chapter.children[0];
  source.material.onBeforeCompile = () => { throw new Error('source closure must not run'); };
  source.material.map = new THREE.DataTexture(new Uint8Array(16), 2, 2);
  const support = new ChapterSupportGeometry(THREE, { maxTriangles: 2, maxMaterials: 1, maxTextureBytes: 8 });
  assert.equal(support.capture({ roots: [chapter], positions: [[-1, 1, -1]], now: 0 }), true);
  assert.ok(support.stats.triangles <= 2); assert.equal(support.stats.materials, 1);
  assert.equal(support.stats.textureBytes, 0); assert.equal(support.stats.limited, true);
  assert.equal(support.root.children[0].material.map, null);
  assert.doesNotThrow(() => support.root.children[0].material.onBeforeCompile({}));
});

test('old campfire support remains during a long stop, then releases on ground arrival, departure, reset or disposal', () => {
  const source = floor(), positions = [[-1, 1, -1]], support = new ChapterSupportGeometry(THREE);
  const capture = () => support.capture({ roots: [source], positions, now: 0 });
  assert.ok(capture()); assert.ok(support.hasSupport);
  assert.ok(support.update({ positions, now: 3600000, hasCurrentGround: false }));
  assert.equal(support.update({ positions, now: 3600001, hasCurrentGround: true }), false);
  capture(); assert.equal(support.update({ positions: [[100, 1, 100]], now: 1 }), false);
  capture(); assert.equal(support.update({ positions: [], now: 1 }), false);
  capture(); support.clear(); assert.equal(support.hasSupport, false);
  capture(); support.dispose(); assert.equal(capture(), false);
});

test('per-player new-ground probes use real surfaces, rejecting holes, ceilings and missing samples', () => {
  const source = floor(5), query = new FollowTerrainQuery(THREE).setRoots([source]);
  const support = new ChapterSupportGeometry(THREE);
  assert.deepEqual(support.probeGround({ positions: [[-1, 1, -1], [2, 1, 2], [NaN, 1, 0]], query }), [true, false, false]);
  source.position.y = 1.2; query.setRoots([source]);
  assert.deepEqual(support.probeGround({ positions: [[-1, 1, -1]], query }), [false]);
  assert.equal(Object.values(support).includes(query), false, 'probe does not retain the new chapter query');
});

test('capture requires actual ground at a candidate position and reports each anchor independently', () => {
  const source = floor(5), support = new ChapterSupportGeometry(THREE);
  assert.equal(support.capture({ roots: [source], positions: [[2, 1, 2]], now: 0 }), false,
    'nearby triangles around an unsupported position do not establish ground');
  assert.equal(support.hasSupport, false);
  assert.ok(support.capture({ roots: [source], positions: [[-1, 1, -1], [2, 1, 2]], now: 0 }));
  assert.deepEqual(support.sourceGrounded, [true, false]);
  assert.equal(support.capture({ roots: [source], positions: [[-1, 7, -1]], now: 0 }), false);
  assert.ok(support.capture({ roots: [source], positions: [[-1, 7, -1]], verticalScale: 2, now: 0 }));
});

test('copied rock gradient uses the exact shared native material construction without source closures', () => {
  const source = floor();
  source.material.userData.peakTerrain = { baseColor: [.2, .3, .4], topColor: [.8, .7, .5],
    sourceColors: { shader: 'W/Peak_Rock' }, tightness: [.1, .9], topAlpha: .8, amount: .7 };
  applyTerrainMaterial(THREE, source.material);
  const support = new ChapterSupportGeometry(THREE);
  support.capture({ roots: [source], positions: [[-1, 1, -1]], now: 0 });
  const copy = support.root.children[0].material;
  assert.notEqual(copy.onBeforeCompile, source.material.onBeforeCompile);
  const makeShader = () => ({ uniforms: {}, vertexShader: '#include <defaultnormal_vertex>', fragmentShader: '#include <color_fragment>' });
  const expected = makeShader(), actual = makeShader();
  source.material.onBeforeCompile(expected); copy.onBeforeCompile(actual);
  assert.deepEqual(actual, expected);
  assert.equal(copy.customProgramCacheKey(), source.material.customProgramCacheKey());
  source.material.userData.peakTerrain.baseColor[0] = 1;
  const after = makeShader(); copy.onBeforeCompile(after);
  assert.equal(after.uniforms.peakBase.value.r, .2, 'plain native metadata is independently copied');
});

test('explicit lifetime is optional and invalid/empty inputs never fabricate support', () => {
  const support = new ChapterSupportGeometry(THREE, { lifetimeMs: 10 });
  assert.equal(support.capture({ roots: [floor()], positions: [[NaN, 0, 0]], now: 0 }), false);
  assert.equal(support.capture({ roots: [], positions: [[0, 0, 0]], now: 0 }), false);
  assert.ok(support.capture({ roots: [floor()], positions: [[-1, 1, -1]], now: 0 }));
  assert.equal(support.update({ positions: [[-1, 1, -1]], now: 10 }), false);
});

test('separated teammates reserve triangle budgets and covered requires real retained ground, not an overlapping box', () => {
  const geometry = new THREE.BufferGeometry(), values = [];
  // One shared static batch places many early triangles under A and the only
  // triangle under B last. Traversal order must not starve B's ground.
  for (let i = 0; i < 100; i++) values.push(-2, 0, -2, -2, 0, 2, 2, 0, -2);
  values.push(18, 0, -2, 18, 0, 2, 22, 0, -2);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const support = new ChapterSupportGeometry(THREE, { maxTriangles: 12 });
  assert.ok(support.capture({ roots: [mesh], positions: [[-1, 1, -1], [19, 1, -1]], now: 0 }));
  assert.deepEqual(support.sourceGrounded, [true, true]);
  assert.deepEqual(support.stats.regionTriangles, [6, 1]);
  assert.deepEqual(support.covered([[-1, 1, -1], [19, 1, -1], [21, 1, 1]]), [true, true, false]);
  const oldQuery = support.supportQuery;
  support.clear();
  assert.deepEqual(oldQuery.roots, []); assert.deepEqual(oldQuery.entries, []);
  assert.deepEqual(support.covered([[19, 1, -1]]), [false]);
  assert.ok(support.capture({ roots: [mesh], positions: [[-1, 1, -1]], now: 0 }));
  assert.equal(support.stats.triangles, 12, 'a single player keeps the entire budget');
  assert.ok(support.capture({ roots: [mesh], positions: [[-1, 1, -1], [-1.2, 1, -1]], now: 0 }));
  assert.equal(support.stats.regions, 1, 'nearby teammates share the same patch');
  assert.equal(support.stats.triangles, 12);
});

test('overlapping player neighborhoods have independent material reserves and no duplicate coplanar region', () => {
  const root = new THREE.Group(), a = floor(2), b = floor(2), distracting = floor(2);
  b.position.x = 6; distracting.position.y = -.1;
  root.add(a, distracting, b);
  const support = new ChapterSupportGeometry(THREE, { maxMaterials: 2 });
  assert.ok(support.capture({ roots: [root], positions: [[-1, 1, -1], [5, 1, -1]], now: 0 }));
  assert.deepEqual(support.covered([[-1, 1, -1], [5, 1, -1]]), [true, true]);
  assert.equal(support.stats.regions, 2); assert.equal(support.stats.materials, 2);
  const oneLargeFloor = floor(100), partitioned = new ChapterSupportGeometry(THREE, { radius: 8 });
  assert.ok(partitioned.capture({ roots: [oneLargeFloor], positions: [[-5, 1, -5], [1, 1, -5]], now: 0 }));
  const hits = new THREE.Raycaster(vec(-2.2, 3, -5), vec(0, -1, 0)).intersectObject(partitioned.root, true);
  assert.equal(hits.length, 1, 'overlapping boxes do not produce two copies of the same plane');
});

test('nearest actual triangles win even when far same-instance geometry occurs first', () => {
  const values = [];
  for (let i = 0; i < 50; i++) values.push(-10, 0, -10, -10, 0, -9, -9, 0, -10);
  values.push(-2, 0, -2, -2, 0, 2, 2, 0, -2);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
  const source = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const support = new ChapterSupportGeometry(THREE, { maxTriangles: 1 });
  assert.ok(support.capture({ roots: [source], positions: [[-1, 1, -1]], now: 0 }));
  assert.deepEqual(support.covered([[-1, 1, -1]]), [true]);
  assert.equal(support.stats.triangles, 1);
});

test('real foot contact survives even when closer dense vertical walls exhaust a tiny budget', () => {
  const values = [];
  for (let i = 0; i < 100; i++) values.push(-.9, 0, -2, -.9, 2, -2, -.9, 0, 2);
  values.push(-2, 0, -2, -2, 0, 2, 2, 0, -2);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
  const source = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const support = new ChapterSupportGeometry(THREE, { maxTriangles: 1 });
  assert.ok(support.capture({ roots: [source], positions: [[-1, 1, -1]], now: 0 }));
  assert.deepEqual(support.covered([[-1, 1, -1]]), [true]);
  assert.equal(support.stats.triangles, 1);
});
