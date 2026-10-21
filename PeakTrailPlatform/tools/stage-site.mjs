import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readGameAssets } from "./lib/game-assets.mjs";
import { localAssetHint, localAssetPaths } from "./lib/local-paths.mjs";
import { normalizeMapFog } from "../web/src/map-fog.js";
import { normalizeMapWater } from "../web/src/map-water.js";
import { normalizeMapEnclosures } from "../web/src/map-enclosures.js";
import { normalizeMapPeak } from "../web/src/map-peak.js";
import { normalizeMapLoot } from "../web/src/map-loot.js";
import { fitMapAlignment, validateMapAlignment } from "../server/map-alignment.mjs";
import { createHash } from "node:crypto";
import { HOME_ART_FILES } from "../web/src/home-art.js";
import { checkSiteBudget, checkSiteDownloadReferences, loadSiteArtifact, optionValue, readSiteRelease, siteReleaseOptions, readSiteStagingProfile } from "./lib/site-release.mjs";
import { createPublicAssetWriter } from "./lib/public-asset-pool.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const platformDirectory = resolve(toolDirectory, "..");
const webDirectory = resolve(platformDirectory, "web");
const dataDirectory = resolve(platformDirectory, "data");
const mapsDirectory = resolve(dataDirectory, "maps");
const schemaDirectory = resolve(platformDirectory, "schema");
const bundledHomeArtDirectory = resolve(dataDirectory, "home-art");
const itemEventAssetsDirectory = resolve(dataDirectory, "item-event-assets");
const outputDirectory = resolve(platformDirectory, "site-dist");
const { gameAssetsDirectory, mapPacksDirectory, mapEnclosuresDirectory, homeArtDirectory } = localAssetPaths;

// Keep bookmarked URLs recoverable without publishing the retired recorder
// tutorial or standalone collector. Only shared language controls are loaded.
const retiredEntryPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>旧足迹入口暂时下线 · PEAK 回忆录</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1917;color:#edf5ee;font:16px/1.8 system-ui}main{max-width:32rem;padding:2rem}h1{font-size:1.5rem}a{color:#9cdbc1}button{display:block;margin-left:auto;border:1px solid #9cdbc155;border-radius:8px;padding:9px 12px;background:#152422;color:#edf5ee;cursor:pointer}</style></head>
<body><main><button data-language-toggle type="button" aria-label="切换为英语" title="切换为英语" lang="en"><span data-language-label>English</span></button><h1>旧足迹入口暂时下线</h1><p>现在使用回忆录 Mod 录制与回放。在首页进入地图后，可查看回忆录上传的路线与热力图。</p>
<a href="./">返回首页</a></main><script type="module">import { initLanguageControls } from './src/i18n-dom.js'; initLanguageControls();</script></body></html>\n`;

export async function stageSite({ preview = false, argv = process.argv.slice(2), env = process.env } = {}) {
const profile = await readSiteStagingProfile(resolve(toolDirectory, "site-build-profile.json"), argv, { preview });
if (env.PEAK_TRAIL_PUBLIC_ASSET_POOL !== undefined && (profile !== "server" || preview))
  throw new Error("Public asset pool is only available for receiver server staging");
const assetWriter = await createPublicAssetWriter(env.PEAK_TRAIL_PUBLIC_ASSET_POOL);
// Verify every advertised DLL before replacing a previously staged site.
const downloadOptions = siteReleaseOptions(argv, env);
const downloadRelease = await readSiteRelease(dataDirectory, downloadOptions.product);
const downloadBytes = await loadSiteArtifact(downloadRelease, { ...downloadOptions, preview });
const downloads = [{ product: downloadOptions.product, release: downloadRelease, bytes: downloadBytes }];
if (downloadOptions.product === "memories") {
  const release = await readSiteRelease(dataDirectory, "recorder");
  const localPath = optionValue(argv, "--recorder-dll") || env.PEAK_TRAIL_RECORDER_DLL;
  const bytes = await loadSiteArtifact(release, { product: "recorder", localPath });
  downloads.push({ product: "recorder", release, bytes });
}
checkSiteDownloadReferences([
  await readFile(resolve(webDirectory, "index.html"), "utf8"),
  await readFile(resolve(webDirectory, "mods.html"), "utf8"),
  retiredEntryPage,
], downloadRelease, downloads[1]?.release);
// Only allowlisted illustrations are public; never copy a local folder wholesale.
const homeArtSources = new Map();
for (const file of HOME_ART_FILES) {
  const localPath = resolve(homeArtDirectory, file);
  const bundledPath = resolve(bundledHomeArtDirectory, file);
  let source = localPath;
  let entry;
  try {
    entry = await lstat(localPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    source = bundledPath;
    entry = await lstat(bundledPath);
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8 * 1024 * 1024)
    throw new Error(`Invalid homepage illustration: ${file}`);
  homeArtSources.set(file, source);
}
// Fail before replacing the running preview if an extraction is incomplete.
let gameAssets;
try {
  gameAssets = await readGameAssets(gameAssetsDirectory);
} catch (error) {
  throw new Error(`Local game assets are missing or invalid at ${localAssetHint(gameAssetsDirectory)}: ${error.message}`);
}
const itemEventCatalog = await lstat(resolve(itemEventAssetsDirectory, "catalog.json"))
  .catch(error => { if (error.code === "ENOENT") return null; throw error; });
if (itemEventCatalog && (!itemEventCatalog.isFile() || itemEventCatalog.isSymbolicLink())) throw new Error("Invalid bundled item-event catalog");
const itemEventAssets = itemEventCatalog ? await readGameAssets(itemEventAssetsDirectory) : null;
const publishedSchemas = [
  "daily-map.schema.json",
  "map-catalog.schema.json",
  "map-pack.schema.json",
  "peaktrace-manifest.schema.json",
  "peaktrace-stream.schema.json",
  "peaktrace-history.schema.json",
  "peaktrace-route.schema.json",
  "peaktrace-world.schema.json",
  "peaktrace-status.schema.json",
];

const catalog = JSON.parse(await readFile(resolve(mapsDirectory, "catalog.json"), "utf8"));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.mapPacks)) {
  throw new Error("Cannot stage an invalid map catalog");
}
const mapPacks = [];
const enclosureFiles = new Set();
const trajectorySidecars = new Map();
for (const entry of catalog.mapPacks) {
  const mapPackId = String(entry?.mapPackId || "").toLowerCase();
  const expectedPath = `./packs/${mapPackId}/map-pack.json`;
  if (!/^sha256-[a-f0-9]{64}$/.test(mapPackId) || entry.path !== expectedPath) {
    throw new Error(`Cannot stage unsafe map catalog path: ${entry?.path}`);
  }
  const sourceDirectory = resolve(mapPacksDirectory, mapPackId);
  const { files, manifest } = await readMapPackAllowlist(sourceDirectory, mapPackId);
  const route = await verifiedRouteMetadata(manifest);
  const mapFog = await verifiedFogMetadata(manifest);
  const mapWater = await verifiedWaterMetadata(manifest);
  const mapEnclosures = await verifiedEnclosureMetadata(manifest);
  const mapPeak = await verifiedPeakMetadata(manifest);
  const landmarks = await verifiedLandmarkMetadata(manifest);
  if (landmarks && !route) throw new Error("Map landmark evidence requires native route evidence");
  if (route) {
    const filename = `routes.${manifest.gameBuildId}.json`;
    if (!trajectorySidecars.has(filename)) trajectorySidecars.set(filename, { schemaVersion: 1, gameBuildId: String(manifest.gameBuildId), maps: [] });
    trajectorySidecars.get(filename).maps.push({ mapPackId, sceneName: manifest.sceneName, mapSlot: manifest.mapSlot,
      sourceSceneSha256: manifest.source.sceneSha256, route: publicRouteMetadata(route) });
  }
  if (landmarks) {
    const filename = `landmarks.${manifest.gameBuildId}.json`;
    if (!trajectorySidecars.has(filename)) trajectorySidecars.set(filename, { ...landmarks.header, maps: [] });
    trajectorySidecars.get(filename).maps.push(landmarks.entry);
  }
  for (const enclosure of mapEnclosures?.enclosures || []) {
    if (enclosureFiles.has(enclosure.geometry)) continue;
    const path = resolve(mapEnclosuresDirectory, enclosure.geometry);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Map enclosure geometry must be a regular file");
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (digest !== enclosure.geometrySha256) throw new Error("Map enclosure geometry SHA-256 mismatch");
    enclosureFiles.add(enclosure.geometry);
  }
  mapPacks.push({ mapPackId, sourceDirectory, files, manifest, route, mapFog, mapWater, mapEnclosures, mapPeak });
}

// Supply and animal surveys must match each canonical map before publication.
const lootCatalogs = new Map();
for (const build of new Set(mapPacks.map(pack => String(pack.manifest.gameBuildId)))) {
  if (!/^\d{1,20}$/.test(build)) continue;
  let raw;
  try {
    const path = resolve(mapsDirectory, `loot.${build}.json`), file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("Map supply survey must be a regular file");
    if (file.size > 96 * 1024 * 1024) throw new Error("Map supply survey exceeds size limit");
    const body = await readFile(path);
    if (body.length > 96 * 1024 * 1024) throw new Error("Map supply survey exceeds size limit");
    raw = JSON.parse(body.toString("utf8"));
  } catch (error) { if (error.code === "ENOENT") continue; throw error; }
  const entries = [], chunks = [];
  const source = {};
  for (const key of ["kind", "anchor", "positions", "chestCoverage", "itemCoverage", "animalCoverage", "componentCoverage", "excluded"]) {
    const value = raw.source?.[key];
    if (typeof value === "string" && value.length <= 4096) source[key] = value;
  }
  for (const pack of mapPacks.filter(pack => String(pack.manifest.gameBuildId) === build)) {
    if (!raw.maps?.some(entry => entry.mapPackId === pack.mapPackId)) continue;
    const normalized = normalizeMapLoot(raw, pack.manifest);
    if (!normalized) throw new Error(`Map supply survey does not match ${pack.mapPackId}`);
    const original = raw.maps.find(entry => entry.mapPackId === pack.mapPackId);
    const entry = { mapPackId: normalized.mapPackId, sceneName: normalized.sceneName, mapSlot: pack.manifest.mapSlot,
      sourceSceneSha256: normalized.sourceSceneSha256,
      ...(original.layers ? { layers: original.layers.map(layer => ({ id: layer.id, segment: layer.segment, geometrySha256: layer.geometrySha256 })) } : {}),
      markers: normalized.markers };
    const path = `loot/${build}/${pack.mapPackId}.json`;
    const survey = { schemaVersion: 1, gameBuildId: build, types: normalized.types,
      ...(Object.keys(source).length ? { source } : {}), maps: [entry] };
    const body = JSON.stringify(survey) + "\n";
    if (Buffer.byteLength(body, "utf8") > 24 * 1024 * 1024) throw new Error(`Map supply map payload exceeds size limit: ${pack.mapPackId}`);
    chunks.push({ path, body });
    entries.push({ mapPackId: entry.mapPackId, sceneName: entry.sceneName, mapSlot: entry.mapSlot,
      sourceSceneSha256: entry.sourceSceneSha256, path });
  }
  if (!entries.length) throw new Error(`Map supply survey has no matching maps for build ${build}`);
  lootCatalogs.set(build, { index: { schemaVersion: 1, kind: "map-loot-index", gameBuildId: build,
    ...(Object.keys(source).length ? { source } : {}), maps: entries }, chunks });
}

// site-dist is generated exclusively by this script and is safe to recreate.
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await mkdir(resolve(outputDirectory, "data", "maps"), { recursive: true });
for (const [build, { index, chunks }] of lootCatalogs) {
  await writeFile(resolve(outputDirectory, "data", "maps", `loot.${build}.json`), JSON.stringify(index) + "\n");
  await mkdir(resolve(outputDirectory, "data", "maps", "loot", build), { recursive: true });
  for (const { path, body } of chunks) await writeFile(resolve(outputDirectory, "data", "maps", path), body);
}
for (const [filename, evidence] of trajectorySidecars) await writeFile(resolve(outputDirectory, "data", "maps", filename), JSON.stringify(evidence, null, 2) + "\n");
await mkdir(resolve(outputDirectory, "schema"), { recursive: true });
for (const { product, release, bytes } of downloads) {
  await mkdir(dirname(resolve(outputDirectory, release.downloadPath)), { recursive: true });
  await mkdir(resolve(outputDirectory, "data", product), { recursive: true });
  await assetWriter.stageImmutableBytes(bytes, resolve(outputDirectory, release.downloadPath));
  await writeFile(resolve(outputDirectory, "data", product, "release.json"), JSON.stringify(release, null, 2) + "\n");
}
await Promise.all([
  cp(resolve(webDirectory, "index.html"), resolve(outputDirectory, "index.html")),
  cp(resolve(webDirectory, "mods.html"), resolve(outputDirectory, "mods.html")),
  cp(resolve(webDirectory, "mods.css"), resolve(outputDirectory, "mods.css")),
  writeFile(resolve(outputDirectory, "guide.html"), retiredEntryPage),
  writeFile(resolve(outputDirectory, "routes.html"), retiredEntryPage),
  cp(resolve(webDirectory, "styles.css"), resolve(outputDirectory, "styles.css")),
  cp(resolve(webDirectory, "home.css"), resolve(outputDirectory, "home.css")),
  cp(resolve(webDirectory, "src"), resolve(outputDirectory, "src"), { recursive: true }),
  cp(resolve(platformDirectory, "vendor"), resolve(outputDirectory, "vendor"), { recursive: true }),
  cp(resolve(dataDirectory, "daily"), resolve(outputDirectory, "data", "daily"), { recursive: true }),
  cp(resolve(mapsDirectory, "catalog.json"), resolve(outputDirectory, "data", "maps", "catalog.json")),
  ...publishedSchemas.map((name) => cp(
    resolve(schemaDirectory, name),
    resolve(outputDirectory, "schema", name),
  )),
]);
await mkdir(resolve(outputDirectory, "data", "home-art"), { recursive: true });
for (const file of HOME_ART_FILES) await assetWriter.stageImmutable(homeArtSources.get(file), resolve(outputDirectory, "data", "home-art", file));

for (const pack of mapPacks) {
  for (const reference of pack.files) {
    const destination = resolve(outputDirectory, "data", "maps", "packs", pack.mapPackId, reference);
    await mkdir(dirname(destination), { recursive: true });
    // Manifests are enriched below and must never share a writable inode with
    // an earlier release. Only allowlisted geometry/texture/height bytes pool.
    if (reference === "map-pack.json") await cp(resolve(pack.sourceDirectory, reference), destination);
    else await assetWriter.stageImmutable(resolve(pack.sourceDirectory, reference), destination);
  }
  // Route evidence is additive metadata and is not part of geometry identity.
  // Original canonical packs remain untouched; only the generated site is enriched.
  if (pack.route || pack.mapFog || pack.mapWater || pack.mapEnclosures || pack.mapPeak) await writeFile(
    resolve(outputDirectory, "data", "maps", "packs", pack.mapPackId, "map-pack.json"),
    JSON.stringify({ ...pack.manifest, ...(pack.route ? { route: pack.route } : {}),
      ...(pack.mapFog ? { mapFog: pack.mapFog } : {}),
      ...(pack.mapWater ? { mapWater: pack.mapWater } : {}),
      ...(pack.mapEnclosures ? { mapEnclosures: pack.mapEnclosures } : {}),
      ...(pack.mapPeak ? { mapPeak: pack.mapPeak } : {}) }, null, 2) + "\n",
  );
}
if (enclosureFiles.size) {
  const destination = resolve(outputDirectory, "data", "maps", "enclosures");
  await mkdir(destination, { recursive: true });
  for (const file of enclosureFiles) await assetWriter.stageImmutable(resolve(mapEnclosuresDirectory, file), resolve(destination, file));
}
for (const reference of gameAssets.files) {
  const destination = resolve(outputDirectory, "data", "game-assets", reference);
  await mkdir(dirname(destination), { recursive: true });
  // Catalogs describe each release; explicitly allowlisted static models can
  // also be JSON and share bytes just like textures and geometry.
  if (reference === "catalog.json" || /^\d+\/catalog\.json$/.test(reference)) await cp(resolve(gameAssetsDirectory, reference), destination);
  else await assetWriter.stageImmutable(resolve(gameAssetsDirectory, reference), destination);
}
for (const reference of itemEventAssets?.files ?? []) {
  const destination = resolve(outputDirectory, "data", "item-event-assets", reference);
  await mkdir(dirname(destination), { recursive: true });
  if (reference === "catalog.json" || /^\d+\/catalog\.json$/.test(reference)) await cp(resolve(itemEventAssetsDirectory, reference), destination);
  else await assetWriter.stageImmutable(resolve(itemEventAssetsDirectory, reference), destination);
}
await writeFile(resolve(outputDirectory, ".nojekyll"), "", "utf8");

let totalBytes = 0;
let fileCount = 0;
async function measure(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await measure(path);
    else if (entry.isFile()) { totalBytes += (await stat(path)).size; fileCount++; }
  }
}
await measure(outputDirectory);
checkSiteBudget(totalBytes, { preview, profile });
console.log(`Staged ${preview ? "local preview (not a public release; GitHub Pages budget not applied)" : `${profile} public site`} at ${outputDirectory}`);
console.log(`${fileCount} files, ${(totalBytes / 1_000_000).toFixed(1)} MB; ${catalog.mapPacks.length} map packs. No private recordings are staged.`);
const publicAssetPool = assetWriter.stats();
if (publicAssetPool.enabled) console.log(`Public asset pool: ${JSON.stringify(publicAssetPool)}`);
return { outputDirectory, release: downloadRelease, releases: downloads.map(item => item.release), product: downloadOptions.product, preview, profile, fileCount, totalBytes, publicAssetPool };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await stageSite({ preview: process.argv.includes("--preview") });

async function readMapPackAllowlist(directory, expectedMapPackId) {
  const manifestPath = resolve(directory, "map-pack.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Local map pack ${expectedMapPackId} is missing or invalid at ${localAssetHint(manifestPath)}: ${error.message}`);
  }
  if (manifest?.mapPackId !== expectedMapPackId || !Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    throw new Error(`Local map pack manifest does not match catalog entry ${expectedMapPackId}: ${manifestPath}`);
  }

  const files = new Set(["map-pack.json"]);
  for (const [layerIndex, layer] of manifest.layers.entries()) {
    const fields = ["texture", "height"];
    if (manifest.identityVersion === 3) fields.push("geometry");
    for (const field of fields) {
      const reference = layer?.[field];
      assertSafeRelativePath(reference, `${expectedMapPackId} layer ${layerIndex} ${field}`);
      files.add(reference);
    }
  }

  for (const reference of files) {
    const source = resolve(directory, reference);
    if (source !== manifestPath && !source.startsWith(directory + sep)) {
      throw new Error(`Map asset escapes local pack ${expectedMapPackId}: ${reference}`);
    }
    let entry;
    try {
      entry = await lstat(source);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Local map asset is missing: ${localAssetHint(source)}`);
      }
      throw error;
    }
    if (!entry.isFile()) throw new Error(`Local map asset must be a regular file: ${source}`);
  }
  return { files: [...files], manifest };
}

async function verifiedRouteMetadata(manifest) {
  const build = String(manifest.gameBuildId || "");
  if (!/^\d+$/.test(build)) return null;
  let evidence;
  try {
    evidence = JSON.parse(await readFile(resolve(mapsDirectory, `routes.${build}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (evidence.schemaVersion !== 1 || String(evidence.gameBuildId) !== build || !Array.isArray(evidence.maps)) {
    throw new Error(`Invalid route evidence for build ${build}`);
  }
  const entries = evidence.maps.filter((entry) => entry.mapPackId === manifest.mapPackId);
  if (!entries.length) return null;
  const entry = entries[0];
  if (entries.length !== 1 || entry.sceneName !== manifest.sceneName || entry.mapSlot !== manifest.mapSlot
      || entry.sourceSceneSha256 !== manifest.source?.sceneSha256 || !Array.isArray(entry.route?.segments)
      || !["volcano-kiln", "swamp-temple"].includes(entry.route.branch)) throw new Error("Route evidence identity mismatch");
  for (const segment of entry.route.segments) {
    if (!manifest.layers.some((layer) => layer.segment === segment.index && layer.biome === segment.biome)) {
      throw new Error(`Route evidence disagrees with geometry: ${manifest.sceneName}, segment ${segment.index}`);
    }
  }
  return publicRouteMetadata(entry.route);
}

function publicRouteMetadata(route) {
  // Build a fresh static-game whitelist; never copy arbitrary neighbouring
  // metadata or fields from an evidence document into the public service.
  return { authority: "serialized-map-handler", branch: route.branch, segments: route.segments.map(segment => {
    const selected = {};
    for (const key of ["index", "biome", "biomeId", "name", "campfireName", "stageId", "displayName"]) {
      if (!Object.hasOwn(segment, key)) continue;
      const value = segment[key];
      if (["index", "biomeId"].includes(key) ? !Number.isInteger(value) || value < 0 :
        !(key === "campfireName" && value === null) && (typeof value !== "string" || value.length > 120 || /[\u0000-\u001f]/u.test(value))) throw new Error("Invalid native route field");
      selected[key] = value;
    }
    return selected;
  }) };
}

async function verifiedLandmarkMetadata(manifest) {
  const build = String(manifest.gameBuildId || "");
  if (!/^\d+$/.test(build)) return null;
  let evidence;
  try { evidence = JSON.parse(await readFile(resolve(mapsDirectory, `landmarks.${build}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (evidence.schemaVersion !== 1 || String(evidence.gameBuildId) !== build || evidence.authority !== "serialized-map-landmarks"
    || !Array.isArray(evidence.maps)) throw new Error("Invalid map landmark evidence");
  const matches = evidence.maps.filter(value => value.mapPackId === manifest.mapPackId);
  // A provisioned build must cover its complete catalog before publication.
  // Builds with no sidecar remain available as a model, with routes pending.
  if (matches.length !== 1) throw new Error("Missing or duplicate exact map landmark evidence");
  const value = matches[0];
  if (value.sceneName !== manifest.sceneName || !/^[a-f0-9]{64}$/.test(value.sourceSceneSha256 || "")
    || value.sourceSceneSha256 !== manifest.source?.sceneSha256) throw new Error("Map landmark source identity mismatch");
  const alignment = validateMapAlignment(value.alignment);
  if (alignment.landmarks.some(point => point.stageIndex !== undefined && !manifest.layers.some(layer => layer.segment === point.stageIndex))
    || fitMapAlignment(alignment, alignment).status !== "verified") throw new Error("Map landmarks cannot prove the source layout");
  const header = { schemaVersion: 1, gameBuildId: build, authority: evidence.authority };
  if (typeof evidence.gameVersion === "string") header.gameVersion = evidence.gameVersion;
  if (header.gameVersion && manifest.gameVersion && header.gameVersion !== manifest.gameVersion) throw new Error("Map landmark game version mismatch");
  if (/^[a-f0-9]{32}$/.test(evidence.sourceGameAssemblyMvid || "")) header.sourceGameAssemblyMvid = evidence.sourceGameAssemblyMvid;
  if (/^[a-f0-9]{64}$/.test(evidence.sourceGameAssemblySha256 || "")) header.sourceGameAssemblySha256 = evidence.sourceGameAssemblySha256;
  const entry = { sceneName: manifest.sceneName, mapPackId: manifest.mapPackId, sourceSceneSha256: value.sourceSceneSha256, alignment };
  if (value.expectedLegacyLayoutKey !== undefined || value.legacyRootTransformPolicy !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(value.expectedLegacyLayoutKey || "") || value.legacyRootTransformPolicy !== "static-no-runtime-trs-writes"
      || !header.sourceGameAssemblyMvid || !header.sourceGameAssemblySha256) throw new Error("Invalid legacy map landmark proof");
    entry.expectedLegacyLayoutKey = value.expectedLegacyLayoutKey;
    entry.legacyRootTransformPolicy = value.legacyRootTransformPolicy;
  }
  return { header, entry };
}

async function verifiedFogMetadata(manifest) {
  const build = String(manifest.gameBuildId || "");
  if (!/^\d+$/.test(build)) return null;
  let evidence;
  try {
    evidence = JSON.parse(await readFile(resolve(mapsDirectory, `fog.${build}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (evidence.schemaVersion !== 1 || evidence.authority !== "serialized-map-baseline"
    || String(evidence.gameBuildId) !== build || !Array.isArray(evidence.maps)) throw new Error("Invalid map fog evidence");
  const matches = evidence.maps.filter((entry) => entry.mapPackId === manifest.mapPackId);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("Duplicate map fog evidence");
  const value = normalizeMapFog({ ...matches[0], schemaVersion: 1, gameBuildId: build,
    authority: evidence.authority, note: evidence.note }, manifest);
  if (!value || value.mapSlot !== manifest.mapSlot) throw new Error("Map fog evidence identity or field mismatch");
  return value;
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || !value || isAbsolute(value)
      || /(^|[\\/])\.\.([\\/]|$)/.test(value) || /^[a-z]+:/i.test(value)) {
    throw new Error(`${label} is not a safe relative path`);
  }
}

async function verifiedWaterMetadata(manifest) {
  const build = String(manifest.gameBuildId || "");
  if (!/^\d+$/.test(build)) return null;
  let evidence;
  try {
    evidence = JSON.parse(await readFile(resolve(mapsDirectory, `water.${build}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (evidence.schemaVersion !== 1 || evidence.authority !== "serialized-map-baseline"
    || String(evidence.gameBuildId) !== build || !Array.isArray(evidence.maps)) throw new Error("Invalid map water evidence");
  const matches = evidence.maps.filter(entry => entry.mapPackId === manifest.mapPackId);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("Duplicate map water evidence");
  const value = normalizeMapWater({ ...matches[0], schemaVersion: 1, gameBuildId: build,
    authority: evidence.authority, note: evidence.note }, manifest);
  if (!value || value.mapSlot !== manifest.mapSlot) throw new Error("Map water evidence identity or plane mismatch");
  return value;
}

async function verifiedEnclosureMetadata(manifest) {
  const build = String(manifest.gameBuildId || "");
  if (!/^\d+$/.test(build)) return null;
  let evidence;
  try { evidence = JSON.parse(await readFile(resolve(mapsDirectory, `enclosures.${build}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (evidence.schemaVersion !== 1 || evidence.authority !== "serialized-map-enclosure"
    || String(evidence.gameBuildId) !== build || !Array.isArray(evidence.maps)) throw new Error("Invalid map enclosure evidence");
  const matches = evidence.maps.filter(entry => entry.mapPackId === manifest.mapPackId);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("Duplicate map enclosure evidence");
  const value = normalizeMapEnclosures({ ...matches[0], schemaVersion: 1, gameBuildId: build,
    authority: evidence.authority }, manifest);
  if (!value) throw new Error("Map enclosure evidence identity or geometry mismatch");
  return value;
}

async function verifiedPeakMetadata(manifest) {
  const build = String(manifest.gameBuildId || "");
  if (!/^\d+$/.test(build)) return null;
  let evidence;
  try { evidence = JSON.parse(await readFile(resolve(mapsDirectory, `peaks.${build}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (evidence.schemaVersion !== 1 || evidence.authority !== "serialized-peak-handler"
      || String(evidence.gameBuildId) !== build || !Array.isArray(evidence.maps)) {
    throw new Error("Invalid PeakHandler evidence");
  }
  const matches = evidence.maps.filter(entry => entry.mapPackId === manifest.mapPackId);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("Duplicate PeakHandler evidence");
  const value = normalizeMapPeak({ ...matches[0], schemaVersion: 1, gameBuildId: build,
    authority: evidence.authority }, manifest);
  if (!value || value.sourceSceneSha256 !== manifest.source?.sceneSha256) {
    throw new Error("PeakHandler evidence identity or geometry mismatch");
  }
  return value;
}
