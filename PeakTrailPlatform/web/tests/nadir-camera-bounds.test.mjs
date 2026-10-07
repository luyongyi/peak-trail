import assert from "node:assert/strict";
import test from "node:test";
import { nadirCameraBounds } from "../src/nadir-camera-bounds.js";

const floor = { bounds: { min: [-2500, 702.6, -2290], max: [2500, 702.6, 2710] },
  materials: [{ name: "M_Void Water", shader: "GD/Water-GD" }] };
const terrain = { bounds: { min: [-50, 710, 150], max: [80, 1015, 600] }, materials: [{ name: "M_Petrified_Stone" }] };
test("only the verified 5km Void water plane is omitted from camera extents", () => {
  const original = structuredClone([floor, terrain]);
  assert.deepEqual(nadirCameraBounds({ biome: "Void" }, "25306743", [floor, terrain]), terrain.bounds);
  assert.deepEqual(nadirCameraBounds({ biome: "Void" }, "25739797", [floor, terrain]), terrain.bounds);
  assert.deepEqual([floor, terrain], original);
  const smallWater = { ...floor, bounds: { min: [-70, 740, 120], max: [90, 740, 650] } };
  assert.deepEqual(nadirCameraBounds({ biome: "Void" }, "25306743", [floor, terrain, smallWater]),
    { min: [-70, 710, 120], max: [90, 1015, 650] });
});
test("unverified identity, shape, or absent remaining geometry preserves the original camera fallback", () => {
  assert.equal(nadirCameraBounds({ biome: "Peak" }, "25306743", [floor, terrain]), null);
  assert.equal(nadirCameraBounds({ biome: "Void" }, "other", [floor, terrain]), null);
  assert.equal(nadirCameraBounds({ biome: "Void" }, "25306743", [floor]), null);
  assert.equal(nadirCameraBounds({ biome: "Void" }, "25306743", [terrain]), null);
  assert.equal(nadirCameraBounds({ biome: "Void" }, "25306743", [{ ...floor, materials: [{ name: "water" }] }, terrain]), null);
  assert.equal(nadirCameraBounds({ biome: "Void" }, "25306743", [{ ...floor, bounds: { min: [-2500, 700, -2290], max: [2500, 900, 2710] } }, terrain]), null);
});
