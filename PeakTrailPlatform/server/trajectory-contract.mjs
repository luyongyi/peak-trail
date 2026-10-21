import { createHash } from "node:crypto";
import { validateMapAlignment } from "./map-alignment.mjs";
import { decodeTrajectoryPointRuns, MAX_EXPANDED_POINTS } from "./trajectory-point-runs.mjs";

export const LIMITS = Object.freeze({ compressedBytes: 12 * 1024 * 1024, decodedBytes: 64 * 1024 * 1024,
  durationMs: 4 * 60 * 60 * 1000, stages: 16, gapMs: 1500, uploads: 10_000,
  storedBytes: 2 * 1024 * 1024 * 1024, queryPoints: 200_000, heatCells: 250_000 });
const HASH = /^[a-f0-9]{64}$/;
const NADIR_KINDS = new Set(["nadir-ready", "nadir-entry", "nadir-wall", "nadir-chase", "nadir"]);
const MILESTONES = new Set(["game-stage", "checkpoint", "native-checkpoint", "summit", ...NADIR_KINDS]);
const KINDS = new Set(["join", "leave", "dead", "revive", "break", "warp", "finish", ...MILESTONES]);
const INTERRUPTIONS = new Set(["join", "leave", "dead", "revive", "break", "warp"]);
export function problem(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
export function digest(value) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
export function validHash(value) { return typeof value === "string" && HASH.test(value); }
export const ITEM_EVENT_LIMITS = Object.freeze({ perUpload: 4096, pageCount: 512, pageBytes: 512 * 1024, queryEvents: 100_000, queryBytes: 32 * 1024 * 1024 });
function object(value, keys, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw problem(`${label}: object required`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw problem(`${label}: unexpected field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw problem(`${label}: missing ${key}`);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw problem(`${label}: integer out of range`);
  return value;
}
function text(value, max, label, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.length) || /[\u0000-\u001f]/u.test(value)) throw problem(`${label}: invalid string`);
  return value;
}
function nullableBool(value, label) { if (value !== null && typeof value !== "boolean") throw problem(`${label}: boolean or null required`); return value; }
function array(value, max, label, min = 0) { if (!Array.isArray(value) || value.length < min || value.length > max) throw problem(`${label}: invalid array size`); return value; }

export function validateItemEvents(raw, { durationMs, map, players }) {
  const ids = new Set(), stages = new Set(map.stages.map(stage => stage.index)), members = new Set(players.map(player => player.key));
  return array(raw, ITEM_EVENT_LIMITS.perUpload, "itemEvents").map(event => {
    object(event, ["id", "actionId", "kind", "tMs", "stageIndex", "positionCm", "item", "playerKey"],
      ["id", "kind", "tMs", "stageIndex", "positionCm", "item"], "item event");
    if (!validHash(event.id) || ids.has(event.id)) throw problem("item event id: unique SHA256 required");
    ids.add(event.id);
    if (!["item-use", "item-spawn"].includes(event.kind)) throw problem("unsupported item event kind");
    const value = { id: event.id };
    if (Object.hasOwn(event, "actionId")) { if (!validHash(event.actionId)) throw problem("item actionId: SHA256 required"); value.actionId = event.actionId; }
    Object.assign(value, { kind: event.kind, tMs: integer(event.tMs, 0, durationMs, "item event time"),
      stageIndex: integer(event.stageIndex, 0, LIMITS.stages - 1, "item event stage") });
    if (!stages.has(value.stageIndex)) throw problem("item event references absent stage");
    value.positionCm = array(event.positionCm, 3, "item event position", 3).map(part => integer(part, -100_000_000, 100_000_000, "item event position cm"));
    object(event.item, ["itemId", "name", "prefabName"], [], "event item");
    const item = {};
    if (Object.hasOwn(event.item, "itemId")) item.itemId = integer(event.item.itemId, 0, 1_000_000, "event itemId");
    if (Object.hasOwn(event.item, "name")) item.name = text(event.item.name, 100, "event item name", true);
    if (Object.hasOwn(event.item, "prefabName")) item.prefabName = text(event.item.prefabName, 100, "event prefabName");
    if (item.itemId === undefined && !item.prefabName) throw problem("event item identity required");
    value.item = item;
    if (Object.hasOwn(event, "playerKey")) {
      if (!validHash(event.playerKey) || !members.has(event.playerKey)) throw problem("item event references absent player");
      value.playerKey = event.playerKey;
    }
    return value;
  }).sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id));
}

// A separate whitelist format deliberately cannot carry the original replay's inventory,
// world objects, audio, textures or platform IDs. Reconstruct every accepted property.
export function validateTrajectory(raw) {
  object(raw, ["format", "recordingId", "runKey", "timeOriginMs", "startedUtc", "durationMs", "sampleHz", "coordinateUnit", "map", "difficulty", "players", "itemEvents"],
    ["format", "recordingId", "startedUtc", "durationMs", "sampleHz", "coordinateUnit", "map", "difficulty", "players"], "trajectory");
  if (!["trajectory-v1", "trajectory-v2"].includes(raw.format) || raw.sampleHz !== 10 || raw.coordinateUnit !== "cm") throw problem("unsupported trajectory format/rate/coordinates");
  if (!validHash(raw.recordingId)) throw problem("recordingId: SHA256 required");
  // The canonical identity remains v1. Wire/storage compression cannot change
  // existing upload IDs, moderation, stage selection or heatmap semantics.
  const result = { format: "trajectory-v1", recordingId: raw.recordingId,
    startedUtc: text(raw.startedUtc, 40, "startedUtc"), durationMs: integer(raw.durationMs, 0, LIMITS.durationMs, "durationMs"), sampleHz: 10, coordinateUnit: "cm" };
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(result.startedUtc) || !Number.isFinite(Date.parse(result.startedUtc))) throw problem("startedUtc: UTC timestamp required");
  if (Object.hasOwn(raw, "runKey")) { if (!validHash(raw.runKey)) throw problem("runKey: SHA256 required"); result.runKey = raw.runKey; }
  if (Object.hasOwn(raw, "timeOriginMs")) result.timeOriginMs = integer(raw.timeOriginMs, -60_000, 7 * 24 * 60 * 60 * 1000, "timeOriginMs");
  object(raw.map, ["buildId", "scene", "levelIndex", "layoutKey", "route", "stages", "alignment"], ["buildId", "scene", "route", "stages"], "map");
  const buildId = text(String(raw.map.buildId), 24, "map.buildId");
  if (!/^[1-9]\d*$/.test(buildId)) throw problem("map.buildId: positive build required");
  const scene = text(raw.map.scene, 80, "map.scene");
  if (!/^Level_\d+$/.test(scene)) throw problem("map.scene: Level_N required");
  result.map = { buildId, scene };
  if (Object.hasOwn(raw.map, "levelIndex")) result.map.levelIndex = integer(raw.map.levelIndex, 0, 2147483647, "levelIndex");
  if (Object.hasOwn(raw.map, "layoutKey")) { if (!validHash(raw.map.layoutKey)) throw problem("layoutKey: SHA256 required"); result.map.layoutKey = raw.map.layoutKey; }
  result.map.route = array(raw.map.route, LIMITS.stages, "map.route", 1).map((name) => text(name, 80, "route name"));
  const indices = new Set();
  result.map.stages = array(raw.map.stages, LIMITS.stages, "map.stages", 1).map((stage) => {
    object(stage, ["index", "name", "enterZCm", "exitZCm"], ["index", "name"], "stage");
    const value = { index: integer(stage.index, 0, LIMITS.stages - 1, "stage.index"), name: text(stage.name, 80, "stage.name") };
    if (indices.has(value.index)) throw problem("duplicate stage index"); indices.add(value.index);
    for (const gate of ["enterZCm", "exitZCm"]) if (Object.hasOwn(stage, gate)) value[gate] = integer(stage[gate], -100_000_000, 100_000_000, gate);
    if ((value.enterZCm === undefined) !== (value.exitZCm === undefined) || (value.enterZCm !== undefined && value.exitZCm <= value.enterZCm)) throw problem("stage gates must be a positive complete pair");
    return value;
  }).sort((a, b) => a.index - b.index);
  if (result.map.stages.length !== result.map.route.length || result.map.stages.some((stage, index) => stage.index !== index || stage.name !== result.map.route[index])) throw problem("stages must match the ordered route");
  if (Object.hasOwn(raw.map, "alignment")) {
    result.map.alignment = validateMapAlignment(raw.map.alignment);
    if (result.map.alignment.landmarks.some(value => value.stageIndex !== undefined && !indices.has(value.stageIndex))) throw problem("landmark references absent stage");
    const points = new Map(result.map.alignment.landmarks.filter(value => value.kind === "progress-point").map(value => [value.key, value.positionCm]));
    const ordinary = result.map.stages.filter(stage => stage.name !== "Void");
    for (let i = 0; i < ordinary.length; i++) {
      const stage = ordinary[i];
      if (stage.enterZCm === undefined) continue;
      const entry = points.get(`progress-point:${stage.index}`), exit = points.get(i + 1 < ordinary.length ? `progress-point:${ordinary[i + 1].index}` : "progress-point:peak");
      if (!entry || !exit || entry[2] !== stage.enterZCm || exit[2] !== stage.exitZCm) throw problem("stage gates disagree with native landmarks");
    }
  }
  object(raw.difficulty, ["ascent", "custom", "mini"], ["ascent", "custom", "mini"], "difficulty");
  result.difficulty = { ascent: raw.difficulty.ascent === null ? null : integer(raw.difficulty.ascent, -100, 1000, "ascent"),
    custom: nullableBool(raw.difficulty.custom, "custom"), mini: nullableBool(raw.difficulty.mini, "mini") };
  const keys = new Set(); let totalPoints = 0;
  const expansionBudget = { points: 0, maxPoints: MAX_EXPANDED_POINTS };
  // Payload bytes and worker resources bound the request, not a vanilla lobby size.
  result.players = array(raw.players, Number.MAX_SAFE_INTEGER, "players", 1).map((player) => {
    object(player, ["key", "name", "owner", "evidence", "points", "events"], ["key", "name", "owner", "evidence", "points", "events"], "player");
    if (!validHash(player.key) || keys.has(player.key)) throw problem("player.key: unique SHA256 required"); keys.add(player.key);
    if (typeof player.owner !== "boolean" || !["native-state", "legacy-unknown"].includes(player.evidence)) throw problem("player owner/evidence invalid");
    let lastTime = -1, lastBucket = -1;
    const sourcePoints = raw.format === "trajectory-v2" ? decodeTrajectoryPointRuns(player.points,
      { durationMs: result.durationMs, maxPoints: Math.floor(result.durationMs / 100) + 1, budget: expansionBudget }) : player.points;
    const points = array(sourcePoints, Math.floor(result.durationMs / 100) + 1, "points").map((point) => {
      if (!Array.isArray(point) || point.length !== 4) throw problem("point: [tMs,xCm,yCm,zCm] required");
      const t = integer(point[0], 0, result.durationMs, "point time"), bucket = Math.floor(t / 100);
      if (t <= lastTime || bucket === lastBucket) throw problem("points must be ordered and at most one per 100ms bucket");
      lastTime = t; lastBucket = bucket; totalPoints += 1;
      for (let index = 1; index < 4; index += 1) integer(point[index], -100_000_000, 100_000_000, "position cm");
      return point;
    });
    let eventTime = -1;
    const events = array(player.events, Math.min(100_000, Math.ceil(result.durationMs / 100) + 100), "events").map((event) => {
      object(event, ["tMs", "kind", "stageIndex", "positionCm"], ["tMs", "kind"], "event");
      const value = { tMs: integer(event.tMs, 0, result.durationMs, "event time"), kind: event.kind };
      if (!KINDS.has(event.kind) || value.tMs < eventTime) throw problem("events must be ordered with supported kind"); eventTime = value.tMs;
      if (Object.hasOwn(event, "stageIndex")) { value.stageIndex = integer(event.stageIndex, 0, LIMITS.stages - 1, "event stage"); if (!indices.has(value.stageIndex)) throw problem("event references absent stage"); }
      if (Object.hasOwn(event, "positionCm")) {
        value.positionCm = array(event.positionCm, 3, "event position", 3).map(part => integer(part, -100_000_000, 100_000_000, "event position cm"));
      }
      if (NADIR_KINDS.has(value.kind) && (player.evidence !== "native-state" || value.stageIndex === undefined
        || (value.kind !== "nadir-ready" && result.map.stages[value.stageIndex]?.name !== "Void"))) throw problem("nadir event requires native stage evidence");
      if (value.kind === "native-checkpoint" && (player.evidence !== "native-state" || !player.owner
        || value.stageIndex === undefined || result.map.stages[value.stageIndex]?.name === "Void")) throw problem("native checkpoint requires local ordinary-stage evidence");
      if (["game-stage", "checkpoint"].includes(value.kind) && value.stageIndex === undefined) throw problem("native stage event requires stageIndex");
      if (value.kind === "summit" && (player.evidence !== "native-state"
        || value.stageIndex !== result.map.stages.filter(stage => stage.name !== "Void").at(-1)?.index)) {
        throw problem("summit requires native final-stage evidence");
      }
      return value;
    });
    validateNativeStageEvents(events, result.map.stages, player.evidence);
    return { key: player.key, name: text(player.name, 100, "player.name", true), owner: player.owner, evidence: player.evidence, points, events };
  }).sort((a, b) => a.key.localeCompare(b.key));
  // Absence stays absent: old canonical bytes and upload identities never change.
  if (Object.hasOwn(raw, "itemEvents")) result.itemEvents = validateItemEvents(raw.itemEvents, result);
  if (raw.format === "trajectory-v2" && Buffer.byteLength(JSON.stringify(result), "utf8") > LIMITS.decodedBytes)
    throw problem("point-run expanded trajectory byte limit exceeded", 413);
  return { trajectory: result, totalPoints };
}

function validateNativeStageEvents(events, stages, evidence) {
  const timeline = events.filter(event => event.kind === "game-stage"), transitions = new Set(), checkpoints = new Set();
  for (let i = 1; i < timeline.length; i += 1) {
    const previous = timeline[i-1], next = timeline[i];
    if (next.tMs <= previous.tMs || next.stageIndex === previous.stageIndex) throw problem("native stage changes must be strictly ordered and change stage");
    if (next.stageIndex === previous.stageIndex + 1 && stages[previous.stageIndex]?.name !== "Void" && stages[next.stageIndex]?.name !== "Void") {
      transitions.add(`${next.tMs}:${previous.stageIndex}`);
    }
  }
  for (const event of events.filter(value => value.kind === "checkpoint")) {
    const key = `${event.tMs}:${event.stageIndex}`;
    if (evidence !== "native-state" || !transitions.has(key) || checkpoints.has(key)) throw problem("checkpoint requires one matching adjacent native stage transition");
    checkpoints.add(key);
  }
}

export function difficultyInfo(raw) {
  const key = `a${raw.ascent ?? "unknown"}-c${raw.custom === null ? "unknown" : Number(raw.custom)}-m${raw.mini === null ? "unknown" : Number(raw.mini)}`;
  return { key, ...raw, label: `${raw.ascent === null ? "难度未知" : `Ascent ${raw.ascent}`}${raw.custom ? " · 自定义" : ""}${raw.mini ? " · Mini" : ""}` };
}

// `finish` in old exports also meant crossing a geometric exit. Only the new
// native win event proves a summit, and a ghost cannot finish on behalf of itself.
function applyLifeEvent(state, event) {
  if (event.kind === "dead") state.dead = true;
  if (event.kind === "revive") state.dead = false;
  if (event.kind === "leave") state.present = false;
  if (event.kind === "join") state.present = true;
}
function living(state) { return state.present && !state.dead; }
function nativeCheckpoints(player, stageIndex) {
  if (player.evidence !== "native-state" || !player.owner) return [];
  const life = { dead: false, present: true }, checkpoints = [];
  for (let index = 0; index < player.events.length;) {
    const time = player.events[index].tMs, matching = []; let interrupted = false;
    while (index < player.events.length && player.events[index].tMs === time) {
      const event = player.events[index++]; applyLifeEvent(life, event);
      interrupted ||= ["dead", "leave", "warp"].includes(event.kind);
      if (event.kind === "native-checkpoint" && event.stageIndex === stageIndex) matching.push(event);
    }
    if (living(life) && !interrupted) checkpoints.push(...matching);
  }
  return checkpoints;
}
function playerEndingCompleted(trajectory, player, kind, final) {
  if (player.evidence !== "native-state") return false;
  const life = { dead: false, present: true };
  for (let index = 0; index < player.events.length;) {
    const time = player.events[index].tMs; let summit = false, interrupted = false;
    while (index < player.events.length && player.events[index].tMs === time) {
      const event = player.events[index++];
      applyLifeEvent(life, event);
      if (["dead", "leave"].includes(event.kind)) interrupted = true;
      if (event.kind === kind && event.stageIndex === final) summit = true;
    }
    if (summit && living(life) && !interrupted) return true;
  }
  return false;
}
export function playerSummitCompleted(trajectory, player) {
  return playerEndingCompleted(trajectory, player, "summit", trajectory.map.stages.filter(stage => stage.name !== "Void").at(-1)?.index);
}
export function playerNadirCompleted(trajectory, player) {
  return playerEndingCompleted(trajectory, player, "nadir", trajectory.map.stages.find(stage => stage.name === "Void")?.index);
}
export function playerMilestones(player, stageIndex) {
  return player.events.filter(event => MILESTONES.has(event.kind) && event.stageIndex === stageIndex);
}
export function groupId(map) { return digest({ buildId: map.buildId, scene: map.scene, layoutKey: map.layoutKey ?? null, route: map.route, stages: map.stages,
  ...(map.alignment ? { alignment: map.alignment } : {}) }); }

function discontinuity(a, b) { const dt = b[0] - a[0]; return dt > LIMITS.gapMs || Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]) > Math.max(1500, dt * 5); }
function lowerEvent(events, time) {
  let low = 0, high = events.length;
  while (low < high) { const middle = (low + high) >>> 1; if (events[middle].tMs < time) low = middle + 1; else high = middle; }
  return low;
}
function disruptedBetween(player, start, end) {
  for (let index = lowerEvent(player.events, start); index < player.events.length && player.events[index].tMs <= end; index += 1) {
    const event = player.events[index]; if (event.tMs > start && INTERRUPTIONS.has(event.kind)) return true;
  }
  return false;
}
function nativeIntervals(trajectory, player) {
  const intervals = [], life = { dead: false, present: true };
  for (let index = 0; index < player.events.length;) {
    const begin = index, time = player.events[index].tMs, lifeBefore = { ...life };
    let changed = null, checkpoint = null, disrupted = false;
    while (index < player.events.length && player.events[index].tMs === time) {
      const event = player.events[index++];
      applyLifeEvent(life, event);
      disrupted ||= INTERRUPTIONS.has(event.kind);
      if (event.kind === "game-stage") changed = event;
      if (event.kind === "checkpoint") checkpoint = event;
    }
    if (changed) {
      const previous = intervals.at(-1), completed = Boolean(previous && checkpoint && checkpoint.stageIndex === previous.stageIndex
        && changed.stageIndex === previous.stageIndex + 1 && trajectory.map.stages[changed.stageIndex]?.name !== "Void"
        && trajectory.map.stages[previous.stageIndex]?.name !== "Void" && living(life) && !disrupted);
      if (previous) { previous.end = time; previous.exitCheckpoint = completed; }
      intervals.push({ stageIndex: changed.stageIndex, start: time, end: trajectory.durationMs + 1,
        entryCheckpoint: completed, exitCheckpoint: false, lifeBeforeStart: lifeBefore, startEventIndex: begin });
    }
  }
  const checkpointsByStage = new Map();
  for (let index = 0; index < intervals.length; index++) {
    const interval = intervals[index], next = intervals[index + 1];
    if (!next || trajectory.map.stages[interval.stageIndex]?.name === "Void"
      || next.stageIndex !== interval.stageIndex + 1 || trajectory.map.stages[next.stageIndex]?.name === "Void") continue;
    // The native local progress callback follows ShowTitleText by about 500 ms.
    // Retain its actual timestamp; do not forge a same-tick team checkpoint.
    if (!checkpointsByStage.has(interval.stageIndex)) checkpointsByStage.set(interval.stageIndex, nativeCheckpoints(player, interval.stageIndex));
    const candidates = checkpointsByStage.get(interval.stageIndex), through = Math.min(interval.end + LIMITS.gapMs, next.end - 1);
    let checkpoint = null;
    for (let at = lowerEvent(candidates, interval.start); at < candidates.length && candidates[at].tMs <= through; at++) {
      if (!disruptedBetween(player, Math.min(interval.end, candidates[at].tMs), candidates[at].tMs)) { checkpoint = candidates[at]; break; }
    }
    if (checkpoint) {
      interval.exitCheckpoint = true;
      if (next) next.entryCheckpoint = true;
    }
  }
  return intervals.length ? intervals : null;
}
function lowerPoint(points, time) {
  let low = 0, high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle][0] < time) low = middle + 1; else high = middle; }
  return low;
}
function intervalIndices(player, interval) {
  const first = lowerPoint(player.points, interval.start), after = lowerPoint(player.points, interval.end);
  let begin = first, end = after;
  // Keep the actual samples bracketing a native change between 10 Hz ticks.
  // No interpolation, teleported endpoint or skipped sampling interval is added.
  if (first > 0 && first < player.points.length && !discontinuity(player.points[first-1], player.points[first])
    && !disruptedBetween(player, player.points[first-1][0], player.points[first][0])) begin = first - 1;
  if (after > 0 && after < player.points.length && !discontinuity(player.points[after-1], player.points[after])
    && !disruptedBetween(player, player.points[after-1][0], player.points[after][0])) end = after + 1;
  return { begin, end };
}
function gameCompletion(trajectory, player, stage, intervals, complete) {
  if (stage.name === "Void" && playerNadirCompleted(trajectory, player)) return true;
  if (stage.name !== "Void" && nativeCheckpoints(player, stage.index).length) return true;
  const final = trajectory.map.stages.filter(value => value.name !== "Void").at(-1);
  if (stage.index === final?.index && playerSummitCompleted(trajectory, player)) return true;
  if (!intervals || player.evidence !== "native-state") return null;
  if (complete || intervals.some(interval => interval.stageIndex === stage.index && interval.exitCheckpoint)) return true;
  // Old final Win evidence is a finish, not a fictitious checkpoint to Void.
  if (stage.index === final?.index && player.events.some(event => event.kind === "finish" && event.stageIndex === stage.index)) return null;
  return false;
}
function extractNativeStageRoutes(trajectory, player, stage, intervals) {
  const routes = [];
  for (const interval of intervals.filter(value => value.stageIndex === stage.index)) {
    const { begin, end } = intervalIndices(player, interval);
    const life = { ...interval.lifeBeforeStart };
    let start = -1, eventIndex = interval.startEventIndex, previous = null;
    for (let index = begin; index < end; index += 1) {
      const point = player.points[index]; let blocked = false;
      while (eventIndex < player.events.length && player.events[eventIndex].tMs <= point[0]) {
        const event = player.events[eventIndex++];
        applyLifeEvent(life, event);
        if (["dead", "leave", "revive", "join"].includes(event.kind)) { start = -1; blocked = true; }
        if (["break", "warp"].includes(event.kind)) { start = -1; blocked = true; }
        // Events before this interval establish state without invalidating its
        // first observation as though the old disruption happened on this tick.
        if (index === begin && event.tMs < point[0]) blocked = false;
      }
      if (previous && discontinuity(previous, point)) { start = -1; blocked = true; }
      if (living(life) && !blocked && start < 0) {
        const entry = index === begin && interval.entryCheckpoint && Math.abs(point[0] - interval.start) <= LIMITS.gapMs;
        const near = point[0] >= interval.start && Math.abs(point[3] - stage.enterZCm) <= 300 && point[3] < stage.exitZCm;
        const crossed = previous && previous[3] <= stage.enterZCm && point[3] >= stage.enterZCm && point[3] < stage.exitZCm;
        if (entry || near) start = index;
        else if (crossed) start = index - 1;
      }
      if (living(life) && !blocked && start >= 0 && point[3] >= stage.exitZCm && index > start) {
        const points = player.points.slice(start, index+1);
        routes.push({ points, startMs: points[0][0], endMs: points.at(-1)[0], breaks: [] }); start = -1;
      }
      previous = point;
    }
    if (interval.exitCheckpoint && start >= 0 && end - start >= 2 && previous && Math.abs(previous[0] - interval.end) <= LIMITS.gapMs
      && !disruptedBetween(player, previous[0], interval.end)) {
      const points = player.points.slice(start, end);
      routes.push({ points, startMs: points[0][0], endMs: points.at(-1)[0], breaks: [] });
    }
    if (routes.length > 1024) throw problem("too many stage attempts");
  }
  return { completion: routes.length ? "complete" : "partial", routes };
}
export function extractStageRoutes(trajectory, player, stage) {
  if (stage.name === "Void" && player.evidence === "native-state") return extractNadirRoutes(trajectory, player, stage);
  if (player.evidence !== "native-state" || !Number.isFinite(stage.enterZCm) || !Number.isFinite(stage.exitZCm)) return { completion: "unknown", routes: [] };
  const intervals = nativeIntervals(trajectory, player);
  if (intervals) return extractNativeStageRoutes(trajectory, player, stage, intervals);
  const direction = Math.sign(stage.exitZCm - stage.enterZCm), enter = stage.enterZCm * direction, exit = stage.exitZCm * direction;
  const routes = [], life = { dead: false, present: true };
  let start = -1, eventIndex = 0, previous = null, blocked = false;
  for (let index = 0; index < player.points.length; index += 1) {
    const point = player.points[index]; blocked = false;
    while (eventIndex < player.events.length && player.events[eventIndex].tMs <= point[0]) {
      const event = player.events[eventIndex++];
      applyLifeEvent(life, event);
      if (["dead", "leave", "revive", "join"].includes(event.kind)) { start = -1; blocked = true; }
      if (["break", "warp"].includes(event.kind)) { start = -1; blocked = true; }
    }
    const broken = previous && discontinuity(previous, point);
    if (broken) { start = -1; blocked = true; }
    if (living(life) && !blocked && start < 0) {
      const z = point[3] * direction;
      // A recording already far past the entrance cannot acquire a complete path.
      if (Math.abs(z - enter) <= 300 && z < exit) start = index;
      else if (previous && previous[3] * direction <= enter && z >= enter && z < exit) start = index - 1;
    }
    if (living(life) && !blocked && start >= 0 && point[3] * direction >= exit && index > start) {
      const points = player.points.slice(start, index + 1);
      if (points.length >= 2) routes.push({ points, startMs: points[0][0], endMs: point[0], breaks: [] });
      if (routes.length > 1024) throw problem("too many stage attempts");
      start = -1;
    }
    previous = point;
  }
  return { completion: routes.length ? "complete" : "partial", routes };
}

// Void has no increasing Z gates. An observed native entry and a real individual
// Nadir win bound an attempt; missing ticks, death, leave or later warps keep it
// inspectable but never contribute a fabricated continuous heatmap route.
function extractNadirRoutes(trajectory, player, stage) {
  const intervals = nativeIntervals(trajectory, player), routes = [];
  if (!intervals) return { completion: "unknown", routes };
  const entries = player.events.filter(event => event.kind === "nadir-entry" && event.stageIndex === stage.index);
  const finishes = player.events.filter(event => event.kind === "nadir" && event.stageIndex === stage.index);
  const won = playerNadirCompleted(trajectory, player);
  for (const interval of intervals.filter(value => value.stageIndex === stage.index)) {
    const entry = entries[lowerEvent(entries, interval.start)], finish = entry && finishes[lowerEvent(finishes, entry.tMs)];
    if (!entry || entry.tMs >= interval.end || !finish || finish.tMs >= interval.end || !won || disruptedBetween(player, entry.tMs, finish.tMs)) continue;
    const first = lowerPoint(player.points, entry.tMs), after = lowerPoint(player.points, finish.tMs + 1);
    const points = player.points.slice(first, after);
    if (points.length < 2 || points[0][0] - entry.tMs > LIMITS.gapMs || finish.tMs - points.at(-1)[0] > LIMITS.gapMs
      || points.some((point, index) => index > 0 && discontinuity(points[index - 1], point))) continue;
    const life = { dead: false, present: true };
    for (const event of player.events) { if (event.tMs > entry.tMs) break; applyLifeEvent(life, event); }
    if (!living(life)) continue;
    routes.push({ points, startMs: points[0][0], endMs: points.at(-1)[0], breaks: [] });
  }
  return { completion: routes.length ? "complete" : "partial", routes };
}

// A separate inspection view may show incomplete attempts. Keep every real
// position and interruption; it must never contribute to public route counts.
export function extractInspectionStage(trajectory, player, stage, { includeInactive = false } = {}) {
  const intervals = nativeIntervals(trajectory, player), selected = new Set();
  if (intervals) for (const interval of intervals.filter(value => value.stageIndex === stage.index)) {
    const { begin, end } = intervalIndices(player, interval);
    for (let index = begin; index < end; index += 1) selected.add(index);
  }
  else if (!Number.isFinite(stage.enterZCm) || !Number.isFinite(stage.exitZCm)) throw problem("stage boundaries unavailable", 409);
  const points = [], breaks = new Set();
  const life = { dead: false, present: true };
  let previousIndex = -1, eventIndex = 0, observedLiving = false, livingSince = null;
  for (let index = 0; index < player.points.length; index += 1) {
    const point = player.points[index];
    let terminalDeath = false;
    while (eventIndex < player.events.length && player.events[eventIndex].tMs <= point[0]) {
      const event = player.events[eventIndex++];
      if (event.kind === "dead") terminalDeath ||= (observedLiving || livingSince !== null && livingSince < event.tMs)
        && living(life) && event.tMs > 0 && event.tMs === point[0];
      // A same-tick dead join is not a death endpoint. An earlier living join or
      // revival is evidence even when its sample was replaced in the 100 ms bucket.
      if (["dead", "leave", "join", "revive"].includes(event.kind)) observedLiving = false;
      applyLifeEvent(life, event);
      if (!living(life)) livingSince = null;
      else if (["join", "revive"].includes(event.kind)) livingSince = event.tMs;
    }
    if (living(life)) observedLiving = true;
    if (!includeInactive && !living(life) && !terminalDeath) continue;
    if (intervals ? !selected.has(index) : point[3] < stage.enterZCm - 300 || point[3] > stage.exitZCm + 300) continue;
    const previous = points.at(-1);
    if (previous && (index !== previousIndex + 1 || discontinuity(previous, point))) breaks.add(point[0]);
    points.push(point); previousIndex = index;
  }
  const terminalDeaths = new Set(), warpTimes = new Set();
  if (!includeInactive && points.length) for (const event of player.events) {
    if (event.kind === "dead" && points[lowerPoint(points, event.tMs)]?.[0] === event.tMs) terminalDeaths.add(event.tMs);
    if (event.kind === "warp") warpTimes.add(event.tMs);
  }
  if (points.length) for (const event of player.events) {
    // The terminal death sample belongs to the preceding living segment. A
    // revive/join (or the removed ghost samples) breaks the next living segment.
    // Preserve the old break shape only when auditing version 1 stored metadata.
    if (!includeInactive && ["dead", "break"].includes(event.kind) && terminalDeaths.has(event.tMs) && !warpTimes.has(event.tMs)) continue;
    if (INTERRUPTIONS.has(event.kind) && event.tMs >= points[0][0] && event.tMs <= points.at(-1)[0]) breaks.add(event.tMs);
  }
  const completion = extractStageRoutes(trajectory, player, stage).completion;
  return { points, breaks: [...breaks].sort((a, b) => a - b), completion,
    gameCompleted: gameCompletion(trajectory, player, stage, intervals, completion === "complete") };
}

export function routeDedupeKey(trajectory, playerKey, stageIndex, startMs, endMs) {
  // A shared run without a shared clock is insufficient to compare separate recordings.
  const shared = trajectory.runKey && trajectory.timeOriginMs !== undefined;
  return { scope: shared ? trajectory.runKey : `recording:${trajectory.recordingId}`,
    playerKey, stageIndex, startMs: startMs + (shared ? trajectory.timeOriginMs : 0), endMs: endMs + (shared ? trajectory.timeOriginMs : 0) };
}
export function dedupeRoutes(routes) {
  const selected = [], buckets = new Map();
  for (const route of [...routes].sort((a, b) => Number(b.owner) - Number(a.owner)
    || Number(b.nativeProgress === true) - Number(a.nativeProgress === true) || b.pointCount - a.pointCount || a.id.localeCompare(b.id))) {
    const key = route.dedupe;
    const bucketKey = JSON.stringify([key.scope, key.playerKey, key.stageIndex]);
    const bucket = buckets.get(bucketKey) ?? [];
    const duplicate = bucket.some((other) => {
      const k = other.dedupe;
      if (k.scope !== key.scope || k.playerKey !== key.playerKey || k.stageIndex !== key.stageIndex) return false;
      const overlap = Math.min(k.endMs, key.endMs) - Math.max(k.startMs, key.startMs);
      return overlap >= 0.8 * Math.max(1, Math.min(k.endMs - k.startMs, key.endMs - key.startMs));
    });
    if (!duplicate) { selected.push(route); bucket.push(route); buckets.set(bucketKey, bucket); }
  }
  return selected;
}

export function aggregateHeatmap(routePoints, cellSizeCm = 200, heightBandCm = 200) {
  const counts = new Map();
  for (const points of routePoints) {
    const visited = new Set();
    const visit = (x, y, z) => {
      const key = `${Math.floor(x / cellSizeCm)},${Math.floor(y / heightBandCm)},${Math.floor(z / cellSizeCm)}`;
      visited.add(key);
      if (visited.size > LIMITS.heatCells) throw problem("heatmap cell limit exceeded", 413);
    };
    for (let index = 0; index < points.length; index += 1) {
      const p = points[index]; visit(p[1], p[2], p[3]);
      if (!index || discontinuity(points[index - 1], p)) continue;
      const a = points[index - 1], steps = Math.ceil(Math.max(Math.abs(p[1] - a[1]) / cellSizeCm, Math.abs(p[2] - a[2]) / heightBandCm, Math.abs(p[3] - a[3]) / cellSizeCm) * 2);
      for (let s = 1; s < steps; s += 1) { const t = s / steps; visit(a[1] + (p[1] - a[1]) * t, a[2] + (p[2] - a[2]) * t, a[3] + (p[3] - a[3]) * t); }
    }
    for (const key of visited) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.size > LIMITS.heatCells) throw problem("heatmap cell limit exceeded", 413);
  }
  return [...counts].map(([key, count]) => [...key.split(",").map(Number), count]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}
