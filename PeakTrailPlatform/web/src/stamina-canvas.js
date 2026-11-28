import { resolveUiAsset } from "./game-assets.js";
import { shadeNativeUi } from "./native-ui-material.js";

const packs = new WeakMap(), views = new WeakMap();
const RASTER_SCALE = .5; // ~307px for a 260 CSS-pixel bar; bound CPU work on iOS.
const canvas = (width, height) => {
  const result = document.createElement("canvas");
  result.width = Math.max(1, Math.ceil(width)); result.height = Math.max(1, Math.ceil(height));
  return result;
};

// Native BarAffliction order is the serialized, right-aligned layout order,
// not enum order. Minimum widths are presentation only; meter values retain
// the actual observation. These are the installed scene's values, not C# defaults.
export function nativeStaminaConditions(layout, status, style, extra = false) {
  if (status?.ready !== true || layout.capacity === null && !extra) return [];
  const width = style.sourceWidth;
  const rules = style.layout.conditions;
  const ordered = [...style.conditions].filter(entry => Boolean(entry.isPetrify) === extra)
    .sort((a, b) => rules.order.indexOf(a.id) - rules.order.indexOf(b.id));
  return ordered.flatMap(native => {
    const entry = status.values?.find(value => extra ? value.type === "Petrify" : value.id === native.id && value.type !== "Petrify");
    const amount = entry?.[extra ? "extraStaminaBlock" : "staminaBlock"];
    if (!(amount > rules.visibleThreshold)) return [];
    return [{ native, width: Math.max(rules.minimumWidth, width * amount / (layout.base || 1)) }];
  });
}

async function loadPack(pack) {
  let pending = packs.get(pack);
  if (pending) return pending;
  pending = (async () => {
    const style = pack.catalog.uiStyle.stamina;
    const keys = new Set([...Object.keys(style.images), "staminaNoise", "staminaDetail"]);
    for (const condition of style.conditions) {
      keys.add(condition.uiKey);
      if (condition.fillUiKey) keys.add(condition.fillUiKey);
      if (condition.outlineUiKey) keys.add(condition.outlineUiKey);
    }
    const byUrl = new Map();
    const pixelUrls = new Set(["staminaNoise", "staminaDetail"].map(key => resolveUiAsset(pack, key)?.url));
    const art = {};
    await Promise.all([...keys].map(async key => {
      const source = resolveUiAsset(pack, key);
      if (!source) return;
      if (!byUrl.has(source.url)) byUrl.set(source.url, new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          try {
            const width = image.naturalWidth, height = image.naturalHeight;
            if (pixelUrls.has(source.url)) {
              const temporary = canvas(width, height), ctx = temporary.getContext("2d");
              ctx.drawImage(image, 0, 0);
              const data = ctx.getImageData(0, 0, width, height).data;
              temporary.width = temporary.height = 1;
              resolve({ width, height, data });
            } else resolve({ surface: image, width, height });
          } catch (error) { reject(error); }
        };
        image.onerror = () => reject(new Error("Native stamina art unavailable"));
        image.src = source.url;
      }));
      art[key] = await byUrl.get(source.url);
    }));
    if (!art.staminaNoise || !art.staminaDetail || !art.staminaFill || !art.staminaOutline) throw new Error("Incomplete native stamina art");
    const images = { ...style.images };
    for (const condition of style.conditions) images[condition.uiKey] = condition.iconStyle;
    return { art, style: { ...style, images }, cache: new Map() };
  })();
  packs.set(pack, pending);
  return pending;
}

function pixelsPerUnit(style) {
  return (style.spritePixelsPerUnit || style.pixelsToUnits || 100) / 100 * (style.pixelsPerUnitMultiplier || 1);
}

function sliced(ctx, image, style, width, height) {
  const [left, bottom, right, top] = style.border;
  const ppu = pixelsPerUnit(style);
  const dx = Math.min(1, width / ((left + right) / ppu || 1));
  const dy = Math.min(1, height / ((top + bottom) / ppu || 1));
  const sx = [0, left, image.width - right, image.width], sy = [0, top, image.height - bottom, image.height];
  const x = [0, left / ppu * dx, width - right / ppu * dx, width];
  const y = [0, top / ppu * dy, height - bottom / ppu * dy, height];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    if (x[col + 1] <= x[col] || y[row + 1] <= y[row]) continue;
    ctx.drawImage(image.surface, sx[col], sy[row], sx[col + 1] - sx[col], sy[row + 1] - sy[row],
      x[col], y[row], x[col + 1] - x[col], y[row + 1] - y[row]);
  }
}

function surface(resource, key, width, height, { tint, origin = [0, 0], tiled = false } = {}) {
  const image = resource.art[key], style = resource.style.images[key];
  if (!image || !style || width <= 0 || height <= 0) return null;
  // Widths are quantized to native UI pixels, with a bounded shared cache.
  // No background animation, resize observer, WebGL context or frame loop.
  width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
  origin = origin.map(value => Math.round(value * RASTER_SCALE) / RASTER_SCALE);
  const id = JSON.stringify([key, width, height, tint, origin, tiled]);
  if (resource.cache.has(id)) {
    const cached = resource.cache.get(id);
    resource.cache.delete(id); resource.cache.set(id, cached);
    return cached;
  }
  const result = canvas(width * RASTER_SCALE, height * RASTER_SCALE), ctx = result.getContext("2d", { willReadFrequently: true });
  ctx.scale(RASTER_SCALE, RASTER_SCALE);
  if (tiled) {
    const ppu = pixelsPerUnit(style);
    const tw = image.width / ppu, th = image.height / ppu;
    for (let y = 0; y < height; y += th) for (let x = 0; x < width; x += tw) ctx.drawImage(image.surface, x, y, tw, th);
  } else if (style.border?.some(v => v > 0)) sliced(ctx, image, style, width, height);
  else if (style.preserveAspect) {
    const factor = Math.min(width / image.width, height / image.height), w = image.width * factor, h = image.height * factor;
    const pivot = style.imagePivot || [.5, .5];
    ctx.drawImage(image.surface, (width - w) * pivot[0], (height - h) * (1 - pivot[1]), w, h);
  } else ctx.drawImage(image.surface, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, result.width, result.height);
  pixels.data.set(shadeNativeUi(pixels.data, result.width, result.height, {
    tint: tint || style.color, material: { ...(tiled ? resource.style.conditionMaterial : resource.style.material), mainSrgb: style.mainSrgb },
    noise: resource.art.staminaNoise, detail: resource.art.staminaDetail, origin, scale: RASTER_SCALE,
  }));
  ctx.putImageData(pixels, 0, 0);
  resource.cache.set(id, result);
  if (resource.cache.size > 64) resource.cache.delete(resource.cache.keys().next().value);
  return result;
}

function render(target, resource, model) {
  const { style } = resource, { main, extra, status } = model;
  const full = style.sourceWidth;
  const m = style.layout.main, e = style.layout.extra, c = style.layout.conditions, p = style.layout.petrification;
  const mainConditions = nativeStaminaConditions(main, status, style);
  const extraConditions = nativeStaminaConditions(extra, status, style, true);
  const extraVisible = extra.ratio !== null && (extra.ratio > 0 || extra.blocked > 0 || extraConditions.length > 0);
  const extraBlocked = extra.blocked > 0 || extraConditions.length > 0;
  const outlineWidth = m.outlineExtra + full * Math.max(1, Math.min(3, Number.isFinite(status?.statusSum) ? status.statusSum : 1));
  const extraWidth = Math.max(e.outlineMinWidth, (extraBlocked ? full : full * (extra.ratio || 0)) + e.outlineExtra);
  const overflow = status?.statusSum > m.overflowThreshold;
  const top = Math.ceil(Math.max(mainConditions.length ? -(c.y + c.iconY) : 0, overflow ? -m.overflowY : 0));
  // Include the native extra bar's lightning and 46-unit indentation. It is
  // not a second full-length bar aligned to the main fill's left edge.
  const logicalWidth = Math.ceil(Math.max(outlineWidth, extraVisible ? e.outlineX - m.outlineX + extraWidth : 0,
    extraConditions.length ? p.iconX + p.iconWidth - m.outlineX : 0));
  const logicalHeight = top + Math.max(extraVisible ? e.y + e.height : m.height, overflow ? m.overflowY + m.overflowHeight : 0);
  target.width = Math.ceil(logicalWidth * RASTER_SCALE); target.height = Math.ceil(logicalHeight * RASTER_SCALE);
  target.style.aspectRatio = `${logicalWidth} / ${logicalHeight}`;
  target.style.width = `${260 * logicalWidth / 614}px`;
  const ctx = target.getContext("2d");
  ctx.scale(RASTER_SCALE, RASTER_SCALE);
  const draw = (key, x, y, w, h, options = {}) => {
    const image = surface(resource, key, w, h, { ...options, origin: [x, -y] });
    if (image) ctx.drawImage(image, x - m.outlineX, y + top, w, h);
  };
  const conditions = (entries, x, y, petrify = false) => {
    let cursor = x + full - entries.reduce((sum, entry) => sum + entry.width, 0);
    for (const { native, width } of entries) {
      draw(native.fillUiKey, cursor + c.fillInsetX, y + c.y, Math.max(0, width - c.fillInsetX * 2), c.height, { tint: native.color, tiled: true });
      draw(native.outlineUiKey, cursor + c.outlineX, y + c.y + c.outlineY, width + c.outlineExtraWidth, c.outlineHeight, { tint: native.color });
      if (petrify) draw(native.uiKey, p.iconX, y + p.iconY, p.iconWidth, p.iconHeight);
      else draw(native.uiKey, cursor + (width - c.iconWidth) / 2, y + c.y + c.iconY, c.iconWidth, c.iconHeight);
      cursor += width;
    }
  };
  if (main.ratio !== null) {
    const capacityWidth = full * (main.capacity ?? 1);
    if (capacityWidth > (m.minimumVisibleWidth ?? 0)) draw("staminaBacking", 0, m.fillY, capacityWidth, m.fillHeight);
    if (main.ratio * full > (m.minimumVisibleWidth ?? 0)) draw("staminaFill", 0, m.fillY, main.ratio * full, m.fillHeight);
    draw("staminaOutline", m.outlineX, m.outlineY, outlineWidth, m.outlineHeight);
    draw("staminaOutlineCap", m.outlineX + outlineWidth - m.outlineCapWidth + m.outlineCapRightOffset,
      m.outlineY, m.outlineCapWidth, m.outlineHeight);
    if (overflow) draw("staminaOverflowLine", m.overflowX, m.overflowY, m.overflowWidth, m.overflowHeight);
    // Unknown condition identity remains a neutral remainder, never a guessed ailment.
    if (main.blocked > 0 && !mainConditions.length) draw("staminaBacking", capacityWidth, m.fillY, full - capacityWidth, m.fillHeight, { tint: [.41, .45, .49, 1] });
    conditions(mainConditions, 0, 0);
  }
  if (extraVisible) {
    if (extra.ratio * full > (e.minimumVisibleWidth ?? 6.1)) {
      draw("extraStaminaFill", e.fillX, e.y + e.fillY, extra.ratio * full, e.fillHeight);
      draw("extraStaminaIcon", e.iconX, e.y + e.iconY, e.iconWidth, e.iconHeight);
    }
    draw("extraStaminaOutline", e.outlineX, e.y + e.outlineY, extraWidth, e.outlineHeight);
    if (extra.blocked > 0 && !extraConditions.length) draw("staminaBacking", e.fillX + (extra.capacity ?? 1) * full, e.y + e.fillY, extra.blocked * full, e.fillHeight, { tint: [.41, .45, .49, 1] });
    conditions(extraConditions, p.rightEdge - full, e.y, true);
  }
}

/** Async art loads are fenced across build/player/state changes. Hidden or
 * unsynchronized views cannot be resurrected by a previous request. */
export function updateNativeStaminaCanvas(target, pack, model, onResult) {
  let state = views.get(target);
  if (!state) { state = { generation: 0 }; views.set(target, state); }
  const signature = JSON.stringify([model.main, model.extra, model.status]);
  if (state.pack === pack && state.signature === signature) return;
  state.pack = pack; state.signature = signature;
  const generation = ++state.generation;
  if (!target.getContext || !pack?.catalog?.uiStyle?.stamina?.material
      || model.main.ratio === null && model.extra.ratio === null) {
    target.hidden = true; onResult(false); return;
  }
  if (state.renderedPack !== pack) { target.hidden = true; onResult(false); }
  loadPack(pack).then(resource => {
    if (generation !== state.generation) return;
    render(target, resource, model);
    state.renderedPack = pack; target.hidden = false; onResult(true);
  }).catch(() => {
    if (generation !== state.generation) return;
    target.hidden = true; onResult(false);
  });
}
