import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { SpectatorCamera, FOLLOW_DISTANCE } from "../src/spectator-camera.js";

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
// Analytic planes stand in for the query port, not the production triangle query.
function planes(definitions) {
  let calls = 0;
  return {
    get calls() { return calls; },
    cast(origin, direction, far) {
      calls++;
      let result = null;
      for (const [axis, at] of definitions) {
        if (Math.abs(direction[axis]) < 1e-8) continue;
        const distance = (at - origin[axis]) / direction[axis];
        if (distance <= 0.001 || distance > far || result && distance >= result.distance) continue;
        const normal = v(); normal[axis] = -Math.sign(direction[axis]);
        result = { distance, normal, point: origin.clone().addScaledVector(direction, distance) };
      }
      return result;
    },
  };
}
function settle(rig, anchor, options = {}, steps = 240, dt = 1 / 60) {
  let result;
  for (let i = 0; i < steps; i++) result = rig.update(anchor, dt, options);
  return result;
}

test("default observer stays farther out, with no fictitious head-height offset", () => {
  const query = planes([]), rig = new SpectatorCamera({ THREE, query });
  const anchor = v(50, 120, -30);
  const result = settle(rig, anchor, { preferredAzimuth: 0, azimuth: 0, cameraPosition: v(1000, 1000, 1000) });
  assert.ok(Math.abs(result.distance - FOLLOW_DISTANCE) < 0.01);
  assert.deepEqual(result.target.toArray(), anchor.toArray());
  assert.equal(result.geometryDerived, false);
});

test("near actual cliff wins over an incorrect map-centre prior", () => {
  const query = planes([["z", 0]]), rig = new SpectatorCamera({ THREE, query });
  const result = settle(rig, v(0, 10, 1), { azimuth: Math.PI, preferredAzimuth: Math.PI, cameraPosition: v(0, 10, -70) });
  assert.ok(result.position.z > 50, "camera is on the player's exposed side, never behind the cliff");
  assert.ok(result.distance > 50); assert.equal(result.geometryDerived, true);
});

test("enclosed interiors shorten a clear boom instead of forcing a distant camera outside walls", () => {
  const query = planes([["z", 10], ["z", -10], ["x", 12], ["x", -12], ["y", 5], ["y", -2]]);
  const rig = new SpectatorCamera({ THREE, query });
  const result = settle(rig, v(), { interior: true, azimuth: 0, cameraPosition: v(0, 1, 4) });
  assert.ok(result.distance > 6 && result.distance < 16);
  assert.ok(result.position.y < 5 && result.position.y > -2);
  assert.ok(Math.abs(result.position.x) < 12 && Math.abs(result.position.z) < 10);
  assert.equal(result.constrained, true);
});

test("a manual orbit retains its chosen side, but cannot put the camera through a wall", () => {
  const query = planes([["z", 5]]), rig = new SpectatorCamera({ THREE, query });
  const result = settle(rig, v(), { manual: true, azimuth: 0, pitch: 0, distance: 70, cameraPosition: v(0, 0, 4) });
  assert.ok(result.position.z > 3 && result.position.z < 4.21);
  assert.ok(Math.abs(result.position.x) < 0.001);
});

test("clear-space movement is smooth and approximately frame-rate independent", () => {
  function run(hz) {
    const rig = new SpectatorCamera({ THREE, query: planes([]) });
    settle(rig, v(), { manual: true, azimuth: 0, pitch: 0, cameraPosition: v(0, 0, 56) });
    let previous = rig.position.clone(), maxStep = 0;
    for (let i = 1; i <= hz * 2; i++) {
      const result = rig.update(v(i / hz * 2, i / hz, 0), 1 / hz, { manual: true, azimuth: 0, pitch: 0 });
      maxStep = Math.max(maxStep, result.position.distanceTo(previous)); previous.copy(result.position);
    }
    return { position: rig.position.clone(), maxStep };
  }
  const slow = run(30), fast = run(120);
  assert.ok(slow.position.distanceTo(fast.position) < 0.1);
  assert.ok(slow.maxStep < 0.1);
});

test("teleport and rewind reset velocity and never orbit an invented intermediate player", () => {
  const rig = new SpectatorCamera({ THREE, query: planes([]) });
  settle(rig, v(), { azimuth: 0, cameraPosition: v(0, 0, 56) });
  const target = v(100, 200, -300);
  const result = rig.update(target, 1 / 60, { azimuth: 0, discontinuity: true });
  assert.ok(Math.abs(result.distance - FOLLOW_DISTANCE) < 0.01);
  assert.deepEqual(result.target.toArray(), target.toArray());
  assert.equal(rig.velocity.length(), 0);
  const back = rig.update(v(), 1 / 60, { discontinuity: true });
  assert.deepEqual(back.target.toArray(), [0, 0, 0]);
});

test("geometry candidate scans are throttled while final camera safety runs every frame", () => {
  const query = planes([]), rig = new SpectatorCamera({ THREE, query });
  rig.update(v(), 1 / 60, { cameraPosition: v(0, 0, 56) });
  const afterFirst = query.calls;
  rig.update(v(), 1 / 60, {});
  assert.ok(afterFirst > 25);
  assert.ok(query.calls - afterFirst <= 10, "a stable frame has only current/next wide-boom checks");
  rig.invalidate();
  rig.update(v(), 1 / 60, {});
  assert.ok(query.calls - afterFirst > 25);
});

test("negative/NaN frame deltas and invalid targets cannot poison the pose", () => {
  const rig = new SpectatorCamera({ THREE, query: planes([]) });
  settle(rig, v(), { cameraPosition: v(0, 0, 56) });
  for (const delta of [0, -1, NaN, Infinity]) {
    const result = rig.update(v(), delta, {});
    assert.ok([...result.position.toArray(), ...result.target.toArray()].every(Number.isFinite));
  }
  assert.equal(rig.update(v(NaN), 1 / 60), null);
});

test("a centre-clear slot is rejected when nearby foreground rocks cover the surrounding view", () => {
  const query = { cast(origin, direction) {
    if (origin.z > 42 && (Math.abs(direction.x) > .05 || Math.abs(direction.y + .218) > .05))
      return { distance: 3, normal: v(0, 0, 1) };
    return null;
  } };
  const rig = new SpectatorCamera({ THREE, query });
  const result = settle(rig, v(), { preferredAzimuth: 0, azimuth: 0, cameraPosition: v(0, 10, 56) });
  assert.ok(Math.abs(result.azimuth) > .5, "uses a wider outside view instead of only keeping the centre visible");
  assert.ok(result.distance > 50);
});

test("blocked smoothing transitions relocate to a verified clear side instead of lingering at the player's face", () => {
  const rig = new SpectatorCamera({ THREE, query: planes([["z", 0]]) });
  const anchor = v(0, 10, 1);
  settle(rig, anchor, { preferredAzimuth: 0, azimuth: 0, cameraPosition: v(0, 10, 60) });
  rig.position.set(0, 10, -20); // a previous view on the other side of a corner
  rig.azimuth = Math.PI;
  const result = rig.update(anchor, 1 / 60, {});
  assert.equal(result.relocated, true);
  assert.ok(result.position.z > 50); assert.ok(result.distance > 50);
});

test("candidate selection rejects a thin opening that cannot fit the camera near plane", () => {
  const query = { cast(origin, direction, far) {
    if (origin.length() < .001 && direction.z > .9 && Math.abs(direction.x) > .002 && far > 3)
      return { distance: 3, normal: v(0, 0, -1) };
    return null;
  } };
  const rig = new SpectatorCamera({ THREE, query });
  const result = settle(rig, v(), { preferredAzimuth: 0, azimuth: 0 });
  assert.ok(result.distance > 50);
  assert.ok(Math.abs(result.azimuth) > .4);
  assert.ok(rig.solution.distance > 50, "selected reach uses the same wide test as final placement");
});

test("an opening closed by movement refreshes its cached candidate in the same frame", () => {
  let closed = false;
  const wall = planes([["z", 4]]);
  const query = { cast: (...args) => closed ? wall.cast(...args) : null };
  const rig = new SpectatorCamera({ THREE, query });
  settle(rig, v(), { azimuth: 0, preferredAzimuth: 0 });
  rig.probeIn = .25; // regular 0.28s candidate scan is not due
  closed = true;
  const result = rig.update(v(), 1 / 60, { preferredAzimuth: 0 });
  assert.ok(result.distance > 50);
  assert.ok(result.position.z < 4, "verified safe destination remains on this side of the wall");
  assert.equal(result.relocated, true);
});

test("a genuinely narrow interior keeps throttled scans instead of rescanning every frame", () => {
  const query = planes([["z", 8], ["z", -8], ["x", 8], ["x", -8], ["y", 8], ["y", -8]]);
  const rig = new SpectatorCamera({ THREE, query });
  rig.update(v(), 1 / 60, { interior: true });
  const before = query.calls;
  rig.update(v(), 1 / 60, { interior: true });
  assert.ok(query.calls - before <= 10);
});
