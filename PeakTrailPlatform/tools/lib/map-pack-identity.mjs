import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";

export const MAP_PACK_IDENTITY_VERSION = 3;
export const SUPPORTED_MAP_PACK_IDENTITY_VERSIONS = Object.freeze([2, 3]);
export const GEOMETRY_FORMAT = "glb-instanced-v1";
export const GEOMETRY_GZIP_FORMAT = "glb-instanced-v1+gzip";
export const GEOMETRY_FORMATS = Object.freeze([GEOMETRY_FORMAT, GEOMETRY_GZIP_FORMAT]);
export const MAX_GEOMETRY_BYTES = 128 * 1024 * 1024;
export const MAP_PACK_ID_PATTERN = /^sha256-[a-f0-9]{64}$/;

export function canonicalMapPackIdentity(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("map pack identity requires an object");
  const version = Number(canonicalInteger(manifest.identityVersion, "identityVersion", 2, 3));
  const layers = requireLayers(manifest.layers);
  const chunks = [`peaktrail-map-pack-identity-v${version}\n`];

  appendInteger(chunks, "identityVersion", manifest.identityVersion, 2, 3);
  appendInteger(chunks, "schemaVersion", manifest.schemaVersion, 1, 1);
  appendInteger(chunks, "projectionVersion", manifest.projectionVersion, 1);
  appendString(chunks, "coordinateSpace", manifest.coordinateSpace);
  appendString(chunks, "textureUv", manifest.textureUv);
  appendString(chunks, "imageOrigin", manifest.imageOrigin);
  appendString(chunks, "gameVersion", manifest.gameVersion, true);
  appendInteger(chunks, "gameBuildId", manifest.gameBuildId, 0);
  appendString(chunks, "sceneName", manifest.sceneName, true);
  appendInteger(chunks, "mapSlot", manifest.mapSlot, 0);
  appendInteger(chunks, "layerCount", layers.length, 1);

  for (const [index, layer] of layers.entries()) {
    validateLayerGeometry(layer, version);
    const prefix = `layer.${index}`;
    appendString(chunks, `${prefix}.id`, layer.id, true);
    appendInteger(chunks, `${prefix}.segment`, layer.segment, 0);
    appendString(chunks, `${prefix}.biome`, layer.biome, true);
    appendString(chunks, `${prefix}.texture`, layer.texture, true);
    appendSha256(chunks, `${prefix}.textureSha256`, layer.textureSha256);
    appendString(chunks, `${prefix}.height`, layer.height, true);
    for (const field of ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"]) {
      appendFloat32(chunks, `${prefix}.${field}`, layer[field]);
    }
    appendInteger(chunks, `${prefix}.columns`, layer.columns, 2);
    appendInteger(chunks, `${prefix}.rows`, layer.rows, 2);
    appendString(chunks, `${prefix}.heightEncoding`, layer.heightEncoding, true);
    appendString(chunks, `${prefix}.noData`, layer.noData, true);
    appendString(chunks, `${prefix}.sampleLocation`, layer.sampleLocation, true);
    appendSha256(chunks, `${prefix}.heightSha256`, layer.heightSha256);
    if (version === 3) {
      appendString(chunks, `${prefix}.geometry`, layer.geometry, true);
      appendSha256(chunks, `${prefix}.geometrySha256`, layer.geometrySha256);
      appendString(chunks, `${prefix}.geometryFormat`, layer.geometryFormat, true);
    }
  }

  return chunks.join("");
}

export function validateLayerGeometry(layer, identityVersion) {
  if (Number(identityVersion) === 2) {
    // Existing v2 offline packs use geometry:{triangle counts,...} as unsigned
    // diagnostics. Preserve those bytes; only rendering references are forbidden.
    if (typeof layer.geometry === "string" || ["geometrySha256", "geometryFormat"].some((field) => Object.hasOwn(layer, field))) {
      throw new Error("identityVersion 2 cannot contain unsigned geometry fields; use identityVersion 3");
    }
    return;
  }
  if (Number(identityVersion) !== 3) throw new Error("Unsupported map geometry identityVersion");
  if (typeof layer.geometry !== "string" || !/^[a-zA-Z0-9_./-]+\.glb(?:\.gz)?$/.test(layer.geometry)
      || layer.geometry.startsWith("/") || layer.geometry.split("/").includes("..")) {
    throw new Error("geometry must be a safe relative .glb or .glb.gz path");
  }
  if (!/^[a-f0-9]{64}$/.test(layer.geometrySha256 || "")) throw new Error("geometrySha256 must be a lowercase SHA-256 digest");
  if (!GEOMETRY_FORMATS.includes(layer.geometryFormat)) throw new Error(`geometryFormat must be ${GEOMETRY_FORMATS.join(" or ")}`);
  if (layer.geometry.endsWith(".gz") !== (layer.geometryFormat === GEOMETRY_GZIP_FORMAT)) throw new Error("geometry filename must match geometryFormat compression");
}

/** Check a complete embedded GLB, so registration cannot publish external dependencies. */
export function verifyGeometryGlb(input, label = "geometry", format = GEOMETRY_FORMAT) {
  let bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (format === GEOMETRY_GZIP_FORMAT) {
    try { bytes = gunzipSync(bytes, { maxOutputLength: MAX_GEOMETRY_BYTES }); }
    catch { throw new Error(`${label} has invalid gzip data or exceeds the 128 MiB decompressed limit`); }
  } else if (format !== GEOMETRY_FORMAT) throw new Error(`${label} has an unsupported geometryFormat`);
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2
      || bytes.readUInt32LE(8) !== bytes.length) throw new Error(`${label} is not a complete GLB version 2 file`);
  let json = null;
  let position = 12;
  let binaryLength = 0;
  let hasBinaryChunk = false;
  while (position < bytes.length) {
    if (position + 8 > bytes.length) throw new Error(`${label} has a truncated GLB chunk`);
    const length = bytes.readUInt32LE(position);
    const type = bytes.readUInt32LE(position + 4);
    position += 8;
    if (length % 4 || position + length > bytes.length) throw new Error(`${label} has an invalid GLB chunk length`);
    if (type === 0x4e4f534a) {
      if (json !== null || position !== 20) throw new Error(`${label} must have exactly one initial JSON chunk`);
      try { json = JSON.parse(bytes.subarray(position, position + length).toString("utf8").trim()); }
      catch { throw new Error(`${label} has invalid GLB JSON`); }
    } else if (type === 0x004e4942) {
      if (hasBinaryChunk) throw new Error(`${label} has multiple GLB binary chunks`);
      hasBinaryChunk = true;
      binaryLength = length;
    }
    position += length;
  }
  if (json?.asset?.version !== "2.0") throw new Error(`${label} lacks a glTF 2.0 asset declaration`);
  const buffers = json.buffers || [];
  const views = json.bufferViews || [];
  const images = json.images || [];
  if (![buffers, views, images].every(Array.isArray)) throw new Error(`${label} has invalid GLB resource arrays`);
  if ([...buffers, ...images].some((entry) => entry?.uri !== undefined)) {
    throw new Error(`${label} must embed every buffer and image; external URIs are unsupported`);
  }
  const meshoptName = "EXT_meshopt_compression";
  const meshoptRequired = Array.isArray(json.extensionsRequired) && json.extensionsRequired.includes(meshoptName);
  const meshoptUsed = Array.isArray(json.extensionsUsed) && json.extensionsUsed.includes(meshoptName);
  const unsignedInteger = (value) => Number.isSafeInteger(value) && value >= 0;
  const insideBuffer = (index, offset, length) => unsignedInteger(index) && index < buffers.length
    && unsignedInteger(offset) && unsignedInteger(length) && length > 0
    && Number.isSafeInteger(offset + length) && offset + length <= buffers[index].byteLength;
  for (const [index, buffer] of buffers.entries()) {
    if (!buffer || !unsignedInteger(buffer.byteLength) || buffer.byteLength === 0
        || (index === 0 && (buffer.byteLength > binaryLength || binaryLength - buffer.byteLength > 3))) {
      throw new Error(`${label} has an invalid embedded buffer length`);
    }
    // GLB buffer 0 owns the BIN chunk. Meshopt may declare additional no-URI
    // buffers as decoded-data placeholders, not additional physical BIN chunks.
    if (index > 0 && (!meshoptRequired || !meshoptUsed)) {
      throw new Error(`${label} has a placeholder buffer without required ${meshoptName}`);
    }
  }
  for (const [index, view] of views.entries()) {
    if (!view || !insideBuffer(view.buffer, view.byteOffset ?? 0, view.byteLength)) {
      throw new Error(`${label} bufferView ${index} is outside its declared buffer`);
    }
    const compressed = view.extensions?.[meshoptName];
    const fallback = buffers[view.buffer].extensions?.[meshoptName]?.fallback === true;
    if ((view.buffer > 0 || fallback) && !compressed) {
      throw new Error(`${label} bufferView ${index} references a fallback buffer without meshopt compression`);
    }
    if (!compressed) continue;
    if (!meshoptUsed || typeof compressed !== "object" || Array.isArray(compressed)) {
      throw new Error(`${label} bufferView ${index} has undeclared or invalid meshopt compression`);
    }
    if (compressed.buffer !== 0 || buffers[0]?.extensions?.[meshoptName]?.fallback === true
        || !insideBuffer(compressed.buffer, compressed.byteOffset ?? 0, compressed.byteLength)) {
      throw new Error(`${label} bufferView ${index} compressed range is outside the embedded BIN buffer`);
    }
    const { byteStride: stride, count, mode } = compressed;
    const filter = compressed.filter ?? "NONE";
    if (!unsignedInteger(stride) || stride === 0 || !unsignedInteger(count) || count === 0
        || !Number.isSafeInteger(stride * count) || view.byteLength !== stride * count
        || (view.byteStride !== undefined && view.byteStride !== stride)
        || !["ATTRIBUTES", "TRIANGLES", "INDICES"].includes(mode)
        || !["NONE", "OCTAHEDRAL", "QUATERNION", "EXPONENTIAL"].includes(filter)
        || (mode === "ATTRIBUTES" && (stride % 4 !== 0 || stride > 256))
        || (mode !== "ATTRIBUTES" && (![2, 4].includes(stride) || filter !== "NONE"))
        || (mode === "TRIANGLES" && count % 3 !== 0)
        || (filter === "OCTAHEDRAL" && ![4, 8].includes(stride))
        || (filter === "QUATERNION" && stride !== 8)
        || (filter === "EXPONENTIAL" && stride % 4 !== 0)) {
      throw new Error(`${label} bufferView ${index} has invalid meshopt decoded layout`);
    }
  }
  for (const [index, image] of images.entries()) {
    if (!image || !unsignedInteger(image.bufferView) || image.bufferView >= views.length) {
      throw new Error(`${label} image ${index} lacks a valid embedded bufferView`);
    }
  }
  return json;
}

export function computeMapPackId(manifest) {
  const canonical = canonicalMapPackIdentity(manifest);
  return `sha256-${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function verifyMapPackIdentity(manifest) {
  if (!MAP_PACK_ID_PATTERN.test(String(manifest?.mapPackId ?? ""))) {
    throw new Error("map-pack.json has an invalid lowercase mapPackId");
  }
  const expected = computeMapPackId(manifest);
  if (manifest.mapPackId !== expected) {
    throw new Error(`map-pack.json mapPackId mismatch: expected ${expected}, received ${manifest.mapPackId}`);
  }
  return expected;
}

export function float32BitsHex(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`float32 identity value must be finite, received ${String(value)}`);
  }
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) throw new Error(`float32 identity value is out of range: ${value}`);
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeFloatLE(rounded, 0);
  return bytes.readUInt32LE(0).toString(16).padStart(8, "0");
}

function requireLayers(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("map pack identity requires layers");
  const layers = [...value];
  for (const [index, layer] of layers.entries()) {
    if (!layer || typeof layer !== "object") throw new Error(`map pack identity layer ${index} must be an object`);
  }
  layers.sort((left, right) => {
    const leftSegment = canonicalInteger(left.segment, "layer segment", 0);
    const rightSegment = canonicalInteger(right.segment, "layer segment", 0);
    return Number(leftSegment) - Number(rightSegment);
  });
  const segments = new Set();
  for (const layer of layers) {
    const segment = canonicalInteger(layer.segment, "layer segment", 0);
    if (segments.has(segment)) throw new Error(`map pack identity contains duplicate segment ${segment}`);
    segments.add(segment);
  }
  return layers;
}

function appendString(chunks, key, value, requireNonEmpty = false) {
  if (typeof value !== "string" || (requireNonEmpty && value.length === 0)) {
    throw new Error(`${key} must be ${requireNonEmpty ? "a non-empty" : "a"} string`);
  }
  chunks.push(`${key}=${Buffer.byteLength(value, "utf8")}:${value}\n`);
}

function appendInteger(chunks, key, value, minimum, maximum = null) {
  const canonical = canonicalInteger(value, key, minimum, maximum);
  chunks.push(`${key}=${canonical}\n`);
}

function appendFloat32(chunks, key, value) {
  chunks.push(`${key}=f32:${float32BitsHex(value)}\n`);
}

function appendSha256(chunks, key, value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${key} must be a lowercase SHA-256 digest`);
  }
  chunks.push(`${key}=${value}\n`);
}

function canonicalInteger(value, key, minimum, maximum = null) {
  let canonical;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${key} must be a safe integer`);
    canonical = String(value);
  } else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    canonical = value;
  } else {
    throw new Error(`${key} must be a canonical non-negative integer`);
  }

  const integer = BigInt(canonical);
  if (integer < BigInt(minimum) || (maximum !== null && integer > BigInt(maximum))) {
    throw new Error(`${key} is outside the supported range`);
  }
  return canonical;
}
