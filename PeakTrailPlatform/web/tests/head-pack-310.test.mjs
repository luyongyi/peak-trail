import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadGameAssetPack } from "../src/game-assets.js";
import { createAvatarRenderPlan, isHeadAppearanceReady, selectHeadModelParts } from "../src/avatar-renderer.js";
import { readGameAssets } from "../../tools/lib/game-assets.mjs";

const root = new URL("../../data/avatar-assets/", import.meta.url);
const read = url => readFile(url, "utf8").then(JSON.parse);
const pack = await loadGameAssetPack("26542162", { indexUrl: new URL("catalog.json", root),
  fetchImpl: async url => ({ ok: true, json: () => read(url) }) });
const baseline = { captured: true, ready: true, skinIndex: 0, eyesIndex: 0, mouthIndex: 0,
  accessoryIndex: 0, outfitIndex: 0, hatIndex: 0 };

test("3.1 portraits retain their head-only geometry alongside native navigation UI", async () => {
  const checked = await readGameAssets(fileURLToPath(root));
  assert.ok(checked.characterBuilds.has("26542162"));
  assert.equal(pack.catalog.profile, "head-portraits");
  assert.equal(pack.catalog.sourceEvidence.installedSteamBuildId, "26542162");
  assert.equal(pack.catalog.sourceEvidence.assembly.sha256, "a3643f11dc444d86491270b224c0a0caf9126a10b26731feb97fc85ad1d82038");
  assert.equal(pack.catalog.sourceEvidence.serializedInputs.length, 5);
  assert.equal(pack.catalog.items.length, 194);
  assert.ok(pack.catalog.items.every(item => !item.model && !item.worldModel));
  assert.equal(pack.catalog.sourceEvidence.navigationUi.selection, "canonical-item-icons-and-serialized-ui-references");
  assert.ok(pack.ui.staminaFill && pack.ui.staminaOutline && pack.ui.extraStaminaIcon);
  assert.ok(pack.catalog.assets.every(asset => !/^models\/(?:world|fit-|sash-|medal-)/.test(asset.path)));
  const model = await read(new URL(pack.customization.avatar.model, pack.catalogUrl));
  assert.equal(selectHeadModelParts(model).length, model.parts.length);
  assert.deepEqual(new Set(model.parts.map(part => part.role)), new Set(["skin", "eyes", "mouth", "accessory"]));
  assert.ok(pack.customization.fits.every(fit => !fit.model && fit.hatMaterial));
  for (const asset of pack.catalog.assets.filter(asset => asset.path.endsWith(".json"))) {
    const mesh = await read(new URL(asset.path, pack.catalogUrl));
    assert.ok(mesh.parts?.length, `${asset.path}: native mesh is missing`);
    for (const part of mesh.parts) {
      assert.ok(part.positions.length >= 9 && part.positions.length % 3 === 0 && part.positions.every(Number.isFinite));
      assert.equal(part.uv.length, part.positions.length / 3 * 2);
      assert.ok(part.uv.every(Number.isFinite));
      assert.ok(part.groups.length > 0);
      for (const group of part.groups) {
        assert.ok(group.indices.length > 0 && group.indices.length % 3 === 0);
        assert.ok(group.indices.every(index => Number.isInteger(index) && index >= 0 && index < part.positions.length / 3));
      }
    }
  }
});

test("every current head, expression, accessory and effective hat has a ready render plan", () => {
  const counts = { skins: 9, eyes: 18, mouths: 19, accessories: 21, fits: 34, hats: 47 };
  const fields = { skins: "skinIndex", eyes: "eyesIndex", mouths: "mouthIndex", accessories: "accessoryIndex",
    fits: "outfitIndex", hats: "effectiveHatIndex" };
  const plan = appearance => {
    // The live DTO supplies chosen cosmetics, not an inferred runtime form.
    assert.equal(isHeadAppearanceReady(pack, appearance), true);
    assert.ok(createAvatarRenderPlan(pack, appearance, true));
    assert.equal(createAvatarRenderPlan(pack, appearance, false), null);
  };
  for (const [group, count] of Object.entries(counts)) {
    assert.equal(pack.customization[group].length, count);
    assert.deepEqual(pack.customization[group].map(entry => entry.index), Array.from({ length: count }, (_, index) => index));
    for (const entry of pack.customization[group]) plan({ ...baseline, [fields[group]]: entry.index });
  }
  for (const fit of pack.customization.fits) for (const hat of [0, 1]) {
    const appearance = { ...baseline, outfitIndex: fit.index, hatIndex: hat };
    plan(appearance);
    assert.equal(createAvatarRenderPlan(pack, appearance, true).hat.index, fit.overrideHat ? fit.overrideHatIndex : hat);
  }
  for (const group of ["eyes", "mouths", "accessories"]) for (const entry of pack.customization[group]) {
    if (entry.isBlank || entry.isThirdEye) continue;
    assert.equal(entry.textureEncoding, "peak-face-mask");
    assert.ok(entry.preview && entry.texture);
  }
  assert.equal(isHeadAppearanceReady(pack, { ...baseline, ready: false }), false);
  assert.equal(isHeadAppearanceReady(pack, { ...baseline, eyesIndex: 999 }), false);
  assert.equal(isHeadAppearanceReady(pack, { ...baseline, formReady: true, form: "skeleton" }), false);
});
