import { createHash } from "node:crypto";
import { validateMapAlignment } from "./map-alignment.mjs";

export const LIMITS = Object.freeze({ compressedBytes: 12 * 1024 * 1024, decodedBytes: 64 * 1024 * 1024,
  durationMs: 4 * 60 * 60 * 1000, players: 16, stages: 16, gapMs: 1500, uploads: 10_000,
  storedBytes: 2 * 1024 * 1024 * 1024, queryPoints: 200_000, heatCells: 250_000 });
const HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(["join", "leave", "dead", "revive", "break", "warp", "finish", "game-stage", "checkpoint"]);
const INTERRUPTIONS = new Set(["join", "leave", "dead", "revive", "break", "warp"]);
export function problem(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
export function digest(value) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
export function validHash(value) { return typeof value === "string" && HASH.test(value); }
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

// A separate whitelist format deliberately cannot carry the original replay's inventory,
// world objects, audio, textures or platform IDs. Reconstruct every accepted property.
export function validateTrajectory(raw) {
  object(raw, ["format", "recordingId", "runKey", "timeOriginMs", "startedUtc", "durationMs", "sampleHz", "coordinateUnit", "map", "difficulty", "players"],
    ["format", "recordingId", "startedUtc", "durationMs", "sampleHz", "coordinateUnit", "map", "difficulty", "players"], "trajectory");
  if (raw.format !== "trajectory-v1" || raw.sampleHz !== 10 || raw.coordinateUnit !== "cm") throw problem("unsupported trajectory format/rate/coordinates");
  if (!validHash(raw.recordingId)) throw problem("recordingId: SHA256 required");
  const result = { format: raw.format, recordingId: raw.recordingId,
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
  result.players = array(raw.players, LIMITS.players, "players", 1).map((player) => {
    object(player, ["key", "name", "owner", "evidence", "points", "events"], ["key", "name", "owner", "evidence", "points", "events"], "player");
    if (!validHash(player.key) || keys.has(player.key)) throw problem("player.key: unique SHA256 required"); keys.add(player.key);
    if (typeof player.owner !== "boolean" || !["native-state", "legacy-unknown"].includes(player.evidence)) throw problem("player owner/evidence invalid");
    let lastTime = -1, lastBucket = -1;
    const points = array(player.points, Math.floor(result.durationMs / 100) + 1, "points").map((point) => {
      if (!Array.isArray(point) || point.length !== 4) throw problem("point: [tMs,xCm,yCm,zCm] required");
      const t = integer(point[0], 0, result.durationMs, "point time"), bucket = Math.floor(t / 100);
      if (t <= lastTime || bucket === lastBucket) throw problem("points must be ordered and at most one per 100ms bucket");
      lastTime = t; lastBucket = bucket; totalPoints += 1;
      for (let index = 1; index < 4; index += 1) integer(point[index], -100_000_000, 100_000_000, "position cm");
      return point;
    });
    let eventTime = -1;
    const events = array(player.events, Math.min(100_000, Math.ceil(result.durationMs / 100) + 100), "events").map((event) => {
      object(event, ["tMs", "kind", "stageIndex"], ["tMs", "kind"], "event");
      const value = { tMs: integer(event.tMs, 0, result.durationMs, "event time"), kind: event.kind };
      if (!KINDS.has(event.kind) || value.tMs < eventTime) throw problem("events must be ordered with supported kind"); eventTime = value.tMs;
      if (Object.hasOwn(event, "stageIndex")) { value.stageIndex = integer(event.stageIndex, 0, LIMITS.stages - 1, "event stage"); if (!indices.has(value.stageIndex)) throw problem("event references absent stage"); }
      if (["game-stage", "checkpoint"].includes(value.kind) && value.stageIndex === undefined) throw problem("native stage event requires stageIndex");
      return value;
    });
    validateNativeStageEvents(events, result.map.stages, player.evidence);
    return { key: player.key, name: text(player.name, 100, "player.name", true), owner: player.owner, evidence: player.evidence, points, events };
  }).sort((a, b) => a.key.localeCompare(b.key));
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
  const intervals = []; let alive = true;
  for (let index = 0; index < player.events.length;) {
    const begin = index, time = player.events[index].tMs, aliveBefore = alive;
    let changed = null, checkpoint = null, disrupted = false;
    while (index < player.events.length && player.events[index].tMs === time) {
      const event = player.events[index++];
      if (["dead", "leave"].includes(event.kind)) alive = false;
      if (["revive", "join"].includes(event.kind)) alive = true;
      disrupted ||= INTERRUPTIONS.has(event.kind);
      if (event.kind === "game-stage") changed = event;
      if (event.kind === "checkpoint") checkpoint = event;
    }
    if (changed) {
      const previous = intervals.at(-1), completed = Boolean(previous && checkpoint && checkpoint.stageIndex === previous.stageIndex
        && changed.stageIndex === previous.stageIndex + 1 && trajectory.map.stages[changed.stageIndex]?.name !== "Void"
        && trajectory.map.stages[previous.stageIndex]?.name !== "Void" && alive && !disrupted);
      if (previous) { previous.end = time; previous.exitCheckpoint = completed; }
      intervals.push({ stageIndex: changed.stageIndex, start: time, end: trajectory.durationMs + 1,
        entryCheckpoint: completed, exitCheckpoint: false, aliveBeforeStart: aliveBefore, startEventIndex: begin });
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
  if (!intervals || player.evidence !== "native-state") return null;
  if (complete || intervals.some(interval => interval.stageIndex === stage.index && interval.exitCheckpoint)) return true;
  const final = trajectory.map.stages.filter(value => value.name !== "Void").at(-1);
  // Old final Win evidence is a finish, not a fictitious checkpoint to Void.
  if (stage.index === final?.index && player.events.some(event => event.kind === "finish" && event.stageIndex === stage.index)) return null;
  return false;
}
function extractNativeStageRoutes(trajectory, player, stage, intervals) {
  const routes = [];
  for (const interval of intervals.filter(value => value.stageIndex === stage.index)) {
    const { begin, end } = intervalIndices(player, interval);
    let start = -1, alive = interval.aliveBeforeStart, eventIndex = interval.startEventIndex, previous = null;
    for (let index = begin; index < end; index += 1) {
      const point = player.points[index]; let blocked = false;
      while (eventIndex < player.events.length && player.events[eventIndex].tMs <= point[0]) {
        const event = player.events[eventIndex++];
        if (["dead", "leave"].includes(event.kind)) { alive = false; start = -1; blocked = true; }
        if (["revive", "join"].includes(event.kind)) { alive = true; start = -1; blocked = true; }
        if (["break", "warp"].includes(event.kind)) { start = -1; blocked = true; }
        // Events before this interval establish state without invalidating its
        // first observation as though the old disruption happened on this tick.
        if (index === begin && event.tMs < point[0]) blocked = false;
      }
      if (previous && discontinuity(previous, point)) { start = -1; blocked = true; }
      if (alive && !blocked && start < 0) {
        const entry = index === begin && interval.entryCheckpoint && Math.abs(point[0] - interval.start) <= LIMITS.gapMs;
        const near = point[0] >= interval.start && Math.abs(point[3] - stage.enterZCm) <= 300 && point[3] < stage.exitZCm;
        const crossed = previous && previous[3] <= stage.enterZCm && point[3] >= stage.enterZCm && point[3] < stage.exitZCm;
        if (entry || near) start = index;
        else if (crossed) start = index - 1;
      }
      if (alive && !blocked && start >= 0 && point[3] >= stage.exitZCm && index > start) {
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
  if (player.evidence !== "native-state" || !Number.isFinite(stage.enterZCm) || !Number.isFinite(stage.exitZCm)) return { completion: "unknown", routes: [] };
  const intervals = nativeIntervals(trajectory, player);
  if (intervals) return extractNativeStageRoutes(trajectory, player, stage, intervals);
  const direction = Math.sign(stage.exitZCm - stage.enterZCm), enter = stage.enterZCm * direction, exit = stage.exitZCm * direction;
  const routes = []; let start = -1, alive = true, eventIndex = 0, previous = null, blocked = false;
  for (let index = 0; index < player.points.length; index += 1) {
    const point = player.points[index]; blocked = false;
    while (eventIndex < player.events.length && player.events[eventIndex].tMs <= point[0]) {
      const event = player.events[eventIndex++];
      if (["dead", "leave"].includes(event.kind)) { alive = false; start = -1; blocked = true; }
      if (["revive", "join"].includes(event.kind)) { alive = true; start = -1; blocked = true; }
      if (["break", "warp"].includes(event.kind)) { start = -1; blocked = true; }
    }
    const broken = previous && discontinuity(previous, point);
    if (broken) { start = -1; blocked = true; }
    if (alive && !blocked && start < 0) {
      const z = point[3] * direction;
      // A recording already far past the entrance cannot acquire a complete path.
      if (Math.abs(z - enter) <= 300 && z < exit) start = index;
      else if (previous && previous[3] * direction <= enter && z >= enter && z < exit) start = index - 1;
    }
    if (alive && !blocked && start >= 0 && point[3] * direction >= exit && index > start) {
      const points = player.points.slice(start, index + 1);
      if (points.length >= 2) routes.push({ points, startMs: points[0][0], endMs: point[0], breaks: [] });
      if (routes.length > 1024) throw problem("too many stage attempts");
      start = -1;
    }
    previous = point;
  }
  return { completion: routes.length ? "complete" : "partial", routes };
}

// A separate inspection view may show incomplete attempts. Keep every real
// position and interruption; it must never contribute to public route counts.
export function extractInspectionStage(trajectory, player, stage) {
  const intervals = nativeIntervals(trajectory, player), selected = new Set();
  if (intervals) for (const interval of intervals.filter(value => value.stageIndex === stage.index)) {
    const { begin, end } = intervalIndices(player, interval);
    for (let index = begin; index < end; index += 1) selected.add(index);
  }
  else if (!Number.isFinite(stage.enterZCm) || !Number.isFinite(stage.exitZCm)) throw problem("stage boundaries unavailable", 409);
  const points = [], breaks = new Set();
  let previousIndex = -1;
  for (let index = 0; index < player.points.length; index += 1) {
    const point = player.points[index];
    if (intervals ? !selected.has(index) : point[3] < stage.enterZCm - 300 || point[3] > stage.exitZCm + 300) continue;
    const previous = points.at(-1);
    if (previous && (index !== previousIndex + 1 || discontinuity(previous, point))) breaks.add(point[0]);
    points.push(point); previousIndex = index;
  }
  if (points.length) for (const event of player.events) {
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
