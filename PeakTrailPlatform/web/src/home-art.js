// Illustrative atmosphere only. Never use these as replay geometry or map evidence.
export const HOME_ART_FILES = Object.freeze([
  'shore-v1.png', 'roots-v1.png', 'tropics-v1.png', 'alpine-v1.png',
  'mesa-v1.png', 'volcano-v1.png', 'swamp-v1.png',
  'kiln-v1.png', 'temple-v1.png',
]);
export const HOME_ART = Object.freeze(Object.fromEntries(HOME_ART_FILES.map(file => [
  file.replace('-v1.png', ''), `./data/home-art/${file}`,
])));

// Endings reuse the preceding biome enum in game data; use the confirmed route,
// never that enum alone, to choose the distinct interior illustration.
export const HOME_ENDINGS = Object.freeze({
  'volcano-kiln': Object.freeze({ art: HOME_ART.kiln, english: 'THE KILN', description: '走进火山深处，沿着熔岩照亮的内壁，完成最后的攀登。' }),
  'swamp-temple': Object.freeze({ art: HOME_ART.temple, english: 'THE CITADEL', description: '穿过雾岛，在围墙环抱的高塔内部，循着微光继续向上。' }),
});
