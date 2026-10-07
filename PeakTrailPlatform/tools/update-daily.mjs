import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDaily } from "../server/peak-daily.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const platformDirectory = resolve(toolDirectory, "..");
const outputDirectory = resolve(platformDirectory, "data", "daily");
const currentPath = resolve(outputDirectory, "current.json");
const historyPath = resolve(outputDirectory, "history.json");

// Share API version, validation, retries and observation timing with /api/daily.
const current = await resolveDaily();

await mkdir(outputDirectory, { recursive: true });

let history = { schemaVersion: 1, observations: [] };
try {
  history = JSON.parse(await readFile(historyPath, "utf8"));
  if (!Array.isArray(history.observations)) {
    throw new Error("history observations is not an array");
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

const previous = history.observations.at(-1);
if (!previous || previous.levelIndex !== current.levelIndex) {
  history.observations.push({
    observedAtUtc: current.fetchedAtUtc,
    levelIndex: current.levelIndex,
    mapSlot: current.mapSlot,
    sceneName: current.sceneName,
    nextChangeAtUtc: current.nextChangeAtUtc
  });
}

await Promise.all([
  writeJson(currentPath, current),
  writeJson(historyPath, history)
]);

console.log(`PEAK LevelIndex ${current.levelIndex} -> ${current.sceneName}; next change ${current.nextChangeAtUtc}`);

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
