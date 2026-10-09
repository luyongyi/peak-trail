import { mkdir, readdir, readFile, writeFile, rename, link, unlink, stat, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { LIMITS, problem, digest, validHash, validateTrajectory, difficultyInfo, groupId,
  extractStageRoutes, extractInspectionStage, playerSummitCompleted, routeDedupeKey, dedupeRoutes, aggregateHeatmap } from "./trajectory-contract.mjs";
import { fitMapAlignment, alignedRoutePoints, validateMapAlignment } from "./map-alignment.mjs";
import { TEAM_LIMITS, makeTeamMetadata, inspectTeamStage, teamIdentity, collectTeams, teamDescriptor, memberMatches, sourceOrder } from "./team-index.mjs";

async function setup(root) { for (const child of ["index", "uploads", "routes"]) await mkdir(join(root, child), { recursive: true, mode: 0o700 }); }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function atomicJson(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.part`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  try { if (exclusive) await link(temporary, path); else await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}
async function atomicBytes(path, value) {
  const temporary = `${path}.${randomUUID()}.part`;
  await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
  try { await link(temporary, path); return true; }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  finally { await unlink(temporary).catch(() => {}); }
}
async function withReviewLock(path, action, wait = false) {
  const lockPath = `${path}.review-lock`;
  let lock;
  for (let attempt = 0; attempt < (wait ? 20 : 1); attempt += 1) {
    try { lock = await open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (wait) await pause(100);
    }
  }
  if (!lock) { if (wait) throw problem("upload review is busy", 503); return null; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdUtc: new Date().toISOString() }));
    return await action();
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}
async function physicalBytes(root) {
  let bytes = 0;
  for (const child of ["index", "uploads", "routes"]) {
    const files = await readdir(join(root, child));
    for (let start = 0; start < files.length; start += 32) {
      const sizes = await Promise.all(files.slice(start, start + 32).map(async (file) => (await stat(join(root, child, file))).size));
      for (const size of sizes) bytes += size;
    }
  }
  return bytes;
}
export async function loadIndex(root) {
  await setup(root);
  const files = (await readdir(join(root, "index"))).filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
  if (files.length > LIMITS.uploads) throw problem("storage index limit exceeded", 503);
  const entries = [];
  for (const file of files) {
    // Fail closed when an index entry is damaged; never rebuild public approval from blobs.
    try { const entry = await readJson(join(root, "index", file));
      if (entry.version === 1 && entry.id === file.slice(0, -5) && ["pending", "approved", "hidden", "rejected"].includes(entry.moderationStatus)) entries.push(entry);
    } catch { /* a damaged private entry is omitted until an administrator repairs it */ }
  }
  return entries;
}
export async function mapMatch(map, catalogPath) {
  const waiting = reason => ({ mapCompatibility: "waiting-map", mapPackId: null, mapAlignment: { status: "pending", reason } });
  try {
    if (!/^[1-9]\d*$/.test(String(map.buildId)) || !/^Level_\d+$/.test(map.scene)) return waiting("invalid-map-identity");
    const catalog = await readJson(catalogPath);
    let evidence = null, landmarks = null;
    try { evidence = await readJson(join(dirname(catalogPath), `routes.${map.buildId}.json`)); } catch (error) { if (error.code !== "ENOENT") return waiting("source-evidence-unavailable"); }
    try { landmarks = await readJson(join(dirname(catalogPath), `landmarks.${map.buildId}.json`)); } catch (error) { if (error.code !== "ENOENT") return waiting("source-evidence-unavailable"); }
    const candidates = (catalog.schemaVersion === 1 && Array.isArray(catalog.mapPacks) ? catalog.mapPacks : []).filter((entry) => entry.enabled !== false
      && String(entry.gameBuildId) === map.buildId && entry.sceneName === map.scene && /^sha256-[a-f0-9]{64}$/.test(entry.mapPackId ?? ""));
    if (!candidates.length) return waiting("map-build-unavailable");
    const compatible = candidates.filter((entry) => {
      const observed = evidence?.maps?.find((value) => value.sceneName === map.scene && value.mapPackId === entry.mapPackId);
      if (evidence && !observed) return false;
      const route = entry.route ?? observed?.route;
      const segments = Array.isArray(route) ? route.map((biome, index) => ({ index, biome })) : route?.segments;
      if (!Array.isArray(segments) || !segments.length) return false;
      const equivalent = (segment) => {
        const name = map.route[segment.index];
        if (name === segment.biome) return true;
        // The audited map route identifies the two terminal roots. They share a
        // biome enum with stage 3, but native progress-point titles distinguish stage 4.
        return segment.index === 4 && ((name === "Kiln" && segment.biome === "Volcano" && route.branch === "volcano-kiln")
          || (["Temple", "Citadel"].includes(name) && segment.biome === "Swamp" && route.branch === "swamp-temple"));
      };
      return segments.every(equivalent)
        && map.route.every((biome, index) => segments.some((segment) => segment.index === index && equivalent(segment)) || (index === 5 && biome === "Void"));
    });
    compatible.sort((a, b) => (Date.parse(b.generatedAtUtc) || 0) - (Date.parse(a.generatedAtUtc) || 0));
    if (!compatible.length) return waiting("map-branch-mismatch");
    if (landmarks?.schemaVersion !== 1 || !Array.isArray(landmarks.maps)) return waiting(map.alignment ? "source-landmarks-missing" : "recording-landmarks-missing");
    if (String(landmarks.gameBuildId) !== map.buildId || landmarks.authority !== "serialized-map-landmarks") return waiting("source-evidence-mismatch");
    let reason = map.alignment ? "source-landmarks-missing" : "recording-landmarks-missing";
    for (const entry of compatible) {
      const source = landmarks.maps.find(value => value.sceneName === map.scene && value.mapPackId === entry.mapPackId);
      if (!source) continue;
      // A sidecar belongs to one exact exported scene, not just a Level_N name.
      // Keep all reads inside the catalog's immutable public pack directory.
      if (entry.path !== `./packs/${entry.mapPackId}/map-pack.json`) { reason = "source-evidence-unavailable"; continue; }
      const pack = await readJson(join(dirname(catalogPath), "packs", entry.mapPackId, "map-pack.json"));
      if (pack.mapPackId !== entry.mapPackId || String(pack.gameBuildId) !== map.buildId || pack.sceneName !== map.scene
        || pack.coordinateSpace !== "unity-world-meters" || !validHash(source.sourceSceneSha256)
        || source.sourceSceneSha256 !== pack.source?.sceneSha256) { reason = "source-evidence-mismatch"; continue; }
      let alignment;
      if (map.alignment) alignment = fitMapAlignment(map.alignment, source.alignment);
      else {
        // Older headers contain a hash of every native root path/XYZ and gate.
        // Only an exact hash regenerated from audited source DLL/scene data,
        // with no runtime root TRS writes, can prove an identity-only mapping.
        // It never estimates an offset or supplies evidence missing from a run.
        const canonical = validateMapAlignment(source.alignment);
        const ordinary = map.stages.filter(stage => stage.name !== "Void");
        const gates = new Map(canonical.landmarks.filter(value => value.kind === "progress-point").map(value => [value.key, value.positionCm[2]]));
        const gatesMatch = ordinary.every((stage, i) => stage.enterZCm === gates.get(`progress-point:${stage.index}`)
          && stage.exitZCm === gates.get(i + 1 < ordinary.length ? `progress-point:${ordinary[i+1].index}` : "progress-point:peak"));
        if (source.legacyRootTransformPolicy !== "static-no-runtime-trs-writes" || !validHash(source.expectedLegacyLayoutKey)
          || !/^[a-f0-9]{32}$/.test(landmarks.sourceGameAssemblyMvid || "") || !validHash(landmarks.sourceGameAssemblySha256)
          || source.expectedLegacyLayoutKey !== map.layoutKey || !gatesMatch || canonical.landmarks.length < 3) continue;
        alignment = { status: "verified", method: "legacy-layout-key", landmarkCount: canonical.landmarks.length, maxErrorCm: 0,
          transform: { rotation: [1,0,0,0,1,0,0,0,1], translationCm: [0,0,0] } };
      }
      if (alignment.status !== "verified") { reason = alignment.reason; continue; }
      alignment.id = digest({ mapPackId: entry.mapPackId, sourceSceneSha256: source.sourceSceneSha256,
        recorded: map.alignment || { layoutKey: map.layoutKey, method: alignment.method }, canonical: source.alignment });
      return { mapCompatibility: "matched", mapPackId: entry.mapPackId, mapAlignment: alignment };
    }
    return waiting(reason);
  } catch { return waiting("source-evidence-unavailable"); }
}
export async function ingestUpload(root, compressed, catalogPath, { minimalReceipt = false } = {}) {
  if (compressed.byteLength > LIMITS.compressedBytes) throw problem("compressed body exceeds 12 MiB", 413);
  let decoded;
  try { decoded = gunzipSync(compressed, { maxOutputLength: LIMITS.decodedBytes }); }
  catch (error) { throw problem(error.code === "ERR_BUFFER_TOO_LARGE" ? "decoded body exceeds 64 MiB" : "invalid gzip body", error.code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400); }
  let raw;
  try { raw = JSON.parse(decoded.toString("utf8")); } catch { throw problem("invalid trajectory JSON"); }
  const { trajectory, totalPoints } = validateTrajectory(raw);
  const canonical = JSON.stringify(trajectory), id = digest(canonical), path = join(root, "index", `${id}.json`);
  await setup(root);
  try { const existing = await readJson(path); return uploadReceipt(existing, true, catalogPath, minimalReceipt); } catch (error) { if (error.code !== "ENOENT") throw problem("existing upload index is damaged", 503); }
  const index = await loadIndex(root);
  const occupiedBytes = await physicalBytes(root);
  if (index.length >= LIMITS.uploads || occupiedBytes + compressed.byteLength * 3 > LIMITS.storedBytes) throw problem("route storage capacity reached", 503);
  const stored = gzipSync(canonical, { level: 6 });
  let storedBytes = stored.byteLength;
  const routeFiles = [];
  const receivedUtc = new Date().toISOString();
  const entry = { version: 1, id, groupId: groupId(trajectory.map), recordingId: trajectory.recordingId, receivedUtc, startedUtc: trajectory.startedUtc,
    moderationStatus: "approved", reviewedUtc: receivedUtc, reviewMethod: "automatic-contract-v1",
    map: trajectory.map, difficulty: difficultyInfo(trajectory.difficulty), durationMs: trajectory.durationMs,
    playerCount: trajectory.players.length, pointCount: totalPoints, players: [], routes: [], storedBytes: 0,
    team: makeTeamMetadata(trajectory) };
  for (let playerIndex = 0; playerIndex < trajectory.players.length; playerIndex += 1) {
    const player = trajectory.players[playerIndex], stages = [];
    for (const stage of trajectory.map.stages) {
      const extracted = extractStageRoutes(trajectory, player, stage);
      stages.push({ index: stage.index, completion: extracted.completion, routeCount: extracted.routes.length });
      for (let attempt = 0; attempt < extracted.routes.length; attempt += 1) {
        const route = extracted.routes[attempt], filename = `${id}-p${playerIndex}-s${stage.index}-a${attempt}.json.gz`;
        const bytes = gzipSync(JSON.stringify({ points: route.points, breaks: route.breaks }), { level: 6 });
        routeFiles.push({ filename, bytes }); storedBytes += bytes.byteLength;
        if (routeFiles.length > 4096 || storedBytes > LIMITS.compressedBytes * 4) throw problem("derived route capacity exceeded", 413);
        entry.routes.push({ id: digest(filename), file: filename, uploadId: id, playerKey: player.key, name: player.name, owner: player.owner,
          stageIndex: stage.index, pointCount: route.points.length, difficulty: entry.difficulty,
          ...(player.events.some(event => event.kind === "game-stage") ? { nativeProgress: true } : {}),
          dedupe: routeDedupeKey(trajectory, player.key, stage.index, route.startMs, route.endMs) });
      }
    }
    entry.players.push({ key: player.key, name: player.name, owner: player.owner, evidence: player.evidence, stages });
  }
  entry.storedBytes = storedBytes + Buffer.byteLength(JSON.stringify(entry));
  if (occupiedBytes + entry.storedBytes > LIMITS.storedBytes) throw problem("route storage capacity reached", 503);
  if (index.reduce((sum, other) => sum + other.routes.length, 0) + entry.routes.length > 100_000) throw problem("route index capacity reached", 503);
  const created = [];
  try {
    const uploadPath = join(root, "uploads", `${id}.json.gz`);
    if (await atomicBytes(uploadPath, stored)) created.push(uploadPath);
    for (const { filename, bytes } of routeFiles) { const routePath = join(root, "routes", filename); if (await atomicBytes(routePath, bytes)) created.push(routePath); }
    await atomicJson(path, entry, true);
  } catch (error) {
    if (error.code === "EEXIST") return uploadReceipt(await readJson(path), true, catalogPath, minimalReceipt);
    let committed = false; try { committed = (await readJson(path)).id === id; } catch { /* no committed index */ }
    if (!committed) for (const file of created) await unlink(file).catch(() => {});
    throw error;
  }
  return uploadReceipt(entry, false, catalogPath, minimalReceipt);
}
async function uploadReceipt(entry, duplicate, catalogPath, minimal = false) {
  const match = await mapMatch(entry.map, catalogPath);
  if (minimal) return { uploadId: entry.id, groupId: entry.groupId, duplicate, moderationStatus: entry.moderationStatus,
    mapCompatibility: match.mapCompatibility };
  return { uploadId: entry.id, groupId: entry.groupId, duplicate, moderationStatus: entry.moderationStatus, ...match,
    stages: entry.players.map((player) => ({ playerKey: player.key, stages: player.stages })) };
}

async function validatePendingEntry(root, entry) {
  const stored = await readFile(join(root, "uploads", `${entry.id}.json.gz`));
  if (stored.byteLength > LIMITS.compressedBytes) throw problem("stored upload exceeds capacity");
  const raw = JSON.parse(gunzipSync(stored, { maxOutputLength: LIMITS.decodedBytes }).toString("utf8"));
  const { trajectory, totalPoints } = validateTrajectory(raw);
  if (digest(JSON.stringify(trajectory)) !== entry.id || entry.groupId !== groupId(trajectory.map)
    || entry.recordingId !== trajectory.recordingId || !isDeepStrictEqual(entry.map, trajectory.map)
    || !isDeepStrictEqual(entry.difficulty, difficultyInfo(trajectory.difficulty)) || entry.durationMs !== trajectory.durationMs
    || entry.playerCount !== trajectory.players.length || entry.pointCount !== totalPoints) throw problem("stored upload index disagrees with its trajectory");
  const players = [], routes = [];
  for (let playerIndex = 0; playerIndex < trajectory.players.length; playerIndex += 1) {
    const player = trajectory.players[playerIndex], stages = [];
    for (const stage of trajectory.map.stages) {
      const extracted = extractStageRoutes(trajectory, player, stage);
      stages.push({ index: stage.index, completion: extracted.completion, routeCount: extracted.routes.length });
      for (let attempt = 0; attempt < extracted.routes.length; attempt += 1) {
        const route = extracted.routes[attempt], filename = `${entry.id}-p${playerIndex}-s${stage.index}-a${attempt}.json.gz`;
        routes.push({ id: digest(filename), file: filename, uploadId: entry.id, playerKey: player.key, name: player.name, owner: player.owner,
          stageIndex: stage.index, pointCount: route.points.length, difficulty: entry.difficulty,
          ...(player.events.some(event => event.kind === "game-stage") ? { nativeProgress: true } : {}),
          dedupe: routeDedupeKey(trajectory, player.key, stage.index, route.startMs, route.endMs) });
        if (routes.length > 4096) throw problem("stored route index exceeds capacity");
        const bytes = await readFile(join(root, "routes", filename));
        if (bytes.byteLength > LIMITS.compressedBytes) throw problem("stored route exceeds capacity");
        const data = JSON.parse(gunzipSync(bytes, { maxOutputLength: LIMITS.decodedBytes }).toString("utf8"));
        if (!isDeepStrictEqual(data, { points: route.points, breaks: route.breaks })) throw problem("stored route disagrees with complete individual attempt");
      }
    }
    players.push({ key: player.key, name: player.name, owner: player.owner, evidence: player.evidence, stages });
  }
  if (!isDeepStrictEqual(entry.players, players) || !isDeepStrictEqual(entry.routes, routes)) throw problem("stored route metadata disagrees with complete individual attempts");
  if (entry.team !== undefined && (![1, 2].includes(entry.team.version)
    || !isDeepStrictEqual(entry.team, makeTeamMetadata(trajectory, { version: entry.team.version })))) throw problem("stored team metadata disagrees with its trajectory");
  return trajectory.startedUtc;
}

// Upgrade only original, unreviewed submissions. An explicit administrative hold,
// rejection or hide remains authoritative, including during a concurrent upgrade.
export async function autoApprovePending(root) {
  const summary = { approved: 0, invalid: 0, busy: 0 };
  for (const entry of await loadIndex(root)) {
    if (entry.moderationStatus !== "pending" || Object.hasOwn(entry, "reviewedUtc")) continue;
    let startedUtc;
    try { startedUtc = await validatePendingEntry(root, entry); }
    catch { summary.invalid += 1; continue; }
    const path = join(root, "index", `${entry.id}.json`);
    const result = await withReviewLock(path, async () => {
      const current = await readJson(path);
      if (current.moderationStatus !== "pending" || Object.hasOwn(current, "reviewedUtc") || !isDeepStrictEqual(current, entry)) return false;
      current.moderationStatus = "approved"; current.startedUtc = startedUtc;
      current.reviewedUtc = new Date().toISOString(); current.reviewMethod = "automatic-contract-v1";
      await atomicJson(path, current);
      return true;
    });
    if (result === null) summary.busy += 1;
    else if (result) summary.approved += 1;
  }
  return summary;
}

export async function moderate(root, id, status) {
  if (!validHash(id) || !["approved", "hidden", "rejected", "pending"].includes(status)) throw problem("invalid moderation command");
  const path = join(root, "index", `${id}.json`);
  await withReviewLock(path, async () => {
    let entry; try { entry = await readJson(path); } catch (error) { throw problem(error.code === "ENOENT" ? "unknown upload" : "damaged upload", 404); }
    entry.moderationStatus = status; entry.reviewedUtc = new Date().toISOString(); entry.reviewMethod = "administrator";
    await atomicJson(path, entry);
  }, true);
  // Queries read current approval and recompute aggregates; hiding takes effect on the
  // next request, without stale public heatmap contributions or a restart.
  return { uploadId: id, moderationStatus: status };
}
async function publicGroups(root) {
  const groups = new Map();
  for (const entry of await loadIndex(root)) {
    if (entry.moderationStatus !== "approved") continue;
    if (!groups.has(entry.groupId)) groups.set(entry.groupId, { id: entry.groupId, map: entry.map, routes: [], startedTimes: [] });
    const group = groups.get(entry.groupId);
    group.routes.push(...entry.routes.map(route => ({ ...route, teamId: teamIdentity(entry).id })));
    if (typeof entry.startedUtc === "string" && Number.isFinite(Date.parse(entry.startedUtc))) group.startedTimes.push(entry.startedUtc);
  }
  for (const group of groups.values()) group.routes = dedupeRoutes(group.routes);
  return groups;
}
export async function listGroups(root, catalogPath) {
  const groups = [];
  for (const group of (await publicGroups(root)).values()) {
    const times = group.startedTimes.sort((a, b) => Date.parse(a) - Date.parse(b));
    groups.push({ id: group.id, map: group.map, firstStartedUtc: times[0] ?? null, lastStartedUtc: times.at(-1) ?? null, ...(await mapMatch(group.map, catalogPath)),
      difficulties: [...new Map(group.routes.map((route) => [route.difficulty.key, route.difficulty])).values()],
      stageSummaries: group.map.stages.map((stage) => ({ index: stage.index, name: stage.name, routeCount: group.routes.filter((route) => route.stageIndex === stage.index).length })) });
  }
  return { groups: groups.sort((a, b) => a.id.localeCompare(b.id)) };
}
async function readRoute(root, route) {
  if (!/^[a-f0-9]{64}-p\d+-s\d+-a\d+\.json\.gz$/.test(route.file)) throw problem("damaged route file reference", 503);
  try { return JSON.parse(gunzipSync(await readFile(join(root, "routes", route.file)), { maxOutputLength: LIMITS.decodedBytes }).toString("utf8")); }
  catch { throw problem("stored route unavailable", 503); }
}
export async function queryRoutes(root, catalogPath, group, stage, difficulty, limit = 200, heat = false, options = {}) {
  if (!validHash(group) || !Number.isInteger(stage) || stage < 0 || stage >= LIMITS.stages) throw problem("invalid route group/stage");
  const chosen = (await publicGroups(root)).get(group);
  if (!chosen || !chosen.map.stages.some((entry) => entry.index === stage)) throw problem("unknown public route group/stage", 404);
  const countBy = options.countBy ?? "player", team = options.team ?? "";
  if (!["player", "team"].includes(countBy) || (team && !validHash(team))) throw problem("invalid team/countBy filter");
  const candidates = chosen.routes.filter((route) => route.stageIndex === stage && (!difficulty || route.difficulty.key === difficulty)
    && (!team || route.teamId === team));
  const base = { groupId: group, stageIndex: stage, ...(await mapMatch(chosen.map, catalogPath)), totalRouteCount: candidates.length };
  base.coordinateSpace = base.mapAlignment.status === "verified" ? "canonical-map-world-cm" : "recording-world-cm";
  const readAligned = async route => {
    const data = await readRoute(root, route);
    return { ...data, points: alignedRoutePoints(data.points, base.mapAlignment) };
  };
  if (heat) {
    const counts = new Map(), participantVisits = new Map(); let visits = 0;
    for (const route of candidates) {
      // Count a team or a member once per voxel even across multiple complete
      // attempts. A different team/run still contributes an independent visit.
      const cells = aggregateHeatmap([(await readAligned(route)).points]);
      for (const [x, y, z, count] of cells) {
        const key = `${x},${y},${z}`;
        const participant = countBy === "team" ? route.teamId : `${route.teamId}:${route.playerKey}`;
        if (!participantVisits.has(participant)) participantVisits.set(participant, new Set());
        const visited = participantVisits.get(participant);
        if (visited.has(key)) continue;
        visited.add(key);
        if (++visits > LIMITS.heatCells * 4) throw problem("team heatmap capacity exceeded", 413);
        counts.set(key, (counts.get(key) ?? 0) + count);
      }
      if (counts.size > LIMITS.heatCells) throw problem("heatmap capacity exceeded", 413);
    }
    return { ...base, countBy, teamCount: new Set(candidates.map(route => route.teamId)).size,
      cellSizeCm: 200, heightBandCm: 200, routeCount: candidates.length,
      cells: [...counts].map(([key, count]) => [...key.split(",").map(Number), count]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) };
  }
  const routes = []; let pointCount = 0;
  for (const route of candidates.slice(0, Math.min(200, limit))) {
    if (pointCount + route.pointCount > LIMITS.queryPoints) break;
    const data = await readAligned(route); pointCount += data.points.length;
    routes.push({ id: route.id, playerKey: route.playerKey, name: route.name, difficulty: route.difficulty, ...data });
  }
  return { ...base, routes, truncated: routes.length < candidates.length, pointCount };
}

export async function queryInspection(root, catalogPath, group, upload, stage) {
  if (!validHash(group) || !validHash(upload) || !Number.isInteger(stage) || stage < 0 || stage >= LIMITS.stages) throw problem("invalid inspection group/upload/stage");
  let entry;
  try { entry = await readJson(join(root, "index", `${upload}.json`)); }
  catch { throw problem("unknown approved inspection upload", 404); }
  if (entry.version !== 1 || entry.id !== upload || entry.groupId !== group || entry.moderationStatus !== "approved") throw problem("unknown approved inspection upload", 404);
  let trajectory;
  try {
    const bytes = await readFile(join(root, "uploads", `${upload}.json.gz`));
    if (bytes.byteLength > LIMITS.compressedBytes) throw new Error("stored upload exceeds capacity");
    ({ trajectory } = validateTrajectory(JSON.parse(gunzipSync(bytes, { maxOutputLength: LIMITS.decodedBytes }).toString("utf8"))));
    if (digest(JSON.stringify(trajectory)) !== upload || groupId(trajectory.map) !== group || !isDeepStrictEqual(entry.map, trajectory.map)
      || !isDeepStrictEqual(entry.difficulty, difficultyInfo(trajectory.difficulty))) throw new Error("stored inspection identity mismatch");
  } catch { throw problem("stored inspection trajectory unavailable", 503); }
  const selected = trajectory.map.stages.find(value => value.index === stage);
  if (!selected) throw problem("unknown inspection stage", 404);
  const base = { groupId: group, uploadId: upload, stageIndex: stage, inspection: true, excludedFromAggregation: true,
    startedUtc: trajectory.startedUtc, ...(await mapMatch(trajectory.map, catalogPath)) };
  base.coordinateSpace = base.mapAlignment.status === "verified" ? "canonical-map-world-cm" : "recording-world-cm";
  const routes = []; let pointCount = 0, totalRouteCount = 0, truncated = false;
  for (const player of trajectory.players) {
    const extracted = extractInspectionStage(trajectory, player, selected);
    if (!extracted.points.length) continue;
    totalRouteCount += 1;
    const points = extracted.points.slice(0, Math.max(0, LIMITS.queryPoints - pointCount));
    if (points.length < extracted.points.length) truncated = true;
    if (!points.length) continue;
    pointCount += points.length;
    routes.push({ id: digest({ upload, playerKey: player.key, stage, inspection: true }), playerKey: player.key, name: player.name,
      difficulty: entry.difficulty, completion: extracted.completion, completed: extracted.completion === "complete",
      gameCompleted: extracted.gameCompleted,
      points: alignedRoutePoints(points, base.mapAlignment), breaks: extracted.breaks.filter(value => value <= points.at(-1)[0]) });
  }
  return { ...base, routes, totalRouteCount, truncated, pointCount };
}

export async function listTeams(root, { member = "", group = "", difficulty = "", limit = 50 } = {}) {
  if (typeof member !== "string" || member.length > 80 || /[\u0000-\u001f]/u.test(member)
    || (group && !validHash(group)) || typeof difficulty !== "string" || difficulty.length > 100
    || !Number.isInteger(limit) || limit < 1 || limit > TEAM_LIMITS.results) throw problem("invalid team search");
  const teams = [...collectTeams(await loadIndex(root)).values()].filter(team => (!group || team.groupId === group)
    && (!difficulty || team.difficulty.key === difficulty) && memberMatches(team, member.trim()))
    .map(teamDescriptor).sort((a, b) => (Date.parse(b.lastStartedUtc) || 0) - (Date.parse(a.lastStartedUtc) || 0) || a.id.localeCompare(b.id));
  return { teams: teams.slice(0, limit), truncated: teams.length > limit };
}

export async function queryTeam(root, catalogPath, teamId) {
  if (!validHash(teamId)) throw problem("invalid team");
  const team = collectTeams(await loadIndex(root)).get(teamId);
  if (!team) throw problem("unknown public team", 404);
  await hydrateLegacyTeam(root, team);
  return { team: { ...teamDescriptor(team), ...(await mapMatch(team.map, catalogPath)) } };
}

async function readInspectionTrajectory(root, entry) {
  try {
    const bytes = await readFile(join(root, "uploads", `${entry.id}.json.gz`));
    if (bytes.byteLength > LIMITS.compressedBytes) throw new Error("stored upload exceeds capacity");
    const { trajectory } = validateTrajectory(JSON.parse(gunzipSync(bytes, { maxOutputLength: LIMITS.decodedBytes }).toString("utf8")));
    if (digest(JSON.stringify(trajectory)) !== entry.id || groupId(trajectory.map) !== entry.groupId
      || !isDeepStrictEqual(entry.map, trajectory.map) || !isDeepStrictEqual(entry.difficulty, difficultyInfo(trajectory.difficulty))) throw new Error("stored team identity mismatch");
    return trajectory;
  } catch { throw problem("stored team trajectory unavailable", 503); }
}

async function hydrateLegacyTeam(root, team) {
  const legacy = team.entries.filter(entry => entry.team?.version !== 2).sort((a, b) => b.pointCount - a.pointCount || a.id.localeCompare(b.id));
  // This is restricted to one explicitly selected team. Search never opens raw
  // blobs, and old indexes are not rewritten or migrated across unrelated teams.
  for (const entry of legacy) {
    const trajectory = await readInspectionTrajectory(root, entry), metadata = makeTeamMetadata(trajectory);
    const members = new Map(metadata.members.map(member => [member.key, member]));
    for (const sources of team.members.values()) for (const source of sources) {
      if (source.entry.id === entry.id) source.metadata = members.get(source.player.key);
    }
  }
}

export async function queryTeamRoutes(root, catalogPath, teamId, stage, { cursor = "" } = {}) {
  if (!validHash(teamId) || !Number.isInteger(stage) || stage < 0 || stage >= LIMITS.stages
    || (cursor && !validHash(cursor))) throw problem("invalid team/stage/cursor");
  const team = collectTeams(await loadIndex(root)).get(teamId);
  if (!team || !team.map.stages.some(value => value.index === stage)) throw problem("unknown public team/stage", 404);
  await hydrateLegacyTeam(root, team);
  const descriptor = teamDescriptor(team);
  const base = { teamId, groupId: team.groupId, stageIndex: stage, timeBasis: "recording-ms",
    teamRevision: digest(team.entries.map(entry => entry.id).sort()),
    summitCompleted: descriptor.summitCompleted, finisherKeys: descriptor.finisherKeys,
    stageCompleted: descriptor.stageSummaries.find(value => value.index === stage).completed,
    ...(await mapMatch(team.map, catalogPath)) };
  base.coordinateSpace = base.mapAlignment.status === "verified" ? "canonical-map-world-cm" : "recording-world-cm";
  const allMembers = [...team.members].sort(([a], [b]) => a.localeCompare(b));
  const after = cursor ? allMembers.findIndex(([key]) => key === cursor) + 1 : 0;
  if (cursor && !after) throw problem("unknown team page cursor");
  const selections = []; let estimatedPoints = 0, estimatedBytes = 0;
  for (let index = after; index < allMembers.length; index += 1) {
    const [key, sources] = allMembers[index], source = [...sources].sort((a, b) => sourceOrder(a, b, stage))[0];
    const summary = source.metadata?.stages?.find(value => value.index === stage);
    const points = summary?.pointCount ?? 0, bytes = 1024 + points * 64 + (summary?.breakCount ?? 0) * 12;
    // Pages contain whole members. The browser follows every cursor, so no late
    // member loses its route because an earlier member used the point budget.
    if (selections.length && (estimatedPoints + points > LIMITS.queryPoints || estimatedBytes + bytes > TEAM_LIMITS.pageBytes)) break;
    if (points > LIMITS.queryPoints || bytes > TEAM_LIMITS.pageBytes) throw problem("individual team route exceeds page capacity", 413);
    selections.push({ key, source }); estimatedPoints += points; estimatedBytes += bytes;
  }
  // Only chosen member observations are decompressed, never the entire searchable
  // index. Read one source at a time and never concatenate multiple recordings.
  const byUpload = new Map();
  for (const selection of selections) {
    const id = selection.source.entry.id;
    if (!byUpload.has(id)) byUpload.set(id, []);
    byUpload.get(id).push(selection);
  }
  const routes = []; let pointCount = 0;
  for (const group of byUpload.values()) {
    const entry = group[0].source.entry, trajectory = await readInspectionTrajectory(root, entry);
    const selected = trajectory.map.stages.find(value => value.index === stage);
    const players = new Map(trajectory.players.map(player => [player.key, player]));
    for (const { key } of group) {
      const player = players.get(key);
      if (!player || !selected) throw problem("stored team member unavailable", 503);
      const extracted = inspectTeamStage(trajectory, player, selected);
      const points = extracted.points;
      pointCount += points.length;
      routes.push({ id: digest({ teamId, upload: entry.id, playerKey: key, stage }), playerKey: key, name: player.name,
        uploadId: entry.id, difficulty: entry.difficulty, completion: extracted.completion,
        completed: extracted.completion === "complete", gameCompleted: extracted.gameCompleted,
        summitCompleted: playerSummitCompleted(trajectory, player),
        timeBasis: "recording-ms", ...(trajectory.runKey === team.scope && trajectory.timeOriginMs !== undefined
          ? { timeOriginMs: trajectory.timeOriginMs } : {}),
        points: alignedRoutePoints(points, base.mapAlignment),
        breaks: points.length ? extracted.breaks.filter(value => value <= points.at(-1)[0]) : [] });
    }
  }
  routes.sort((a, b) => a.playerKey.localeCompare(b.playerKey));
  return { ...base, routes, totalRouteCount: allMembers.length, pointCount, truncated: false,
    nextCursor: after + selections.length < allMembers.length ? selections.at(-1).key : null };
}
