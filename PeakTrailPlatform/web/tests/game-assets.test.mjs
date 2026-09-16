import assert from "node:assert/strict";
import test from "node:test";
import {
  loadGameAssetPack,
  resolveAppearanceAssets,
  resolveGameAssetUrl,
  resolveItemAsset,
} from "../src/game-assets.js";
import {
  PLAYER_BACKPACK_SLOTS,
  canonicalInventoryLocation,
  inventoryVisualState,
} from "../src/player-card.js";

function jsonFetch(responses) {
  return async (input) => {
    const url = String(input);
    if (!responses.has(url)) return { ok: false, status: 404, async json() { return null; } };
    return { ok: true, status: 200, async json() { return responses.get(url); } };
  };
}

test("game assets are selected by exact build and item identity", async () => {
  const indexUrl = "https://assets.test/data/game-assets/catalog.json";
  const buildUrl = "https://assets.test/data/game-assets/25306743/catalog.json";
  const responses = new Map([
    [indexUrl, { schemaVersion: 1, builds: [{ gameBuildId: "25306743", catalog: "25306743/catalog.json" }] }],
    [buildUrl, {
      schemaVersion: 1,
      gameBuildId: "25306743",
      source: "local-unity-assets",
      items: [{ itemId: 42, prefabName: "Lantern", name: "Lantern", icon: "icons/lantern.png" }],
      ui: { backpackIcon: "icons/backpack.png" },
      customization: {
        avatar: { model: "models/avatar.json" },
        skins: [{ index: 1, name: "Skin", color: [0.2, 0.3, 0.4, 1] }],
        eyes: [{ index: 2, name: "Eyes", preview: "previews/eyes.png", texture: "textures/eyes.png" }],
        mouths: [], accessories: [],
        fits: [{ index: 3, name: "Fit", preview: "previews/fit.png", model: "models/fit.json" }],
        hats: [{ index: 9, name: "Hat", model: "models/hat.json" }],
        sashes: [], medals: [],
      },
    }],
  ]);
  const fetchImpl = jsonFetch(responses);
  const pack = await loadGameAssetPack("25306743", { indexUrl, fetchImpl });
  assert.equal(resolveItemAsset(pack, { itemId: "42", prefabName: "Anything" }).iconUrl, "https://assets.test/data/game-assets/25306743/icons/lantern.png");
  assert.equal(resolveItemAsset(pack, { prefabName: "lantern" }).name, "Lantern");
  const appearance = resolveAppearanceAssets(pack, {
    captured: true, skinIndex: 1, eyesIndex: 2, outfitIndex: 3, hatIndex: 0, effectiveHatIndex: 9,
  });
  assert.equal(appearance.previewKind, "fit-preview");
  assert.equal(appearance.components.hat.entry.name, "Hat");
  assert.equal(appearance.avatarModelUrl, "https://assets.test/data/game-assets/25306743/models/avatar.json");
  Object.assign(pack.customizationIndex.fits.get(3), { overrideHat: true, overrideHatIndex: 9 });
  const legacyHat = resolveAppearanceAssets(pack, { captured: true, outfitIndex: 3, hatIndex: 0 });
  assert.equal(legacyHat.components.hat.entry.name, "Hat", "the feature chip follows the same outfit override as the head renderer");
  assert.equal(await loadGameAssetPack("other-build", { indexUrl, fetchImpl }), null);
});

test("catalog references cannot escape their exact build directory", async () => {
  const indexUrl = "https://assets.test/data/game-assets/catalog.json";
  const fetchImpl = jsonFetch(new Map([
    [indexUrl, { schemaVersion: 1, builds: [{ gameBuildId: "x", catalog: "../private.json" }] }],
  ]));
  await assert.rejects(loadGameAssetPack("x", { indexUrl, fetchImpl }), /不安全/);
  assert.equal(resolveGameAssetUrl({ catalogUrl: new URL("https://assets.test/build/catalog.json") }, "../escape.png"), null);
});

test("fixed inventory layout distinguishes empty, unsynced and unavailable backpack cells", () => {
  assert.equal(canonicalInventoryLocation({ location: "inventory", index: 2 }), "slot/2");
  assert.equal(canonicalInventoryLocation({ location: "backpack", index: 3 }), "backpack/3");
  const definition = PLAYER_BACKPACK_SLOTS[0];
  assert.equal(inventoryVisualState(null, definition).mode, "unknown");
  assert.equal(inventoryVisualState({ captured: true, ready: false }, definition).mode, "syncing");
  assert.equal(inventoryVisualState({ captured: true, ready: true, backpackContentsPresent: false }, definition).mode, "inactive");
  assert.equal(inventoryVisualState({ captured: true, ready: true, backpackContentsPresent: true, backpackContentsReady: false }, definition).mode, "syncing");
  assert.equal(inventoryVisualState({ captured: true, ready: true, backpackContentsPresent: true, backpackContentsReady: true, slots: [] }, definition).mode, "unavailable");
  assert.equal(inventoryVisualState({ captured: true, ready: true, backpackContentsPresent: true, backpackContentsReady: true, slots: [{ location: "backpack/0", index: 0, empty: true, item: null }] }, definition).mode, "empty");
});
