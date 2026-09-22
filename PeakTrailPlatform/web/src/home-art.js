// Illustrative atmosphere only. Never use these as replay geometry or map evidence.
export const HOME_ART_FILES = Object.freeze([
  'shore-v3.png', 'roots-v3.png', 'tropics-v3.png', 'alpine-v3.png',
  'mesa-v3.png', 'volcano-v3.png', 'swamp-v3.png',
  'kiln-v3.png', 'temple-v3.png',
]);
export const HOME_ART = Object.freeze(Object.fromEntries(HOME_ART_FILES.map(file => [
  file.replace(/-v\d+\.png$/, ''), `./data/home-art/${file}`,
])));

// Endings reuse the preceding biome enum in game data; use the confirmed route,
// never that enum alone, to choose the distinct interior illustration.
export const HOME_ENDINGS = Object.freeze({
  'volcano-kiln': Object.freeze({ art: HOME_ART.kiln, english: 'THE KILN', description: '走进火山深处，跨过岩桥，赶在熔岩升起前沿内壁向上。' }),
  'swamp-temple': Object.freeze({ art: HOME_ART.temple, english: 'THE CITADEL', description: '穿过雾岛，在围墙环抱的高塔内部，避开箭道，循着微光向上。' }),
});
