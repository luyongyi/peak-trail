// Audited builds 25306743 and 25739797 use M_Void Water / GD/Water-GD.
// Its 5 km square is retained in the scene; only camera fitting omits it.
export function nadirCameraBounds(layer, gameBuildId, parts) {
  if (!["25306743", "25739797"].includes(String(gameBuildId)) || String(layer?.biome).toLowerCase() !== "void") return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let omitted = 0, retained = 0;
  for (const part of parts) {
    const bounds = part?.bounds;
    if (!bounds || ![bounds.min, bounds.max].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
        || bounds.min.some((v, i) => v > bounds.max[i])) return null;
    const size = bounds.max.map((v, i) => v - bounds.min[i]);
    const water = part.materials?.length && part.materials.every((material) => material.name === "M_Void Water" && material.shader === "GD/Water-GD");
    if (water && Math.abs(size[0] - 5000) < 1 && Math.abs(size[2] - 5000) < 1 && size[1] < 0.01) {
      omitted++;
      continue;
    }
    retained++;
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], bounds.min[i]); max[i] = Math.max(max[i], bounds.max[i]); }
  }
  return omitted && retained ? { min, max } : null;
}
