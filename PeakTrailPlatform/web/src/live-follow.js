// Live-follow chase math. Following the live edge used to mean a once-per-second
// jump to the newest record: markers teleported (read as packet loss) and state
// changes like the held item only rendered on the next tick. Instead the
// playhead continuously chases a point just behind the newest record so sample
// interpolation keeps motion smooth.

/** Default trail until the arrival-cadence estimator has enough samples. */
export const LIVE_TRAIL_S = 0.3;
/** Falling further behind than this (attach, tab sleep, stream stall) snaps to
 * the edge instead of fast-forwarding through the backlog at 1x. */
export const LIVE_SNAP_BEHIND_S = 1.5;

/**
 * @param {{currentTime: number, edge: number, deltaSeconds: number, trailSeconds?: number}} state
 * @returns {number | null} the playhead time to move to this frame, or null to
 *   hold position (already at the trailing edge).
 */
export function liveChaseTarget({ currentTime, edge, deltaSeconds, trailSeconds = LIVE_TRAIL_S }) {
  const target = Math.max(0, edge - Math.max(0, trailSeconds));
  const behind = target - currentTime;
  if (behind <= 0) return null;
  if (behind > LIVE_SNAP_BEHIND_S) return target;
  return Math.min(target, currentTime + Math.max(0, deltaSeconds));
}

/**
 * Playout-delay estimator (the VoIP jitter-buffer idea): watches how fast live
 * sample records actually arrive and sizes the trail to the observed cadence,
 * so the viewer buffers no more than the stream needs. A denser stream (e.g.
 * 20 Hz relay sampling) automatically shrinks the trail and the latency.
 *
 * Observes wall-clock arrival gaps of accepted sample records; gaps outside
 * [8 ms, 1.5 s] are ignored — burst-internal (~0 ms) and network-stall (seconds)
 * arrivals would otherwise skew the estimate. The trail tracks a high quantile
 * of recent gaps with margin, clamped to sane bounds.
 */
export function createTrailEstimator({
  minMs = 80,
  maxMs = 400,
  defaultMs = Math.round(LIVE_TRAIL_S * 1000),
  windowSize = 16,
  minSamples = 4,
  maxGapMs = 1500,
} = {}) {
  const gaps = [];
  let last = null;
  return {
    observe(nowMs) {
      if (last !== null) {
        const gap = nowMs - last;
        if (gap >= 8 && gap <= maxGapMs) {
          gaps.push(gap);
          if (gaps.length > windowSize) gaps.shift();
        }
      }
      last = nowMs;
    },
    trailMs() {
      if (gaps.length < minSamples) return defaultMs;
      const sorted = [...gaps].sort((left, right) => left - right);
      const p85 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.85))];
      return Math.min(maxMs, Math.max(minMs, Math.round(p85 * 1.25)));
    },
    reset() {
      gaps.length = 0;
      last = null;
    },
  };
}

// The room API delivers a batch after each one-second poll. Measure a batch
// once, not once per player or sample. Let the clock consume that batch
// between polls, up to the last known timestamp; never predict a position.
export function createPacketPlayout() {
  const delay = createTrailEstimator({ minMs: 1150, defaultMs: 1500, maxMs: 2400, maxGapMs: 3000 });
  let lastEdge = null, arrivalMs = 0;
  function target(edge, nowMs) {
    const elapsed = lastEdge === edge ? Math.max(0, nowMs - arrivalMs) : 0;
    return Math.max(0, Math.min(edge, edge + (elapsed - delay.trailMs()) / 1000));
  }
  return {
    observe(edge, nowMs) {
      if (!Number.isFinite(edge) || lastEdge !== null && edge <= lastEdge) return;
      delay.observe(nowMs);
      lastEdge = edge;
      arrivalMs = nowMs;
    },
    reset() { lastEdge = null; arrivalMs = 0; delay.reset(); },
    target,
    next(current, edge, delta, nowMs) {
      if (edge <= current || delta <= 0) return null;
      const desired = target(edge, nowMs);
      if (desired === 0 && current === 0) return null;
      const drift = desired - current;
      if (drift > LIVE_SNAP_BEHIND_S) return desired;
      // Absorb ordinary arrival jitter gradually, without frame jumps or
      // rewinding. After an actual outage the marker holds at the final sample.
      const rate = 1 + Math.max(-0.12, Math.min(0.12, (drift - delta) * 0.4));
      return Math.min(edge, current + delta * rate);
    },
  };
}
