import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadGameAssetPack, resolveAppearanceForm, resolveAppearanceVisuals } from "../src/game-assets.js";
import { createAvatarRenderPlan, isHeadAppearanceReady, selectHeadModelParts, headAppearanceFingerprint,
  avatarAppearanceFingerprint, stateMaterialPlan } from "../src/avatar-renderer.js";
import { observedAppearanceVisuals, petrificationCoverage } from "../src/appearance-visuals.js";
import { appearanceVisualPresentation, appearanceFormPresentation } from "../src/player-conditions.js";
import { setLocale } from "../src/i18n.js";

const root = new URL("../../data/avatar-assets/25739797/", import.meta.url);
const catalog = JSON.parse(await readFile(new URL("catalog.json", root), "utf8"));
const requests = [];
const pack = await loadGameAssetPack("25739797", { indexUrl: "https://assets.test/catalog.json", fetchImpl: async (url, options) => {
  requests.push({ url: String(url), options });
  return { ok: true, json: async () => String(url).endsWith("/25739797/catalog.json") ? catalog
    : { schemaVersion: 1, builds: [{ gameBuildId: "25739797", catalog: "25739797/catalog.json" }] } };
} });
const normal = { captured: true, ready: true, formReady: true, form: "normal", skinIndex: 0, eyesIndex: 0,
  mouthIndex: 0, accessoryIndex: 0, outfitIndex: 0, hatIndex: 0, sashIndex: 0, medalIndex: 0 };
const ghost = { ...normal, form: "ghost", ghostReady: true, ghostActive: true, ghostVisible: false,
  ghostPosition: [10, 20, 30], ghostRotation: [0, 0, 0, 1] };
const stone = { ...normal, petrificationReady: true, petrificationActive: true,
  petrificationAmount: .625, petrificationProgress: .5, petrificationTriggered: true };
const blind = { ...normal, blindnessReady: true, blindnessActive: true };

test("mutable exact-build catalogs revalidate while recording no cross-build fallback", () => {
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.options.cache === "no-cache"));
  assert.equal(pack.gameBuildId, "25739797");
});

test("real ghost owner face and third eye render without ordinary hats, clothes, sash or medal", async () => {
  for (const headOnly of [true, false]) {
    const plan = createAvatarRenderPlan(pack, ghost, headOnly);
    assert.ok(plan); assert.equal(plan.hat, null); assert.equal(plan.models.length, 1);
    assert.match(plan.models[0].url, /models\/forms\/ghost(?:-head)?\.json$/);
    assert.equal(plan.assets.components.eyes.entry.index, ghost.eyesIndex);
    const third = createAvatarRenderPlan(pack, { ...ghost, accessoryIndex: 20 }, headOnly);
    assert.equal(third.models.length, 2); assert.match(third.models[1].url, /ghost-third-eye-live\.json$/);
  }
  const model = JSON.parse(await readFile(new URL(catalog.customization.ghost.headModel, root), "utf8"));
  assert.equal(selectHeadModelParts(model).length, model.parts.length, "the original whole ghost is the honest portrait; no invented human head");
  assert.ok(selectHeadModelParts(model).some(part => part.role === "ghost-body"));
  assert.equal(appearanceFormPresentation(ghost).known, true, "native local-view hiding does not erase the spectator's observed entity");
});

test("ghost requires owner cosmetics and current entity evidence rather than death or old flags", () => {
  for (const appearance of [{ ...ghost, ready: false }, { ...ghost, eyesIndex: null }, { ...ghost, skinIndex: null },
    { ...ghost, ghostReady: false }, { ...ghost, ghostActive: false }, { ...ghost, ghostReady: null }]) {
    assert.equal(isHeadAppearanceReady(pack, appearance), false);
    assert.equal(createAvatarRenderPlan(pack, appearance, true), null);
    assert.equal(createAvatarRenderPlan(pack, appearance, false), null);
  }
  const archived = { ...pack, customization: { ...pack.customization, ghost: { ...pack.customization.ghost, telemetrySupported: false } } };
  assert.equal(resolveAppearanceForm(archived, ghost).modelUrl, null);
  assert.equal(createAvatarRenderPlan(archived, ghost), null);
  assert.equal(observedAppearanceVisuals({ dead: true }).ghost.active, false);
});

test("stone uses the source separate head, native curve value, and original tint and crack layer", async () => {
  const plan = createAvatarRenderPlan(pack, stone, true), visual = plan.visuals[0];
  assert.equal(visual.state, "petrification"); assert.equal(visual.amount, .625); assert.equal(visual.coverage, .5);
  assert.match(plan.models.at(-1).url, /states\/petrification-head\.json$/);
  const head = JSON.parse(await readFile(new URL(catalog.customization.stateVisuals.petrification.headModel, root), "utf8"));
  assert.equal(head.parts.length, 1); assert.equal(head.parts[0].source.mesh.name, "Statue head");
  const material = stateMaterialPlan(head.parts[0].groups[0].material, visual);
  assert.equal(material.opacity, .5); assert.equal(material.amount, .625);
  assert.match(material.texture, /A_Crack-3/); assert.equal(material.unlit, false);
  const entry = catalog.customization.stateVisuals.petrification;
  assert.equal(petrificationCoverage(.5, entry), 0); assert.equal(petrificationCoverage(.75, entry), 1);
  assert.equal(petrificationCoverage(100, entry), 1, "display is bounded without rewriting the native amount");
  assert.equal(petrificationCoverage(null, entry), null);
});

test("blind card and stone can coexist at their source positions; status values never activate them", async () => {
  const overlap = { ...stone, ...blind, petrificationReady: true, petrificationActive: true,
    petrificationAmount: stone.petrificationAmount, petrificationProgress: stone.petrificationProgress };
  const plan = createAvatarRenderPlan(pack, overlap, true);
  assert.deepEqual(plan.visuals.map(visual => visual.state), ["petrification", "blindness"]);
  assert.match(plan.models.at(-1).url, /states\/blindness\.json$/);
  assert.equal(plan.models.at(-1).offset, undefined, "never invent a new face-card height or position");
  const model = JSON.parse(await readFile(new URL(catalog.customization.stateVisuals.blindness.model, root), "utf8"));
  const material = stateMaterialPlan(model.parts[0].groups[0].material, plan.visuals[1]);
  assert.match(material.texture, /Blind-/); assert.equal(material.unlit, true);
  assert.deepEqual(resolveAppearanceVisuals(pack, { ...normal, status: { values: [{ type: "Petrify", amount: 1 }], effects: [{ type: "Blind" }] } }), []);
  assert.deepEqual(resolveAppearanceVisuals(pack, { ...overlap, ...ghost }), [], "character overlays do not attach to a separate PlayerGhost prefab");
});

test("missing active overlay assets cannot silently display an ordinary healthy portrait", () => {
  const noHead = { ...pack, customization: { ...pack.customization, stateVisuals: { ...pack.customization.stateVisuals,
    petrification: { ...pack.customization.stateVisuals.petrification, headModel: null } } } };
  assert.equal(createAvatarRenderPlan(noHead, stone, true), null);
  assert.ok(createAvatarRenderPlan(noHead, stone, false));
  assert.equal(createAvatarRenderPlan(pack, { ...stone, petrificationAmount: null }), null);
});

test("clearing, unknown and changed observed visual values cannot reuse earlier portrait cache entries", () => {
  for (const fingerprint of [headAppearanceFingerprint, avatarAppearanceFingerprint]) {
    const snapshots = [normal, ghost, stone, blind, { ...stone, petrificationAmount: .7 },
      { ...stone, petrificationReady: false, petrificationActive: null },
      { ...stone, petrificationReady: true, petrificationActive: false }, { ...blind, blindnessReady: false, blindnessActive: null }];
    assert.equal(new Set(snapshots.map(appearance => fingerprint(pack, appearance))).size, snapshots.length);
    assert.equal(fingerprint(pack, ghost), fingerprint(pack, { ...ghost, ghostPosition: [99, 88, 77] }), "world translation alone must not continuously rerender the portrait");
  }
  for (const state of [{ ...stone, petrificationReady: false }, { ...stone, petrificationActive: false },
    { ...blind, blindnessReady: false }, { ...blind, blindnessActive: false }]) {
    assert.deepEqual(createAvatarRenderPlan(pack, state, true).visuals, []);
  }
});

test("observed visual labels localize and distinguish explicit clear from unknown", () => {
  try {
    setLocale("zh-CN"); assert.equal(appearanceVisualPresentation(stone)[0].label, "石化 50%");
    assert.equal(appearanceVisualPresentation(blind)[0].label, "失明");
    assert.deepEqual(appearanceVisualPresentation({ ...stone, petrificationActive: false }), []);
    assert.match(appearanceVisualPresentation({ ...blind, blindnessReady: false })[0].label, /未确认/);
    setLocale("en"); assert.equal(appearanceVisualPresentation(stone)[0].label, "Petrification 50%");
    assert.equal(appearanceVisualPresentation(ghost)[0].label, "Ghost");
  } finally { setLocale("zh-CN"); }
});
