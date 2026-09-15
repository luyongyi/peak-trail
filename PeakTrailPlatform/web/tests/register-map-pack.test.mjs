import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { computeMapPackId } from "../../tools/lib/map-pack-identity.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceTool = resolve(testDirectory, "..", "..", "tools", "register-map-pack.mjs");
const sourceHelper = resolve(testDirectory, "..", "..", "tools", "lib", "map-pack-identity.mjs");
const sourceLocalPaths = resolve(testDirectory, "..", "..", "tools", "lib", "local-paths.mjs");

for (const [identityVersion, isGzip] of [[2, false], [3, false], [3, true]]) test(`registration v${identityVersion}${isGzip ? " gzip" : ""} recomputes identity and verifies assets on idempotent runs`, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "peaktrail-register-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolDirectory = resolve(root, "tools");
  const exportDirectory = resolve(root, "export");
  const assetRoot = resolve(root, "external-assets");
  const executionOptions = { env: { ...process.env, PEAK_TRAIL_ASSET_ROOT: assetRoot } };
  await mkdir(resolve(toolDirectory, "lib"), { recursive: true });
  await mkdir(resolve(root, "data", "maps"), { recursive: true });
  await mkdir(exportDirectory, { recursive: true });
  await Promise.all([
    copyFile(sourceTool, resolve(toolDirectory, "register-map-pack.mjs")),
    copyFile(sourceHelper, resolve(toolDirectory, "lib", "map-pack-identity.mjs")),
    copyFile(sourceLocalPaths, resolve(toolDirectory, "lib", "local-paths.mjs")),
    writeFile(
      resolve(root, "data", "maps", "catalog.json"),
      '{"schemaVersion":1,"activeGameBuildId":null,"mapPacks":[]}\n',
      "utf8",
    ),
  ]);

  const texture = Buffer.from("fixture texture bytes", "utf8");
  const height = Buffer.alloc(16);
  [1.25, 2.5, 3.75, 5].forEach((value, index) => height.writeFloatLE(value, index * 4));
  const manifest = {
    schemaVersion: 1,
    identityVersion,
    mapPackId: `sha256-${"0".repeat(64)}`,
    generatedAtUtc: "2026-09-15T00:00:00Z",
    gameVersion: "2.4.c",
    gameBuildId: 19492001,
    sceneName: "Level_7",
    mapSlot: 7,
    projectionVersion: 1,
    coordinateSpace: "unity-world-meters",
    textureUv: "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)",
    imageOrigin: "bottom-left-in-uv;viewer-flips-for-top-left-images",
    layers: [{
      id: "segment-00-shore",
      name: "Shore",
      segment: 0,
      biome: "Shore",
      texture: "segment-00-shore.png",
      textureSha256: sha256(texture),
      height: "segment-00-shore.height.f32",
      heightSha256: sha256(height),
      columns: 2,
      rows: 2,
      minX: -1.5,
      maxX: 1.5,
      minY: 1.25,
      maxY: 5,
      minZ: -2.5,
      maxZ: 2.5,
      heightEncoding: "float32-le-row-major-minz-minx",
      noData: "NaN",
      sampleLocation: "cell-centers",
      validHeightSamples: 4,
    }],
  };
  const geometry = isGzip ? gzipSync(embeddedGlb()) : embeddedGlb();
  if (identityVersion === 3) Object.assign(manifest.layers[0], {
    geometry: `segment-00-shore.glb${isGzip ? ".gz" : ""}`, geometrySha256: sha256(geometry), geometryFormat: `glb-instanced-v1${isGzip ? "+gzip" : ""}`,
  });
  await Promise.all([
    writeFile(resolve(exportDirectory, manifest.layers[0].texture), texture),
    writeFile(resolve(exportDirectory, manifest.layers[0].height), height),
    writeFile(resolve(exportDirectory, "map-pack.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    ...(identityVersion === 3 ? [writeFile(resolve(exportDirectory, manifest.layers[0].geometry), geometry)] : []),
  ]);

  const localTool = resolve(toolDirectory, "register-map-pack.mjs");
  await assert.rejects(
    execFileAsync(process.execPath, [localTool, exportDirectory], executionOptions),
    (error) => /mapPackId mismatch/.test(`${error.stderr}\n${error.stdout}`),
  );

  manifest.mapPackId = computeMapPackId(manifest);
  await writeFile(resolve(exportDirectory, "map-pack.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await execFileAsync(process.execPath, [localTool, exportDirectory], executionOptions);
  const catalog = JSON.parse(await readFile(resolve(root, "data", "maps", "catalog.json"), "utf8"));
  assert.equal(catalog.mapPacks[0].mapPackId, manifest.mapPackId);
  assert.equal(catalog.mapPacks[0].identityVersion, identityVersion);

  if (identityVersion === 3) {
    const registered = resolve(assetRoot, "maps", "packs", manifest.mapPackId);
    assert.deepEqual(await readFile(resolve(registered, manifest.layers[0].geometry)), geometry);
    await writeFile(resolve(exportDirectory, manifest.layers[0].geometry), "corrupt geometry");
    await assert.rejects(execFileAsync(process.execPath, [localTool, exportDirectory], executionOptions),
      (error) => /geometrySha256 does not match/.test(`${error.stderr}\n${error.stdout}`));
    await writeFile(resolve(exportDirectory, manifest.layers[0].geometry), geometry);

    // Exercise the shipping validator in an isolated platform, including GLB bytes.
    await mkdir(resolve(root, "data", "daily"), { recursive: true });
    await mkdir(resolve(assetRoot, "game-assets"), { recursive: true });
    const platform = resolve(testDirectory, "..", "..");
    await Promise.all([
      copyFile(resolve(platform, "tools", "validate-data.mjs"), resolve(toolDirectory, "validate-data.mjs")),
      copyFile(resolve(platform, "tools", "lib", "game-assets.mjs"), resolve(toolDirectory, "lib", "game-assets.mjs")),
      copyFile(resolve(platform, "data", "daily", "current.json"), resolve(root, "data", "daily", "current.json")),
      copyFile(resolve(platform, "data", "daily", "history.json"), resolve(root, "data", "daily", "history.json")),
      writeFile(resolve(assetRoot, "game-assets", "catalog.json"), '{"schemaVersion":1,"builds":[]}'),
    ]);
    await execFileAsync(process.execPath, [resolve(toolDirectory, "validate-data.mjs")], executionOptions);
    await writeFile(resolve(registered, manifest.layers[0].geometry), "corrupt registered geometry");
    await assert.rejects(execFileAsync(process.execPath, [resolve(toolDirectory, "validate-data.mjs")], executionOptions),
      (error) => /geometrySha256 mismatch/.test(`${error.stderr}\n${error.stdout}`));
    await writeFile(resolve(registered, manifest.layers[0].geometry), geometry);
  }

  await writeFile(resolve(exportDirectory, manifest.layers[0].texture), "corrupted source", "utf8");
  await assert.rejects(
    execFileAsync(process.execPath, [localTool, exportDirectory], executionOptions),
    (error) => /textureSha256 does not match/.test(`${error.stderr}\n${error.stdout}`),
  );
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
