import assert from "node:assert/strict";
import test from "node:test";
import { cacheControlFor } from "../lib/serve-headers.mjs";

test("cache policy: content-addressed packs are immutable, mutable data stays fresh", () => {
  // Only geometry is immutable; additive source evidence enriches manifests.
  assert.equal(
    cacheControlFor("/data/maps/packs/sha256-5828be29/map-pack.json"),
    "no-store",
  );
  assert.equal(cacheControlFor(`/data/maps/enclosures/${'a'.repeat(64)}.glb.gz`), "public, max-age=31536000, immutable");
  assert.equal(
    cacheControlFor("/data/maps/packs/sha256-5828be29/segment-02-alpine.glb.gz"),
    "public, max-age=31536000, immutable",
  );
  // The versioned vendor path only changes with a three.js upgrade.
  assert.equal(cacheControlFor("/vendor/three/0.180.0/build/three.module.js"), "public, max-age=86400");

  // Everything that can change between staging passes must refetch.
  assert.equal(cacheControlFor("/"), "no-store");
  assert.equal(cacheControlFor("/index.html"), "no-store");
  assert.equal(cacheControlFor("/src/app.js"), "no-store");
  assert.equal(cacheControlFor("/data/maps/catalog.json"), "no-store");
  assert.equal(cacheControlFor("/data/daily/current.json"), "no-store");
  assert.equal(cacheControlFor("/data/game-assets/25306743/catalog.json"), "no-store");
});
