import { gameItemName, tr } from "./i18n.js";

const HASH = /^[a-f0-9]{64}$/;
export const MAX_ITEM_EVENTS = 1024;
export const MAX_ITEM_MARKERS = 512;
const point = value => Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(n) && Math.abs(n) <= 1_000_000);
const text = value => typeof value === "string" && value.length <= 160 && !/[\u0000-\u001f]/u.test(value);

/** Only explicit use/spawn observations enter this layer. Inventory differences
 * and old generic item events cannot manufacture a use or a generated object. */
export function normalizeItemEvent(value, { live = false } = {}) {
  const kind = String(live ? value?.type : value?.kind).replaceAll("_", "-");
  if (!["item-use", "item-spawn"].includes(kind) || !HASH.test(value?.id || "")) return null;
  const tMs = live ? Math.round(value.t * 1000) : value.tMs;
  const stageIndex = live ? value.activeSegment : value.stageIndex;
  const pos = live ? value.pos : Array.isArray(value.positionCm) ? value.positionCm.map(n => n / 100) : null;
  const playerKey = live ? value.playerId : value.playerKey;
  if (!Number.isSafeInteger(tMs) || tMs < 0 || !point(pos)
    || !live && (!Array.isArray(value.positionCm) || !value.positionCm.every(Number.isSafeInteger))
    || stageIndex != null && (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex > 63)
    || !live && stageIndex == null
    || value.actionId != null && !HASH.test(value.actionId)
    || playerKey != null && !(live ? /^p\d{1,3}$/ : HASH).test(playerKey)
    || value.playerName != null && !text(value.playerName)) return null;
  const raw = value.item;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = {};
  if (raw.itemId != null) {
    if (!(Number.isSafeInteger(raw.itemId) && raw.itemId >= 0 || text(raw.itemId))) return null;
    item.itemId = raw.itemId;
  }
  for (const key of ["name", "prefabName"]) if (raw[key] != null) {
    if (!text(raw[key])) return null;
    item[key] = raw[key];
  }
  return { id: value.id, actionId: value.actionId || null, kind, tMs, stageIndex: stageIndex ?? null,
    pos: [...pos], item, playerKey: playerKey || null, playerName: playerKey ? value.playerName || null : null };
}

export function retainLiveItemEvents(trace) {
  const events = new Map((trace.itemEvents || []).map(event => [event.id, event]));
  for (const raw of trace.events || []) {
    const event = normalizeItemEvent(raw, { live: true });
    if (event && !events.has(event.id)) events.set(event.id, event);
  }
  const ordered = [...events.values()].sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id));
  trace.itemEventsTruncated ||= ordered.length > MAX_ITEM_EVENTS;
  trace.itemEvents = ordered.slice(-MAX_ITEM_EVENTS);
}

export function itemEventName(event) {
  return gameItemName(event.item.name || event.item.prefabName || (event.item.itemId != null ? `#${event.item.itemId}` : tr("未知道具", "Unknown item")));
}
export function itemEventKind(event) { return event.kind === "item-spawn" ? tr("生成点", "Spawn point") : tr("使用点", "Use point"); }
export function itemEventTime(event) {
  const seconds = Math.floor(event.tMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function relatedUseEvent(events, event) {
  if (!event?.actionId || event.kind !== "item-spawn") return null;
  return events.filter(value => value.kind === "item-use" && value.actionId === event.actionId
    && value.stageIndex === event.stageIndex && value.tMs <= event.tMs
    && (!event.playerKey || !value.playerKey || event.playerKey === value.playerKey))
    .sort((a, b) => b.tMs - a.tMs)[0] || null;
}

export function visibleItemEvents(events, { stageIndex = null, timeMs = Infinity, visiblePlayers = null } = {}) {
  const scoped = events.filter(event => (stageIndex === null || event.stageIndex === stageIndex) && event.tMs <= timeMs
    && (!visiblePlayers || !event.playerKey || visiblePlayers.has(event.playerKey)));
  const ordered = [...scoped].sort((a, b) => b.tMs - a.tMs || a.id.localeCompare(b.id));
  const spawned = new Set(ordered.filter(event => event.kind === "item-spawn" && event.actionId).map(event => event.actionId));
  // Keep use-only observations sparse. A paired use is revealed on selection.
  const uses = ordered.filter(event => event.kind === "item-use" && (!event.actionId || !spawned.has(event.actionId))).slice(0, 32);
  return [...ordered.filter(event => event.kind === "item-spawn").slice(0, MAX_ITEM_MARKERS - uses.length), ...uses];
}

const invalid = () => new Error(tr("道具事件与当前队伍、地图或版本不一致，请刷新。", "Item events do not match this team, map, or revision. Please refresh."));
export async function loadTeamItemEvents(context, { fetchImpl = (...args) => globalThis.fetch(...args), signal } = {}) {
  const { teamId, groupId, stageIndex, mapPackId, alignmentId, teamRevision } = context;
  if (![teamId, groupId, alignmentId, teamRevision].every(value => HASH.test(value || "")) || !Number.isInteger(stageIndex)) throw invalid();
  const events = [], ids = new Set(), cursors = new Set();
  let cursor = null;
  do {
    const response = await fetchImpl(`/api/route-teams/${teamId}/stages/${stageIndex}/item-events${cursor ? `?cursor=${cursor}` : ""}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(tr("道具事件暂时无法读取。", "Item events are temporarily unavailable."));
    if (Number(response.headers?.get("content-length")) > 600_000) throw invalid();
    const content = await response.text();
    if (content.length > 600_000) throw invalid();
    const body = JSON.parse(content);
    if (body.teamId !== teamId || body.groupId !== groupId || body.stageIndex !== stageIndex || body.teamRevision !== teamRevision
      || body.mapPackId !== mapPackId || body.mapCompatibility !== "matched" || body.mapAlignment?.status !== "verified"
      || body.mapAlignment.id !== alignmentId || body.coordinateSpace !== "canonical-map-world-cm"
      || !Array.isArray(body.events) || body.events.length > 512 || body.truncated !== false) throw invalid();
    let previousId = cursor;
    for (const raw of body.events) {
      const event = normalizeItemEvent(raw);
      if (!event || event.stageIndex !== stageIndex || ids.has(event.id) || previousId && event.id <= previousId) throw invalid();
      events.push(event); ids.add(event.id); previousId = event.id;
    }
    cursor = body.nextCursor ?? null;
    if (cursor !== null && (!HASH.test(cursor) || cursors.has(cursor) || cursor !== events.at(-1)?.id)) throw invalid();
    if (cursor) cursors.add(cursor);
    if (events.length >= MAX_ITEM_EVENTS) return { events: events.slice(0, MAX_ITEM_EVENTS), truncated: Boolean(cursor) || events.length > MAX_ITEM_EVENTS };
  } while (cursor);
  return { events, truncated: false };
}
