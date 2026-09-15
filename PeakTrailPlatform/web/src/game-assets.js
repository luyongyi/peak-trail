const DEFAULT_INDEX_URL = new URL("../data/game-assets/catalog.json", import.meta.url);

function textKey(value) {
  if (value === undefined || value === null) return null;
  const key = String(value).trim().toLocaleLowerCase("en-US");
  return key || null;
}

function exactBuildId(value) {
  if (value === undefined || value === null) return null;
  const id = String(value).trim();
  return id || null;
}

function safeChildUrl(baseUrl, reference) {
  if (typeof reference !== "string" || !reference.trim() || reference.includes("\\")) return null;
  const value = reference.trim();
  if (value.startsWith("/") || value.startsWith("//")) return null;
  let base;
  let resolved;
  try {
    base = new URL("./", baseUrl);
    resolved = new URL(value, base);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) return null;
  if (resolved.username || resolved.password || resolved.search || resolved.hash) return null;
  return resolved;
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { cache: "force-cache" });
  if (!response?.ok) throw new Error(`真实游戏素材目录读取失败（${response?.status ?? "network"}）`);
  const value = await response.json();
  if (!value || typeof value !== "object") throw new Error("真实游戏素材目录不是 JSON 对象");
  return value;
}

function entryIndex(entries) {
  const index = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const value = Number(entry?.index);
    if (Number.isInteger(value) && value >= 0) index.set(value, entry);
  }
  return index;
}

function firstAssetReference(entry, fields) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  for (const field of fields) {
    if (typeof entry[field] === "string" && entry[field].trim()) return entry[field];
  }
  return null;
}

function assetFromEntry(pack, entry, fields = ["icon", "preview", "texture", "image", "path"]) {
  const reference = firstAssetReference(entry, fields);
  const url = reference ? safeChildUrl(pack.catalogUrl, reference) : null;
  return url ? { entry, url: url.href } : null;
}

export function resolveGameAssetUrl(pack, reference) {
  return pack ? safeChildUrl(pack.catalogUrl, reference)?.href || null : null;
}

function itemLookupKeys(item) {
  return [item?.itemId, item?.id, item?.prefabName, item?.name]
    .map(textKey)
    .filter(Boolean);
}

function catalogItemKeys(item) {
  return [item?.itemId, item?.id, item?.prefabName, item?.prefab, item?.name]
    .map(textKey)
    .filter(Boolean);
}

/**
 * Loads only the catalog for the trace's exact PEAK build. There is deliberately
 * no "latest build" fallback: showing a plausible icon from a different build
 * would make a historical replay look more authoritative than it is.
 */
export async function loadGameAssetPack(gameBuildId, options = {}) {
  const wantedBuildId = exactBuildId(gameBuildId);
  if (!wantedBuildId) return null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前环境不支持读取真实游戏素材");
  const indexUrl = options.indexUrl ? new URL(options.indexUrl) : DEFAULT_INDEX_URL;
  const index = await fetchJson(indexUrl, fetchImpl);
  if (index.schemaVersion !== 1 || !Array.isArray(index.builds)) {
    throw new Error("真实游戏素材总目录版本无效");
  }
  const build = index.builds.find(
    (entry) => exactBuildId(entry?.gameBuildId) === wantedBuildId,
  );
  if (!build) return null;
  const catalogUrl = safeChildUrl(indexUrl, build.catalog);
  if (!catalogUrl) throw new Error("真实游戏素材目录包含不安全的构建路径");
  const catalog = await fetchJson(catalogUrl, fetchImpl);
  if (catalog.schemaVersion !== 1 || exactBuildId(catalog.gameBuildId) !== wantedBuildId) {
    throw new Error("真实游戏素材构建与足迹构建不一致");
  }

  const itemIndex = new Map();
  for (const item of Array.isArray(catalog.items) ? catalog.items : []) {
    for (const key of catalogItemKeys(item)) {
      if (!itemIndex.has(key)) itemIndex.set(key, item);
    }
  }
  const customization = catalog.customization && typeof catalog.customization === "object"
    ? catalog.customization
    : {};
  return {
    schemaVersion: 1,
    gameBuildId: wantedBuildId,
    source: String(catalog.source || "local-unity-assets"),
    catalogUrl,
    catalog,
    itemIndex,
    ui: catalog.ui && typeof catalog.ui === "object" ? catalog.ui : {},
    customization,
    customizationIndex: {
      skins: entryIndex(customization.skins),
      eyes: entryIndex(customization.eyes),
      mouths: entryIndex(customization.mouths),
      accessories: entryIndex(customization.accessories),
      fits: entryIndex(customization.fits),
      hats: entryIndex(customization.hats),
      sashes: entryIndex(customization.sashes),
      medals: entryIndex(customization.medals),
    },
  };
}

export function resolveItemAsset(pack, item) {
  if (!pack || !item) return null;
  let entry = null;
  for (const key of itemLookupKeys(item)) {
    entry = pack.itemIndex.get(key);
    if (entry) break;
  }
  if (!entry) return null;
  const asset = assetFromEntry(pack, entry, ["icon", "image", "texture", "path"]);
  return {
    entry,
    iconUrl: asset?.url || null,
    name: String(entry.name || item.name || entry.prefabName || item.id || "未知物品"),
    source: pack.source,
  };
}

export function resolveUiAsset(pack, name) {
  if (!pack || !name) return null;
  const entry = pack.ui[name];
  return assetFromEntry(pack, entry, ["icon", "image", "texture", "path"]);
}

function appearanceComponent(pack, collection, index, fields = ["preview", "icon", "texture", "image", "path"]) {
  if (!pack || !Number.isInteger(index) || index < 0) return null;
  const entry = pack.customizationIndex[collection]?.get(index) || null;
  if (!entry) return null;
  return {
    entry,
    index,
    assetUrl: assetFromEntry(pack, entry, fields)?.url || null,
    modelUrl: resolveGameAssetUrl(pack, entry.model),
  };
}

function previewMatches(preview, appearance) {
  const fields = [
    "skinIndex", "eyesIndex", "mouthIndex", "accessoryIndex", "outfitIndex",
    "hatIndex", "sashIndex", "medalIndex",
  ];
  let compared = 0;
  for (const field of fields) {
    if (!Number.isInteger(preview?.[field])) continue;
    compared += 1;
    if (preview[field] !== appearance[field]) return false;
  }
  return compared > 0;
}

export function resolveAppearanceAssets(pack, appearance) {
  if (!pack || !appearance?.captured) return null;
  const effectiveHatIndex = Number.isInteger(appearance.effectiveHatIndex)
    ? appearance.effectiveHatIndex
    : appearance.hatIndex;
  const components = {
    skin: appearanceComponent(pack, "skins", appearance.skinIndex, ["preview", "texture", "image", "path"]),
    eyes: appearanceComponent(pack, "eyes", appearance.eyesIndex),
    mouth: appearanceComponent(pack, "mouths", appearance.mouthIndex),
    accessory: appearanceComponent(pack, "accessories", appearance.accessoryIndex),
    fit: appearanceComponent(pack, "fits", appearance.outfitIndex, ["preview", "image", "texture", "path"]),
    hat: appearanceComponent(pack, "hats", effectiveHatIndex),
    sash: appearanceComponent(pack, "sashes", appearance.sashIndex),
    medal: appearanceComponent(pack, "medals", appearance.medalIndex),
  };
  const previews = [
    ...(Array.isArray(pack.customization.appearancePreviews)
      ? pack.customization.appearancePreviews : []),
    ...(Array.isArray(pack.customization.previews) ? pack.customization.previews : []),
  ];
  const exactEntry = previews.find((entry) => previewMatches(entry, appearance)) || null;
  const exactAsset = exactEntry
    ? assetFromEntry(pack, exactEntry, ["preview", "image", "texture", "path"])
    : null;
  return {
    previewUrl: exactAsset?.url || components.fit?.assetUrl || null,
    previewKind: exactAsset ? "recorded-composite" : components.fit?.assetUrl ? "fit-preview" : null,
    avatarModelUrl: resolveGameAssetUrl(pack, pack.customization.avatar?.model),
    components,
    source: pack.source,
  };
}

export function gameAssetFingerprint(pack) {
  return pack ? `${pack.gameBuildId}:${pack.catalogUrl.href}` : "none";
}

export const gameAssetIndexUrl = DEFAULT_INDEX_URL.href;
