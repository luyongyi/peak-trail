import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMapPackIdentity } from "./lib/map-pack-identity.mjs";

// A read-only geometric check, not a claim that every climber stands on the
// topmost surface. Caves, overhangs and airborne players need a full 3D model.
export function measureAlignment(samples, layers) {
  const perSegment = new Map();
  const deltas = [];
  let inBounds = 0, supported = 0, valid = 0;
  for (const sample of samples) {
    if (!Array.isArray(sample.pos) || sample.pos.length !== 3 || !sample.pos.every(Number.isFinite)) continue;
    valid++;
    const [x, y, z] = sample.pos;
    // Its enormous collision floor is not evidence that an ordinary mountain
    // trace is aligned. Void needs a separate, explicitly scoped validation.
    const candidates = layers.filter((layer) => String(layer.biome).toLowerCase() !== "void"
      && x >= layer.minX && x <= layer.maxX && z >= layer.minZ && z <= layer.maxZ);
    if (candidates.length) inBounds++;
    const surfaces = candidates.map((layer) => {
      const col = Math.min(layer.columns - 1, Math.floor((x - layer.minX) / (layer.maxX - layer.minX) * layer.columns));
      const row = Math.min(layer.rows - 1, Math.floor((z - layer.minZ) / (layer.maxZ - layer.minZ) * layer.rows));
      return { segment: layer.segment, delta: y - layer.values[row * layer.columns + col] };
    }).filter((surface) => Number.isFinite(surface.delta));
    if (!surfaces.length) continue;
    // activeSegment is global game progress, not necessarily the player's
    // physical segment. Match by XYZ instead of assigning that progress index.
    const nearest = surfaces.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
    supported++;
    deltas.push(nearest.delta);
    perSegment.set(nearest.segment, (perSegment.get(nearest.segment) || 0) + 1);
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  const absolute = deltas.map(Math.abs).sort((a, b) => a - b);
  const percentile = (values, p) => values.length ? Number(values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))].toFixed(3)) : null;
  return {
    samples: valid, inBounds, supported,
    supportedPercent: valid ? Number((100 * supported / valid).toFixed(2)) : 0,
    signedHeightDeltaMeters: { min: percentile(sorted, 0), median: percentile(sorted, 0.5), max: percentile(sorted, 1) },
    absoluteHeightDeltaMeters: { median: percentile(absolute, 0.5), p90: percentile(absolute, 0.9), p99: percentile(absolute, 0.99) },
    within5Meters: deltas.filter((delta) => Math.abs(delta) <= 5).length,
    samplesPerNearestSegment: Object.fromEntries([...perSegment.entries()].sort((a, b) => a[0] - b[0])),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [traceDirectory, packDirectory] = process.argv.slice(2);
  if (!traceDirectory || !packDirectory) throw new Error("Usage: node tools/check-trace-alignment.mjs <recording-folder> <map-pack-folder>");
  const manifest = JSON.parse(await readFile(resolve(traceDirectory, "manifest.json"), "utf8"));
  const pack = JSON.parse(await readFile(resolve(packDirectory, "map-pack.json"), "utf8"));
  verifyMapPackIdentity(pack);
  for (const key of ["sceneName", "gameBuildId", "projectionVersion", "coordinateSpace"]) {
    if (String(manifest[key]) !== String(pack[key])) throw new Error(`Trace/map ${key} mismatch`);
  }
  let text;
  try { text = await readFile(resolve(traceDirectory, "stream.ndjson"), "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    text = await readFile(resolve(traceDirectory, "stream.ndjson.partial"), "utf8");
  }
  const samples = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.type === "sample");
  const layers = await Promise.all(pack.layers.map(async (layer) => {
    const bytes = await readFile(resolve(packDirectory, layer.height));
    if (bytes.length !== layer.columns * layer.rows * 4) throw new Error(`Invalid height size: ${layer.id}`);
    const values = new Float32Array(layer.columns * layer.rows);
    for (let i = 0; i < values.length; i++) values[i] = bytes.readFloatLE(i * 4);
    return { ...layer, values };
  }));
  console.log(JSON.stringify({
    sceneName: pack.sceneName, gameBuildId: pack.gameBuildId, mapPackId: pack.mapPackId,
    ...measureAlignment(samples, layers),
    note: "Position-to-top-surface comparison excluding Void's huge floor; positive delta means the player is above the surface. This does not validate caves, overhangs, visual texture orientation, Void, or all 21 scenes.",
  }, null, 2));
}
