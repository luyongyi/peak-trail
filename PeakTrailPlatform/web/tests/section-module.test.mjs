import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { applySectionModuleMask, cutsSectionModule } from "../src/section-module.js";
import { createSectionPlane } from "../src/section-plane.js";

function fixture(centres = [[0, 0, 0, 1]], extents = centres.map(() => [1, 1, 1])) {
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute("peakSectionModule", new THREE.InstancedBufferAttribute(new Float32Array(centres.flat()), 4));
  geometry.setAttribute("peakSectionExtent", new THREE.InstancedBufferAttribute(new Float32Array(extents.flat()), 3));
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), centres.length);
  mesh.updateMatrixWorld(true);
  const section = createSectionPlane(THREE); section.value.set(1, 0, 0, 1);
  return { mesh, section, centre: geometry.getAttribute("peakSectionModule"), extent: geometry.getAttribute("peakSectionExtent") };
}

test("any module support on the camera side hides the whole instance while rear and ineligible modules remain", () => {
  const { mesh, section } = fixture([[0, 0, 0, 1], [-2, 0, 0, 1], [2, 0, 0, 1], [2, 0, 0, 0]]);
  assert.deepEqual([0, 1, 2, 3].map(i => cutsSectionModule(section, mesh, i)), [true, false, true, false]);
  section.value.x = -1;
  assert.deepEqual([0, 1, 2, 3].map(i => cutsSectionModule(section, mesh, i)), [true, true, false, false]);
  section.value.w = 0;
  assert.deepEqual([0, 1, 2, 3].map(i => cutsSectionModule(section, mesh, i)), [false, false, false, false]);
});

test("plane support uses the transformed local bounds, including shear, reflection and translation", () => {
  const { mesh, section, centre, extent } = fixture([[2, -1, 4, 1]], [[3, 1.5, 2]]);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.set(-2, .7, .3, 14, .4, 2.2, -.2, 8, .8, -.1, 1.3, -6, 0, 0, 0, 1);
  mesh.updateMatrixWorld(true);
  for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI / 8;
    const nx = Math.cos(angle), nz = Math.sin(angle);
    let max = -Infinity;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const corner = new THREE.Vector3(centre.getX(0) + x * extent.getX(0),
        centre.getY(0) + y * extent.getY(0), centre.getZ(0) + z * extent.getZ(0)).applyMatrix4(mesh.matrixWorld);
      max = Math.max(max, nx * corner.x + nz * corner.z);
    }
    section.value.set(nx, nz, -max + .00101, 1);
    assert.equal(cutsSectionModule(section, mesh, 0), true);
    section.value.z = -max + .00099;
    assert.equal(cutsSectionModule(section, mesh, 0), false);
  }
});

test("bounds already include the instance matrix and are not transformed by it twice", () => {
  const { mesh, section } = fixture([[2, 0, 0, 1]]);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(100, 0, 0));
  section.value.set(1, 0, -50, 1);
  assert.equal(cutsSectionModule(section, mesh, 0), false);
  mesh.position.x = 60; mesh.updateMatrixWorld(true);
  assert.equal(cutsSectionModule(section, mesh, 0), true, "the batch model matrix is applied");
});

test("contact protection retains the complete module at the XZ radius and vertical interval boundaries", () => {
  const { mesh, section, centre } = fixture([[0, 1.75, 0, 1]], [[1, .5, 1]]);
  assert.equal(cutsSectionModule(section, mesh, 0), true, "orbit has no contact protection");
  section.footing.value.set(2, 0, 0, 1);
  assert.equal(cutsSectionModule(section, mesh, 0), false, "touches both XZ radius and upper Y bound");
  section.footing.value.x = 2.001;
  assert.equal(cutsSectionModule(section, mesh, 0), true);
  section.footing.value.x = 2; centre.setY(0, 1.751);
  assert.equal(cutsSectionModule(section, mesh, 0), true, "above contact interval");
  centre.setY(0, -2.5);
  assert.equal(cutsSectionModule(section, mesh, 0), false, "touches lower Y bound");
  centre.setY(0, -2.501);
  assert.equal(cutsSectionModule(section, mesh, 0), true);
  centre.setY(0, 0); section.footing.value.w = 0;
  assert.equal(cutsSectionModule(section, mesh, 0), true, "ending follow restores whole-module sectioning");
});

test("contact uses transformed world AABB extents and a circle rather than a square footprint", () => {
  const { mesh, section } = fixture([[0, 0, 0, 1]], [[1, 1, 1]]);
  mesh.scale.set(3, 2, .5); mesh.position.set(2, 4, -1); mesh.updateMatrixWorld(true);
  section.footing.value.set(6, 4, -1, 1);
  assert.equal(cutsSectionModule(section, mesh, 0), false, "scaled world bound touches the foot circle");
  section.footing.value.z = .5;
  assert.equal(cutsSectionModule(section, mesh, 0), true, "diagonal gaps of one metre are outside a one-metre circle");
});

test("missing attributes, ordinary meshes and invalid instance indices never hide", () => {
  const { mesh, section } = fixture();
  for (const index of [null, undefined, -1, .5, 1]) assert.equal(cutsSectionModule(section, mesh, index), false);
  assert.equal(cutsSectionModule(null, mesh, 0), false);
  assert.equal(cutsSectionModule(section, new THREE.Mesh(mesh.geometry, mesh.material), 0), false);
  mesh.geometry.deleteAttribute("peakSectionExtent");
  assert.equal(cutsSectionModule(section, mesh, 0), false);
});

test("lit and unlit shaders retain existing compile hooks and hide by one per-instance decision", () => {
  for (const Material of [THREE.MeshStandardMaterial, THREE.MeshBasicMaterial]) {
    const material = new Material(), section = createSectionPlane(THREE);
    material.userData.peakSectionMode = "module";
    let receiver;
    material.onBeforeCompile = function(shader) { receiver = this; shader.uniforms.previousHook = { value: 7 }; };
    material.customProgramCacheKey = () => "existing-material";
    const shader = { uniforms: {}, vertexShader: "void main() {\n#include <begin_vertex>\n}",
      fragmentShader: "void main() {\n#include <clipping_planes_fragment>\n}" };
    applySectionModuleMask(material, section); material.onBeforeCompile(shader, {});
    assert.equal(receiver, material); assert.equal(shader.uniforms.previousHook.value, 7);
    assert.equal(shader.uniforms.peakSectionModulePlane, section);
    assert.equal(shader.uniforms.peakSectionModuleFooting, section.footing);
    assert.equal(material.userData.peakSectionMode, "module");
    assert.deepEqual(material.defaultAttributeValues.peakSectionModule, [0, 0, 0, 0]);
    assert.match(shader.vertexShader, /#ifdef USE_INSTANCING/);
    assert.match(shader.vertexShader, /modelMatrix \* vec4\(peakSectionModule\.xyz, 1\.0\)/);
    assert.match(shader.vertexShader, /dot\(abs\(localAxis\), peakSectionExtent\)/);
    assert.match(shader.fragmentShader, /if \(vPeakSectionModuleHidden > 0\.5\) discard/);
    assert.doesNotMatch(shader.fragmentShader, /world|footing|vViewPosition/i, "fragment shader does not cut a triangle into pieces");
    assert.equal(material.customProgramCacheKey(), "existing-material-section-module-mask-v1");
  }
});

test("installing the shader never classifies ordinary props or native surface shells as modules", () => {
  for (const mode of [undefined, "surface"]) {
    const material = new THREE.MeshStandardMaterial(), section = createSectionPlane(THREE);
    if (mode) material.userData.peakSectionMode = mode;
    applySectionModuleMask(material, section);
    assert.equal(material.userData.peakSectionMode, mode);
  }
});
