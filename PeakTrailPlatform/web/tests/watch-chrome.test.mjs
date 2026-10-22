import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createWatchChrome } from '../src/watch-chrome.js';

class Node extends EventTarget {
  constructor(tagName = 'div') {
    super(); this.tagName = tagName.toUpperCase(); this.children = []; this.parentNode = null;
    this.attributes = new Map(); this.open = false; this.hidden = false; this.focusCount = 0;
    const classes = new Set();
    this.classList = { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; } };
  }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  before(node) {
    const parent = this.parentNode; assert.ok(parent, 'insertion anchor remains attached');
    node.remove(); parent.children.splice(parent.children.indexOf(this), 0, node); node.parentNode = parent;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(node) { for (; node; node = node.parentNode) if (node === this) return true; return false; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  matches(selector) {
    if (selector === 'details[open]') return this.tagName === 'DETAILS' && this.open;
    if (selector === "[contenteditable]:not([contenteditable='false'])")
      return this.attributes.has('contenteditable') && this.attributes.get('contenteditable') !== 'false';
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) if (selector.split(',').some(part => node.matches(part.trim()))) return node;
    return null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  focus() { this.focusCount++; }
}
class Document extends EventTarget {
  constructor() { super(); this.registrations = []; }
  createComment() { return new Node('#comment'); }
  addEventListener(type, callback, options) { this.registrations.push({ type, options }); super.addEventListener(type, callback, options); }
  emit(type, fields = {}) {
    const event = new Event(type, { cancelable: true });
    for (const [name, value] of Object.entries(fields)) Object.defineProperty(event, name, { value });
    let stopped = false;
    event.stopPropagation = () => { stopped = true; };
    this.dispatchEvent(event);
    return { event, get stopped() { return stopped; } };
  }
}
function fixture() {
  const root = new Document(), shell = new Node(), menu = new Node('details'), summary = new Node('summary');
  const slot = new Node(), original = new Node(), before = new Node(), first = new Node('button'), second = new Node(), after = new Node();
  const importedDetails = new Node('details'); second.append(importedDetails);
  const nested = new Node('details'), inside = new Node('button'); nested.append(inside);
  menu.append(summary, slot, nested); original.append(before, first, second, after);
  const initialChildren = [...original.children], closed = [];
  const chrome = createWatchChrome({ root, shell, menu, groups: [{ slot, controls: [first, null, second] }],
    onClosePanel(kind) { closed.push(kind); shell.classList.remove(`watch-${kind}-open`); } });
  return { root, shell, menu, summary, slot, original, first, second, importedDetails, nested, inside, closed, chrome, initialChildren };
}

test('watch controls move as the same live nodes and restore exact sibling order without accumulating placeholders', () => {
  const f = fixture(); let clicks = 0;
  f.first.addEventListener('click', () => clicks++);
  for (let cycle = 0; cycle < 3; cycle++) {
    f.importedDetails.open = true;
    f.chrome.setActive(true);
    assert.equal(f.importedDetails.open, false, 'an open explorer camera menu is folded after moving into default watch chrome');
    assert.deepEqual(f.slot.children, [f.first, f.second]); assert.equal(f.menu.hidden, false);
    f.first.dispatchEvent(new Event('click')); assert.equal(clicks, cycle + 1, 'the original listener survives each move');
    f.menu.open = true;
    f.shell.classList.add('watch-players-open');
    const resets = f.closed.length;
    f.chrome.setActive(true);
    assert.equal(f.menu.open, true); assert.equal(f.closed.length, resets, 'repaint of active mode cannot reset open UI');
    assert.equal(f.original.children.filter(node => node.tagName === '#COMMENT').length, 2);
    f.chrome.setActive(false);
    assert.equal(f.menu.hidden, true); assert.equal(f.menu.open, false);
    assert.deepEqual(f.original.children, f.initialChildren); assert.deepEqual(f.slot.children, []);
    assert.equal(f.shell.classList.contains('watch-players-open'), false);
  }
});

test('Escape consumes only the visible top UI layer and restores menu focus before camera shortcuts', () => {
  const f = fixture(); f.chrome.setActive(true); f.closed.length = 0;
  f.menu.open = true; f.nested.open = true; f.shell.classList.add('watch-players-open');
  const menuEscape = f.root.emit('keydown', { key: 'Escape', target: f.inside });
  assert.equal(menuEscape.event.defaultPrevented, true); assert.equal(menuEscape.stopped, true);
  assert.equal(f.menu.open, false); assert.equal(f.nested.open, false);
  assert.equal(f.shell.classList.contains('watch-players-open'), true, 'one key closes only the menu');
  assert.deepEqual(f.closed, []); assert.equal(f.summary.focusCount, 1);
  const panelEscape = f.root.emit('keydown', { key: 'Escape', target: f.inside });
  assert.equal(panelEscape.stopped, true); assert.deepEqual(f.closed, ['players']); assert.equal(f.summary.focusCount, 2);
  f.shell.classList.add('watch-replay-open');
  assert.equal(f.root.emit('keydown', { key: 'Escape' }).stopped, true);
  assert.deepEqual(f.closed, ['players', 'replay']);
  const bareEscape = f.root.emit('keydown', { key: 'Escape' });
  assert.equal(bareEscape.stopped, false); assert.equal(bareEscape.event.defaultPrevented, false);
  assert.equal(f.root.registrations.find(item => item.type === 'keydown').options, true, 'capture intercepts the key before the camera');
});

test('Tab, clicks inside and inactive workspace keys stay native; outside click and reset close only chrome', () => {
  const f = fixture(); f.chrome.setActive(true); f.menu.open = true; f.nested.open = true;
  const tab = f.root.emit('keydown', { key: 'Tab', target: f.summary });
  assert.equal(tab.event.defaultPrevented, false); assert.equal(tab.stopped, false); assert.equal(f.menu.open, true);
  f.root.emit('click', { target: f.inside }); assert.equal(f.menu.open, true);
  f.root.emit('click', { target: f.original }); assert.equal(f.menu.open, false); assert.equal(f.nested.open, false);
  assert.equal(f.summary.focusCount, 0, 'pointer dismissal does not steal focus');
  // Native <summary> can close only its parent before the controller runs.
  f.nested.open = true; f.importedDetails.open = true;
  assert.equal(f.chrome.closeMenu(true), false, 'an already-closed outer menu does not claim a visible layer was closed');
  assert.equal(f.nested.open, false); assert.equal(f.importedDetails.open, false);
  assert.equal(f.summary.focusCount, 0, 'cleaning hidden nested state does not move focus');
  f.menu.open = true; f.shell.classList.add('watch-replay-open'); f.chrome.reset();
  assert.equal(f.menu.open, false); assert.equal(f.shell.classList.contains('watch-replay-open'), false);
  assert.equal(f.first.parentNode, f.slot, 'reset hides UI without relocating controls into another workspace');
  f.chrome.setActive(false); f.menu.open = true;
  assert.equal(f.root.emit('keydown', { key: 'Escape' }).stopped, false);
  assert.equal(f.menu.open, true);
});

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function appFunction(name) {
  const source = app.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))?.[0];
  assert.ok(source, name); return source;
}
test('player and replay drawers are mutually exclusive UI only, in live and paused playback', () => {
  for (const following of [true, false]) {
    const shell = new Node(), nodes = new Map([['watchPlayers', new Node()], ['watchReplay', new Node()]]);
    const state = Object.freeze({ playing: !following, currentTime: 42, watch: Object.freeze({ active: true, following }) });
    let menusClosed = 0;
    const forbidden = () => { throw new Error('Panel toggles must not seek, play, reload or reconnect'); };
    const ports = { state, elements: { appShell: shell }, $: id => nodes.get(id), watchChrome: { closeMenu() { menusClosed++; } },
      updatePlaybackTime: forbidden, setPlaying: forbidden, renderData: forbidden, startWatch: forbidden, viewer: { fitView: forbidden } };
    const api = new Function(...Object.keys(ports), '"use strict";\n' + ['toggleWatchPlayers', 'toggleWatchReplay'].map(appFunction).join('\n')
      + '\nreturn {toggleWatchPlayers,toggleWatchReplay};')(...Object.values(ports));
    api.toggleWatchPlayers();
    assert.equal(shell.classList.contains('watch-players-open'), true);
    assert.equal(nodes.get('watchPlayers').getAttribute('aria-expanded'), 'true');
    api.toggleWatchReplay();
    assert.equal(shell.classList.contains('watch-players-open'), false); assert.equal(shell.classList.contains('watch-replay-open'), true);
    assert.equal(nodes.get('watchPlayers').getAttribute('aria-expanded'), 'false'); assert.equal(nodes.get('watchReplay').getAttribute('aria-expanded'), 'true');
    api.toggleWatchReplay(); assert.equal(shell.classList.contains('watch-replay-open'), false);
    assert.deepEqual(state, { playing: !following, currentTime: 42, watch: { active: true, following } });
    assert.equal(menusClosed, 2);
  }
});

test('Space on menu summaries and native interactive content does not click the hidden playback button', () => {
  const source = app.match(/document\.addEventListener\("keydown", \(event\) => \{\r?\n  if \(gateOpen\(\)\) return;[^]*?^\}\);/m)?.[0];
  assert.ok(source);
  const root = new Document(); let clicks = 0, gate = false;
  new Function('document', 'elements', 'gateOpen', source)(root, { playButton: { click() { clicks++; } } }, () => gate);
  for (const tag of ['summary', 'a', 'textarea', 'button', 'input', 'select']) {
    const parent = new Node(tag), child = new Node('span'); parent.append(child);
    for (const target of [parent, child]) {
      const result = root.emit('keydown', { code: 'Space', target });
      assert.equal(result.event.defaultPrevented, false, `${tag} retains its native action`); assert.equal(clicks, 0);
    }
  }
  const editable = new Node(), child = new Node('span'); editable.append(child); editable.setAttribute('contenteditable', '');
  assert.equal(root.emit('keydown', { code: 'Space', target: child }).event.defaultPrevented, false); assert.equal(clicks, 0);
  const canvas = new Node('canvas');
  assert.equal(root.emit('keydown', { code: 'Space', target: canvas }).event.defaultPrevented, true); assert.equal(clicks, 1);
  root.emit('keydown', { code: 'Space', repeat: true, target: canvas });
  root.emit('keydown', { code: 'Enter', target: canvas }); gate = true;
  root.emit('keydown', { code: 'Space', target: canvas }); assert.equal(clicks, 1);
});

test('pausing the live edge reveals replay controls without seeking or disconnecting the stream', () => {
  const source = app.match(/elements\.playButton\.addEventListener\("click", \(\) => \{[^]*?^\}\);/m)?.[0];
  assert.ok(source);
  const button = new Node('button'), calls = [], client = {};
  const state = { trace: { duration: 90 }, currentTime: 89.7, playing: false, watch: { active: true, following: true, status: 'live', client } };
  new Function('elements', 'state', 'setPlaying', 'toggleWatchReplay', 'updateWatchStatus', 'updatePlaybackTime', source)(
    { playButton: button }, state, value => { calls.push(['playing', value]); state.playing = value; },
    open => calls.push(['replay', open]), () => calls.push(['status']), () => assert.fail('Pausing cannot seek'));
  button.dispatchEvent(new Event('click'));
  assert.equal(state.watch.following, false); assert.equal(state.watch.client, client); assert.equal(state.currentTime, 89.7);
  assert.deepEqual(calls, [['playing', false], ['replay', true], ['status']]);
});
