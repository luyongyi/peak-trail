import { mkdir, readdir, readFile, writeFile, rename, link, unlink, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { LIMITS, problem, digest, validHash, validateTrajectory, difficultyInfo, groupId,
  extractStageRoutes, routeDedupeKey, dedupeRoutes, aggregateHeatmap } from "./trajectory-contract.mjs";
import { fitMapAlignment, alignedRoutePoints, validateMapAlignment } from "./map-alignment.mjs";

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
export async function ingestUpload(root, compressed, catalogPath) {
  if (compressed.byteLength > LIMITS.compressedBytes) throw problem("compressed body exceeds 12 MiB", 413);
  let decoded;
  try { decoded = gunzipSync(compressed, { maxOutputLength: LIMITS.decodedBytes }); }
  catch (error) { throw problem(error.code === "ERR_BUFFER_TOO_LARGE" ? "decoded body exceeds 64 MiB" : "invalid gzip body", error.code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400); }
  let raw;
  try { raw = JSON.parse(decoded.toString("utf8")); } catch { throw problem("invalid trajectory JSON"); }
  const { trajectory, totalPoints } = validateTrajectory(raw);
  const canonical = JSON.stringify(trajectory), id = digest(canonical), path = join(root, "index", `${id}.json`);
  await setup(root);
  try { const existing = await readJson(path); return uploadReceipt(existing, true, catalogPath); } catch (error) { if (error.code !== "ENOENT") throw problem("existing upload index is damaged", 503); }
  const index = await loadIndex(root);
  const occupiedBytes = await physicalBytes(root);
  if (index.length >= LIMITS.uploads || occupiedBytes + compressed.byteLength * 3 > LIMITS.storedBytes) throw problem("route storage capacity reached", 503);
  const stored = gzipSync(canonical, { level: 6 });
  let storedBytes = stored.byteLength;
  const routeFiles = [];
  const entry = { version: 1, id, groupId: groupId(trajectory.map), recordingId: trajectory.recordingId, receivedUtc: new Date().toISOString(),
    moderationStatus: "pending", map: trajectory.map, difficulty: difficultyInfo(trajectory.difficulty), durationMs: trajectory.durationMs,
    playerCount: trajectory.players.length, pointCount: totalPoints, players: [], routes: [], storedBytes: 0 };
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
    if (error.code === "EEXIST") return uploadReceipt(await readJson(path), true, catalogPath);
    let committed = false; try { committed = (await readJson(path)).id === id; } catch { /* no committed index */ }
    if (!committed) for (const file of created) await unlink(file).catch(() => {});
    throw error;
  }
  return uploadReceipt(entry, false, catalogPath);
}
async function uploadReceipt(entry, duplicate, catalogPath) {
  return { uploadId: entry.id, duplicate, moderationStatus: entry.moderationStatus, ...(await mapMatch(entry.map, catalogPath)),
    stages: entry.players.map((player) => ({ playerKey: player.key, stages: player.stages })) };
}

export async function moderate(root, id, status) {
  if (!validHash(id) || !["approved", "hidden", "rejected", "pending"].includes(status)) throw problem("invalid moderation command");
  const path = join(root, "index", `${id}.json`);
  let entry; try { entry = await readJson(path); } catch (error) { throw problem(error.code === "ENOENT" ? "unknown upload" : "damaged upload", 404); }
  entry.moderationStatus = status; entry.reviewedUtc = new Date().toISOString();
  await atomicJson(path, entry);
  // Queries read current approval and recompute aggregates; hiding takes effect on the
  // next request, without stale public heatmap contributions or a restart.
  return { uploadId: id, moderationStatus: status };
}
async function publicGroups(root) {
  const groups = new Map();
  for (const entry of await loadIndex(root)) {
    if (entry.moderationStatus !== "approved" || !entry.routes.length) continue;
    if (!groups.has(entry.groupId)) groups.set(entry.groupId, { id: entry.groupId, map: entry.map, routes: [] });
    groups.get(entry.groupId).routes.push(...entry.routes);
  }
  for (const group of groups.values()) group.routes = dedupeRoutes(group.routes);
  return groups;
}
export async function listGroups(root, catalogPath) {
  const groups = [];
  for (const group of (await publicGroups(root)).values()) {
    groups.push({ id: group.id, map: group.map, ...(await mapMatch(group.map, catalogPath)),
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
export async function queryRoutes(root, catalogPath, group, stage, difficulty, limit = 200, heat = false) {
  if (!validHash(group) || !Number.isInteger(stage) || stage < 0 || stage >= LIMITS.stages) throw problem("invalid route group/stage");
  const chosen = (await publicGroups(root)).get(group);
  if (!chosen || !chosen.map.stages.some((entry) => entry.index === stage)) throw problem("unknown public route group/stage", 404);
  const candidates = chosen.routes.filter((route) => route.stageIndex === stage && (!difficulty || route.difficulty.key === difficulty));
  const base = { groupId: group, stageIndex: stage, ...(await mapMatch(chosen.map, catalogPath)), totalRouteCount: candidates.length };
  base.coordinateSpace = base.mapAlignment.status === "verified" ? "canonical-map-world-cm" : "recording-world-cm";
  const readAligned = async route => {
    const data = await readRoute(root, route);
    return { ...data, points: alignedRoutePoints(data.points, base.mapAlignment) };
  };
  if (heat) {
    const counts = new Map();
    for (const route of candidates) {
      // Each complete individual attempt contributes at most one visit to a voxel.
      const cells = aggregateHeatmap([(await readAligned(route)).points]);
      for (const [x, y, z, count] of cells) { const key = `${x},${y},${z}`; counts.set(key, (counts.get(key) ?? 0) + count); }
      if (counts.size > LIMITS.heatCells) throw problem("heatmap capacity exceeded", 413);
    }
    return { ...base, cellSizeCm: 200, heightBandCm: 200, routeCount: candidates.length,
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
