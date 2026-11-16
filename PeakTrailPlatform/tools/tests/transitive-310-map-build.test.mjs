import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readVerifiedMapBuild, readVerifiedMapManifest } from "../lib/verified-map-input.mjs";
import { prepareTransitive310MapBuild } from "../prepare-transitive-310-map-build.mjs";

const maps=resolve(dirname(fileURLToPath(import.meta.url)),"../../data/maps");
const parse=async path=>JSON.parse(await readFile(path,"utf8"));
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
test("3.1 derived identities preserve the retained 3.0.1 canonical source and all source-bound sidecars",async()=>{
  const old=await readVerifiedMapBuild("26155610",{mapsDirectory:maps});
  const current=await readVerifiedMapBuild("26542162",{mapsDirectory:maps});
  assert.equal(current.plan.sourceGameBuildId,"26155610");assert.equal(current.plan.packs.length,208);
  assert.equal(current.proof.transitiveVerification.bundleExtractionRepeated,false);
  assert.equal(current.proof.transitiveVerification.derivativeRehashRepeated,false);
  assert.equal(current.proof.transitiveVerification.parentReceiptSha256,"045c1d36773badd69e63050ca85e1e3e0d0f6eaa08856a750a8ba8fdc0e150e7");
  const mapping=new Map();
  for(const pack of current.plan.packs){
    const source=old.plan.packs.find(value=>value.mapPackId===pack.sourceMapPackId);
    assert.ok(source);assert.deepEqual(pack.assets,source.assets);
    const before=await readVerifiedMapManifest(old,pack.sourceMapPackId),after=await readVerifiedMapManifest(current,pack.mapPackId);
    assert.deepEqual(after.layers,before.layers);assert.equal(after.source.sceneSha256,before.source.sceneSha256);
    assert.equal(after.source.equivalence.sourceGameBuildId,"26155610");
    assert.equal(after.gameBuildId,"26542162");assert.equal(after.gameVersion,"3.1.0--logFile");
    assert.notEqual(after.mapPackId,before.mapPackId);mapping.set(before.mapPackId,after.mapPackId);
  }
  for(const kind of ["routes","landmarks","fog","water","peaks","enclosures"]){
    const before=await parse(join(maps,`${kind}.26155610.json`)),after=await parse(join(maps,`${kind}.26542162.json`));
    assert.equal(after.gameBuildId,"26542162");assert.equal(after.maps.length,208);
    assert.equal(after.expectedLegacyLayoutKey,undefined);assert.equal(after.legacyRootTransformPolicy,undefined);
    if("sourceGameAssemblyMvid" in after)assert.equal(after.sourceGameAssemblyMvid,"e9a4fa24a0684abd8c8d66c4b2b65471");
    for(let i=0;i<after.maps.length;i++){
      assert.equal(after.maps[i].mapPackId,mapping.get(before.maps[i].mapPackId));
      assert.equal(after.maps[i].sourceSceneSha256,before.maps[i].sourceSceneSha256);
      assert.equal(after.maps[i].sceneName,before.maps[i].sceneName);
    }
  }
  const catalog=await parse(join(maps,"catalog.json"));assert.equal(catalog.activeGameBuildId,"26542162");
  assert.equal(catalog.mapPacks.filter(value=>String(value.gameBuildId)==="26542162").length,208);
  assert.equal(catalog.mapPacks.filter(value=>String(value.gameBuildId)==="26155610").length,208);
});

test("transitive publisher rejects wrong receipt digest without changing publication metadata",async()=>{
  const target=join(maps,"verified-builds/26542162/equivalence.json"),catalog=join(maps,"catalog.json");
  const before=sha(await readFile(catalog));
  await assert.rejects(prepareTransitive310MapBuild({maps,receiptPath:target,receiptSha256:"f".repeat(64)}),/Fresh receipt SHA mismatch/);
  assert.equal(sha(await readFile(catalog)),before);
});
