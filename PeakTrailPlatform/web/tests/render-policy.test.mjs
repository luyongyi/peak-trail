import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chooseRenderPolicy, renderErrorName } from '../src/render-policy.js';

test('retina tablet resolution is bounded by total pixels without changing CSS size', () => {
  const policy = chooseRenderPolicy({ width: 1366, height: 1024, devicePixelRatio: 2, coarsePointer: true });
  assert.equal(policy.pixelBudget, 2_000_000);
  assert.ok(policy.pixelRatio > 1 && policy.pixelRatio < 2);
  assert.ok(policy.drawingWidth * policy.drawingHeight <= policy.pixelBudget);
  assert.ok(Math.abs(policy.drawingWidth / policy.drawingHeight - 1366 / 1024) < .002);
});

test('ordinary DPR1 desktop remains full size; very large desktop and hardware limits are bounded', () => {
  assert.deepEqual(chooseRenderPolicy({ width: 1920, height: 1080, devicePixelRatio: 1 }),
    { pixelRatio: 1, pixelBudget: 4_000_000, requestedRatio: 1, coarsePointer: false, drawingWidth: 1920, drawingHeight: 1080 });
  const large = chooseRenderPolicy({ width: 5000, height: 2000, devicePixelRatio: 2 });
  assert.ok(large.drawingWidth * large.drawingHeight <= 4_000_000);
  const narrow = chooseRenderPolicy({ width: 10000, height: 100, devicePixelRatio: 2, maxTextureSize: 4096, maxRenderbufferSize: 2048 });
  assert.equal(narrow.drawingWidth, 2048); assert.ok(narrow.drawingHeight >= 1);
});

test('invalid measurements cannot produce NaN, zero buffers, or an unbounded retina scale', () => {
  for (const value of [undefined, NaN, Infinity, -1, 0]) {
    const policy = chooseRenderPolicy({ width: value, height: value, devicePixelRatio: value, maxRenderbufferSize: value });
    assert.ok(Number.isFinite(policy.pixelRatio) && policy.pixelRatio > 0 && policy.pixelRatio <= 2);
    assert.ok(policy.drawingWidth >= 1 && policy.drawingHeight >= 1);
  }
  assert.equal(renderErrorName(new TypeError('private URL')), 'TypeError');
  assert.equal(renderErrorName({ name: 'private-token-name' }), 'Error');
});

const source = (await readFile(process.env.PEAK_TEST_SCENE_PATH || new URL('../src/scene.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export class TrailScene', 'class TrailScene');
function fixture() {
  const frames = new Map(), events = [], calls = { render: 0, fog: 0, resize: 0, reset: 0, disable: 0 };
  let serial = 0;
  const request = callback => { frames.set(++serial, callback); return serial; };
  class FogDepthPass { constructor() { calls.reset++; } dispose() {} render() { calls.fog++; } disableMaterials() { calls.disable++; } }
  const TrailScene = new Function('THREE', 'FogDepthPass', 'chooseRenderPolicy', 'renderErrorName', 'requestAnimationFrame', 'cancelAnimationFrame', `${source}\nreturn TrailScene;`)(
    {}, FogDepthPass, chooseRenderPolicy, renderErrorName, request, id => frames.delete(id));
  const scene = Object.create(TrailScene.prototype);
  const canvas = new EventTarget(); canvas.width = 800; canvas.height = 600;
  canvas.parentElement = { clientWidth: 1000, clientHeight: 800 };
  canvas.ownerDocument = { defaultView: { devicePixelRatio: 2, matchMedia: () => ({ matches: true }) } };
  canvas.addEventListener('peaktrail-render-status', event => events.push(event.detail));
  Object.assign(scene, { canvas, contextLost: false, contextLossCount: 0, contextRestoreCount: 0, renderFailure: null,
    disposed: false, renderingStarted: false, renderStatus: 'initializing', lastFrameTime: null,
    viewportWidth: 800, viewportHeight: 600, followTargetId: null,
    camera: { updateProjectionMatrix() {} }, scene: {}, freeCamera: { mode: 'orbit' }, controls: { update() {} },
    renderer: { getContext: () => ({ getContextAttributes: () => ({ antialias: true }), getParameter: () => 4 }),
      getPixelRatio: () => scene.renderPolicy?.pixelRatio ?? 1, info: { memory: { geometries: 3, textures: 2 }, programs: [1] },
      setDrawingBufferSize(w, h, ratio) { calls.resize++; canvas.width = Math.floor(w * ratio); canvas.height = Math.floor(h * ratio); },
      render() { calls.render++; } },
    fogDepthPass: { render() { calls.fog++; }, dispose() {}, disableMaterials() { calls.disable++; } },
    worldRenderer: { entries: new Map(), projectLabels() {} },
    updatePlayerLabelPositions() {}, updateCameraMarkerVisibility() {},
  });
  scene.animate = scene.animate.bind(scene);
  return { scene, frames, events, calls, run(timestamp = 100) { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(timestamp); } };
}

test('context loss cancels rendering; restore resumes original data with exactly one animation loop', () => {
  const f = fixture(); f.scene.animate(0); assert.equal(f.frames.size, 1);
  let prevented = false; f.scene.onRenderContextLost({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.frames.size, 0);
  assert.equal(f.events.at(-1).status, 'context-lost'); assert.equal(f.calls.disable, 1);
  f.scene.animate(10); assert.equal(f.calls.render, 1);
  f.scene.onRenderContextRestored(); f.scene.onRenderContextRestored();
  assert.equal(f.frames.size, 1); assert.equal(f.calls.reset, 2);
  assert.equal(f.events.at(-1).status, 'context-restored');
  f.run(); assert.equal(f.calls.render, 2); assert.equal(f.frames.size, 1);
  assert.equal(f.events.at(-1).status, 'ready');
  const diagnostics = f.scene.getRenderDiagnostics();
  assert.equal(diagnostics.contextLossCount, 1); assert.equal(diagnostics.contextRestoreCount, 2);
  assert.equal(diagnostics.pixelBudget, 2_000_000); assert.ok(diagnostics.drawingWidth * diagnostics.drawingHeight <= 2_000_000);
});

test('frame failures surface safe diagnostic events and do not create an endless error loop', () => {
  for (const stage of ['fog', 'render', 'labels']) {
    const f = fixture(), failure = () => { throw new TypeError('https://private/room/TOKEN'); };
    if (stage === 'fog') f.scene.fogDepthPass.render = failure;
    if (stage === 'render') f.scene.renderer.render = failure;
    if (stage === 'labels') f.scene.worldRenderer.projectLabels = failure;
    f.scene.animate(10); assert.equal(f.frames.size, 0); assert.equal(f.events.at(-1).status, 'render-error');
    assert.equal(f.events.at(-1).diagnostics.errorName, 'TypeError');
    assert.ok(!JSON.stringify(f.events).includes('TOKEN'));
    const count = f.events.length; f.scene.animate(20); assert.equal(f.events.length, count);
  }
});

test('shader compilation errors reported inside render stop before a ready event or another frame', () => {
  for (const stage of ['fog', 'render']) {
    const f = fixture();
    const fail = () => { f.scene.renderFailure = 'ShaderError'; f.scene.emitRenderStatus('render-error', 'fixed message'); };
    if (stage === 'fog') f.scene.fogDepthPass.render = fail;
    else f.scene.renderer.render = fail;
    f.scene.animate(10);
    assert.equal(f.frames.size, 0); assert.equal(f.scene.renderingStarted, false);
    assert.equal(f.events.at(-1).status, 'render-error');
    assert.ok(!f.events.some(event => event.status === 'ready'));
    if (stage === 'fog') assert.equal(f.calls.render, 0);
  }
});

test('disposed scene neither resumes nor allocates after queued restore or resize', () => {
  const f = fixture(); f.scene.disposed = true;
  f.scene.onRenderContextRestored(); f.scene.resize(); f.scene.animate(0);
  assert.equal(f.frames.size, 0); assert.equal(f.calls.resize, 0); assert.equal(f.calls.reset, 0); assert.deepEqual(f.events, []);
});

test('diagnostics remain available when context queries fail and contain no scene identity', () => {
  const f = fixture(); f.scene.mapPack = { room: 'SECRET', url: 'PRIVATE' };
  f.scene.renderer.getContext = () => ({ getContextAttributes() { throw new Error('private'); } });
  const diagnostics = f.scene.getRenderDiagnostics();
  assert.equal(diagnostics.samples, null); assert.equal(diagnostics.antialias, null);
  assert.equal(diagnostics.geometryCount, 3); assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
});
