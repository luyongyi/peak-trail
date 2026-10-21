import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMilestones, milestoneText, runOutcomeLabel } from '../src/route-milestones.js';
import { normalizeRoutes } from '../src/route-collection-model.js';
import { setLocale } from '../src/i18n.js';

test('same-frame Nadir phases retain their recorded order and absent coordinates remain absent', () => {
  const source = [{ tMs: 1000, kind: 'nadir-wall', stageIndex: 5 },
    { tMs: 1000, kind: 'nadir-chase', stageIndex: 5, positionCm: [120, -500, 600] },
    { tMs: 2000, kind: 'nadir', stageIndex: 5 }];
  const result = normalizeRoutes({ stageIndex: 5, routes: [{ id: 'p1', points: [], milestones: source }] }).routes[0];
  assert.deepEqual(result.milestones, source);
  assert.equal(Object.hasOwn(result.milestones[0], 'positionCm'), false);
  assert.notEqual(result.milestones[1].positionCm, source[1].positionCm);
});

test('milestones reject mismatched stages and invented or malformed coordinates', () => {
  for (const milestone of [{ tMs: 1, kind: 'nadir', stageIndex: 4 }, { tMs: 1, kind: 'nadir', positionCm: [1, 2] },
    { tMs: -1, kind: 'summit' }, { tMs: 1, kind: 'nadir', positionCm: [1, NaN, 3] }, { tMs: 1, kind: 'unknown' }]) {
    assert.throws(() => normalizeMilestones([milestone], 5));
  }
});

test('long runs accept more milestones than the display window while validating every entry and the contract bound', () => {
  const milestones = Array.from({ length: 1025 }, (_, tMs) => ({ tMs, kind: 'nadir-wall', stageIndex: 5 }));
  assert.equal(normalizeMilestones(milestones, 5).length, 1025);
  assert.throws(() => normalizeMilestones([...milestones, { tMs: 1025, kind: 'nadir', positionCm: [1, 2, Infinity] }], 5));
  assert.throws(() => normalizeMilestones(Array(100001).fill(milestones[0]), 5));
});

test('summit and Nadir outcomes stay independent and translated without inferring success from a path', () => {
  try {
    setLocale('zh-CN');
    assert.equal(runOutcomeLabel({ completed: true, gameCompleted: true }), '');
    assert.equal(runOutcomeLabel({ nadirCompleted: true }), '天底已通关');
    assert.equal(runOutcomeLabel({ summitCompleted: true, nadirCompleted: true }), '已登顶 · 天底已通关');
    setLocale('en');
    assert.equal(runOutcomeLabel({ nadirCompleted: true }), 'Nadir completed');
    assert.equal(milestoneText({ tMs: 61100, kind: 'nadir' }), '1:01 · Nadir completed');
    const nativeCheckpoint = normalizeMilestones([{ tMs: 90000, kind: 'native-checkpoint', stageIndex: 2 }], 2)[0];
    assert.equal(milestoneText(nativeCheckpoint), '1:30 · Chapter completed');
    assert.equal(milestoneText({ tMs: 0, kind: 'game-stage' }), '0:00 · Entered chapter');
    setLocale('zh-CN');
    assert.equal(milestoneText(nativeCheckpoint), '1:30 · 关卡完成');
    assert.equal(milestoneText({ tMs: 0, kind: 'game-stage' }), '0:00 · 进入关卡');
  } finally { setLocale('zh-CN'); }
});
