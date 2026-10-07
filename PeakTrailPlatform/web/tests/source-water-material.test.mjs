import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";

const source = (await readFile(new URL("../src/source-water-material.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export (?=function )/gm, "");
const { applySourceWaterDepth, sourceWaterColorAtDepth, sourceWaterDepthGap } = new Function("THREE",
  `${source}\nreturn { applySourceWaterDepth, sourceWaterColorAtDepth, sourceWaterDepthGap };`)(THREE);
const linear = (value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const parameters = {
  primaryLinear: [.7053561806678772, .7452830076217651, .28475427627563477].map(linear),
  shallowLinear: [.14728191494941711, .06274504214525223, .20784303545951843].map(linear),
  tintLinear: [.36078423261642456, .5154326558113098, .6235294342041016].map(linear),
  depth: 15.960000038146973,
};
const effect = () => ({ kind: "water", source: { material: "M_Water_swamp", shader: "GD/Water-GD",
  mapBuildId: 25306743, waterDepth: parameters } });
const close = (a, b) => a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) < 1e-10));

test("audited swamp tint replaces the full-strength yellow fallback without changing alpha", () => {
  close(sourceWaterColorAtDepth(parameters), [.048765471242588926, .11777777207851214, .02285329838734245]);
  const material = new THREE.MeshStandardMaterial();
  assert.equal(applySourceWaterDepth(material, effect()), true);
  close(material.color.toArray(), sourceWaterColorAtDepth(parameters));
  assert.equal(material.opacity, 1);
  assert.equal(material.transparent, true);
  assert.equal(material.depthWrite, false);
  material.dispose();
});

test("native depth remap saturates at one tenth of the source range and shallow tint stays separate", () => {
  const shallow = parameters.shallowLinear.map((value, i) => value * parameters.tintLinear[i]);
  const deep = sourceWaterColorAtDepth(parameters);
  close(sourceWaterColorAtDepth(parameters, 0), shallow);
  close(sourceWaterColorAtDepth(parameters, parameters.depth / 20), shallow.map((value, i) => (value + deep[i]) / 2));
  close(sourceWaterColorAtDepth(parameters, parameters.depth / 10), deep);
  close(sourceWaterColorAtDepth(parameters, 300), deep);
});

test("depth gap uses camera-forward projection and undoes height exaggeration", () => {
  assert.equal(sourceWaterDepthGap([10, 3, -5], [0, 0, 0], [0, 0, -1]), 5);
  assert.equal(sourceWaterDepthGap([0, -8, 0], [0, 0, 0], [0, -1, 0], 2), 4);
  const cameraForward = [0, -Math.SQRT1_2, -Math.SQRT1_2];
  assert.ok(Math.abs(sourceWaterDepthGap([0, -8, -4], [0, 0, 0], cameraForward, 2) - 12 / Math.sqrt(5)) < 1e-10);
});

test("water hook keeps pass uniform objects through shader compilation and composes previous hooks", () => {
  const material = new THREE.MeshStandardMaterial();
  let previousCalled = false;
  material.onBeforeCompile = () => { previousCalled = true; };
  assert.equal(applySourceWaterDepth(material, effect()), true);
  const state = material.userData.peakWaterDepth;
  state.uniforms.hasSceneDepth.value = true;
  state.uniforms.heightScale.value = 1.5;
  const shader = { uniforms: {}, fragmentShader: "#include <color_fragment>" };
  material.onBeforeCompile(shader, {});
  assert.equal(previousCalled, true);
  assert.equal(shader.uniforms.hasSceneDepth, state.uniforms.hasSceneDepth);
  assert.equal(shader.uniforms.heightScale.value, 1.5);
  assert.ok(shader.fragmentShader.includes("vec4(-vViewPosition, 1.0)"));
  assert.ok(shader.fragmentShader.includes("mix(peakWaterShallow, peakWaterPrimary, peakWaterWeight) * peakWaterTint"));
  const callback = material.onBeforeCompile;
  assert.equal(applySourceWaterDepth(material, effect()), true);
  assert.equal(material.onBeforeCompile, callback, "a shared material must not receive duplicate hooks");
  material.dispose();
});

test("unverified builds, other water types and invalid depth metadata remain untouched", () => {
  for (const mutate of [
    (value) => { value.source.material = "M_Water_forest"; },
    (value) => { value.source.mapBuildId = 25739797; },
    (value) => { value.source.shader = "W/Peak_Waterfall"; },
    (value) => { value.source.waterDepth = { ...parameters, depth: 0 }; },
    (value) => { value.source.waterDepth = { ...parameters, tintLinear: [0, NaN, 1] }; },
  ]) {
    const value = effect(); mutate(value);
    const material = new THREE.MeshStandardMaterial({ color: "#123456" });
    const before = material.color.toArray();
    assert.equal(applySourceWaterDepth(material, value), false);
    close(material.color.toArray(), before);
    assert.equal(material.userData.peakWaterDepth, undefined);
    material.dispose();
  }
});
