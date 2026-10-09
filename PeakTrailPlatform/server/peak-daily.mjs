// Resolves PEAK's current daily-map rotation from the game's own login API.
// Shared by the live relay (/api/daily) and tools/update-daily.mjs. The endpoint
// rejects requests without this project's User-Agent, so the header is mandatory.
// PEAK 2.6.b's CloudAPI uses BuildVersion.ToMatchmaking(): major.minor.
// Keep this one default shared by the relay, preview and scheduled updater.
export const DEFAULT_API_VERSION = "2.6";
export const DEFAULT_MAP_COUNT = 21;
export const DAILY_CACHE_MS = 10 * 60_000;
// Current NextLevelService adds the native integer HoursUntilLevel directly;
// it is a total hour count, not a 0..23 wall-clock component. Bound the sum to
// the game's signed 32-bit second arithmetic rather than assuming a daily lock.
const MAX_NATIVE_COUNTDOWN_SECONDS = 2_147_483_647;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function latestDailyBoundary(now = Date.now()) {
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(current)) return NaN;
  const local = new Date(current + SHANGHAI_OFFSET_MS);
  let boundary = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 1)
    - SHANGHAI_OFFSET_MS;
  if (current < boundary) boundary -= DAY_MS;
  return boundary;
}

export function cachedDailyIsFresh(daily, now = Date.now()) {
  const current = now instanceof Date ? now.getTime() : Number(now);
  const fetched = Date.parse(daily?.fetchedAtUtc);
  const deadline = Date.parse(daily?.nextChangeAtUtc);
  return Number.isFinite(current) && Number.isFinite(fetched) && Number.isFinite(deadline)
    && fetched <= current && fetched >= latestDailyBoundary(current) && deadline > current;
}

/** Coalesce requests without renewing expired/previous-rotation observations. */
export function createDailyCache({ resolver = resolveDaily, now = Date.now, ttlMs = DAILY_CACHE_MS } = {}) {
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;
  function read() {
    const current = Number(now());
    const age = current - cachedAt;
    if (cached && age >= 0 && age < ttlMs && cachedDailyIsFresh(cached, current)) return Promise.resolve(cached);
    if (!inFlight) {
      inFlight = Promise.resolve().then(resolver).then(data => {
        cached = data;
        cachedAt = Number(now());
        return data;
      }).finally(() => { inFlight = null; });
    }
    return inFlight;
  }
  function startPrewarm() {
    const warm = () => { read().catch(() => {}); };
    warm();
    const timer = setInterval(warm, Math.floor(ttlMs / 2));
    timer.unref?.();
    return () => clearInterval(timer);
  }
  return { read, startPrewarm };
}

export function dailyEndpoint(apiVersion = DEFAULT_API_VERSION) {
  return process.env.PEAK_DAILY_ENDPOINT
    ?? `https://peaklogin3.azurewebsites.net/api/VersionCheck?version=${encodeURIComponent(apiVersion)}`;
}

export async function resolveDaily({
  apiVersion = process.env.PEAK_API_VERSION || DEFAULT_API_VERSION,
  mapCount = Number(process.env.PEAK_MAP_COUNT || DEFAULT_MAP_COUNT), endpoint = null,
  now = Date.now, fetchImpl = globalThis.fetch,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isSafeInteger(mapCount) || mapCount <= 0) throw new Error("PEAK_MAP_COUNT must be a positive integer");
  const source = endpoint ?? dailyEndpoint(apiVersion);
  const clock = () => {
    const value = typeof now === "function" ? now() : now;
    const time = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(time)) throw new Error("Daily observation clock is invalid");
    return time;
  };
  const { payload, observedAt } = await fetchDailyPayload(source, { fetchImpl, sleepImpl, clock });
  if (!Number.isSafeInteger(payload.LevelIndex)) {
    throw new Error("PEAK daily endpoint did not return an integer LevelIndex");
  }
  if (payload.VersionOkay !== true) {
    throw new Error(`PEAK daily endpoint rejected API version ${apiVersion}`);
  }

  const secondsRemaining = [
    countdownPart(payload.HoursUntilLevel, "HoursUntilLevel", Math.floor(MAX_NATIVE_COUNTDOWN_SECONDS / 3600)) * 3600,
    countdownPart(payload.MinutesUntilLevel, "MinutesUntilLevel", 59) * 60,
    countdownPart(payload.SecondsUntilLevel, "SecondsUntilLevel", 59),
  ].reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(secondsRemaining) || secondsRemaining < 0 || secondsRemaining > MAX_NATIVE_COUNTDOWN_SECONDS) {
    throw new Error("PEAK daily endpoint returned an invalid rotation countdown");
  }

  return {
    schemaVersion: 1,
    fetchedAtUtc: new Date(observedAt).toISOString(),
    nextChangeAtUtc: new Date(observedAt + secondsRemaining * 1000).toISOString(),
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

async function fetchDailyPayload(url, { fetchImpl, sleepImpl, clock }) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const requestedAt = clock();
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "peak-trail-platform-daily-monitor/1.0",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`PEAK daily endpoint returned HTTP ${response.status}`);
      }
      const payload = await response.json();
      const observedAt = clock();
      // A request crossing 01:00 might contain the prior map. Requery it;
      // relabelling that response with a new observation date is unsafe.
      if (latestDailyBoundary(requestedAt) !== latestDailyBoundary(observedAt)) {
        throw new Error("PEAK rotation changed while querying the daily map");
      }
      return { payload, observedAt };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleepImpl(attempt * 2_000);
      }
    }
  }
  throw lastError;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function countdownPart(value, name, maximum) {
  const parsed = Number(value);
  if (value === null || value === undefined || !Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`PEAK daily endpoint returned an invalid ${name}`);
  }
  return parsed;
}
