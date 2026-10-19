import { GAME_NAME_TERMS, GAME_ITEM_KEYS } from './game-text.js';

// Only terms used by this site are retained from the game's runtime table.
// resources.assets / TextAsset 1422 / SerializedTermsData, build 25739797.
export const GAME_TEXT_SOURCE = Object.freeze({ gameBuildId: '25739797', textAsset: 'SerializedTermsData',
  sha256: '13a7a854a997e6445b0b0c2d702748ed65e5f8edcc3e6cc317bfa1d860f0d342', englishIndex: 0, chineseIndex: 9 });
const GAME_TEXT = Object.freeze({
  ...GAME_NAME_TERMS,
  SHORE: ['海岸', 'SHORE'], ROOTS: ['森蕈', 'ROOTS'], TROPICS: ['雨林', 'TROPICS'], ALPINE: ['雪山', 'ALPINE'],
  MESA: ['方山', 'MESA'], CALDERA: ['火山', 'CALDERA'], 'THE KILN': ['熔炉', 'THE KILN'],
  GLOOM: ['雾沼', 'GLOOM'], 'THE CITADEL': ['城塞', 'THE CITADEL'], PEAK: ['顶峰', 'PEAK'], AREA_VOID: ['天底', 'NADIR'],
  BACK: ['返回', 'BACK'], SETTINGS: ['设置', 'SETTINGS'], LANGUAGE: ['语言', 'LANGUAGE'], LOADING: ['加载中', 'LOADING'],
  TENDERFOOT: ['菜鸟新人', 'TENDERFOOT'], CUSTOM: ['自定义冒险', 'CUSTOM RUN'],
  ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`ASCENT ${index + 1}`, [`天阶 ${index + 1}`, `ASCENT ${index + 1}`]])),
});
const BIOME_KEYS = Object.freeze({ shore: 'SHORE', beach: 'SHORE', roots: 'ROOTS', tropics: 'TROPICS',
  alpine: 'ALPINE', mesa: 'MESA', volcano: 'CALDERA', caldera: 'CALDERA', kiln: 'THE KILN',
  swamp: 'GLOOM', gloom: 'GLOOM', temple: 'THE CITADEL', citadel: 'THE CITADEL', peak: 'PEAK', void: 'AREA_VOID', nadir: 'AREA_VOID' });
const STORAGE_KEY = 'peak-trail.language';
const listeners = new Set();
export function normalizeLocale(value) {
  const name = String(value || '').toLowerCase();
  return /^zh(?:-|$)/.test(name) ? 'zh-CN' : /^en(?:-|$)/.test(name) ? 'en' : null;
}
export function detectLocale({ url, stored, languages = [] } = {}) {
  let query;
  try { query = normalizeLocale(new URL(url).searchParams.get('lang')); } catch { /* No browser URL. */ }
  return query || normalizeLocale(stored) || (String(languages[0] || '').toLowerCase().startsWith('zh') ? 'zh-CN' : languages.length ? 'en' : 'zh-CN');
}
function initialLocale() {
  if (typeof window === 'undefined' || typeof window.location?.href !== 'string') return 'zh-CN';
  let stored;
  try { stored = window.localStorage.getItem(STORAGE_KEY); } catch { /* Storage can be disabled. */ }
  return detectLocale({ url: window.location.href, stored, languages: window.navigator?.languages || [window.navigator?.language].filter(Boolean) });
}
let locale = initialLocale();
export const getLocale = () => locale;
export function tr(chinese, english) { return String(locale === 'en' ? english ?? chinese : chinese); }
export function setLocale(value, { persist = true } = {}) {
  const next = normalizeLocale(value);
  if (!next) return false;
  if (persist && typeof window !== 'undefined') {
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* Session-only switching still works. */ }
    // An explicit language link should not override a later manual choice on reload.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('lang')) { url.searchParams.set('lang', next); window.history.replaceState(window.history.state, '', url); }
    } catch { /* Embeds can restrict history. */ }
  }
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = next;
  if (locale === next) return true;
  locale = next;
  for (const listener of [...listeners]) listener(next);
  return true;
}
export function onLocaleChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function gameText(key, chinese = '', english = '') {
  const term = GAME_TEXT[String(key).toUpperCase()];
  return term ? tr(term[0], term[1]) : tr(chinese, english || chinese);
}
const ITEM_TEXT_KEYS = new Map();
for (const [key, names] of Object.entries(GAME_NAME_TERMS)) for (const name of names) {
  const normalized = name.toUpperCase();
  const previous = ITEM_TEXT_KEYS.get(normalized);
  ITEM_TEXT_KEYS.set(normalized, ITEM_TEXT_KEYS.has(normalized) && previous !== key ? null : key);
}
export function gameItemName(value) {
  const name = String(value || '');
  const key = GAME_ITEM_KEYS[name] || (GAME_NAME_TERMS[`NAME_${name.toUpperCase()}`] ? `NAME_${name.toUpperCase()}` : null)
    || ITEM_TEXT_KEYS.get(name.toUpperCase());
  return key ? gameText(key) : name;
}
export function biomeName(value, fallback = '') {
  const name = typeof value === 'object' && value ? value.biome || value.stageId || '' : value;
  const key = BIOME_KEYS[String(name || '').toLowerCase()];
  return key ? gameText(key) : String(fallback || name || '');
}
export function formatNumber(value, options) { return new Intl.NumberFormat(locale, options).format(value); }
