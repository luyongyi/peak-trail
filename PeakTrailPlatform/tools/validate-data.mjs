import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_MAP_PACK_IDENTITY_VERSIONS, verifyMapPackIdentity, verifyGeometryGlb } from "./lib/map-pack-identity.mjs";
import { readGameAssets } from "./lib/game-assets.mjs";
import { localAssetHint, localAssetPaths } from "./lib/local-paths.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const platformDirectory = resolve(toolDirectory, "..");
const coordinateSpace = "unity-world-meters";
const textureUv = "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)";
const imageOrigin = "bottom-left-in-uv;viewer-flips-for-top-left-images";
const heightEncoding = "float32-le-row-major-minz-minx";

const [current, history, catalog] = await Promise.all([
  readJson(resolve(platformDirectory, "data", "daily", "current.json")),
  readJson(resolve(platformDirectory, "data", "daily", "history.json")),
  readJson(resolve(platformDirectory, "data", "maps", "catalog.json")),
]);

assert(current.schemaVersion === 1, "daily/current.json must use schemaVersion 1");
assert(isIsoDate(current.fetchedAtUtc), "daily/current.json has an invalid fetchedAtUtc");
assert(isIsoDate(current.nextChangeAtUtc), "daily/current.json has an invalid nextChangeAtUtc");
assert(current.versionOkay === true, "daily/current.json must have versionOkay=true");
assert(Number.isInteger(current.levelIndex), "daily/current.json levelIndex must be an integer");
assert(Number.isInteger(current.mapCount) && current.mapCount > 0, "daily/current.json mapCount must be positive");
assert(Number.isInteger(current.mapSlot), "daily/current.json mapSlot must be an integer");
assert(current.mapSlot >= 0 && current.mapSlot < current.mapCount, "daily/current.json mapSlot is out of range");
assert(current.mapSlot === positiveModulo(current.levelIndex, current.mapCount), "daily/current.json mapSlot does not match levelIndex");
assert(current.sceneName === `Level_${current.mapSlot}`, "daily/current.json sceneName does not match mapSlot");
assert(Number.isInteger(current.secondsRemaining) && current.secondsRemaining >= 0, "daily/current.json secondsRemaining is invalid");

assert(history.schemaVersion === 1 && Array.isArray(history.observations), "daily/history.json is invalid");
for (const [index, observation] of history.observations.entries()) {
  assert(isIsoDate(observation.observedAtUtc), `daily/history.json observation ${index} has an invalid time`);
  assert(Number.isInteger(observation.levelIndex), `daily/history.json observation ${index} has an invalid levelIndex`);
  assert(Number.isInteger(observation.mapSlot), `daily/history.json observation ${index} has an invalid mapSlot`);
  assert(observation.sceneName === `Level_${observation.mapSlot}`, `daily/history.json observation ${index} has a mismatched sceneName`);
}

assert(catalog.schemaVersion === 1 && Array.isArray(catalog.mapPacks), "maps/catalog.json is invalid");
const activeBuildId = normalizeBuildId(catalog.activeGameBuildId);
const mapPackIds = catalog.mapPacks.map((pack) => pack?.mapPackId);
assert(mapPackIds.every((id) => /^sha256-[a-f0-9]{64}$/.test(id || "")), "maps/catalog.json contains an invalid lowercase mapPackId");
assert(new Set(mapPackIds).size === mapPackIds.length, "maps/catalog.json contains duplicate mapPackId values");
const mapPackPaths = catalog.mapPacks.map((pack) => pack?.path);
assert(new Set(mapPackPaths).size === mapPackPaths.length, "maps/catalog.json contains duplicate paths");
if (catalog.mapPacks.length) {
  assert(activeBuildId, "maps/catalog.json must declare activeGameBuildId when map packs are present");
  assert(catalog.mapPacks.some((entry) => normalizeBuildId(entry?.gameBuildId) === activeBuildId), "maps/catalog.json activeGameBuildId has no map packs");
}

const mapsDirectory = resolve(platformDirectory, "data", "maps");
const { gameAssetsDirectory, mapPacksDirectory: packsDirectory } = localAssetPaths;
for (const [index, entry] of catalog.mapPacks.entries()) {
  validateCatalogEntry(entry, index);
  const packDirectory = resolve(packsDirectory, entry.mapPackId.toLowerCase());
  assert(packDirectory.startsWith(packsDirectory + sep), `catalog entry ${index} resolves outside ${packsDirectory}`);
  const manifestPath = resolve(packDirectory, "map-pack.json");
  const mapPack = await readLocalJson(manifestPath, `map pack ${entry.mapPackId}`);
  assert(mapPack.schemaVersion === 1, `${entry.path} must use schemaVersion 1`);
  assert(SUPPORTED_MAP_PACK_IDENTITY_VERSIONS.includes(mapPack.identityVersion), `${entry.path} must use identityVersion 2 or 3`);
  for (const field of ["mapPackId", "identityVersion", "sceneName", "gameVersion", "projectionVersion", "generatedAtUtc"]) {
    assert(String(mapPack[field]) === String(entry[field]), `${entry.path} ${field} does not match catalog`);
  }
  assert(Number(mapPack.mapSlot) === Number(entry.mapSlot), `${entry.path} mapSlot does not match catalog`);
  assert(normalizeBuildId(mapPack.gameBuildId) === normalizeBuildId(entry.gameBuildId), `${entry.path} gameBuildId does not match catalog`);
  assert(mapPack.coordinateSpace === coordinateSpace, `${entry.path} has an unsupported coordinateSpace`);
  assert(mapPack.textureUv === textureUv, `${entry.path} has an unsupported textureUv`);
  assert(mapPack.imageOrigin === imageOrigin, `${entry.path} has an unsupported imageOrigin`);
  assert(Array.isArray(mapPack.layers) && mapPack.layers.length > 0, `${entry.path} has no layers`);
  try {
    verifyMapPackIdentity(mapPack);
  } catch (error) {
    throw new Error(`${entry.path} identity verification failed: ${error.message}`);
  }
  const segments = new Set();
  for (const [layerIndex, layer] of mapPack.layers.entries()) {
    assert(Number.isInteger(layer?.segment), `${entry.path} layer ${layerIndex} has an invalid segment`);
    assert(!segments.has(layer.segment), `${entry.path} contains duplicate segment ${layer.segment}`);
    segments.add(layer.segment);
    assert(Number.isInteger(layer?.columns) && layer.columns >= 2, `${entry.path} layer ${layerIndex} has invalid columns`);
    assert(Number.isInteger(layer?.rows) && layer.rows >= 2, `${entry.path} layer ${layerIndex} has invalid rows`);
    assert(layer?.heightEncoding === heightEncoding, `${entry.path} layer ${layerIndex} has an unsupported heightEncoding`);
    assert(layer?.noData === "NaN", `${entry.path} layer ${layerIndex} must use noData=NaN`);
    assert(layer?.sampleLocation === "cell-centers", `${entry.path} layer ${layerIndex} must use cell-centers`);
    for (const field of ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"]) {
      assert(typeof layer?.[field] === "number" && Number.isFinite(layer[field]), `${entry.path} layer ${layerIndex} has invalid ${field}`);
    }
    assert(layer.minX < layer.maxX && layer.minZ < layer.maxZ && layer.minY <= layer.maxY, `${entry.path} layer ${layerIndex} has invalid bounds`);
    const assetFields = [["texture", "textureSha256"], ["height", "heightSha256"]];
    if (mapPack.identityVersion === 3) assetFields.push(["geometry", "geometrySha256"]);
    for (const [assetField, hashField] of assetFields) {
      assert(typeof layer?.[assetField] === "string" && layer[assetField].length > 0, `${entry.path} layer ${layerIndex} lacks ${assetField}`);
      const assetPath = resolveInside(packDirectory, packDirectory, layer[assetField], `${entry.path} layer ${layerIndex}`);
      let bytes;
      try {
        bytes = await readFile(assetPath);
      } catch (error) {
        if (error?.code === "ENOENT") throw new Error(`Local map asset is missing: ${localAssetHint(assetPath)}`);
        throw error;
      }
      assert(/^[a-f0-9]{64}$/i.test(layer[hashField] || ""), `${entry.path} layer ${layerIndex} lacks a valid ${hashField}`);
      const digest = createHash("sha256").update(bytes).digest("hex");
      assert(digest.toLowerCase() === String(layer[hashField]).toLowerCase(), `${entry.path} layer ${layerIndex} ${hashField} mismatch`);
      if (assetField === "height") {
        assert(bytes.length === layer.columns * layer.rows * 4, `${entry.path} layer ${layerIndex} height byte length is invalid`);
      }
      if (assetField === "geometry") verifyGeometryGlb(bytes, `${entry.path} layer ${layerIndex} geometry`, layer.geometryFormat);
    }
  }
}

let gameAssets;
try {
  gameAssets = await readGameAssets(gameAssetsDirectory);
} catch (error) {
  throw new Error(`Local game assets are missing or invalid at ${localAssetHint(gameAssetsDirectory)}: ${error.message}`);
}
console.log(`Daily data, ${catalog.mapPacks.length} map packs and ${gameAssets.files.length} game-asset files are valid.`);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readLocalJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Local ${label} is missing or invalid at ${localAssetHint(path)}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function normalizeBuildId(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

function validateCatalogEntry(entry, index) {
  assert(entry && typeof entry === "object", `maps/catalog.json entry ${index} is invalid`);
  assert(SUPPORTED_MAP_PACK_IDENTITY_VERSIONS.includes(entry.identityVersion), `maps/catalog.json entry ${index} has an invalid identityVersion`);
  assert(/^Level_\d+$/.test(entry.sceneName), `maps/catalog.json entry ${index} has an invalid sceneName`);
  assert(Number.isInteger(entry.mapSlot) && entry.sceneName === `Level_${entry.mapSlot}`, `maps/catalog.json entry ${index} has a mismatched mapSlot`);
  assert(typeof entry.gameVersion === "string" && entry.gameVersion.length > 0, `maps/catalog.json entry ${index} has an invalid gameVersion`);
  assert(normalizeBuildId(entry.gameBuildId), `maps/catalog.json entry ${index} has an invalid gameBuildId`);
  assert(Number.isInteger(entry.projectionVersion) && entry.projectionVersion >= 1, `maps/catalog.json entry ${index} has an invalid projectionVersion`);
  assert(isIsoDate(entry.generatedAtUtc), `maps/catalog.json entry ${index} has an invalid generatedAtUtc`);
  assert(entry.path === `./packs/${entry.mapPackId.toLowerCase()}/map-pack.json`, `maps/catalog.json entry ${index} has an unsafe or mismatched path`);
  assert(entry.enabled === undefined || typeof entry.enabled === "boolean", `maps/catalog.json entry ${index} has an invalid enabled flag`);
}

function resolveInside(root, base, reference, label) {
  const result = resolve(base, reference);
  assert(result.startsWith(root + sep), `${label} resolves outside ${root}`);
  return result;
}
