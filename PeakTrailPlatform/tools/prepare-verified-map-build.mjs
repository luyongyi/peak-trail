import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMapPackId, verifyMapPackIdentity, verifyGeometryGlb } from "./lib/map-pack-identity.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const packPattern = /^sha256-[a-f0-9]{64}$/;
const hashPattern = /^[a-f0-9]{64}$/;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
async function regular(path) {
  const entry = await lstat(path);
  requireValue(entry.isFile() && !entry.isSymbolicLink(), `Expected regular file: ${path}`);
  return readFile(path);
}
function assetName(name) {
  requireValue(typeof name === "string" && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(png|f32|glb(?:\.gz)?)$/.test(name), "Unsafe map asset name");
  return name;
}
const positive = value => Number.isSafeInteger(value) && value > 0;
function validateReceipt(proof, catalogBytes, evidenceBytes, sources) {
  requireValue(proof.verified === true && digest(catalogBytes) === proof.sourceCatalogSha256
    && digest(evidenceBytes) === proof.sourceEvidenceSha256, "Receipt source catalog/evidence SHA-256 mismatch or proof incomplete");
  const evidence = JSON.parse(evidenceBytes);
  requireValue(evidence.schemaVersion === 1 && evidence.authority === "installed-game-assets-and-serialized-map-baker"
    && String(evidence.gameBuildId) === proof.sourceBuildId && positive(evidence.sceneCount)
    && evidence.sceneCount === sources.length && Array.isArray(evidence.maps) && evidence.maps.length === sources.length,
  "Incomplete source scene evidence");
  const order = proof.sceneOrder;
  requireValue(order?.equal === true && order.count === sources.length && order.assetFile === "resources.assets"
    && order.componentClass === "MapBaker" && order.field === "ScenePaths"
    && hashPattern.test(order.assetSha256 || "") && order.objectSha256 === evidence.sceneOrder?.objectSha256
    && hashPattern.test(order.objectSha256 || "") && Array.isArray(order.scenePaths)
    && order.scenePaths.length === sources.length, "Incomplete native scene order proof");
  const bundles = new Map();
  requireValue(Array.isArray(evidence.bundles) && evidence.bundles.length === proof.bundles.length, "Incomplete bundle proof");
  for (const bundle of proof.bundles) {
    const source = evidence.bundles.find(item => item.file === bundle.file);
    requireValue(source && /^StreamingAssets\/maps\/levels\d+-\d+\.assetbundle$/.test(bundle.file)
      && !bundles.has(bundle.file) && hashPattern.test(bundle.sha256 || "") && bundle.sha256 === source.sha256
      && positive(bundle.bytes) && positive(bundle.extractedBytes) && bundle.extractedBytes === source.extractedBytes
      && bundle.bundleContentsVerified === true
      && hashPattern.test(bundle.extractionEvidenceSha256 || "") && positive(bundle.memberCount)
      && positive(bundle.serializedFiles) && bundle.serializedFiles <= bundle.memberCount
      && Number.isSafeInteger(bundle.streamedGeometryAndTextures) && bundle.streamedGeometryAndTextures >= 0
      && Array.isArray(bundle.dependencies) && bundle.dependencies.every(value => typeof value === "string" && value.length > 0)
      && new Set(bundle.dependencies).size === bundle.dependencies.length, "Invalid or duplicate bundle proof");
    bundles.set(bundle.file, bundle);
  }
  const scenes = new Set(), packs = new Set();
  for (const item of proof.maps) {
    const native = evidence.maps.find(value => value.sceneName === item.sceneName);
    requireValue(Number.isSafeInteger(item.mapSlot) && item.mapSlot >= 0 && item.sceneName === `Level_${item.mapSlot}`
      && !scenes.has(item.sceneName) && !packs.has(item.sourceMapPackId)
      && native && native.mapPackId === item.sourceMapPackId && native.mapSlot === item.mapSlot
      && native.sceneSha256 === item.sourceSceneSha256 && native.sceneFile === item.sceneFile && native.bundle === item.bundle
      && bundles.has(`StreamingAssets/maps/${item.bundle}`)
      && item.sceneFile === `${item.bundle.replace(/\.assetbundle$/, "")}/BuildPlayer-${item.sceneName}`
      && order.scenePaths[item.mapSlot] === native.scenePath && native.scenePath === `Assets/8_SCENES/Generated/${item.sceneName}.unity`
      && hashPattern.test(item.sourceManifestSha256 || "") && positive(item.derivativeFiles) && positive(item.derivativeBytes),
    "Invalid, duplicate or incomplete receipt scene");
    scenes.add(item.sceneName); packs.add(item.sourceMapPackId);
  }
  requireValue(scenes.size === sources.length && new Set(sources.map(item => item.sceneName)).size === sources.length
    && new Set(sources.map(item => item.mapSlot)).size === sources.length
    && new Set(sources.map(item => item.mapPackId)).size === sources.length, "Duplicate source catalog scene or pack");
  const comparisons = proof.codeComparisons;
  requireValue(hashPattern.test(proof.unityDefaultResourcesSha256 || "") && Array.isArray(comparisons) && comparisons.length === 2
    && new Set(comparisons.map(item => item.type)).size === 2 && comparisons.every(item => ["MapBaker", "MapHandler"].includes(item.type)
      && item.equal === true && item.comparison === "normalized-decompiled-text" && hashPattern.test(item.sha256 || "")
      && hashPattern.test(item.baselineFileSha256 || "")), "Incomplete native dependency/code proof");
  const builtin = proof.externalBuiltins;
  requireValue(builtin?.allObjectsEqual === true && builtin.file === "Resources/unity_builtin_extra"
    && [builtin.sha256, builtin.baselineFileSha256, builtin.baselineExtractionEvidenceSha256].every(value => hashPattern.test(value || ""))
    && Array.isArray(builtin.objects) && builtin.objects.length > 0
    && new Set(builtin.objects.map(item => item.pathId)).size === builtin.objects.length
    && builtin.objects.every(item => item.equal === true && typeof item.pathId === "string" && /^-?[1-9]\d*$/.test(item.pathId)
      && typeof item.shader === "string" && item.shader.length > 0 && hashPattern.test(item.sha256 || "")),
  "Incomplete external built-in object proof");
  const external = proof.externalMaterials, inputs = external?.currentInputSha256;
  const requiredFields = ["name", "shader", "colors", "floats", "shaderProperties", "passState", "shaderObjectSha256"];
  requireValue(hashPattern.test(external?.sourceEvidenceSha256 || "") && inputs && typeof inputs === "object" && !Array.isArray(inputs)
    && Object.keys(inputs).length > 0 && Object.entries(inputs).every(([name, hash]) => /^[A-Za-z0-9_.-]+\.assets$/.test(name) && hashPattern.test(hash || ""))
    && Array.isArray(external.materials) && external.materials.length > 0
    && new Set(external.materials.map(item => `${item.sourceFile}:${item.pathId}`)).size === external.materials.length
    && external.materials.every(item => item.equal === true && typeof item.name === "string" && item.name.length > 0
      && Object.hasOwn(inputs, item.sourceFile) && Object.hasOwn(inputs, item.shaderSourceFile)
      && Number.isSafeInteger(item.pathId) && item.pathId !== 0 && Number.isSafeInteger(item.shaderPathId) && item.shaderPathId !== 0
      && hashPattern.test(item.materialObjectSha256 || "") && hashPattern.test(item.shaderObjectSha256 || "")
      && Array.isArray(item.verifiedFields) && requiredFields.every(field => item.verifiedFields.includes(field))),
  "Incomplete external material proof");
}

/** Consume a separately authenticated source receipt; never infer compatibility from version numbers. */
export async function prepareVerifiedMapBuild({ reportPath, reportSha256, assets, maps, output, now = new Date().toISOString() }) {
  const receipt = await regular(reportPath);
  requireValue(hashPattern.test(reportSha256 || "") && digest(receipt) === reportSha256, "Equivalence receipt SHA-256 mismatch");
  const proof = JSON.parse(receipt);
  requireValue(proof.schemaVersion === 1 && proof.authority === "verified-map-build-equivalence", "Unsupported source equivalence receipt");
  const { sourceBuildId, targetBuildId, targetGameVersion } = proof;
  requireValue([sourceBuildId, targetBuildId].every(id => typeof id === "string" && /^[1-9]\d*$/.test(id)) && sourceBuildId !== targetBuildId, "Invalid source/target build");
  requireValue(typeof targetGameVersion === "string" && targetGameVersion.length > 0, "Missing native game version");
  requireValue(Array.isArray(proof.maps) && proof.maps.length > 0 && Array.isArray(proof.bundles) && proof.bundles.length > 0, "Incomplete source receipt");
  requireValue(hashPattern.test(proof.assembly?.sha256 || "") && /^[a-f0-9]{32}$/.test(proof.assembly?.mvid || ""), "Missing current assembly identity");
  const catalogBytes = await regular(resolve(maps, "catalog.json"));
  const catalog = JSON.parse(catalogBytes);
  requireValue(catalog.schemaVersion === 1 && Array.isArray(catalog.mapPacks), "Invalid source catalog");
  requireValue(!catalog.mapPacks.some(entry => String(entry.gameBuildId) === targetBuildId), "Target build already has catalog entries");
  const sources = catalog.mapPacks.filter(entry => entry.enabled !== false && String(entry.gameBuildId) === sourceBuildId);
  requireValue(sources.length === proof.maps.length, "Receipt does not cover the complete source catalog");
  validateReceipt(proof, catalogBytes, await regular(resolve(maps, `game-build.${sourceBuildId}.json`)), sources);
  for (const source of [assets, maps]) {
    const path = relative(resolve(source), resolve(output));
    requireValue(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path), "Output must be separate from source assets and metadata");
  }
  requireValue(!await lstat(output).catch(error => { if (error.code === "ENOENT") return null; throw error; }), "Select a fresh output directory");
  const identities = new Map(), manifests = [], plans = [];
  for (const item of proof.maps) {
    requireValue(packPattern.test(item.sourceMapPackId || "") && !identities.has(item.sourceMapPackId), "Invalid or duplicate source pack");
    const entry = sources.find(entry => entry.mapPackId === item.sourceMapPackId);
    requireValue(entry && entry.sceneName === item.sceneName && entry.mapSlot === item.mapSlot, "Receipt scene differs from catalog");
    const oldDirectory = resolve(assets, "maps", "packs", item.sourceMapPackId);
    const oldBytes = await regular(resolve(oldDirectory, "map-pack.json"));
    requireValue(digest(oldBytes) === item.sourceManifestSha256, "Receipt source manifest SHA-256 mismatch");
    const old = JSON.parse(oldBytes);
    verifyMapPackIdentity(old);
    requireValue(old.identityVersion === 3 && String(old.gameBuildId) === sourceBuildId && old.sceneName === item.sceneName
      && old.mapSlot === item.mapSlot && hashPattern.test(item.sourceSceneSha256 || "")
      && old.source?.sceneSha256 === item.sourceSceneSha256 && old.source?.sceneFile === item.sceneFile
      && entry.path === `./packs/${old.mapPackId}/map-pack.json`, "Receipt source identity mismatch");
    const assetsByName = new Map();
    let derivativeFiles = 0, derivativeBytes = 0;
    for (const layer of old.layers) for (const field of ["texture", "height", "geometry"]) {
      const name = assetName(layer[field]);
      if (assetsByName.has(name)) {
        const previous = assetsByName.get(name);
        requireValue(previous.sha256 === layer[`${field}Sha256`], `Conflicting source derivative SHA-256: ${name}`);
        if (field === "height") requireValue(previous.bytes === layer.columns * layer.rows * 4, `Invalid source height byte length: ${name}`);
        derivativeFiles++; derivativeBytes += previous.bytes;
        continue;
      }
      const bytes = await regular(resolve(oldDirectory, name));
      const sha256 = digest(bytes);
      requireValue(sha256 === layer[`${field}Sha256`], `Source derivative SHA-256 mismatch: ${name}`);
      if (field === "geometry") verifyGeometryGlb(bytes, name, layer.geometryFormat);
      if (field === "height") requireValue(bytes.length === layer.columns * layer.rows * 4, `Invalid source height byte length: ${name}`);
      assetsByName.set(name, { name, bytes: bytes.length, sha256 });
      derivativeFiles++; derivativeBytes += bytes.length;
    }
    requireValue(derivativeFiles === item.derivativeFiles && derivativeBytes === item.derivativeBytes, "Receipt derivative inventory differs from source");
    const manifest = structuredClone(old);
    manifest.gameBuildId = targetBuildId;
    manifest.gameVersion = targetGameVersion;
    manifest.generatedAtUtc = now;
    manifest.source = { ...manifest.source, equivalence: { authority: proof.authority, sourceGameBuildId: sourceBuildId,
      sourceMapPackId: old.mapPackId, receiptSha256: reportSha256 } };
    manifest.mapPackId = computeMapPackId(manifest);
    verifyMapPackIdentity(manifest);
    identities.set(old.mapPackId, manifest.mapPackId);
    const body = JSON.stringify(manifest, null, 2) + "\n";
    plans.push({ sourceMapPackId: old.mapPackId, mapPackId: manifest.mapPackId, manifestSha256: digest(body),
      manifestBytes: Buffer.byteLength(body), assets: [...assetsByName.values()] });
    manifests.push({ manifest, body, entry: { ...entry, mapPackId: manifest.mapPackId, gameBuildId: targetBuildId,
      gameVersion: targetGameVersion, generatedAtUtc: now, path: `./packs/${manifest.mapPackId}/map-pack.json`, supersedesMapPackIds: undefined } });
  }
  const sidecars = [];
  for (const kind of ["routes", "landmarks", "fog", "water", "peaks", "enclosures"]) {
    const data = JSON.parse(await regular(resolve(maps, `${kind}.${sourceBuildId}.json`)));
    requireValue(data.schemaVersion === 1 && String(data.gameBuildId) === sourceBuildId && Array.isArray(data.maps), "Invalid source sidecar");
    const next = { ...data, gameBuildId: targetBuildId, maps: [] };
    delete next.expectedLegacyLayoutKey;
    delete next.legacyRootTransformPolicy;
    if ("gameVersion" in next) next.gameVersion = targetGameVersion;
    if ("sourceGameAssemblyMvid" in next) next.sourceGameAssemblyMvid = proof.assembly.mvid;
    if ("sourceGameAssemblySha256" in next) next.sourceGameAssemblySha256 = proof.assembly.sha256;
    const seen = new Set();
    for (const row of data.maps) {
      const mapPackId = identities.get(row.mapPackId);
      requireValue(mapPackId && !seen.has(row.mapPackId), `Unknown or duplicate ${kind} source sidecar map`);
      seen.add(row.mapPackId);
      const source = proof.maps.find(item => item.sourceMapPackId === row.mapPackId);
      requireValue(row.sceneName === source.sceneName && row.sourceSceneSha256 === source.sourceSceneSha256
        && (row.mapSlot === undefined || row.mapSlot === source.mapSlot)
        && (row.gameBuildId === undefined || String(row.gameBuildId) === sourceBuildId), "Sidecar scene differs from verified source");
      const value = { ...row, mapPackId };
      if ("gameBuildId" in value) value.gameBuildId = targetBuildId;
      // A new assembly requires its own runtime-layout audit. Static landmark positions remain exact source data.
      delete value.expectedLegacyLayoutKey;
      delete value.legacyRootTransformPolicy;
      next.maps.push(value);
    }
    requireValue(next.maps.length === manifests.length, `Incomplete ${kind} source sidecar`);
    sidecars.push({ name: `${kind}.${targetBuildId}.json`, body: JSON.stringify(next, null, 2) + "\n" });
  }
  const plan = { schemaVersion: 1, sourceGameBuildId: sourceBuildId, gameBuildId: targetBuildId,
    gameVersion: targetGameVersion, equivalenceReceiptSha256: reportSha256, packs: plans };
  // All source checks complete before output is published. The installed source and active catalog are read-only.
  await mkdir(dirname(resolve(output)), { recursive: true });
  await mkdir(output);
  for (const { manifest, body } of manifests) {
    const directory = resolve(output, "manifests", manifest.mapPackId);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "map-pack.json"), body);
  }
  await mkdir(resolve(output, "data"), { recursive: true });
  for (const { name, body } of sidecars) await writeFile(resolve(output, "data", name), body);
  // The default rotation changes only when that build's character assets have also been provisioned.
  await writeFile(resolve(output, "data", "catalog.json"), JSON.stringify({ ...catalog,
    mapPacks: [...catalog.mapPacks, ...manifests.map(value => value.entry)] }, null, 2) + "\n");
  await writeFile(resolve(output, "equivalence.json"), receipt);
  await writeFile(resolve(output, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  return { gameBuildId: targetBuildId, maps: manifests.length, sidecars: sidecars.length,
    planSha256: digest(await readFile(resolve(output, "plan.json"))), output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => { const at = args.indexOf(flag); requireValue(at >= 0 && args[at + 1], `Missing ${flag}`); return args[at + 1]; };
  console.log(JSON.stringify(await prepareVerifiedMapBuild({ reportPath: value("--report"), reportSha256: value("--report-sha256"),
    assets: value("--assets"), output: value("--output"), maps: resolve(dirname(fileURLToPath(import.meta.url)), "../data/maps") })));
}
