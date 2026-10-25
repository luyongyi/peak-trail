import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { prepareVerifiedMapBuild } from "../prepare-verified-map-build.mjs";
import { computeMapPackId, verifyMapPackIdentity } from "../lib/map-pack-identity.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceBuildId = "26134529", targetBuildId = "26155610";
const kinds = ["routes", "landmarks", "fog", "water", "peaks", "enclosures"];
const json = value => JSON.stringify(value, null, 2) + "\n";
const readJson = async path => JSON.parse(await readFile(path, "utf8"));

function geometry() {
  const text = JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] });
  const body = Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text) / 4) * 4, " "));
  const bytes = Buffer.alloc(20 + body.length);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(body.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); body.copy(bytes, 20);
  return gzipSync(bytes);
}

async function fixture(t, changeManifest = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "peak-verified-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, "assets"), maps = join(root, "maps"), output = join(root, "prepared"), reportPath = join(root, "report.json");
  await mkdir(maps); await mkdir(assets);
  const inputs = new Map([["chapter.png", Buffer.from("source texture")], ["chapter.height.f32", Buffer.alloc(16)], ["chapter.glb.gz", geometry()]]);
  const manifests = [], entries = [];
  for (let mapSlot = 0; mapSlot < 2; mapSlot++) {
    const sceneName = `Level_${mapSlot}`;
    const manifest = { schemaVersion: 1, identityVersion: 3, gameBuildId: sourceBuildId, gameVersion: "3.0.0--logFile",
      sceneName, mapSlot, projectionVersion: 1, coordinateSpace: "unity-world-meters",
      textureUv: "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)", imageOrigin: "bottom-left-in-uv;viewer-flips-for-top-left-images",
      generatedAtUtc: "2026-10-23T00:00:00Z", source: { sceneSha256: hash(sceneName), sceneFile: `levels0-31/BuildPlayer-${sceneName}` },
      layers: [{ id: "chapter", segment: 0, biome: "Shore", texture: "chapter.png", textureSha256: hash(inputs.get("chapter.png")),
        height: "chapter.height.f32", heightSha256: hash(inputs.get("chapter.height.f32")), geometry: "chapter.glb.gz",
        geometrySha256: hash(inputs.get("chapter.glb.gz")), geometryFormat: "glb-instanced-v1+gzip", minX: 0, maxX: 10,
        minY: -1, maxY: 30, minZ: 0, maxZ: 20, columns: 2, rows: 2, heightEncoding: "float32-le-row-major-minz-minx",
        noData: "NaN", sampleLocation: "cell-centers" }] };
    changeManifest(manifest);
    manifest.mapPackId = computeMapPackId(manifest);
    const directory = join(assets, "maps", "packs", manifest.mapPackId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "map-pack.json"), json(manifest));
    for (const [name, bytes] of inputs) await writeFile(join(directory, name), bytes);
    manifests.push(manifest);
    entries.push({ mapPackId: manifest.mapPackId, identityVersion: 3, sceneName, mapSlot, gameBuildId: sourceBuildId,
      gameVersion: manifest.gameVersion, projectionVersion: 1, generatedAtUtc: manifest.generatedAtUtc,
      supersedesMapPackIds: [`sha256-${String(mapSlot + 1).repeat(64)}`], path: `./packs/${manifest.mapPackId}/map-pack.json`, enabled: true });
  }
  const catalog = { schemaVersion: 1, activeGameBuildId: sourceBuildId, mapPacks: entries };
  const bundle = { file: "StreamingAssets/maps/levels0-31.assetbundle", sha256: hash("bundle"), extractedBytes: 1000 };
  const order = { assetFile: "resources.assets", assetSha256: hash("old resources"), componentClass: "MapBaker", pathId: "27846",
    objectSha256: hash("MapBaker object"), field: "ScenePaths", count: manifests.length };
  const evidence = { schemaVersion: 1, authority: "installed-game-assets-and-serialized-map-baker", gameBuildId: sourceBuildId,
    gameVersion: manifests[0].gameVersion, sceneCount: manifests.length, sceneOrder: order, bundles: [bundle],
    maps: manifests.map(value => ({ sceneName: value.sceneName, mapSlot: value.mapSlot, bundle: "levels0-31.assetbundle",
      sceneFile: value.source.sceneFile, sceneSha256: value.source.sceneSha256, bytes: 100,
      scenePath: `Assets/8_SCENES/Generated/${value.sceneName}.unity`, mapPackId: value.mapPackId })) };
  await writeFile(join(maps, "catalog.json"), json(catalog));
  await writeFile(join(maps, `game-build.${sourceBuildId}.json`), json(evidence));
  const report = { schemaVersion: 1, authority: "verified-map-build-equivalence", verified: true, sourceBuildId, targetBuildId,
    targetGameVersion: "3.0.1--logFile", sourceEvidenceSha256: hash(json(evidence)), sourceCatalogSha256: hash(json(catalog)),
    assembly: { sha256: hash("current assembly"), mvid: "a".repeat(32) }, unityDefaultResourcesSha256: hash("unity default resources"),
    externalBuiltins: { file: "Resources/unity_builtin_extra", sha256: hash("current builtins"), baselineFileSha256: hash("old builtins"),
      baselineExtractionEvidenceSha256: hash("builtin extraction"), allObjectsEqual: true,
      objects: [{ pathId: "1", shader: "Unchanged shader", sha256: hash("shader object"), equal: true }] },
    externalMaterials: { sourceEvidenceSha256: hash("material evidence"), currentInputSha256: { "resources.assets": hash("current materials") },
      materials: [{ name: "AntiSphere", sourceFile: "resources.assets", pathId: 1, materialObjectSha256: hash("material object"),
        shaderSourceFile: "resources.assets", shaderPathId: 2, shaderObjectSha256: hash("material shader"), equal: true,
        verifiedFields: ["name", "shader", "colors", "floats", "shaderProperties", "passState", "shaderObjectSha256"] }] },
    sceneOrder: { ...order, assetSha256: hash("current resources"), equal: true, scenePaths: evidence.maps.map(value => value.scenePath) },
    codeComparisons: ["MapBaker", "MapHandler"].map(type => ({ type, comparison: "normalized-decompiled-text", equal: true,
      sha256: hash(type), baselineFileSha256: hash(`${type} source`) })),
    bundles: [{ ...bundle, bytes: 800, extractionEvidenceSha256: hash("extraction manifest"), memberCount: 4,
      bundleContentsVerified: true, serializedFiles: 2, streamedGeometryAndTextures: 10, dependencies: ["unity default resources"] }],
    maps: manifests.map(value => ({ sceneName: value.sceneName, mapSlot: value.mapSlot, sourceSceneSha256: value.source.sceneSha256,
      sourceMapPackId: value.mapPackId, sourceManifestSha256: hash(json(value)), derivativeFiles: inputs.size,
      derivativeBytes: [...inputs.values()].reduce((sum, bytes) => sum + bytes.length, 0), bundle: "levels0-31.assetbundle", sceneFile: value.source.sceneFile })) };
  for (const kind of kinds) await writeFile(join(maps, `${kind}.${sourceBuildId}.json`), json({ schemaVersion: 1,
    gameBuildId: sourceBuildId, gameVersion: evidence.gameVersion, sourceGameAssemblyMvid: "b".repeat(32), sourceGameAssemblySha256: hash("old assembly"),
    expectedLegacyLayoutKey: "old root policy", legacyRootTransformPolicy: "old policy",
    maps: manifests.map(value => ({ mapPackId: value.mapPackId, sceneName: value.sceneName, mapSlot: value.mapSlot, gameBuildId: sourceBuildId,
      sourceSceneSha256: value.source.sceneSha256, expectedLegacyLayoutKey: "old layout", legacyRootTransformPolicy: "static-no-runtime-trs-writes",
      payload: { exactPositions: [1, 2, 3] } })) }));
  const f = { root, assets, maps, output, reportPath, inputs, manifests, catalog, evidence, report };
  f.saveReport = async () => { const body = json(f.report); await writeFile(reportPath, body); return hash(body); };
  f.run = async overrides => prepareVerifiedMapBuild({ assets, maps, output, reportPath,
    reportSha256: await f.saveReport(), now: "2026-10-26T00:00:00Z", ...overrides });
  return f;
}

test("authenticated complete proof yields new canonical packs, exact same-resource plans and six rebound sidecars without changing sources", async t => {
  const f = await fixture(t);
  const oldCatalog = await readFile(join(f.maps, "catalog.json")), oldManifests = await Promise.all(f.manifests.map(value =>
    readFile(join(f.assets, "maps", "packs", value.mapPackId, "map-pack.json"))));
  const result = await f.run();
  assert.equal(result.maps, 2); assert.equal(result.sidecars, 6);
  const catalog = await readJson(join(f.output, "data", "catalog.json"));
  assert.equal(catalog.activeGameBuildId, sourceBuildId, "unprepared avatars must not change the default rotation");
  assert.deepEqual(catalog.mapPacks.slice(0, 2), f.catalog.mapPacks);
  const plan = await readJson(join(f.output, "plan.json"));
  assert.equal(hash(await readFile(join(f.output, "plan.json"))), result.planSha256);
  assert.equal(plan.equivalenceReceiptSha256, hash(await readFile(f.reportPath)));
  for (const [index, pack] of plan.packs.entries()) {
    const body = await readFile(join(f.output, "manifests", pack.mapPackId, "map-pack.json"));
    const manifest = JSON.parse(body);
    assert.notEqual(pack.mapPackId, pack.sourceMapPackId); assert.equal(pack.manifestSha256, hash(body));
    assert.equal(pack.manifestBytes, body.length); assert.equal(verifyMapPackIdentity(manifest), manifest.mapPackId);
    assert.equal(manifest.gameBuildId, targetBuildId); assert.equal(manifest.gameVersion, "3.0.1--logFile");
    assert.deepEqual(manifest.layers, f.manifests[index].layers); assert.equal(manifest.source.sceneSha256, f.manifests[index].source.sceneSha256);
    assert.deepEqual(pack.assets, [...f.inputs].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes) })));
    assert.equal(catalog.mapPacks[index + 2].supersedesMapPackIds, undefined, "old-build aliases must not cross to the new build");
    assert.deepEqual(await readFile(join(f.assets, "maps", "packs", pack.sourceMapPackId, "map-pack.json")), oldManifests[index]);
    for (const [name, bytes] of f.inputs) assert.deepEqual(await readFile(join(f.assets, "maps", "packs", pack.sourceMapPackId, name)), bytes);
  }
  for (const kind of kinds) {
    const sidecar = await readJson(join(f.output, "data", `${kind}.${targetBuildId}.json`));
    assert.equal(sidecar.gameBuildId, targetBuildId); assert.equal(sidecar.sourceGameAssemblyMvid, f.report.assembly.mvid);
    assert.equal(sidecar.sourceGameAssemblySha256, f.report.assembly.sha256);
    assert.equal(sidecar.expectedLegacyLayoutKey, undefined); assert.equal(sidecar.legacyRootTransformPolicy, undefined);
    assert.deepEqual(sidecar.maps.map(value => value.mapPackId), plan.packs.map(value => value.mapPackId));
    assert.ok(sidecar.maps.every(value => value.gameBuildId === targetBuildId && !value.expectedLegacyLayoutKey && !value.legacyRootTransformPolicy));
    assert.deepEqual(sidecar.maps[0].payload, { exactPositions: [1, 2, 3] });
  }
  assert.deepEqual(await readFile(join(f.maps, "catalog.json")), oldCatalog);
  assert.deepEqual(await readFile(join(f.output, "equivalence.json")), await readFile(f.reportPath));
  assert.deepEqual((await readdir(join(f.output, "manifests", plan.packs[0].mapPackId))).sort(), ["map-pack.json"], "raw geometry is shared by plan, never copied into tracked output");
});

test("a digest mismatch or incomplete/false native proof fails before creating output", async t => {
  const changes = [
    r => { r.verified = false; }, r => { r.maps.pop(); }, r => { r.bundles = []; }, r => { r.bundles[0].bundleContentsVerified = false; },
    r => { delete r.bundles[0].extractionEvidenceSha256; }, r => { r.sourceCatalogSha256 = hash("different catalog"); },
    r => { r.sourceEvidenceSha256 = hash("different evidence"); }, r => { r.codeComparisons.pop(); },
    r => { r.codeComparisons[0].equal = false; }, r => { r.sceneOrder.equal = false; }, r => { r.sceneOrder.scenePaths.reverse(); },
    r => { r.maps[0].sourceManifestSha256 = hash("different manifest"); }, r => { r.maps[0].derivativeFiles--; },
    r => { r.maps[0].derivativeBytes++; }, r => { r.maps[1] = { ...r.maps[0] }; },
  ];
  for (const change of changes) {
    const f = await fixture(t); change(f.report);
    await assert.rejects(f.run(), /proof|Receipt|receipt|scene|SHA-256|inventory/);
    await assert.rejects(readFile(join(f.output, "plan.json")), { code: "ENOENT" });
  }
  const f = await fixture(t);
  await assert.rejects(f.run({ reportSha256: hash("other report") }), /receipt SHA-256 mismatch/);
});

test("duplicate catalog scenes cannot turn complete receipt counts into false coverage", async t => {
  const f = await fixture(t);
  f.catalog.mapPacks[1].sceneName = f.catalog.mapPacks[0].sceneName;
  await writeFile(join(f.maps, "catalog.json"), json(f.catalog));
  f.report.sourceCatalogSha256 = hash(json(f.catalog));
  await assert.rejects(f.run(), /Duplicate source catalog/);
});

test("external shader and material proofs must retain nonempty authenticated equal-object inventories", async t => {
  for (const change of [
    proof => { delete proof.externalBuiltins; }, proof => { proof.externalBuiltins.allObjectsEqual = false; },
    proof => { proof.externalBuiltins.objects = []; }, proof => { proof.externalBuiltins.objects[0].equal = false; },
    proof => { proof.externalBuiltins.objects[0].sha256 = "invalid"; },
    proof => { proof.externalBuiltins.objects.push(proof.externalBuiltins.objects[0]); },
    proof => { delete proof.externalMaterials; }, proof => { proof.externalMaterials.materials = []; },
    proof => { proof.externalMaterials.materials[0].equal = false; },
    proof => { proof.externalMaterials.currentInputSha256 = {}; },
    proof => { proof.externalMaterials.currentInputSha256["resources.assets"] = "invalid"; },
    proof => { proof.externalMaterials.sourceEvidenceSha256 = "invalid"; },
    proof => { proof.externalMaterials.materials[0].shaderObjectSha256 = "invalid"; },
    proof => { proof.externalMaterials.materials[0].verifiedFields.pop(); },
    proof => { proof.externalMaterials.materials[0].shaderSourceFile = "missing.assets"; },
  ]) {
    const f = await fixture(t); change(f.report);
    await assert.rejects(f.run(), /external built-in|external material/);
    await assert.rejects(readFile(join(f.output, "plan.json")), { code: "ENOENT" });
  }
});

test("bad source bytes, identity or a conflicting shared asset digest fail without modifying source files", async t => {
  for (const kind of ["texture", "height", "geometry"]) {
    const f = await fixture(t), old = f.manifests[0], path = join(f.assets, "maps", "packs", old.mapPackId, old.layers[0][kind]);
    await writeFile(path, "tampered derivative");
    await assert.rejects(f.run(), /Source derivative SHA-256 mismatch/);
    assert.equal(await readFile(path, "utf8"), "tampered derivative");
  }
  const f = await fixture(t), old = f.manifests[0], path = join(f.assets, "maps", "packs", old.mapPackId, "map-pack.json");
  old.layers[0].minX = -999;
  await writeFile(path, json(old)); f.report.maps[0].sourceManifestSha256 = hash(json(old));
  await assert.rejects(f.run(), /mapPackId mismatch/);
  const shared = await fixture(t, manifest => manifest.layers.push({ ...manifest.layers[0], id: "second-chapter", segment: 1,
    textureSha256: hash("conflicting digest for the shared filename") }));
  await assert.rejects(shared.run(), /Conflicting source derivative SHA-256/);
});

test("every sidecar is mandatory, complete, unique and bound to the exact source scene digest", async t => {
  for (const change of [
    value => { value.maps[0].sceneName = "Level_99"; }, value => { value.maps[0].sourceSceneSha256 = hash("other scene"); },
    value => { value.maps[0].mapSlot = 99; }, value => { value.maps[0].gameBuildId = "99999999"; },
    value => { value.maps.pop(); }, value => { value.maps[1] = value.maps[0]; },
  ]) {
    const f = await fixture(t), path = join(f.maps, `water.${sourceBuildId}.json`), value = await readJson(path);
    change(value); await writeFile(path, json(value));
    await assert.rejects(f.run(), /Sidecar scene|Incomplete water|duplicate water/);
    await assert.rejects(readFile(join(f.output, "plan.json")), { code: "ENOENT" });
  }
  const f = await fixture(t);
  await rm(join(f.maps, `landmarks.${sourceBuildId}.json`));
  await assert.rejects(f.run(), { code: "ENOENT" });
});

test("existing or source-contained output cannot overwrite current catalogs or old plans", async t => {
  const f = await fixture(t), catalogBytes = await readFile(join(f.maps, "catalog.json"));
  await assert.rejects(f.run({ output: f.maps }), /separate from source/);
  await assert.rejects(f.run({ output: join(f.maps, "..not-outside") }), /separate from source/);
  await mkdir(f.output); await writeFile(join(f.output, "plan.json"), "old reviewed plan");
  await assert.rejects(f.run(), /fresh output/);
  assert.equal(await readFile(join(f.output, "plan.json"), "utf8"), "old reviewed plan");
  assert.deepEqual(await readFile(join(f.maps, "catalog.json")), catalogBytes);
});
