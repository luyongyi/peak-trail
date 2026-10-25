import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifyMapPackIdentity } from "./map-pack-identity.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = /^[a-f0-9]{64}$/;
const packId = /^sha256-[a-f0-9]{64}$/;
const buildId = /^[1-9]\d{0,19}$/;
const assetName = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:png|f32|glb(?:\.gz)?)$/;
const check = (condition, message) => { if (!condition) throw new Error(`Verified map input: ${message}`); };
const missing = error => { if (error.code === "ENOENT") return null; throw error; };

async function directories(path, allowMissing = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let cursor = root;
  for (const part of ["", ...relative(root, absolute).split(sep).filter(Boolean)]) {
    if (part) cursor = join(cursor, part);
    const info = await lstat(cursor).catch(missing);
    if (!info && allowMissing) return;
    check(info?.isDirectory() && !info.isSymbolicLink(), `expected ordinary directory: ${cursor}`);
  }
}

async function regular(path) {
  await directories(dirname(path));
  const before = await lstat(path);
  check(before.isFile() && !before.isSymbolicLink(), `expected ordinary file: ${path}`);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const after = await file.stat();
    check(after.isFile() && before.dev === after.dev && before.ino === after.ino, `file changed during open: ${path}`);
    return file;
  } catch (error) { await file.close(); throw error; }
}

async function json(path, maximum, expectedHash) {
  const file = await regular(path);
  try {
    check((await file.stat()).size <= maximum, `JSON size limit exceeded: ${path}`);
    const buffer = Buffer.allocUnsafe(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    check(length <= maximum && (!expectedHash || sha(bytes) === expectedHash), `JSON SHA-256/size mismatch: ${path}`);
    return { value: JSON.parse(bytes.toString("utf8")), bytes: length };
  } finally { await file.close(); }
}

async function verifiedAsset(path, expected) {
  const file = await regular(path), digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      check(bytes <= expected.bytes, `asset exceeds declared size: ${path}`);
      digest.update(buffer.subarray(0, bytesRead));
    }
    check(bytes === expected.bytes && digest.digest("hex") === expected.sha256, `asset size/SHA-256 mismatch: ${path}`);
  } finally { await file.close(); }
}

async function readIndex(mapsDirectory) {
  const path = resolve(mapsDirectory, "verified-builds/index.json");
  await directories(dirname(path), true);
  if (!(await lstat(path).catch(missing))) return { schemaVersion: 1, builds: [] };
  const { value: index } = await json(path, 1024 ** 2);
  check(index?.schemaVersion === 1 && Array.isArray(index.builds) && index.builds.length <= 256, "invalid verified-build index");
  const builds = new Set();
  for (const entry of index.builds) {
    check(buildId.test(entry?.gameBuildId) && typeof entry.gameBuildId === "string" && !builds.has(entry.gameBuildId)
      && hex.test(entry.planSha256) && hex.test(entry.receiptSha256), "invalid or duplicate verified-build index entry");
    builds.add(entry.gameBuildId);
  }
  return index;
}

/** Read only trusted, hash-pinned build proofs. No arbitrary path or build alias is accepted. */
export async function readVerifiedMapBuild(gameBuildId, { mapsDirectory }) {
  gameBuildId = String(gameBuildId);
  check(buildId.test(gameBuildId), "unsafe requested build identity");
  mapsDirectory = resolve(mapsDirectory);
  const index = await readIndex(mapsDirectory), entry = index.builds.find(item => item.gameBuildId === gameBuildId);
  if (!entry) return null;
  const buildDirectory = resolve(mapsDirectory, "verified-builds", gameBuildId);
  const { value: plan } = await json(join(buildDirectory, "plan.json"), 16 * 1024 ** 2, entry.planSha256);
  const { value: proof } = await json(join(buildDirectory, "equivalence.json"), 32 * 1024 ** 2, entry.receiptSha256);
  check(plan?.schemaVersion === 1 && buildId.test(plan.sourceGameBuildId) && plan.gameBuildId === gameBuildId
    && plan.sourceGameBuildId !== gameBuildId && typeof plan.gameVersion === "string" && plan.gameVersion.length > 0
    && plan.equivalenceReceiptSha256 === entry.receiptSha256, "plan source/target identity or proof binding mismatch");
  check(proof?.schemaVersion === 1 && proof.authority === "verified-map-build-equivalence" && proof.verified === true
    && proof.sourceBuildId === plan.sourceGameBuildId && proof.targetBuildId === plan.gameBuildId
    && proof.targetGameVersion === plan.gameVersion && Array.isArray(proof.bundles) && proof.bundles.length > 0
    && proof.bundles.every(bundle => bundle?.bundleContentsVerified === true), "incomplete or mismatched source equivalence proof");
  check(Array.isArray(plan.packs) && plan.packs.length > 0 && plan.packs.length <= 4096
    && Array.isArray(proof.maps) && proof.maps.length === plan.packs.length, "incomplete plan/receipt map inventory");
  const targets = new Set(), sources = new Set(), scenes = new Set();
  for (const item of plan.packs) {
    check(packId.test(item?.mapPackId) && packId.test(item.sourceMapPackId) && item.mapPackId !== item.sourceMapPackId
      && !targets.has(item.mapPackId) && !sources.has(item.sourceMapPackId) && hex.test(item.manifestSha256)
      && Number.isSafeInteger(item.manifestBytes) && item.manifestBytes > 0 && item.manifestBytes <= 8 * 1024 ** 2
      && Array.isArray(item.assets) && item.assets.length > 0 && item.assets.length <= 192, "invalid or duplicate planned map");
    targets.add(item.mapPackId); sources.add(item.sourceMapPackId);
    const matches = proof.maps.filter(map => map.sourceMapPackId === item.sourceMapPackId);
    check(matches.length === 1, "receipt must bind every source map exactly once");
    const map = matches[0];
    check(Number.isSafeInteger(map.mapSlot) && map.mapSlot >= 0 && map.sceneName === `Level_${map.mapSlot}`
      && !scenes.has(map.sceneName) && hex.test(map.sourceSceneSha256) && hex.test(map.sourceManifestSha256), "invalid or duplicate receipt scene");
    scenes.add(map.sceneName);
  }
  return { plan, proof, buildDirectory, planSha256: entry.planSha256, receiptSha256: entry.receiptSha256 };
}

/** Read the exact signed target manifest bound by a previously authenticated build. */
export async function readVerifiedMapManifest(build, mapPackId) {
  check(packId.test(mapPackId), "unsafe map pack identity");
  const { plan, proof, buildDirectory, receiptSha256 } = build;
  const entries = plan.packs.filter(item => item.mapPackId === mapPackId);
  check(entries.length === 1, "target map is absent or ambiguous in verified build");
  const entry = entries[0], receipt = proof.maps.find(map => map.sourceMapPackId === entry.sourceMapPackId);
  const path = join(buildDirectory, "manifests", mapPackId, "map-pack.json");
  const { value: manifest, bytes } = await json(path, 8 * 1024 ** 2, entry.manifestSha256);
  check(bytes === entry.manifestBytes && verifyMapPackIdentity(manifest) === mapPackId, "planned manifest size/canonical identity mismatch");
  const equivalence = manifest.source?.equivalence;
  check(String(manifest.gameBuildId) === plan.gameBuildId && manifest.gameVersion === plan.gameVersion
    && manifest.sceneName === receipt.sceneName && manifest.mapSlot === receipt.mapSlot
    && manifest.source?.sceneSha256 === receipt.sourceSceneSha256, "target manifest build/scene differs from receipt");
  check(equivalence?.authority === proof.authority && equivalence.sourceGameBuildId === plan.sourceGameBuildId
    && equivalence.sourceMapPackId === entry.sourceMapPackId && equivalence.receiptSha256 === receiptSha256,
  "new manifest does not bind its source equivalence proof");
  return manifest;
}

/** Resolve a canonical pack, or an independently signed manifest over proven identical source bytes. */
export async function resolveVerifiedMapInput(mapPackId, { packsDirectory, mapsDirectory }) {
  check(packId.test(mapPackId), "unsafe map pack identity");
  packsDirectory = resolve(packsDirectory); mapsDirectory = resolve(mapsDirectory);
  const normalDirectory = join(packsDirectory, mapPackId), normalManifest = join(normalDirectory, "map-pack.json");
  await directories(normalDirectory, true);
  if (await lstat(normalManifest).catch(missing)) {
    const file = await regular(normalManifest); await file.close();
    return { manifestPath: normalManifest, assetsDirectory: normalDirectory };
  }
  const index = await readIndex(mapsDirectory);
  let found = null;
  for (const entry of index.builds) {
    const build = await readVerifiedMapBuild(entry.gameBuildId, { mapsDirectory });
    const matches = build.plan.packs.filter(item => item.mapPackId === mapPackId);
    check(matches.length <= 1 && !(found && matches.length), "ambiguous verified target map");
    if (matches.length) found = { ...build, entry: matches[0] };
  }
  check(found, `local map pack ${mapPackId} is missing and has no verified build input`);
  const { plan, proof, buildDirectory, receiptSha256, entry } = found;
  const manifestPath = join(buildDirectory, "manifests", mapPackId, "map-pack.json");
  const assetsDirectory = join(packsDirectory, entry.sourceMapPackId);
  const receipt = proof.maps.find(map => map.sourceMapPackId === entry.sourceMapPackId);
  const manifest = await readVerifiedMapManifest(found, mapPackId);
  const { value: source } = await json(join(assetsDirectory, "map-pack.json"), 8 * 1024 ** 2, receipt.sourceManifestSha256);
  check(verifyMapPackIdentity(manifest) === mapPackId && verifyMapPackIdentity(source) === entry.sourceMapPackId, "canonical map identity mismatch");
  check(String(source.gameBuildId) === plan.sourceGameBuildId && String(manifest.gameBuildId) === plan.gameBuildId
    && manifest.gameVersion === plan.gameVersion, "map source/target build/version mismatch");
  for (const field of ["schemaVersion", "identityVersion", "sceneName", "mapSlot", "projectionVersion", "coordinateSpace", "textureUv", "imageOrigin"])
    check(isDeepStrictEqual(manifest[field], source[field]), `rebound map ${field} differs from verified source`);
  check(manifest.sceneName === receipt.sceneName && manifest.mapSlot === receipt.mapSlot
    && source.source?.sceneSha256 === receipt.sourceSceneSha256 && manifest.source?.sceneSha256 === receipt.sourceSceneSha256
    && isDeepStrictEqual(manifest.layers, source.layers), "rebound map scene/layers differ from verified source");
  const expected = new Map();
  for (const layer of source.layers) for (const field of ["texture", "height", ...(source.identityVersion === 3 ? ["geometry"] : [])]) {
    const name = layer[field], hash = layer[`${field}Sha256`];
    check(typeof name === "string" && assetName.test(name) && !name.includes("..") && hex.test(hash), "unsafe or unsigned map dependency");
    check(!expected.has(name) || expected.get(name) === hash, "conflicting map dependency digest");
    expected.set(name, hash);
  }
  const names = new Set();
  check(entry.assets.length === expected.size, "planned dependency closure mismatch");
  for (const asset of entry.assets) {
    check(assetName.test(asset?.name) && !asset.name.includes("..") && !names.has(asset.name)
      && expected.get(asset.name) === asset.sha256 && Number.isSafeInteger(asset.bytes) && asset.bytes > 0
      && asset.bytes <= 2 ** 31, "unsafe, duplicate or mismatched planned dependency");
    names.add(asset.name);
    await verifiedAsset(join(assetsDirectory, asset.name), asset);
  }
  return { manifestPath, assetsDirectory };
}
