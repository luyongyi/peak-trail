import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLocale, normalizeLocale, getLocale, setLocale, onLocaleChange, tr, biomeName, gameText, gameItemName } from '../src/i18n.js';
import { REPLAY_CAMERA_HELP } from '../src/replay-camera.js';
import { worldTelemetryNote } from '../src/world-timeline.js';

test('language selection prefers explicit links, remembered choices, then browser language', () => {
  assert.equal(detectLocale({ url: 'https://example.test/?lang=en', stored: 'zh-CN', languages: ['zh-CN'] }), 'en');
  assert.equal(detectLocale({ url: 'https://example.test/', stored: 'zh-CN', languages: ['en-US'] }), 'zh-CN');
  assert.equal(detectLocale({ languages: ['zh-TW'] }), 'zh-CN');
  assert.equal(detectLocale({ languages: ['fr-FR'] }), 'en');
  assert.equal(detectLocale(), 'zh-CN');
  assert.equal(normalizeLocale('en-GB'), 'en');
  assert.equal(normalizeLocale('<script>'), null);
});

test('switching language uses game terms without confusing internal biome or action names', () => {
  const previous = getLocale(), events = [];
  const unsubscribe = onLocaleChange(locale => events.push(locale));
  try {
    setLocale('en', { persist: false });
    assert.equal(biomeName('swamp'), 'GLOOM');
    assert.equal(biomeName('temple'), 'THE CITADEL');
    assert.equal(biomeName('void'), 'NADIR');
    assert.equal(gameText('ASCENT 4'), 'ASCENT 4');
    assert.equal(gameItemName('HealingPuffShroom'), 'REMEDY FUNGUS');
    assert.equal(gameItemName('曲迁菇'), 'WARP FUNGUS');
    assert.equal(gameItemName('Example custom item'), 'Example custom item');
    assert.equal(gameText('PLAY', '播放', 'Play'), 'Play', 'the unrelated in-game instrument PLAY term is not reused');
    assert.equal(tr('地图', 'Map'), 'Map');
    assert.match(REPLAY_CAMERA_HELP, /WASD to move/);
    assert.doesNotMatch(worldTelemetryNote(null, 0), /\p{Script=Han}/u);
    setLocale('zh-CN', { persist: false });
    assert.equal(biomeName('roots'), '森蕈');
    assert.equal(gameText('BACK'), '返回');
    assert.equal(gameItemName('HealingPuffShroom'), '灵药菇');
    assert.match(REPLAY_CAMERA_HELP, /点击地图/);
    assert.equal(setLocale('de', { persist: false }), false);
    assert.equal(getLocale(), 'zh-CN');
    assert.deepEqual(events, ['en', 'zh-CN']);
    unsubscribe();
    setLocale('en', { persist: false });
    assert.deepEqual(events, ['en', 'zh-CN']);
  } finally { unsubscribe(); setLocale(previous, { persist: false }); }
});

test('manual choices are remembered without losing a historical-route link or requiring storage', () => {
  const previous = getLocale(), oldWindow = globalThis.window, oldDocument = globalThis.document;
  const values = new Map(), replaced = [];
  globalThis.window = { localStorage: { setItem: (key, value) => values.set(key, value) },
    location: { href: 'https://example.test/?routeGroup=keep&lang=zh-CN' },
    history: { state: { route: true }, replaceState: (state, unused, url) => replaced.push({ state, url }) } };
  globalThis.document = { documentElement: { lang: 'zh-CN' } };
  try {
    setLocale('en');
    assert.equal(values.get('peak-trail.language'), 'en');
    assert.equal(replaced.at(-1).url.searchParams.get('routeGroup'), 'keep');
    assert.equal(replaced.at(-1).url.searchParams.get('lang'), 'en');
    assert.equal(globalThis.document.documentElement.lang, 'en');
    globalThis.window.localStorage.setItem = () => { throw new Error('Storage disabled'); };
    assert.doesNotThrow(() => setLocale('zh-CN'));
    assert.equal(getLocale(), 'zh-CN');
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    setLocale(previous, { persist: false });
  }
});
