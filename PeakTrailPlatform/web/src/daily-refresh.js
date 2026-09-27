const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Most recent 01:00 in Asia/Shanghai. Before 01:00, this is yesterday's boundary. */
export function latestDailyBoundary(now = Date.now()) {
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(current)) return NaN;
  const local = new Date(current + SHANGHAI_OFFSET_MS);
  let boundary = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 1)
    - SHANGHAI_OFFSET_MS;
  if (current < boundary) boundary -= DAY_MS;
  return boundary;
}

export function nextDailyBoundary(now = Date.now()) {
  const boundary = latestDailyBoundary(now);
  return Number.isFinite(boundary) ? boundary + DAY_MS : NaN;
}

/** A pre-boundary observation must be rechecked even if its reported countdown is still positive. */
export function dailyObservationIsFresh(daily, now = Date.now()) {
  const current = now instanceof Date ? now.getTime() : Number(now);
  const fetched = Date.parse(daily?.fetchedAtUtc);
  const deadline = Date.parse(daily?.nextChangeAtUtc);
  const boundary = latestDailyBoundary(current);
  return Number.isFinite(current) && Number.isFinite(fetched) && Number.isFinite(deadline)
    && fetched <= current && fetched >= boundary && deadline > current;
}

/** Prefer the live source, but never turn a skipped retry into a new cooldown. */
export function createDailySourceReader({
  sources, freshness, fetchImpl = globalThis.fetch, now = Date.now,
  retryMs = 30_000, timeoutMs = 5000,
}) {
  const retryAfter = new Map();
  let inFlight = null;

  async function readSources() {
    let stale = null;
    for (const url of [...new Set(sources())]) {
      const backend = url.endsWith("/api/daily");
      if (backend && now() < (retryAfter.get(url) || 0)) continue;
      try {
        const response = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`Daily source returned ${response.status}`);
        const data = await response.json();
        const status = freshness(data, now());
        if (status === "current") {
          retryAfter.delete(url);
          return data;
        }
        if (status === "stale") stale ||= data;
      } catch { /* The static snapshot may still be current. */ }
      // Only a real failed/stale backend attempt starts this bounded cooldown.
      // Static fallback polling and skipped attempts cannot extend it.
      if (backend) retryAfter.set(url, now() + retryMs);
    }
    return stale;
  }

  return {
    read() {
      if (!inFlight) inFlight = readSources().finally(() => { inFlight = null; });
      return inFlight;
    },
    get retryAt() {
      const pending = [...retryAfter.values()].filter(deadline => deadline > now());
      return pending.length ? Math.min(...pending) : 0;
    },
  };
}

/** Boundary/retry timers complement the slow poll; a resumed tab refreshes too. */
export function createDailyRefreshClock({
  refresh, expire, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let daily = null;
  let expiryTimer = null;
  let retryTimer = null;
  let scheduledRetryAt = 0;
  let inFlight = null;
  let disposed = false;

  function wake() {
    if (disposed) return Promise.resolve();
    const current = now();
    if (scheduledRetryAt > current) return Promise.resolve();
    if (daily && dailyObservationIsFresh(daily, current) && scheduledRetryAt <= 0) return Promise.resolve();
    if (!inFlight) {
      inFlight = (async () => {
        if (daily && !dailyObservationIsFresh(daily, now())) await expire(daily);
        await refresh();
      })().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  return {
    wake,
    schedule(value, retryAt = 0) {
      clearTimer(expiryTimer);
      clearTimer(retryTimer);
      daily = value;
      scheduledRetryAt = retryAt;
      if (disposed) return;
      const current = now();
      const reportedDeadline = Date.parse(daily?.nextChangeAtUtc);
      const boundary = nextDailyBoundary(current);
      const deadline = Math.min(
        Number.isFinite(reportedDeadline) ? reportedDeadline : Infinity,
        Number.isFinite(boundary) ? boundary : Infinity,
      );
      const delay = deadline - current;
      if (Number.isFinite(delay) && delay > 0) expiryTimer = setTimer(wake, delay + 50);
      if (retryAt > now()) retryTimer = setTimer(wake, retryAt - now() + 50);
    },
    dispose() {
      disposed = true;
      scheduledRetryAt = 0;
      clearTimer(expiryTimer);
      clearTimer(retryTimer);
    },
  };
}
