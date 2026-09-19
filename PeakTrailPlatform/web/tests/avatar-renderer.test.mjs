import assert from "node:assert/strict";
import test from "node:test";
import {
  createAvatarCamera,
  createAvatarRenderPlan,
  avatarAppearanceFingerprint,
  headAppearanceFingerprint,
  isHeadAppearanceReady,
  renderHeadPreview,
  resolveAvatarHat,
  selectHeadModelParts,
  selectedTextureReference,
} from "../src/avatar-renderer.js";
import { resolveAppearanceAssets, resolveAppearanceForm } from "../src/game-assets.js";

function headFixture() {
  const entries = {
    skins: [{ index: 0, color: [0.8, 0.4, 0.2, 1] }],
    eyes: [{ index: 5, texture: "eyes-5.png" }],
    mouths: [{ index: 12, texture: "mouth-12.png" }],
    accessories: [{ index: 5, texture: "accessory-5.png" }],
    fits: [],
    hats: [{ index: 0, model: "hat-0.json" }, { index: 2, model: "hat-2.json" }],
    sashes: [],
    medals: [],
  };
  return {
    pack: {
      gameBuildId: "fixture-build",
      catalogUrl: new URL("https://example.test/data/game-assets/fixture-build/catalog.json"),
      customization: { avatar: { model: "avatar-base.json" } },
      customizationIndex: Object.fromEntries(Object.entries(entries)
        .map(([name, values]) => [name, new Map(values.map((entry) => [entry.index, entry]))])),
    },
    appearance: {
      captured: true, ready: true, skinIndex: 0,
      eyesIndex: 5, mouthIndex: 12, accessoryIndex: 5, effectiveHatIndex: 2,
    },
  };
}

test("avatar camera supplies a complete, forward-facing orthographic frustum", () => {
  class OrthographicCamera {
    constructor(...parameters) {
      this.parameters = parameters;
      [this.left, this.right, this.top, this.bottom, this.near, this.far] = parameters;
    }
  }

  const camera = createAvatarCamera({ OrthographicCamera }, 4, 0.75);
  assert.deepEqual(camera.parameters, [-1.5, 1.5, 2, -2, 0.01, 20]);
  assert.equal(camera.parameters.length, 6);
  assert.ok(camera.left < camera.right);
  assert.ok(camera.bottom < camera.top);
  assert.ok(camera.near > 0 && camera.near < 3);
  assert.ok(camera.far > 3);
});

test("avatar face cards use the exact-build decoded mask instead of losing hidden RGB", () => {
  const assets = {
    components: {
      eyes: {
        entry: {
          texture: "textures/raw-eyes.png",
          preview: "previews/eyes-5.png",
          textureEncoding: "peak-face-mask",
        },
      },
      mouth: null,
      accessory: null,
    },
  };

  assert.deepEqual(selectedTextureReference("eyes", assets), {
    reference: "previews/eyes-5.png",
    decodeRole: null,
    faceRole: "eyes",
  });
});

test("head preview uses independent head geometry and excludes every body part", () => {
  const head = { name: "HeadMesh", role: "skin" };
  const eyes = { name: "Eye Card L", role: "eyes" };
  const mouth = { name: "Mouth Card", role: "mouth" };
  const accessory = { name: "Accesory Card", role: "accessory" };
  const body = { name: "BodyMesh", role: "skin" };
  const outfit = { name: "Fit", role: "body" };
  const sash = { name: "Sash", role: "sash" };
  assert.deepEqual(selectHeadModelParts({ parts: [body, head, eyes, outfit, mouth, sash, accessory] }),
    [head, eyes, mouth, accessory]);
  assert.deepEqual(selectHeadModelParts({ parts: [body, eyes, mouth] }), [],
    "a body crop is not a replacement for the real independent head mesh");
});

test("head previews need no outfit, sash or medal model", () => {
  const { pack, appearance } = headFixture();
  assert.equal(appearance.outfitIndex, undefined);
  assert.equal(pack.customizationIndex.fits.size, 0);
  assert.equal(isHeadAppearanceReady(pack, appearance), true);
  assert.equal(isHeadAppearanceReady(pack, { ...appearance, ready: false }), false);
  assert.equal(isHeadAppearanceReady(pack, { ...appearance, captured: false }), false);
  assert.equal(isHeadAppearanceReady(pack, { ...appearance, eyesIndex: 999 }), false);
  assert.equal(isHeadAppearanceReady(pack, { ...appearance, skinIndex: 999 }), false);
  assert.equal(isHeadAppearanceReady(pack, { ...appearance, skinIndex: 999, skinColor: [0.5, 0.6, 0.7] }), true);
  pack.customizationIndex.eyes.get(5).texture = null;
  assert.equal(isHeadAppearanceReady(pack, appearance), false, "missing face art is not a generic fallback");
});

test("head hats follow recorded effective hat, then outfit override, then selected hat", () => {
  const { pack, appearance } = headFixture();
  const hatMaterial = { role: "hat", color: [1, 0, 0, 1] };
  pack.customizationIndex.fits.set(21, { index: 21, overrideHat: true, overrideHatIndex: 0, hatMaterial });
  const selected = { ...appearance, outfitIndex: 21, hatIndex: 2, effectiveHatIndex: undefined };
  assert.equal(resolveAvatarHat(pack, selected).index, 0);
  assert.equal(resolveAvatarHat(pack, selected).material, hatMaterial);
  assert.equal(isHeadAppearanceReady(pack, selected), true, "fit metadata suffices without a fit model");
  assert.equal(resolveAvatarHat(pack, { ...selected, effectiveHatIndex: 2 }).index, 2);
  assert.equal(resolveAvatarHat(pack, { ...selected, outfitIndex: undefined }).index, 2);
  assert.equal(isHeadAppearanceReady(pack, { ...appearance, effectiveHatIndex: 0 }), false,
    "a cap without its recorded outfit fabric must not silently use another fabric");
});

test("third-eye heads require the real dedicated renderer rather than a drawn accessory", () => {
  const { pack, appearance } = headFixture();
  const accessory = pack.customizationIndex.accessories.get(5);
  accessory.isThirdEye = true;
  assert.equal(isHeadAppearanceReady(pack, appearance), false);
  pack.customization.avatar.thirdEyeModel = "models/head-third-eye.json";
  assert.equal(isHeadAppearanceReady(pack, appearance), true);
});

test("head fingerprint separates catalog origins, readiness, face, skin and effective hat", () => {
  const { pack, appearance } = headFixture();
  const original = headAppearanceFingerprint(pack, appearance);
  for (const change of [{ ready: false }, { eyesIndex: 1 }, { mouthIndex: 1 }, { accessoryIndex: 1 },
    { skinColor: [0.2, 0.3, 0.4] }, { effectiveHatIndex: 0 }, { outfitIndex: 21 }]) {
    assert.notEqual(headAppearanceFingerprint(pack, { ...appearance, ...change }), original);
  }
  assert.notEqual(headAppearanceFingerprint({ ...pack, catalogUrl: new URL("https://elsewhere.test/catalog.json") }, appearance), original);
  assert.equal(headAppearanceFingerprint(pack, { ...appearance, sashIndex: 9, medalIndex: 1 }), original);
  assert.equal(headAppearanceFingerprint(pack, { ...appearance, captured: false }), "none");
});

test("concurrent head requests share work but an unavailable render never poisons the cache", async () => {
  const { pack, appearance } = headFixture();
  const first = renderHeadPreview(pack, appearance);
  assert.equal(renderHeadPreview(pack, appearance), first);
  assert.equal(await first, null, "Node has no WebGL document");
  const retry = renderHeadPreview(pack, appearance);
  assert.notEqual(retry, first);
  assert.equal(await retry, null);
});

function addFormFixture(pack) {
  pack.customization.forms = ["skeleton", "mushroom", "chicken"].map((form) => ({
    form, headModel: `forms/${form}-head.json`, model: `forms/${form}.json`,
    retainHat: form !== "mushroom", hatOffset: form === "chicken" ? [0, -0.225622, -0.00773] : [0, 0, 0],
  }));
}

test("recorded transformations render real form heads without human cosmetics or readiness", () => {
  const { pack, appearance } = headFixture(); addFormFixture(pack);
  pack.customizationIndex.accessories.get(5).isThirdEye = true;
  for (const form of ["skeleton", "mushroom", "chicken"]) {
    const transformed = { captured: true, ready: false, formReady: true, form };
    assert.equal(isHeadAppearanceReady(pack, transformed), true);
    const plan = createAvatarRenderPlan(pack, transformed, true);
    assert.equal(plan.models.length, 1, "unknown hats must not be invented");
    assert.ok(plan.models[0].url.endsWith(`/forms/${form}-head.json`));
    assert.equal(plan.models[0].headOnly, true);
    assert.equal(createAvatarRenderPlan(pack, transformed).models[0].url.endsWith(`/forms/${form}.json`), true);
    const dressed = createAvatarRenderPlan(pack, { ...appearance, formReady: true, form }, true);
    assert.equal(dressed.models.length, form === "mushroom" ? 1 : 2);
    assert.equal(dressed.models.some((model) => /third-eye|avatar-base|fit-/.test(model.url)), false);
    if (form === "chicken") assert.deepEqual(dressed.models[1].offset, [0, -0.225622, -0.00773]);
  }
});

test("missing or unsafe transformed resources never fall back to human face or outfit preview", () => {
  const { pack, appearance } = headFixture(); addFormFixture(pack);
  pack.customizationIndex.fits.set(1, { index: 1, preview: "fit.png", model: "fit.json" });
  const skeleton = { ...appearance, outfitIndex: 1, formReady: true, form: "skeleton" };
  pack.customization.forms[0].headModel = "https://unrelated.test/skull.json";
  assert.equal(isHeadAppearanceReady(pack, skeleton), false);
  assert.equal(createAvatarRenderPlan(pack, skeleton, true), null);
  assert.equal(resolveAppearanceAssets(pack, skeleton).previewUrl, null);
  pack.customization.forms = [];
  assert.equal(createAvatarRenderPlan(pack, skeleton), null);
  assert.equal(isHeadAppearanceReady(pack, { ...skeleton, form: "future-form" }), false);
});

test("unknown old form keeps the recorded cosmetic baseline without claiming a normal state", () => {
  const { pack, appearance } = headFixture(); addFormFixture(pack);
  assert.equal(resolveAppearanceForm(pack, appearance).form, "unknown");
  assert.equal(isHeadAppearanceReady(pack, appearance), true);
  assert.equal(resolveAppearanceForm(pack, { ...appearance, form: "skeleton", formReady: false }).transformed, false);
  assert.equal(isHeadAppearanceReady(pack, { ...appearance, form: "unknown", formReady: null }), true);
  for (const failed of [{ form: "unknown", formReady: false }, { form: "unknown", formReady: true },
    { form: "skeleton", formReady: false }]) {
    assert.equal(isHeadAppearanceReady(pack, { ...appearance, ...failed }), false);
    assert.equal(createAvatarRenderPlan(pack, { ...appearance, ...failed }, true), null);
    assert.equal(resolveAppearanceAssets(pack, { ...appearance, ...failed }).previewUrl, null);
  }
  const original = headAppearanceFingerprint(pack, appearance);
  for (const form of ["normal", "skeleton", "mushroom", "chicken"]) {
    assert.notEqual(headAppearanceFingerprint(pack, { ...appearance, formReady: true, form }), original);
    assert.notEqual(avatarAppearanceFingerprint(pack, { ...appearance, formReady: true, form }), avatarAppearanceFingerprint(pack, appearance));
  }
});

test("head selection accepts only explicitly exported form-head topology", () => {
  const head = { role: "form-head", name: "Skeleton Head" };
  const body = { role: "form-body", name: "Skeleton" };
  const eyes = { role: "eyes", name: "Human eye card" };
  assert.deepEqual(selectHeadModelParts({ purpose: "form-head", form: "skeleton", parts: [body, head, eyes] }), [head]);
  assert.deepEqual(selectHeadModelParts({ form: "skeleton", parts: [body, head] }), []);
});
