import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const platformDirectory = resolve(toolDirectory, "..");
const outputDirectory = resolve(platformDirectory, "data", "daily");
const currentPath = resolve(outputDirectory, "current.json");
const historyPath = resolve(outputDirectory, "history.json");

const apiVersion = process.env.PEAK_API_VERSION ?? "2.4";
const mapCount = parsePositiveInteger(process.env.PEAK_MAP_COUNT ?? "21", "PEAK_MAP_COUNT");
const endpoint = process.env.PEAK_DAILY_ENDPOINT
  ?? `https://peaklogin3.azurewebsites.net/api/VersionCheck?version=${encodeURIComponent(apiVersion)}`;

const payload = await fetchDailyPayload(endpoint);
if (!Number.isInteger(payload.LevelIndex)) {
  throw new Error("PEAK daily endpoint did not return an integer LevelIndex");
}
if (payload.VersionOkay !== true) {
  throw new Error(`PEAK daily endpoint rejected API version ${apiVersion}`);
}

const secondsRemaining = [
  countdownPart(payload.HoursUntilLevel, "HoursUntilLevel") * 3600,
  countdownPart(payload.MinutesUntilLevel, "MinutesUntilLevel") * 60,
  countdownPart(payload.SecondsUntilLevel, "SecondsUntilLevel")
].reduce((sum, value) => sum + value, 0);

if (!Number.isFinite(secondsRemaining) || secondsRemaining < 0) {
  throw new Error("PEAK daily endpoint returned an invalid rotation countdown");
}

const fetchedAt = new Date();
const mapSlot = positiveModulo(payload.LevelIndex, mapCount);
const current = {
  schemaVersion: 1,
  fetchedAtUtc: fetchedAt.toISOString(),
  nextChangeAtUtc: new Date(fetchedAt.getTime() + secondsRemaining * 1000).toISOString(),
  source: endpoint,
  apiVersion,
  versionOkay: payload.VersionOkay,
  levelIndex: payload.LevelIndex,
  mapCount,
  mapSlot,
  sceneName: `Level_${mapSlot}`,
  secondsRemaining,
  message: String(payload.Message ?? "")
};

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

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function countdownPart(value, name) {
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`PEAK daily endpoint returned an invalid ${name}`);
  }
  return parsed;
}

async function fetchDailyPayload(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "peak-trail-platform-daily-monitor/1.0"
        },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) {
        throw new Error(`PEAK daily endpoint returned HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 2_000));
      }
    }
  }
  throw lastError;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
