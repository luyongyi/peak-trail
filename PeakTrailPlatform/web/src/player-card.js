import { renderHeadPreview, headAppearanceFingerprint } from "./avatar-renderer.js";
import { getLocale, tr, gameItemName } from "./i18n.js";
import { staminaLayout, conditionPresentation, conditionSummary, appearanceFormPresentation, effectPresentation } from "./player-conditions.js";
import {
  gameAssetFingerprint,
  resolveAppearanceAssets,
  resolveItemAsset,
  resolveUiAsset,
} from "./game-assets.js";

function baseSlot(index, shortZh, shortEn, labelZh, labelEn) {
  return { key: `slot/${index}`, index, group: "base", get short() { return tr(shortZh, shortEn); }, get label() { return tr(labelZh, labelEn); } };
}
export const PLAYER_BASE_SLOTS = Object.freeze([
  baseSlot(0, "1", "1", "快捷 1", "Quick slot 1"), baseSlot(1, "2", "2", "快捷 2", "Quick slot 2"),
  baseSlot(2, "3", "3", "快捷 3", "Quick slot 3"), baseSlot(3, "包", "Bag", "背包槽", "Backpack slot"),
  baseSlot(250, "临", "Temp", "临时槽", "Temporary slot"),
]);

export const PLAYER_BACKPACK_SLOTS = Object.freeze(Array.from({ length: 4 }, (_, index) => ({
  key: `backpack/${index}`,
  short: String(index + 1),
  get label() { return tr(`包内 ${index + 1}`, `Backpack ${index + 1}`); },
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
  const fallback = element("span", "visual-slot-fallback", tr("未记录", "Not recorded"));
  const count = element("span", "visual-slot-count");
  const held = element("span", "visual-slot-held", tr("手持", "Held"));
  art.append(image, fallback, count, held);
  const caption = element("span", "visual-slot-caption", definition.label);
  node.append(key, art, caption);
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", tr(`${definition.label}：未记录`, `${definition.label}: not recorded`));
  return node;
}

function makeVital(title, rolePrefix, extra = false) {
  const vital = element("div", `vital-row${extra ? " extra" : ""}`);
  const heading = element("span", "vital-label", title);
  const track = element("span", "vital-track is-unknown");
  const fill = element("i");
  fill.dataset.role = `${rolePrefix}-bar`;
  const blocked = element("span", "vital-blocked");
  blocked.dataset.role = `${rolePrefix}-blocked`;
  const conditions = element("span", "vital-conditions");
  conditions.dataset.role = `${rolePrefix}-conditions`;
  track.append(blocked, fill, conditions);
  const output = element("output");
  output.dataset.role = `${rolePrefix}-value`;
  output.textContent = tr("未记录", "Not recorded");
  vital.append(heading, track, output);
  const cap = element("small", "vital-cap", tr("上限未知", "Cap unknown"));
  cap.dataset.role = `${rolePrefix}-cap`;
  vital.append(cap);
  return vital;
}

export function createPlayerCard(participant, color, onVisibilityChange) {
  const row = element("article", "player-row player-card");
  row.style.setProperty("--player-color", color);
  row.dataset.playerId = participant.id;
  row.dataset.playerName = participant.nickname || participant.id;
  row.setAttribute("aria-expanded", "false");

  const header = element("header", "player-card-header");
  const colorBadge = element(
    "span",
    "player-color",
    Array.from(participant.nickname || participant.id)[0]?.toUpperCase() || "?",
  );
  const head = element("img", "player-head-image");
  head.hidden = true;
  head.alt = tr(`${participant.nickname || participant.id}的游戏头像`, `${participant.nickname || participant.id}’s game portrait`);
  head.decoding = "async";
  const headFallback = element("span", "player-head-fallback", colorBadge.textContent);
  colorBadge.replaceChildren(head, headFallback);
  const identity = element("button", "player-identity");
  identity.type = "button";
  identity.setAttribute("aria-label", tr(`展开 ${participant.nickname || participant.id} 的生命、体力与手持信息`, `Expand ${participant.nickname || participant.id}’s life, stamina and held item`));
  identity.setAttribute("aria-expanded", "false");
  const name = element("strong", null, participant.nickname || participant.id);
  const stableId = element(
    "small",
    "player-stable-id",
    [participant.platform, participant.id].filter(Boolean).join(" · "),
  );
  identity.append(name, stableId);
  const input = element("input");
  input.type = "checkbox";
  input.checked = true;
  input.setAttribute("aria-label", tr(`显示 ${participant.nickname || participant.id}`, `Show ${participant.nickname || participant.id}`));
  input.addEventListener("change", () => onVisibilityChange?.(input.checked));
  const check = element("span", "player-check");
  const toggle = element("label", "player-toggle");
  toggle.title = tr(`显示或隐藏 ${participant.nickname || participant.id}`, `Show or hide ${participant.nickname || participant.id}`);
  toggle.append(input, check);
  const followButton = element("button", "player-follow-button", "◎");
  followButton.type = "button";
  followButton.dataset.role = "follow-button";
  followButton.title = tr(`跟随镜头 ${participant.nickname || participant.id}`, `Follow ${participant.nickname || participant.id}`);
  header.append(colorBadge, identity, followButton, toggle);

  const overview = element("div", "player-overview");
  const appearance = element("section", "appearance-panel is-unknown");
  appearance.dataset.role = "appearance";
  const appearanceMedia = element("div", "appearance-media");
  const avatar = element("img", "appearance-avatar");
  avatar.hidden = true;
  avatar.decoding = "async";
  const appearancePlaceholder = element("span", "appearance-placeholder", tr("未记录\n外观", "Appearance\nnot recorded"));
  const appearanceBadge = element("span", "appearance-badge", tr("历史未知", "History unknown"));
  appearanceMedia.append(avatar, appearancePlaceholder, appearanceBadge);
  const appearanceCopy = element("div", "appearance-copy");
  const appearanceTitle = element("strong", null, tr("本局未记录外观", "No appearance recorded for this run"));
  appearanceTitle.dataset.role = "appearance-title";
  const appearanceMeta = element("small", null, tr("不会用当前套装冒充历史记录", "Current outfits are not substituted for history"));
  appearanceMeta.dataset.role = "appearance-meta";
  appearanceCopy.append(appearanceTitle, appearanceMeta);
  const features = element("div", "appearance-features");
  features.dataset.role = "appearance-features";
  appearance.append(appearanceMedia, appearanceCopy, features);

  const status = element("section", "player-status");
  const heldSummary = element("div", "held-summary");
  heldSummary.dataset.role = "held-summary";
  const heldSlot = createSlot({ key: "held", short: tr("手", "Hand"), label: tr("当前手持", "Held item") }, true);
  heldSlot.dataset.role = "held-slot";
  const heldCopy = element("span", "held-copy");
  const heldName = element("strong", null, tr("当前手持未记录", "Held item not recorded"));
  heldName.dataset.role = "held-name";
  const heldMeta = element("small", null, tr("等待物品快照", "Waiting for an item snapshot"));
  heldMeta.dataset.role = "held-meta";
  heldCopy.append(heldName, heldMeta);
  heldSummary.append(heldSlot, heldCopy);
  const vitals = element("div", "vitals");
  vitals.append(makeVital(tr("体力", "Stamina"), "stamina"), makeVital(tr("额外", "Extra"), "extra", true));
  const telemetryAuthority = element("small", "snapshot-authority");
  telemetryAuthority.dataset.role = "telemetry-authority";
  status.append(heldSummary, vitals, telemetryAuthority);
  overview.append(status);

  const conditions = element("section", "player-conditions");
  const conditionHeading = element("div", "loadout-heading");
  conditionHeading.append(element("strong", null, tr("身体状态", "Conditions")));
  const life = element("span", "condition-life"); life.dataset.role = "condition-life";
  conditionHeading.append(life);
  const conditionList = element("div", "condition-list"); conditionList.dataset.role = "condition-list";
  const conditionNote = element("p", "condition-note"); conditionNote.dataset.role = "condition-note";
  const effects = element("div", "condition-effects"); effects.dataset.role = "condition-effects";
  status.prepend(conditionHeading);
  conditions.append(conditionList, conditionNote, effects);

  const loadout = element("section", "player-loadout");
  const loadoutHeader = element("div", "loadout-heading");
  loadoutHeader.append(
    element("strong", null, tr("物品快照", "Inventory snapshot")),
    element("small", null, tr("随时间线变化", "Follows the timeline")),
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
    element("strong", null, tr("背包内部", "Inside backpack")),
    element("small", null, tr("4 格 · 未记录", "4 slots · Not recorded")),
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
  const details = element("details", "player-details");
  const detailsSummary = element("summary", null, tr("玩家详情", "Player details"));
  details.append(detailsSummary, appearance, conditions, loadout);
  row.append(header, overview, details);
  return row;
}

function updateVital(row, playerState, role) {
  const telemetry = playerState.telemetry;
  const layout = staminaLayout(telemetry, playerState.status, role === "extra");
  const { ratio } = layout;
  const output = row.querySelector(`[data-role="${role}-value"]`);
  // Everything below derives from these fields; skip identical DOM writes. Sidebar
  // cards are also throttled during playback, and this keeps seeks and 8 Hz ticks cheap.
  const signature = [getLocale(),
    layout.output,
    ratio,
    layout.blocked,
    layout.capText,
    playerState.status?.ready === true,
    JSON.stringify(layout.blocks),
  ].join("|");
  if (output.dataset.vitalSignature === signature) return;
  output.dataset.vitalSignature = signature;
  const bar = row.querySelector(`[data-role="${role}-bar"]`);
  bar.style.width = `${(ratio ?? 0) * 100}%`;
  bar.parentElement.classList.toggle("is-unknown", ratio === null);
  bar.parentElement.classList.toggle("is-low", ratio !== null && ratio <= 0.2);
  output.textContent = layout.output;
  output.title = `当前 ${layout.value ?? tr(tr("未知", "Form"), "Unknown")} · 可用上限 ${layout.cap ?? tr(tr("未知", "Form"), "Unknown")} · 完整容量 ${layout.base ?? tr(tr("未知", "Form"), "Unknown")}`;
  row.querySelector(`[data-role="${role}-cap"]`).textContent = layout.capText;
  const blocked = row.querySelector(`[data-role="${role}-blocked"]`);
  blocked.style.width = `${(layout.blocked ?? 0) * 100}%`;
  blocked.title = layout.blocked === null ? tr("受限容量未知", "Blocked capacity unknown") : tr(`受限容量 ${Math.round(layout.blocked * 100)}%${playerState.status?.ready === true ? "" : " · 原因未记录"}`, `Blocked capacity ${Math.round(layout.blocked * 100)}%${playerState.status?.ready === true ? "" : " · Cause not recorded"}`);
  const conditions = row.querySelector(`[data-role="${role}-conditions"]`);
  const key = getLocale() + JSON.stringify(layout.blocks);
  if (conditions.dataset.key !== key) {
    conditions.dataset.key = key; conditions.replaceChildren();
    for (const block of layout.blocks) {
      const segment = element("span", "vital-condition");
      segment.style.left = `${block.left * 100}%`; segment.style.width = `${block.width * 100}%`;
      segment.style.background = block.color;
      segment.title = tr(`${block.label}占用 ${Math.round(block.width * 100)}%`, `${block.label} blocks ${Math.round(block.width * 100)}%`);
      conditions.append(segment);
    }
  }
}

function updateConditions(row, playerState) {
  const status = playerState.status;
  const life = row.querySelector('[data-role="condition-life"]');
  life.textContent = { dead: tr("已死亡", "Dead"), alive: tr("存活", "Alive"), absent: tr("已离开", "Left"), unknown: tr("生死未记录", "Life status not recorded") }[playerState.life || "unknown"];
  row.querySelector('[data-role="condition-note"]').textContent = conditionSummary(status);
  const list = row.querySelector('[data-role="condition-list"]');
  const values = status?.ready === true ? status.values.filter((value) => value.amount > 0 || value.staminaBlock > 0 || value.extraStaminaBlock > 0) : [];
  const key = getLocale() + JSON.stringify(values);
  if (list.dataset.key !== key) {
    list.dataset.key = key; list.replaceChildren();
    for (const value of values) {
      const info = conditionPresentation(value.type);
      const chip = element("span", "condition-chip"); chip.style.setProperty("--condition-color", info.color);
      chip.append(element("i"), element("strong", null, info.label), element("span", null, `${Math.round(value.amount * 100)}%`));
      chip.title = tr(`${value.type} · 普通体力占用 ${(value.staminaBlock * 100).toFixed(1)}% · 额外体力占用 ${(value.extraStaminaBlock * 100).toFixed(1)}%`, `${value.type} · Stamina blocked ${(value.staminaBlock * 100).toFixed(1)}% · Extra stamina blocked ${(value.extraStaminaBlock * 100).toFixed(1)}%`);
      list.append(chip);
    }
  }
  const effects = row.querySelector('[data-role="condition-effects"]');
  effects.textContent = status?.effectsReady === true
    ? status.effects.length ? tr(`持续效果：${status.effects.map((effect) => effectPresentation(effect.type)).join(" · ")}（未记录可靠倒计时）`, `Ongoing effects: ${status.effects.map((effect) => effectPresentation(effect.type)).join(" · ")} (reliable countdown not recorded)`) : tr("持续效果：已记录，无活动效果", "Ongoing effects: recorded, none active")
    : tr("持续效果：未记录或未同步，不等于没有效果", "Effects not recorded or synced. This does not mean no active effects");
  effects.title = [status?.effectsAuthority, ...(status?.effects || []).map((effect) => effect.type)].filter(Boolean).join(" · ");
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
      appearancePlaceholder.textContent = tr("真实图像\n加载失败", "Game image\nfailed to load");
    }
  };
  image.src = url;
}

function itemIdentity(item) {
  return [item?.itemId, item?.id, item?.prefabName, item?.name, item?.count]
    .map((value) => value ?? "")
    .join(":");
}

function itemDisplayName(asset, item) {
  return gameItemName(asset?.entry?.prefabName || item?.prefabName || asset?.name || item?.name || item?.id || tr("未知物品", "Unknown item"));
}

function slotFallback(mode, assetStatus, item) {
  if (mode === "unknown") return tr("未记录", "Not recorded");
  if (mode === "syncing") return tr(tr("同步中", "Appearance"), "Syncing");
  if (mode === "inactive") return tr("未装备", "Not equipped");
  if (mode === "unavailable") return tr("不可用", "Unavailable");
  if (mode === "empty") return tr("空", "Empty");
  if (!item) return tr("描述缺失", "Description missing");
  if (assetStatus === "loading") return tr("载入图标", "Loading icon");
  return tr("无真实图", "No game image");
}

function renderSlot(node, visual, { assetPack, assetStatus, selected = false, held = false } = {}) {
  const fingerprint = [getLocale(),
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
  imageSource(image, asset?.iconUrl, visual.item ? itemDisplayName(asset, visual.item) : tr("PEAK 物品", "PEAK item"), node);
  fallback.textContent = slotFallback(visual.mode, assetStatus, visual.item);
  fallback.hidden = Boolean(asset?.iconUrl);
  count.textContent = Number.isFinite(visual.item?.count) && visual.item.count !== 1
    ? `×${visual.item.count}`
    : "";
  const definition = [...PLAYER_BASE_SLOTS, ...PLAYER_BACKPACK_SLOTS].find(value => value.key === node.dataset.location);
  const label = definition?.label || tr("当前手持", "Held item");
  node.dataset.label = label;
  node.querySelector(".visual-slot-caption").textContent = label;
  node.querySelector(".visual-slot-key").textContent = definition?.short || tr("手", "Hand");
  node.querySelector(".visual-slot-held").textContent = tr("手持", "Held");
  const itemName = visual.item ? itemDisplayName(asset, visual.item) : null;
  const stateName = itemName || slotFallback(visual.mode, assetStatus, visual.item);
  node.setAttribute("aria-label", `${label}${tr("：", ": ")}${stateName}${selected ? tr("，已选中", ", selected") : ""}${held ? tr("，手持", ", held") : ""}`);
  node.title = [
    `${label} · ${stateName}`,
    visual.item?.itemId !== null && visual.item?.itemId !== undefined
      ? `itemId ${visual.item.itemId}` : null,
    visual.item?.prefabName,
    selected ? tr("当前选中槽", "Selected slot") : null,
    held ? tr("当前手持", "Held item") : null,
    asset?.source ? tr("图像：本机 PEAK 游戏资源", "Image: PEAK game assets") : null,
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
    name.textContent = itemDisplayName(asset, visual.item);
    meta.textContent = asset?.iconUrl ? tr("真实游戏图标", "Game icon") : tr("日志有物品 · 此构建图标不可用", "Item recorded · Icon unavailable for this build");
  } else {
    name.textContent = {
      syncing: tr("物品同步中", "Items syncing"),
      empty: tr("当前未持有物品", "No held item"),
      unavailable: tr("已持有 · 描述不可用", "Item held · Description unavailable"),
      unknown: tr("当前手持未记录", "Held item not recorded"),
    }[visual.mode];
    meta.textContent = visual.mode === "syncing" ? tr("等待主机快照", "Waiting for a host snapshot") : tr("随时间线读取", "Read from the timeline");
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
  if (!inventory?.captured) backpackState.textContent = tr("4 格 · 未记录", "4 slots · Not recorded");
  else if (inventory.ready === false) backpackState.textContent = tr("4 格 · 等待主机快照", "4 slots · Waiting for host snapshot");
  else if (!inventory.backpackContentsPresent) backpackState.textContent = tr("4 格 · 未装备背包", "4 slots · No backpack equipped");
  else if (!inventory.backpackContentsReady) backpackState.textContent = tr("4 格 · 内容未同步", "4 slots · Contents not synced");
  else backpackState.textContent = tr("4 格 · 已同步", "4 slots · Synced");
  const authority = row.querySelector('[data-role="inventory-authority"]');
  authority.textContent = !inventory?.captured
    ? tr("物品：此日志未记录", "Items: not recorded in this log")
    : inventory.ready === false
      ? tr("物品：同步中，暂不把空槽当作真实", "Items syncing. Empty slots are not yet confirmed")
      : `${tr("物品快照", "Inventory snapshot")}${inventory.authority ? ` · ${inventory.authority}` : ""}${selectedKey ? "" : tr(" · 选中槽未知", " · Selected slot unknown")}`;

  const backpackIcon = row.querySelector('[data-role="backpack-icon"]');
  const uiAsset = resolveUiAsset(context.assetPack, "backpackIcon")
    || resolveUiAsset(context.assetPack, "backpack");
  imageSource(backpackIcon, uiAsset?.url, tr("PEAK 背包图标", "PEAK backpack icon"), row.querySelector(".backpack-heading"));
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
  chip.title = `${label} · ${(component?.entry?.name || component?.index) ?? tr("日志颜色", "Recorded color")} · ${tr("本机 PEAK 游戏资源", "PEAK game assets")}`;
  return chip;
}

function fallbackAppearancePreview(panel, avatar, placeholder, title, meta, badge, assets, appearance) {
  const form = appearanceFormPresentation(appearance);
  imageSource(avatar, null, "", panel);
  placeholder.hidden = false;
  placeholder.textContent = tr("游戏头像\n待渲染", "Game portrait\nwaiting to render");
  title.textContent = form.transformed ? form.label : assets?.components.fit?.entry?.name || tr(`本局套装 ${appearance.outfitIndex ?? "已记录"}`, `Run outfit ${appearance.outfitIndex ?? "recorded"}`);
  meta.textContent = form.transformed ? tr("真实变形已记录；对应头部素材暂不可用，不以普通人脸替代", "Transformation recorded. Matching head assets are unavailable") : tr("头部素材未齐全，不用套装预览代替玩家头像", "Head assets are incomplete. An outfit preview is not a player portrait");
  badge.textContent = tr("有记录", "Recorded");
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
  const form = appearanceFormPresentation(appearance);
  const fingerprint = [getLocale(),
    headAppearanceFingerprint(context.assetPack, appearance),
    appearance?.ready,
    appearance?.source,
    appearance?.authority,
    context.assetStatus,
    playerState.appearanceTime,
    appearance?.formReady,
    appearance?.form,
  ].join("|");
  if (panel.dataset.renderFingerprint === fingerprint) return;
  panel.dataset.renderFingerprint = fingerprint;
  panel.dataset.avatarToken = fingerprint;
  const headerHead = row.querySelector(".player-head-image");
  const headerFallback = row.querySelector(".player-head-fallback");
  headerHead.hidden = true;
  headerHead.removeAttribute("src");
  headerFallback.hidden = false;
  context.onPortrait?.(null);
  panel.classList.remove("is-ready", "is-partial", "is-syncing", "is-unknown", "is-local-current");
  features.replaceChildren();
  imageSource(avatar, null, "", panel);
  avatar.hidden = true;
  placeholder.hidden = false;

  if (!appearance?.captured) {
    panel.classList.add("is-unknown");
    placeholder.textContent = tr("未记录\n外观", "Appearance\nnot recorded");
    badge.textContent = tr("历史未知", "History unknown");
    title.textContent = tr("本局未记录外观", "No appearance recorded for this run");
    meta.textContent = tr("不会用本地当前套装冒充历史记录", "Current local outfits are not substituted for history");
    return;
  }
  if (appearance.formReady === false || (appearance.formReady === true && !form.known)) {
    panel.classList.add("is-unknown");
    placeholder.textContent = tr("形态\n未知", "Form\nunknown");
    badge.textContent = tr("形态未同步", "Form not synced");
    title.textContent = tr("当前人物形态尚未确认", "Player form not yet confirmed");
    meta.textContent = tr("已清除上一时刻头像，等待新的真实形态记录", "Previous portrait cleared. Waiting for a recorded form");
    return;
  }
  if (appearance.ready === false && !form.transformed) {
    panel.classList.add("is-syncing");
    placeholder.textContent = tr("外观\n同步中", "Appearance\nsyncing");
    badge.textContent = tr(tr("同步中", "Appearance"), "Syncing");
    title.textContent = tr("等待玩家外观同步", "Waiting for appearance to sync");
    meta.textContent = appearance.authority || tr("暂不显示默认角色", "Default character hidden");
    return;
  }

  const isLocalCurrent = String(appearance.source || "").toLowerCase() === "local-current";
  panel.classList.toggle("is-local-current", isLocalCurrent);
  badge.textContent = isLocalCurrent ? tr("本地当前 · 非历史", "Current local outfit · Not historical") : tr("本局记录", "Recorded this run");
  if (context.assetStatus === "loading") {
    panel.classList.add("is-syncing");
    placeholder.textContent = tr("载入真实\n游戏头像", "Loading game\nportrait");
    title.textContent = tr("正在组装本局头像", "Building this run’s portrait");
    meta.textContent = tr("只读取与足迹 build 完全一致的本机 PEAK 素材", "Using PEAK assets from the exact recorded build");
    return;
  }
  if (!context.assetPack) {
    panel.classList.add("is-partial");
    placeholder.textContent = tr("外观已记录\n素材缺失", "Appearance recorded\nassets missing");
    title.textContent = tr("本局外观索引已记录", "Appearance indices recorded");
    meta.textContent = context.assetStatus === "missing"
      ? tr("此游戏构建没有匹配的真实素材包", "No matching assets for this game build")
      : tr("真实素材目录暂时不可用", "Game asset catalog temporarily unavailable");
    return;
  }

  const assets = resolveAppearanceAssets(context.assetPack, appearance);
  const skin = rgba(appearance.skinColor || assets?.components.skin?.entry?.color);
  for (const [key, label, component] of [
    ["eyes", tr("眼睛", "Eyes"), assets?.components.eyes],
    ["mouth", tr("嘴型", "Mouth"), assets?.components.mouth],
    ["accessory", tr("配件", "Accessory"), assets?.components.accessory],
    ["hat", tr("帽子", "Hat"), assets?.components.hat],
    ["sash", tr("肩带", "Sash"), assets?.components.sash],
    ["medal", tr("徽章", "Medal"), assets?.components.medal],
  ]) {
    if (form.transformed && key !== "hat") continue;
    if (appearance.form === "mushroom" && key === "hat") continue;
    const chip = featureChip(label, component);
    if (chip) features.append(chip);
  }
  const skinChip = featureChip(tr("肤色", "Skin"), assets?.components.skin, skin);
  if (skinChip && !form.transformed) features.prepend(skinChip);

  fallbackAppearancePreview(panel, avatar, placeholder, title, meta, badge, assets, appearance);
  if (isLocalCurrent) badge.textContent = tr("本地当前 · 非历史", "Current local outfit · Not historical");
  const token = fingerprint;
  title.textContent = form.transformed ? form.label : assets?.components.fit?.entry?.name || tr(`套装 ${appearance.outfitIndex}`, `Outfit ${appearance.outfitIndex}`);
  meta.textContent = form.transformed ? tr("正在读取游戏中的真实变形头部…", "Loading the game’s transformed head…") : tr("正在用本局记录装配头部、脸型与帽子…", "Assembling the recorded head, face and hat…");
  void renderHeadPreview(context.assetPack, appearance).then((rendered) => {
    if (panel.dataset.avatarToken !== token) return;
    if (!rendered) {
      fallbackAppearancePreview(panel, avatar, placeholder, title, meta, badge, assets, appearance);
      if (isLocalCurrent) badge.textContent = tr("本地当前 · 非历史", "Current local outfit · Not historical");
      return;
    }
    imageSource(avatar, rendered.dataUrl, tr(`本局 PEAK 头像：${row.dataset.playerName}`, `Recorded PEAK portrait: ${row.dataset.playerName}`), panel);
    headerHead.src = rendered.dataUrl;
    headerHead.hidden = false;
    headerFallback.hidden = true;
    context.onPortrait?.(rendered.dataUrl);
    placeholder.hidden = true;
    panel.classList.remove("is-partial", "is-syncing");
    panel.classList.add("is-ready");
    badge.textContent = isLocalCurrent ? tr("本地当前 · 非历史", "Current local outfit · Not historical") : form.known ? form.label : tr("装扮头像 · 形态未知", "Outfit portrait · Form unknown");
    title.textContent = form.transformed ? form.label : appearance.outfitName || assets?.components.fit?.entry?.name || tr("本局游戏头像", "Portrait from this run");
    meta.textContent = [
      rendered.portraitScope === "whole-form-no-head" ? tr("此形态无头部 · 使用游戏原模型图标", "This form has no head · Showing the game model icon")
        : form.transformed ? tr("游戏原生变形头部", "Game transformation head") : form.known ? tr("原始头部、眼睛与嘴型", "Original head, eyes and mouth") : tr("装扮已记录；旧日志未记录途中变形", "Outfit recorded. This older log has no transformation history"),
      rendered.hatName,
    ].filter(Boolean).join(" · ");
  }).catch(() => {
    if (panel.dataset.avatarToken !== token) return;
    fallbackAppearancePreview(panel, avatar, placeholder, title, meta, badge, assets, appearance);
    if (isLocalCurrent) badge.textContent = tr("本地当前 · 非历史", "Current local outfit · Not historical");
  });
}

function updateCardLanguage(row) {
  if (row.dataset.uiLocale === getLocale()) return;
  row.dataset.uiLocale = getLocale();
  const name = row.dataset.playerName;
  row.querySelector(".player-head-image").alt = tr(`${name}的游戏头像`, `${name}’s game portrait`);
  row.querySelector(".player-identity").setAttribute("aria-label", tr(`展开 ${name} 的生命、体力与手持信息`, `Expand ${name}’s life, stamina and held item`));
  row.querySelector(".player-toggle").title = tr(`显示或隐藏 ${name}`, `Show or hide ${name}`);
  row.querySelector(".player-toggle input").setAttribute("aria-label", tr(`显示 ${name}`, `Show ${name}`));
  row.querySelector(".player-follow-button").title = tr(`跟随镜头 ${name}`, `Follow ${name}`);
  const labels = [
    [".player-status .loadout-heading strong", "身体状态", "Conditions"],
    [".player-loadout > .loadout-heading strong", "物品快照", "Inventory snapshot"],
    [".player-loadout > .loadout-heading small", "随时间线变化", "Follows the timeline"],
    [".backpack-heading strong", "背包内部", "Inside backpack"],
    [".player-details > summary", "玩家详情", "Player details"],
  ];
  for (const [selector, zh, en] of labels) row.querySelector(selector).textContent = tr(zh, en);
  for (const role of ["stamina", "extra"]) row.querySelector(`[data-role="${role}-value"]`).parentElement.querySelector(".vital-label").textContent = role === "extra" ? tr("额外", "Extra") : tr("体力", "Stamina");
}

export function updatePlayerCard(row, playerState, context = {}) {
  updateCardLanguage(row);
  const telemetry = playerState.telemetry;
  updateVital(row, playerState, "stamina");
  updateVital(row, playerState, "extra");
  updateConditions(row, playerState);
  const telemetryAuthority = row.querySelector('[data-role="telemetry-authority"]');
  telemetryAuthority.textContent = telemetry?.ready === false
    ? tr("体力：等待玩家同步", "Stamina: waiting for player sync")
    : telemetry?.captured
      ? `${tr("体力快照", "Stamina snapshot")}${telemetry.authority ? ` · ${telemetry.authority}` : ""}`
      : tr("体力：此日志未记录", "Stamina: not recorded in this log");
  updateHeld(row, playerState, context);
  updateInventory(row, playerState.inventory, context);
  updateAppearance(row, playerState, context);
}
