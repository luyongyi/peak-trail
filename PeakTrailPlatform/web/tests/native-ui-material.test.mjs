import test from "node:test";
import assert from "node:assert/strict";
import { nativeUiAlpha, sampleNativeUiTexture, shadeNativeUi } from "../src/native-ui-material.js";

const material = { step: .95, stepSmooth: .38, alphaStrength: 2, noiseScale: .01,
  noiseRemap: 0, texScale: 2, texColor: [1, 1, 1, 1], redIsAlpha: false, alphaClip: true };
const texture = (width, height, values) => ({ width, height, data: Uint8ClampedArray.from(values.flat()) });
const solid = value => texture(1, 1, [[value, value, value, 255]]);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("native alpha sharpens sprite edges using noise and both smoothstep limits", () => {
  near(nativeUiAlpha(.1, 1, .5, 1, material), 0);
  near(nativeUiAlpha(.32, 1, .5, 1, material), .5);
  near(nativeUiAlpha(.6, 1, .5, 1, material), 1);
  // Native UI_ALPHA multiplies the accumulated noise + doubled alpha by red.
  const red = { ...material, step: .55, stepSmooth: .17, redIsAlpha: true };
  near(nativeUiAlpha(1, 0, .5, 1, red), 0);
  near(nativeUiAlpha(1, .254, .5, 1, red), .5);
  near(nativeUiAlpha(1, 1, .5, .5, red), 128 / 255);
});

test("native texture sampling preserves repeat seams, mirror edges, Y orientation and sRGB filtering", () => {
  const two = texture(2, 1, [[0, 0, 0, 255], [255, 255, 255, 255]]);
  near(sampleNativeUiTexture(two, .25, .5), 0);
  near(sampleNativeUiTexture(two, .75, .5), 1);
  near(sampleNativeUiTexture(two, 0, .5), .5);
  near(sampleNativeUiTexture(two, 1, .5), .5);
  near(sampleNativeUiTexture(two, -.25, .5), 1);
  near(sampleNativeUiTexture(two, 0, .5, 0, { wrap: "mirror" }), 0);
  near(sampleNativeUiTexture(two, 1, .5, 0, { wrap: "mirror" }), 1);
  near(sampleNativeUiTexture(two, 1.25, .5, 0, { wrap: "mirror" }), 1);
  near(sampleNativeUiTexture(two, .5, .5, 0, { srgb: true }), .5); // Decode before interpolation.
  const vertical = texture(1, 2, [[0, 0, 0, 255], [255, 255, 255, 255]]);
  near(sampleNativeUiTexture(vertical, .5, .25), 1);
  near(sampleNativeUiTexture(vertical, .5, .75), 0);
});

test("CPU shader preserves straight-alpha color and native red-mask stripes", () => {
  const source = Uint8ClampedArray.from([255, 255, 255, 255]);
  const output = shadeNativeUi(source, 1, 1, { tint: [.35, .78, 0, .5], material, noise: solid(128), detail: solid(255) });
  assert.deepEqual([...output], [89, 199, 0, 128]); // RGB is not multiplied by alpha twice.
  assert.deepEqual([...source], [255, 255, 255, 255]);
  const stripes = Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255]);
  const shaded = shadeNativeUi(stripes, 2, 1, { tint: [1, .3, 0, 1],
    material: { ...material, step: .55, stepSmooth: .17, redIsAlpha: true }, noise: solid(128), detail: solid(255) });
  assert.deepEqual([...shaded], [0, 0, 0, 0, 255, 77, 0, 255]);
});

test("native material rejects missing resources and oversized or malformed buffers", () => {
  const options = { tint: [1, 1, 1, 1], material, noise: solid(128), detail: solid(255) };
  assert.throws(() => shadeNativeUi(new Uint8ClampedArray(4), 1, 1, { ...options, noise: null }), /missing/);
  assert.throws(() => shadeNativeUi(new Uint8ClampedArray(4), 1, 1, { ...options, scale: 0 }), /parameters/);
  assert.throws(() => shadeNativeUi(new Uint8ClampedArray(4), 1, 1, { ...options, material: { ...material, stepSmooth: 0 } }), /parameters/);
  assert.throws(() => shadeNativeUi(new Uint8ClampedArray(4), 10_000, 10_000, options), /buffer/);
});
