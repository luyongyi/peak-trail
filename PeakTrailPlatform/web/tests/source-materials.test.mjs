import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getSourceEffectMaterial } from "../src/source-materials.js";

const evidence = JSON.parse(await readFile(new URL("../../tools/offline-maps/source-effect-materials.25306743.json", import.meta.url), "utf8"));
const linear = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

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
  assert.equal(checked, 14);
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
