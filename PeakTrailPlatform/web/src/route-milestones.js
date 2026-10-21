import { tr } from "./i18n.js";

const KINDS = new Set(["game-stage", "checkpoint", "native-checkpoint", "summit", "nadir-ready", "nadir-entry", "nadir-wall", "nadir-chase", "nadir"]);
export function normalizeMilestones(value = [], stageIndex = null) {
  if (!Array.isArray(value) || value.length > 100000) throw new Error(tr("关键节点格式无效", "Invalid milestones"));
  return value.map(entry => {
    if (!entry || !KINDS.has(entry.kind) || !Number.isSafeInteger(entry.tMs) || entry.tMs < 0
      || entry.stageIndex !== undefined && (!Number.isInteger(entry.stageIndex) || entry.stageIndex < 0 || entry.stageIndex > 63)
      || stageIndex !== null && entry.stageIndex !== undefined && entry.stageIndex !== stageIndex
      || entry.positionCm !== undefined && (!Array.isArray(entry.positionCm) || entry.positionCm.length !== 3
        || entry.positionCm.some(v => !Number.isSafeInteger(v) || Math.abs(v) > 2_147_483_647))) {
      throw new Error(tr("关键节点时间、关卡或坐标无效", "Invalid milestone time, chapter, or coordinates"));
    }
    return { ...entry, ...(entry.positionCm ? { positionCm: [...entry.positionCm] } : {}) };
  }).sort((a, b) => a.tMs - b.tMs);
}

export function milestoneLabel(kind) {
  return ({
    "game-stage": tr("进入关卡", "Entered chapter"), checkpoint: tr("关卡完成", "Chapter completed"), "native-checkpoint": tr("关卡完成", "Chapter completed"),
    summit: tr("登顶", "Summit reached"), "nadir-ready": tr("天底物件已就绪", "Nadir items ready"),
    "nadir-entry": tr("进入天底", "Entered Nadir"), "nadir-wall": tr("天底屏障变化", "Nadir barrier changed"),
    "nadir-chase": tr("天底追逐变化", "Nadir chase changed"), nadir: tr("天底通关", "Nadir completed"),
  })[kind] || kind;
}

export function runOutcomeLabel(value) {
  return [value?.summitCompleted === true && tr("已登顶", "Summit reached"),
    value?.nadirCompleted === true && tr("天底已通关", "Nadir completed")].filter(Boolean).join(" · ");
}

export function milestoneText(milestone) {
  const seconds = Math.floor(milestone.tMs / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") + " · " + milestoneLabel(milestone.kind);
}
