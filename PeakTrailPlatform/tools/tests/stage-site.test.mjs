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
    mkdir(resolve(platform, "data", "home-art"), { recursive: true }),
    mkdir(resolve(platform, "data", "maps"), { recursive: true }),
    mkdir(resolve(platform, "data", "recorder"), { recursive: true }),
    mkdir(resolve(platform, "data", "memories"), { recursive: true }),
    mkdir(resolve(platform, "schema"), { recursive: true }),
    mkdir(resolve(platform, "server"), { recursive: true }),
    mkdir(pack, { recursive: true }),
    mkdir(secondPack, { recursive: true }),
    mkdir(resolve(enclosures, "private"), { recursive: true }),
    mkdir(resolve(gameAssets, "123", "icons"), { recursive: true }),
    mkdir(resolve(assets, "home-art"), { recursive: true }),
    mkdir(resolve(repository, "local", "recordings"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(resolve(platformSource, "tools", "stage-site.mjs"), resolve(tools, "stage-site.mjs")),
    copyFile(resolve(platformSource, "server", "map-alignment.mjs"), resolve(platform, "server", "map-alignment.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "game-assets.mjs"), resolve(tools, "lib", "game-assets.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "local-paths.mjs"), resolve(tools, "lib", "local-paths.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "recorder-release.mjs"), resolve(tools, "lib", "recorder-release.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "memories-release.mjs"), resolve(tools, "lib", "memories-release.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "site-release.mjs"), resolve(tools, "lib", "site-release.mjs")),
    copyFile(resolve(platformSource, "web", "src", "map-fog.js"), resolve(platform, "web", "src", "map-fog.js")),
    copyFile(resolve(platformSource, "web", "src", "map-water.js"), resolve(platform, "web", "src", "map-water.js")),
    copyFile(resolve(platformSource, "web", "src", "map-enclosures.js"), resolve(platform, "web", "src", "map-enclosures.js")),
    copyFile(resolve(platformSource, "web", "src", "map-peak.js"), resolve(platform, "web", "src", "map-peak.js")),
    copyFile(resolve(platformSource, "web", "src", "home-art.js"), resolve(platform, "web", "src", "home-art.js")),
    writeFile(resolve(platform, "web", "index.html"), '<!doctype html><a href="./downloads/recorder/0.7.1/PeakTrailRecorder.dll" download>Download</a>'),
    writeFile(resolve(platform, "web", "guide.html"), '<!doctype html><title>Legacy install guide</title><a href="downloads/recorder/old/PeakTrailRecorder.dll">Old recorder</a>'),
    writeFile(resolve(platform, "web", "routes.html"), '<!doctype html><title>Legacy routes</title><script>oldCollector()</script>'),
    writeFile(resolve(platform, "web", "styles.css"), "body{}"),
    writeFile(resolve(platform, "web", "home.css"), ".home-page{}"),
    writeFile(resolve(platform, "web", "src", "app.js"), "export {};"),
    writeFile(resolve(platform, "vendor", "notice.txt"), "fixture"),
    writeFile(resolve(platform, "data", "daily", "current.json"), "{}"),
    writeFile(resolve(repository, "local", "recordings", "private-session.ndjson"), "private trail"),
  ]);
  const bundledHomeArt = new Set(['peak-v1.png', 'nadir-v1.png']);
  await Promise.all(HOME_ART_FILES.map(file => writeFile(resolve(
    bundledHomeArt.has(file) ? resolve(platform, 'data', 'home-art') : resolve(assets, 'home-art'), file,
  ), 'illustration fixture')));
  const retiredHomeArt = ['shore', 'roots', 'tropics', 'alpine', 'mesa', 'volcano', 'swamp', 'kiln', 'temple']
    .flatMap(name => [1, 2].map(version => `${name}-v${version}.png`));
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
    maps: [manifest, secondManifest].map(value => ({ mapPackId: value.mapPackId,
      sceneName: value.sceneName, mapSlot: value.mapSlot, sourceSceneSha256: value.source.sceneSha256, route })),
  };
  evidence.privatePath = "must not publish";
  evidence.maps.push({ mapPackId: `sha256-${'e'.repeat(64)}`, sceneName: 'Unserved', privateRecordings: ['must not publish'] });
  const evidencePath = resolve(platform, "data", "maps", "routes.123.json");
  const alignment = { version: 1, coordinateSpace: 'unity-world-cm', landmarks: [
    { key: 'segment-root:0', kind: 'segment-root', stageIndex: 0, name: 'Beach_Segment', positionCm: [0,0,0], rotation: [0,0,0,1], scale: [1,1,1] },
    { key: 'progress-point:3', kind: 'progress-point', stageIndex: 3, name: 'Caldera Gate', positionCm: [1000,1000,1000] },
    { key: 'progress-point:peak', kind: 'progress-point', name: 'Peak Gate', positionCm: [0,1000,2000] },
  ] };
  const landmarkEvidence = { schemaVersion: 1, gameBuildId: '123', authority: 'serialized-map-landmarks',
    sourceGameAssemblyMvid: 'a'.repeat(32), sourceGameAssemblySha256: 'f'.repeat(64), privatePath: 'must not publish',
    maps: [manifest,secondManifest].map(value => ({ sceneName: value.sceneName, mapPackId: value.mapPackId,
      sourceSceneSha256: value.source.sceneSha256, alignment, expectedLegacyLayoutKey: '9'.repeat(64), legacyRootTransformPolicy: 'static-no-runtime-trs-writes',
      privateRecordings: ['must not publish'] })) };
  landmarkEvidence.maps.push({ mapPackId: `sha256-${'e'.repeat(64)}`, sceneName: 'Unserved', privateRecordings: ['must not publish'] });
  const landmarkPath = resolve(platform,'data','maps','landmarks.123.json');
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
    writeFile(landmarkPath, JSON.stringify(landmarkEvidence)),
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

  const recorderBytes = Buffer.from("MZ pinned recorder fixture");
  const recorderPath = resolve(repository, "local", "PeakTrailRecorder.dll");
  const recorderRelease = { schemaVersion: 1, version: "0.7.1", filename: "PeakTrailRecorder.dll",
    sourceRevision: "e".repeat(40), size: recorderBytes.length, sha256: sha256(recorderBytes),
    artifactUrl: "https://github.com/luyongyi/peak-trail/releases/download/recorder-v0.7.1/PeakTrailRecorder.dll",
    downloadPath: "downloads/recorder/0.7.1/PeakTrailRecorder.dll" };
  await writeFile(recorderPath, recorderBytes);
  await writeFile(resolve(repository, "local", "Assembly-CSharp.dll"), "game assembly must not publish");
  await writeFile(resolve(repository, "local", "PeakTrailRecorder.cfg"), "private configuration must not publish");
  await writeFile(resolve(platform, "data", "recorder", "release.json"), JSON.stringify(recorderRelease));
  const options = { env: { ...process.env, PEAK_TRAIL_ASSET_ROOT: assets, PEAK_TRAIL_DOWNLOAD_PRODUCT: "recorder", PEAK_TRAIL_RECORDER_DLL: recorderPath } };
  await execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options);
  const staged = resolve(platform, "site-dist");
  for (const name of ["guide.html", "routes.html"]) {
    const page = await readFile(resolve(staged, name), "utf8");
    assert.match(page, /旧足迹入口暂时下线/);
    assert.match(page, /<a href="\.\/">返回首页<\/a>/);
    assert.match(page, /回忆录 Mod/);
    assert.doesNotMatch(page, /<script|<form|PeakTrailRecorder|oldCollector|Legacy install guide|Legacy routes/);
  }
  assert.deepEqual(await readFile(resolve(staged, recorderRelease.downloadPath)), recorderBytes);
  assert.deepEqual(JSON.parse(await readFile(resolve(staged, "data", "recorder", "release.json"), "utf8")), recorderRelease);
  assert.deepEqual(await readdir(resolve(staged, "downloads", "recorder", "0.7.1")), ["PeakTrailRecorder.dll"]);
  assert.deepEqual((await readdir(resolve(staged, 'data', 'home-art'))).sort(), [...HOME_ART_FILES].sort(), 'publish every illustration, and no neighboring private files');
  for (const file of retiredHomeArt) await assert.rejects(access(resolve(staged, 'data', 'home-art', file)), { code: 'ENOENT' }, 'do not publish retired illustration versions');
  const stagedManifestPath = resolve(staged, "data", "maps", "packs", packId, "map-pack.json");
  const stagedManifestBytes = await readFile(stagedManifestPath, "utf8");
  const stagedManifest = JSON.parse(stagedManifestBytes);
  assert.deepEqual(stagedManifest.route, route);
  const stagedRoutes = JSON.parse(await readFile(resolve(staged,'data','maps','routes.123.json'),'utf8'));
  const stagedLandmarks = JSON.parse(await readFile(resolve(staged,'data','maps','landmarks.123.json'),'utf8'));
  assert.equal(stagedRoutes.maps.length,2); assert.equal(stagedLandmarks.maps.length,2);
  assert.equal(stagedRoutes.privatePath,undefined); assert.equal(stagedLandmarks.privatePath,undefined);
  assert.ok(stagedLandmarks.maps.every(value=>value.privateRecordings===undefined));
  assert.deepEqual(stagedLandmarks.maps[0].alignment.landmarks.map(value=>value.key),['progress-point:3','progress-point:peak','segment-root:0']);
  assert.equal(stagedLandmarks.maps[0].sourceSceneSha256,manifest.source.sceneSha256);
  assert.equal(stagedLandmarks.maps[0].expectedLegacyLayoutKey,'9'.repeat(64));
  assert.equal(stagedLandmarks.sourceGameAssemblyMvid,'a'.repeat(32));
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

  const memoriesBytes = Buffer.from("MZ pinned memories staging fixture");
  const memoriesPath = resolve(repository, "local", "PeakReplayLab.dll");
  const memoriesRelease = { schemaVersion: 1, product: "peak-memories", version: "0.8.0", filename: "PeakReplayLab.dll",
    fileVersion: "0.8.0.0", informationalVersion: `0.8.0+${"f".repeat(40)}`, channel: "development", releaseStatus: "unreleased",
    sourceDirty: true, repositoryUrl: "https://github.com/luyongyi/peak-memories", size: memoriesBytes.length, sha256: sha256(memoriesBytes),
    downloadPath: "downloads/memories/0.8.0/PeakReplayLab.dll" };
  await writeFile(memoriesPath, memoriesBytes);
  await writeFile(resolve(repository, "local", "private.peakrun"), "private memoir");
  await writeFile(resolve(platform, "data", "memories", "release.json"), JSON.stringify({ ...memoriesRelease, privatePath: memoriesPath }));
  const memoriesOptions = { env: { ...options.env, PEAK_TRAIL_DOWNLOAD_PRODUCT: "", PEAK_TRAIL_MEMORIES_DLL: memoriesPath } };
  await writeFile(resolve(staged, "preflight-marker.txt"), "keep on failure");
  await assert.rejects(execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], memoriesOptions), /unpublished development build/);
  assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
  const previewArgs = [resolve(tools, "stage-site.mjs"), "--preview", "--memories-dll", memoriesPath];
  await assert.rejects(execFileAsync(process.execPath, [...previewArgs, "--profile", "server"], memoriesOptions), /Server staging cannot use --preview/);
  assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
  await assert.rejects(execFileAsync(process.execPath, previewArgs, memoriesOptions), /does not match selected/);
  assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
  await writeFile(resolve(platform, "web", "index.html"), `<!doctype html><a href="./${memoriesRelease.downloadPath}" download>Download</a>`);
  await assert.rejects(execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options), /does not match selected/);
  assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
  assert.match((await execFileAsync(process.execPath, previewArgs, memoriesOptions)).stdout, /local preview.*not a public release/);
  assert.deepEqual(await readFile(resolve(staged, memoriesRelease.downloadPath)), memoriesBytes);
  assert.deepEqual(JSON.parse(await readFile(resolve(staged, "data", "memories", "release.json"), "utf8")), memoriesRelease);
  assert.deepEqual(await readdir(resolve(staged, "downloads", "memories", "0.8.0")), ["PeakReplayLab.dll"]);
  await assert.rejects(access(resolve(staged, "downloads", "recorder")), { code: "ENOENT" });
  await assert.rejects(access(resolve(staged, "data", "recorder")), { code: "ENOENT" });
  await assert.rejects(access(resolve(staged, "private.peakrun")), { code: "ENOENT" });
  await assert.rejects(access(resolve(staged, "Assembly-CSharp.dll")), { code: "ENOENT" });
  await writeFile(resolve(staged, "preflight-marker.txt"), "keep on failure");
  const wrongMemories = Buffer.from(memoriesBytes); wrongMemories[3] ^= 1;
  await writeFile(memoriesPath, wrongMemories);
  await assert.rejects(execFileAsync(process.execPath, previewArgs, memoriesOptions), /Memories DLL SHA-256 mismatch/);
  assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
  assert.deepEqual(await readFile(resolve(staged, memoriesRelease.downloadPath)), memoriesBytes);
  await writeFile(resolve(platform, "web", "index.html"), `<!doctype html><a href="./${recorderRelease.downloadPath}" download>Download</a>`);
  await execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options);

  await writeFile(resolve(staged, "preflight-marker.txt"), "keep on failure");
  const wrongRecorder = Buffer.from(recorderBytes); wrongRecorder[3] ^= 1;
  await writeFile(recorderPath, wrongRecorder);
  await assert.rejects(execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options), /Recorder DLL SHA-256 mismatch/);
  assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
  assert.deepEqual(await readFile(resolve(staged, recorderRelease.downloadPath)), recorderBytes);
  await writeFile(recorderPath, recorderBytes);
  for (const invalidate of [
    value => { value.maps.splice(0,1); },
    value => { value.maps.push(value.maps[0]); },
    value => { value.maps[0].sourceSceneSha256 = '0'.repeat(64); },
    value => { value.maps[0].sceneName = 'Level_2'; },
    value => { value.maps[0].alignment.landmarks[0].positionCm[0] = .5; },
    value => { value.maps[0].alignment.landmarks[0].scale = [0,1,1]; },
    value => { value.maps[0].alignment.landmarks[1].stageIndex = 2; value.maps[0].alignment.landmarks[1].key = 'progress-point:2'; },
    value => { value.maps[0].alignment.landmarks.forEach((landmark,index)=>{landmark.positionCm=[0,0,index*2000];}); },
    value => { delete value.sourceGameAssemblyMvid; },
  ]) {
    const invalid = structuredClone(landmarkEvidence); invalidate(invalid); await writeFile(landmarkPath,JSON.stringify(invalid));
    await assert.rejects(execFileAsync(process.execPath,[resolve(tools,'stage-site.mjs')],options), /landmark|layout|scale|coordinates/i);
    assert.equal(await readFile(resolve(staged,'preflight-marker.txt'),'utf8'),'keep on failure');
    assert.equal(await readFile(stagedManifestPath,'utf8'),stagedManifestBytes);
  }
  await writeFile(landmarkPath,JSON.stringify(landmarkEvidence));
  const missingRoute = structuredClone(evidence); missingRoute.maps.splice(0,1);
  await writeFile(evidencePath,JSON.stringify(missingRoute));
  await assert.rejects(execFileAsync(process.execPath,[resolve(tools,'stage-site.mjs')],options), /requires native route evidence/);
  assert.equal(await readFile(resolve(staged,'preflight-marker.txt'),'utf8'),'keep on failure');
  await writeFile(evidencePath,JSON.stringify(evidence));
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
