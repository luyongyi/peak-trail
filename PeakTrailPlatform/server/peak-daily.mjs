// Resolves PEAK's current daily-map rotation from the game's own login API.
// Shared by the live relay (/api/daily) and tools/update-daily.mjs. The endpoint
// rejects requests without this project's User-Agent, so the header is mandatory.
export const DEFAULT_API_VERSION = "2.4";
export const DEFAULT_MAP_COUNT = 21;

export function dailyEndpoint(apiVersion = DEFAULT_API_VERSION) {
  return process.env.PEAK_DAILY_ENDPOINT
    ?? `https://peaklogin3.azurewebsites.net/api/VersionCheck?version=${encodeURIComponent(apiVersion)}`;
}

export async function resolveDaily({ apiVersion = DEFAULT_API_VERSION, mapCount = DEFAULT_MAP_COUNT, endpoint = null, now = new Date() } = {}) {
  const source = endpoint ?? dailyEndpoint(apiVersion);
  const payload = await fetchDailyPayload(source);
  if (!Number.isInteger(payload.LevelIndex)) {
    throw new Error("PEAK daily endpoint did not return an integer LevelIndex");
  }
  if (payload.VersionOkay !== true) {
    throw new Error(`PEAK daily endpoint rejected API version ${apiVersion}`);
  }

  const secondsRemaining = [
    countdownPart(payload.HoursUntilLevel, "HoursUntilLevel") * 3600,
    countdownPart(payload.MinutesUntilLevel, "MinutesUntilLevel") * 60,
    countdownPart(payload.SecondsUntilLevel, "SecondsUntilLevel"),
  ].reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(secondsRemaining) || secondsRemaining < 0) {
    throw new Error("PEAK daily endpoint returned an invalid rotation countdown");
  }

  return {
    schemaVersion: 1,
    fetchedAtUtc: now.toISOString(),
    nextChangeAtUtc: new Date(now.getTime() + secondsRemaining * 1000).toISOString(),
    source,
    apiVersion,
    versionOkay: payload.VersionOkay,
    levelIndex: payload.LevelIndex,
    mapCount,
    mapSlot: positiveModulo(payload.LevelIndex, mapCount),
    sceneName: `Level_${positiveModulo(payload.LevelIndex, mapCount)}`,
    secondsRemaining,
    message: String(payload.Message ?? ""),
  };
}

async function fetchDailyPayload(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "peak-trail-platform-daily-monitor/1.0",
        },
        signal: AbortSignal.timeout(20_000),
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

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function countdownPart(value, name) {
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`PEAK daily endpoint returned an invalid ${name}`);
  }
  return parsed;
}
