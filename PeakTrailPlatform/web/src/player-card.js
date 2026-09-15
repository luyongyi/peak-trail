import { renderAvatarPreview, avatarAppearanceFingerprint } from "./avatar-renderer.js";
import {
  gameAssetFingerprint,
  resolveAppearanceAssets,
  resolveItemAsset,
  resolveUiAsset,
} from "./game-assets.js";

export const PLAYER_BASE_SLOTS = Object.freeze([
  { key: "slot/0", short: "1", label: "快捷 1", index: 0, group: "base" },
  { key: "slot/1", short: "2", label: "快捷 2", index: 1, group: "base" },
  { key: "slot/2", short: "3", label: "快捷 3", index: 2, group: "base" },
  { key: "slot/3", short: "包", label: "背包槽", index: 3, group: "base" },
  { key: "slot/250", short: "临", label: "临时槽", index: 250, group: "base" },
]);

export const PLAYER_BACKPACK_SLOTS = Object.freeze(Array.from({ length: 4 }, (_, index) => ({
  key: `backpack/${index}`,
  short: String(index + 1),
  label: `包内 ${index + 1}`,
  index,
  group: "backpack",
})));

const SLOT_STATE_CLASSES = [
  "has-item", "is-empty", "is-unknown", "is-syncing", "is-unavailable",
  "is-inactive", "is-selected", "is-held", "is-image-ready", "is-image-error",
];

function element(tag, className, text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

export function canonicalInventoryLocation(slot) {
  const location = String(slot?.location || "").trim().toLowerCase().replaceAll("\\", "/");
  const index = Number(slot?.index);
  const container = String(slot?.container || "").trim().toLowerCase();
  let match = location.match(/^backpack(?:\/|:|-)?(\d+)$/);
  if (match) return `backpack/${Number(match[1])}`;
  if (location === "backpack" || container === "backpack") {
    return Number.isInteger(index) && index >= 0 ? `backpack/${index}` : null;
  }
  match = location.match(/^slot(?:\/|:|-)?(\d+)$/);
  if (match) return `slot/${Number(match[1])}`;
  if (["inventory", "quick", "quickslot", "hotbar"].includes(location)) {
    return Number.isInteger(index) && index >= 0 ? `slot/${index}` : null;
  }
  if (["temporary", "temp"].includes(location)) return "slot/250";
  return Number.isInteger(index) && [0, 1, 2, 3, 250].includes(index) ? `slot/${index}` : null;
}

function slotIndex(inventory) {
  const index = new Map();
  for (const slot of inventory?.slots || []) {
    const key = canonicalInventoryLocation(slot);
    if (key && !index.has(key)) index.set(key, slot);
  }
  return index;
}

export function inventoryVisualState(inventory, definition) {
  if (!inventory?.captured) return { mode: "unknown", item: null };
  if (inventory.ready === false) return { mode: "syncing", item: null };
  if (definition.group === "backpack") {
    if (!inventory.backpackContentsPresent) return { mode: "inactive", item: null };
    if (!inventory.backpackContentsReady) return { mode: "syncing", item: null };
  }
  const slot = slotIndex(inventory).get(definition.key);
  if (!slot) return { mode: "unavailable", item: null };
  if (slot.item) return { mode: "item", item: slot.item, slot };
  if (slot.empty) return { mode: "empty", item: null, slot };
  return { mode: "unavailable", item: null, slot };
}

function createSlot(definition, compact = false) {
  const node = element("div", `visual-slot is-unknown${compact ? " held-visual-slot" : ""}`);
  node.dataset.location = definition.key;
  node.dataset.label = definition.label;
  const key = element("span", "visual-slot-key", definition.short);
  const art = element("span", "visual-slot-art");
  const image = element("img", "visual-slot-image");
  image.hidden = true;
  image.decoding = "async";
  const fallback = element("span", "visual-slot-fallback", "未记录");
  const count = element("span", "visual-slot-count");
  const held = element("span", "visual-slot-held", "手持");
  art.append(image, fallback, count, held);
  const caption = element("span", "visual-slot-caption", definition.label);
  node.append(key, art, caption);
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", `${definition.label}：未记录`);
  return node;
}

function makeVital(title, rolePrefix, extra = false) {
  const vital = element("div", `vital-row${extra ? " extra" : ""}`);
  const heading = element("span", "vital-label", title);
  const track = element("span", "vital-track is-unknown");
  const fill = element("i");
  fill.dataset.role = `${rolePrefix}-bar`;
  track.append(fill);
  const output = element("output");
  output.dataset.role = `${rolePrefix}-value`;
  output.textContent = "未记录";
  vital.append(heading, track, output);
  return vital;
}

export function createPlayerCard(participant, color, onVisibilityChange) {
  const row = element("article", "player-row player-card");
  row.style.setProperty("--player-color", color);
  row.dataset.playerId = participant.id;

  const header = element("header", "player-card-header");
  const colorBadge = element(
    "span",
    "player-color",
    Array.from(participant.nickname || participant.id)[0]?.toUpperCase() || "?",
  );
  const identity = element("span", "player-identity");
  const name = element("strong", null, participant.nickname || participant.id);
  const stableId = element(
    "small",
    null,
    [participant.platform, participant.id].filter(Boolean).join(" · "),
  );
  identity.append(name, stableId);
  const input = element("input");
  input.type = "checkbox";
  input.checked = true;
  input.setAttribute("aria-label", `显示 ${participant.nickname || participant.id}`);
  input.addEventListener("change", () => onVisibilityChange?.(input.checked));
  const check = element("span", "player-check");
  const toggle = element("label", "player-toggle");
  toggle.title = `显示或隐藏 ${participant.nickname || participant.id}`;
  toggle.append(input, check);
  header.append(colorBadge, identity, toggle);

  const overview = element("div", "player-overview");
  const appearance = element("section", "appearance-panel is-unknown");
  appearance.dataset.role = "appearance";
  const appearanceMedia = element("div", "appearance-media");
  const avatar = element("img", "appearance-avatar");
  avatar.hidden = true;
  avatar.decoding = "async";
  const appearancePlaceholder = element("span", "appearance-placeholder", "未记录\n外观");
  const appearanceBadge = element("span", "appearance-badge", "历史未知");
  appearanceMedia.append(avatar, appearancePlaceholder, appearanceBadge);
  const appearanceCopy = element("div", "appearance-copy");
  const appearanceTitle = element("strong", null, "本局未记录外观");
  appearanceTitle.dataset.role = "appearance-title";
  const appearanceMeta = element("small", null, "不会用当前套装冒充历史记录");
  appearanceMeta.dataset.role = "appearance-meta";
  appearanceCopy.append(appearanceTitle, appearanceMeta);
  const features = element("div", "appearance-features");
  features.dataset.role = "appearance-features";
  appearance.append(appearanceMedia, appearanceCopy, features);

  const status = element("section", "player-status");
  const heldSummary = element("div", "held-summary");
  heldSummary.dataset.role = "held-summary";
  const heldSlot = createSlot({ key: "held", short: "手", label: "当前手持" }, true);
  heldSlot.dataset.role = "held-slot";
  const heldCopy = element("span", "held-copy");
  const heldName = element("strong", null, "当前手持未记录");
  heldName.dataset.role = "held-name";
  const heldMeta = element("small", null, "等待物品快照");
  heldMeta.dataset.role = "held-meta";
  heldCopy.append(heldName, heldMeta);
  heldSummary.append(heldSlot, heldCopy);
  const vitals = element("div", "vitals");
  vitals.append(makeVital("体力", "stamina"), makeVital("额外", "extra", true));
  const telemetryAuthority = element("small", "snapshot-authority");
  telemetryAuthority.dataset.role = "telemetry-authority";
  status.append(heldSummary, vitals, telemetryAuthority);
  overview.append(appearance, status);

  const loadout = element("section", "player-loadout");
  const loadoutHeader = element("div", "loadout-heading");
  loadoutHeader.append(
    element("strong", null, "物品快照"),
    element("small", null, "随时间线变化"),
  );
  const baseSlots = element("div", "loadout-grid base-slots");
  baseSlots.dataset.role = "base-slots";
  for (const definition of PLAYER_BASE_SLOTS) baseSlots.append(createSlot(definition));
  const backpack = element("div", "backpack-loadout");
  const backpackHeading = element("div", "backpack-heading");
  const backpackIcon = element("img", "backpack-heading-icon");
  backpackIcon.hidden = true;
  backpackIcon.dataset.role = "backpack-icon";
  const backpackTitle = element("span");
  backpackTitle.append(
    element("strong", null, "背包内部"),
    element("small", null, "4 格 · 未记录"),
  );
  backpackTitle.querySelector("small").dataset.role = "backpack-state";
  backpackHeading.append(backpackIcon, backpackTitle);
  const backpackSlots = element("div", "loadout-grid backpack-slots");
  backpackSlots.dataset.role = "backpack-slots";
  for (const definition of PLAYER_BACKPACK_SLOTS) backpackSlots.append(createSlot(definition));
  backpack.append(backpackHeading, backpackSlots);
  const inventoryAuthority = element("small", "snapshot-authority inventory-authority");
  inventoryAuthority.dataset.role = "inventory-authority";
  loadout.append(loadoutHeader, baseSlots, backpack, inventoryAuthority);
  row.append(header, overview, loadout);
  return row;
}

function telemetryRatio(value, max, normalized) {
  if (Number.isFinite(normalized)) return Math.min(1, Math.max(0, normalized));
  if (Number.isFinite(value) && max === 0) return 0;
  if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
    return Math.min(1, Math.max(0, value / max));
  }
  if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  return null;
}

function telemetryValue(value, max, normalized) {
  if (Number.isFinite(normalized)) return `${Math.round(normalized * 100)}%`;
  if (Number.isFinite(value) && max === 0) return "0%";
  if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
    return `${Math.round(Math.min(1, Math.max(0, value / max)) * 100)}%`;
  }
  if (Number.isFinite(value) && value >= 0 && value <= 1) return `${Math.round(value * 100)}%`;
  if (Number.isFinite(value)) return value.toFixed(2).replace(/\.00$/, "");
  return "未记录";
}

function updateVital(row, telemetry, role, value, max, normalized) {
  const ratio = telemetryRatio(value, max, normalized);
  const bar = row.querySelector(`[data-role="${role}-bar"]`);
  const output = row.querySelector(`[data-role="${role}-value"]`);
  bar.style.width = `${(ratio ?? 0) * 100}%`;
  bar.parentElement.classList.toggle("is-unknown", ratio === null);
  bar.parentElement.classList.toggle("is-low", ratio !== null && ratio <= 0.2);
  output.textContent = telemetry?.ready === false
    ? "同步中"
    : telemetryValue(value, max, normalized);
  output.title = Number.isFinite(value)
    ? `${value}${Number.isFinite(max) ? ` / ${max}` : ""}`
    : output.textContent;
}

function imageSource(image, url, alt, owner) {
  if (!url) {
    image.hidden = true;
    image.removeAttribute("src");
    delete image.dataset.assetUrl;
    image.alt = "";
    owner?.classList.remove("is-image-ready", "is-image-error");
    return;
  }
  image.hidden = false;
  image.alt = alt;
  if (image.dataset.assetUrl === url) return;
  image.dataset.assetUrl = url;
  owner?.classList.remove("is-image-ready", "is-image-error");
  image.onload = () => {
    if (image.dataset.assetUrl === url) owner?.classList.add("is-image-ready");
  };
  image.onerror = () => {
    if (image.dataset.assetUrl !== url) return;
    image.hidden = true;
    owner?.classList.add("is-image-error");
    const fallback = owner?.querySelector?.(".visual-slot-fallback");
    if (fallback) fallback.hidden = false;
    const appearancePlaceholder = owner?.querySelector?.(".appearance-placeholder");
    if (appearancePlaceholder) {
      appearancePlaceholder.hidden = false;
      appearancePlaceholder.textContent = "真实图像\n加载失败";
    }
  };
  image.src = url;
}

function itemIdentity(item) {
  return [item?.itemId, item?.id, item?.prefabName, item?.name, item?.count]
    .map((value) => value ?? "")
    .join(":");
}

function slotFallback(mode, assetStatus, item) {
  if (mode === "unknown") return "未记录";
  if (mode === "syncing") return "同步中";
  if (mode === "inactive") return "未装备";
  if (mode === "unavailable") return "不可用";
  if (mode === "empty") return "空";
  if (!item) return "描述缺失";
  if (assetStatus === "loading") return "载入图标";
  return "无真实图";
}

function renderSlot(node, visual, { assetPack, assetStatus, selected = false, held = false } = {}) {
  const fingerprint = [
    visual.mode,
    itemIdentity(visual.item),
    selected,
    held,
    assetStatus,
    gameAssetFingerprint(assetPack),
  ].join("|");
  if (node.dataset.renderFingerprint === fingerprint) return;
  node.dataset.renderFingerprint = fingerprint;
  node.classList.remove(...SLOT_STATE_CLASSES);
  node.classList.add(visual.mode === "item" ? "has-item" : `is-${visual.mode}`);
  node.classList.toggle("is-selected", selected);
  node.classList.toggle("is-held", held);
  const image = node.querySelector(".visual-slot-image");
  const fallback = node.querySelector(".visual-slot-fallback");
  const count = node.querySelector(".visual-slot-count");
  const asset = visual.item ? resolveItemAsset(assetPack, visual.item) : null;
  imageSource(image, asset?.iconUrl, asset?.name || visual.item?.name || "PEAK 物品", node);
  fallback.textContent = slotFallback(visual.mode, assetStatus, visual.item);
  fallback.hidden = Boolean(asset?.iconUrl);
  count.textContent = Number.isFinite(visual.item?.count) && visual.item.count !== 1
    ? `×${visual.item.count}`
    : "";
  const label = node.dataset.label;
  const itemName = asset?.name || visual.item?.name || visual.item?.prefabName || visual.item?.id;
  const stateName = itemName || slotFallback(visual.mode, assetStatus, visual.item);
  node.setAttribute("aria-label", `${label}：${stateName}${selected ? "，已选中" : ""}${held ? "，手持" : ""}`);
  node.title = [
    `${label} · ${stateName}`,
    visual.item?.itemId !== null && visual.item?.itemId !== undefined
      ? `itemId ${visual.item.itemId}` : null,
    visual.item?.prefabName,
    selected ? "当前选中槽" : null,
    held ? "当前手持" : null,
    asset?.source ? "图像：本机 PEAK 游戏资源" : null,
  ].filter(Boolean).join("\n");
}

function heldVisual(playerState) {
  const inventory = playerState.inventory;
  if (inventory?.captured) {
    if (inventory.ready === false) return { mode: "syncing", item: null };
    if (!inventory.heldCaptured) return { mode: "unknown", item: null };
    if (!inventory.heldPresent) return { mode: "empty", item: null };
    return inventory.held
      ? { mode: "item", item: inventory.held }
      : { mode: "unavailable", item: null };
  }
  const telemetry = playerState.telemetry;
  if (!telemetry?.itemCaptured) return { mode: "unknown", item: null };
  return telemetry.item ? { mode: "item", item: telemetry.item } : { mode: "empty", item: null };
}

function updateHeld(row, playerState, context) {
  const visual = heldVisual(playerState);
  const node = row.querySelector('[data-role="held-slot"]');
  renderSlot(node, visual, { ...context, held: visual.mode === "item" });
  const name = row.querySelector('[data-role="held-name"]');
  const meta = row.querySelector('[data-role="held-meta"]');
  const asset = visual.item ? resolveItemAsset(context.assetPack, visual.item) : null;
  if (visual.mode === "item") {
    name.textContent = asset?.name || visual.item?.name || visual.item?.prefabName || "已持有物品";
    meta.textContent = asset?.iconUrl ? "真实游戏图标" : "日志有物品 · 此构建图标不可用";
  } else {
    name.textContent = {
      syncing: "物品同步中",
      empty: "当前未持有物品",
      unavailable: "已持有 · 描述不可用",
      unknown: "当前手持未记录",
    }[visual.mode];
    meta.textContent = visual.mode === "syncing" ? "等待主机快照" : "随时间线读取";
  }
}

function selectedSlotKey(inventory) {
  return inventory?.selectedSlotKnown && Number.isInteger(Number(inventory.selectedSlot))
    ? `slot/${Number(inventory.selectedSlot)}`
    : null;
}

function updateInventory(row, inventory, context) {
  const selectedKey = selectedSlotKey(inventory);
  const heldIsKnown = inventory?.heldCaptured && inventory?.heldPresent;
  for (const definition of [...PLAYER_BASE_SLOTS, ...PLAYER_BACKPACK_SLOTS]) {
    const node = row.querySelector(`[data-location="${definition.key}"]`);
    const selected = definition.key === selectedKey;
    renderSlot(node, inventoryVisualState(inventory, definition), {
      ...context,
      selected,
      held: heldIsKnown && selected,
    });
  }
  const backpackState = row.querySelector('[data-role="backpack-state"]');
  if (!inventory?.captured) backpackState.textContent = "4 格 · 未记录";
  else if (inventory.ready === false) backpackState.textContent = "4 格 · 等待主机快照";
  else if (!inventory.backpackContentsPresent) backpackState.textContent = "4 格 · 未装备背包";
  else if (!inventory.backpackContentsReady) backpackState.textContent = "4 格 · 内容未同步";
  else backpackState.textContent = "4 格 · 已同步";
  const authority = row.querySelector('[data-role="inventory-authority"]');
  authority.textContent = !inventory?.captured
    ? "物品：此日志未记录"
    : inventory.ready === false
      ? "物品：同步中，暂不把空槽当作真实"
      : `物品快照${inventory.authority ? ` · ${inventory.authority}` : ""}${selectedKey ? "" : " · 选中槽未知"}`;

  const backpackIcon = row.querySelector('[data-role="backpack-icon"]');
  const uiAsset = resolveUiAsset(context.assetPack, "backpackIcon")
    || resolveUiAsset(context.assetPack, "backpack");
  imageSource(backpackIcon, uiAsset?.url, "PEAK 背包图标", row.querySelector(".backpack-heading"));
}

function rgba(color) {
  if (!Array.isArray(color)) return null;
  const channels = color.slice(0, 3).map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
  return `rgba(${channels.join(",")},${Math.min(1, Math.max(0, color[3] ?? 1))})`;
}

function featureChip(label, component, color = null) {
  if (!component && !color) return null;
  const chip = element("span", "appearance-feature");
  if (component?.assetUrl) {
    const image = element("img");
    image.decoding = "async";
    imageSource(image, component.assetUrl, `${label}：${component.entry?.name || component.index}`, chip);
    chip.append(image);
  } else if (color) {
    const swatch = element("i", "appearance-swatch");
    swatch.style.background = color;
    chip.append(swatch);
  }
  chip.append(element("span", null, label));
  chip.title = `${label} · ${(component?.entry?.name || component?.index) ?? "日志颜色"} · 本机 PEAK 游戏资源`;
  return chip;
}

function fallbackAppearancePreview(panel, avatar, placeholder, title, meta, badge, assets, appearance) {
  if (assets?.previewUrl) {
    imageSource(
      avatar,
      assets.previewUrl,
      `PEAK 原始套装：${assets.components.fit?.entry?.name || appearance.outfitIndex}`,
      panel,
    );
    placeholder.hidden = true;
    title.textContent = assets.components.fit?.entry?.name || `套装 ${appearance.outfitIndex}`;
    meta.textContent = "真实套装预览 · 未把缺少的个性化部分伪造出来";
    badge.textContent = "套装预览";
    panel.classList.add("is-ready", "is-partial");
    return;
  }
  imageSource(avatar, null, "", panel);
  placeholder.hidden = false;
  placeholder.textContent = "真实模型\n待渲染";
  title.textContent = assets?.components.fit?.entry?.name || `本局套装 ${appearance.outfitIndex ?? "已记录"}`;
  meta.textContent = "外观索引可信；此构建暂无可显示的完整预览";
  badge.textContent = "有记录";
  panel.classList.add("is-partial");
}

function updateAppearance(row, playerState, context) {
  const panel = row.querySelector('[data-role="appearance"]');
  const avatar = panel.querySelector(".appearance-avatar");
  const placeholder = panel.querySelector(".appearance-placeholder");
  const badge = panel.querySelector(".appearance-badge");
  const title = row.querySelector('[data-role="appearance-title"]');
  const meta = row.querySelector('[data-role="appearance-meta"]');
  const features = row.querySelector('[data-role="appearance-features"]');
  const appearance = playerState.appearance;
  const fingerprint = [
    avatarAppearanceFingerprint(context.assetPack, appearance),
    appearance?.ready,
    appearance?.source,
    appearance?.authority,
    context.assetStatus,
    playerState.appearanceTime,
  ].join("|");
  if (panel.dataset.renderFingerprint === fingerprint) return;
  panel.dataset.renderFingerprint = fingerprint;
  panel.dataset.avatarToken = fingerprint;
  panel.classList.remove("is-ready", "is-partial", "is-syncing", "is-unknown", "is-local-current");
  features.replaceChildren();
  imageSource(avatar, null, "", panel);
  avatar.hidden = true;
  placeholder.hidden = false;

  if (!appearance?.captured) {
    panel.classList.add("is-unknown");
    placeholder.textContent = "未记录\n外观";
    badge.textContent = "历史未知";
    title.textContent = "本局未记录外观";
    meta.textContent = "不会用本地当前套装冒充历史记录";
    return;
  }
  if (appearance.ready === false) {
    panel.classList.add("is-syncing");
    placeholder.textContent = "外观\n同步中";
    badge.textContent = "同步中";
    title.textContent = "等待玩家外观同步";
    meta.textContent = appearance.authority || "暂不显示默认角色";
    return;
  }

  const isLocalCurrent = String(appearance.source || "").toLowerCase() === "local-current";
  panel.classList.toggle("is-local-current", isLocalCurrent);
  badge.textContent = isLocalCurrent ? "本地当前 · 非历史" : "本局记录";
  if (context.assetStatus === "loading") {
    panel.classList.add("is-syncing");
    placeholder.textContent = "载入真实\n游戏模型";
    title.textContent = "正在组装本局角色";
    meta.textContent = "只读取与足迹 build 完全一致的本机 PEAK 素材";
    return;
  }
  if (!context.assetPack) {
    panel.classList.add("is-partial");
    placeholder.textContent = "外观已记录\n素材缺失";
    title.textContent = "本局外观索引已记录";
    meta.textContent = context.assetStatus === "missing"
      ? "此游戏构建没有匹配的真实素材包"
      : "真实素材目录暂时不可用";
    return;
  }

  const assets = resolveAppearanceAssets(context.assetPack, appearance);
  const skin = rgba(appearance.skinColor || assets?.components.skin?.entry?.color);
  for (const [label, component] of [
    ["眼睛", assets?.components.eyes],
    ["嘴型", assets?.components.mouth],
    ["配件", assets?.components.accessory],
    ["帽子", assets?.components.hat],
    ["肩带", assets?.components.sash],
    ["徽章", assets?.components.medal],
  ]) {
    const chip = featureChip(label, component);
    if (chip) features.append(chip);
  }
  const skinChip = featureChip("肤色", assets?.components.skin, skin);
  if (skinChip) features.prepend(skinChip);

  fallbackAppearancePreview(panel, avatar, placeholder, title, meta, badge, assets, appearance);
  if (isLocalCurrent) badge.textContent = "本地当前 · 非历史";
  const token = fingerprint;
  title.textContent = assets?.components.fit?.entry?.name || `套装 ${appearance.outfitIndex}`;
  meta.textContent = "正在用本局记录装配 PEAK 原始模型…";
  void renderAvatarPreview(context.assetPack, appearance).then((rendered) => {
    if (panel.dataset.avatarToken !== token || !rendered) return;
    imageSource(avatar, rendered.dataUrl, `本局 PEAK 角色：${rendered.fitName}`, panel);
    placeholder.hidden = true;
    panel.classList.remove("is-partial", "is-syncing");
    panel.classList.add("is-ready");
    badge.textContent = isLocalCurrent ? "本地当前 · 非历史" : "本局模型";
    title.textContent = rendered.fitName;
    meta.textContent = [
      "PEAK 原始模型与纹理",
      rendered.hatName,
      rendered.sashName,
      rendered.medalName,
    ].filter(Boolean).join(" · ");
  }).catch(() => {
    if (panel.dataset.avatarToken !== token) return;
    fallbackAppearancePreview(panel, avatar, placeholder, title, meta, badge, assets, appearance);
    if (isLocalCurrent) badge.textContent = "本地当前 · 非历史";
  });
}

export function updatePlayerCard(row, playerState, context = {}) {
  const telemetry = playerState.telemetry;
  updateVital(row, telemetry, "stamina", telemetry?.stamina, telemetry?.maxStamina, telemetry?.stamina01);
  updateVital(
    row,
    telemetry,
    "extra",
    telemetry?.extraStamina,
    telemetry?.maxExtraStamina,
    telemetry?.extraStamina01,
  );
  const telemetryAuthority = row.querySelector('[data-role="telemetry-authority"]');
  telemetryAuthority.textContent = telemetry?.ready === false
    ? "体力：等待玩家同步"
    : telemetry?.captured
      ? `体力快照${telemetry.authority ? ` · ${telemetry.authority}` : ""}`
      : "体力：此日志未记录";
  updateHeld(row, playerState, context);
  updateInventory(row, playerState.inventory, context);
  updateAppearance(row, playerState, context);
}
