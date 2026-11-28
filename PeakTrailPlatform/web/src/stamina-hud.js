import { resolveUiAsset } from "./game-assets.js";
import { staminaLayout } from "./player-conditions.js";
import { tr } from "./i18n.js";
import { updateNativeStaminaCanvas } from "./stamina-canvas.js";

const views = new WeakMap();
const fallbackColors = { staminaBacking: "#1a444d", staminaFill: "#59c800", staminaOutline: "#dfdac2",
  extraStaminaFill: "#bfec1c", extraStaminaOutline: "#dfdac2", extraStaminaIcon: "#bfec1c" };
const color = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
  ? `rgba(${value.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(",")},${Math.max(0, Math.min(1, value[3]))})` : null;
const percent = value => `${Math.max(0, Math.min(1, value)) * 100}%`;
function node(tag, className) { const result = document.createElement(tag); result.className = className; return result; }

// Semantic/fallback meters remain readable while exact-build art is loading.
// Native art is rendered after slicing and shader evaluation in Canvas2D;
// using these sprites as raw CSS alpha masks does not reproduce Scouts/UI.
function surface(key) {
  const result = node("span", `game-stamina-surface game-stamina-${key}`);
  result.setAttribute("aria-hidden", "true");
  return result;
}

function paintSurface(element, pack, key) {
  const style = pack?.catalog?.uiStyle?.stamina?.images?.[key];
  element.style.setProperty("--native-tint", color(style?.color) || fallbackColors[key]);
}

function track(extra = false) {
  const root = node("div", "game-stamina-track");
  root.setAttribute("role", "meter"); root.setAttribute("aria-valuemin", "0"); root.setAttribute("aria-valuemax", "100");
  const backing = surface("backing"), content = node("span", "game-stamina-content");
  const fill = surface("fill"), blocked = node("span", "game-stamina-blocked"), blocks = node("span", "game-stamina-blocks");
  content.append(fill, blocked, blocks);
  const outline = surface("outline");
  root.append(backing, content, outline);
  return { root, backing, fill, blocked, blocks, outline, extra };
}

function build(root) {
  const main = track(), extra = track(true), extraRow = node("div", "game-stamina-extra");
  const lightning = node("i", "game-stamina-lightning"), pending = node("span", "game-stamina-pending");
  lightning.setAttribute("aria-hidden", "true");
  const canvas = node("canvas", "game-stamina-native");
  canvas.hidden = true; canvas.setAttribute("aria-hidden", "true");
  extraRow.append(lightning, extra.root); root.replaceChildren(main.root, extraRow, pending, canvas);
  const view = { main, extra, extraRow, lightning, pending, canvas, pack: undefined };
  views.set(root, view); return view;
}

function updateTrack(view, layout, status, pack) {
  const { root, fill, blocked, blocks, extra } = view;
  const label = extra ? tr("额外体力", "Extra stamina") : tr("体力", "Stamina");
  root.hidden = layout.ratio === null;
  root.setAttribute("aria-label", label);
  if (layout.ratio === null) { root.removeAttribute("aria-valuenow"); return; }
  const value = Math.round(layout.ratio * 100);
  root.setAttribute("aria-valuenow", String(value));
  root.setAttribute("aria-valuetext", `${layout.output} · ${layout.capText}`);
  root.title = `${label} ${layout.output} · ${layout.capText}`;
  fill.style.width = percent(layout.ratio);
  fill.hidden = layout.ratio === 0;
  blocked.style.width = percent(layout.blocked ?? 0);
  blocked.hidden = !(layout.blocked > 0);
  const signature = JSON.stringify([layout.blocks, pack?.catalogUrl?.href, tr("体力", "Stamina")]);
  if (blocks.dataset.signature === signature) return;
  blocks.dataset.signature = signature;
  blocks.replaceChildren(...layout.blocks.map(block => {
    const observed = status?.values?.find(entry => entry.type === block.type);
    const native = pack?.catalog?.uiStyle?.stamina?.conditions?.find(entry => block.type === "Petrify"
      ? entry.isPetrify : !entry.isPetrify && entry.id === observed?.id);
    const segment = node("span", "game-stamina-condition");
    segment.style.left = percent(block.left); segment.style.width = percent(block.width);
    segment.style.backgroundColor = color(native?.color) || block.color;
    segment.title = `${block.label} ${Math.round(block.width * 100)}%`;
    const art = native && resolveUiAsset(pack, native.uiKey);
    if (art && block.width >= .07) {
      const icon = node("i", "game-stamina-condition-icon");
      icon.style.setProperty("--native-icon", `url("${art.url}")`);
      segment.append(icon);
    }
    return segment;
  }));
}

export function updateStaminaHud(root, telemetry, status, pack = null) {
  if (!root) return;
  const view = views.get(root) || build(root);
  const main = staminaLayout(telemetry, status), extra = staminaLayout(telemetry, status, true);
  if (view.pack !== pack) {
    view.pack = pack;
    for (const bar of [view.main, view.extra]) {
      paintSurface(bar.backing, pack, "staminaBacking");
      paintSurface(bar.fill, pack, bar.extra ? "extraStaminaFill" : "staminaFill");
      paintSurface(bar.outline, pack, bar.extra ? "extraStaminaOutline" : "staminaOutline");
    }
    const icon = resolveUiAsset(pack, "extraStaminaIcon");
    view.lightning.hidden = !icon;
    view.lightning.style.setProperty("--native-icon", icon ? `url("${icon.url}")` : "none");
    view.lightning.style.color = color(pack?.catalog?.uiStyle?.stamina?.images?.extraStaminaIcon?.color) || fallbackColors.extraStaminaIcon;
  }
  updateTrack(view.main, main, status, pack); updateTrack(view.extra, extra, status, pack);
  const extraBlocked = extra.blocked > 0 || extra.blocks.length > 0;
  view.extraRow.hidden = extra.ratio === null || !(extra.ratio > 0 || extraBlocked);
  // Native extra stamina contracts to its remaining length; petrification keeps
  // the full-width capacity/blocked section visible. Do not renormalize to100%.
  view.extra.root.style.width = extraBlocked ? "100%" : `max(18px, ${percent(extra.ratio ?? 0)})`;
  view.extra.fill.style.width = extraBlocked ? percent(extra.ratio ?? 0) : "100%";
  const unavailable = main.ratio === null && view.extraRow.hidden;
  view.pending.hidden = !unavailable;
  view.pending.textContent = telemetry?.ready === false ? tr("体力同步中", "Stamina syncing") : tr("体力未记录", "Stamina not recorded");
  root.hidden = unavailable && !telemetry?.captured && telemetry?.ready !== false;
  updateNativeStaminaCanvas(view.canvas, pack, { main, extra, status }, rendered => root.classList.toggle("is-native-rendered", rendered));
}
