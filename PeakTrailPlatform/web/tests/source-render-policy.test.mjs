import assert from "node:assert/strict";
import test from "node:test";
import { isSourceProjectionProxy } from "../src/source-render-policy.js";

test("only exact-build audited depth decal materials are classified as effect proxies", () => {
  for (const name of ["M_VFX_PetrifyDecal", "M_VFX_FireballDecal"]) {
    assert.equal(isSourceProjectionProxy(25306743, name, "Decal"), true);
    assert.equal(isSourceProjectionProxy("25306743", name, "Decal"), true);
    assert.equal(isSourceProjectionProxy("new-build", name, "Decal"), false);
    assert.equal(isSourceProjectionProxy(25306743, name, "W/Peak_Standard"), false);
    assert.equal(isSourceProjectionProxy(25306743, name), false);
  }
  for (const name of ["M_Petrified_Stone_Evil", "M_SporeShroomExplo", "Jug Glass", "AntiSphere", "OtherDecal"])
    assert.equal(isSourceProjectionProxy(25306743, name, "Decal"), false);
});
