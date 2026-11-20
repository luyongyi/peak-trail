// Each lazy shard covers eight map slots. Its two map identities and exact
// geometry digests were verified against both releases by the offline compiler.
const shards = [
  () => import('./campfire-sources/00.js'),
  () => import('./campfire-sources/01.js'),
  () => import('./campfire-sources/02.js'),
  () => import('./campfire-sources/03.js'),
  () => import('./campfire-sources/04.js'),
  () => import('./campfire-sources/05.js'),
  () => import('./campfire-sources/06.js'),
  () => import('./campfire-sources/07.js'),
  () => import('./campfire-sources/08.js'),
  () => import('./campfire-sources/09.js'),
  () => import('./campfire-sources/10.js'),
  () => import('./campfire-sources/11.js'),
  () => import('./campfire-sources/12.js'),
  () => import('./campfire-sources/13.js'),
  () => import('./campfire-sources/14.js'),
  () => import('./campfire-sources/15.js'),
  () => import('./campfire-sources/16.js'),
  () => import('./campfire-sources/17.js'),
  () => import('./campfire-sources/18.js'),
  () => import('./campfire-sources/19.js'),
  () => import('./campfire-sources/20.js'),
  () => import('./campfire-sources/21.js'),
  () => import('./campfire-sources/22.js'),
  () => import('./campfire-sources/23.js'),
  () => import('./campfire-sources/24.js'),
  () => import('./campfire-sources/25.js'),
];

export async function loadCampfireSourceData(mapPack) {
  if (mapPack?.identityVersion !== 3) return null;
  const build = String(mapPack.gameBuildId);
  if (build !== '26542162' && build !== '26155610') return null;
  const scene = /^Level_(\d+)$/.exec(mapPack.sceneName || '');
  const slot = mapPack.mapSlot ?? (scene ? Number(scene[1]) : null);
  if (!Number.isInteger(slot) || slot < 0 || slot >= 208 || (scene && Number(scene[1]) !== slot)) return null;
  const { default: records } = await shards[Math.floor(slot / 8)]();
  const [currentId, legacyId, chapters] = records[slot % 8];
  if (mapPack.mapPackId !== (build === '26542162' ? currentId : legacyId)) return null;
  const byGeometry = Object.create(null), templates = Object.create(null);
  for (const [digest, template] of chapters) {
    byGeometry[digest] = template ? digest : null;
    if (template) templates[digest] = template;
  }
  return { byGeometry, templates };
}
