import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMapPackId, verifyMapPackIdentity } from "./lib/map-pack-identity.mjs";
import { readVerifiedMapBuild, readVerifiedMapManifest } from "./lib/verified-map-input.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (okay, message) => { if (!okay) throw new Error(message); };
const json = value => JSON.stringify(value, null, 2) + "\n";
const parentReceiptHash = "045c1d36773badd69e63050ca85e1e3e0d0f6eaa08856a750a8ba8fdc0e150e7";
const parentPlanHash = "f6c598d5896e1c4f2910f8515b0b139f52e374427921538b867ac37d0306ef57";

/** Publish metadata over an authenticated retained canonical build, without claiming to rehash its assets. */
export async function prepareTransitive310MapBuild({ maps, receiptPath, receiptSha256 }) {
  maps = resolve(maps);
  const receiptBytes = await readFile(receiptPath), proof = JSON.parse(receiptBytes);
  check(/^[a-f0-9]{64}$/.test(receiptSha256) && sha(receiptBytes) === receiptSha256, "Fresh receipt SHA mismatch");
  const parent = await readVerifiedMapBuild("26155610", { mapsDirectory: maps });
  check(parent && parent.plan.gameBuildId === "26155610" && parent.plan.sourceGameBuildId === "26134529", "Unexpected retained parent");
  check(sha(await readFile(join(maps,"verified-builds/26155610/equivalence.json"))) === parentReceiptHash
    && sha(await readFile(join(maps,"verified-builds/26155610/plan.json"))) === parentPlanHash, "Parent evidence changed");
  check(proof.authority === "verified-map-build-equivalence" && proof.verified === true && proof.sourceBuildId === "26155610"
    && proof.targetBuildId === "26542162" && proof.targetGameVersion === "3.1.0--logFile" && proof.maps.length === 208
    && proof.transitiveVerification?.parentReceiptSha256 === parentReceiptHash
    && proof.transitiveVerification?.parentPlanSha256 === parentPlanHash, "Unsupported transitive receipt identity");
  check(proof.assembly?.sha256 === "a3643f11dc444d86491270b224c0a0caf9126a10b26731feb97fc85ad1d82038"
    && proof.assembly?.mvid === "e9a4fa24a0684abd8c8d66c4b2b65471" && proof.sceneOrder?.equal === true
    && proof.bundles.length === parent.proof.bundles.length && proof.bundles.every(bundle => bundle.bundleContentsVerified
      && bundle.currentContainerBytesRechecked && bundle.parentReceiptSha256 === parentReceiptHash
      && parent.proof.bundles.some(old => old.file === bundle.file && old.sha256 === bundle.sha256 && old.bytes === bundle.bytes)),
  "Current input evidence is incomplete");
  const catalogBytes = await readFile(join(maps,"catalog.json")), catalog = JSON.parse(catalogBytes);
  const sourceEvidenceBytes = await readFile(join(maps,"game-build.26155610.json")), sourceEvidence = JSON.parse(sourceEvidenceBytes);
  check(sha(catalogBytes) === proof.sourceCatalogSha256 && sha(sourceEvidenceBytes) === proof.sourceEvidenceSha256, "Source catalog/evidence changed");
  check(!catalog.mapPacks.some(entry => String(entry.gameBuildId) === "26542162"), "Target catalog already exists");
  const destination = join(maps,"verified-builds/26542162");
  check(!(await stat(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; })), "Choose a fresh target build");
  const documents = [], entries = [], plans = [], identities = new Map(), sourceIds = new Set();
  for (const item of proof.maps) {
    check(!sourceIds.has(item.sourceMapPackId), "Duplicate current source identity"); sourceIds.add(item.sourceMapPackId);
    const entry = parent.plan.packs.find(value => value.mapPackId === item.sourceMapPackId);
    const catalogEntry = catalog.mapPacks.find(value => value.mapPackId === item.sourceMapPackId && String(value.gameBuildId) === "26155610");
    check(entry && catalogEntry && item.sourceManifestSha256 === entry.manifestSha256, "Receipt source differs from retained parent");
    const manifest = structuredClone(await readVerifiedMapManifest(parent,item.sourceMapPackId));
    check(manifest.sceneName === item.sceneName && manifest.mapSlot === item.mapSlot && manifest.source.sceneSha256 === item.sourceSceneSha256,
      "Receipt source scene mismatch");
    manifest.gameBuildId = "26542162"; manifest.gameVersion = proof.targetGameVersion; manifest.generatedAtUtc = proof.verifiedAtUtc;
    manifest.source.equivalence = { authority: proof.authority, sourceGameBuildId: "26155610", sourceMapPackId: item.sourceMapPackId,
      receiptSha256 };
    manifest.mapPackId = computeMapPackId(manifest); verifyMapPackIdentity(manifest);
    identities.set(item.sourceMapPackId,manifest.mapPackId);
    const bytes = json(manifest);
    documents.push({ path: join(destination,"manifests",manifest.mapPackId,"map-pack.json"), bytes });
    plans.push({ sourceMapPackId: item.sourceMapPackId, mapPackId: manifest.mapPackId, manifestSha256: sha(bytes),
      manifestBytes: Buffer.byteLength(bytes), assets: structuredClone(entry.assets) });
    const next = { ...catalogEntry, mapPackId: manifest.mapPackId, gameBuildId: "26542162", gameVersion: proof.targetGameVersion,
      generatedAtUtc: proof.verifiedAtUtc, path: `./packs/${manifest.mapPackId}/map-pack.json` };
    delete next.supersedesMapPackIds; entries.push(next);
  }
  check(sourceIds.size === 208 && new Set(plans.map(entry => entry.mapPackId)).size === 208, "Incomplete target identity set");
  for (const kind of ["routes","landmarks","fog","water","peaks","enclosures"]) {
    const original = JSON.parse(await readFile(join(maps,`${kind}.26155610.json`))), data = structuredClone(original);
    check(String(data.gameBuildId) === "26155610" && data.maps.length === 208, `Incomplete ${kind} source`);
    data.gameBuildId = "26542162";
    if ("gameVersion" in data) data.gameVersion = proof.targetGameVersion;
    if ("sourceGameAssemblyMvid" in data) data.sourceGameAssemblyMvid = proof.assembly.mvid;
    if ("sourceGameAssemblySha256" in data) data.sourceGameAssemblySha256 = proof.assembly.sha256;
    delete data.expectedLegacyLayoutKey; delete data.legacyRootTransformPolicy;
    const seen = new Set();
    for (const row of data.maps) {
      const source = proof.maps.find(value => value.sourceMapPackId === row.mapPackId);
      check(source && !seen.has(row.mapPackId) && row.sceneName === source.sceneName && row.sourceSceneSha256 === source.sourceSceneSha256,
        `${kind} source identity mismatch`); seen.add(row.mapPackId);
      row.mapPackId = identities.get(row.mapPackId);
      if ("gameBuildId" in row) row.gameBuildId = "26542162";
      delete row.expectedLegacyLayoutKey; delete row.legacyRootTransformPolicy;
    }
    documents.push({ path: join(maps,`${kind}.26542162.json`), bytes: json(data) });
  }
  const nextEvidence = { ...sourceEvidence, gameBuildId: "26542162", gameVersion: proof.targetGameVersion,
    authority: "installed-game-assets-and-serialized-map-baker", sourceGameAssemblyMvid: proof.assembly.mvid,
    sourceGameAssemblySha256: proof.assembly.sha256, sceneOrder: structuredClone(proof.sceneOrder),
    maps: sourceEvidence.maps.map(value => ({ ...value, mapPackId: identities.get(value.mapPackId) })),
    provenance: { authority: proof.authority, receiptSha256, sourceBuildId: "26155610", bundleExtractionRepeated: false } };
  check(nextEvidence.maps.length === 208 && nextEvidence.maps.every(value => value.mapPackId), "Target native evidence incomplete");
  documents.push({ path: join(maps,"game-build.26542162.json"), bytes: json(nextEvidence) });
  const plan = { schemaVersion: 1, sourceGameBuildId: "26155610", gameBuildId: "26542162", gameVersion: proof.targetGameVersion,
    equivalenceReceiptSha256: receiptSha256, packs: plans };
  const planBytes = json(plan), index = JSON.parse(await readFile(join(maps,"verified-builds/index.json")));
  check(!index.builds.some(value => value.gameBuildId === "26542162"), "Target index already exists");
  index.builds.push({ gameBuildId: "26542162", planSha256: sha(planBytes), receiptSha256 });
  documents.push({ path: join(destination,"plan.json"), bytes: planBytes }, { path: join(destination,"equivalence.json"), bytes: receiptBytes });
  // All input checks precede any metadata write. Existing canonical assets,
  // old manifests, old proof and their bytes are never modified.
  for (const doc of documents) { await mkdir(resolve(doc.path,".."),{recursive:true}); await writeFile(doc.path,doc.bytes,{flag:"wx"}); }
  await writeFile(join(maps,"verified-builds/index.json"),json(index));
  await writeFile(join(maps,"catalog.json"),json({ ...catalog, activeGameBuildId: "26542162",
    playerVisualization: { mode: "markers", gameBuildId: "26542162", receiptSha256 },
    playerVisualization: { mode: "markers", gameBuildId: "26542162", receiptSha256 },
    mapPacks: [...catalog.mapPacks,...entries] }));
  const published = await readVerifiedMapBuild("26542162",{mapsDirectory:maps});
  for (const item of plans) await readVerifiedMapManifest(published,item.mapPackId);
  return { buildId: "26542162", maps: plans.length, sourceBuildId: "26155610", planSha256: sha(planBytes), receiptSha256,
    canonicalAssetsWritten: 0, verifiedManifests: plans.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => { const at=args.indexOf(flag);check(at>=0&&args[at+1],`Missing ${flag}`);return args[at+1]; };
  console.log(JSON.stringify(await prepareTransitive310MapBuild({ maps:value("--maps"),receiptPath:value("--receipt"),receiptSha256:value("--receipt-sha256") })));
}
