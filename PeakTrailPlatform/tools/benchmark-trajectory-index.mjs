// Synthetic local I/O benchmark. No server, player data, or public API is used.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadIndex } from "../server/trajectory-store.mjs";
import { digest, LIMITS } from "../server/trajectory-contract.mjs";

const count = Number(process.argv[2] ?? 5000), runs = Number(process.argv[3] ?? 5);
if (!Number.isInteger(count) || count < 1 || count > LIMITS.uploads || !Number.isInteger(runs) || runs < 1 || runs > 20) {
  throw new Error("Usage: node benchmark-trajectory-index.mjs [index-count:1..10000] [runs:1..20]");
}
// The pre-optimization loader, retained here solely for matched-input timing.
async function serialIndex(root) {
  for (const child of ["index", "uploads", "routes"]) await mkdir(join(root, child), { recursive: true, mode: 0o700 });
  const files = (await readdir(join(root, "index"))).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
  if (files.length > LIMITS.uploads) throw new Error("storage index limit exceeded");
  const entries = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(await readFile(join(root, "index", file), "utf8"));
      if (entry.version === 1 && entry.id === file.slice(0, -5) && ["pending", "approved", "hidden", "rejected"].includes(entry.moderationStatus)) entries.push(entry);
    } catch { /* same fail-closed omission as the old production loader */ }
  }
  return entries;
}
const root = await mkdtemp(join(tmpdir(), "peak-index-benchmark-"));
try {
  await mkdir(join(root, "index"));
  for (let start = 0; start < count; start += 16) {
    await Promise.all(Array.from({ length: Math.min(16, count - start) }, async (_, offset) => {
      const id = digest(`synthetic-index-${start + offset}`), key = digest(`synthetic-member-${start + offset}`);
      const stages = ["Shore", "Roots", "Alpine", "Volcano", "Kiln"].map((name, index) => ({ index, name, enterZCm: index * 10000, exitZCm: (index + 1) * 10000 }));
      const entry = { version: 1, id, recordingId: id, groupId: digest("synthetic-group"), moderationStatus: "approved",
        map: { buildId: "12345678", scene: "Level_0", layoutKey: digest("synthetic-layout"), route: stages.map(stage => stage.name), stages },
        difficulty: { key: "a:1;c:false;m:false", ascent: 1, custom: false, mini: false },
        players: [{ key, name: "Synthetic member", evidence: "native-state", stages: stages.map(stage => ({ index: stage.index, completion: "complete", routeCount: 1 })) }],
        routes: stages.map(stage => ({ id: digest(`${id}-${stage.index}`), file: `${id}-p0-s${stage.index}-a0.json.gz`, playerKey: key, stageIndex: stage.index, pointCount: 12000 })) };
      await writeFile(join(root, "index", `${id}.json`), JSON.stringify(entry));
    }));
  }
  const serialMs = [], boundedMs = [];
  // Warm both implementations, then alternate order to reduce filesystem-cache bias.
  assert.deepEqual(await loadIndex(root), await serialIndex(root));
  async function measure(fn, timings) { const before = performance.now(), value = await fn(root); timings.push(performance.now() - before); return value; }
  for (let run = 0; run < runs; run++) {
    const serialFirst = run % 2 === 0;
    const first = await measure(serialFirst ? serialIndex : loadIndex, serialFirst ? serialMs : boundedMs);
    const second = await measure(serialFirst ? loadIndex : serialIndex, serialFirst ? boundedMs : serialMs);
    assert.deepEqual(first, second);
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const serialMedianMs = median(serialMs), boundedMedianMs = median(boundedMs);
  console.log(JSON.stringify({ synthetic: true, phase: "index-read-only", node: process.version, count, runs,
    identicalResults: true, serialMs, boundedMs, serialMedianMs, boundedMedianMs,
    speedup: serialMedianMs / boundedMedianMs }, null, 2));
} finally {
  // This is the exact temporary directory created above, never a supplied path.
  await rm(root, { recursive: true, force: true });
}
