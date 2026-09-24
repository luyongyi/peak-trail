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
  let inFlight = null;
  let disposed = false;

  function wake() {
    if (disposed) return Promise.resolve();
    if (!inFlight) {
      inFlight = (async () => {
        const deadline = Date.parse(daily?.nextChangeAtUtc);
        if (Number.isFinite(deadline) && deadline <= now()) await expire(daily);
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
      if (disposed) return;
      const delay = Date.parse(daily?.nextChangeAtUtc) - now();
      if (Number.isFinite(delay) && delay > 0) expiryTimer = setTimer(wake, delay + 50);
      if (retryAt > now()) retryTimer = setTimer(wake, retryAt - now() + 50);
    },
    dispose() {
      disposed = true;
      clearTimer(expiryTimer);
      clearTimer(retryTimer);
    },
  };
}
