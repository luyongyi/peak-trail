const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const GROUP_RADIUS_METERS = 10;

/** Transitive world-space clustering of `{ id, pos:[x,y,z] }` entries: players within
 * `radius` metres of a chain-mate share one badge (A–B 9 m, B–C 9 m groups all
 * three). Screen distance is never used — "10米" describes the recorded mountain,
 * not the current camera. Entries without a finite position become their own
 * cluster so a broken sample cannot swallow other players' labels. */
export function clusterPlayerEntries(entries, radius = GROUP_RADIUS_METERS) {
  const valid = [];
  const clusters = [];
  for (const entry of entries || []) {
    const pos = Array.isArray(entry?.pos) && entry.pos.length === 3
      && entry.pos.every((value) => Number.isFinite(value)) ? entry.pos : null;
    if (pos) valid.push({ entry, pos });
    else clusters.push([entry]);
  }
  const parent = valid.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  const limit = Math.max(0, finite(radius, GROUP_RADIUS_METERS));
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      if (find(i) === find(j)) continue;
      const [ax, ay, az] = valid[i].pos;
      const [bx, by, bz] = valid[j].pos;
      if (Math.hypot(ax - bx, ay - by, az - bz) <= limit) parent[find(j)] = find(i);
    }
  }
  const grouped = new Map();
  for (let index = 0; index < valid.length; index += 1) {
    const root = find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(valid[index].entry);
  }
  return [...grouped.values(), ...clusters];
}

/** Deterministic, small-group label layout. Anchors stay untouched for leader lines. */
export function layoutPortraitLabels(anchors, viewport, { gap = 6, padding = 4 } = {}) {
  const width = Math.max(1, finite(viewport?.width, 1));
  const height = Math.max(1, finite(viewport?.height, 1));
  const edge = clamp(finite(padding, 4), 0, (Math.min(width, height) - 1) / 2);
  const spacing = Math.max(0, finite(gap, 6));
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
    const initialY = clamp(anchorY - h - 8, edge, maxY);
    // Existing rectangle edges give exact non-overlapping alternatives without
    // a pixel search, force simulation, animation state or input-order jitter.
    const xs = new Set([initialX, edge, maxX]);
    const ys = new Set([initialY, edge, maxY]);
    for (const other of placed) {
      xs.add(clamp(other.left - w - spacing, edge, maxX));
      xs.add(clamp(other.left + other.width + spacing, edge, maxX));
      ys.add(clamp(other.top - h - spacing, edge, maxY));
      ys.add(clamp(other.top + other.height + spacing, edge, maxY));
    }
    let best = null;
    for (const left of xs) for (const top of ys) {
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
