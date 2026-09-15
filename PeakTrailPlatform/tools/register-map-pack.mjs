import { createHash } from "node:crypto";
import { access, copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SUPPORTED_MAP_PACK_IDENTITY_VERSIONS, verifyMapPackIdentity, verifyGeometryGlb } from "./lib/map-pack-identity.mjs";
import { localAssetHint, localAssetPaths, platformDirectory } from "./lib/local-paths.mjs";

const mapsDirectory = resolve(platformDirectory, "data", "maps");
const { mapPacksDirectory: packsDirectory } = localAssetPaths;
const catalogPath = resolve(mapsDirectory, "catalog.json");
const coordinateSpace = "unity-world-meters";
const textureUv = "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)";
const imageOrigin = "bottom-left-in-uv;viewer-flips-for-top-left-images";
const heightEncoding = "float32-le-row-major-minz-minx";
const argumentsList = process.argv.slice(2);
const sourceArgument = argumentsList.find((value) => !value.startsWith("--"));
const activateBuild = argumentsList.includes("--activate-build");

if (!sourceArgument || argumentsList.some((value) => value.startsWith("--") && value !== "--activate-build")) {
  throw new Error("Usage: node PeakTrailPlatform/tools/register-map-pack.mjs <export-folder> [--activate-build]");
}

const sourceDirectory = resolve(sourceArgument);
const sourceManifestPath = resolve(sourceDirectory, "map-pack.json");
const manifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
validateManifest(manifest);
verifyMapPackIdentity(manifest);
const directoryName = String(manifest.mapPackId).toLowerCase();
const destinationDirectory = resolve(packsDirectory, directoryName);
assertInside(packsDirectory, destinationDirectory, "destination map pack");
await mkdir(packsDirectory, { recursive: true });
const lockPath = resolve(mapsDirectory, ".register-map-pack.lock");
let lockHandle;
try {
  lockHandle = await open(lockPath, "wx");
  await lockHandle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
} catch (error) {
  if (lockHandle) {
    await lockHandle.close();
    await rm(lockPath, { force: true });
  }
  if (error?.code === "EEXIST") {
    throw new Error(`Another registration is active, or a stale lock remains: ${lockPath}`);
  }
  throw error;
}

try {
  await registerUnderLock();
} finally {
  try {
    await lockHandle.close();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function registerUnderLock() {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.mapPacks)) {
    throw new Error("data/maps/catalog.json is not a schemaVersion 1 catalog");
  }

  const expectedPath = `./packs/${directoryName}/map-pack.json`;
  const references = await verifyAssets(sourceDirectory);
  const existingEntry = catalog.mapPacks.find((entry) => entry?.mapPackId === manifest.mapPackId);
  if (existingEntry) {
    if (existingEntry.path !== expectedPath) throw new Error(`Catalog path conflict for ${manifest.mapPackId}`);
    if (!await pathExists(destinationDirectory)) {
      throw new Error(`Catalog references a missing local map pack: ${localAssetHint(destinationDirectory)}`);
    }
    await verifyExistingPack(destinationDirectory);
    const buildId = String(manifest.gameBuildId).trim();
    if ((!catalog.activeGameBuildId || activateBuild)
        && String(catalog.activeGameBuildId ?? "").trim() !== buildId) {
      catalog.activeGameBuildId = buildId;
      await writeCatalogAtomically(catalog);
    }
    console.log(`Map pack already registered: ${relative(platformDirectory, destinationDirectory)}`);
    console.log(`Active map build: ${catalog.activeGameBuildId}`);
    return;
  }

  let createdDestination = false;
  if (await pathExists(destinationDirectory)) {
    await verifyExistingPack(destinationDirectory);
  } else {
    const stagingDirectory = resolve(packsDirectory, `.staging-${process.pid}-${Date.now()}`);
    assertInside(packsDirectory, stagingDirectory, "staging map pack");
    await mkdir(stagingDirectory);
    try {
      for (const reference of references) {
        const destinationAsset = resolve(stagingDirectory, reference);
        assertInside(stagingDirectory, destinationAsset, `destination asset ${reference}`);
        await mkdir(dirname(destinationAsset), { recursive: true });
        await copyFile(resolve(sourceDirectory, reference), destinationAsset);
      }
      await copyFile(sourceManifestPath, resolve(stagingDirectory, "map-pack.json"));
      await rename(stagingDirectory, destinationDirectory);
      createdDestination = true;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  const buildId = String(manifest.gameBuildId).trim();
  if (!catalog.activeGameBuildId || activateBuild) catalog.activeGameBuildId = buildId;
  catalog.mapPacks.push({
    mapPackId: manifest.mapPackId,
    identityVersion: manifest.identityVersion,
    sceneName: manifest.sceneName,
    mapSlot: manifest.mapSlot,
    gameVersion: manifest.gameVersion,
    gameBuildId: buildId,
    projectionVersion: manifest.projectionVersion,
    generatedAtUtc: manifest.generatedAtUtc,
    path: expectedPath,
    enabled: true,
  });
  catalog.mapPacks.sort((left, right) =>
    String(left.gameBuildId).localeCompare(String(right.gameBuildId), "en", { numeric: true })
    || Number(left.mapSlot) - Number(right.mapSlot)
    || String(left.generatedAtUtc).localeCompare(String(right.generatedAtUtc)));

  try {
    await writeCatalogAtomically(catalog);
  } catch (error) {
    if (createdDestination) await rm(destinationDirectory, { recursive: true, force: true });
    throw error;
  }

  console.log(`Registered ${manifest.sceneName} / build ${buildId} at ${relative(platformDirectory, destinationDirectory)}`);
  console.log(`Active map build: ${catalog.activeGameBuildId}`);
}

async function verifyAssets(baseDirectory) {
  const references = new Set();
  for (const [layerIndex, layer] of manifest.layers.entries()) {
    const assetFields = [["texture", "textureSha256"], ["height", "heightSha256"]];
    if (manifest.identityVersion === 3) assetFields.push(["geometry", "geometrySha256"]);
    for (const [assetField, hashField] of assetFields) {
      const reference = layer[assetField];
      assertSafeRelativePath(reference, `layer ${layerIndex} ${assetField}`);
      const assetPath = resolve(baseDirectory, reference);
      assertInside(baseDirectory, assetPath, `layer ${layerIndex} ${assetField}`);
      const bytes = await readFile(assetPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (!/^[a-f0-9]{64}$/i.test(layer[hashField] || "")) throw new Error(`layer ${layerIndex} is missing a valid ${hashField}`);
      if (digest.toLowerCase() !== String(layer[hashField]).toLowerCase()) throw new Error(`layer ${layerIndex} ${hashField} does not match ${reference}`);
      if (assetField === "height" && bytes.length !== layer.columns * layer.rows * 4) throw new Error(`layer ${layerIndex} height byte length does not match its grid`);
      if (assetField === "geometry") verifyGeometryGlb(bytes, `layer ${layerIndex} geometry`, layer.geometryFormat);
      references.add(reference);
    }
  }
  return references;
}

async function verifyExistingPack(directory) {
  const existingManifestBytes = await readFile(resolve(directory, "map-pack.json"));
  const sourceManifestBytes = await readFile(sourceManifestPath);
  if (!existingManifestBytes.equals(sourceManifestBytes)) throw new Error(`Existing map-pack.json differs in ${directory}`);
  await verifyAssets(directory);
}

async function writeCatalogAtomically(catalog) {
  const temporaryPath = resolve(mapsDirectory, `.catalog-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await rename(temporaryPath, catalogPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1) throw new Error("map-pack.json must use schemaVersion 1");
  if (!SUPPORTED_MAP_PACK_IDENTITY_VERSIONS.includes(value.identityVersion)) throw new Error("map-pack.json must use identityVersion 2 or 3");
  if (!/^sha256-[a-f0-9]{64}$/.test(value.mapPackId || "")) throw new Error("map-pack.json has an invalid lowercase mapPackId");
  if (!/^Level_\d+$/.test(value.sceneName || "")) throw new Error("map-pack.json has an invalid sceneName");
  if (!Number.isInteger(value.mapSlot) || value.sceneName !== `Level_${value.mapSlot}`) throw new Error("map-pack.json mapSlot does not match sceneName");
  if (!value.gameVersion || !validBuildId(value.gameBuildId)) throw new Error("map-pack.json lacks valid game version/build identity");
  if (!Number.isInteger(value.projectionVersion) || value.projectionVersion < 1) throw new Error("map-pack.json has an invalid projectionVersion");
  if (!Number.isFinite(Date.parse(value.generatedAtUtc))) throw new Error("map-pack.json has an invalid generatedAtUtc");
  if (!Array.isArray(value.layers) || value.layers.length === 0) throw new Error("map-pack.json has no layers");
  if (value.coordinateSpace !== coordinateSpace || value.textureUv !== textureUv || value.imageOrigin !== imageOrigin) {
    throw new Error("map-pack.json uses an unsupported coordinate/texture convention");
  }
  const segments = new Set();
  for (const [index, layer] of value.layers.entries()) {
    if (!Number.isInteger(layer?.segment) || segments.has(layer.segment)) throw new Error(`layer ${index} has an invalid or duplicate segment`);
    segments.add(layer.segment);
    if (typeof layer.id !== "string" || !layer.id || typeof layer.biome !== "string" || !layer.biome) throw new Error(`layer ${index} lacks identity metadata`);
    if (!Number.isInteger(layer.columns) || layer.columns < 2 || !Number.isInteger(layer.rows) || layer.rows < 2) throw new Error(`layer ${index} has an invalid grid`);
    if (layer.heightEncoding !== heightEncoding || layer.noData !== "NaN" || layer.sampleLocation !== "cell-centers") throw new Error(`layer ${index} uses an unsupported height convention`);
    const bounds = [layer.minX, layer.maxX, layer.minY, layer.maxY, layer.minZ, layer.maxZ];
    if (!bounds.every((part) => typeof part === "number" && Number.isFinite(part))
        || layer.minX >= layer.maxX || layer.minZ >= layer.maxZ || layer.minY > layer.maxY) {
      throw new Error(`layer ${index} has invalid world bounds`);
    }
  }
}

function validBuildId(value) {
  return /^[1-9]\d*$/.test(String(value ?? "").trim());
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || !value || isAbsolute(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value) || /^[a-z]+:/i.test(value)) {
    throw new Error(`${label} is not a safe relative path`);
  }
}

function assertInside(root, target, label) {
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`${label} resolves outside ${root}`);
}
