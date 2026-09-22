// Exact-build effect-volume evidence is documented in
// tools/offline-maps/EFFECT-PROXIES.md. These are projection volumes, not props.
// Do not classify by mesh name: PEAK also has genuine spherical mushrooms,
// glass and AntiSphere objects that must remain visible.
const PROJECTED_DECALS = new Set(["M_VFX_PetrifyDecal", "M_VFX_FireballDecal"]);

export function isSourceProjectionProxy(gameBuildId, materialName, shader) {
  return String(gameBuildId) === "25306743" && shader === "Decal"
    && PROJECTED_DECALS.has(materialName);
}

export function isProjectionProxyMaterial(gameBuildId, material) {
  const source = material?.userData?.peakTerrain;
  return isSourceProjectionProxy(gameBuildId, source?.sourceMaterial || material?.name,
    source?.sourceColors?.shader);
}
