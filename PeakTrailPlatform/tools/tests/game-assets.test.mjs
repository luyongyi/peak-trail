import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGameAssets } from "../lib/game-assets.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "peak-assets-test-"));
  await mkdir(join(root, "123", "icons"), { recursive: true });
  const bytes = Buffer.from("test image");
  await writeFile(join(root, "123", "icons", "item.png"), bytes);
  const build = {
    schemaVersion: 1, gameBuildId: "123", items: [{ itemId: 1, icon: "icons/item.png" }],
    assets: [{ path: "icons/item.png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
  };
  await writeFile(join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, builds: [{ gameBuildId: "123", catalog: "123/catalog.json" }] }));
  const save = () => writeFile(join(root, "123", "catalog.json"), JSON.stringify(build));
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
