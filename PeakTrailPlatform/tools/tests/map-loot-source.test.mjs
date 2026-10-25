import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { publicMapLootChunk, readMapLootSource } from "../lib/map-loot-source.mjs";
import { computeMapPackId } from "../lib/map-pack-identity.mjs";

const sha = body => createHash("sha256").update(body).digest("hex");
const build = "26134529";
const pack = { mapPackId: `sha256-${"a".repeat(64)}`, gameBuildId: build,
  sceneName: "Level_207", mapSlot: 207, source: { sceneSha256: "b".repeat(64) },
  layers: [{ id: "shore", segment: 0, geometrySha256: "c".repeat(64) }] };
const fixture = () => ({ schemaVersion: 1, gameBuildId: build,
  source: { kind: "canonical-map-geometry-survey", componentCoverage: "native components", privateField: "excluded" },
  types: [{ id: "chest-small", category: "chest", name: "小型行李箱", nameEn: "Small Luggage" }],
  maps: [{ mapPackId: pack.mapPackId, sceneName: pack.sceneName, mapSlot: pack.mapSlot,
    sourceSceneSha256: pack.source.sceneSha256, layers: pack.layers,
    markers: [{ id: "chest:1", type: "chest-small", category: "chest", placement: "fixed",
      pos: [1, 2, 3], segment: 0, layerId: "shore" }] }] });

async function directory(t) {
  const root = await mkdtemp(resolve(tmpdir(), "peak-map-loot-source-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("peak-map-loot-source-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function indexed(t, raw = fixture()) {
  const root = await directory(t);
  const path = `loot/${build}/${pack.mapPackId}.json`;
  const file = resolve(root, path), indexFile = resolve(root, `loot.${build}.json`);
  const body = JSON.stringify(raw) + "\n";
  const index = { schemaVersion: 1, kind: "map-loot-index", gameBuildId: build, source: raw.source,
    maps: [{ mapPackId: pack.mapPackId, sceneName: pack.sceneName, mapSlot: pack.mapSlot,
      sourceSceneSha256: pack.source.sceneSha256, path, sha256: sha(body), size: Buffer.byteLength(body) }] };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  await writeFile(indexFile, JSON.stringify(index));
  return { root, file, indexFile, index, raw, body };
}

test("legacy complete surveys still produce bounded public chunks with exact source identity", async t => {
  const root = await directory(t), raw = fixture();
  await writeFile(resolve(root, `loot.${build}.json`), JSON.stringify(raw));
  const source = await readMapLootSource(root, build);
  const output = await publicMapLootChunk(source, pack), body = JSON.parse(output.body);
  assert.equal(output.sha256, sha(output.body));
  assert.equal(body.maps.length, 1);
  assert.equal(body.maps[0].markers[0].name, raw.types[0].name);
  assert.equal(body.source.componentCoverage, "native components");
  assert.equal(body.source.privateField, undefined);
  assert.equal(output.entry.path, `loot/${build}/${pack.mapPackId}.json`);
  assert.equal(output.entry.sourceSceneSha256, pack.source.sceneSha256);
});

test("an indexed source reads only the selected map and supports the full 208-map pool", async t => {
  const f = await indexed(t);
  for (let slot = 0; slot < 207; slot++) {
    const mapPackId = `sha256-${sha(String(slot))}`;
    f.index.maps.push({ ...f.index.maps[0], mapPackId, sceneName: `Level_${slot}`, mapSlot: slot,
      path: `loot/${build}/${mapPackId}.json` });
  }
  await writeFile(f.indexFile, JSON.stringify(f.index));
  const source = await readMapLootSource(f.root, build);
  assert.equal(source.raw.maps.length, 208);
  assert.ok(source.raw.maps.every(entry => !Object.hasOwn(entry, "markers")));
  const output = await publicMapLootChunk(source, pack);
  assert.equal(JSON.parse(output.body).maps[0].markers.length, 1);
  assert.equal(await source.readMap(`sha256-${"f".repeat(64)}`), null);
});

test("changed chunk bytes are rejected even when valid JSON still has the same identity", async t => {
  const f = await indexed(t), source = await readMapLootSource(f.root, build);
  const changed = f.body.replace('"pos":[1,2,3]', '"pos":[9,2,3]');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(f.body));
  await writeFile(f.file, changed);
  await assert.rejects(publicMapLootChunk(source, pack), /checksum mismatch/);
});

test("index size is checked independently of its checksum", async t => {
  const f = await indexed(t);
  f.index.maps[0].size += 1;
  await writeFile(f.indexFile, JSON.stringify(f.index));
  const source = await readMapLootSource(f.root, build);
  await assert.rejects(source.readMap(pack.mapPackId), /checksum mismatch/);
});

test("path substitution, duplicate entries and malformed references fail before any chunk is opened", async t => {
  const f = await indexed(t);
  for (const mutate of [
    entry => entry.path = "../private.json",
    entry => entry.path = `loot/${build}/different.json`,
    entry => entry.path = f.file,
    entry => entry.path = "https://example.invalid/loot.json",
    entry => entry.mapPackId = "../../private",
    entry => entry.sha256 = "invalid",
    entry => entry.size = 24 * 1024 * 1024 + 1,
    entry => entry.size = 0,
  ]) {
    const value = structuredClone(f.index); mutate(value.maps[0]);
    await writeFile(f.indexFile, JSON.stringify(value));
    await assert.rejects(readMapLootSource(f.root, build), /chunk reference/, mutate.toString());
  }
  f.index.maps.push(f.index.maps[0]);
  await writeFile(f.indexFile, JSON.stringify(f.index));
  await assert.rejects(readMapLootSource(f.root, build), /chunk reference/);
});

test("a matching checksum cannot authorize changed map identity or a different build", async t => {
  const f = await indexed(t);
  for (const mutate of [
    value => value.gameBuildId = "25739797",
    value => value.schemaVersion = 2,
    value => value.maps[0].mapPackId = `sha256-${"d".repeat(64)}`,
    value => value.maps[0].sceneName = "Level_0",
    value => value.maps[0].mapSlot = 0,
    value => value.maps[0].sourceSceneSha256 = "e".repeat(64),
    value => value.maps.push(value.maps[0]),
  ]) {
    const value = fixture(); mutate(value);
    const body = JSON.stringify(value);
    f.index.maps[0].sha256 = sha(body); f.index.maps[0].size = Buffer.byteLength(body);
    await writeFile(f.file, body); await writeFile(f.indexFile, JSON.stringify(f.index));
    const source = await readMapLootSource(f.root, build);
    await assert.rejects(source.readMap(pack.mapPackId), /identity mismatch/, mutate.toString());
  }
});

test("manifest scene and geometry binding remain required after successful indexed-file verification", async t => {
  const f = await indexed(t), source = await readMapLootSource(f.root, build);
  for (const mutate of [
    value => value.gameBuildId = "25739797",
    value => value.source.sceneSha256 = "e".repeat(64),
    value => value.layers[0].geometrySha256 = "e".repeat(64),
    value => value.layers[0].segment = 1,
  ]) {
    const manifest = structuredClone(pack); mutate(manifest);
    await assert.rejects(publicMapLootChunk(source, manifest), /does not match/, mutate.toString());
  }
});

test("missing optional survey is tolerated but a missing declared chunk aborts publication", async t => {
  const f = await indexed(t);
  assert.equal(await readMapLootSource(f.root, "25739797"), null);
  const source = await readMapLootSource(f.root, build);
  await rm(f.file);
  await assert.rejects(publicMapLootChunk(source, pack), { code: "ENOENT" });
});

test("malformed survey JSON, wrong root identity and non-regular files are rejected", async t => {
  const root = await directory(t), path = resolve(root, `loot.${build}.json`);
  await writeFile(path, "{broken");
  await assert.rejects(readMapLootSource(root, build), SyntaxError);
  for (const value of [{ ...fixture(), gameBuildId: "25739797" }, { ...fixture(), schemaVersion: 2 },
    { ...fixture(), maps: Array.from({ length: 513 }, () => ({})) }]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readMapLootSource(root, build), /survey identity/);
  }
  await rm(path); await mkdir(path);
  await assert.rejects(readMapLootSource(root, build), /regular file/);
  for (const value of ["../1", "0", "12a", "1".repeat(21)])
    await assert.rejects(readMapLootSource(root, value), /Invalid supply survey build/);
});

test("a source is re-read on every publication pass instead of caching stale marker bodies", async t => {
  const f = await indexed(t), source = await readMapLootSource(f.root, build);
  const first = await publicMapLootChunk(source, pack);
  assert.equal(first.sha256, sha(first.body));
  const original = await readFile(f.file, "utf8");
  await writeFile(f.file, original.replace('"pos":[1,2,3]', '"pos":[4,2,3]'));
  await assert.rejects(publicMapLootChunk(source, pack), /checksum mismatch/);
});

async function verified(t, { legacy = false } = {}) {
  const root = await directory(t), targetBuild = "26155610";
  const oldManifest = { schemaVersion: 1, identityVersion: 3, gameBuildId: build, gameVersion: "3.0.0--logFile",
    sceneName: pack.sceneName, mapSlot: pack.mapSlot, projectionVersion: 1, coordinateSpace: "unity-world-meters",
    textureUv: "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)", imageOrigin: "bottom-left-in-uv;viewer-flips-for-top-left-images",
    source: pack.source, layers: [{ ...pack.layers[0], biome: "Shore", texture: "shore.png", textureSha256: sha("texture"),
      height: "shore.height.f32", heightSha256: sha("height"), geometry: "shore.glb.gz", geometryFormat: "glb-instanced-v1+gzip",
      columns: 2, rows: 2, minX: 0, maxX: 10, minY: 0, maxY: 10, minZ: 0, maxZ: 10,
      heightEncoding: "float32-le-row-major-minz-minx", noData: "NaN", sampleLocation: "cell-centers" }] };
  oldManifest.mapPackId = computeMapPackId(oldManifest);
  const proof = { schemaVersion: 1, authority: "verified-map-build-equivalence", verified: true,
    sourceBuildId: build, targetBuildId: targetBuild, targetGameVersion: "3.0.1--logFile", bundles: [{ bundleContentsVerified: true }],
    maps: [{ sourceMapPackId: oldManifest.mapPackId, sceneName: pack.sceneName, mapSlot: pack.mapSlot,
      sourceSceneSha256: pack.source.sceneSha256, sourceManifestSha256: sha(JSON.stringify(oldManifest)) }] };
  const manifest = { ...structuredClone(oldManifest), gameBuildId: targetBuild, gameVersion: proof.targetGameVersion,
    source: { ...pack.source, equivalence: { authority: proof.authority, sourceGameBuildId: build,
      sourceMapPackId: oldManifest.mapPackId, receiptSha256: "" } } };
  manifest.mapPackId = computeMapPackId(manifest);
  const plan = { schemaVersion: 1, sourceGameBuildId: build, gameBuildId: targetBuild, gameVersion: proof.targetGameVersion,
    equivalenceReceiptSha256: "", packs: [{ sourceMapPackId: oldManifest.mapPackId, mapPackId: manifest.mapPackId,
      manifestSha256: "", manifestBytes: 0, assets: [{ name: "shore.png", bytes: 7, sha256: sha("texture") },
        { name: "shore.height.f32", bytes: 6, sha256: sha("height") }, { name: "shore.glb.gz", bytes: 8, sha256: pack.layers[0].geometrySha256 }] }] };
  const raw = fixture(); raw.maps[0].mapPackId = oldManifest.mapPackId;
  raw.maps[0].markers[0].source = { geometrySha256: pack.layers[0].geometrySha256, anchor: "geometry-bounds-center" };
  const chunkPath = `loot/${build}/${oldManifest.mapPackId}.json`;
  const nativeIndex = { schemaVersion: 1, kind: "map-loot-index", gameBuildId: build, source: raw.source,
    maps: [{ mapPackId: oldManifest.mapPackId, sceneName: pack.sceneName, mapSlot: pack.mapSlot,
      sourceSceneSha256: pack.source.sceneSha256, path: chunkPath, size: 0, sha256: "" }] };
  const buildDirectory = resolve(root, "verified-builds", targetBuild), manifestPath = resolve(buildDirectory, "manifests", manifest.mapPackId, "map-pack.json");
  await mkdir(dirname(manifestPath), { recursive: true }); await mkdir(dirname(resolve(root, chunkPath)), { recursive: true });
  const f = { root, targetBuild, raw, manifest, oldManifest, plan, proof, nativeIndex, buildDirectory, manifestPath,
    chunkPath: resolve(root, chunkPath), nativePath: resolve(root, `loot.${build}.json`) };
  f.saveNative = async () => {
    const body = JSON.stringify(raw) + "\n";
    nativeIndex.maps[0].sha256 = sha(body); nativeIndex.maps[0].size = Buffer.byteLength(body);
    await writeFile(f.nativePath, JSON.stringify(legacy ? raw : nativeIndex));
    if (!legacy) await writeFile(f.chunkPath, body);
  };
  f.saveVerified = async () => {
    const receipt = JSON.stringify(proof) + "\n";
    plan.equivalenceReceiptSha256 = sha(receipt);
    manifest.source.equivalence.receiptSha256 = sha(receipt);
    const body = JSON.stringify(manifest) + "\n";
    plan.packs[0].manifestSha256 = sha(body); plan.packs[0].manifestBytes = Buffer.byteLength(body);
    const planBody = JSON.stringify(plan) + "\n";
    await writeFile(manifestPath, body);
    await writeFile(resolve(buildDirectory, "equivalence.json"), receipt);
    await writeFile(resolve(buildDirectory, "plan.json"), planBody);
    await writeFile(resolve(root, "verified-builds", "index.json"), JSON.stringify({ schemaVersion: 1,
      builds: [{ gameBuildId: targetBuild, planSha256: sha(planBody), receiptSha256: sha(receipt) }] }));
  };
  await f.saveNative(); await f.saveVerified();
  return f;
}

test("verified reuse remaps canonical survey identities in memory while preserving every source marker and public chunk path", async t => {
  for (const legacy of [false, true]) {
    const f = await verified(t, { legacy }), source = await readMapLootSource(f.root, f.targetBuild);
    assert.equal(source.raw.gameBuildId, f.targetBuild); assert.equal(source.raw.maps.length, 1);
    assert.equal(source.raw.maps[0].mapPackId, f.manifest.mapPackId);
    const chunk = await source.readMap(f.manifest.mapPackId);
    assert.equal(chunk.gameBuildId, f.targetBuild); assert.equal(chunk.maps[0].mapPackId, f.manifest.mapPackId);
    assert.deepEqual(chunk.maps[0].markers, f.raw.maps[0].markers);
    assert.deepEqual(chunk.maps[0].layers, f.raw.maps[0].layers);
    assert.equal(f.raw.maps[0].mapPackId, f.oldManifest.mapPackId, "source identity is immutable");
    const output = await publicMapLootChunk(source, f.manifest);
    assert.equal(output.path, `loot/${f.targetBuild}/${f.manifest.mapPackId}.json`);
    assert.equal(output.sha256, sha(output.body)); assert.equal(JSON.parse(output.body).maps[0].markers.length, 1);
    assert.equal(await source.readMap(f.oldManifest.mapPackId), null);
    await assert.rejects(readFile(resolve(f.root, `loot.${f.targetBuild}.json`)), { code: "ENOENT" });
    await assert.rejects(readFile(resolve(f.root, output.path)), { code: "ENOENT" });
  }
});

test("an unpinned changed plan, receipt or target manifest cannot authorize survey reuse", async t => {
  for (const path of ["plan.json", "equivalence.json", "manifest"]) {
    const f = await verified(t), file = path === "manifest" ? f.manifestPath : resolve(f.buildDirectory, path);
    await writeFile(file, (await readFile(file, "utf8")) + " ");
    if (path === "manifest") {
      const source = await readMapLootSource(f.root, f.targetBuild);
      await assert.rejects(source.readMap(f.manifest.mapPackId), /SHA-256\/size mismatch/);
    } else await assert.rejects(readMapLootSource(f.root, f.targetBuild), /SHA-256\/size mismatch/);
  }
});

test("false, cyclic, cross-scene or duplicated verified mappings fail even with freshly pinned JSON", async t => {
  for (const mutate of [
    f => { f.proof.verified = false; },
    f => { f.proof.bundles[0].bundleContentsVerified = false; },
    f => { f.plan.sourceGameBuildId = f.targetBuild; },
    f => { f.plan.packs.push(f.plan.packs[0]); f.proof.maps.push(f.proof.maps[0]); },
    f => { f.proof.maps[0].sceneName = "Level_0"; f.proof.maps[0].mapSlot = 0; },
    f => { f.proof.maps[0].sourceSceneSha256 = "d".repeat(64); },
  ]) {
    const f = await verified(t); mutate(f); await f.saveVerified();
    await assert.rejects(readMapLootSource(f.root, f.targetBuild), /proof|bind|identity|duplicate|scene/i);
  }
});

test("reuse requires a native source survey and never follows another verified-build mapping", async t => {
  const f = await verified(t);
  await rm(f.nativePath);
  const indexPath = resolve(f.root, "verified-builds", "index.json"), index = JSON.parse(await readFile(indexPath, "utf8"));
  index.builds.push({ ...index.builds[0], gameBuildId: build });
  await writeFile(indexPath, JSON.stringify(index));
  await assert.rejects(readMapLootSource(f.root, f.targetBuild), /native source survey.*chains are unsupported/);
  assert.equal(await readMapLootSource(f.root, "12345678"), null, "ordinary builds cannot inherit maps or markers");
});

test("source chunks retain checksum verification and cannot become stale after a verified reader is created", async t => {
  const f = await verified(t), source = await readMapLootSource(f.root, f.targetBuild);
  await source.readMap(f.manifest.mapPackId);
  const body = await readFile(f.chunkPath, "utf8");
  await writeFile(f.chunkPath, body.replace('"pos":[1,2,3]', '"pos":[9,2,3]'));
  await assert.rejects(source.readMap(f.manifest.mapPackId), /checksum mismatch/);
});

test("verified markers require complete matching layer digests and individual native or geometry source identities", async t => {
  for (const mutate of [
    raw => { delete raw.maps[0].layers; }, raw => { raw.maps[0].layers = []; },
    raw => { raw.maps[0].layers[0].geometrySha256 = "d".repeat(64); },
    raw => { raw.maps[0].layers.push(raw.maps[0].layers[0]); },
    raw => { delete raw.maps[0].markers; }, raw => { delete raw.maps[0].markers[0].source; },
    raw => { delete raw.maps[0].markers[0].source.geometrySha256; },
    raw => { raw.maps[0].markers[0].source.geometrySha256 = "d".repeat(64); },
    raw => { raw.maps[0].markers[0].source = { sourceKind: "serialized-scene-component" }; },
    raw => { raw.maps[0].markers[0].id = ""; },
  ]) {
    const f = await verified(t); mutate(f.raw); await f.saveNative();
    const source = await readMapLootSource(f.root, f.targetBuild);
    await assert.rejects(source.readMap(f.manifest.mapPackId), /layer identity|source identity|marker identity/);
  }
});

test("a native target survey takes precedence over optional verified fallback data", async t => {
  const f = await verified(t);
  const native = { ...fixture(), gameBuildId: f.targetBuild };
  await writeFile(resolve(f.root, `loot.${f.targetBuild}.json`), JSON.stringify(native));
  await writeFile(resolve(f.buildDirectory, "plan.json"), "broken proof");
  const source = await readMapLootSource(f.root, f.targetBuild);
  assert.deepEqual(source.raw, native);
});
