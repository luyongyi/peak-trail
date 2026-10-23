import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t, build, count) {
  const root = await mkdtemp(resolve(tmpdir(), "peak-finalize-count-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const platform = resolve(root, "PeakTrailPlatform"), input = resolve(root, "input");
  await mkdir(resolve(platform, "tools/lib"), { recursive: true });
  await mkdir(resolve(platform, "data/maps"), { recursive: true });
  await copyFile(resolve(source, "finalize-offline-maps.mjs"), resolve(platform, "tools/finalize-offline-maps.mjs"));
  await copyFile(resolve(source, "lib/map-pack-identity.mjs"), resolve(platform, "tools/lib/map-pack-identity.mjs"));
  const catalog = JSON.stringify({ activeGameBuildId: build, mapPacks: [{ sceneName: "Level_207", keep: true }] });
  await writeFile(resolve(platform, "data/maps/catalog.json"), catalog);
  const originals = [];
  for (let slot = 0; slot < count; slot++) {
    const path = resolve(input, `Level_${slot}/map-pack.json`);
    await mkdir(dirname(path), { recursive: true });
    const bytes = JSON.stringify({ gameBuildId: build, identityVersion: 3, sceneName: `Level_${slot}`, mapSlot: slot,
      layers: Array.from({ length: 6 }, (_, i) => ({ geometry: `segment-${i}.glb.gz`,
        geometrySha256: "a".repeat(64), geometryFormat: "glb-instanced-v1+gzip" })) });
    await writeFile(path, bytes);
    originals.push([path, bytes]);
  }
  return {
    async run(args) { return exec(process.execPath, [resolve(platform, "tools/finalize-offline-maps.mjs"), input, ...args]); },
    async unchanged() {
      assert.equal(await readFile(resolve(platform, "data/maps/catalog.json"), "utf8"), catalog);
      for (const [path, bytes] of originals) assert.equal(await readFile(path, "utf8"), bytes);
      assert.deepEqual((await readdir(root)).sort(), ["PeakTrailPlatform", "input"]);
    },
  };
}

test("208-map builds reject omitted or smaller counts before catalog backup, registration or source changes", async t => {
  const f = await fixture(t, 26134529, 21);
  for (const count of [[], ["--map-count", "21"], ["--map-count", "128"]]) {
    for (const mode of [[], ["--replace-build"]]) {
      await assert.rejects(f.run([...count, ...mode]), error => /requires explicit --map-count 208/.test(error.stderr));
      await f.unchanged();
    }
  }
});

test("explicit 208 still requires the complete pool and legacy default still checks all 21 slots", async t => {
  const current = await fixture(t, "26134529", 21);
  await assert.rejects(current.run(["--map-count", "208", "--replace-build"]),
    error => error.stderr.includes("ENOENT") && error.stderr.includes("Level_21"));
  await current.unchanged();
  const legacy = await fixture(t, 25306743, 20);
  await assert.rejects(legacy.run(["--replace-build"]),
    error => error.stderr.includes("ENOENT") && error.stderr.includes("Level_20"));
  await legacy.unchanged();
});
