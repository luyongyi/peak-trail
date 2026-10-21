import { tr } from "./i18n.js";
import { observedAppearanceVisuals } from "./appearance-visuals.js";
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value) => typeof value === "string" ? value : null;

// UI legend colors, not extracted game textures. Values and identities always
// come from the snapshot; a name in an inventory is never a status observation.
const CONDITIONS = {
  Injury: ["受伤", "#dd726a", "Injury"], Hunger: ["饥饿", "#dfb477", "Hunger"], Cold: ["寒冷", "#83cbe5", "Cold"],
  Poison: ["中毒", "#9fc477", "Poison"], Crab: ["螃蟹", "#e59c6f", "Crab"], Curse: ["诅咒", "#b791dc", "Curse"],
  Drowsy: ["昏睡", "#a1a4e0", "Drowsiness"], Weight: ["负重", "#9aada9", "Weight"], Hot: ["炎热", "#e78358", "Heat"],
  Thorns: ["荆棘", "#95aa6e", "Thorns"], Spores: ["孢子", "#cfbc73", "Spores"], Web: ["蛛网", "#d4d8cd", "Web"],
  Arrow: ["箭伤", "#bb8475", "Arrow wound"], Petrify: ["石化", "#929aaa", "Petrification"], FlyTrap: ["捕蝇草", "#97b88a", "Flytrap"],
};

// Descriptive UI labels; retain raw enum names in tooltips for verification.
const EFFECTS = {
  PoisonOverTime: ["持续中毒", "Poison over time"], InfiniteStamina: ["无限体力", "Infinite stamina"], FasterBoi: ["加速", "Speed boost"], Exhausted: ["精疲力竭", "Exhausted"],
  Glowing: ["发光", "Glowing"], ColdOverTime: ["持续寒冷", "Cold over time"], Chaos: ["混沌", "Chaos"], AdjustStatus: ["状态调整", "Status adjustment"],
  ClearAllStatus: ["清除状态", "Clear conditions"], PreventPoisonHealing: ["阻止中毒恢复", "Poison healing blocked"], AddBonusStamina: ["补充额外体力", "Bonus stamina"],
  DrowsyOverTime: ["持续昏睡", "Drowsiness over time"], AdjustStatusOverTime: ["持续状态调整", "Status adjustment over time"], Sunscreen: ["防晒", "Sunscreen"],
  BingBongShield: ["Bing Bong 护盾", "Bing Bong shield"], ZombieBite: ["僵尸咬伤", "Zombie bite"], Invincibility: ["无敌", "Invincibility"], LowGravity: ["低重力", "Low gravity"],
  Blind: ["失明", "Blindness"], Numb: ["麻木", "Numbness"], ClimbingChalk: ["攀爬镁粉", "Climbing chalk"], NoHunger: ["免饥饿", "No hunger"], HealAll: ["全体治疗", "Heal everyone"],
  DoubleJumpAmulet: ["二段跳护符", "Double jump amulet"], RadiateInfiniteStam: ["无限体力光环", "Infinite stamina aura"], MassSuperJump: ["群体超级跳跃", "Group super jump"],
};

export function effectPresentation(type) {
  return EFFECTS[type] ? tr(...EFFECTS[type]) : String(type || tr("未知效果", "Unknown effect"));
}

export function conditionPresentation(type) {
  const [zh, color, en] = CONDITIONS[type] || [String(type || tr("未知状态", "Unknown condition")), "#a7b4b6", String(type || tr("未知状态", "Unknown condition"))];
  return { label: tr(zh, en), color };
}

export function normalizePlayerStatus(record) {
  const raw = record?.status;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ready = typeof raw.ready === "boolean" ? raw.ready : null;
  const result = { captured: true, ready, authority: text(raw.authority), source: text(raw.source),
    complete: ready === true && raw.complete === true, dead: typeof raw.dead === "boolean" ? raw.dead : null,
    statusSum: null, baseMaxStamina: null, maxStamina: null, baseMaxExtraStamina: null, maxExtraStamina: null,
    effectsReady: typeof raw.effectsReady === "boolean" ? raw.effectsReady : null,
    effectsAuthority: text(raw.effectsAuthority), values: [], effects: [] };
  if (ready === true) {
    for (const key of ["statusSum", "baseMaxStamina", "maxStamina", "baseMaxExtraStamina", "maxExtraStamina"]) result[key] = number(raw[key]);
    const seen = new Set();
    if (!Array.isArray(raw.values)) result.complete = false;
    for (const value of Array.isArray(raw.values) ? raw.values : []) {
      const amount = number(value?.amount), staminaBlock = number(value?.staminaBlock), extraStaminaBlock = number(value?.extraStaminaBlock);
      if (!value || typeof value.type !== "string" || !value.type || seen.has(value.type)
          || !Number.isInteger(value.id) || value.id < 0 || amount === null || staminaBlock === null || extraStaminaBlock === null) {
        result.complete = false; continue;
      }
      seen.add(value.type);
      result.values.push({ id: value.id, type: value.type, amount, staminaBlock, extraStaminaBlock });
    }
  }
  if (result.effectsReady === true) {
    for (const effect of Array.isArray(raw.effects) ? raw.effects : []) {
      if (!effect || typeof effect.type !== "string" || !effect.type) continue;
      result.effects.push({ type: effect.type, typeId: Number.isInteger(effect.typeId) ? effect.typeId : null });
    }
  }
  return result;
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Percentages are relative to full capacity, NOT the damaged remaining cap. */
export function staminaLayout(telemetry, status, extra = false) {
  const valueKey = extra ? "extraStamina" : "stamina";
  const maxKey = extra ? "maxExtraStamina" : "maxStamina";
  const baseKey = extra ? "baseMaxExtraStamina" : "baseMaxStamina";
  const blockKey = extra ? "extraStaminaBlock" : "staminaBlock";
  const rawValue = number(telemetry?.[valueKey]);
  // The normal status array arrives independently from CharacterSyncer, whose
  // stamina packet already includes petrification / the extra-capacity limit.
  const capacityUnknown = !extra && telemetry?.capacityReady === false;
  const rawCap = capacityUnknown ? null : number(telemetry?.[maxKey]);
  const ready = telemetry?.ready !== false;
  const explicitBase = number(telemetry?.[baseKey]) ?? (status?.ready === true ? number(status[baseKey]) : null);
  // PEAK's legacy recorder also wrote absolute 0..1 capacity units. Keep those
  // limits visible, while never inventing WHICH conditions consumed them.
  const base = explicitBase > 0 ? explicitBase : rawCap !== null && rawCap <= 1 ? 1
    : rawCap > 0 ? rawCap : rawValue !== null && rawValue <= 1 ? 1 : null;
  const cap = capacityUnknown ? null : rawCap ?? (status?.ready === true ? number(status[maxKey]) : null);
  const normalized = number(telemetry?.[extra ? "extraStamina01" : "stamina01"]);
  const value = ready && base > 0 ? (rawValue ?? (normalized !== null && cap !== null ? normalized * cap : null)) : null;
  const ratio = value !== null ? clamp01(value / base) : ready && normalized !== null ? clamp01(normalized) : null;
  const capacity = base > 0 && cap !== null ? clamp01(cap / base) : null;
  const blocks = [];
  let cursor = 1;
  if (!capacityUnknown && status?.ready === true && base > 0) {
    for (const entry of status.values || []) {
      if (!(entry[blockKey] > 0)) continue;
      // Saturation affects display only; raw amounts remain in the chip/tooltip.
      const width = Math.min(cursor, entry[blockKey] / base);
      cursor -= width;
      if (width > 0) blocks.push({ type: entry.type, left: cursor, width, ...conditionPresentation(entry.type) });
    }
  }
  return { value, cap, base, ratio, capacity, blocked: capacity !== null ? 1 - capacity : null, blocks,
    output: telemetry?.ready === false ? tr("同步中", "Syncing") : ratio === null ? tr("未记录", "Not recorded") : `${Math.round(ratio * 100)}%`,
    capText: capacity === null ? tr("上限未知", "Cap unknown") : tr(`上限 ${Math.round(capacity * 100)}%`, `Cap ${Math.round(capacity * 100)}%`) };
}

export function conditionSummary(status) {
  if (!status?.captured) return tr("此日志未记录状态种类，不能从体力下降推测寒冷或诅咒。", "Conditions were not recorded. A stamina decrease cannot identify cold or curses.");
  if (status.ready !== true) return tr("状态同步未就绪，不把未收到的数据当作健康。", "Conditions have not synced. Missing data does not mean healthy.");
  const active = (status.values || []).filter((entry) => entry.amount > 0 || entry.staminaBlock > 0 || entry.extraStaminaBlock > 0);
  if (active.length) return tr(`${active.length} 项状态 · 按记录显示占用，不把受损上限当成满体力`, `${active.length} conditions · Recorded blocks are shown relative to full stamina capacity`);
  return status.complete ? tr("已记录：当前无状态占用", "Recorded: no active capacity blocks") : tr("已记录部分无占用 · 状态快照不完整", "No blocks in the recorded part \u00b7 Condition snapshot incomplete");
}

export function appearanceFormPresentation(appearance) {
  if (appearance?.formReady !== true || appearance.form === "unknown") return { known: false, transformed: false, label: tr("形态未记录", "Form not recorded") };
  const names = { normal: tr("普通形态", "Normal form"), skeleton: tr("骷髅形态", "Skeleton form"), mushroom: tr("蘑菇形态", "Mushroom form"), chicken: tr("鸡形态", "Chicken form"), ghost: tr("幽灵形态", "Ghost form") };
  if (appearance.form === "ghost" && !observedAppearanceVisuals(appearance).ghost.active) return { known: false, transformed: false, label: tr("幽灵状态未确认", "Ghost state unconfirmed") };
  return { known: Boolean(names[appearance.form]), transformed: appearance.form !== "normal", label: names[appearance.form] || tr("未知变形", "Unknown transformation") };
}

export function appearanceVisualPresentation(appearance) {
  const observed = observedAppearanceVisuals(appearance), labels = [];
  if (observed.ghost.active) {
    labels.push({ state: "ghost", label: tr("幽灵", "Ghost"), detail: appearance.ghostVisible === false
      ? tr("游戏录制视角隐藏此幽灵；观战仍显示实际实体", "Hidden in the recorder's game view; the observed ghost is shown to spectators")
      : tr("实际所属幽灵实体", "Observed owner-matched ghost") });
    return labels; // Living character overlays do not belong to PlayerGhost.
  }
  if (observed.petrification.active) {
    const progress = Number.isFinite(appearance.petrificationProgress) ? Math.round(appearance.petrificationProgress * 100) : null;
    labels.push({ state: "petrification", label: tr("石化", "Petrification") + (progress === null ? "" : ` ${progress}%`),
      detail: tr("原生石化层已启用；按记录进度显示静态材质近似", "Native stone layer active; a static material approximation follows the recorded progress") });
  } else if (appearance?.petrificationReady === false) labels.push({ state: "unknown", label: tr("石化画面未确认", "Petrification visual unknown") });
  if (observed.blindness.active) labels.push({ state: "blindness", label: tr("失明", "Blindness"), detail: tr("原生失明面罩已启用", "Native blindness card active") });
  else if (appearance?.blindnessReady === false) labels.push({ state: "unknown", label: tr("失明画面未确认", "Blindness visual unknown") });
  return labels;
}
