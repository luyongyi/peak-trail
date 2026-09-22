import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { HOME_ART_FILES } from "../../web/src/home-art.js";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const platformSource = resolve(testDirectory, "..", "..");

test("stage enriches exact-pack sidecars, deduplicates enclosures, allowlists assets and preserves output on failed preflight", async (t) => {
  const repository = await mkdtemp(resolve(tmpdir(), "peaktrail-stage-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const platform = resolve(repository, "PeakTrailPlatform");
  const tools = resolve(platform, "tools");
  const assets = resolve(repository, "separate-assets");
  const packId = `sha256-${"a".repeat(64)}`;
  const pack = resolve(assets, "maps", "packs", packId);
  const secondPackId = `sha256-${"d".repeat(64)}`;
  const secondPack = resolve(assets, "maps", "packs", secondPackId);
  const enclosures = resolve(assets, "maps", "enclosures");
  const gameAssets = resolve(assets, "game-assets");
  const schemas = [
    "daily-map.schema.json", "map-catalog.schema.json", "map-pack.schema.json",
    "peaktrace-manifest.schema.json", "peaktrace-stream.schema.json", "peaktrace-history.schema.json",
    "peaktrace-route.schema.json",
    "peaktrace-world.schema.json",
    "peaktrace-status.schema.json",
  ];

  await Promise.all([
    mkdir(resolve(tools, "lib"), { recursive: true }),
    mkdir(resolve(platform, "web", "src"), { recursive: true }),
    mkdir(resolve(platform, "vendor"), { recursive: true }),
    mkdir(resolve(platform, "data", "daily"), { recursive: true }),
    mkdir(resolve(platform, "data", "maps"), { recursive: true }),
    mkdir(resolve(platform, "schema"), { recursive: true }),
    mkdir(pack, { recursive: true }),
    mkdir(secondPack, { recursive: true }),
    mkdir(resolve(enclosures, "private"), { recursive: true }),
    mkdir(resolve(gameAssets, "123", "icons"), { recursive: true }),
    mkdir(resolve(assets, "home-art"), { recursive: true }),
    mkdir(resolve(repository, "local", "recordings"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(resolve(platformSource, "tools", "stage-site.mjs"), resolve(tools, "stage-site.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "game-assets.mjs"), resolve(tools, "lib", "game-assets.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "local-paths.mjs"), resolve(tools, "lib", "local-paths.mjs")),
    copyFile(resolve(platformSource, "web", "src", "map-fog.js"), resolve(platform, "web", "src", "map-fog.js")),
    copyFile(resolve(platformSource, "web", "src", "map-water.js"), resolve(platform, "web", "src", "map-water.js")),
    copyFile(resolve(platformSource, "web", "src", "map-enclosures.js"), resolve(platform, "web", "src", "map-enclosures.js")),
    copyFile(resolve(platformSource, "web", "src", "home-art.js"), resolve(platform, "web", "src", "home-art.js")),
    writeFile(resolve(platform, "web", "index.html"), "<!doctype html>"),
    writeFile(resolve(platform, "web", "styles.css"), "body{}"),
    writeFile(resolve(platform, "web", "home.css"), ".home-page{}"),
    writeFile(resolve(platform, "web", "src", "app.js"), "export {};"),
    writeFile(resolve(platform, "vendor", "notice.txt"), "fixture"),
    writeFile(resolve(platform, "data", "daily", "current.json"), "{}"),
    writeFile(resolve(repository, "local", "recordings", "private-session.ndjson"), "private trail"),
  ]);
  await Promise.all(HOME_ART_FILES.map(file => writeFile(resolve(assets, 'home-art', file), 'illustration fixture')));
  const retiredHomeArt = ['volcano-v1.png', 'swamp-v1.png'];
  await Promise.all(retiredHomeArt.map(file => writeFile(resolve(assets, 'home-art', file), 'retired illustration')));
  await writeFile(resolve(assets, 'home-art', 'private-session.ndjson'), 'not public');
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
  const secondManifest = { ...manifest, mapPackId: secondPackId, sceneName: 'Level_1', mapSlot: 1,
    source: { sceneSha256: 'c'.repeat(64) } };
  const secondManifestBytes = JSON.stringify(secondManifest);
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
  const fogEvidence = { schemaVersion: 1, gameBuildId: '123', authority: 'serialized-map-baseline', maps: [{
    mapPackId: packId, sceneName: manifest.sceneName, mapSlot: manifest.mapSlot,
    sourceSceneSha256: manifest.source.sceneSha256, volumes: [],
  }] };
  const fogPath = resolve(platform, 'data', 'maps', 'fog.123.json');
  const waterSurface = {
    objectId: 'map-water:fixture:1', kind: 'ocean', segment: 0,
    source: 'serialized-global-water-renderer', sourceRendererPathId: 1,
    corners: [[-2500, -1, -2500], [2500, -1, -2500], [2500, -1, 2500], [-2500, -1, 2500]],
    material: { name: 'FixtureWater', shader: 'GD/Water-GD', asset: 'fixture.assets', pathId: 1,
      colorProperty: '_WaterColorPrimary', storedColor: [0.2, 0.5, 0.6, 0], linearColor: [0.03, 0.21, 0.32] },
  };
  const waterEvidence = { schemaVersion: 1, gameBuildId: '123', authority: 'serialized-map-baseline', maps: [{
    mapPackId: packId, sceneName: manifest.sceneName, mapSlot: manifest.mapSlot,
    sourceSceneSha256: manifest.source.sceneSha256, surfaces: [waterSurface],
  }] };
  const waterPath = resolve(platform, 'data', 'maps', 'water.123.json');
  const enclosureBytes = Buffer.from('content-addressed enclosure staging fixture');
  const enclosureHash = sha256(enclosureBytes);
  const enclosureFilename = `${enclosureHash}.glb.gz`;
  const enclosureFile = resolve(enclosures, enclosureFilename);
  const enclosure = {
    objectId: 'map-enclosure:fixture:1', segment: 4, sourceRootPathId: 1, sourceRootName: 'Fixture enclosure',
    geometry: enclosureFilename, geometrySha256: enclosureHash, geometryFormat: 'glb-instanced-v1+gzip',
    meshBounds: { min: [-10, 20, -10], max: [10, 50, 10] },
    interiorReference: [0, 30, 0], interiorReferenceSource: 'source-model-axis',
  };
  const enclosureEvidence = { schemaVersion: 1, gameBuildId: '123', authority: 'serialized-map-enclosure',
    maps: [manifest, secondManifest].map(value => ({ mapPackId: value.mapPackId, sceneName: value.sceneName,
      mapSlot: value.mapSlot, sourceSceneSha256: value.source.sceneSha256, enclosures: [enclosure] })) };
  const enclosureEvidencePath = resolve(platform, 'data', 'maps', 'enclosures.123.json');
  const buildCatalog = {
    schemaVersion: 1,
    gameBuildId: "123",
    items: [{ itemId: 1, icon: "icons/item.png" }],
    assets: [{ path: "icons/item.png", bytes: item.length, sha256: sha256(item) }],
  };
  await Promise.all([
    writeFile(resolve(platform, "data", "maps", "catalog.json"), JSON.stringify({
      schemaVersion: 1,
      mapPacks: [packId, secondPackId].map(value => ({ mapPackId: value, path: `./packs/${value}/map-pack.json` })),
    })),
    writeFile(resolve(pack, "map-pack.json"), manifestBytes),
    writeFile(resolve(secondPack, "map-pack.json"), secondManifestBytes),
    writeFile(evidencePath, JSON.stringify(evidence)),
    writeFile(fogPath, JSON.stringify(fogEvidence)),
    writeFile(waterPath, JSON.stringify(waterEvidence)),
    writeFile(enclosureEvidencePath, JSON.stringify(enclosureEvidence)),
    writeFile(enclosureFile, enclosureBytes),
    writeFile(resolve(enclosures, 'unused.glb.gz'), 'unreferenced geometry must not publish'),
    writeFile(resolve(enclosures, 'private-session.ndjson'), 'private trail must not publish'),
    writeFile(resolve(enclosures, 'private', 'secret.txt'), 'private nested file must not publish'),
    writeFile(resolve(pack, "shore.png"), texture),
    writeFile(resolve(pack, "shore.height.f32"), height),
    writeFile(resolve(pack, "shore.glb.gz"), geometry),
    writeFile(resolve(secondPack, "shore.png"), texture),
    writeFile(resolve(secondPack, "shore.height.f32"), height),
    writeFile(resolve(secondPack, "shore.glb.gz"), geometry),
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
  assert.deepEqual((await readdir(resolve(staged, 'data', 'home-art'))).sort(), [...HOME_ART_FILES].sort(), 'publish every illustration, and no neighboring private files');
  for (const file of retiredHomeArt) await assert.rejects(access(resolve(staged, 'data', 'home-art', file)), { code: 'ENOENT' }, 'do not publish retired illustration versions');
  const stagedManifestPath = resolve(staged, "data", "maps", "packs", packId, "map-pack.json");
  const stagedManifestBytes = await readFile(stagedManifestPath, "utf8");
  const stagedManifest = JSON.parse(stagedManifestBytes);
  assert.deepEqual(stagedManifest.route, route);
  assert.deepEqual(stagedManifest.mapFog.volumes, []);
  assert.equal(stagedManifest.mapFog.authority, 'serialized-map-baseline');
  assert.deepEqual(stagedManifest.mapWater.surfaces, [waterSurface]);
  assert.equal(stagedManifest.mapWater.authority, 'serialized-map-baseline');
  assert.equal(stagedManifest.mapWater.sourceSceneSha256, manifest.source.sceneSha256);
  assert.equal(stagedManifest.mapWater.mapPackId, packId);
  assert.deepEqual(stagedManifest.mapEnclosures.enclosures, [enclosure]);
  assert.equal(stagedManifest.mapEnclosures.authority, 'serialized-map-enclosure');
  assert.equal(stagedManifest.mapEnclosures.mapPackId, packId);
  assert.equal(stagedManifest.mapEnclosures.sourceSceneSha256, manifest.source.sceneSha256);
  assert.equal(stagedManifest.mapPackId, packId);
  assert.deepEqual(stagedManifest.layers, manifest.layers);
  assert.equal(await readFile(resolve(pack, "map-pack.json"), "utf8"), manifestBytes);
  assert.deepEqual(await readFile(resolve(staged, "data", "maps", "packs", packId, "shore.glb.gz")), geometry);
  assert.deepEqual(await readFile(resolve(staged, "data", "game-assets", "123", "icons", "item.png")), item);
  await assert.rejects(access(resolve(staged, "data", "maps", "packs", packId, "private-session.ndjson")));
  await assert.rejects(access(resolve(staged, "local", "recordings", "private-session.ndjson")));
  const stagedEnclosures = resolve(staged, 'data', 'maps', 'enclosures');
  assert.deepEqual(await readdir(stagedEnclosures), [enclosureFilename], 'only the referenced shared geometry is published, not neighboring private data');
  assert.deepEqual(await readFile(resolve(stagedEnclosures, enclosureFilename)), enclosureBytes);
  const stagedSecond = JSON.parse(await readFile(resolve(staged, 'data', 'maps', 'packs', secondPackId, 'map-pack.json'), 'utf8'));
  assert.deepEqual(stagedSecond.mapEnclosures.enclosures, [enclosure]);
  assert.equal(stagedSecond.mapEnclosures.mapPackId, secondPackId);
  assert.equal(stagedSecond.mapEnclosures.sourceSceneSha256, secondManifest.source.sceneSha256);
  assert.equal(stagedSecond.mapPackId, secondPackId);
  assert.deepEqual(stagedSecond.layers, secondManifest.layers);
  for (const id of [packId, secondPackId]) {
    await assert.rejects(access(resolve(staged, 'data', 'maps', 'packs', id, enclosureFilename)), 'shared geometry must not be duplicated inside each pack');
  }
  assert.equal(await readFile(resolve(secondPack, 'map-pack.json'), 'utf8'), secondManifestBytes);

  await writeFile(resolve(staged, "preflight-marker.txt"), "keep on failure");
  const invalidFog = structuredClone(fogEvidence);
  invalidFog.maps[0].sourceSceneSha256 = '0'.repeat(64);
  await writeFile(fogPath, JSON.stringify(invalidFog));
  await assert.rejects(execFileAsync(process.execPath, [resolve(tools, 'stage-site.mjs')], options), /Map fog evidence identity or field mismatch/);
  assert.equal(await readFile(resolve(staged, 'preflight-marker.txt'), 'utf8'), 'keep on failure');
  await writeFile(fogPath, JSON.stringify(fogEvidence));
  for (const invalidate of [
    value => { value.maps[0].sourceSceneSha256 = '0'.repeat(64); },
    value => { value.maps[0].surfaces[0].corners[0][1] = 2; },
    value => { value.maps[0].surfaces[0].segment = 4; },
  ]) {
    const invalidWater = structuredClone(waterEvidence);
    invalidate(invalidWater);
    await writeFile(waterPath, JSON.stringify(invalidWater));
    await assert.rejects(execFileAsync(process.execPath, [resolve(tools, 'stage-site.mjs')], options), /Map water evidence identity or plane mismatch/);
    assert.equal(await readFile(resolve(staged, 'preflight-marker.txt'), 'utf8'), 'keep on failure');
    assert.equal(await readFile(stagedManifestPath, 'utf8'), stagedManifestBytes);
    assert.equal(await readFile(resolve(pack, 'map-pack.json'), 'utf8'), manifestBytes);
  }
  await writeFile(waterPath, JSON.stringify(waterEvidence));
  async function assertEnclosureFailurePreservesSite(pattern) {
    await assert.rejects(execFileAsync(process.execPath, [resolve(tools, 'stage-site.mjs')], options), pattern);
    assert.equal(await readFile(resolve(staged, 'preflight-marker.txt'), 'utf8'), 'keep on failure');
    assert.equal(await readFile(stagedManifestPath, 'utf8'), stagedManifestBytes);
    assert.deepEqual(await readFile(resolve(stagedEnclosures, enclosureFilename)), enclosureBytes);
    assert.equal(await readFile(resolve(pack, 'map-pack.json'), 'utf8'), manifestBytes);
    assert.equal(await readFile(resolve(secondPack, 'map-pack.json'), 'utf8'), secondManifestBytes);
  }
  for (const invalidate of [
    value => { value.maps[0].sourceSceneSha256 = '0'.repeat(64); },
    value => { value.maps[0].sceneName = 'Level_2'; },
    value => { value.maps[0].mapSlot = 2; },
    value => { value.maps[0].enclosures[0].geometry = `../${enclosureFilename}`; },
    value => { value.maps[0].enclosures[0].geometry = `..\\${enclosureFilename}`; },
    value => { value.maps[0].enclosures[0].geometry = '../private-session.ndjson'; },
    value => { value.maps[0].enclosures[0].geometry = `https://example.invalid/${enclosureFilename}`; },
  ]) {
    const invalid = structuredClone(enclosureEvidence);
    invalidate(invalid);
    await writeFile(enclosureEvidencePath, JSON.stringify(invalid));
    await assertEnclosureFailurePreservesSite(/Map enclosure evidence identity or geometry mismatch/);
  }
  await writeFile(enclosureEvidencePath, JSON.stringify(enclosureEvidence));
  await writeFile(enclosureFile, 'corrupted source bytes');
  await assertEnclosureFailurePreservesSite(/Map enclosure geometry SHA-256 mismatch/);
  await rm(enclosureFile);
  await assertEnclosureFailurePreservesSite(/ENOENT/);
  await writeFile(enclosureFile, enclosureBytes);
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
