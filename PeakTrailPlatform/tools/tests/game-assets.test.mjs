import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGameAssets, readMergedGameAssets, requireActiveCharacterAssets } from "../lib/game-assets.mjs";

async function fixture(buildId = "123") {
  const root = await mkdtemp(join(tmpdir(), "peak-assets-test-"));
  await mkdir(join(root, buildId, "icons"), { recursive: true });
  const bytes = Buffer.from("test image");
  await writeFile(join(root, buildId, "icons", "item.png"), bytes);
  const build = {
    schemaVersion: 1, gameBuildId: buildId, items: [{ itemId: 1, icon: "icons/item.png" }],
    assets: [{ path: "icons/item.png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
  };
  await writeFile(join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, builds: [{ gameBuildId: buildId, catalog: `${buildId}/catalog.json` }] }));
  const save = () => writeFile(join(root, buildId, "catalog.json"), JSON.stringify(build));
  await save();
  return { root, build, save, clean: () => rm(root, { recursive: true, force: true }) };
}

test("staging allowlist excludes private and unreferenced files", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "123", "private-save.json"), "private");
    const result = await readGameAssets(f.root);
    assert.deepEqual(result.files, ["catalog.json", "123/icons/item.png", "123/catalog.json"]);
  } finally { await f.clean(); }
});

test("game assets reject corruption, missing references and traversal", async () => {
  const f = await fixture();
  try {
    f.build.assets[0].sha256 = "0".repeat(64);
    await f.save();
    await assert.rejects(readGameAssets(f.root), /hash mismatch/);
    f.build.assets = [];
    await f.save();
    await assert.rejects(readGameAssets(f.root), /Unlisted/);
    f.build.assets = [{ path: "../outside.png" }];
    await f.save();
    await assert.rejects(readGameAssets(f.root), /escapes/);
  } finally { await f.clean(); }
});

test("world models and NPC head references must belong to the checksummed allowlist", async () => {
  const f = await fixture();
  try {
    for (const key of ['worldModel', 'headModel', 'model', 'icon']) {
      f.build.worldObjects = [{ objectId: 'MushroomZombie', [key]: '../private-save.json' }];
      await f.save();
      await assert.rejects(readGameAssets(f.root), /Unlisted game asset reference/);
      f.build.worldObjects = [{ objectId: 'MushroomZombie', [key]: 'https://external.invalid/asset.json' }];
      await f.save();
      await assert.rejects(readGameAssets(f.root), /Unlisted game asset reference/);
    }
    f.build.worldObjects = [];
    f.build.items[0].worldModel = 'models/unlisted.json';
    await f.save();
    await assert.rejects(readGameAssets(f.root), /Unlisted game asset reference/);
    f.build.items[0].worldModel = 'icons/item.png';
    f.build.worldObjects = [{ icon: 'icons/item.png', headModel: 'icons/item.png' }];
    await f.save();
    assert.equal((await readGameAssets(f.root)).files.length, 3);
  } finally { await f.clean(); }
});

test("transformed avatar models and heads remain inside the explicit deployment allowlist", async () => {
  const f = await fixture();
  try {
    for (const key of ["model", "headModel"]) {
      f.build.customization = { forms: [{ form: "skeleton", [key]: "models/unlisted.json" }] };
      await f.save();
      await assert.rejects(readGameAssets(f.root), /Unlisted game asset reference/);
      f.build.customization.forms[0][key] = "../private-save.json";
      await f.save();
      await assert.rejects(readGameAssets(f.root), /Unlisted game asset reference/);
    }
    f.build.customization.forms = [{ form: "skeleton", model: "icons/item.png", headModel: "icons/item.png" }];
    await f.save();
    assert.equal((await readGameAssets(f.root)).files.length, 3);
  } finally { await f.clean(); }
});

test("checksummed model materials must include every texture and decoded preview dependency", async t => {
  const f = await fixture(); t.after(f.clean);
  f.build.customization = { avatar: { model: "avatar.json" } };
  const model = { parts: [{ groups: [{ material: { texture: "textures/missing.png" } }] }] };
  async function saveModel() {
    const bytes = Buffer.from(JSON.stringify(model));
    await writeFile(join(f.root, "123", "avatar.json"), bytes);
    f.build.assets = [f.build.assets[0], { path: "avatar.json", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }];
    await f.save();
  }
  await saveModel();
  await assert.rejects(readGameAssets(f.root), /Unlisted game asset reference: textures\/missing.png/);
  model.parts[0].groups[0].material.texture = "icons/item.png";
  model.parts[0].groups[0].material.preview = "../private.png";
  await saveModel();
  await assert.rejects(readGameAssets(f.root), /Unlisted game asset reference/);
  model.parts[0].groups[0].material.preview = "icons/item.png";
  await saveModel();
  const valid = await readGameAssets(f.root);
  assert.ok(valid.files.includes("123/avatar.json"));
  assert.doesNotThrow(() => requireActiveCharacterAssets(valid, "123"));
  assert.throws(() => requireActiveCharacterAssets(valid, "25739797"), /Missing character assets/);
  // Ghost art is additive raw material, but follows the same dependency rules.
  f.build.customization.ghost = { telemetrySupported: false, model: "models/missing-ghost.json" }; await f.save();
  await assert.rejects(readGameAssets(f.root), /Unlisted game asset reference/);
  delete f.build.customization.ghost;
  f.build.items[0].altIcon = "icons/missing.png"; await f.save();
  await assert.rejects(readGameAssets(f.root), /Unlisted game asset reference/);
});

test("archived ghost and state material textures require allowlisted assets without treating source provenance as a dependency", async t => {
  const f = await fixture(); t.after(f.clean);
  const material = { source: { asset: "resources.assets" }, sourceProperties: { textures: [
    { property: "_MainTex", asset: "icons/item.png", source: { asset: "resources.assets" } },
    { property: "_Noise3D", unavailableReason: "source-is-not-a-2d-texture-or-sprite", source: { asset: "sharedassets0.assets" } },
  ] } };
  const model = { parts: [{ groups: [{ material }] }] };
  f.build.customization = { ghost: { model: "ghost.json", telemetrySupported: false }, stateVisuals: { petrified: { material: structuredClone(material) } } };
  async function saveModel() {
    const bytes = Buffer.from(JSON.stringify(model));
    await writeFile(join(f.root, "123", "ghost.json"), bytes);
    f.build.assets = [f.build.assets[0], { path: "ghost.json", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }];
    await f.save();
  }
  await saveModel();
  assert.ok((await readGameAssets(f.root)).files.includes("123/ghost.json"));
  // Both inline state metadata and checksummed model JSON must close references.
  for (const location of ["inline", "model"]) {
    const referencedMaterial = location === "inline" ? f.build.customization.stateVisuals.petrified.material : material;
    for (const reference of ["textures/unlisted.png", "../private.png", "https://external.invalid/texture.png", null, 7]) {
      referencedMaterial.sourceProperties.textures[0].asset = reference;
      await saveModel();
      await assert.rejects(readGameAssets(f.root), /Unlisted archived texture reference/);
    }
    referencedMaterial.sourceProperties.textures[0].asset = "icons/item.png";
    await saveModel();
    await readGameAssets(f.root);
  }
});

test("bundled character builds augment the installed catalog without losing older builds or copying private files", async t => {
  const old = await fixture("25306743"), fresh = await fixture("25739797");
  t.after(old.clean); t.after(fresh.clean);
  await writeFile(join(fresh.root, "25739797", "private-save.json"), "private");
  const merged = await readMergedGameAssets(old.root, fresh.root);
  assert.deepEqual(merged.catalog.builds.map(build => build.gameBuildId), ["25306743", "25739797"]);
  assert.equal(merged.sourceFiles.get("25306743/icons/item.png"), join(old.root, "25306743", "icons", "item.png"));
  assert.equal(merged.sourceFiles.get("25739797/icons/item.png"), join(fresh.root, "25739797", "icons", "item.png"));
  assert.equal(merged.files.length, 5);
  assert.ok(merged.files.every(path => !path.includes("private")));
  const noBundle = await readMergedGameAssets(old.root, join(old.root, "absent"));
  assert.equal(noBundle.catalog.builds.length, 1);
  assert.doesNotThrow(() => requireActiveCharacterAssets(noBundle, undefined));
  assert.throws(() => requireActiveCharacterAssets(noBundle, "25306743"), /Missing character assets/);
  await mkdir(join(old.root, "incomplete-bundle"));
  await assert.rejects(readMergedGameAssets(old.root, join(old.root, "incomplete-bundle")), /ENOENT/);
  await assert.rejects(readMergedGameAssets(join(old.root, "absent"), fresh.root), /ENOENT/);
});

test("duplicate builds are accepted only when both validated catalogs and all checksummed resources agree", async t => {
  const first = await fixture(), second = await fixture();
  t.after(first.clean); t.after(second.clean);
  const merged = await readMergedGameAssets(first.root, second.root);
  assert.equal(merged.catalog.builds.length, 1); assert.equal(merged.files.length, 3);
  assert.equal(merged.sourceFiles.get("123/icons/item.png"), join(first.root, "123", "icons", "item.png"));
  second.build.items[0].name = "different artwork metadata"; await second.save();
  await assert.rejects(readMergedGameAssets(first.root, second.root), /Conflicting game-assets build: 123/);
  delete second.build.items[0].name; await second.save();
  await writeFile(join(second.root, "123", "icons", "item.png"), "corrupted!");
  await assert.rejects(readMergedGameAssets(first.root, second.root), /Game asset (size|hash) mismatch/);
});
