// The installed 3.1 Scouts/UI D3D11 pixel programs (variants 25/26) apply
// thresholded noise to the sprite, not a raw alpha mask. Keep this CPU path
// independent of Canvas, the DOM and animation loops. Call after slicing or
// tiling the native sprite; returned bytes are straight-alpha sRGB ImageData.
const MAX_PIXELS = 4_194_304;
const clamp01 = value => Math.max(0, Math.min(1, value));
const srgbToLinear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const linearToSrgb = value => value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055;
const srgbBytes = Float64Array.from({ length: 256 }, (_, index) => srgbToLinear(index / 255));
// Final output is only 8-bit. A 64 KiB table avoids three power operations per
// shaded pixel; 16-bit linear quantization changes the result by at most 1 byte.
const outputBytes = Uint8ClampedArray.from({ length: 65_536 }, (_, index) => Math.round(linearToSrgb(index / 65_535) * 255));

function dimensions(width, height, data) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > MAX_PIXELS || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)
    || data.length !== width * height * 4) throw new TypeError("Invalid native UI pixel buffer");
}

function textureReader(texture, wrap = "repeat", srgb = false) {
  if (!texture) throw new TypeError("Native UI texture is missing");
  const { data, width, height } = texture;
  dimensions(width, height, data);
  if (!["repeat", "mirror", "clamp"].includes(wrap)) throw new TypeError("Unsupported native UI texture wrap");
  const decodeRaw = value => value / 255;
  const decodeRgb = srgb ? value => srgbBytes[value] : decodeRaw;
  const index = (coordinate, size) => {
    if (wrap === "clamp") return Math.max(0, Math.min(size - 1, coordinate));
    const period = wrap === "mirror" ? size * 2 : size;
    const value = ((coordinate % period) + period) % period;
    return wrap === "mirror" && value >= size ? period - value - 1 : value;
  };
  // PNG/ImageData rows start at the top; Unity UVs start at the bottom.
  return (u, v, channel) => {
    const x = u * width - .5, y = (1 - v) * height - .5;
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const left = index(ix, width), right = index(ix + 1, width);
    const top = index(iy, height), bottom = index(iy + 1, height);
    const decode = channel < 3 ? decodeRgb : decodeRaw;
    const a = decode(data[(top * width + left) * 4 + channel]);
    const b = decode(data[(top * width + right) * 4 + channel]);
    const c = decode(data[(bottom * width + left) * 4 + channel]);
    const d = decode(data[(bottom * width + right) * 4 + channel]);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
}

/** Bilinear GPU-style sampling, including wrap seams and sRGB decode before filtering. */
export function sampleNativeUiTexture(texture, u, v, channel = 0, options = {}) {
  if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isInteger(channel) || channel < 0 || channel > 3)
    throw new TypeError("Invalid native UI sample coordinates");
  return textureReader(texture, options.wrap, options.srgb)(u, v, channel);
}

/** Native Scouts/UI smoothstep; the UI_ALPHA variant multiplies the entire input by red. */
export function nativeUiAlpha(spriteAlpha, spriteRed, noiseRed, tintAlpha, material) {
  const noise = noiseRed * (1 - material.noiseRemap) + material.noiseRemap;
  let input = noise + spriteAlpha * material.alphaStrength;
  if (material.redIsAlpha) input *= spriteRed;
  const t = clamp01((input - material.step) / material.stepSmooth);
  const alpha = t * t * (3 - 2 * t) * (Math.round(clamp01(tintAlpha) * 255) / 255);
  return material.alphaClip !== false && alpha < .001 ? 0 : alpha;
}

/**
 * Shade a rasterized native sprite at a fixed material phase (time = 0).
 * `origin` is Unity/UI world XY at the output's top-left corner; Y points up.
 * `scale` is output pixels per native UI unit. Screen-space detail coordinates
 * default to this same plane; `screenOrigin`/`screenScale` can override them.
 * The project's linear color space and Canvas_HUD's non-gamma vertex colors
 * require converting the serialized sRGB Image tint before shader arithmetic.
 * This audited path has no overlay, scrolling, clipping rectangle or motion.
 */
export function shadeNativeUi(rgba, width, height, options) {
  dimensions(width, height, rgba);
  const { tint, material, noise, detail, origin = [0, 0], scale = 1,
    screenOrigin = origin, screenScale = scale } = options || {};
  if (!material || !Array.isArray(tint) || tint.length !== 4 || !tint.every(Number.isFinite)
    || !Array.isArray(material.texColor) || material.texColor.length < 3 || !material.texColor.every(Number.isFinite)
    || !["step", "stepSmooth", "alphaStrength", "noiseScale", "noiseRemap", "texScale"].every(key => Number.isFinite(material[key]))
    || material.stepSmooth <= 0 || !Number.isFinite(scale) || scale <= 0
    || !Number.isFinite(screenScale) || screenScale <= 0
    || ![origin, screenOrigin].every(value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)))
    throw new TypeError("Invalid native UI material parameters");
  const readNoise = textureReader(noise, material.noiseWrap || "repeat", material.noiseSrgb === true);
  const readDetail = textureReader(detail, material.detailWrap || "mirror", material.detailSrgb !== false);
  const tintLinear = tint.slice(0, 3).map(value => material.tintSrgb === false ? clamp01(value) : srgbToLinear(clamp01(value)));
  const sourceLinear = material.mainSrgb !== false;
  const output = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y++) {
    const worldY = origin[1] - (y + .5) / scale;
    const detailV = (screenOrigin[1] - (y + .5) / screenScale) * material.texScale / detail.height;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const worldX = origin[0] + (x + .5) / scale;
      const detailU = (screenOrigin[0] + (x + .5) / screenScale) * material.texScale / detail.width;
      const noiseRed = readNoise(worldX * material.noiseScale, worldY * material.noiseScale, 0);
      const red = sourceLinear ? srgbBytes[rgba[offset]] : rgba[offset] / 255;
      const alpha = nativeUiAlpha(rgba[offset + 3] / 255, red, noiseRed, tint[3], material);
      if (alpha <= 0) continue;
      output[offset + 3] = Math.round(alpha * 255);
      for (let channel = 0; channel < 3; channel++) {
        const source = material.redIsAlpha ? 1 : sourceLinear ? srgbBytes[rgba[offset + channel]] : rgba[offset + channel] / 255;
        const paper = 1 + (material.texColor[channel] - 1) * readDetail(detailU, detailV, channel);
        // Native Blend One/OneMinusSrcAlpha emits premultiplied RGB. ImageData
        // expects straight RGB, so encode the unmultiplied color exactly once.
        const linear = clamp01(source * paper * tintLinear[channel]);
        output[offset + channel] = outputBytes[Math.round(linear * 65_535)];
      }
    }
  }
  return output;
}
