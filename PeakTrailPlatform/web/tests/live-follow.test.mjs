import assert from "node:assert/strict";
import test from "node:test";
import { createPacketPlayout, createTrailEstimator, liveChaseTarget, LIVE_SNAP_BEHIND_S, LIVE_TRAIL_S } from "../src/live-follow.js";

test("live chase holds position once the playhead reaches the trailing edge", () => {
  assert.equal(liveChaseTarget({ currentTime: 10, edge: 10.3, deltaSeconds: 0.016 }), null);
  assert.equal(liveChaseTarget({ currentTime: 10.5, edge: 10.3, deltaSeconds: 0.016 }), null,
    "ahead of the trailing edge (fresh attach) holds instead of rewinding");
});

test("live chase advances smoothly at 1x and never overshoots the trailing edge", () => {
  const next = liveChaseTarget({ currentTime: 10, edge: 10.35, deltaSeconds: 0.016 });
  assert.equal(next, 10.016);
  // A large frame delta (tab jank) is clamped to the target, not past it.
  const clamped = liveChaseTarget({ currentTime: 10, edge: 10.35, deltaSeconds: 0.25 });
  assert.ok(Math.abs(clamped - (10 + (0.35 - LIVE_TRAIL_S))) < 1e-9, `clamped to target, got ${clamped}`);
  // Negative deltas (timestamp jitter) never move the playhead backward.
  assert.equal(liveChaseTarget({ currentTime: 10, edge: 10.35, deltaSeconds: -0.01 }), 10);
});

test("live chase snaps to the edge after a stall instead of fast-forwarding at 1x", () => {
  const edge = 20;
  const target = edge - LIVE_TRAIL_S;
  assert.equal(
    liveChaseTarget({ currentTime: target - (LIVE_SNAP_BEHIND_S + 0.4), edge, deltaSeconds: 0.016 }),
    target,
    "a stalled stream resuming more than the snap window ahead snaps immediately",
  );
  assert.equal(
    liveChaseTarget({ currentTime: target - (LIVE_SNAP_BEHIND_S - 0.2), edge, deltaSeconds: 0.016 }),
    target - (LIVE_SNAP_BEHIND_S - 0.2) + 0.016,
    "just inside the window it keeps chasing smoothly",
  );
});

test("live chase clamps the target at zero for very short runs", () => {
  // An edge inside the trail window clamps the target to 0: nothing to chase.
  assert.equal(liveChaseTarget({ currentTime: 0, edge: 0.1, deltaSeconds: 0.016 }), null);
  assert.equal(liveChaseTarget({ currentTime: 0.05, edge: 0.1, deltaSeconds: 5 }), null);
  assert.equal(liveChaseTarget({ currentTime: 0, edge: 5, deltaSeconds: 5 }), 5 - LIVE_TRAIL_S,
    "a snap inside a short run still reaches the trailing edge");
});

test("packet navigation plays timestamped positions between HTTP batches without stopping at every poll", () => {
  const clock = createPacketPlayout(), arrivals = [1060, 1200, 1380, 1070, 1020, 1300, 1150];
  const frameMs = 1000 / 60, sampleMs = 112;
  let due = 0, batch = 0, edge = 0, time;
  for (let frame = 0; frame < 1800; frame++) {
    const now = frame * frameMs;
    if (now >= due) {
      edge = 40 + Math.floor(now / sampleMs) * sampleMs / 1000;
      clock.observe(edge, now);
      due += arrivals[batch++ % arrivals.length];
    }
    time ??= clock.target(edge, now);
    const next = clock.next(time, edge, frameMs / 1000, now);
    assert.ok(next > time && next - time <= 1.13 / 60, "smooth forward frames between ordinary batches");
    assert.ok(next <= edge, "never display movement beyond the captured samples");
    time = next;
  }
  assert.ok(edge - time < 2, "playback stays near the room after thirty seconds");
});

test("packet clock ignores empty repeats, holds at the final known sample, and resets for a new scene", () => {
  const clock = createPacketPlayout();
  clock.observe(20, 1000);
  const initial = clock.target(20, 1000);
  clock.observe(20, 2100);
  assert.equal(clock.target(20, 2100), initial + 1.1);
  assert.equal(clock.target(20, 15000), 20);
  assert.equal(clock.next(20, 20, .016, 15000), null);
  clock.observe(30, 15100);
  assert.equal(clock.next(20, 30, .016, 15100), clock.target(30, 15100), "seek past a long outage");
  clock.reset();
  clock.observe(.3, 20000);
  assert.equal(clock.next(0, .3, .016, 20000), null, "prime the short initial packet window");
  clock.observe(3, 22600);
  assert.equal(clock.target(3, 22600), 1.5);
});

test("trail estimator falls back to the default until it has enough samples", () => {
  const estimator = createTrailEstimator();
  assert.equal(estimator.trailMs(), 300, "cold estimator serves the default trail");
  estimator.observe(0);
  estimator.observe(100);
  estimator.observe(200);
  assert.equal(estimator.trailMs(), 300, "below minSamples keeps the default");
});

test("trail estimator tracks the observed arrival cadence and clamps to bounds", () => {
  const estimator = createTrailEstimator();
  // Steady 100 ms arrival cadence (20 Hz sampling + 100 ms batching).
  for (let i = 1; i <= 8; i += 1) estimator.observe(i * 100);
  assert.ok(Math.abs(estimator.trailMs() - 125) <= 1, `p85 of 100ms gaps x1.25 = 125, got ${estimator.trailMs()}`);

  // Steady 250 ms cadence (5 Hz + 250 ms flush) matches the old fixed trail.
  const slow = createTrailEstimator();
  for (let i = 1; i <= 8; i += 1) slow.observe(i * 250);
  assert.ok(Math.abs(slow.trailMs() - 313) <= 1, `p85 of 250ms gaps x1.25 = 313, got ${slow.trailMs()}`);

  // Tight cadence clamps at the minimum so interpolation never starves.
  const fast = createTrailEstimator();
  for (let i = 1; i <= 8; i += 1) fast.observe(i * 10 + i); // 11ms gaps pass the 8ms floor
  assert.equal(fast.trailMs(), 80, "tiny gaps clamp to minMs");

  // A single stall gap does not inflate the trail (excluded as out of range).
  const jittery = createTrailEstimator();
  for (let i = 1; i <= 8; i += 1) jittery.observe(i * 100);
  jittery.observe(8 * 100 + 5000); // 5s network stall — filtered
  jittery.observe(8 * 100 + 5100);
  assert.ok(Math.abs(jittery.trailMs() - 125) <= 1, "stall gap ignored, trail stays at cadence");
});

test("live chase honours the adaptive trail parameter", () => {
  // 20 Hz stream: estimator says 125 ms — the chase trails that much closer.
  assert.equal(liveChaseTarget({ currentTime: 10, edge: 10.2, deltaSeconds: 0.016, trailSeconds: 0.125 }), 10.016);
  assert.equal(liveChaseTarget({ currentTime: 10.1, edge: 10.2, deltaSeconds: 0.016, trailSeconds: 0.125 }), null);
  // Negative/absurd trails are clamped to a non-negative target offset.
  assert.equal(liveChaseTarget({ currentTime: 0, edge: 5, deltaSeconds: 1, trailSeconds: -1 }), 5,
    "trail below zero means chase the edge itself");
});
