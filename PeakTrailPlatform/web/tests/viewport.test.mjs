import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewportLayout } from '../src/viewport.js';

function fixture({ visual = true } = {}) {
  const values = new Map(), windowEvents = new Map(), viewportEvents = new Map(), frames = new Map();
  let id = 0, writes = 0;
  const style = {
    setProperty(key, value) { values.set(key, value); writes++; },
    getPropertyValue: key => values.get(key) || '', getPropertyPriority: () => '',
    removeProperty: key => values.delete(key),
  };
  const viewport = { width: 440, height: 760, offsetTop: 0, offsetLeft: 0, scale: 1,
    addEventListener: (name, handler) => viewportEvents.set(name, handler),
    removeEventListener: name => viewportEvents.delete(name) };
  const win = { innerWidth: 440, innerHeight: 956, visualViewport: visual ? viewport : undefined,
    addEventListener: (name, handler) => windowEvents.set(name, handler),
    removeEventListener: name => windowEvents.delete(name),
    requestAnimationFrame(handler) { frames.set(++id, handler); return id; },
    cancelAnimationFrame: key => frames.delete(key) };
  const controller = createViewportLayout({ documentRef: { documentElement: { style }, defaultView: win } });
  return { controller, values, viewport, win, style, frames, windowEvents, viewportEvents,
    get writes() { return writes; },
    flush() { for (const [key, callback] of [...frames]) { frames.delete(key); callback(); } } };
}

test('visible viewport follows Safari toolbar, keyboard offset and orientation in one frame', () => {
  const f = fixture();
  assert.equal(f.values.get('--app-viewport-height'), '760px');
  f.viewport.height = 410; f.viewport.offsetTop = 180;
  f.viewportEvents.get('resize')(); f.viewportEvents.get('scroll')();
  assert.equal(f.frames.size, 1); f.flush();
  assert.equal(f.values.get('--app-viewport-height'), '410px');
  assert.equal(f.values.get('--app-viewport-offset-top'), '180px');
  f.viewport.width = 956; f.viewport.height = 360; f.viewport.offsetTop = -2;
  f.windowEvents.get('orientationchange')(); f.flush();
  assert.equal(f.values.get('--app-viewport-width'), '956px');
  assert.equal(f.values.get('--app-viewport-offset-top'), '0px');
  const writes = f.writes;
  f.viewportEvents.get('resize')(); f.flush(); assert.equal(f.writes, writes);
});

test('pinch magnification does not shrink or reposition the page underneath the user', () => {
  const f = fixture(), before = new Map(f.values);
  f.viewport.scale = 2; f.viewport.width = 220; f.viewport.height = 380; f.viewport.offsetLeft = 80;
  f.viewportEvents.get('resize')(); f.viewportEvents.get('scroll')(); f.flush();
  assert.deepEqual(f.values, before);
  f.viewport.scale = 1; f.viewport.width = 440; f.viewport.height = 820; f.viewport.offsetLeft = 0;
  f.viewportEvents.get('resize')(); f.flush();
  assert.equal(f.values.get('--app-viewport-height'), '820px');
});

test('window sizing is a fallback and invalid dimensions never replace a valid layout', () => {
  const f = fixture({ visual: false });
  assert.equal(f.values.get('--app-viewport-height'), '956px');
  f.win.innerHeight = 0; f.windowEvents.get('resize')(); f.flush();
  assert.equal(f.values.get('--app-viewport-height'), '956px');
  assert.doesNotThrow(() => createViewportLayout().dispose());
  assert.doesNotThrow(() => createViewportLayout({ documentRef: {} }).dispose());
});

test('disposing releases events, cancels pending work and leaves later external styles intact', () => {
  const f = fixture();
  f.viewportEvents.get('resize')();
  f.style.setProperty('--app-viewport-width', '500px');
  f.controller.dispose(); f.controller.dispose();
  assert.equal(f.frames.size, 0); assert.equal(f.windowEvents.size, 0); assert.equal(f.viewportEvents.size, 0);
  assert.equal(f.values.get('--app-viewport-width'), '500px');
  assert.equal(f.values.has('--app-viewport-height'), false);
});
