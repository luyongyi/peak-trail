import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createFullscreen } from '../src/fullscreen.js';

function fakeDocument() {
  const listeners = new Map(), calls = [];
  const doc = {
    fullscreenEnabled: true, fullscreenElement: null,
    documentElement: { async requestFullscreen() {
      assert.equal(this, doc.documentElement, 'native element receiver is retained'); calls.push('request');
      doc.fullscreenElement = this; listeners.get('fullscreenchange')?.();
    } },
    async exitFullscreen() {
      assert.equal(this, doc, 'native document receiver is retained'); calls.push('exit');
      doc.fullscreenElement = null; listeners.get('fullscreenchange')?.();
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
  };
  return { doc, calls, listeners };
}

test('fullscreen only requests on explicit toggle and follows browser Esc changes', async () => {
  const { doc, calls, listeners } = fakeDocument(), changes = [];
  const screen = createFullscreen({ documentRef: doc, onChange: () => changes.push(screen.active) });
  assert.deepEqual(calls, []);
  const entering = screen.toggle();
  assert.deepEqual(calls, ['request'], 'request occurs synchronously while user activation is available');
  await entering;
  assert.equal(screen.active, true); assert.equal(screen.presentationActive, true); assert.equal(screen.mode, 'native'); assert.equal(screen.pending, false);
  doc.fullscreenElement = null; listeners.get('fullscreenchange')();
  assert.equal(screen.active, false); assert.equal(screen.presentationActive, false); assert.equal(screen.mode, null); assert.equal(changes.at(-1), false);
  await screen.toggle(); await screen.toggle();
  assert.deepEqual(calls, ['request', 'request', 'exit']);
  screen.dispose(); assert.equal(listeners.size, 0);
});

test('missing or disabled native fullscreen expands the page without claiming native success', async () => {
  const { doc, calls } = fakeDocument();
  const screen = createFullscreen({ documentRef: doc });
  doc.fullscreenEnabled = false; await screen.toggle();
  assert.equal(screen.supported(), false); assert.equal(screen.nativeSupported(), false); assert.equal(screen.fallbackAvailable(), true);
  assert.equal(screen.error, null); assert.deepEqual(calls, []); assert.equal(screen.active, false);
  assert.equal(screen.presentationActive, true); assert.equal(screen.mode, 'page');
  await screen.toggle();
  assert.equal(screen.presentationActive, false); assert.equal(screen.mode, null); assert.deepEqual(calls, []);
  delete doc.documentElement.requestFullscreen; delete doc.exitFullscreen;
  await screen.toggle(); assert.equal(screen.mode, 'page'); assert.equal(screen.active, false);
  screen.dispose(); assert.equal(screen.presentationActive, false);
  const missing = createFullscreen({ documentRef: null });
  await missing.toggle(); assert.equal(missing.fallbackAvailable(), false); assert.equal(missing.error, 'unsupported');
});

test('denied native entry uses page expansion while a failed native exit remains retryable', async () => {
  const { doc, calls } = fakeDocument();
  const screen = createFullscreen({ documentRef: doc });
  doc.fullscreenEnabled = true;
  doc.documentElement.requestFullscreen = async () => { throw new Error('gesture denied'); };
  await screen.toggle(); assert.equal(screen.error, null); assert.equal(screen.active, false); assert.equal(screen.mode, 'page');
  await screen.toggle(); assert.equal(screen.presentationActive, false); assert.deepEqual(calls, []);
  doc.fullscreenElement = doc.documentElement;
  doc.exitFullscreen = async () => { throw new Error('not allowed'); };
  await screen.toggle(); assert.equal(screen.error, 'exit-denied'); assert.equal(screen.active, true); assert.equal(screen.mode, 'native');
});

for (const oldSpelling of [false, true]) test(`prefixed Safari fullscreen retains receivers (${oldSpelling ? 'legacy spelling' : 'current spelling'})`, async () => {
  const { doc, calls, listeners } = fakeDocument();
  delete doc.documentElement.requestFullscreen; delete doc.exitFullscreen;
  doc.webkitFullscreenEnabled = true; doc.webkitFullscreenElement = null;
  doc.documentElement[oldSpelling ? 'webkitRequestFullScreen' : 'webkitRequestFullscreen'] = function () {
    assert.equal(this, doc.documentElement); calls.push('webkit-request');
    doc.webkitFullscreenElement = this; listeners.get('webkitfullscreenchange')();
  };
  doc[oldSpelling ? 'webkitCancelFullScreen' : 'webkitExitFullscreen'] = function () {
    assert.equal(this, doc); calls.push('webkit-exit');
    doc.webkitFullscreenElement = null; listeners.get('webkitfullscreenchange')();
  };
  const screen = createFullscreen({ documentRef: doc });
  assert.equal(screen.nativeSupported(), true);
  const entering = screen.toggle(); assert.deepEqual(calls, ['webkit-request']);
  await entering; assert.equal(screen.mode, 'native'); assert.equal(screen.active, true);
  await screen.toggle(); assert.deepEqual(calls, ['webkit-request', 'webkit-exit']); assert.equal(screen.presentationActive, false);
  screen.dispose(); assert.equal(listeners.size, 0);
});

test('standard API is preferred but an existing prefixed session uses the matching exit', async () => {
  const { doc, calls } = fakeDocument();
  doc.documentElement.webkitRequestFullscreen = () => { throw new Error('must prefer standard entry'); };
  doc.webkitExitFullscreen = function () { assert.equal(this, doc); calls.push('webkit-exit'); doc.webkitFullscreenElement = null; };
  const screen = createFullscreen({ documentRef: doc });
  await screen.toggle(); await screen.toggle(); assert.deepEqual(calls, ['request', 'exit']);
  doc.webkitFullscreenElement = doc.documentElement;
  await screen.toggle(); assert.deepEqual(calls, ['request', 'exit', 'webkit-exit']);
});

test('duplicate clicks share one pending operation and a resolved call alone never claims native fullscreen', async () => {
  const { doc } = fakeDocument(); let resolve, requests = 0;
  doc.documentElement.requestFullscreen = () => { requests++; return new Promise(done => { resolve = done; }); };
  const screen = createFullscreen({ documentRef: doc });
  const first = screen.toggle(); await screen.toggle();
  assert.equal(requests, 1); assert.equal(screen.pending, true);
  resolve(); await first;
  assert.equal(screen.pending, false); assert.equal(screen.active, false);
  assert.equal(screen.presentationActive, true); assert.equal(screen.mode, 'page');
  await screen.toggle(); assert.equal(screen.mode, null); assert.equal(requests, 1, 'closing page mode never retries native entry');
});

test('page expansion exits with Esc and native external entry/exit remains authoritative', async () => {
  const { doc, listeners } = fakeDocument();
  doc.fullscreenEnabled = false;
  const screen = createFullscreen({ documentRef: doc });
  await screen.toggle(); let prevented = 0;
  listeners.get('keydown')({ key: 'ArrowRight' }); assert.equal(screen.mode, 'page');
  listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented++; } });
  assert.equal(screen.mode, null); assert.equal(prevented, 1);
  await screen.toggle();
  doc.fullscreenElement = doc.documentElement; listeners.get('fullscreenchange')();
  assert.equal(screen.mode, 'native');
  doc.fullscreenElement = null; listeners.get('fullscreenchange')();
  assert.equal(screen.mode, null); assert.equal(screen.presentationActive, false, 'external native exit does not enter page mode');
});

test('Escape respects a menu that already handled it and does not also cancel camera follow', async () => {
  const { doc, listeners } = fakeDocument(); doc.fullscreenEnabled = false;
  const screen = createFullscreen({ documentRef: doc }); await screen.toggle();
  listeners.get('keydown')({ key: 'Escape', defaultPrevented: true });
  assert.equal(screen.mode, 'page', 'closing a topmost menu leaves expansion active');
  let stopped = false;
  listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.equal(screen.mode, null); assert.equal(stopped, true, 'the same key never reaches the camera window handler');
});

test('an external native exit while its entry promise is pending does not reopen page expansion', async () => {
  const { doc, listeners } = fakeDocument(); let resolve;
  doc.documentElement.requestFullscreen = () => new Promise(done => { resolve = done; });
  const screen = createFullscreen({ documentRef: doc });
  const entering = screen.toggle();
  doc.fullscreenElement = doc.documentElement; listeners.get('fullscreenchange')();
  doc.fullscreenElement = null; listeners.get('fullscreenchange')();
  resolve(); await entering;
  assert.equal(screen.mode, null); assert.equal(screen.presentationActive, false);
});

test('disposing a pending entry removes listeners and releases a late owned native entry', async () => {
  const { doc, listeners, calls } = fakeDocument(); let resolve, changes = 0;
  doc.documentElement.requestFullscreen = function () {
    assert.equal(this, doc.documentElement); calls.push('request');
    return new Promise(done => { resolve = () => { doc.fullscreenElement = doc.documentElement; done(); }; });
  };
  const screen = createFullscreen({ documentRef: doc, onChange: () => changes++ });
  const entering = screen.toggle(); const beforeDispose = changes;
  screen.dispose();
  assert.equal(listeners.size, 0); assert.equal(screen.pending, false); assert.equal(screen.mode, null);
  resolve(); await entering;
  assert.deepEqual(calls, ['request', 'exit']); assert.equal(screen.active, false); assert.equal(screen.presentationActive, false);
  assert.equal(changes, beforeDispose); await screen.toggle(); assert.deepEqual(calls, ['request', 'exit']);
});

test('disposing a pending failed request never adds a fallback or emits another change', async () => {
  const { doc, listeners } = fakeDocument(); let reject, changes = 0;
  doc.documentElement.requestFullscreen = () => new Promise((_, fail) => { reject = fail; });
  const screen = createFullscreen({ documentRef: doc, onChange: () => changes++ });
  const entering = screen.toggle(); const beforeDispose = changes;
  screen.dispose(); reject(new Error('denied')); await entering;
  assert.equal(screen.error, null); assert.equal(screen.presentationActive, false); assert.equal(screen.pending, false);
  assert.equal(changes, beforeDispose); assert.equal(listeners.size, 0);
});

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function renderFixture() {
  const elements = Object.fromEntries(['fullscreenButton', 'fullscreenHomeExit', 'fullscreenMessage', 'screenFeedback', 'wakeLockChip', 'wakeLockRetry']
    .map(key => [key, { hidden: false, classList: { toggle() {} }, setAttribute(key, value) { this[key] = value; } }]));
  const fullscreen = { active: false, pending: false, error: null, supported: () => true };
  const wakeLock = { desired: true, held: false, status: 'denied', supported: () => true };
  const state = { watch: { active: false } };
  let english = false;
  const source = app.match(/^function syncWakeLockChip\([^]*?^\}/m)[0];
  const classes = new Set();
  const document = { body: { classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } } } };
  const render = new Function('elements', 'fullscreen', 'wakeLock', 'tr', 'window', 'state', 'document', `${source}; return syncWakeLockChip;`)(
    elements, fullscreen, wakeLock, (zh, en) => english ? en : zh, { isSecureContext: true }, state, document);
  return { elements, fullscreen, wakeLock, state, render, classes, english() { english = true; } };
}

test('page expansion is labelled honestly, stays reversible and does not show a fullscreen failure', () => {
  const f = renderFixture();
  f.fullscreen.supported = () => false; f.wakeLock.desired = false;
  f.render();
  assert.equal(f.elements.fullscreenButton.textContent, '展开地图');
  f.fullscreen.mode = 'page'; f.fullscreen.presentationActive = true; f.render();
  assert.equal(f.fullscreen.active, false, 'page layout does not fabricate native fullscreen');
  assert.equal(f.elements.fullscreenButton.textContent, '收起地图');
  assert.equal(f.elements.fullscreenButton['aria-pressed'], 'true');
  assert.equal(f.classes.has('map-expanded'), true);
  assert.equal(f.elements.fullscreenMessage.hidden, true);
  assert.equal(f.elements.fullscreenHomeExit.hidden, false, 'home also has an exit outside the inert workspace');
  f.wakeLock.desired = true; f.wakeLock.held = true; f.render();
  assert.equal(f.elements.screenFeedback.hidden, true, 'successful keep-awake feedback never blocks map tools');
  f.english(); f.render(); assert.equal(f.elements.fullscreenButton['aria-label'], 'Collapse map');
  f.fullscreen.mode = null; f.fullscreen.presentationActive = false; f.render();
  assert.equal(f.elements.fullscreenButton.textContent, 'Expand map');
  assert.equal(f.classes.has('map-expanded'), false);
  assert.equal(f.elements.fullscreenHomeExit.hidden, true);
});

test('fullscreen and wake UI exposes actual success, denial and retry in both languages', () => {
  const f = renderFixture(); f.render();
  assert.match(f.elements.wakeLockChip.textContent, /未能保持常亮/);
  assert.equal(f.elements.wakeLockRetry.hidden, false); assert.equal(f.elements.screenFeedback.hidden, false);
  f.wakeLock.status = 'pending'; f.render();
  assert.match(f.elements.wakeLockChip.textContent, /正在申请/); assert.equal(f.elements.wakeLockRetry.hidden, true);
  f.fullscreen.active = true; f.wakeLock.held = true; f.wakeLock.status = 'held'; f.render();
  assert.equal(f.elements.fullscreenButton.textContent, '退出全屏'); assert.equal(f.elements.fullscreenButton['aria-pressed'], 'true');
  assert.equal(f.elements.fullscreenHomeExit.hidden, false);
  assert.equal(f.elements.wakeLockChip.textContent, '屏幕常亮已开启');
  f.english(); f.render(); assert.equal(f.elements.fullscreenButton['aria-label'], 'Exit fullscreen');
  f.fullscreen.active = false; f.fullscreen.error = 'unsupported'; f.wakeLock.held = false;
  f.wakeLock.supported = () => false; f.render();
  assert.match(f.elements.fullscreenMessage.textContent, /unavailable/); assert.match(f.elements.wakeLockChip.textContent, /unavailable/);
  assert.equal(f.elements.wakeLockRetry.hidden, true); assert.equal(f.elements.fullscreenHomeExit.hidden, true);
});

test('watch hides successful keep-awake feedback without hiding failures or changing the lock', () => {
  const f = renderFixture();
  f.state.watch.active = true; f.wakeLock.held = true; f.wakeLock.status = 'held';
  f.render();
  assert.equal(f.elements.screenFeedback.hidden, true);
  assert.equal(f.wakeLock.held, true); assert.equal(f.wakeLock.desired, true);
  f.fullscreen.error = 'request-denied'; f.render();
  assert.equal(f.elements.screenFeedback.hidden, false);
  assert.equal(f.elements.fullscreenMessage.hidden, false);
  f.fullscreen.error = null; f.wakeLock.held = false; f.wakeLock.status = 'denied'; f.render();
  assert.equal(f.elements.screenFeedback.hidden, false);
  assert.equal(f.elements.wakeLockRetry.hidden, false);
});

test('waiting leaves screen controls in the header and homepage has an exit outside the inert workspace', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const header = html.slice(html.indexOf('<header class="topbar"'), html.indexOf('</header>', html.indexOf('<header class="topbar"')));
  for (const id of ['fullscreenButton', 'wakeLockChip', 'wakeLockRetry', 'screenFeedback']) assert.ok(header.includes(`id="${id}"`), id);
  assert.equal((html.match(/id="wakeLockChip"/g) || []).length, 1);
  assert.ok(html.indexOf('id="fullscreenHomeExit"') > html.indexOf('</footer>'));
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /body\.gate-open #fullscreenHomeExit:not\(\[hidden\]\)/);
});
