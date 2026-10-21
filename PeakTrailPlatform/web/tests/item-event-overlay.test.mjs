import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../../vendor/three/0.180.0/build/three.module.js';
import { relatedUseEvent, visibleItemEvents } from '../src/item-events.js';
const source = (await readFile(new URL('../src/item-event-overlay.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('export class ', 'class ');
const ItemEventOverlay = new Function('THREE', 'WorldRenderer', 'relatedUseEvent', 'visibleItemEvents', `${source}; return ItemEventOverlay;`)(THREE, null, relatedUseEvent, visibleItemEvents);
const hash = n => n.toString(16).padStart(64, '0');
const fact = (n, extra = {}) => ({ id: hash(n), actionId: hash(900), kind: 'item-spawn', tMs: n * 1000, stageIndex: 2, pos: [11, 22, 33], item: { prefabName: 'ShelfShroomSpawn' }, playerKey: 'p1', ...extra });
function harness(template = async () => null) {
  const canvas = { dispatchEvent() {} }, loader = { overlay: {}, pack: null, setData(_trace, pack) { this.pack = pack; }, resolveAsset: object => ({ modelUrl: object.prefabName }), template, dispose() {} };
  return new ItemEventOverlay(canvas, { modelLoader: loader });
}

test('item markers use actual anchor coordinates with existing origin, height scale and Unity mirror', () => {
  const overlay = harness(), parent = new THREE.Group(); parent.scale.z = -1; parent.add(overlay.root);
  overlay.setData({ enabled: true, live: true, events: [fact(1)], stageIndex: 2, timeMs: 2000, playerVisibility: new Map() }, new THREE.Vector3(10, 20, 30), 2);
  assert.equal(overlay.visible.length, 1, 'unset player visibility means visible');
  const point = new THREE.Vector3().fromBufferAttribute(overlay.points.geometry.attributes.position, 0);
  parent.updateMatrixWorld(true); point.applyMatrix4(overlay.root.matrixWorld); assert.deepEqual(point.toArray(), [1, 4, -3]);
  overlay.setTime(2, new Map([['p1', false]])); assert.equal(overlay.visible.length, 0);
  overlay.setTime(0, new Map()); assert.equal(overlay.visible.length, 0);
  overlay.dispose();
});

test('selection only links the recorded action pair and reuses geometry while time advances', () => {
  const overlay = harness(), use = fact(1, { kind: 'item-use', pos: [10, 21, 30] }), spawn = fact(2);
  overlay.setData({ enabled: true, events: [use, spawn], stageIndex: 2 }, new THREE.Vector3(), 1);
  assert.equal(overlay.visible.length, 1); overlay.select(spawn.id); assert.equal(overlay.link.visible, true);
  assert.deepEqual([...overlay.link.geometry.attributes.position.array], [10, 21, 30, 11, 22, 33]);
  const geometry = overlay.link.geometry; overlay.setTime(9); assert.equal(overlay.link.geometry, geometry);
  overlay.select(null); assert.equal(overlay.link.visible, false); overlay.dispose();
});

test('slow templates cannot resurrect markers after stage changes or disposal; model count is bounded', async () => {
  let resolve; const promise = new Promise(done => { resolve = done; }); let calls = 0;
  const overlay = harness(() => { ++calls; return promise; });
  overlay.setData({ enabled: true, events: Array.from({ length: 600 }, (_, i) => fact(i + 1)), stageIndex: 2 }, new THREE.Vector3(), 1);
  assert.equal(overlay.visible.length, 512); assert.equal(calls, 32);
  overlay.setData({ enabled: false }, new THREE.Vector3(), 1);
  resolve(new THREE.Group()); await promise; await Promise.resolve(); assert.equal(overlay.models.children.length, 0);
  overlay.dispose();
});
