import assert from "node:assert/strict";
import test from "node:test";
import { nadirCameraBounds, nadirCameraParts } from "../src/nadir-camera-bounds.js";

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

test("filtered Void parts retain original oriented points, entries and ordering", () => {
  const points = [[-50, 710, 150], [80, 1015, 600]];
  const orientedTerrain = { ...terrain, points };
  const smallWater = { ...floor, bounds: { min: [-70, 740, 120], max: [90, 740, 650] }, points: [[-70, 740, 120], [90, 740, 650]] };
  const input = [orientedTerrain, floor, smallWater], original = structuredClone(input);
  for (const build of ["25306743", "25739797"]) {
    const retained = nadirCameraParts({ biome: "Void" }, build, input);
    assert.deepEqual(retained, [orientedTerrain, smallWater]);
    assert.notEqual(retained, input);
    assert.equal(retained[0], orientedTerrain);
    assert.equal(retained[0].points, points);
    assert.equal(retained[1], smallWater);
    assert.equal(retained[1].points, smallWater.points);
    assert.deepEqual(nadirCameraBounds({ biome: "Void" }, build, input),
      { min: [-70, 710, 120], max: [90, 1015, 650] });
  }
  assert.deepEqual(input, original);
});

test("parts filtering requires the audited water material, dimensions and valid remaining geometry", () => {
  const impostors = [
    { ...floor, materials: [{ name: "water", shader: "GD/Water-GD" }] },
    { ...floor, materials: [{ name: "M_Void Water", shader: "other" }] },
    { ...floor, materials: [...floor.materials, { name: "rock", shader: "GD/Water-GD" }] },
    { ...floor, bounds: { min: [-2500, 702.6, -2290], max: [2498, 702.6, 2710] } },
    { ...floor, bounds: { min: [-2500, 702.6, -2290], max: [2500, 702.6, 2708] } },
    { ...floor, bounds: { min: [-2500, 702.6, -2290], max: [2500, 702.62, 2710] } },
  ];
  for (const impostor of impostors) {
    assert.equal(nadirCameraParts({ biome: "Void" }, "25306743", [impostor, terrain]), null);
    assert.deepEqual(nadirCameraParts({ biome: "Void" }, "25306743", [floor, impostor, terrain]), [impostor, terrain]);
  }
  for (const parts of [[], [floor], [terrain], [floor, null], [floor, { bounds: { min: [1, 0, 0], max: [0, 1, 1] } }],
    [floor, { bounds: { min: [0, NaN, 0], max: [1, 1, 1] } }]]) {
    assert.equal(nadirCameraParts({ biome: "Void" }, "25739797", parts), null);
    assert.equal(nadirCameraBounds({ biome: "Void" }, "25739797", parts), null);
  }
  assert.equal(nadirCameraParts({ biome: "Peak" }, "25306743", [floor, terrain]), null);
  assert.equal(nadirCameraParts({ biome: "Void" }, "other", [floor, terrain]), null);
});

test("opaque audited Void water excludes only fully submerged parts within its footprint from framing", () => {
  const water = { ...floor, bounds: { min: [-2500, 728.276, -2290], max: [2500, 728.276, 2710] } };
  const fog = { bounds: { min: [-264, 727.6, 30.5], max: [264, 727.6, 552] },
    materials: [{ name: "FogSurface void", shader: "GD/FogSurface" }] };
  const hiddenFloor = { bounds: { min: [-96, 702.6, 76], max: [96, 702.6, 506] },
    materials: [{ name: "Lit", shader: "Universal Render Pipeline/Lit" }] };
  const crossingRock = { ...terrain, points: [[-50, 710, 150], [80, 1015, 600]] };
  const outside = { bounds: { min: [2499, 700, 150], max: [2501, 710, 600] } };
  const outsideZ = { bounds: { min: [-50, 700, 2709], max: [80, 710, 2711] } };
  const nearSurface = { bounds: { min: [-50, 728.27, 150], max: [80, 728.27, 600] } };
  const atSurface = { bounds: { min: [-50, 728.276, 150], max: [80, 728.276, 600] } };
  const input = [fog, crossingRock, hiddenFloor, outside, water, outsideZ, nearSurface, atSurface];
  const original = structuredClone(input), expected = [crossingRock, outside, outsideZ, nearSurface, atSurface];
  for (const build of ["25306743", "25739797"]) {
    const retained = nadirCameraParts({ biome: "Void" }, build, input);
    assert.deepEqual(retained, expected);
    expected.forEach((part, index) => assert.equal(retained[index], part));
    assert.equal(retained[0].points, crossingRock.points);
    assert.deepEqual(nadirCameraBounds({ biome: "Void" }, build, input),
      { min: [-50, 700, 150], max: [2501, 1015, 2711] });
  }
  assert.deepEqual(input, original);
  assert.equal(nadirCameraParts({ biome: "Void" }, "other", input), null);
  assert.equal(nadirCameraParts({ biome: "Shore" }, "25739797", input), null);
});

test("submerged filtering requires a verified plane and respects each plane's height and footprint", () => {
  const lower = { ...floor, bounds: { min: [-2500, 727.276, -2290], max: [2500, 727.276, 2710] } };
  const upper = { ...floor, bounds: { min: [-2500, 728.276, -2290], max: [2500, 728.276, 2710] } };
  const between = { bounds: { min: [-264, 727.6, 30], max: [264, 727.6, 552] } };
  const unverified = { ...upper, materials: [{ name: "Other Water", shader: "GD/Water-GD" }] };
  assert.deepEqual(nadirCameraParts({ biome: "Void" }, "25739797", [lower, between, terrain]), [between, terrain]);
  assert.deepEqual(nadirCameraParts({ biome: "Void" }, "25739797", [lower, between, upper, terrain]), [terrain]);
  assert.deepEqual(nadirCameraParts({ biome: "Void" }, "25739797", [lower, between, unverified, terrain]),
    [between, unverified, terrain]);
  assert.equal(nadirCameraParts({ biome: "Void" }, "25739797", [unverified, between, terrain]), null);
  assert.equal(nadirCameraParts({ biome: "Void" }, "25739797", [upper, between]), null);
});
