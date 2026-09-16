// Matching is limited to exact-build explosive-mushroom geometry. An absent
// snapshot is not an explosion, and a blast radius is not a mesh-hide radius.
export function isExplosiveMineMaterial(buildId, name, shader) {
  return String(buildId) === '25306743' && name === 'M_SporeShroomExplo' && shader === 'W/Peak_Standard';
}

const point = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const distance = (a, b) => Math.hypot(...a.map((axis, i) => axis - b[i]));

function isDuplicatePart(a, b) {
  // Separate original LOD/submesh draws can represent the same physical mine.
  // Do not treat merely overlapping neighbouring mushrooms as one instance.
  const spanA = a.max.map((v, i) => v - a.min[i]);
  const spanB = b.max.map((v, i) => v - b.min[i]);
  const tolerance = Math.max(0.015, Math.min(0.12, Math.hypot(...spanA) * 0.04));
  return distance(a.center, b.center) <= tolerance
    && spanA.every((v, i) => Math.abs(v - spanB[i]) <= Math.max(0.04, v * 0.35));
}

function score(candidate, pos) {
  if (![candidate.center, candidate.min, candidate.max].every(point)) return Infinity;
  const diagonal = distance(candidate.min, candidate.max);
  if (!(diagonal > 0) || diagonal > 30) return Infinity;
  // Unity prefab origin sits slightly below the visible cap. Bounds carry the
  // full scene scale/reflection; modest padding tolerates source LOD variation.
  const padding = Math.max(0.15, Math.min(0.6, diagonal * 0.22));
  if (pos.some((v, i) => v < candidate.min[i] - padding || v > candidate.max[i] + padding)) return Infinity;
  return distance(candidate.center, pos);
}

export function recordedHiddenMineIndices(candidates, objects = [], events = [], time = 0) {
  const positions = objects.filter((object) => object.kind === 'mine'
    && ['spent', 'exploded'].includes(object.activity) && point(object.pos)).map((object) => object.pos);
  for (const event of events) {
    if (['mine_explosion', 'mine_exploded'].includes(event.type)
      && Number.isFinite(event.t) && event.t <= time && point(event.pos)) positions.push(event.pos);
  }
  const hidden = new Set();
  for (const pos of positions) {
    const matches = candidates.map((candidate, index) => ({ candidate, index, score: score(candidate, pos) }))
      .filter((match) => Number.isFinite(match.score)).sort((a, b) => a.score - b.score);
    if (!matches.length) continue;
    const nearest = matches[0];
    const other = matches.find((match) => !isDuplicatePart(nearest.candidate, match.candidate));
    // Ambiguous equal-distance neighbours remain visible rather than erasing
    // an unrelated mine with unsupported certainty.
    if (other && other.score - nearest.score < 0.05) continue;
    hidden.add(nearest.index);
    for (const match of matches.slice(1)) {
      if (isDuplicatePart(nearest.candidate, match.candidate)) hidden.add(match.index);
    }
  }
  return hidden;
}
