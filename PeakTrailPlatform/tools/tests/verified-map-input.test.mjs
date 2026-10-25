import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeMapPackId } from "../lib/map-pack-identity.mjs";
import { readVerifiedMapBuild, readVerifiedMapManifest, resolveVerifiedMapInput } from "../lib/verified-map-input.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = async path => !!(await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; }));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "peak-verified-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packsDirectory = join(root, "assets/packs"), mapsDirectory = join(root, "maps");
  const files = new Map([["chapter.png", Buffer.from("texture")], ["chapter.f32", Buffer.alloc(16)],
    ["chapter.glb.gz", Buffer.from("unchanged geometry")]]);
  const source = { schemaVersion: 1, identityVersion: 3, gameBuildId: "26134529", gameVersion: "3.0.0--logFile",
    sceneName: "Level_81", mapSlot: 81, projectionVersion: 1, coordinateSpace: "unity-world-meters",
    textureUv: "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)", imageOrigin: "bottom-left-in-uv;viewer-flips-for-top-left-images",
    generatedAtUtc: "2026-10-23T00:00:00Z", source: { sceneSha256: sha("unchanged scene") }, layers: [{
      id: "chapter", segment: 0, biome: "Shore", texture: "chapter.png", textureSha256: sha(files.get("chapter.png")),
      height: "chapter.f32", heightSha256: sha(files.get("chapter.f32")), geometry: "chapter.glb.gz",
      geometrySha256: sha(files.get("chapter.glb.gz")), geometryFormat: "glb-instanced-v1+gzip", minX: 0, maxX: 10,
      minY: -1, maxY: 30, minZ: 0, maxZ: 20, columns: 2, rows: 2, heightEncoding: "float32-le-row-major-minz-minx",
      noData: "NaN", sampleLocation: "cell-centers" }] };
  source.mapPackId = computeMapPackId(source);
  const oldBytes = JSON.stringify(source), sourceDirectory = join(packsDirectory, source.mapPackId);
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(join(sourceDirectory, "map-pack.json"), oldBytes);
  for (const [name, bytes] of files) await writeFile(join(sourceDirectory, name), bytes);
  const proof = { schemaVersion: 1, authority: "verified-map-build-equivalence", verified: true, sourceBuildId: "26134529",
    targetBuildId: "26155610", targetGameVersion: "3.0.1--logFile", bundles: [{ bundleContentsVerified: true }],
    maps: [{ sourceMapPackId: source.mapPackId, sceneName: source.sceneName, mapSlot: source.mapSlot,
      sourceSceneSha256: source.source.sceneSha256, sourceManifestSha256: sha(oldBytes) }] };
  const target = { ...structuredClone(source), gameBuildId: "26155610", gameVersion: "3.0.1--logFile" };
  target.mapPackId = computeMapPackId(target);
  const plan = { schemaVersion: 1, sourceGameBuildId: "26134529", gameBuildId: "26155610", gameVersion: target.gameVersion,
    packs: [{ sourceMapPackId: source.mapPackId, mapPackId: target.mapPackId,
      assets: [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) })) }] };
  const buildDirectory = join(mapsDirectory, "verified-builds/26155610");
  const f = { root, packsDirectory, mapsDirectory, source, target, files, sourceDirectory, proof, plan, buildDirectory };
  f.options = { packsDirectory, mapsDirectory };
  await save(f); return f;
}

async function save(f) {
  const proof = JSON.stringify(f.proof), receiptSha256 = sha(proof);
  f.plan.equivalenceReceiptSha256 = receiptSha256;
  f.target.source.equivalence = { authority: f.proof.authority, sourceGameBuildId: f.plan.sourceGameBuildId,
    sourceMapPackId: f.plan.packs[0].sourceMapPackId, receiptSha256 };
  const body = JSON.stringify(f.target);
  Object.assign(f.plan.packs[0], { manifestSha256: sha(body), manifestBytes: Buffer.byteLength(body) });
  const folder = join(f.buildDirectory, "manifests", f.plan.packs[0].mapPackId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "map-pack.json"), body);
  await writeFile(join(f.buildDirectory, "equivalence.json"), proof);
  const plan = JSON.stringify(f.plan); await writeFile(join(f.buildDirectory, "plan.json"), plan);
  await writeFile(join(f.mapsDirectory, "verified-builds/index.json"), JSON.stringify({ schemaVersion: 1,
    builds: [{ gameBuildId: "26155610", planSha256: sha(plan), receiptSha256 }] }));
}

test("ordinary canonical packs retain their own manifest and asset directory without consulting proof metadata", async t => {
  const f = await fixture(t);
  await writeFile(join(f.mapsDirectory, "verified-builds/index.json"), "invalid ignored index");
  assert.deepEqual(await resolveVerifiedMapInput(f.source.mapPackId, f.options),
    { manifestPath: join(f.sourceDirectory, "map-pack.json"), assetsDirectory: f.sourceDirectory });
});

test("verified rebinding reads a new signed manifest and exactly the original immutable assets without writes", async t => {
  const f = await fixture(t), targetDirectory = join(f.packsDirectory, f.target.mapPackId);
  const before = await readFile(join(f.sourceDirectory, "map-pack.json"));
  const input = await resolveVerifiedMapInput(f.target.mapPackId, f.options);
  assert.equal(input.assetsDirectory, f.sourceDirectory);
  assert.equal(input.manifestPath, join(f.buildDirectory, "manifests", f.target.mapPackId, "map-pack.json"));
  assert.equal(await exists(targetDirectory), false);
  assert.deepEqual(await readFile(join(f.sourceDirectory, "map-pack.json")), before);
  const build = await readVerifiedMapBuild("26155610", f.options);
  assert.deepEqual(await readVerifiedMapManifest(build, f.target.mapPackId), f.target);
  assert.equal(await readVerifiedMapBuild("26155611", f.options), null);
});

test("missing canonical packs cannot fall back without an independently pinned receipt", async t => {
  const f = await fixture(t);
  await rm(join(f.mapsDirectory, "verified-builds/index.json"));
  await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /missing.*no verified/);
  await save(f);
  await writeFile(join(f.buildDirectory, "equivalence.json"), JSON.stringify({ ...f.proof, verified: false }));
  await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /SHA-256\/size mismatch/);
  await save(f);
  await writeFile(join(f.buildDirectory, "plan.json"), "{}");
  await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /SHA-256\/size mismatch/);
});

test("repinning incomplete proofs, wrong builds or duplicate inventories cannot authorize a rebind", async t => {
  for (const mutate of [
    f => { f.proof.verified = false; }, f => { f.proof.sourceBuildId = "999"; },
    f => { f.proof.targetBuildId = "999"; }, f => { f.proof.bundles[0].bundleContentsVerified = false; },
    f => { f.proof.maps.push(f.proof.maps[0]); }, f => { f.plan.packs.push(f.plan.packs[0]); },
    f => { f.proof.maps[0].sourceMapPackId = `sha256-${"0".repeat(64)}`; },
  ]) {
    const f = await fixture(t); mutate(f); await save(f);
    await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /proof|inventory|planned map|bind every source/);
  }
});

test("target manifests, original manifests and all reused asset bytes remain authenticated", async t => {
  const f = await fixture(t);
  const target = join(f.buildDirectory, "manifests", f.target.mapPackId, "map-pack.json");
  await writeFile(target, "{}");
  await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /SHA-256\/size mismatch/);
  await save(f); await writeFile(join(f.sourceDirectory, "map-pack.json"), "{}");
  await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /SHA-256\/size mismatch/);
  await writeFile(join(f.sourceDirectory, "map-pack.json"), JSON.stringify(f.source));
  await writeFile(join(f.sourceDirectory, "chapter.png"), "tampered");
  await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /asset exceeds|asset size\/SHA-256 mismatch/);
});

test("a newly signed target still cannot change geometry, scene or projection under the equivalence proof", async t => {
  for (const mutate of [
    p => { p.sceneName = "Level_82"; }, p => { p.projectionVersion = 2; },
    p => { p.layers[0].minX = -10; }, p => { p.source.sceneSha256 = "0".repeat(64); },
  ]) {
    const f = await fixture(t); mutate(f.target); f.target.mapPackId = computeMapPackId(f.target);
    f.plan.packs[0].mapPackId = f.target.mapPackId; await save(f);
    await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /scene differs|projectionVersion differs|scene\/layers differ/);
  }
});

test("dependencies are a closed allowlist and untrusted paths cannot escape either source root", async t => {
  for (const mutate of [
    f => { f.plan.packs[0].sourceMapPackId = "../../outside"; },
    f => { f.plan.packs[0].assets[0].name = "../outside.png"; },
    f => { f.plan.packs[0].assets.pop(); },
    f => { f.plan.packs[0].assets[1] = f.plan.packs[0].assets[0]; },
  ]) {
    const f = await fixture(t); mutate(f); await save(f);
    await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /planned map|planned dependency|dependency closure/);
  }
  const f = await fixture(t);
  await assert.rejects(resolveVerifiedMapInput("../../outside", f.options), /unsafe map pack identity/);
  await assert.rejects(readVerifiedMapBuild("../../outside", f.options), /unsafe requested build/);
});

test("symbolic links in original assets, uploaded manifests or ancestor directories are rejected", {
  skip: process.platform === "win32" && "POSIX symlink checks run in CI",
}, async t => {
  for (const kind of ["source-file", "target-file", "target-directory"]) {
    const f = await fixture(t);
    if (kind === "source-file") {
      const path = join(f.sourceDirectory, "chapter.png"); await rm(path); await symlink(join(f.sourceDirectory, "chapter.f32"), path);
    } else if (kind === "target-file") {
      const path = join(f.buildDirectory, "manifests", f.target.mapPackId, "map-pack.json"); await rm(path);
      await symlink(join(f.sourceDirectory, "map-pack.json"), path);
    } else {
      const path = join(f.buildDirectory, "manifests", f.target.mapPackId); await rm(path, { recursive: true });
      await symlink(f.sourceDirectory, path);
    }
    await assert.rejects(resolveVerifiedMapInput(f.target.mapPackId, f.options), /ordinary file|ordinary directory/);
  }
});
