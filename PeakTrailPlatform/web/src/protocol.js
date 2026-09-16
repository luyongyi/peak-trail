import { normalizeRoute } from "./map-route.js";
import { normalizeWorldRecord, buildWorldTimeline } from "./world-timeline.js";

export class ProtocolError extends Error {
  constructor(message, detail = "") {
    super(message);
    this.name = "ProtocolError";
    this.detail = detail;
  }
}

const REQUIRED_COORDINATE_SPACE = "unity-world-meters";
const HEIGHT_ENCODING = "float32-le-row-major-minz-minx";
const TEXTURE_UV = "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)";
const IMAGE_ORIGIN = "bottom-left-in-uv;viewer-flips-for-top-left-images";
const SAMPLE_LOCATION = "cell-centers";
const SUPPORTED_MAP_PACK_IDENTITY_VERSIONS = [2, 3];
const GEOMETRY_FORMATS = ["glb-instanced-v1", "glb-instanced-v1+gzip"];
const MAP_PACK_ID_PATTERN = /^sha256-[a-f0-9]{64}$/;

function validateLayerGeometry(layer, identityVersion) {
  if (identityVersion === 2) {
    if (typeof layer.geometry === "string" || ["geometrySha256", "geometryFormat"].some((field) => Object.hasOwn(layer, field))) {
      throw new ProtocolError("identityVersion 2 不能携带未签名的真实几何，请使用 identityVersion 3");
    }
    return;
  }
  if (typeof layer.geometry !== "string" || !/^[a-zA-Z0-9_./-]+\.glb(?:\.gz)?$/.test(layer.geometry)
      || layer.geometry.startsWith("/") || layer.geometry.split("/").includes("..")) {
    throw new ProtocolError("geometry 必须是地图包内的相对 .glb 或 .glb.gz 路径");
  }
  if (!/^[a-f0-9]{64}$/.test(layer.geometrySha256 || "")) throw new ProtocolError("geometrySha256 无效");
  if (!GEOMETRY_FORMATS.includes(layer.geometryFormat)) throw new ProtocolError(`geometryFormat 必须是 ${GEOMETRY_FORMATS.join(" 或 ")}`);
  if (layer.geometry.endsWith(".gz") !== (layer.geometryFormat === "glb-instanced-v1+gzip")) throw new ProtocolError("geometry 文件名必须与 geometryFormat 压缩格式匹配");
}

/** Browser equivalent of tools/lib/map-pack-identity.mjs; cross-runtime vectors guard byte parity. */
export function canonicalMapPackIdentity(manifest) {
  const integer = (value, key, min, max = null) => {
    if (!(typeof value === "number" && Number.isSafeInteger(value))
        && !(typeof value === "string" && /^(0|[1-9]\d*)$/.test(value))) throw new ProtocolError(`${key} 必须是整数`);
    const number = BigInt(value);
    if (number < BigInt(min) || (max !== null && number > BigInt(max))) throw new ProtocolError(`${key} 超出范围`);
    return String(number);
  };
  const version = Number(integer(manifest.identityVersion, "identityVersion", 2, 3));
  const chunks = [`peaktrail-map-pack-identity-v${version}\n`];
  const utf8 = new TextEncoder();
  const str = (key, value, nonempty = false) => {
    if (typeof value !== "string" || (nonempty && !value.length)) throw new ProtocolError(`${key} 必须是字符串`);
    chunks.push(`${key}=${utf8.encode(value).byteLength}:${value}\n`);
  };
  const int = (key, value, min, max = null) => chunks.push(`${key}=${integer(value, key, min, max)}\n`);
  const sha = (key, value) => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ProtocolError(`${key} 必须是小写 SHA-256`);
    chunks.push(`${key}=${value}\n`);
  };
  const float = (key, value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new ProtocolError(`${key} 必须是有限 float32`);
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    chunks.push(`${key}=f32:${view.getUint32(0, true).toString(16).padStart(8, "0")}\n`);
  };
  if (!Array.isArray(manifest.layers) || !manifest.layers.length) throw new ProtocolError("地图缺少 layers");
  const layers = [...manifest.layers].sort((a, b) => Number(integer(a.segment, "segment", 0)) - Number(integer(b.segment, "segment", 0)));
  if (new Set(layers.map((layer) => integer(layer.segment, "segment", 0))).size !== layers.length) throw new ProtocolError("地图有重复 segment");
  int("identityVersion", manifest.identityVersion, 2, 3);
  int("schemaVersion", manifest.schemaVersion, 1, 1);
  int("projectionVersion", manifest.projectionVersion, 1);
  str("coordinateSpace", manifest.coordinateSpace);
  str("textureUv", manifest.textureUv);
  str("imageOrigin", manifest.imageOrigin);
  str("gameVersion", manifest.gameVersion, true);
  int("gameBuildId", manifest.gameBuildId, 0);
  str("sceneName", manifest.sceneName, true);
  int("mapSlot", manifest.mapSlot, 0);
  int("layerCount", layers.length, 1);
  for (const [index, layer] of layers.entries()) {
    validateLayerGeometry(layer, version);
    const prefix = `layer.${index}`;
    str(`${prefix}.id`, layer.id, true);
    int(`${prefix}.segment`, layer.segment, 0);
    str(`${prefix}.biome`, layer.biome, true);
    str(`${prefix}.texture`, layer.texture, true);
    sha(`${prefix}.textureSha256`, layer.textureSha256);
    str(`${prefix}.height`, layer.height, true);
    for (const field of ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"]) float(`${prefix}.${field}`, layer[field]);
    int(`${prefix}.columns`, layer.columns, 2);
    int(`${prefix}.rows`, layer.rows, 2);
    str(`${prefix}.heightEncoding`, layer.heightEncoding, true);
    str(`${prefix}.noData`, layer.noData, true);
    str(`${prefix}.sampleLocation`, layer.sampleLocation, true);
    sha(`${prefix}.heightSha256`, layer.heightSha256);
    if (version === 3) {
      str(`${prefix}.geometry`, layer.geometry, true);
      sha(`${prefix}.geometrySha256`, layer.geometrySha256);
      str(`${prefix}.geometryFormat`, layer.geometryFormat, true);
    }
  }
  return chunks.join("");
}

async function verifyMapPackIdentityV3(manifest) {
  const canonical = canonicalMapPackIdentity(manifest);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const expected = `sha256-${[...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  if (manifest.mapPackId !== expected) throw new ProtocolError("地图包身份校验失败", `mapPackId 不匹配：${expected}`);
}

function basename(path) {
  return String(path || "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .pop() || "";
}

function normalizedPath(path) {
  return String(path || "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function asFiniteNumber(value, fallback = null) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return isFiniteNumber(number) ? number : fallback;
}

function asId(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function asLayerSegment(value) {
  const number = asFiniteNumber(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function asActiveSegment(value, fallback = null) {
  const number = asFiniteNumber(value, fallback);
  return Number.isInteger(number) ? number : null;
}

function parsePosition(record) {
  const value = record.pos ?? record.position ?? record.worldPosition;
  if (Array.isArray(value) && value.length >= 3) {
    const result = value.slice(0, 3).map((part) => asFiniteNumber(part));
    return result.every(isFiniteNumber) ? result : null;
  }
  if (value && typeof value === "object") {
    const result = [asFiniteNumber(value.x), asFiniteNumber(value.y), asFiniteNumber(value.z)];
    return result.every(isFiniteNumber) ? result : null;
  }
  const result = [asFiniteNumber(record.x), asFiniteNumber(record.y), asFiniteNumber(record.z)];
  return result.every(isFiniteNumber) ? result : null;
}

function identifyTimeScale(manifest) {
  const unit = String(manifest.timeUnit || "milliseconds").toLowerCase();
  if (["millisecond", "milliseconds", "ms"].includes(unit)) return 0.001;
  if (["second", "seconds", "s"].includes(unit)) return 1;
  throw new ProtocolError(`不支持的时间单位：${manifest.timeUnit}`, "v1 使用 milliseconds。 ");
}

export class FileBundle {
  constructor(fileList) {
    this.files = Array.from(fileList || []);
    this.urls = [];
    this.index = new Map();
    for (const file of this.files) {
      const relative = normalizedPath(file.webkitRelativePath || file.name);
      const name = normalizedPath(file.name);
      this.index.set(relative, file);
      this.index.set(name, file);
    }
  }

  resolve(reference) {
    if (!reference) return null;
    const key = normalizedPath(reference);
    if (this.index.has(key)) return this.index.get(key);
    const wantedName = basename(key).toLowerCase();
    const matches = this.files.filter((file) => basename(file.name).toLowerCase() === wantedName);
    if (matches.length === 1) return matches[0];
    return null;
  }

  makeUrl(file) {
    const url = URL.createObjectURL(file);
    this.urls.push(url);
    return url;
  }

  dispose() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.length = 0;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await file.text());
  } catch (error) {
    throw new ProtocolError(`${file.name} 不是有效的 JSON`, error.message);
  }
}

async function findJsonByShape(files, predicate, preferredPattern) {
  const candidates = files.filter((file) => file.name.toLowerCase().endsWith(".json"));
  candidates.sort((a, b) => {
    const aPreferred = preferredPattern.test(a.name) ? 0 : 1;
    const bPreferred = preferredPattern.test(b.name) ? 0 : 1;
    return aPreferred - bPreferred;
  });

  for (const file of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      continue;
    }
    if (predicate(parsed)) return { file, parsed };
  }
  return null;
}

async function readNdjson(file) {
  const records = [];
  const rejected = [];
  let lineNumber = 0;

  const acceptLine = (line) => {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      rejected.push({ line: lineNumber, message: error.message });
    }
  };

  if (file.stream && typeof TextDecoderStream !== "undefined") {
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) acceptLine(line);
    }
    if (pending.trim()) acceptLine(pending);
  } else {
    for (const line of (await file.text()).split(/\r?\n/)) acceptLine(line);
  }

  return { records, rejected };
}

function normalizeManifest(raw) {
  if (!raw || typeof raw !== "object") {
    throw new ProtocolError("manifest 必须是一个 JSON 对象");
  }
  if (raw.schemaVersion !== 1) {
    throw new ProtocolError(`不支持的足迹协议版本：${raw.schemaVersion ?? "未声明"}`, "当前只接受 schemaVersion 1。");
  }
  if (!raw.sessionId) throw new ProtocolError("manifest 缺少 sessionId");
  if (!raw.sceneName) throw new ProtocolError("manifest 缺少 sceneName");
  if (raw.coordinateSpace !== REQUIRED_COORDINATE_SPACE) {
    throw new ProtocolError(
      `不支持的轨迹坐标系：${raw.coordinateSpace ?? "未声明"}`,
      `查看器只接受 ${REQUIRED_COORDINATE_SPACE}。`,
    );
  }
  if (raw.identityMode && raw.identityMode !== "platform-user-id") {
    throw new ProtocolError(
      `不支持的身份模式：${raw.identityMode}`,
      "本项目要求记录真实、稳定的平台用户 ID。",
    );
  }
  const projectionVersion = asFiniteNumber(raw.projectionVersion);
  if (raw.projectionVersion !== undefined
      && (!Number.isInteger(projectionVersion) || projectionVersion < 1)) {
    throw new ProtocolError(`无效的足迹投影版本：${raw.projectionVersion}`);
  }
  const segmentResolution = String(raw.segmentResolution || "legacy-global-current");
  if (!["unassigned", "position-inferred-v1", "legacy-global-current"].includes(segmentResolution)) {
    throw new ProtocolError(`不支持的分层解析模式：${segmentResolution}`);
  }
  return {
    ...raw,
    schemaVersion: 1,
    sessionId: String(raw.sessionId),
    runId: asId(raw.runId),
    sceneName: String(raw.sceneName),
    gameVersion: raw.gameVersion ? String(raw.gameVersion) : null,
    gameBuildId: asId(raw.gameBuildId),
    mapPackId: asId(raw.mapPackId),
    mapSlot: asFiniteNumber(raw.mapSlot),
    levelIndex: asFiniteNumber(raw.levelIndex),
    projectionVersion,
    coordinateSpace: raw.coordinateSpace,
    positionAuthority: raw.positionAuthority || "xyz",
    segmentResolution,
    route: normalizeRoute(raw.route),
    activeSegmentSemantics: raw.activeSegmentSemantics || "global-maphandler-segments-index",
    identityMode: raw.identityMode || "platform-user-id",
    timeUnit: raw.timeUnit || "milliseconds",
  };
}

function participantFromRecord(record, fallbackId = null) {
  if (!record || typeof record !== "object") return null;
  const id = asId(
    record.playerId ?? record.stableId ?? record.platformUserId ?? record.steamId ?? record.id ?? fallbackId,
  );
  if (!id) return null;
  return {
    id,
    nickname: String(record.nickname ?? record.displayName ?? record.name ?? id),
    actorNumber: asFiniteNumber(record.actorNumber),
    platform: record.platform ? String(record.platform) : null,
  };
}

function participantRecords(source) {
  if (Array.isArray(source)) return source.map((record) => ({ record, fallbackId: null }));
  if (!source || typeof source !== "object") return [];
  return Object.entries(source).map(([fallbackId, record]) => ({ record, fallbackId }));
}

function normalizeEventName(value) {
  return String(value || "event").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function normalizeItem(record) {
  const raw = record.item ?? record.heldItem ?? record.heldItemName ?? record.carriedItem;
  if (raw === undefined) return { captured: false, value: null };
  if (raw === null || raw === "") return { captured: true, value: null };
  if (typeof raw === "string" || typeof raw === "number") {
    const name = String(raw);
    return {
      captured: true,
      value: {
        id: name,
        itemId: name,
        prefabName: null,
        name,
        slot: asFiniteNumber(record.itemSlot),
        count: null,
      },
    };
  }
  if (typeof raw !== "object") return { captured: true, value: null };
  const itemId = asId(raw.itemId ?? raw.id);
  const prefabName = asId(raw.prefabName ?? raw.prefab);
  const id = asId(itemId ?? prefabName ?? raw.nameKey ?? raw.name);
  const name = asId(raw.displayName ?? raw.name ?? raw.itemName ?? raw.nameKey ?? raw.prefabName ?? id);
  if (!id && !name) return { captured: true, value: null };
  return {
    captured: true,
    value: {
      id: id || name,
      itemId,
      prefabName,
      name: name || id,
      slot: asFiniteNumber(raw.slot ?? record.itemSlot),
      count: asFiniteNumber(raw.count ?? raw.quantity),
    },
  };
}

function appearanceIndex(value) {
  const number = asFiniteNumber(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function appearanceColor(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const parts = value.slice(0, 4).map((part) => asFiniteNumber(part));
  if (!parts.slice(0, 3).every(isFiniteNumber)) return null;
  if (parts.length === 3 || parts[3] === null) parts[3] = 1;
  if (!parts.every(isFiniteNumber)) return null;
  const scale = parts.some((part) => part > 1) && parts.every((part) => part >= 0 && part <= 255)
    ? 255
    : 1;
  return parts.map((part) => Math.min(1, Math.max(0, part / scale)));
}

function normalizeAppearance(record) {
  const nested = record.appearance && typeof record.appearance === "object"
    ? record.appearance
    : null;
  const raw = nested || record;
  const ready = typeof raw.ready === "boolean"
    ? raw.ready
    : typeof record.appearanceReady === "boolean" ? record.appearanceReady : null;
  const appearance = {
    ready,
    authority: asId(raw.authority ?? record.authority),
    source: asId(raw.source ?? record.appearanceSource),
    skinIndex: appearanceIndex(raw.skinIndex),
    eyesIndex: appearanceIndex(raw.eyesIndex ?? raw.eyeIndex),
    mouthIndex: appearanceIndex(raw.mouthIndex),
    accessoryIndex: appearanceIndex(raw.accessoryIndex),
    outfitIndex: appearanceIndex(raw.outfitIndex ?? raw.fitIndex),
    hatIndex: appearanceIndex(raw.hatIndex),
    effectiveHatIndex: appearanceIndex(raw.effectiveHatIndex ?? raw.resolvedHatIndex),
    sashIndex: appearanceIndex(raw.sashIndex),
    medalIndex: appearanceIndex(raw.medalIndex),
    outfitName: asId(raw.outfitName ?? raw.fitName),
    hatName: asId(raw.hatName),
    skinColor: appearanceColor(raw.skinColor ?? raw.color),
  };
  appearance.captured = Boolean(
    nested
    || ready !== null
    || appearance.authority
    || appearance.source
    || appearance.skinColor
    || [
      appearance.skinIndex,
      appearance.eyesIndex,
      appearance.mouthIndex,
      appearance.accessoryIndex,
      appearance.outfitIndex,
      appearance.hatIndex,
      appearance.effectiveHatIndex,
      appearance.sashIndex,
      appearance.medalIndex,
    ].some((value) => value !== null),
  );
  return appearance;
}

function readTelemetry(record) {
  const item = normalizeItem(record);
  const stamina = asFiniteNumber(record.stamina ?? record.staminaValue ?? record.energy);
  const maxStamina = asFiniteNumber(record.maxStamina ?? record.staminaMax ?? record.maxEnergy);
  const stamina01 = asFiniteNumber(record.stamina01 ?? record.staminaNormalized);
  const extraStamina = asFiniteNumber(
    record.extraStamina ?? record.extraStaminaValue ?? record.bonusStamina,
  );
  const maxExtraStamina = asFiniteNumber(
    record.maxExtraStamina ?? record.extraStaminaMax ?? record.maxBonusStamina,
  );
  const extraStamina01 = asFiniteNumber(
    record.extraStamina01 ?? record.extraStaminaNormalized ?? record.bonusStamina01,
  );
  const totalStamina = asFiniteNumber(record.totalStamina);
  const ready = typeof record.telemetryReady === "boolean" ? record.telemetryReady : null;
  const captured = ready !== null || item.captured || [
    stamina,
    maxStamina,
    stamina01,
    extraStamina,
    maxExtraStamina,
    extraStamina01,
    totalStamina,
  ].some((value) => value !== null);
  return {
    captured,
    item: item.value,
    itemCaptured: item.captured,
    stamina,
    maxStamina,
    stamina01,
    extraStamina,
    maxExtraStamina,
    extraStamina01,
    totalStamina,
    ready,
    authority: record.authority ? String(record.authority) : null,
  };
}

function normalizeInventory(record) {
  const ready = typeof record.inventoryReady === "boolean" ? record.inventoryReady : null;
  const heldProbe = normalizeItem({ item: record.held });
  const heldCaptured = Object.hasOwn(record, "held") || typeof record.heldPresent === "boolean";
  const heldPresent = typeof record.heldPresent === "boolean"
    ? record.heldPresent
    : Boolean(heldProbe.value);
  const slots = Array.isArray(record.slots) ? record.slots.map((slot, index) => {
    const itemProbe = normalizeItem({ item: slot?.item });
    return {
      location: String(slot?.location ?? "inventory"),
      container: asId(slot?.container),
      index: asFiniteNumber(slot?.index, index),
      slotId: asId(slot?.slotId),
      empty: slot?.empty === true || slot?.item === null,
      item: itemProbe.value,
    };
  }) : [];
  const hasNestedBackpackSlots = slots.some((slot) => {
    const location = slot.location.toLowerCase();
    return location === "backpack" || location.startsWith("backpack/");
  });
  const backpackContentsPresent = typeof record.backpackContentsPresent === "boolean"
    ? record.backpackContentsPresent
    : hasNestedBackpackSlots;
  const backpackContentsReady = typeof record.backpackContentsReady === "boolean"
    ? record.backpackContentsReady
    : hasNestedBackpackSlots;
  return {
    captured: ready !== null || heldCaptured || slots.length > 0,
    ready,
    authority: record.authority ? String(record.authority) : null,
    selectedSlotKnown: record.selectedSlotKnown === true,
    selectedSlot: asFiniteNumber(record.selectedSlot),
    backpackContentsPresent,
    backpackContentsReady,
    heldCaptured,
    heldPresent,
    held: heldPresent ? heldProbe.value : null,
    slots,
  };
}

function filePath(file) {
  return normalizedPath(file?.webkitRelativePath || file?.name || "");
}

function directoryOf(path) {
  const normalized = normalizedPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

function isTraceStream(file) {
  const name = String(file?.name || "").toLowerCase();
  return name.includes("stream") && (name.includes(".ndjson") || name.endsWith(".partial"));
}

async function loadSingleTrace(bundle, manifestMatch, streamFiles, parsedStreams = null) {
  const manifest = normalizeManifest(manifestMatch.parsed);
  const timeScale = identifyTimeScale(manifest);
  const participants = new Map();
  const tracks = new Map();
  const telemetryTracks = new Map();
  const inventoryTracks = new Map();
  const appearanceTracks = new Map();
  const routeTracks = [];
  const worldRecords = [];
  const events = [];
  const warnings = [];
  let acceptedSamples = 0;
  let telemetrySamples = 0;
  let itemSamples = 0;
  let staminaSamples = 0;
  let extraStaminaSamples = 0;
  let appearanceSamples = 0;
  const hasPositionSegments = manifest.segmentResolution === "position-inferred-v1";

  if (manifest.segmentResolution === "legacy-global-current") {
    warnings.push(
      "旧版轨迹的 segment 来自全局 MapHandler，不能证明远端玩家所属分层；已保守地只按 XYZ 回放。",
    );
  } else if (manifest.segmentResolution === "unassigned") {
    warnings.push("轨迹未猜测逐玩家分层；XYZ 坐标是权威，底图分层筛选时仍保留未分配轨迹的原始 XYZ。");
  }

  // Merge the legacy players alias first, then let v1 participants override it.
  // Object-form legacy data often stores the stable ID only in the object key.
  const suppliedPlayers = [
    ...participantRecords(manifest.players),
    ...participantRecords(manifest.participants),
  ];
  for (const { record, fallbackId } of suppliedPlayers) {
    const participant = participantFromRecord(record, fallbackId);
    if (participant) participants.set(participant.id, participant);
  }

  for (let streamIndex = 0; streamIndex < streamFiles.length; streamIndex += 1) {
    const streamFile = streamFiles[streamIndex];
    const parsed = parsedStreams?.[streamIndex] || await readNdjson(streamFile);
    if (parsed.rejected.length) {
      warnings.push(`${streamFile.name} 有 ${parsed.rejected.length} 行未能解析`);
    }

    for (const record of parsed.records) {
      if (!record || typeof record !== "object") continue;
      const type = String(record.type ?? record.kind ?? "").toLowerCase();

      if (type === "participant" || type === "player") {
        const participant = participantFromRecord(record);
        if (participant) participants.set(participant.id, participant);
        continue;
      }

      const rawTime = asFiniteNumber(record.t ?? record.time ?? record.timestamp);
      if (rawTime === null || rawTime < 0) continue;
      const t = rawTime * timeScale;

      if (type === "world_snapshot" || type === "world_delta") {
        const worldRecord = normalizeWorldRecord(record, t);
        if (worldRecord) worldRecords.push(worldRecord);
        continue;
      }

      if (type === "route") {
        const route = normalizeRoute(record.route);
        if (route) routeTracks.push({ t, rawT: rawTime, route });
        else warnings.push("一条关卡分支记录无效，未采用该记录。");
        continue;
      }

      if (type === "state") {
        const playerId = asId(record.playerId ?? record.stableId ?? record.platformUserId ?? record.id);
        if (!playerId) continue;
        if (!participants.has(playerId)) {
          participants.set(playerId, {
            id: playerId,
            nickname: String(record.nickname ?? record.displayName ?? playerId),
            actorNumber: asFiniteNumber(record.actorNumber),
            platform: record.platform ? String(record.platform) : null,
          });
        }
        const telemetry = readTelemetry(record);
        if (!telemetryTracks.has(playerId)) telemetryTracks.set(playerId, []);
        telemetryTracks.get(playerId).push({ t, rawT: rawTime, telemetry });
        if (telemetry.captured) telemetrySamples += 1;
        if (telemetry.itemCaptured) itemSamples += 1;
        if (telemetry.stamina !== null || telemetry.stamina01 !== null) staminaSamples += 1;
        if (telemetry.extraStamina !== null || telemetry.extraStamina01 !== null) extraStaminaSamples += 1;
        continue;
      }

      if (type === "inventory") {
        const playerId = asId(record.playerId ?? record.stableId ?? record.platformUserId ?? record.id);
        if (!playerId) continue;
        if (!participants.has(playerId)) {
          participants.set(playerId, {
            id: playerId,
            nickname: String(record.nickname ?? record.displayName ?? playerId),
            actorNumber: asFiniteNumber(record.actorNumber),
            platform: record.platform ? String(record.platform) : null,
          });
        }
        const inventory = normalizeInventory(record);
        if (!inventoryTracks.has(playerId)) inventoryTracks.set(playerId, []);
        inventoryTracks.get(playerId).push({ t, rawT: rawTime, inventory });
        if (inventory.captured) itemSamples += 1;
        continue;
      }

      if (type === "appearance") {
        const playerId = asId(record.playerId ?? record.stableId ?? record.platformUserId ?? record.id);
        if (!playerId) continue;
        if (!participants.has(playerId)) {
          participants.set(playerId, {
            id: playerId,
            nickname: String(record.nickname ?? record.displayName ?? playerId),
            actorNumber: asFiniteNumber(record.actorNumber),
            platform: record.platform ? String(record.platform) : null,
          });
        }
        const appearance = normalizeAppearance(record);
        if (!appearanceTracks.has(playerId)) appearanceTracks.set(playerId, []);
        appearanceTracks.get(playerId).push({ t, rawT: rawTime, appearance });
        if (appearance.captured) appearanceSamples += 1;
        continue;
      }

      if (type === "sample" || type === "position" || (!type && parsePosition(record))) {
        const playerId = asId(record.playerId ?? record.stableId ?? record.platformUserId ?? record.id);
        const pos = parsePosition(record);
        if (!playerId || !pos) continue;

        if (!participants.has(playerId)) {
          participants.set(playerId, {
            id: playerId,
            nickname: String(record.nickname ?? record.displayName ?? playerId),
            actorNumber: asFiniteNumber(record.actorNumber),
            platform: record.platform ? String(record.platform) : null,
          });
        }

        if (!tracks.has(playerId)) tracks.set(playerId, []);
        const recordedSegment = asLayerSegment(record.segment ?? record.layer);
        const telemetry = readTelemetry(record);
        tracks.get(playerId).push({
          t,
          rawT: rawTime,
          playerId,
          pos,
          yaw: asFiniteNumber(record.yaw ?? record.rotationY, 0),
          segment: hasPositionSegments ? recordedSegment : null,
          activeSegment: asActiveSegment(
            record.activeSegment,
            hasPositionSegments ? null : recordedSegment,
          ),
          telemetry,
        });
        if (telemetry.captured) telemetrySamples += 1;
        if (telemetry.itemCaptured) itemSamples += 1;
        if (telemetry.stamina !== null || telemetry.stamina01 !== null) staminaSamples += 1;
        if (telemetry.extraStamina !== null || telemetry.extraStamina01 !== null) extraStaminaSamples += 1;
        acceptedSamples += 1;
        continue;
      }

      if (type === "event" || record.event) {
        const playerId = asId(record.playerId ?? record.stableId ?? record.platformUserId);
        const recordedSegment = asLayerSegment(record.segment ?? record.layer);
        events.push({
          type: normalizeEventName(record.event ?? record.name ?? record.eventType),
          t,
          rawT: rawTime,
          playerId,
          pos: parsePosition(record),
          segment: hasPositionSegments ? recordedSegment : null,
          activeSegment: asActiveSegment(
            record.activeSegment,
            hasPositionSegments ? null : recordedSegment,
          ),
          label: record.label ? String(record.label) : null,
          item: normalizeItem(record).value,
          detail: record.detail && typeof record.detail === "object" ? record.detail : null,
          source: record.source ? String(record.source) : null,
          confidence: record.confidence ? String(record.confidence) : null,
          fromLocation: record.fromLocation ? String(record.fromLocation) : null,
          toLocation: record.toLocation ? String(record.toLocation) : null,
          objectId: typeof record.objectId === "string" ? record.objectId : null,
          kind: type === "world_event" ? record.kind : null,
          radius: asFiniteNumber(record.radius),
        });
      }
    }
  }

  if (!acceptedSamples) {
    throw new ProtocolError("轨迹中没有可用的位置采样", "sample 记录需要 t、playerId、pos:[x,y,z]。");
  }

  for (const samples of tracks.values()) samples.sort((a, b) => a.t - b.t);
  for (const samples of telemetryTracks.values()) samples.sort((a, b) => a.t - b.t);
  for (const samples of inventoryTracks.values()) samples.sort((a, b) => a.t - b.t);
  for (const samples of appearanceTracks.values()) samples.sort((a, b) => a.t - b.t);
  events.sort((a, b) => a.t - b.t);
  routeTracks.sort((a, b) => a.t - b.t);
  const duration = Math.max(
    asFiniteNumber(manifest.durationMs, 0) * 0.001,
    asFiniteNumber(manifest.durationSeconds, 0),
    ...events.map((event) => event.t),
    ...Array.from(tracks.values(), (samples) => samples.at(-1)?.t || 0),
    ...Array.from(telemetryTracks.values(), (samples) => samples.at(-1)?.t || 0),
    ...Array.from(inventoryTracks.values(), (samples) => samples.at(-1)?.t || 0),
    ...Array.from(appearanceTracks.values(), (samples) => samples.at(-1)?.t || 0),
    ...worldRecords.map((record) => record.t),
  );

  const allPositions = Array.from(tracks.values()).flatMap((samples) => samples.map((sample) => sample.pos));
  const bounds = getPointBounds(allPositions);

  return {
    manifest,
    manifestFileName: manifestMatch.file.name,
    streamFileNames: streamFiles.map((file) => file.name),
    participants: Array.from(participants.values()),
    tracks,
    telemetryTracks,
    inventoryTracks,
    appearanceTracks,
    routeTracks,
    worldTimeline: buildWorldTimeline(worldRecords),
    events,
    duration,
    sampleCount: acceptedSamples,
    bounds,
    warnings,
    telemetry: {
      captured: telemetrySamples > 0,
      sampleCount: telemetrySamples,
      hasItems: itemSamples > 0,
      hasStamina: staminaSamples > 0,
      hasExtraStamina: extraStaminaSamples > 0,
      hasAppearance: appearanceSamples > 0,
    },
  };
}

export async function loadTraceBundle(fileList) {
  const bundle = fileList instanceof FileBundle ? fileList : new FileBundle(fileList);
  const manifestMatch = await findJsonByShape(
    bundle.files,
    (value) => Boolean(value && value.sessionId && value.sceneName),
    /^manifest(?:\.partial)?\.json$/i,
  );
  if (!manifestMatch) {
    throw new ProtocolError(
      "没有找到轨迹 manifest",
      "请选择 manifest.json（或 manifest.partial.json）与 stream.ndjson。",
    );
  }
  const streamFiles = bundle.files.filter(isTraceStream);
  if (!streamFiles.length) {
    throw new ProtocolError(
      "没有找到轨迹数据流",
      "请选择 stream.ndjson 或 stream.ndjson.partial。",
    );
  }
  return loadSingleTrace(bundle, manifestMatch, streamFiles);
}

function sessionFileToken(value) {
  return normalizedPath(value)
    .replace(/manifest|stream|\.ndjson|\.partial|\.json/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function localDateKey(isoValue, timeZone) {
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) return "日期未知";
  if (!timeZone) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function groupTraceSessions(sessions, { timeZone } = {}) {
  const groups = new Map();
  for (const session of sessions || []) {
    const date = localDateKey(session?.manifest?.startedAtUtc, timeZone);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(session);
  }
  return [...groups.entries()]
    .map(([date, dateSessions]) => ({
      date,
      sessions: dateSessions.sort((left, right) => {
        const leftTime = Date.parse(left.manifest.startedAtUtc || "") || 0;
        const rightTime = Date.parse(right.manifest.startedAtUtc || "") || 0;
        return rightTime - leftTime || left.manifest.sessionId.localeCompare(right.manifest.sessionId);
      }),
    }))
    .sort((left, right) => {
      if (left.date === "日期未知") return 1;
      if (right.date === "日期未知") return -1;
      return right.date.localeCompare(left.date);
    });
}

function virtualTextFile(name, contents) {
  return {
    name: basename(name),
    webkitRelativePath: name,
    async text() { return contents; },
  };
}

async function loadTraceJournal(file) {
  const parsed = await readNdjson(file);
  const journals = new Map();
  const activeJournalKeys = new Map();
  const warnings = parsed.rejected.length
    ? [`${file.name} 有 ${parsed.rejected.length} 行未能解析`]
    : [];
  for (const envelope of parsed.records) {
    if (!envelope || typeof envelope !== "object") continue;
    const type = String(envelope.type || "").toLowerCase();
    if (type === "session_start") {
      const rawManifest = envelope.manifest;
      const sessionId = asId(rawManifest?.sessionId ?? envelope.sessionId);
      if (!sessionId || !rawManifest || typeof rawManifest !== "object") continue;
      if (envelope.sessionId && rawManifest.sessionId
          && String(envelope.sessionId) !== String(rawManifest.sessionId)) {
        throw new ProtocolError(
          "历史日志的会话 ID 不一致",
          `session_start 信封 ${envelope.sessionId} / manifest ${rawManifest.sessionId}`,
        );
      }
      let journalKey = sessionId;
      let occurrence = 1;
      while (journals.has(journalKey)) {
        occurrence += 1;
        journalKey = `${sessionId}#${occurrence}`;
      }
      if (occurrence > 1) {
        warnings.push(`会话 ID ${sessionId} 重复；已保留为独立的第 ${occurrence} 段`);
      }
      journals.set(journalKey, {
        manifest: {
          ...rawManifest,
          sessionId: journalKey,
          sourceSessionId: occurrence > 1 ? sessionId : rawManifest.sourceSessionId,
        },
        records: [],
      });
      activeJournalKeys.set(sessionId, journalKey);
      continue;
    }
    const sessionId = asId(envelope.sessionId);
    const journalKey = sessionId ? activeJournalKeys.get(sessionId) : null;
    if (!journalKey || !journals.has(journalKey)) continue;
    const journal = journals.get(journalKey);
    if (type === "trace_record" && envelope.record && typeof envelope.record === "object") {
      journal.records.push(envelope.record);
    } else if (type === "session_end") {
      if (envelope.endedAtUtc) journal.manifest.endedAtUtc = envelope.endedAtUtc;
      if (asFiniteNumber(envelope.durationMs) !== null) journal.manifest.durationMs = envelope.durationMs;
      if (asFiniteNumber(envelope.durationSeconds) !== null) {
        journal.manifest.durationSeconds = envelope.durationSeconds;
      }
      if (envelope.status) journal.manifest.status = String(envelope.status);
      if (envelope.endReason) journal.manifest.endReason = String(envelope.endReason);
    }
  }
  const sessions = [];
  for (const [journalKey, journal] of journals) {
    const safeDirectory = journalKey.replace(/[^a-zA-Z0-9._-]/g, "_");
    const manifestFile = virtualTextFile(
      `journal/${safeDirectory}/manifest.json`,
      JSON.stringify(journal.manifest),
    );
    const streamFile = virtualTextFile(`journal/${safeDirectory}/stream.ndjson`, "");
    const virtualBundle = new FileBundle([manifestFile, streamFile]);
    try {
      sessions.push(await loadSingleTrace(
        virtualBundle,
        { file: manifestFile, parsed: journal.manifest },
        [streamFile],
        [{ records: journal.records, rejected: [] }],
      ));
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      if (error.message === "轨迹中没有可用的位置采样") {
        warnings.push(`历史日志中的会话 ${journalKey} 尚无位置采样，已跳过`);
        continue;
      }
      error.detail = [`历史日志中的会话 ${journalKey}`, error.detail].filter(Boolean).join(" · ");
      throw error;
    }
  }
  return {
    sessions,
    warnings,
  };
}

function preferFinalManifests(matches) {
  const chosen = new Map();
  for (const match of matches) {
    const key = `${directoryOf(filePath(match.file))}\u0000${String(match.parsed.sessionId)}`;
    const current = chosen.get(key);
    const isFinal = !match.file.name.toLowerCase().includes("partial");
    const currentIsFinal = current && !current.file.name.toLowerCase().includes("partial");
    if (!current || (isFinal && !currentIsFinal)) chosen.set(key, match);
  }
  return [...chosen.values()];
}

function streamMatchesForManifest(manifestMatch, streamFiles, claimed, manifestCount) {
  const available = streamFiles.filter((file) => !claimed.has(file));
  const manifestPath = filePath(manifestMatch.file);
  const manifestDirectory = directoryOf(manifestPath);
  const declaredStreams = [
    manifestMatch.parsed.streamFile,
    ...(Array.isArray(manifestMatch.parsed.streamFiles) ? manifestMatch.parsed.streamFiles : []),
  ].filter(Boolean);
  let matches = [];
  if (manifestDirectory) {
    matches = available.filter((file) => directoryOf(filePath(file)) === manifestDirectory);
  }
  if (!matches.length && declaredStreams.length) {
    matches = available.filter((file) => declaredStreams.some(
      (reference) => normalizedPath(reference) === filePath(file)
        || (manifestCount === 1
          && basename(reference).toLowerCase() === basename(file.name).toLowerCase()),
    ));
  }
  if (!matches.length) {
    const manifestToken = sessionFileToken(manifestMatch.parsed.sessionId);
    const filenameToken = sessionFileToken(basename(manifestPath));
    matches = available.filter((file) => {
      const token = sessionFileToken(filePath(file));
      return Boolean(manifestToken && manifestToken.length > 6 && token.includes(manifestToken))
        || Boolean(filenameToken && filenameToken.length > 6 && token.includes(filenameToken));
    });
  }
  if (!matches.length && manifestCount === 1
      && available.length === 1 && !directoryOf(filePath(available[0]))) {
    // Ordinary two-file selection has no relative paths. It is safe only when every
    // side contains exactly one file; multiple flat streams are ambiguous unless
    // the manifest explicitly declared them above.
    matches = available;
  }
  return matches;
}

function preferFinalStreams(matches) {
  const finalDirectories = new Set(
    matches
      .filter((file) => !file.name.toLowerCase().includes("partial"))
      .map((file) => directoryOf(filePath(file))),
  );
  if (!finalDirectories.size) return matches;
  return matches.filter((file) => {
    const isPartial = file.name.toLowerCase().includes("partial");
    return !isPartial || !finalDirectories.has(directoryOf(filePath(file)));
  });
}

async function isHistoryJournal(file) {
  if (/^peaktrailhistory(?:\.partial)?\.ndjson(?:\.partial)?$/i.test(file.name)) {
    return true;
  }
  if (!/\.ndjson(?:\.partial)?$/i.test(file.name)) return false;
  try {
    // Accept a renamed history export without reading an arbitrarily large file twice in
    // browsers. The first journal envelope is always session_start and carries a manifest.
    const prefix = typeof file.slice === "function" ? file.slice(0, 64 * 1024) : file;
    const firstLine = (await prefix.text()).split(/\r?\n/).find((line) => line.trim());
    if (!firstLine) return false;
    const record = JSON.parse(firstLine);
    return record?.type === "session_start" && Boolean(record.manifest);
  } catch {
    return false;
  }
}

export async function loadTraceCollection(fileList, options = {}) {
  const bundle = fileList instanceof FileBundle ? fileList : new FileBundle(fileList);
  const journalMatches = await Promise.all(bundle.files.map(isHistoryJournal));
  const journalFiles = bundle.files.filter((_, index) => journalMatches[index]);
  const journalResults = await Promise.all(journalFiles.map(loadTraceJournal));
  const journalSessions = journalResults.flatMap((result) => result.sessions);
  const journalWarnings = journalResults.flatMap((result) => result.warnings);
  const rawManifestMatches = [];
  for (const file of bundle.files.filter((candidate) => candidate.name.toLowerCase().endsWith(".json"))) {
    let parsed;
    try {
      parsed = await readJson(file);
    } catch {
      continue;
    }
    if (parsed?.sessionId && parsed?.sceneName) rawManifestMatches.push({ file, parsed });
  }
  const manifestMatches = preferFinalManifests(rawManifestMatches);
  if (!manifestMatches.length && journalSessions.length) {
    const sessions = journalSessions.sort((left, right) => {
      const leftTime = Date.parse(left.manifest.startedAtUtc || "") || 0;
      const rightTime = Date.parse(right.manifest.startedAtUtc || "") || 0;
      return rightTime - leftTime;
    });
    return { sessions, days: groupTraceSessions(sessions, options), warnings: journalWarnings };
  }
  if (!manifestMatches.length && journalFiles.length) {
    throw new ProtocolError(
      "历史日志中没有可回放的会话",
      journalWarnings.join("；") || "至少需要一条 session_start 和一条对应的位置 sample。",
    );
  }
  if (!manifestMatches.length) {
    throw new ProtocolError(
      "没有找到轨迹 manifest",
      "请选择一个或多个会话目录；每局需要 manifest.json 与 stream.ndjson。",
    );
  }
  const streamFiles = bundle.files.filter(isTraceStream);
  if (!streamFiles.length) {
    throw new ProtocolError("没有找到轨迹数据流", "每局需要 stream.ndjson 或 stream.ndjson.partial。 ");
  }

  const claimed = new Set();
  const groups = [];
  for (const manifestMatch of manifestMatches) {
    const allMatches = streamMatchesForManifest(
      manifestMatch,
      streamFiles,
      claimed,
      manifestMatches.length,
    );
    const matches = preferFinalStreams(allMatches);
    if (!matches.length) {
      throw new ProtocolError(
        `无法为会话 ${manifestMatch.parsed.sessionId} 配对数据流`,
        "请拖入保留会话子目录的总文件夹，或在文件名中包含 sessionId；查看器不会猜测并混合不同局。",
      );
    }
    // A partial stream superseded by a final stream is intentionally claimed but
    // not parsed a second time.
    allMatches.forEach((file) => claimed.add(file));
    groups.push({ manifestMatch, streamFiles: matches });
  }

  const unclaimedStreams = streamFiles.filter((file) => !claimed.has(file));
  if (unclaimedStreams.length) {
    throw new ProtocolError(
      "发现无法归属到会话的数据流",
      `${unclaimedStreams.map((file) => filePath(file)).join("、")}；请改为选择保留子目录的足迹总目录。`,
    );
  }

  const directorySessions = await Promise.all(
    groups.map(({ manifestMatch, streamFiles: files }) => loadSingleTrace(bundle, manifestMatch, files)),
  );
  const sessions = [...directorySessions, ...journalSessions]
    .filter((candidate, index, all) => all.findIndex(
      (entry) => entry.manifest.sessionId === candidate.manifest.sessionId,
    ) === index);
  sessions.sort((left, right) => {
    const leftTime = Date.parse(left.manifest.startedAtUtc || "") || 0;
    const rightTime = Date.parse(right.manifest.startedAtUtc || "") || 0;
    return rightTime - leftTime || left.manifest.sessionId.localeCompare(right.manifest.sessionId);
  });
  return {
    sessions,
    days: groupTraceSessions(sessions, options),
    warnings: [...sessions.flatMap((session) => session.warnings.map(
      (warning) => `${session.manifest.sessionId}: ${warning}`,
    )), ...journalWarnings],
  };
}

function latestAtTime(samples, seconds) {
  if (!samples.length || Number(seconds) < samples[0].t) return null;
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].t <= seconds) low = middle + 1;
    else high = middle;
  }
  return samples[Math.max(0, low - 1)] || null;
}

export function traceSampleAtTime(trace, playerId, seconds) {
  return latestAtTime(trace?.tracks?.get(playerId) || [], seconds);
}

export function tracePlayerStateAtTime(trace, playerId, seconds) {
  const sample = traceSampleAtTime(trace, playerId, seconds);
  const state = latestAtTime(trace?.telemetryTracks?.get(playerId) || [], seconds);
  const inventoryEntry = latestAtTime(trace?.inventoryTracks?.get(playerId) || [], seconds);
  const appearanceEntry = latestAtTime(trace?.appearanceTracks?.get(playerId) || [], seconds);
  const telemetry = { ...(sample?.telemetry || {}) };
  const vitalityKeys = [
    "stamina",
    "maxStamina",
    "stamina01",
    "extraStamina",
    "maxExtraStamina",
    "extraStamina01",
    "totalStamina",
  ];
  const sampleHasVitality = sample?.telemetry
    && (sample.telemetry.ready !== null || vitalityKeys.some(
      (key) => sample.telemetry[key] !== null && sample.telemetry[key] !== undefined,
    ));
  const stateWinsVitality = state?.telemetry
    && (!sampleHasVitality || state.t >= (sample?.t ?? -Infinity));
  if (stateWinsVitality) {
    telemetry.captured = Boolean(telemetry.captured || state.telemetry.captured);
    if (state.telemetry.ready === false) {
      for (const key of vitalityKeys) telemetry[key] = null;
    }
    for (const [key, value] of Object.entries(state.telemetry)) {
      if (key === "item" || key === "itemCaptured" || key === "captured") continue;
      if (value !== null && value !== undefined) telemetry[key] = value;
    }
  }
  const inventory = inventoryEntry?.inventory || null;
  const inventoryWinsItem = inventory?.heldCaptured
    && (!sample?.telemetry?.itemCaptured || inventoryEntry.t >= sample.t);
  if (inventoryWinsItem) {
    telemetry.itemCaptured = true;
    telemetry.item = inventory.heldPresent ? inventory.held : null;
  }
  return {
    sample,
    telemetry: Object.keys(telemetry).length ? telemetry : null,
    inventory,
    appearance: appearanceEntry?.appearance || null,
    telemetryTime: stateWinsVitality ? state.t : sample?.t ?? null,
    inventoryTime: inventoryEntry?.t ?? null,
    appearanceTime: appearanceEntry?.t ?? null,
  };
}

function assertFiniteField(layer, field) {
  const value = asFiniteNumber(layer[field]);
  if (value === null) throw new ProtocolError(`地图分层 ${layer.id || "?"} 缺少数值字段 ${field}`);
  return value;
}

async function decodeFloat32(buffer, expectedCount) {
  if (buffer.byteLength < expectedCount * 4) {
    throw new ProtocolError(
      "高度场数据不完整",
      `需要 ${expectedCount * 4} 字节，实际只有 ${buffer.byteLength} 字节。`,
    );
  }
  const view = new DataView(buffer);
  const values = new Float32Array(expectedCount);
  for (let index = 0; index < expectedCount; index += 1) {
    values[index] = view.getFloat32(index * 4, true);
  }
  return values;
}

function decodeBase64Float32(value, expectedCount) {
  const binary = atob(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return decodeFloat32(bytes.buffer, expectedCount);
}

function validateMapPack(raw) {
  if (!raw || typeof raw !== "object") throw new ProtocolError("map-pack 必须是一个 JSON 对象");
  if (raw.schemaVersion !== 1) {
    throw new ProtocolError(`不支持的地图包协议版本：${raw.schemaVersion ?? "未声明"}`, "当前只接受 schemaVersion 1。");
  }
  if (!SUPPORTED_MAP_PACK_IDENTITY_VERSIONS.includes(raw.identityVersion)) {
    throw new ProtocolError(
      `不支持的地图身份版本：${raw.identityVersion ?? "未声明"}`,
      "当前接受 identityVersion 2 或 3。",
    );
  }
  if (!MAP_PACK_ID_PATTERN.test(String(raw.mapPackId || ""))) {
    throw new ProtocolError("map-pack 的 mapPackId 格式无效", "必须是 identityVersion 2 或 3 生成的小写 sha256-... 标识。 ");
  }
  if (!raw.sceneName) throw new ProtocolError("map-pack 缺少 sceneName");
  if (!Array.isArray(raw.layers) || !raw.layers.length) throw new ProtocolError("map-pack 没有 layers");
  for (const layer of raw.layers) validateLayerGeometry(layer, raw.identityVersion);
  if (raw.coordinateSpace !== REQUIRED_COORDINATE_SPACE) {
    throw new ProtocolError(`不支持的地图坐标系：${raw.coordinateSpace ?? "未声明"}`);
  }
  if (raw.textureUv !== TEXTURE_UV) {
    throw new ProtocolError(`不支持的地图 UV 约定：${raw.textureUv ?? "未声明"}`);
  }
  if (raw.imageOrigin !== IMAGE_ORIGIN) {
    throw new ProtocolError(`不支持的地图图像方向：${raw.imageOrigin ?? "未声明"}`);
  }
  const projectionVersion = asFiniteNumber(raw.projectionVersion);
  if (!Number.isInteger(projectionVersion) || projectionVersion < 1) {
    throw new ProtocolError(`无效的地图投影版本：${raw.projectionVersion ?? "未声明"}`);
  }
}

async function hydrateMapPack(raw, resolver) {
  validateMapPack(raw);
  if (raw.identityVersion === 3) await verifyMapPackIdentityV3(raw);
  const hydratedLayers = [];

  for (const sourceLayer of raw.layers) {
    const id = asId(sourceLayer.id) ?? `segment-${sourceLayer.segment ?? hydratedLayers.length}`;
    const columns = assertFiniteField(sourceLayer, "columns");
    const rows = assertFiniteField(sourceLayer, "rows");
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || rows < 2) {
      throw new ProtocolError(`地图分层 ${id} 的网格尺寸必须是至少 2×2 的整数`);
    }
    const segment = assertFiniteField(sourceLayer, "segment");
    if (!Number.isInteger(segment)) throw new ProtocolError(`地图分层 ${id} 的 segment 必须是整数`);
    const minX = assertFiniteField(sourceLayer, "minX");
    const maxX = assertFiniteField(sourceLayer, "maxX");
    const minY = assertFiniteField(sourceLayer, "minY");
    const maxY = assertFiniteField(sourceLayer, "maxY");
    const minZ = assertFiniteField(sourceLayer, "minZ");
    const maxZ = assertFiniteField(sourceLayer, "maxZ");
    if (!(minX < maxX) || !(minZ < maxZ) || minY > maxY) {
      throw new ProtocolError(`地图分层 ${id} 的世界坐标边界无效`);
    }
    const encoding = sourceLayer.heightEncoding;
    if (encoding !== HEIGHT_ENCODING) {
      throw new ProtocolError(`不支持的高度编码：${encoding ?? "未声明"}`, `当前只接受 ${HEIGHT_ENCODING}。`);
    }
    if (sourceLayer.sampleLocation !== SAMPLE_LOCATION) {
      throw new ProtocolError(`地图分层 ${id} 必须声明 sampleLocation=${SAMPLE_LOCATION}`);
    }
    if (sourceLayer.noData !== "NaN") {
      throw new ProtocolError(`地图分层 ${id} 必须声明 noData=NaN`);
    }
    if (sourceLayer.textureFlipY === false) {
      throw new ProtocolError(
        `地图分层 ${id} 试图覆盖已签名的图像方向`,
        `identity v2 固定使用 ${IMAGE_ORIGIN}；不能用未纳入身份的 textureFlipY=false 翻转底图。`,
      );
    }

    const expectedCount = columns * rows;
    let heightData = null;
    if (raw.identityVersion === 3) {
      // Real geometry is loaded and SHA-verified only when a layer is selected.
      // Survey height fields remain in the signed pack, but are not a 3D surface.
    } else if (Array.isArray(sourceLayer.heightValues)) {
      if (sourceLayer.heightValues.length < expectedCount) {
        throw new ProtocolError(`地图分层 ${id} 的 heightValues 数量不足`);
      }
      heightData = Float32Array.from(sourceLayer.heightValues.slice(0, expectedCount));
    } else if (sourceLayer.heightDataBase64) {
      heightData = await decodeBase64Float32(sourceLayer.heightDataBase64, expectedCount);
    } else {
      const heightAsset = await resolver.binary(sourceLayer.height);
      heightData = await decodeFloat32(heightAsset, expectedCount);
    }

    let textureUrl = null;
    if (sourceLayer.textureDataUrl) textureUrl = sourceLayer.textureDataUrl;
    else if (sourceLayer.texture) textureUrl = await resolver.url(sourceLayer.texture, "texture");
    const geometryUrl = raw.identityVersion === 3 ? await resolver.url(sourceLayer.geometry, "geometry") : null;

    hydratedLayers.push({
      ...sourceLayer,
      id,
      name: String(sourceLayer.name || `Segment ${sourceLayer.segment ?? hydratedLayers.length}`),
      segment,
      columns,
      rows,
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
      heightEncoding: encoding,
      sampleLocation: sourceLayer.sampleLocation,
      heightData,
      textureUrl,
      geometryUrl,
      geometrySha256: raw.identityVersion === 3 ? sourceLayer.geometrySha256 : null,
      geometryFormat: raw.identityVersion === 3 ? sourceLayer.geometryFormat : null,
    });
  }

  return {
    ...raw,
    schemaVersion: 1,
    identityVersion: raw.identityVersion,
    mapPackId: String(raw.mapPackId),
    sceneName: String(raw.sceneName),
    gameVersion: raw.gameVersion ? String(raw.gameVersion) : null,
    gameBuildId: asId(raw.gameBuildId),
    mapSlot: asFiniteNumber(raw.mapSlot),
    projectionVersion: asFiniteNumber(raw.projectionVersion),
    coordinateSpace: raw.coordinateSpace,
    layers: hydratedLayers,
    bounds: {
      min: [
        Math.min(...hydratedLayers.map((layer) => layer.minX)),
        Math.min(...hydratedLayers.map((layer) => layer.minY)),
        Math.min(...hydratedLayers.map((layer) => layer.minZ)),
      ],
      max: [
        Math.max(...hydratedLayers.map((layer) => layer.maxX)),
        Math.max(...hydratedLayers.map((layer) => layer.maxY)),
        Math.max(...hydratedLayers.map((layer) => layer.maxZ)),
      ],
    },
  };
}

function localResolver(bundle) {
  return {
    async binary(reference) {
      const file = bundle.resolve(reference);
      if (!file) {
        throw new ProtocolError(
          `地图包缺少 ${reference}`,
          "浏览器不能自动读取 JSON 旁边的文件；请一次选中 map-pack.json、全部 PNG 与 .f32。",
        );
      }
      return file.arrayBuffer();
    },
    async url(reference) {
      if (/^(data:|blob:|https?:)/i.test(reference)) return reference;
      const file = bundle.resolve(reference);
      if (!file) {
        throw new ProtocolError(
          `地图包缺少 ${reference}`,
          "请把 map-pack.json、全部 PNG 与 .f32 一起拖入或多选。",
        );
      }
      return bundle.makeUrl(file);
    },
  };
}

function remoteResolver(baseUrl) {
  return {
    async binary(reference) {
      const url = new URL(reference, baseUrl);
      const response = await fetch(url);
      if (!response.ok) throw new ProtocolError(`无法加载高度场 ${url.pathname}`, `HTTP ${response.status}`);
      return response.arrayBuffer();
    },
    async url(reference) {
      return new URL(reference, baseUrl).href;
    },
  };
}

export async function loadMapPackBundle(fileList) {
  const bundle = fileList instanceof FileBundle ? fileList : new FileBundle(fileList);
  const packMatch = await findJsonByShape(
    bundle.files,
    (value) => Boolean(value && value.mapPackId && Array.isArray(value.layers)),
    /^map-pack\.json$/i,
  );
  if (!packMatch) {
    throw new ProtocolError("没有找到 map-pack.json", "地图包 JSON 必须包含 mapPackId 与 layers。");
  }
  const pack = await hydrateMapPack(packMatch.parsed, localResolver(bundle));
  pack.sourceName = packMatch.file.name;
  pack.disposeAssets = () => bundle.dispose();
  return pack;
}

export async function loadMapPackUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new ProtocolError(`无法加载地图包`, `${response.status} ${response.statusText}`);
  const raw = await response.json();
  const pack = await hydrateMapPack(raw, remoteResolver(response.url || url));
  pack.sourceName = basename(new URL(response.url || url).pathname) || "map-pack.json";
  pack.disposeAssets = () => {};
  return pack;
}

export function selectDailyMapPack(catalog, daily) {
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.mapPacks)) {
    throw new ProtocolError("地图目录格式无效", "catalog.json 必须使用 schemaVersion 1 并包含 mapPacks 数组。");
  }
  if (!daily?.sceneName || !Number.isInteger(Number(daily.mapSlot))) {
    throw new ProtocolError("今日轮换数据格式无效", "缺少 sceneName 或 mapSlot。");
  }

  const activeBuildId = asId(catalog.activeGameBuildId)?.trim();
  if (!/^[1-9]\d*$/.test(activeBuildId || "")) return null;

  const candidates = catalog.mapPacks.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const mapPackId = String(entry.mapPackId || "");
    const expectedPath = `./packs/${mapPackId.toLowerCase()}/map-pack.json`;
    if (!SUPPORTED_MAP_PACK_IDENTITY_VERSIONS.includes(entry.identityVersion)
        || !MAP_PACK_ID_PATTERN.test(mapPackId)
        || entry.path !== expectedPath
        || !entry.sceneName) return false;
    if (String(entry.gameBuildId ?? "").trim() !== activeBuildId) return false;
    if (String(entry.sceneName) !== String(daily.sceneName)) return false;
    if (entry.mapSlot !== undefined && Number(entry.mapSlot) !== Number(daily.mapSlot)) return false;
    return entry.enabled !== false;
  });

  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.generatedAtUtc || "") || 0;
    const rightTime = Date.parse(right.generatedAtUtc || "") || 0;
    return right.identityVersion - left.identityVersion || rightTime - leftTime || String(right.mapPackId).localeCompare(String(left.mapPackId));
  });
  return candidates[0] || null;
}

function validCatalogEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const mapPackId = String(entry.mapPackId || "");
  return SUPPORTED_MAP_PACK_IDENTITY_VERSIONS.includes(entry.identityVersion)
    && MAP_PACK_ID_PATTERN.test(mapPackId)
    && entry.path === `./packs/${mapPackId}/map-pack.json`
    && Boolean(entry.sceneName)
    && entry.enabled !== false;
}

export function selectTraceMapPack(catalog, manifest) {
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.mapPacks)) {
    throw new ProtocolError("地图目录格式无效", "catalog.json 必须使用 schemaVersion 1 并包含 mapPacks 数组。");
  }
  if (!manifest?.sceneName) return null;
  const entries = catalog.mapPacks.filter(validCatalogEntry);
  const requestedPackId = asId(manifest.mapPackId);
  if (requestedPackId) {
    const exact = entries.find((entry) => String(entry.mapPackId) === requestedPackId);
    return exact || null;
  }

  const buildId = asId(manifest.gameBuildId)?.trim();
  const projectionVersion = asFiniteNumber(manifest.projectionVersion);
  if (!/^[1-9]\d*$/.test(buildId || "")
      || !Number.isInteger(projectionVersion)
      || projectionVersion < 1) return null;
  const candidates = entries.filter((entry) => {
    if (String(entry.sceneName) !== String(manifest.sceneName)) return false;
    if (String(entry.gameBuildId ?? "").trim() !== buildId) return false;
    if (manifest.mapSlot !== null && manifest.mapSlot !== undefined
        && entry.mapSlot !== undefined && Number(entry.mapSlot) !== Number(manifest.mapSlot)) return false;
    if (entry.projectionVersion !== undefined
        && Number(entry.projectionVersion) !== projectionVersion) return false;
    return true;
  });
  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.generatedAtUtc || "") || 0;
    const rightTime = Date.parse(right.generatedAtUtc || "") || 0;
    return right.identityVersion - left.identityVersion || rightTime - leftTime || String(right.mapPackId).localeCompare(String(left.mapPackId));
  });
  return candidates[0] || null;
}

export function isDailyMapFresh(daily, now = Date.now()) {
  const deadline = Date.parse(daily?.nextChangeAtUtc);
  const currentTime = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(deadline) && Number.isFinite(currentTime) && deadline > currentTime;
}

export function assessCompatibility(manifest, mapPack) {
  if (!manifest || !mapPack) {
    const message = manifest
      ? "未找到匹配底图 · 无底图回放"
      : mapPack
        ? "内嵌地图就绪 · 等待足迹"
        : "等待地图与足迹";
    return { status: "neutral", compatible: false, message, reasons: [] };
  }

  const reasons = [];
  if (manifest.schemaVersion !== 1 || mapPack.schemaVersion !== 1) {
    reasons.push(`协议版本：足迹 ${manifest.schemaVersion ?? "未声明"} / 地图 ${mapPack.schemaVersion ?? "未声明"}`);
  }
  if (manifest.coordinateSpace !== REQUIRED_COORDINATE_SPACE
      || mapPack.coordinateSpace !== REQUIRED_COORDINATE_SPACE) {
    reasons.push(`坐标系必须由双方明确声明为 ${REQUIRED_COORDINATE_SPACE}`);
  }
  const compare = (key, label, normalizer = String) => {
    const left = manifest[key];
    const right = mapPack[key];
    if (left === null || left === undefined || right === null || right === undefined) return;
    if (normalizer(left) !== normalizer(right)) reasons.push(`${label}：足迹 ${left} / 地图 ${right}`);
  };

  compare("sceneName", "场景");
  compare("gameVersion", "游戏版本");
  compare("gameBuildId", "游戏构建");
  compare("mapSlot", "地图槽位", Number);
  compare("projectionVersion", "投影版本", Number);
  if (manifest.mapPackId) compare("mapPackId", "地图包 ID");

  if (reasons.length) {
    return {
      status: "error",
      compatible: false,
      message: "地图不匹配 · 已禁用底图",
      reasons,
    };
  }

  const validBuildId = (value) => {
    if (value === null || value === undefined) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized !== "" && normalized !== "0" && normalized !== "unknown" && normalized !== "null";
  };
  const exactPackId = Boolean(manifest.mapPackId && manifest.mapPackId === mapPack.mapPackId);
  const validProjectionVersion = (value) => Number.isInteger(value) && value >= 1;
  const verifiedProjectionFallback = Boolean(
    manifest.sceneName &&
      mapPack.sceneName &&
      manifest.sceneName === mapPack.sceneName &&
      validBuildId(manifest.gameBuildId) &&
      validBuildId(mapPack.gameBuildId) &&
      String(manifest.gameBuildId) === String(mapPack.gameBuildId) &&
      validProjectionVersion(manifest.projectionVersion) &&
      validProjectionVersion(mapPack.projectionVersion) &&
      manifest.projectionVersion === mapPack.projectionVersion &&
      manifest.coordinateSpace === mapPack.coordinateSpace,
  );
  const strongIdentity = exactPackId || verifiedProjectionFallback;

  if (!strongIdentity) {
    return {
      status: "error",
      compatible: false,
      message: "无法验证地图 · 已禁用底图",
      reasons: [
        "需要相同 mapPackId；或同时匹配 sceneName、有效 gameBuildId、projectionVersion 与 coordinateSpace。",
      ],
    };
  }

  return { status: "good", compatible: true, message: "地图与足迹版本匹配", reasons: [] };
}

export function getPointBounds(points) {
  if (!points.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    if (!point || point.length < 3) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      if (!isFiniteNumber(point[axis])) continue;
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
}

export function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safe);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export const EVENT_PRESENTATION = {
  mine_explosion: { label: "地雷爆开", symbol: "✹", color: "#ff7449" },
  mine_exploded: { label: "地雷爆开", symbol: "✹", color: "#ff7449" },
  zombie_activated: { label: "僵尸激活", symbol: "!", color: "#fb886b" },
  zombie_woke: { label: "僵尸苏醒", symbol: "!", color: "#fb886b" },
  world_spawn: { label: "世界物体出现", symbol: "+", color: "#83d9a2" },
  world_despawn: { label: "世界物体消失", symbol: "−", color: "#92aba6" },
  fog_activated: { label: "昏睡雾激活", symbol: "≈", color: "#cb9bfb" },
  fog_enabled: { label: "昏睡雾出现", symbol: "≈", color: "#cb9bfb" },
  fog_disabled: { label: "昏睡雾消退", symbol: "≈", color: "#91cab1" },
  zombie_state: { label: "僵尸状态变化", symbol: "!", color: "#fb886b" },
  join: { label: "加入攀登", symbol: "+", color: "#6fd3a6" },
  leave: { label: "离开攀登", symbol: "−", color: "#93a39f" },
  passed_out: { label: "失去意识", symbol: "!", color: "#ffad62" },
  recovered: { label: "恢复意识", symbol: "↟", color: "#77d6c7" },
  death: { label: "死亡", symbol: "×", color: "#ff716e" },
  revive: { label: "复活", symbol: "✦", color: "#6fd3a6" },
  warp: { label: "传送", symbol: "↝", color: "#ab94ff" },
  segment_change: { label: "进入新分区", symbol: "◆", color: "#efb74e" },
  run_end: { label: "攀登结束", symbol: "■", color: "#efb74e" },
  item_pickup: { label: "拾取物品", symbol: "↑", color: "#77d6c7" },
  item_drop: { label: "放下物品", symbol: "↓", color: "#93a39f" },
  item_use: { label: "使用物品", symbol: "◇", color: "#efb74e" },
  item_acquired: { label: "获得物品", symbol: "+", color: "#77d6c7" },
  item_lost: { label: "失去物品", symbol: "−", color: "#93a39f" },
  item_moved: { label: "移动物品", symbol: "↔", color: "#ab94ff" },
  item_state_changed: { label: "物品状态变化", symbol: "◇", color: "#efb74e" },
  item_consumed: { label: "消耗物品", symbol: "○", color: "#ffad62" },
  item_thrown: { label: "投掷物品", symbol: "↗", color: "#ee7f74" },
  item_equipped: { label: "拿出物品", symbol: "▣", color: "#77d6c7" },
  item_unequipped: { label: "收起物品", symbol: "□", color: "#93a39f" },
  equip: { label: "装备物品", symbol: "▣", color: "#77d6c7" },
  unequip: { label: "收起物品", symbol: "□", color: "#93a39f" },
  stamina_empty: { label: "体力耗尽", symbol: "!", color: "#ffad62" },
  event: { label: "事件", symbol: "◆", color: "#efb74e" },
};

export function eventPresentation(type) {
  return EVENT_PRESENTATION[type] || {
    label: String(type || "事件").replaceAll("_", " "),
    symbol: "◆",
    color: "#efb74e",
  };
}
