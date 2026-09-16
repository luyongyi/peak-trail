import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const platformSource = resolve(testDirectory, "..", "..");

test("stage enriches exact-pack route metadata, allowlists assets and preserves output on failed preflight", async (t) => {
  const repository = await mkdtemp(resolve(tmpdir(), "peaktrail-stage-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const platform = resolve(repository, "PeakTrailPlatform");
  const tools = resolve(platform, "tools");
  const assets = resolve(repository, "separate-assets");
  const packId = `sha256-${"a".repeat(64)}`;
  const pack = resolve(assets, "maps", "packs", packId);
  const gameAssets = resolve(assets, "game-assets");
  const schemas = [
    "daily-map.schema.json", "map-catalog.schema.json", "map-pack.schema.json",
    "peaktrace-manifest.schema.json", "peaktrace-stream.schema.json", "peaktrace-history.schema.json",
    "peaktrace-route.schema.json",
  ];

  await Promise.all([
    mkdir(resolve(tools, "lib"), { recursive: true }),
    mkdir(resolve(platform, "web", "src"), { recursive: true }),
    mkdir(resolve(platform, "vendor"), { recursive: true }),
    mkdir(resolve(platform, "data", "daily"), { recursive: true }),
    mkdir(resolve(platform, "data", "maps"), { recursive: true }),
    mkdir(resolve(platform, "schema"), { recursive: true }),
    mkdir(pack, { recursive: true }),
    mkdir(resolve(gameAssets, "123", "icons"), { recursive: true }),
    mkdir(resolve(repository, "local", "recordings"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(resolve(platformSource, "tools", "stage-site.mjs"), resolve(tools, "stage-site.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "game-assets.mjs"), resolve(tools, "lib", "game-assets.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "local-paths.mjs"), resolve(tools, "lib", "local-paths.mjs")),
    writeFile(resolve(platform, "web", "index.html"), "<!doctype html>"),
    writeFile(resolve(platform, "web", "styles.css"), "body{}"),
    writeFile(resolve(platform, "web", "src", "app.js"), "export {};"),
    writeFile(resolve(platform, "vendor", "notice.txt"), "fixture"),
    writeFile(resolve(platform, "data", "daily", "current.json"), "{}"),
    writeFile(resolve(repository, "local", "recordings", "private-session.ndjson"), "private trail"),
  ]);
  await Promise.all(schemas.map((name) => writeFile(resolve(platform, "schema", name), "{}")));

  const texture = Buffer.from("texture");
  const height = Buffer.alloc(16);
  const geometry = Buffer.from("geometry");
  const item = Buffer.from("item icon");
  const manifest = {
    identityVersion: 3,
    mapPackId: packId,
    gameBuildId: "123",
    sceneName: "Level_0",
    mapSlot: 0,
    source: { sceneSha256: "b".repeat(64) },
    layers: [[0, "Shore"], [3, "Volcano"], [4, "Volcano"]].map(([segment, biome]) => ({
      segment,
      biome,
      texture: "shore.png",
      height: "shore.height.f32",
      geometry: "shore.glb.gz",
    })),
  };
  const manifestBytes = JSON.stringify(manifest);
  const route = {
    authority: "serialized-map-handler",
    branch: "volcano-kiln",
    segments: [
      { index: 0, biome: "Shore", biomeId: 0, name: "Beach_Segment" },
      { index: 3, biome: "Volcano", biomeId: 3, name: "Caldera_Segment", displayName: "火山" },
      { index: 4, biome: "Volcano", biomeId: 3, name: "Volcano_Segment", displayName: "熔炉" },
    ],
  };
  const evidence = {
    schemaVersion: 1,
    gameBuildId: "123",
    maps: [{
      mapPackId: packId,
      sceneName: manifest.sceneName,
      mapSlot: manifest.mapSlot,
      sourceSceneSha256: manifest.source.sceneSha256,
      route,
    }],
  };
  const evidencePath = resolve(platform, "data", "maps", "routes.123.json");
  const buildCatalog = {
    schemaVersion: 1,
    gameBuildId: "123",
    items: [{ itemId: 1, icon: "icons/item.png" }],
    assets: [{ path: "icons/item.png", bytes: item.length, sha256: sha256(item) }],
  };
  await Promise.all([
    writeFile(resolve(platform, "data", "maps", "catalog.json"), JSON.stringify({
      schemaVersion: 1,
      mapPacks: [{ mapPackId: packId, path: `./packs/${packId}/map-pack.json` }],
    })),
    writeFile(resolve(pack, "map-pack.json"), manifestBytes),
    writeFile(evidencePath, JSON.stringify(evidence)),
    writeFile(resolve(pack, "shore.png"), texture),
    writeFile(resolve(pack, "shore.height.f32"), height),
    writeFile(resolve(pack, "shore.glb.gz"), geometry),
    writeFile(resolve(pack, "private-session.ndjson"), "must not publish"),
    writeFile(resolve(gameAssets, "catalog.json"), JSON.stringify({
      schemaVersion: 1,
      builds: [{ gameBuildId: "123", catalog: "123/catalog.json" }],
    })),
    writeFile(resolve(gameAssets, "123", "catalog.json"), JSON.stringify(buildCatalog)),
    writeFile(resolve(gameAssets, "123", "icons", "item.png"), item),
  ]);

  const options = { env: { ...process.env, PEAK_TRAIL_ASSET_ROOT: assets } };
  await execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options);
  const staged = resolve(platform, "site-dist");
  const stagedManifestPath = resolve(staged, "data", "maps", "packs", packId, "map-pack.json");
  const stagedManifestBytes = await readFile(stagedManifestPath, "utf8");
  const stagedManifest = JSON.parse(stagedManifestBytes);
  assert.deepEqual(stagedManifest.route, route);
  assert.equal(stagedManifest.mapPackId, packId);
  assert.deepEqual(stagedManifest.layers, manifest.layers);
  assert.equal(await readFile(resolve(pack, "map-pack.json"), "utf8"), manifestBytes);
  assert.deepEqual(await readFile(resolve(staged, "data", "maps", "packs", packId, "shore.glb.gz")), geometry);
  assert.deepEqual(await readFile(resolve(staged, "data", "game-assets", "123", "icons", "item.png")), item);
  await assert.rejects(access(resolve(staged, "data", "maps", "packs", packId, "private-session.ndjson")));
  await assert.rejects(access(resolve(staged, "local", "recordings", "private-session.ndjson")));

  await writeFile(resolve(staged, "preflight-marker.txt"), "keep on failure");
  for (const [field, invalidValue] of [
    ["sceneName", "Level_1"],
    ["mapSlot", 1],
    ["sourceSceneSha256", "c".repeat(64)],
  ]) {
    const invalid = structuredClone(evidence);
    invalid.maps[0][field] = invalidValue;
    await writeFile(evidencePath, JSON.stringify(invalid));
    await assert.rejects(
      execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options),
      (error) => /Route evidence identity mismatch/.test(`${error.stderr}\n${error.stdout}`),
      `wrong ${field} must fail before replacing the previous site`,
    );
    assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
    assert.equal(await readFile(stagedManifestPath, "utf8"), stagedManifestBytes);
    assert.equal(await readFile(resolve(pack, "map-pack.json"), "utf8"), manifestBytes);
  }

  const wrongBiome = structuredClone(evidence);
  wrongBiome.maps[0].route.segments[2].biome = "Swamp";
  await writeFile(evidencePath, JSON.stringify(wrongBiome));
  await assert.rejects(
    execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options),
    (error) => /Route evidence disagrees with geometry/.test(`${error.stderr}\n${error.stdout}`),
  );
  assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
  assert.equal(await readFile(stagedManifestPath, "utf8"), stagedManifestBytes);

  await writeFile(evidencePath, JSON.stringify(evidence));
  await rm(resolve(pack, "shore.glb.gz"));
  await assert.rejects(
    execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options),
    (error) => /Local map asset is missing:.*PEAK_TRAIL_ASSET_ROOT/s.test(`${error.stderr}\n${error.stdout}`),
  );
  assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
