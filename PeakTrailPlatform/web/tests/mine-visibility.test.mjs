import test from 'node:test';
import assert from 'node:assert/strict';
import { isExplosiveMineMaterial, recordedHiddenMineIndices } from '../src/mine-visibility.js';

const mine = (x = 0, scale = 1) => ({ center: [x, 0.25 * scale, 0],
  min: [x - 0.56 * scale, -0.34 * scale, -0.56 * scale],
  max: [x + 0.57 * scale, 0.84 * scale, 0.58 * scale] });
const explosion = (x = 0, t = 10) => ({ type: 'mine_explosion', t, pos: [x, 0, 0], radius: 50 });

test('only exact-build explosive mushroom is eligible', () => {
  assert.ok(isExplosiveMineMaterial('25306743', 'M_SporeShroomExplo', 'W/Peak_Standard'));
  assert.ok(!isExplosiveMineMaterial('other', 'M_SporeShroomExplo', 'W/Peak_Standard'));
  assert.ok(!isExplosiveMineMaterial('25306743', 'M_SporeShroomPoison', 'W/Peak_Standard'));
});

test('explosion hides nearest mine, never all neighbours within its blast radius', () => {
  assert.deepEqual([...recordedHiddenMineIndices([mine(), mine(0.8), mine(20)], [], [explosion()], 10)], [0]);
  assert.equal(recordedHiddenMineIndices([mine(20)], [], [explosion()], 10).size, 0);
});

test('rewind, missing snapshot, and inactive state restore rather than invent destruction', () => {
  assert.equal(recordedHiddenMineIndices([mine()], [], [explosion()], 9).size, 0);
  assert.equal(recordedHiddenMineIndices([mine()], [], [], 20).size, 0);
  assert.equal(recordedHiddenMineIndices([mine()], [{ kind: 'mine', activity: 'inactive', pos: [0, 0, 0] }], [], 20).size, 0);
  assert.equal(recordedHiddenMineIndices([mine()], [{ kind: 'mine', activity: 'spent', pos: [0, 0, 0] }], [], 20).size, 1);
});

test('coincident LODs disappear together while ambiguous neighbours fail closed', () => {
  assert.deepEqual([...recordedHiddenMineIndices([mine(), mine(), mine(0.8)], [], [explosion()], 10)], [0, 1]);
  assert.equal(recordedHiddenMineIndices([mine(-0.4), mine(0.4)], [], [explosion()], 10).size, 0);
});

test('Unity-world matching remains independent of display origin and mirrored scale', () => {
  assert.deepEqual([...recordedHiddenMineIndices([mine(-500, 4), mine(-470)], [], [explosion(-500)], 10)], [0]);
  assert.equal(recordedHiddenMineIndices([mine(-500)], [], [{ type: 'spore_explosion', t: 2, pos: [-500, 0, 0] }], 10).size, 0);
});

test('cached explosion extraction stays per-events and time-monotonic across replay frames', () => {
  const events = [
    explosion(0, 10),
    { type: 'spore_explosion', t: 5, pos: [0, 0, 0] },
    { type: 'mine_exploded', t: 30, pos: [20, 0, 0] },
    { type: 'mine_explosion', t: 40, pos: [Number.NaN, 0, 0] },
    { type: 'mine_explosion', t: Number.NaN, pos: [0, 0, 0] },
  ];
  // Rewinding restores, and repeated frames reuse the same filtered slice.
  assert.equal(recordedHiddenMineIndices([mine()], [], events, 9).size, 0);
  assert.equal(recordedHiddenMineIndices([mine()], [], events, 10).size, 1);
  assert.equal(recordedHiddenMineIndices([mine()], [], events, 20).size, 1);
  assert.equal(recordedHiddenMineIndices([mine()], [], events, 9).size, 0);
  assert.equal(recordedHiddenMineIndices([mine(20)], [], events, 30).size, 1);
  // Absent event lists never hide anything and never throw.
  assert.equal(recordedHiddenMineIndices([mine()], [], null, 50).size, 0);
  assert.equal(recordedHiddenMineIndices([mine()], [], undefined, 50).size, 0);
});
