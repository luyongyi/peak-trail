import { mkdir, lstat, readFile, open, rename, unlink, link } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { problem, validHash } from "./trajectory-contract.mjs";

const INDEX_BYTES = 4 * 1024 * 1024, PACK_BYTES = 48 * 1024 * 1024, RECORD_BYTES = 128 * 1024;
const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const indexPath = (root, context) => join(root, "point-bases", `context-${context}.json`);
function validateIndex(index, context) {
  if (!exactKeys(index, ["version", "context", "blocks", "bases"]) || index.version !== 1 || index.context !== context
    || !index.blocks || typeof index.blocks !== "object" || Array.isArray(index.blocks)
    || !index.bases || typeof index.bases !== "object" || Array.isArray(index.bases)
    || Object.keys(index.blocks).length > 20_000 || Object.keys(index.bases).length > 20_000) throw problem("invalid point context index", 503);
  const intervals = new Map();
  for (const [hash, ref] of Object.entries(index.blocks)) {
    if (!validHash(hash) || !exactKeys(ref, ["packHash", "offset", "length", "recordSha256", "window", "pointCount", "type"])
      || !validHash(ref.packHash) || !validHash(ref.recordSha256) || !Number.isSafeInteger(ref.offset) || ref.offset < 0
      || !Number.isSafeInteger(ref.length) || ref.length < 1 || ref.length > RECORD_BYTES || ref.offset + ref.length > PACK_BYTES
      || !Number.isSafeInteger(ref.window) || ref.window % 60_000 || !Number.isSafeInteger(ref.pointCount)
      || ref.pointCount < 1 || ref.pointCount > 601 || ![1, 2].includes(ref.type)) throw problem("invalid point pack record reference", 503);
    if (!intervals.has(ref.packHash)) intervals.set(ref.packHash, []);
    intervals.get(ref.packHash).push([ref.offset, ref.offset + ref.length]);
  }
  for (const ranges of intervals.values()) {
    ranges.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < ranges.length; index++) if (ranges[index][0] < ranges[index - 1][1]) throw problem("overlapping point pack records", 503);
  }
  for (const [key, hash] of Object.entries(index.bases)) {
    const ref = index.blocks[hash];
    if (!/^-?\d+:\d+$/.test(key) || !validHash(hash) || !ref || ref.type !== 1 || key !== `${ref.window}:${ref.pointCount}`) throw problem("invalid plain point base reference", 503);
  }
  return index;
}
export function createPointPackCache() { return { indexes: new Map(), bytes: 0 }; }
export async function readPointContext(root, context, cache) {
  if (!validHash(context)) throw problem("invalid point context identity", 503);
  if (cache?.indexes.has(context)) return cache.indexes.get(context);
  const path = indexPath(root, context), info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > INDEX_BYTES) throw problem("point context index capacity exceeded", 503);
  const bytes = await readFile(path), value = { index: validateIndex(JSON.parse(bytes.toString("utf8")), context), bytes: bytes.byteLength };
  if (cache) {
    while (cache.indexes.size && cache.bytes + value.bytes > INDEX_BYTES) { const key = cache.indexes.keys().next().value; cache.bytes -= cache.indexes.get(key).bytes; cache.indexes.delete(key); }
    cache.indexes.set(context, value); cache.bytes += value.bytes;
  }
  return value;
}
export async function readPackedPointBytes(root, hash, context, window, cache) {
  const info = await readPointContext(root, context, cache), ref = info?.index.blocks[hash];
  if (!ref) return null;
  if (ref.window !== window) throw problem("point pack window identity mismatch", 503);
  const path = join(root, "point-blocks", `${ref.packHash}.pack`);
  const pathInfo = await lstat(path);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw problem("point pack must be an ordinary file", 503);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > PACK_BYTES || ref.offset + ref.length > stat.size) throw problem("point pack record exceeds actual file length", 503);
    const bytes = Buffer.alloc(ref.length); let received = 0;
    while (received < bytes.length) {
      const read = await file.read(bytes, received, bytes.length - received, ref.offset + received);
      if (!read.bytesRead) throw problem("point pack record truncated", 503); received += read.bytesRead;
    }
    if (hashBytes(bytes) !== ref.recordSha256) throw problem("point pack record checksum mismatch", 503);
    return bytes;
  } finally { await file.close(); }
}
async function existingPack(root, hash, bytes) {
  const path = join(root, "point-blocks", `${hash}.pack`), info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length || info.size > PACK_BYTES || hashBytes(await readFile(path)) !== hash) throw problem("immutable point pack identity mismatch", 503);
  return true;
}
export async function planPointPacks(root, plan) {
  const groups = new Map(); plan.packs = []; plan.contextUpdates = new Map();
  for (const [hash, body] of plan.blocks) {
    if (plan.existing.has(hash)) continue;
    const info = plan.blockInfo.get(hash);
    if (!groups.has(info.context)) groups.set(info.context, []);
    groups.get(info.context).push({ hash, body, info });
  }
  let addedBytes = 0;
  for (const [context, records] of groups) {
    const bytes = Buffer.concat(records.map(record => record.body));
    if (bytes.length > PACK_BYTES) throw problem("immutable point pack capacity exceeded", 413);
    const packHash = hashBytes(bytes), references = {}; let offset = 0;
    for (const { hash, body, info } of records) {
      references[hash] = { packHash, offset, length: body.length, recordSha256: hashBytes(body), window: info.window,
        pointCount: info.points.length, type: info.type ?? 1 }; offset += body.length;
    }
    const old = await readPointContext(root, context, plan.packCache);
    const index = { version: 1, context, blocks: { ...old?.index.blocks, ...references }, bases: { ...old?.index.bases } };
    const bases = {};
    for (const base of plan.bases.values()) if (base.context === context) {
      const key = `${base.window}:${base.pointCount}`; if (!index.bases[key]) { index.bases[key] = base.hash; bases[key] = base.hash; }
    }
    const indexBytes = Buffer.byteLength(`${JSON.stringify(validateIndex(index, context))}\n`);
    if (indexBytes > INDEX_BYTES) throw problem("point context metadata capacity exceeded", 413);
    const exists = await existingPack(root, packHash, bytes);
    if (!exists) addedBytes += bytes.length;
    addedBytes += indexBytes - (old?.bytes ?? 0);
    plan.packs.push({ context, packHash, bytes, exists }); plan.contextUpdates.set(context, { references, bases });
  }
  return addedBytes;
}
async function publishPack(root, pack) {
  if (pack.exists) return;
  const path = join(root, "point-blocks", `${pack.packHash}.pack`), temporary = `${path}.${randomUUID()}.part`, file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(pack.bytes); await file.sync(); } finally { await file.close(); }
  try {
    // A unique same-directory temporary plus hard-link publication never replaces
    // an existing immutable pack. Reuse verifies the complete pack's raw SHA.
    try { await link(temporary, path); } catch (error) { if (error.code !== "EEXIST") throw error; await existingPack(root, pack.packHash, pack.bytes); }
  } finally { await unlink(temporary).catch(() => {}); }
}
const contextWrites = new Map();
async function withContextWrite(root, context, action) {
  // The service already serializes jobs until the actual worker exits; offline
  // preparation has one writer in a fresh directory. This queue also protects
  // direct concurrent calls within one worker, without persistent lock files
  // that could strand a run after a killed worker or a whole-service restart.
  const key = `${root}\0${context}`, next = (contextWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  contextWrites.set(key, next);
  try { return await next; } finally { if (contextWrites.get(key) === next) contextWrites.delete(key); }
}
export async function writePointPacks(root, plan) {
  if (!plan.packs.length) return;
  await mkdir(join(root, "point-blocks"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "point-bases"), { recursive: true, mode: 0o700 });
  for (const pack of plan.packs) await publishPack(root, pack);
  for (const [context, update] of plan.contextUpdates) await withContextWrite(root, context, async () => {
    const current = await readPointContext(root, context), index = { version: 1, context, blocks: { ...current?.index.blocks }, bases: { ...current?.index.bases } };
    for (const [hash, record] of Object.entries(update.references)) if (!index.blocks[hash]) index.blocks[hash] = record;
    for (const [key, hash] of Object.entries(update.bases)) if (!index.bases[key]) index.bases[key] = hash;
    const bytes = `${JSON.stringify(validateIndex(index, context))}\n`;
    if (Buffer.byteLength(bytes) > INDEX_BYTES) throw problem("point context metadata capacity exceeded", 413);
    const path = indexPath(root, context), temporary = `${path}.${randomUUID()}.part`, file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
  });
}
