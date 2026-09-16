function position(value) {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite);
}

function normalizeBounds(value) {
  if (!value || typeof value !== "object") return null;
  const min = Array.isArray(value.min) ? value.min.slice(0, 3) : [value.minX, value.minY, value.minZ];
  const max = Array.isArray(value.max) ? value.max.slice(0, 3) : [value.maxX, value.maxY, value.maxZ];
  return position(min) && position(max) && min.every((coordinate, axis) => coordinate <= max[axis])
    ? { min, max } : null;
}

/** A spatial display filter, not evidence that a participant owns a chapter. */
export function pointInBounds(pos, bounds) {
  if (!position(pos)) return false;
  if (bounds === null || bounds === undefined) return true;
  const normalized = normalizeBounds(bounds);
  return Boolean(normalized && normalized.min.every((min, axis) => pos[axis] >= min && pos[axis] <= normalized.max[axis]));
}

function interpolate(left, right, ratio) {
  // Preserve exact recorded endpoints at 0 and 1 rather than introducing a
  // rounding difference through subtract/add arithmetic.
  if (ratio === 0) return left;
  if (ratio === 1) return right;
  return left + (right - left) * ratio;
}

/**
 * Clip one already continuity-checked XYZ trail edge to a selected layer's
 * spatial bounds. segment/activeSegment never participate: old and remote
 * players' shared progression must not be mistaken for their actual location.
 * startT/endT identify the clipped positions; visibleAt retains the ORIGINAL
 * end-sample time so clipping cannot reveal a future edge ahead of its sample.
 * No coordinate projection, floor snapping or height offset is performed.
 */
export function clipTrailSegment(start, end, bounds) {
  if (!position(start?.pos) || !position(end?.pos) || !Number.isFinite(start.t)
      || !Number.isFinite(end.t) || start.t < 0 || end.t < start.t) return null;
  let enter = 0;
  let exit = 1;
  if (bounds !== null && bounds !== undefined) {
    const normalized = normalizeBounds(bounds);
    if (!normalized) return null;
    for (let axis = 0; axis < 3; axis++) {
      const from = start.pos[axis];
      const delta = end.pos[axis] - from;
      const min = normalized.min[axis];
      const max = normalized.max[axis];
      if (delta === 0) {
        if (from < min || from > max) return null;
        continue;
      }
      const a = (min - from) / delta;
      const b = (max - from) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return null;
    }
  }
  const startPos = start.pos.slice(0, 3).map((value, axis) => interpolate(value, end.pos[axis], enter));
  const endPos = start.pos.slice(0, 3).map((value, axis) => interpolate(value, end.pos[axis], exit));
  // A corner touch or a stationary heartbeat has no drawable line length.
  if (startPos.every((value, axis) => value === endPos[axis])) return null;
  return { startPos, endPos,
    startT: interpolate(start.t, end.t, enter), endT: interpolate(start.t, end.t, exit),
    visibleAt: end.t };
}
