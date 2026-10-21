const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const GROUP_RADIUS_METERS = 4;

/** Native metre positions decide proximity, independently of map height scaling.
 * Every pair in a group must be close: a chain cannot swallow distant players.
 * Projected entries also need overlapping portraits, so zooming in separates them. */
export function clusterPlayerEntries(entries, radius = GROUP_RADIUS_METERS) {
  const clusters = [...(entries || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(entry => [entry]);
  const limit = Math.max(0, finite(radius, GROUP_RADIUS_METERS));
  const validPosition = entry => Array.isArray(entry?.pos) && entry.pos.length === 3 && entry.pos.every(Number.isFinite);
  const pairDistance = (a, b) => {
    if (!validPosition(a) || !validPosition(b)) return Infinity;
    const distance = Math.hypot(...a.pos.map((value, axis) => value - b.pos[axis]));
    if (distance > limit) return Infinity;
    const projected = [a.x, a.y, a.size, b.x, b.y, b.size];
    if (projected.every(Number.isFinite)
      && Math.hypot(a.x - b.x, a.y - b.y) > (a.size + b.size) / 2 + 4) return Infinity;
    return distance;
  };
  for (;;) {
    let best = null;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const distance = Math.max(...clusters[i].flatMap(a => clusters[j].map(b => pairDistance(a, b))));
        if (Number.isFinite(distance) && (!best || distance < best.distance)) best = { i, j, distance };
      }
    }
    if (!best) return clusters;
    clusters[best.i].push(...clusters[best.j]);
    clusters.splice(best.j, 1);
  }
}

/** Project a modest 2.4 m marker into CSS pixels, with readable but compact limits. */
export function portraitScreenSize(depth, viewportHeight, { fov = 38, zoom = 1 } = {}) {
  const pixels = Math.max(1, finite(viewportHeight, 1)) * 2.4 * Math.max(.01, finite(zoom, 1))
    / (2 * Math.tan(clamp(finite(fov, 38), 1, 179) * Math.PI / 360) * Math.max(.01, finite(depth, 10000)));
  return clamp(pixels, 14, 32);
}

/** Deterministic, small-group label layout. Anchors stay untouched for leader lines. */
export function layoutPortraitLabels(anchors, viewport, { gap = 6, padding = 4, anchorGap = 8, maxDisplacement = Infinity } = {}) {
  const width = Math.max(1, finite(viewport?.width, 1));
  const height = Math.max(1, finite(viewport?.height, 1));
  const edge = clamp(finite(padding, 4), 0, (Math.min(width, height) - 1) / 2);
  const spacing = Math.max(0, finite(gap, 6));
  const displacement = Math.max(0, finite(maxDisplacement, Infinity));
  const placed = [];
  const sorted = [...anchors].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  for (const anchor of sorted) {
    const w = clamp(finite(anchor.width, 42), 1, width - edge * 2);
    const h = clamp(finite(anchor.height, 60), 1, height - edge * 2);
    const anchorX = finite(anchor.x, width / 2);
    const anchorY = finite(anchor.y, height / 2);
    const maxX = width - edge - w;
    const maxY = height - edge - h;
    const initialX = clamp(anchorX - w / 2, edge, maxX);
    const initialY = clamp(anchorY - h - Math.max(0, finite(anchorGap, 8)), edge, maxY);
    // Existing rectangle edges give exact non-overlapping alternatives without
    // a pixel search, force simulation, animation state or input-order jitter.
    const xs = new Set([initialX, edge, maxX]);
    const ys = new Set([initialY, edge, maxY]);
    if (Number.isFinite(displacement)) {
      xs.add(clamp(initialX - displacement, edge, maxX));
      xs.add(clamp(initialX + displacement, edge, maxX));
      ys.add(clamp(initialY - displacement, edge, maxY));
      ys.add(clamp(initialY + displacement, edge, maxY));
    }
    for (const other of placed) {
      xs.add(clamp(other.left - w - spacing, edge, maxX));
      xs.add(clamp(other.left + other.width + spacing, edge, maxX));
      ys.add(clamp(other.top - h - spacing, edge, maxY));
      ys.add(clamp(other.top + other.height + spacing, edge, maxY));
    }
    let best = null;
    for (const left of xs) for (const top of ys) {
      if (Math.hypot(left - initialX, top - initialY) > displacement + 1e-6) continue;
      let overlap = 0;
      for (const other of placed) {
        const x = Math.max(0, Math.min(left + w + spacing, other.left + other.width + spacing)
          - Math.max(left, other.left));
        const y = Math.max(0, Math.min(top + h + spacing, other.top + other.height + spacing)
          - Math.max(top, other.top));
        overlap += x * y;
      }
      const distance = (left - initialX) ** 2 + (top - initialY) ** 2 * 1.2;
      const candidate = { left, top, overlap, distance };
      if (!best || overlap < best.overlap || (overlap === best.overlap && (distance < best.distance
        || (distance === best.distance && (top < best.top || (top === best.top && left < best.left)))))) {
        best = candidate;
      }
    }
    placed.push({ id: anchor.id, left: best.left, top: best.top, width: w, height: h, anchorX, anchorY });
  }
  return placed;
}
