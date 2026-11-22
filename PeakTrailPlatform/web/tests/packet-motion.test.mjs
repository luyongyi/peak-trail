import assert from "node:assert/strict";
import test from "node:test";
import { appendPacketMotion, packetPoseAt } from "../src/packet-motion.js";

const point = (playerId, t, x, activeSegment = 0, yaw = 0) =>
  ({ playerId, t, pos: [x, 0, 0], activeSegment, yaw });

test("merges each player's intermediate poses with regular route samples without extending history", () => {
  const route = [point("p1", 1, 0), point("p1", 1.12, 2)];
  const trace = { duration: 1.12, tracks: new Map([["p1", route]]) };
  appendPacketMotion(trace, { reset: true, samples: [point("p1", 1.06, 1), point("p2", 1.06, 5), point("p1", 1.12, 999)] });
  assert.deepEqual(trace.packetMotion.get("p1").poses.map(p => p.pos[0]), [0, 1, 2]);
  assert.deepEqual(trace.packetMotion.get("p2").poses.map(p => p.pos[0]), [5]);
  assert.equal(route.length, 2);
  trace.duration = 12;
  appendPacketMotion(trace, { reset: false, samples: [] });
  assert.equal(trace.packetMotion.size, 0);
  appendPacketMotion(trace, { reset: true, samples: [] });
  assert.equal(trace.packetMotion, undefined);
});

test("weights irregular positions by elapsed time, preserves the base marker's fields, never extrapolates", () => {
  const make = (t, x, yaw = 0) => point("p1", t, x, 0, yaw);
  const poses = [make(0, 0), make(.02, 0, 350), make(.04, 1, 10), make(.08, 0), make(.1, 0)];
  const base = { ...poses[0], telemetry: { stamina: 4 } };
  const s = packetPoseAt(poses, .05, base, []);
  assert.ok(Math.abs(s.pos[0] - (.5 * .06 / .07)) < 1e-9);
  assert.equal(s.telemetry, base.telemetry);
  assert.equal(packetPoseAt(poses, .03, base, []).yaw, 360);
  assert.equal(packetPoseAt(poses, -.01, base, []), base);
  assert.equal(packetPoseAt(poses, .2, base, []), base);
});

test("holds at chapter changes, gaps, warps and lifecycle boundaries", () => {
  const make = (t, x, seg) => point("p1", t, x, seg);
  const a = make(1, 2, 1);
  for (const [b, events] of [[make(1.1, 3, 2), []], [make(1.3, 3, 1), []],
    [make(1.1, 42, 1), []], [make(1.1, 3, 1), [{ t: 1.05, type: "leave" }]]]) {
    assert.deepEqual(packetPoseAt([a, b], 1.07, a, events).pos, a.pos);
  }
  const poses = [make(0, 0, 0), make(.03, 1, 0), make(.06, 2, 0), make(.09, 200, 0)];
  // The center bracket is sound, but the smoothing window touches a warp.
  assert.ok(Math.abs(packetPoseAt(poses, .05, poses[0], []).pos[0] - 5 / 3) < 1e-9);
});
