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
  assert.equal(screen.active, true); assert.equal(screen.pending, false);
  doc.fullscreenElement = null; listeners.get('fullscreenchange')();
  assert.equal(screen.active, false); assert.equal(changes.at(-1), false);
  await screen.toggle(); await screen.toggle();
  assert.deepEqual(calls, ['request', 'request', 'exit']);
  screen.dispose(); assert.equal(listeners.size, 0);
});

test('unsupported, denied and rejected exit never fabricate fullscreen success', async () => {
  const { doc, calls } = fakeDocument();
  const screen = createFullscreen({ documentRef: doc });
  doc.fullscreenEnabled = false; await screen.toggle();
  assert.equal(screen.error, 'unsupported'); assert.deepEqual(calls, []); assert.equal(screen.active, false);
  doc.fullscreenEnabled = true;
  doc.documentElement.requestFullscreen = async () => { throw new Error('gesture denied'); };
  await screen.toggle(); assert.equal(screen.error, 'request-denied'); assert.equal(screen.active, false);
  doc.fullscreenElement = doc.documentElement;
  doc.exitFullscreen = async () => { throw new Error('not allowed'); };
  await screen.toggle(); assert.equal(screen.error, 'exit-denied'); assert.equal(screen.active, true);
});

test('duplicate clicks share one pending native operation', async () => {
  const { doc } = fakeDocument(); let resolve, requests = 0;
  doc.documentElement.requestFullscreen = () => { requests++; return new Promise(done => { resolve = done; }); };
  const screen = createFullscreen({ documentRef: doc });
  const first = screen.toggle(); await screen.toggle();
  assert.equal(requests, 1); assert.equal(screen.pending, true);
  resolve(); await first;
  assert.equal(screen.pending, false); assert.equal(screen.active, false, 'a resolved call alone does not prove fullscreen');
});

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function renderFixture() {
  const elements = Object.fromEntries(['fullscreenButton', 'fullscreenHomeExit', 'fullscreenMessage', 'screenFeedback', 'wakeLockChip', 'wakeLockRetry']
    .map(key => [key, { hidden: false, classList: { toggle() {} }, setAttribute(key, value) { this[key] = value; } }]));
  const fullscreen = { active: false, pending: false, error: null };
  const wakeLock = { desired: true, held: false, status: 'denied', supported: () => true };
  let english = false;
  const source = app.match(/^function syncWakeLockChip\([^]*?^\}/m)[0];
  const render = new Function('elements', 'fullscreen', 'wakeLock', 'tr', 'window', `${source}; return syncWakeLockChip;`)(
    elements, fullscreen, wakeLock, (zh, en) => english ? en : zh, { isSecureContext: true });
  return { elements, fullscreen, wakeLock, render, english() { english = true; } };
}

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

test('waiting leaves screen controls in the header and homepage has an exit outside the inert workspace', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const header = html.slice(html.indexOf('<header class="topbar"'), html.indexOf('</header>', html.indexOf('<header class="topbar"')));
  for (const id of ['fullscreenButton', 'wakeLockChip', 'wakeLockRetry', 'screenFeedback']) assert.ok(header.includes(`id="${id}"`), id);
  assert.equal((html.match(/id="wakeLockChip"/g) || []).length, 1);
  assert.ok(html.indexOf('id="fullscreenHomeExit"') > html.indexOf('</footer>'));
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /body\.gate-open #fullscreenHomeExit:not\(\[hidden\]\)/);
});
