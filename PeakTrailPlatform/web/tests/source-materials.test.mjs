import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getSourceEffectMaterial } from "../src/source-materials.js";

const evidence = JSON.parse(await readFile(new URL("../../tools/offline-maps/source-effect-materials.25306743.json", import.meta.url), "utf8"));
const fungalEvidence = JSON.parse(await readFile(new URL("../../tools/offline-maps/source-fungal-colors-evidence.json", import.meta.url), "utf8"));
const currentEvidence = JSON.parse(await readFile(new URL("../../tools/offline-maps/source-effect-materials.25739797.json", import.meta.url), "utf8"));
const linear = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

test("current-build effect values come from that build's own source and omit legacy fungal corrections", () => {
  let checked = 0;
  for (const source of currentEvidence.materials) {
    const effect = getSourceEffectMaterial(currentEvidence.gameBuildId, source.name, source.shader);
    if (!effect) continue;
    checked++;
    assert.equal(effect.source.buildId, 25739797);
    assert.equal(effect.source.mapBuildId, 25739797);
    assert.equal(effect.source.asset, source.sourceFile);
    assert.equal(effect.source.pathId, source.pathId);
    assert.equal(effect.source.pass.zWrite, source.passState.zWrite.val);
    if (effect.source.colorProperty) {
      const color = source.colors[effect.source.colorProperty];
      assert.deepEqual(effect.source.storedColor, color.rgba);
      assert.equal(effect.source.propertyFlags, color.flags);
      assert.deepEqual(effect.source.sourceColorLinear, color.rgba.slice(0, 3).map(value => color.flags & 16 ? value : linear(value)));
    }
    if (effect.kind === "fog") assert.equal(effect.opacity, source.floats._Opacity);
    assert.equal(getSourceEffectMaterial(25739798, source.name, source.shader), null);
  }
  assert.equal(checked, 15);
  for (const name of ["M_Mushroom_tree", "M_Mushroom_tree_evil", "Glow Shroom"])
    assert.equal(getSourceEffectMaterial(25739797, name, "W/Peak_Standard"), null);
  const source = currentEvidence.materials.find(value => value.name === "M_Water_swamp");
  const water = getSourceEffectMaterial(25739797, source.name, source.shader).source.waterDepth;
  assert.deepEqual(water.tintStored, source.colors._WaterTint.rgba);
  assert.deepEqual(water.shallowStored, source.colors._WaterColorShallow.rgba);
  assert.equal(water.depth, source.floats._Depth);
  assert.equal(water.sameBuildShaderEvidence, true);
});

test("all effect lookup entries reproduce their exact-build raw Unity source evidence", () => {
  let checked = 0;
  for (const source of evidence.materials) {
    const effect = getSourceEffectMaterial(evidence.gameBuildId, source.name, source.shader);
    if (!effect) continue;
    checked++;
    assert.equal(effect.source.asset, source.sourceFile);
    assert.equal(effect.source.pathId, source.pathId);
    const color = source.colors[effect.source.colorProperty];
    if (effect.source.colorProperty) {
      assert.deepEqual(effect.source.storedColor, color.rgba);
      assert.equal(effect.source.propertyFlags, color.flags);
      const rgb = color.rgba.slice(0, 3).map((v) => color.flags & 16 ? v : linear(v));
      assert.deepEqual(effect.source.sourceColorLinear, rgb);
      assert.deepEqual(effect.kind === "lava" ? effect.emissive : effect.baseColor, rgb);
    } else {
      assert.equal(effect.kind, "antisphere");
      assert.equal(effect.source.storedColor, null);
      assert.equal(effect.source.sourceColorLinear, null);
    }
    assert.equal(effect.source.pass.zWrite, source.passState.zWrite.val);
    if (effect.kind === "fog") assert.equal(effect.opacity, source.floats._Opacity);
  }
  assert.equal(checked, 15);
});

test("Shore jellyfish restores shader-declared purple and does not confuse the urchin or color alpha", () => {
  const source = evidence.materials.find((material) => material.name === "Jelly");
  const jelly = getSourceEffectMaterial("25306743", "Jelly", "Jelly");
  assert.equal(jelly.kind, "jellyfish");
  assert.equal(jelly.source.colorProperty, "_Color");
  assert.ok(!Object.hasOwn(source.shaderProperties, "_BaseColor"), "the stale white property is not declared by Jelly");
  assert.deepEqual(source.unusedSavedColors._BaseColor, [1, 1, 1, 1]);
  assert.deepEqual(jelly.baseColor, source.colors._Color.rgba.slice(0, 3).map(linear));
  assert.ok(jelly.baseColor[2] > jelly.baseColor[1] && jelly.baseColor[0] > jelly.baseColor[1]);
  assert.deepEqual(jelly.emissive, [0, 0, 0]);
  assert.equal(jelly.transparent, true);
  assert.equal(jelly.depthWrite, true);
  assert.equal(jelly.opacity, 1, "color alpha controls source refraction, not output opacity");
  assert.equal(jelly.source.cull, source.passState.culling.val);
  assert.equal(jelly.source.pass.srcBlend, source.passState.rtBlend0.srcBlend.val);
  assert.equal(jelly.source.pass.dstBlend, source.passState.rtBlend0.destBlend.val);
  assert.equal(source.forwardTags.QUEUE, "Transparent");
  for (const layer of Object.values(jelly.source.colorLayers).filter((value) => value?.property)) {
    assert.deepEqual(layer.rgba, source.colors[layer.property].rgba);
    assert.equal(layer.flags, source.colors[layer.property].flags);
  }
  assert.equal(jelly.source.colorLayers.formula, source.colorComputation.surface);
  assert.match(jelly.source.approximation, /refraction.*not reproduced/);
  assert.equal(getSourceEffectMaterial("25306743", "M_Urchin", "GD/FoliageGD"), null);
  assert.equal(getSourceEffectMaterial("25306743", "Jelly", "other"), null);
  assert.equal(getSourceEffectMaterial("25306744", "Jelly", "Jelly"), null);
  assert.equal(getSourceEffectMaterial("25306743", "Jelly (Instance)", "Jelly"), null);
  jelly.source.colorLayers.secondary.rgba[0] = 100;
  assert.notEqual(getSourceEffectMaterial("25306743", "Jelly", "Jelly").source.colorLayers.secondary.rgba[0], 100);
});

test("Void AntiSphere shells use exact transparent source evidence instead of opaque white PBR", () => {
  for (const [name, pathId, borderLight] of [["AntiSphere", 13, 0], ["AntiSphereInterior", 14, 1]]) {
    const effect = getSourceEffectMaterial("25306743", name, "AntiSphere");
    assert.equal(effect.kind, "antisphere");
    assert.equal(effect.transparent, true);
    assert.equal(effect.depthWrite, true);
    assert.equal(effect.opacity, 1, "source _Alpha remains 1; the shader computes per-pixel transparency");
    assert.equal(effect.source.asset, "resources.assets");
    assert.equal(effect.source.pathId, pathId);
    assert.deepEqual(effect.source.alphaShape,
      {_Alpha: 1, _Power: 0.25, _SoftInverse: 0.5, _BorderLight: borderLight});
    assert.match(effect.source.approximation, /Fresnel shell/);
  }
  assert.equal(getSourceEffectMaterial("25306743", "AntiSphere", "other"), null);
});

test("Roots explosive mushroom uses source orange HDR albedo, not neutral tint or emission", () => {
  const mine = getSourceEffectMaterial("25306743", "M_SporeShroomExplo", "W/Peak_Standard");
  assert.deepEqual(mine.baseColor, [0.7169811725616455, 0.25232812762260437, 0]);
  assert.deepEqual(mine.emissive, [0, 0, 0]);
  assert.equal(mine.transparent, false);
  assert.equal(mine.depthWrite, true);
  assert.equal(mine.opacity, 1);
  assert.match(mine.source.approximation, /multilayer.*not reproduced/);
  assert.notDeepEqual(mine.baseColor, getSourceEffectMaterial("25306743", "M_SporeShroomPoison", "W/Peak_Standard").baseColor);
});

test("ordinary, Evil and Glow caps retain distinct source albedo and the real Tint multiplier", () => {
  for (const source of fungalEvidence.materialColors) {
    const effect = getSourceEffectMaterial("25306743", source.name, source.shader);
    assert.equal(effect.kind, "fungus");
    assert.deepEqual(effect.baseColor, source.baseTimesTintLinearRgb);
    assert.deepEqual(effect.source.storedColor, source.primary.storedRgba);
    assert.deepEqual(effect.source.tintProperty.storedColor, source.tint.storedRgba);
    assert.equal(effect.source.propertyFlags, 16);
    assert.equal(effect.source.tintProperty.propertyFlags, 16);
    assert.deepEqual(effect.emissive, [0, 0, 0]);
    assert.equal(effect.transparent, false);
    assert.equal(effect.opacity, 1, "layer-colour alpha is not surface transparency");
    assert.equal(effect.depthWrite, true);
    assert.equal(effect.source.mapBuildId, 25306743);
    assert.equal(effect.source.buildId, source.published25306743Evidence.primaryStoredRgbaMatchesInstalledExactly
      ? 25306743 : 25739797, "cross-build primary evidence stays explicit");
    assert.equal(getSourceEffectMaterial("25739797", source.name, source.shader), null);
    assert.equal(getSourceEffectMaterial("25306743", source.name, "unknown"), null);
  }
  const ordinary = getSourceEffectMaterial("25306743", "M_Mushroom_tree", "W/Peak_Standard");
  const evil = getSourceEffectMaterial("25306743", "M_Mushroom_tree_evil", "W/Peak_Standard");
  assert.notDeepEqual(ordinary.baseColor, evil.baseColor);
  assert.equal(getSourceEffectMaterial("25306743", "M_MushroomBase", "W/Peak_Standard"), null,
    "pale bell shells and stalks must not receive red cap colour");
});

test("source effects require exact build, material name and shader", () => {
  for (const args of [["25306744", "M_Lava", "Lava"], ["25306743", "M_Lava (Instance)", "Lava"], ["25306743", "M_Lava", "other"], [undefined, "M_Lava", "Lava"]]) {
    assert.equal(getSourceEffectMaterial(...args), null);
  }
});

test("HDR lava remains unclamped while water shader alpha is not misread as invisibility", () => {
  const lava = getSourceEffectMaterial("25306743", "M_Lava", "Lava");
  assert.deepEqual(lava.baseColor, [0, 0, 0]);
  assert.ok(lava.emissive[0] > 4);
  const water = getSourceEffectMaterial("25306743", "M_Water_forest", "GD/Water-GD");
  assert.equal(water.source.storedColor[3], 0);
  assert.equal(water.opacity, 1);
  assert.match(water.source.approximation, /alpha fixed to 1/);
  water.baseColor[0] = 100;
  assert.notEqual(getSourceEffectMaterial("25306743", "M_Water_forest", "GD/Water-GD").baseColor[0], 100);
});

test("swamp depth inputs retain independent source tint and shallow colours", () => {
  const source = evidence.materials.find(material => material.name === "M_Water_swamp");
  const parameters = getSourceEffectMaterial("25306743", source.name, source.shader).source.waterDepth;
  for (const [field, property] of [["primaryLinear", "_WaterColorPrimary"], ["shallowLinear", "_WaterColorShallow"], ["tintLinear", "_WaterTint"]]) {
    assert.equal(source.colors[property].flags, parameters.propertyFlags);
    assert.deepEqual(parameters[field], source.colors[property].rgba.slice(0, 3).map(linear));
  }
  assert.deepEqual(parameters.tintStored, source.colors._WaterTint.rgba);
  assert.equal(parameters.depth, source.floats._Depth);
  assert.equal(parameters.shaderEvidenceBuildId, 25739797);
  assert.equal(parameters.crossBuildShaderIdentityVerified, false);
  assert.match(parameters.approximation, /native alpha is not reconstructed/);
  assert.equal(getSourceEffectMaterial("25306743", "M_Water_forest", source.shader).source.waterDepth, null);
});
