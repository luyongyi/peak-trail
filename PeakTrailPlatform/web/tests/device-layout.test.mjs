import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const home = await readFile(new URL('../home.css', import.meta.url), 'utf8');
const replay = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('home and replay share an iPad portrait range including mini and large Pro widths', () => {
  const portrait = /@media \(min-width: 744px\) and \(max-width: 1100px\) and \(orientation: portrait\)/;
  assert.match(home, portrait);
  assert.match(replay, portrait);
  assert.match(home, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(home, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(replay, /\.workspace \{ display: block; \}/);
  assert.doesNotMatch(replay, /\.speed-control\s*\{\s*display:\s*none/);
});

test('phone-only breakpoints are retired while tablet touch targets remain', () => {
  for (const css of [home, replay]) {
    assert.doesNotMatch(css, /@media\s*\(max-width:\s*(?:440|520|640|700|760|850)px\)/);
    assert.match(css, /@media \(pointer: coarse\) and \(min-width: 744px\)/);
    assert.match(css, /min-height: 44px/);
  }
});
