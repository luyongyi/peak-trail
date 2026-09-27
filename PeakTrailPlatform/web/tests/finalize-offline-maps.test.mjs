import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceTools = resolve(testDirectory, "..", "..", "tools");

test("full-build replacement preserves each retired pack id as an explicit alias", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "peaktrail-finalize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const platform = resolve(root, "platform");
  const tools = resolve(platform, "tools");
  const build = resolve(root, "build");
  const assetRoot = resolve(root, "assets");
  await Promise.all([
    mkdir(resolve(tools, "lib"), { recursive: true }),
    mkdir(resolve(platform, "data", "maps"), { recursive: true }),
    mkdir(build, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(resolve(sourceTools, "finalize-offline-maps.mjs"), resolve(tools, "finalize-offline-maps.mjs")),
    copyFile(resolve(sourceTools, "register-map-pack.mjs"), resolve(tools, "register-map-pack.mjs")),
    copyFile(resolve(sourceTools, "lib", "map-pack-identity.mjs"), resolve(tools, "lib", "map-pack-identity.mjs")),
    copyFile(resolve(sourceTools, "lib", "local-paths.mjs"), resolve(tools, "lib", "local-paths.mjs")),
  ]);

  const oldEntries = [];
  const texture = Buffer.from("fixture texture");
  const height = Buffer.alloc(16);
  const geometry = embeddedGlb();
  for (let slot = 0; slot < 21; slot++) {
    const oldId = `sha256-${sha256(Buffer.from(`old-${slot}`))}`;
    oldEntries.push({ mapPackId: oldId, identityVersion: 3, sceneName: `Level_${slot}`, mapSlot: slot,
      gameVersion: "2.4.c", gameBuildId: "25306743", projectionVersion: 1,
      generatedAtUtc: "2026-09-15T00:00:00Z", path: `./packs/${oldId}/map-pack.json`, enabled: true });
    const folder = resolve(build, `Level_${slot}`);
    await mkdir(folder);
    const layers = Array.from({ length: 6 }, (_, segment) => ({
      id: `segment-${segment}`, name: `Segment ${segment}`, segment, biome: `Biome ${segment}`,
      texture: "texture.png", textureSha256: sha256(texture), height: "height.f32", heightSha256: sha256(height),
      columns: 2, rows: 2, minX: -1, maxX: 1, minY: 0, maxY: 1, minZ: -1, maxZ: 1,
      heightEncoding: "float32-le-row-major-minz-minx", noData: "NaN", sampleLocation: "cell-centers",
      validHeightSamples: 4, geometry: "geometry.glb", geometrySha256: sha256(geometry), geometryFormat: "glb-instanced-v1",
    }));
    const manifest = { schemaVersion: 1, identityVersion: 3, mapPackId: `sha256-${"0".repeat(64)}`,
      generatedAtUtc: "2026-09-27T00:00:00Z", gameVersion: "2.4.c", gameBuildId: 25306743,
      sceneName: `Level_${slot}`, mapSlot: slot, projectionVersion: 1, coordinateSpace: "unity-world-meters",
      textureUv: "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)",
      imageOrigin: "bottom-left-in-uv;viewer-flips-for-top-left-images", layers };
    await Promise.all([
      writeFile(resolve(folder, "texture.png"), texture), writeFile(resolve(folder, "height.f32"), height),
      writeFile(resolve(folder, "geometry.glb"), geometry),
      writeFile(resolve(folder, "map-pack.json"), `${JSON.stringify(manifest)}\n`),
    ]);
  }
  await writeFile(resolve(platform, "data", "maps", "catalog.json"), `${JSON.stringify({
    schemaVersion: 1, activeGameBuildId: "25306743", mapPacks: oldEntries,
  })}\n`);

  await execFileAsync(process.execPath, [resolve(tools, "finalize-offline-maps.mjs"), build, "--replace-build"], {
    env: { ...process.env, PEAK_TRAIL_ASSET_ROOT: assetRoot }, maxBuffer: 8 * 1024 * 1024,
  });
  const catalog = JSON.parse(await readFile(resolve(platform, "data", "maps", "catalog.json"), "utf8"));
  assert.equal(catalog.mapPacks.length, 21);
  for (let slot = 0; slot < 21; slot++) {
    const entry = catalog.mapPacks.find((candidate) => candidate.mapSlot === slot);
    assert.ok(entry);
    assert.notEqual(entry.mapPackId, oldEntries[slot].mapPackId);
    assert.deepEqual(entry.supersedesMapPackIds, [oldEntries[slot].mapPackId]);
  }
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function embeddedGlb() {
  const text = JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] });
  const json = Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text) / 4) * 4, " "));
  const bytes = Buffer.alloc(20 + json.length);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  return bytes;
}
