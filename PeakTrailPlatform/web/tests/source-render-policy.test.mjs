import assert from "node:assert/strict";
import test from "node:test";
import { isSourceProjectionProxy, shadowOnlyNodeIndices } from "../src/source-render-policy.js";

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

test("shadow-only correction is pinned to audited builds and exact delivery digests", () => {
  const digest = "db142d322fc18bc65e85fff216e237d9ea32691fa31be651ba4233c40c0ae78c";
  assert.deepEqual([...shadowOnlyNodeIndices(25306743, digest)], [83, 1609]);
  assert.deepEqual([...shadowOnlyNodeIndices("25306743", digest)], [83, 1609]);
  for (const build of [undefined, "new-build", 25306744])
    assert.equal(shadowOnlyNodeIndices(build, digest).size, 0);
  for (const hash of [undefined, "", "a".repeat(64), `${digest.slice(0, -1)}a`])
    assert.equal(shadowOnlyNodeIndices(25306743, hash).size, 0);
  const result = shadowOnlyNodeIndices(25306743, digest);
  result.add(42); result.delete(83);
  assert.deepEqual([...shadowOnlyNodeIndices(25306743, digest)], [83, 1609], "callers cannot mutate the registry");
});
