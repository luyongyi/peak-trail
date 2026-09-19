const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value) => typeof value === "string" ? value : null;

// UI legend colors, not extracted game textures. Values and identities always
// come from the snapshot; a name in an inventory is never a status observation.
const CONDITIONS = {
  Injury: ["受伤", "#dd726a"], Hunger: ["饥饿", "#dfb477"], Cold: ["寒冷", "#83cbe5"],
  Poison: ["中毒", "#9fc477"], Crab: ["螃蟹", "#e59c6f"], Curse: ["诅咒", "#b791dc"],
  Drowsy: ["昏睡", "#a1a4e0"], Weight: ["负重", "#9aada9"], Hot: ["炎热", "#e78358"],
  Thorns: ["荆棘", "#95aa6e"], Spores: ["孢子", "#cfbc73"], Web: ["蛛网", "#d4d8cd"],
  Arrow: ["箭伤", "#bb8475"], Petrify: ["石化", "#929aaa"], FlyTrap: ["捕蝇草", "#97b88a"],
};

// Descriptive UI labels; retain raw enum names in tooltips for verification.
const EFFECTS = {
  PoisonOverTime: "持续中毒", InfiniteStamina: "无限体力", FasterBoi: "加速", Exhausted: "精疲力竭",
  Glowing: "发光", ColdOverTime: "持续寒冷", Chaos: "混沌", AdjustStatus: "状态调整",
  ClearAllStatus: "清除状态", PreventPoisonHealing: "阻止中毒恢复", AddBonusStamina: "补充额外体力",
  DrowsyOverTime: "持续昏睡", AdjustStatusOverTime: "持续状态调整", Sunscreen: "防晒",
  BingBongShield: "Bing Bong 护盾", ZombieBite: "僵尸咬伤", Invincibility: "无敌", LowGravity: "低重力",
  Blind: "失明", Numb: "麻木", ClimbingChalk: "攀爬镁粉", NoHunger: "免饥饿", HealAll: "全体治疗",
  DoubleJumpAmulet: "二段跳护符", RadiateInfiniteStam: "无限体力光环", MassSuperJump: "群体超级跳跃",
};

export function effectPresentation(type) {
  return EFFECTS[type] || String(type || "未知效果");
}

export function conditionPresentation(type) {
  const [label, color] = CONDITIONS[type] || [String(type || "未知状态"), "#a7b4b6"];
  return { label, color };
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
    output: telemetry?.ready === false ? "同步中" : ratio === null ? "未记录" : `${Math.round(ratio * 100)}%`,
    capText: capacity === null ? "上限未知" : `上限 ${Math.round(capacity * 100)}%` };
}

export function conditionSummary(status) {
  if (!status?.captured) return "此日志未记录状态种类，不能从体力下降推测寒冷或诅咒。";
  if (status.ready !== true) return "状态同步未就绪，不把未收到的数据当作健康。";
  const active = (status.values || []).filter((entry) => entry.amount > 0 || entry.staminaBlock > 0 || entry.extraStaminaBlock > 0);
  if (active.length) return `${active.length} 项状态 · 按记录显示占用，不把受损上限当成满体力`;
  return status.complete ? "已记录：当前无状态占用" : "已记录部分无占用 · 状态快照不完整";
}

export function appearanceFormPresentation(appearance) {
  if (appearance?.formReady !== true || appearance.form === "unknown") return { known: false, transformed: false, label: "形态未记录" };
  const names = { normal: "普通形态", skeleton: "骷髅形态", mushroom: "蘑菇形态", chicken: "鸡形态" };
  return { known: Boolean(names[appearance.form]), transformed: appearance.form !== "normal", label: names[appearance.form] || "未知变形" };
}
