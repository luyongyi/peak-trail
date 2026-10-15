import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { LIMITS, digest, validHash, validateTrajectory, groupId, difficultyInfo, problem, routeDedupeKey, extractInspectionStage } from "./trajectory-contract.mjs";
import { encodePointRuns, decodeTrajectoryPointRuns, MAX_EXPANDED_POINTS } from "./trajectory-point-runs.mjs";
import { createPointPackCache, readPointContext, readPackedPointBytes, planPointPacks, writePointPacks } from "./trajectory-point-packs.mjs";

const WINDOW_MS = 60_000;
const STORAGE_FORMAT = "trajectory-storage-v2";
const INSPECTION_METADATA_BYTES = 4 * 1024 * 1024;
function clock(trajectory) {
  const shared = validHash(trajectory.runKey) && Number.isSafeInteger(trajectory.timeOriginMs);
  return { origin: shared ? trajectory.timeOriginMs : 0,
    scope: shared ? trajectory.runKey : `recording:${trajectory.recordingId}` };
}
function playerContext(trajectory, player) {
  return digest({ groupId: groupId(trajectory.map), difficulty: difficultyInfo(trajectory.difficulty).key,
    scope: clock(trajectory).scope, playerKey: player.key });
}
function keys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
async function boundedGzip(path, blockFile = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > (blockFile ? 128 * 1024 : LIMITS.compressedBytes)) throw problem("stored trajectory file exceeds capacity", 503);
  const bytes = await readFile(path);
  return JSON.parse(gunzipSync(bytes, { maxOutputLength: blockFile ? 256 * 1024 : LIMITS.decodedBytes }).toString("utf8"));
}
async function readPointBlock(root, hash, context, window, allowDelta = true, packCache) {
  if (!validHash(hash)) throw problem("invalid trajectory block reference", 503);
  const packed = await readPackedPointBytes(root, hash, context, window, packCache);
  const block = packed ? JSON.parse(gunzipSync(packed, { maxOutputLength: 256 * 1024 }).toString("utf8"))
    : await boundedGzip(join(root, "point-blocks", `${hash}.json.gz`), true);
  if (block.context !== context || block.window !== window) throw problem("stored trajectory block identity mismatch", 503);
  let encoded = block.points;
  if (block.version === 2) {
    if (!allowDelta || !keys(block, ["version", "context", "window", "baseHash", "pointCount", "xorData"])
      || !validHash(block.baseHash) || block.baseHash === hash || !Number.isSafeInteger(block.pointCount)
      || block.pointCount < 1 || block.pointCount > 601 || typeof block.xorData !== "string"
      || block.xorData.length > 13_000) throw problem("invalid trajectory delta block", 503);
    const base = await readPointBlock(root, block.baseHash, context, window, false, packCache), xor = Buffer.from(block.xorData, "base64");
    if (base.length !== block.pointCount || xor.byteLength !== base.length * 16 || xor.toString("base64") !== block.xorData) throw problem("trajectory delta length mismatch", 503);
    encoded = base.map((point, index) => point.map((value, axis) => value ^ xor.readInt32LE(index * 16 + axis * 4)));
  } else if (block.version !== 1 || !keys(block, ["version", "context", "window", "points"])) throw problem("invalid trajectory point block", 503);
  // The recording's sampling buckets may begin between absolute window buckets.
  // Decode order/time here; the complete canonical validator checks its original
  // recording buckets after the reference's exact clock offset is restored.
  const points = decodeTrajectoryPointRuns(encoded, { durationMs: WINDOW_MS - 1, maxPoints: 601, checkBuckets: false });
  const logical = { version: 1, context, window, points: encodePointRuns(points) };
  if (digest(JSON.stringify(logical)) !== hash) throw problem("stored trajectory block checksum mismatch", 503);
  return points;
}

// Coordinates exist only in immutable content-addressed blocks. Names, owner
// evidence, events and the recording clock remain separate in each manifest.
// A time overlap alone never discards another observation or event.
export function planTrajectoryStorage(trajectory, { maxManifestDecodedBytes = LIMITS.decodedBytes, maxManifestCompressedBytes = LIMITS.compressedBytes } = {}) {
  if (!Number.isSafeInteger(maxManifestDecodedBytes) || maxManifestDecodedBytes < 1 || maxManifestDecodedBytes > LIMITS.decodedBytes
    || !Number.isSafeInteger(maxManifestCompressedBytes) || maxManifestCompressedBytes < 1 || maxManifestCompressedBytes > LIMITS.compressedBytes) throw problem("invalid storage manifest capacity");
  if (trajectory.players.reduce((count, player) => count + player.points.length, 0) > MAX_EXPANDED_POINTS)
    throw problem("trajectory expanded point capacity exceeded", 413);
  const blocks = new Map(), blockInfo = new Map(), { origin } = clock(trajectory);
  const players = trajectory.players.map(player => {
    const context = playerContext(trajectory, player), windows = new Map();
    for (const point of player.points) {
      const absolute = point[0] + origin, window = Math.floor(absolute / WINDOW_MS) * WINDOW_MS;
      if (!windows.has(window)) windows.set(window, []);
      windows.get(window).push([absolute - window, ...point.slice(1)]);
    }
    const pointBlocks = [];
    for (const [window, points] of windows) {
      const block = { version: 1, context, window, points: encodePointRuns(points) }, canonical = JSON.stringify(block), hash = digest(canonical);
      if (!blocks.has(hash)) blocks.set(hash, gzipSync(canonical, { level: 6 }));
      blockInfo.set(hash, { context, window, points });
      pointBlocks.push({ hash, offsetMs: window - origin, pointCount: points.length });
    }
    const { points, ...metadata } = player;
    return { ...metadata, pointCount: points.length, pointBlocks };
  });
  const manifest = { format: STORAGE_FORMAT, trajectory: { ...trajectory, players } };
  const canonical = JSON.stringify(manifest);
  if (Buffer.byteLength(canonical) > maxManifestDecodedBytes) throw problem("stored manifest decoded capacity exceeded", 413);
  const stored = gzipSync(canonical, { level: 6 });
  if (stored.byteLength > maxManifestCompressedBytes) throw problem("stored manifest compressed capacity exceeded", 413);
  return { manifest, manifestSha256: digest(canonical), stored, blocks, blockInfo, bases: new Map(), existing: new Set(), packCache: createPointPackCache(),
    statistics: { sharedBlocks: 0, deltaBlocks: 0, plainBlocks: 0, savedDeltaBytes: 0 } };
}

export async function missingPointBlockBytes(root, plan) {
  for (const [hash, body] of plan.blocks) {
    const { context, window, points } = plan.blockInfo.get(hash);
    const current = await readPointContext(root, context, plan.packCache);
    let exists = Boolean(current?.index.blocks[hash]);
    if (!exists) try { exists = Boolean(await lstat(join(root, "point-blocks", `${hash}.json.gz`))); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (exists) {
      await readPointBlock(root, hash, context, window, true, plan.packCache);
      plan.existing.add(hash);
      plan.statistics.sharedBlocks += 1;
      continue;
    }
    const baseKey = digest({ context, window, pointCount: points.length });
    let base = plan.bases.get(baseKey), basePoints;
    if (base) basePoints = plan.blockInfo.get(base.hash).points;
    else {
      const baseHash = current?.index.bases[`${window}:${points.length}`];
      if (baseHash) {
        base = { hash: baseHash, context, window, pointCount: points.length };
        try { basePoints = await readPointBlock(root, base.hash, context, window, false, plan.packCache); }
        catch { throw problem("stored plain trajectory base unavailable", 503); }
        if (basePoints.length !== points.length) throw problem("trajectory base point count mismatch", 503);
      }
    }
    let stored = body;
    if (basePoints) {
      const xor = Buffer.alloc(points.length * 16);
      for (let index = 0; index < points.length; index += 1) for (let axis = 0; axis < 4; axis += 1)
        xor.writeInt32LE(points[index][axis] ^ basePoints[index][axis], index * 16 + axis * 4);
      const delta = gzipSync(JSON.stringify({ version: 2, context, window, baseHash: base.hash,
        pointCount: points.length, xorData: xor.toString("base64") }), { level: 6 });
      if (delta.byteLength < body.byteLength) {
        stored = delta; plan.blocks.set(hash, stored); plan.statistics.deltaBlocks += 1;
        plan.blockInfo.get(hash).type = 2;
        plan.statistics.savedDeltaBytes += body.byteLength - delta.byteLength;
      } else plan.statistics.plainBlocks += 1;
    } else {
      base = { hash, context, window, pointCount: points.length };
      plan.bases.set(baseKey, base);
      plan.statistics.plainBlocks += 1;
    }
  }
  return planPointPacks(root, plan);
}
export async function writePointBlocks(root, plan) {
  await writePointPacks(root, plan);
  // On failure, unreferenced blocks deliberately remain counted against capacity.
  // Removing a created shared block here could break another committed manifest.
}

export async function readStoredTrajectory(root, id) {
  if (!validHash(id)) throw problem("invalid stored upload identity", 503);
  const raw = await boundedGzip(join(root, "uploads", `${id}.json.gz`));
  let candidate = raw;
  if (raw.format === STORAGE_FORMAT) {
    if (!keys(raw, ["format", "trajectory"]) || !raw.trajectory || !Array.isArray(raw.trajectory.players)) throw problem("invalid stored trajectory manifest", 503);
    const trajectory = raw.trajectory, players = [];
    if (trajectory.players.reduce((count, player) => count + (Number.isSafeInteger(player?.pointCount) && player.pointCount >= 0 ? player.pointCount : MAX_EXPANDED_POINTS + 1), 0) > MAX_EXPANDED_POINTS)
      throw problem("stored trajectory point capacity exceeded", 503);
    let total = 0; const packCache = createPointPackCache();
    for (const player of trajectory.players) {
      if (!keys(player, ["key", "name", "owner", "evidence", "events", "pointCount", "pointBlocks"])
        || !Number.isSafeInteger(player.pointCount) || player.pointCount < 0 || !Array.isArray(player.pointBlocks)
        || player.pointBlocks.length > Math.ceil(LIMITS.durationMs / WINDOW_MS) + 2) throw problem("invalid stored player block manifest", 503);
      const context = playerContext(trajectory, player), points = [];
      for (const ref of player.pointBlocks) {
        if (!keys(ref, ["hash", "offsetMs", "pointCount"]) || !Number.isSafeInteger(ref.offsetMs)
          || !Number.isSafeInteger(ref.pointCount) || ref.pointCount < 1 || ref.pointCount > 601) throw problem("invalid stored point range", 503);
        const decoded = await readPointBlock(root, ref.hash, context, ref.offsetMs + clock(trajectory).origin, true, packCache);
        if (decoded.length !== ref.pointCount) throw problem("stored block count mismatch", 503);
        total += decoded.length;
        // Also bounds a forged manifest before constructing an unlimited object.
        if (total > MAX_EXPANDED_POINTS) throw problem("stored trajectory point capacity exceeded", 503);
        for (const point of decoded) points.push([point[0] + ref.offsetMs, ...point.slice(1)]);
      }
      if (points.length !== player.pointCount) throw problem("stored player count mismatch", 503);
      const { pointCount, pointBlocks, ...metadata } = player;
      players.push({ ...metadata, points });
    }
    candidate = { ...trajectory, players };
  }
  const validated = validateTrajectory(candidate);
  const canonical = JSON.stringify(validated.trajectory);
  if (Buffer.byteLength(canonical) > LIMITS.decodedBytes || digest(canonical) !== id) throw problem("stored upload identity mismatch", 503);
  return { ...validated, ...(raw.format === STORAGE_FORMAT ? { manifestSha256: digest(JSON.stringify(raw)) } : {}) };
}

export function routeSource(player, route, manifestSha256) {
  const time = route.points[0]?.[0]; let first = 0, high = player.points.length;
  while (first < high) { const middle = (first + high) >>> 1; if (player.points[middle][0] < time) first = middle + 1; else high = middle; }
  const after = first + route.points.length;
  if (player.points[first]?.[0] !== time || after > player.points.length || route.points.some((point, index) => point !== player.points[first + index]
    && point.some((value, axis) => value !== player.points[first + index][axis]))) throw problem("derived attempt is not an exact source range", 503);
  return { version: manifestSha256 ? 2 : 1, ...(manifestSha256 ? { manifestSha256 } : {}), playerKey: player.key, first, after, breaks: route.breaks };
}
export function sourceRoute(trajectory, route) {
  const source = route.source, player = trajectory.players.find(value => value.key === source?.playerKey);
  if (!keys(source, ["version", ...(source?.version === 2 ? ["manifestSha256"] : []), "playerKey", "first", "after", "breaks"])
    || ![1, 2].includes(source.version) || source.version === 2 && !validHash(source.manifestSha256) || !player
    || source.playerKey !== route.playerKey || !Number.isSafeInteger(source.first) || !Number.isSafeInteger(source.after)
    || source.first < 0 || source.after > player.points.length || source.after <= source.first
    || source.after - source.first !== route.pointCount || !Array.isArray(source.breaks)
    || source.breaks.length) throw problem("damaged derived source range", 503);
  const points = player.points.slice(source.first, source.after);
  if (!isDeepStrictEqual(route.dedupe, routeDedupeKey(trajectory, player.key, route.stageIndex, points[0][0], points.at(-1)[0]))) throw problem("derived source interval identity mismatch", 503);
  return { points, breaks: source.breaks };
}

function inspectionLogical(value, points) {
  return { playerKey: value.playerKey, stageIndex: value.stageIndex, available: value.available,
    points, breaks: value.source.breaks, completion: value.completion, gameCompleted: value.gameCompleted };
}
export function makeInspectionSources(trajectory, manifestSha256, { maxMetadataBytes = INSPECTION_METADATA_BYTES } = {}) {
  if (!validHash(manifestSha256) || !Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1 || maxMetadataBytes > INSPECTION_METADATA_BYTES)
    throw problem("invalid inspection metadata capacity");
  const sources = []; let metadataBytes = 2;
  for (const player of trajectory.players) for (const stage of trajectory.map.stages) {
    let extracted, available = true;
    try { extracted = extractInspectionStage(trajectory, player, stage); }
    catch (error) {
      if (error.statusCode !== 409 || error.message !== "stage boundaries unavailable") throw error;
      available = false; extracted = { points: [], breaks: [], completion: "unknown", gameCompleted: null };
    }
    const spans = []; let next = 0;
    for (const point of extracted.points) {
      if (player.points[next]?.[0] !== point[0]) {
        let high = player.points.length;
        while (next < high) { const middle = (next + high) >>> 1; if (player.points[middle][0] < point[0]) next = middle + 1; else high = middle; }
      }
      if (!isDeepStrictEqual(player.points[next], point)) throw problem("inspection is not an exact source sample", 503);
      if (spans.at(-1)?.[1] === next) spans.at(-1)[1] = next + 1; else spans.push([next, next + 1]);
      next += 1;
    }
    const value = { playerKey: player.key, stageIndex: stage.index, available, pointCount: extracted.points.length,
      completion: extracted.completion, gameCompleted: extracted.gameCompleted,
      source: { version: 1, manifestSha256, spans, breaks: extracted.breaks, logicalSha256: "" } };
    value.source.logicalSha256 = digest(inspectionLogical(value, extracted.points));
    metadataBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
    if (metadataBytes > maxMetadataBytes) throw problem("inspection source metadata capacity exceeded", 413);
    sources.push(value);
  }
  return sources;
}

// Public route queries need only the referenced player/range, not every member's
// full recording. The approved manifest SHA plus every block's logical SHA pins
// the same source; complete canonical-ID reconstruction remains the review path.
// All caches live inside one worker request and have explicit memory budgets.
export function createReferencedRouteReader(root) {
  const manifests = new Map(), blocks = new Map(), inspections = new WeakMap(); let manifestBytes = 0, cachedPoints = 0;
  const packCache = createPointPackCache();
  const loadManifest = async (uploadId, manifestSha256) => {
    if (!validHash(uploadId) || !validHash(manifestSha256)) throw problem("invalid approved source manifest identity", 503);
    let manifest = manifests.get(uploadId)?.value;
    if (!manifest) {
      const raw = await boundedGzip(join(root, "uploads", `${uploadId}.json.gz`)), canonical = JSON.stringify(raw);
      if (!keys(raw, ["format", "trajectory"]) || raw.format !== STORAGE_FORMAT || digest(canonical) !== manifestSha256
        || !Array.isArray(raw.trajectory?.players)) throw problem("stored route manifest checksum mismatch", 503);
      manifest = raw; const bytes = Buffer.byteLength(canonical);
      while (manifests.size && manifestBytes + bytes > 4 * 1024 * 1024) {
        const key = manifests.keys().next().value; manifestBytes -= manifests.get(key).bytes; manifests.delete(key);
      }
      if (bytes <= 4 * 1024 * 1024) { manifests.set(uploadId, { value: manifest, bytes, sha256: manifestSha256 }); manifestBytes += bytes; }
    } else if (manifests.get(uploadId).sha256 !== manifestSha256) throw problem("inconsistent approved source manifest", 503);
    return manifest;
  };
  const readRange = async (route, verifyAttempt = true) => {
    const source = route.source;
    if (!source || source.version !== 2 || !keys(source, ["version", "manifestSha256", "playerKey", "first", "after", "breaks"])) throw problem("invalid approved source reference", 503);
    const manifest = await loadManifest(route.uploadId, source.manifestSha256);
    const trajectory = manifest.trajectory, player = trajectory.players.find(value => value.key === source.playerKey);
    if (!player || player.key !== route.playerKey || !Array.isArray(player.pointBlocks) || player.pointBlocks.length > 242
      || !Number.isSafeInteger(source.first) || !Number.isSafeInteger(source.after) || source.first < 0
      || source.after > player.pointCount || source.after <= source.first || source.after - source.first !== route.pointCount
      || !Array.isArray(source.breaks) || source.breaks.length) throw problem("invalid approved source point range", 503);
    const context = playerContext(trajectory, player), selected = []; let first = 0;
    for (const ref of player.pointBlocks) {
      if (!keys(ref, ["hash", "offsetMs", "pointCount"]) || !validHash(ref.hash) || !Number.isSafeInteger(ref.offsetMs)
        || !Number.isSafeInteger(ref.pointCount) || ref.pointCount < 1 || ref.pointCount > 601) throw problem("invalid approved source block range", 503);
      const after = first + ref.pointCount;
      if (after > source.first && first < source.after) selected.push({ ref, first, after });
      first = after;
    }
    if (first !== player.pointCount) throw problem("approved source block counts mismatch", 503);
    const output = [];
    for (let begin = 0; begin < selected.length; begin += 4) {
      const decoded = await Promise.all(selected.slice(begin, begin + 4).map(async value => {
        let points = blocks.get(value.ref.hash);
        if (!points) {
          points = await readPointBlock(root, value.ref.hash, context, value.ref.offsetMs + clock(trajectory).origin, true, packCache);
          if (points.length !== value.ref.pointCount) throw problem("approved source block length mismatch", 503);
          while (blocks.size && cachedPoints + points.length > 24_000) {
            const hash = blocks.keys().next().value; cachedPoints -= blocks.get(hash).length; blocks.delete(hash);
          }
          blocks.set(value.ref.hash, points); cachedPoints += points.length;
        }
        return { ...value, points };
      }));
      for (const { ref, first, points } of decoded) for (let index = Math.max(0, source.first - first); index < Math.min(points.length, source.after - first); index += 1)
        output.push([points[index][0] + ref.offsetMs, ...points[index].slice(1)]);
    }
    if (output.length !== route.pointCount) throw problem("approved source range count mismatch", 503);
    if (verifyAttempt && !isDeepStrictEqual(route.dedupe, routeDedupeKey(trajectory, player.key, route.stageIndex, output[0][0], output.at(-1)[0]))) throw problem("approved source interval identity mismatch", 503);
    return { points: output, breaks: source.breaks };
  };
  readRange.metadata = async entry => {
    const { trajectory } = await loadManifest(entry.id, entry.storageManifestSha256);
    const candidate = { ...trajectory, players: trajectory.players.map(player => {
      const { pointCount, pointBlocks, ...metadata } = player; return { ...metadata, points: [] };
    }) };
    const validated = validateTrajectory(candidate).trajectory;
    if (groupId(validated.map) !== entry.groupId || !isDeepStrictEqual(validated.map, entry.map)
      || !isDeepStrictEqual(difficultyInfo(validated.difficulty), entry.difficulty)) throw problem("stored member metadata identity mismatch", 503);
    return validated;
  };
  readRange.player = async (entry, key) => {
    const { trajectory } = await loadManifest(entry.id, entry.storageManifestSha256), player = trajectory.players.find(value => value.key === key);
    if (!player || !Number.isSafeInteger(player.pointCount) || player.pointCount < 0 || player.pointCount > MAX_EXPANDED_POINTS) throw problem("stored selected player unavailable", 503);
    const points = player.pointCount ? (await readRange({ uploadId: entry.id, playerKey: key, pointCount: player.pointCount,
      source: { version: 2, manifestSha256: entry.storageManifestSha256, playerKey: key, first: 0, after: player.pointCount, breaks: [] } }, false)).points : [];
    const { pointCount, pointBlocks, ...metadata } = player;
    return validateTrajectory({ ...trajectory, players: [{ ...metadata, points }] }).trajectory.players[0];
  };
  readRange.inspection = async (entry, key, stageIndex, { allowUnavailable = false } = {}) => {
    let lookup = inspections.get(entry);
    if (!lookup) {
      if (!Array.isArray(entry.inspectionSources) || Buffer.byteLength(JSON.stringify(entry.inspectionSources)) > INSPECTION_METADATA_BYTES)
        throw problem("invalid inspection source metadata capacity", 503);
      lookup = new Map();
      for (const value of entry.inspectionSources) {
        const identity = `${value?.playerKey}:${value?.stageIndex}`;
        if (lookup.has(identity)) throw problem("duplicate inspection source identity", 503);
        lookup.set(identity, value);
      }
      inspections.set(entry, lookup);
    }
    const value = lookup.get(`${key}:${stageIndex}`), source = value?.source;
    const { trajectory } = await loadManifest(entry.id, entry.storageManifestSha256), player = trajectory.players.find(player => player.key === key);
    if (!keys(value, ["playerKey", "stageIndex", "available", "pointCount", "completion", "gameCompleted", "source"])
      || !keys(source, ["version", "manifestSha256", "spans", "breaks", "logicalSha256"]) || source.version !== 1
      || source.manifestSha256 !== entry.storageManifestSha256 || !validHash(source.logicalSha256) || !player
      || typeof value.available !== "boolean" || !["complete", "partial", "unknown"].includes(value.completion)
      || ![null, true, false].includes(value.gameCompleted) || !Number.isSafeInteger(value.pointCount) || value.pointCount < 0
      || value.pointCount > MAX_EXPANDED_POINTS || !Array.isArray(source.spans) || source.spans.length > value.pointCount
      || !Array.isArray(source.breaks) || source.breaks.length > 100_000) throw problem("invalid inspection source metadata", 503);
    let after = -1, count = 0;
    for (const span of source.spans) {
      if (!Array.isArray(span) || span.length !== 2 || !Number.isSafeInteger(span[0]) || !Number.isSafeInteger(span[1])
        || span[0] < 0 || span[0] <= after || span[1] <= span[0] || span[1] > player.pointCount) throw problem("invalid inspection source spans", 503);
      count += span[1] - span[0]; after = span[1] - 1;
    }
    if (count !== value.pointCount || !value.available && count) throw problem("inspection source span counts mismatch", 503);
    const points = [];
    if (count) {
      const first = source.spans[0][0], last = source.spans.at(-1)[1];
      const cover = (await readRange({ uploadId: entry.id, playerKey: key, pointCount: last - first,
        source: { version: 2, manifestSha256: entry.storageManifestSha256, playerKey: key, first, after: last, breaks: [] } }, false)).points;
      for (const [begin, end] of source.spans) for (let index = begin; index < end; index++) points.push(cover[index - first]);
    }
    if (source.breaks.some((time, index) => !Number.isSafeInteger(time) || time < (points[0]?.[0] ?? 0)
      || time > (points.at(-1)?.[0] ?? 0) || index > 0 && time <= source.breaks[index - 1])
      || !points.length && source.breaks.length || digest(inspectionLogical(value, points)) !== source.logicalSha256) throw problem("inspection source checksum mismatch", 503);
    if (!value.available && !allowUnavailable) throw problem("stage boundaries unavailable", 409);
    return { points, breaks: source.breaks, completion: value.completion, gameCompleted: value.gameCompleted };
  };
  return readRange;
}
