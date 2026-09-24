import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const home = await readFile(new URL('../home.css', import.meta.url), 'utf8');
const replay = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('home and replay share an iPad portrait range including mini and large Pro widths', () => {
  const portrait = /@media \(min-width: 744px\) and \(max-width: 1100px\) and \(orientation: portrait\)/;
  assert.match(home, portrait);
  assert.match(replay, portrait);
  assert.match(home, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(home, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(replay, /\.workspace \{ display: block; \}/);
  assert.doesNotMatch(replay, /\.speed-control\s*\{\s*display:\s*none/);
});

test('phone and tablet layouts retain touch targets and playback speed', () => {
  for (const css of [home, replay]) {
    assert.match(css, /@media \(max-width: 743px\)/);
    assert.match(css, /min-height: 44px/);
    assert.match(css, /env\(safe-area-inset-bottom/);
  }
  assert.match(home, /@media \(max-width: 359px\)/);
  assert.doesNotMatch(replay, /\.speed-control\s*\{\s*display:\s*none/);
  assert.doesNotMatch(home, /\.home-date\s*\{\s*display:\s*none/);
});

test('phone spectators can leave the gesture-controlled map and navigate inside it without a keyboard', () => {
  assert.match(html, /id="phonePanelButton"[^>]*aria-label="跳到玩家状态与回放设置"/);
  assert.match(replay, /\.phone-panel-button\s*\{[\s\S]*?min-height: 44px/);
  assert.equal((html.match(/data-camera-move=/g) || []).length, 6);
  assert.match(replay, /\.camera-touch-controls\[hidden\] \{ display: none !important; \}/);
  assert.match(replay, /html, body \{\s*min-width: 320px;\s*height: auto;/);
  assert.match(replay, /body \{ overflow: visible; \}/);
});

test('short phone landscape reserves map height with single-row playback controls', () => {
  for (const css of [home, replay]) {
    assert.match(css, /\(max-width: 950px\) and \(max-height: 500px\) and \(orientation: landscape\)/);
  }
  assert.match(replay, /grid-template-areas: "play current track total speed panel"/);
  assert.match(replay, /height: calc\(100svh - 114px/);
});
