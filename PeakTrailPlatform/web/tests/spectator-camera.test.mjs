import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { SpectatorCamera, FOLLOW_DISTANCE, FOLLOW_INTERIOR_DISTANCE, FOLLOW_INTERIOR_MAX_DISTANCE } from "../src/spectator-camera.js";
import { FollowTerrainQuery } from "../src/follow-terrain.js";

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

function roomWithOpenDoor() {
  // Synthetic test room, not an assertion about any PEAK chapter's dimensions.
  // Open ceiling and a real gap in the +X wall allow an unconstrained long boom
  // to escape; source triangles alone cannot express the desired inward view.
  const group = new THREE.Group(), material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const wall = (size, position) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material); mesh.position.set(...position); group.add(mesh);
  };
  wall([.5, 30, 50], [-25, 10, 0]);
  wall([50, 30, .5], [0, 10, -25]); wall([50, 30, .5], [0, 10, 25]);
  wall([.5, 30, 18], [25, 10, -16]); wall([.5, 30, 18], [25, 10, 16]);
  wall([50, .5, 50], [0, -5, 0]);
  return new FollowTerrainQuery(THREE).setRoots([group]);
}

test("interior follows from the source-centre side despite an open door, open roof and initially external camera", () => {
  const query = roomWithOpenDoor(), rig = new SpectatorCamera({ THREE, query });
  const anchor = v(21, 5, 0), reference = { center: [0, 0, 0] };
  assert.equal(query.cast(anchor, v(1, 0, 0), 100), null, "the door genuinely opens outward");
  assert.equal(query.cast(anchor, v(0, 1, 0), 100), null, "there is no invented roof");
  for (let frame = 0; frame < 240; frame++) {
    const pose = rig.update(anchor, 1 / 60, { interior: true, interiorReference: reference,
      preferredAzimuth: Math.PI / 2, azimuth: Math.PI / 2, cameraPosition: v(80, 20, 0) });
    assert.equal(pose.mode, "interior"); assert.equal(pose.interiorReferenceReady, true);
    assert.ok(pose.position.x < anchor.x && pose.position.x >= 0, `must remain on inner, subject-side half: ${pose.position.x}`);
    assert.ok(pose.distance <= FOLLOW_INTERIOR_DISTANCE + 1e-7);
    assert.deepEqual(pose.target.toArray(), anchor.toArray(), "watch the player, never the centre pivot");
  }
});

test("interior default and wheel distances are presentation limits independent of the room size", () => {
  const anchor = v(100, 10, 0), reference = { center: [0, 10000, 0] };
  for (const [request, expected] of [[undefined, 18], [9, 9], [22, 22], [140, 28], [Infinity, 18]]) {
    const rig = new SpectatorCamera({ THREE, query: null });
    const pose = settle(rig, anchor, { interior: true, interiorReference: reference, distance: request });
    assert.equal(pose.desiredDistance, expected); assert.ok(Math.abs(pose.distance - expected) < 1e-7);
    assert.ok(Math.abs(pose.position.y - anchor.y) < 10, "source centre height must not lift the camera toward an invented eye/pivot");
  }
  assert.equal(FOLLOW_INTERIOR_MAX_DISTANCE, 28);
});

test("reference-constrained interior remains inward even before any map triangles load", () => {
  const rig = new SpectatorCamera({ THREE, query: null }), anchor = v(8, 150, -3);
  const result = rig.update(anchor, 1 / 60, { interior: true, interiorReference: { center: [0, 0, -3] },
    cameraPosition: v(500, 500, 500), azimuth: Math.PI / 2 });
  assert.ok(result.position.x < 8 && result.position.x > 0, "shortens before the centre plane, even without geometry");
  assert.ok(Math.hypot(result.position.x, result.position.z + 3) <= 8 + 1e-7,
    "a diagonal boom may exceed the direct centre distance but cannot drift outside the player's radius");
  assert.ok(result.distance <= 18 + 1e-7); assert.equal(result.constrained, true);
  assert.equal(result.geometryDerived, false, "source-centre framing is not a recorded/queried climbing normal");
});

test("near the source centre, diagonal candidates cannot drift farther out or cross to its other side", () => {
  const rig = new SpectatorCamera({ THREE, query: null }), anchor = v(1.2, 10, 0);
  for (const initial of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    rig.reset();
    const pose = settle(rig, anchor, { interior: true, interiorReference: { center: [0, 100, 0] }, distance: 28, azimuth: initial });
    assert.ok(pose.position.x >= 0 && pose.position.x < 1.2);
    assert.ok(Math.hypot(pose.position.x, pose.position.z) <= 1.2 + 1e-7);
  }
});

test("missing or malformed reference never uses an outward map-centre prior or invents a cylinder", () => {
  for (const reference of [undefined, { center: [NaN, 0, 0] }, { center: [0, 0] }, { center: "0,0,0" }]) {
    const a = new SpectatorCamera({ THREE, query: null }), b = new SpectatorCamera({ THREE, query: null });
    const options = { interior: true, interiorReference: reference, azimuth: 1.1 };
    const first = settle(a, v(), { ...options, preferredAzimuth: 0 });
    const second = settle(b, v(), { ...options, preferredAzimuth: Math.PI });
    assert.equal(first.interiorReferenceReady, false); assert.equal(first.interiorSideKnown, false);
    assert.ok(first.position.distanceTo(second.position) < 1e-8);
    assert.ok(first.distance <= 18 + 1e-8);
  }
});

test("reference-less interior uses actual nearby wall free-side normals, without treating them as room boundaries", () => {
  const rig = new SpectatorCamera({ THREE, query: planes([["x", 3]]) });
  const pose = settle(rig, v(2, 10, 0), { interior: true, azimuth: Math.PI / 2, preferredAzimuth: Math.PI / 2 });
  assert.equal(pose.geometryDerived, true); assert.equal(pose.interiorReferenceReady, false);
  assert.ok(pose.position.x < 2); assert.ok(pose.distance <= 18 + 1e-8);
});

test("verified centre arriving late and exterior-to-interior transitions cannot show one external frame", () => {
  const rig = new SpectatorCamera({ THREE, query: null }), anchor = v(20, 10, 0);
  settle(rig, anchor, { azimuth: Math.PI / 2, preferredAzimuth: Math.PI / 2 });
  assert.ok(rig.position.x > 60);
  const inside = rig.update(anchor, 1 / 60, { interior: true, interiorReference: { center: [0, 0, 0] }, azimuth: Math.PI / 2 });
  assert.ok(inside.position.x < 20 && inside.position.x > 0);
  assert.equal(inside.desiredDistance, 18); assert.deepEqual(inside.target.toArray(), anchor.toArray());
  const outside = rig.update(anchor, 1 / 60, { azimuth: Math.PI / 2, preferredAzimuth: Math.PI / 2 });
  assert.equal(outside.mode, "exterior"); assert.equal(outside.desiredDistance, 56);
  rig.update(anchor, 1 / 60, { interior: true, azimuth: Math.PI / 2 });
  assert.ok(rig.position.x > 20, "unknown interior has no evidence to invent its inward side");
  const late = rig.update(anchor, 1 / 60, { interior: true, interiorReference: { center: [0, 0, 0] }, azimuth: Math.PI / 2 });
  assert.ok(late.position.x < 20 && late.position.x >= 0); assert.equal(late.relocated, true);
});

test("manual interior orbit retains user direction but still respects actual walls and the distance limit", () => {
  const anchor = v(20, 10, 0), options = { interior: true, interiorReference: { center: [0, 0, 0] },
    manual: true, azimuth: Math.PI / 2, pitch: 0, distance: 100 };
  const free = settle(new SpectatorCamera({ THREE, query: null }), anchor, options);
  assert.ok(free.position.x > anchor.x); assert.ok(Math.abs(free.distance - 28) < 1e-8);
  const wall = settle(new SpectatorCamera({ THREE, query: planes([["x", 24]]) }), anchor, options);
  assert.ok(wall.position.x > anchor.x && wall.position.x < 24);
  assert.equal(wall.relocated, false);
});

test("moving around the reference axis never lerps through the forbidden outer half-space", () => {
  const rig = new SpectatorCamera({ THREE, query: null }), reference = { center: [0, 0, 0] };
  for (let i = 0; i <= 360; i++) {
    const angle = i * Math.PI / 180, anchor = v(Math.sin(angle) * 9, 20, Math.cos(angle) * 9);
    const pose = rig.update(anchor, 1 / 60, { interior: true, interiorReference: reference });
    const towardCentre = v(-anchor.x, 0, -anchor.z), offset = pose.position.clone().sub(anchor); offset.y = 0;
    assert.ok(offset.dot(towardCentre) >= -1e-7);
    assert.ok(Math.hypot(pose.position.x, pose.position.z) <= 9 + 1e-7);
    assert.ok(offset.dot(towardCentre.clone().normalize()) <= 9 + 1e-7, "do not cross the centre plane");
  }
});

test("standing exactly at the source axis has no invented inward direction", () => {
  const rig = new SpectatorCamera({ THREE, query: null });
  const result = settle(rig, v(10, 20, 30), { interior: true, interiorReference: { center: [10, 0, 30] } });
  assert.equal(result.interiorReferenceReady, true); assert.equal(result.interiorSideKnown, false);
  assert.ok(result.distance <= 4 + 1e-8);
  assert.ok(result.position.toArray().every(Number.isFinite));
});

test("a cached candidate leaving the rotating inward cone is refreshed before the next scheduled scan", () => {
  const rig = new SpectatorCamera({ THREE, query: null });
  const options = { interior: true, interiorReference: { center: [0, 0, 0] } };
  settle(rig, v(20, 10, 0), options);
  rig.solution.azimuth = Math.PI / 2; // cached candidate invalidated by an axis/subject turn
  rig.probeIn = .25;
  const result = rig.update(v(20, 10, 0), 1 / 60, options);
  assert.ok(rig.interiorAngleAllowed(rig.solution.azimuth));
  assert.ok(result.position.x < 20 && result.position.x > 0);
  assert.ok(result.distance > 10, "does not collapse to the subject while waiting for a stale candidate");
});
