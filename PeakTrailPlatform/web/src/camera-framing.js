const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const validPoint = (point) => Array.isArray(point) && point.length >= 3
  && point.slice(0, 3).every(Number.isFinite);

function normalized(vector) {
  const length = Math.hypot(...vector);
  return length > 0 && Number.isFinite(length) ? vector.map((value) => value / length) : null;
}

const OVERVIEW_DIRECTION = [0.52, 0.85, 0.62];
const OVERVIEW_AZIMUTH = Math.atan2(OVERVIEW_DIRECTION[0], OVERVIEW_DIRECTION[2]);
const OVERVIEW_PITCH = Math.atan2(OVERVIEW_DIRECTION[1], Math.hypot(OVERVIEW_DIRECTION[0], OVERVIEW_DIRECTION[2]));
const radians = (degrees) => degrees * Math.PI / 180;

function polygonArea(points) {
  const ordered = points.filter(Boolean).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (values) => {
    const result = [];
    for (const point of values) {
      while (result.length > 1 && cross2(result.at(-2), result.at(-1), point) <= 0) result.pop();
      result.push(point);
    }
    result.pop();
    return result;
  };
  const hull = [...half(ordered), ...half(ordered.slice().reverse())];
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const next = hull[(i + 1) % hull.length];
    area += hull[i][0] * next[1] - next[0] * hull[i][1];
  }
  return Math.abs(area) / 2;
}

/**
 * Choose a readable front-side overview without changing its subject. All points
 * participate in the direction comparison and must still go through the exact
 * fit below afterwards. Pitch never changes; cameras stay within 50 degrees of
 * rendered +Z (the approach to the mountain), rather than turning behind it or
 * looking vertically down just to obtain a short camera distance.
 *
 * Each candidate uses two linear scans, not the exact fit's iterative centering.
 * Its score uses projected silhouette area and depth legibility, not distance.
 * Eight screen-space support directions bound the scoring cost independently of
 * mesh count. They only approximate the score; they never replace fitting points.
 */
export function chooseOverviewDirection(points, {
  aspect = 1, fov = 38, padding = 1.02, minDistance = 25,
  frame = { left: -1, right: 1, bottom: -1, top: 1 },
} = {}) {
  const fallback = () => OVERVIEW_DIRECTION.slice();
  if (!Array.isArray(points) || points.length < 3 || !points.every(validPoint)
      || !Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(fov) || fov <= 0 || fov >= 180
      || !Number.isFinite(padding) || padding < 1 || !Number.isFinite(minDistance) || minDistance < 0
      || !frame || typeof frame !== "object" || Array.isArray(frame)
      || ![frame.left, frame.right, frame.bottom, frame.top].every(Number.isFinite)
      || frame.left < -1 || frame.right > 1 || frame.left >= frame.right
      || frame.bottom < -1 || frame.top > 1 || frame.bottom >= frame.top) return fallback();

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
  }
  const center = min.map((value, axis) => value / 2 + max[axis] / 2);
  let xSum = 0, zSum = 0, xx = 0, zz = 0, xz = 0;
  for (const point of points) {
    const x = point[0] - center[0], z = point[2] - center[2];
    xSum += x; zSum += z; xx += x * x; zz += z * z; xz += x * z;
  }
  xx -= xSum * xSum / points.length; zz -= zSum * zSum / points.length; xz -= xSum * zSum / points.length;
  const difference = Math.hypot(xx - zz, 2 * xz), major = (xx + zz + difference) / 2;
  const minor = Math.max(0, (xx + zz - difference) / 2);
  // Round courtyards and slender vertical towers have no reliable horizontal
  // route axis. Keep their established viewpoint rather than rotating on noise.
  if (!(major > 0) || !Number.isFinite(major) || major < minor * 1.6) return fallback();
  const axisAngle = Math.atan2(2 * xz, xx - zz) / 2;
  let axisX = Math.cos(axisAngle), axisZ = Math.sin(axisAngle);
  if (axisZ < 0) { axisX = -axisX; axisZ = -axisZ; }
  const routeAzimuth = Math.atan2(axisX, axisZ);
  const candidates = [OVERVIEW_AZIMUTH, ...[0, 15, 25, 35, 50].map(radians),
    routeAzimuth - radians(25), routeAzimuth + radians(25)];
  const unique = candidates.filter((angle, index) => Number.isFinite(angle) && angle >= 0 && angle <= radians(50)
    && candidates.findIndex((other) => Math.abs(other - angle) < radians(0.1)) === index);
  const tanV = Math.tan(fov * Math.PI / 360), tanH = tanV * aspect;
  if (!(tanV > 0 && tanH > 0 && Number.isFinite(tanH))) return fallback();
  const paddedV = tanV / padding, paddedH = tanH / padding;
  const midpointX = (frame.left + frame.right) / 2, midpointY = (frame.bottom + frame.top) / 2;
  const left = frame.left + midpointX * (padding - 1), right = frame.right + midpointX * (padding - 1);
  const bottom = frame.bottom + midpointY * (padding - 1), top = frame.top + midpointY * (padding - 1);
  const sinPitch = Math.sin(OVERVIEW_PITCH), cosPitch = Math.cos(OVERVIEW_PITCH);

  const score = (azimuth) => {
    const sin = Math.sin(azimuth), cos = Math.cos(azimuth);
    let hLower = -Infinity, hUpper = Infinity, vLower = -Infinity, vUpper = Infinity;
    let nearZ = -Infinity, farZ = Infinity;
    for (const point of points) {
      const x = point[0] - center[0], y = point[1] - center[1], z = point[2] - center[2];
      const horizontal = x * cos - z * sin;
      const vertical = y * cosPitch - (x * sin + z * cos) * sinPitch;
      const depth = y * sinPitch + (x * sin + z * cos) * cosPitch;
      hLower = Math.max(hLower, horizontal + right * paddedH * depth);
      hUpper = Math.min(hUpper, horizontal + left * paddedH * depth);
      vLower = Math.max(vLower, vertical + top * paddedV * depth);
      vUpper = Math.min(vUpper, vertical + bottom * paddedV * depth);
      nearZ = Math.max(nearZ, depth); farZ = Math.min(farZ, depth);
    }
    const distance = Math.max(minDistance, nearZ + Math.max(0.1, Math.abs(nearZ) * 1e-10),
      (hLower - hUpper) / ((right - left) * paddedH), (vLower - vUpper) / ((top - bottom) * paddedV)) * (1 + 1e-12);
    if (!Number.isFinite(distance)) return -Infinity;
    const shiftX = (hLower + hUpper - (right + left) * paddedH * distance) / 2;
    const shiftY = (vLower + vUpper - (top + bottom) * paddedV * distance) / 2;
    const supports = Array(8).fill(-Infinity), outline = Array(8), directions = Array(8);
    for (const point of points) {
      const x = point[0] - center[0], y = point[1] - center[1], z = point[2] - center[2];
      const depth = distance - y * sinPitch - (x * sin + z * cos) * cosPitch;
      const u = (x * cos - z * sin - shiftX) / (depth * tanH);
      const v = (y * cosPitch - (x * sin + z * cos) * sinPitch - shiftY) / (depth * tanV);
      directions[0] = u; directions[1] = u + v; directions[2] = v; directions[3] = v - u;
      directions[4] = -u; directions[5] = -u - v; directions[6] = -v; directions[7] = u - v;
      for (let axis = 0; axis < 8; axis++) if (directions[axis] > supports[axis]) {
        supports[axis] = directions[axis]; outline[axis] = [u, v];
      }
    }
    // A large near foreground must not win merely by making the far end tiny.
    const depthLegibility = Math.sqrt((distance - nearZ) / (distance - farZ));
    return polygonArea(outline) * depthLegibility;
  };

  const baselineScore = score(OVERVIEW_AZIMUTH);
  let selected = OVERVIEW_AZIMUTH, bestScore = baselineScore;
  for (const azimuth of unique) {
    if (azimuth === OVERVIEW_AZIMUTH) continue;
    // Avoid aiming straight down a long corridor/route even when that happens
    // to shorten its projection. The existing viewpoint is always an option.
    const axisAlignment = Math.abs(axisX * Math.sin(azimuth) + axisZ * Math.cos(azimuth));
    if (axisAlignment > Math.cos(radians(20)) && azimuth !== OVERVIEW_AZIMUTH) continue;
    const candidateScore = score(azimuth);
    if (candidateScore > bestScore) { selected = azimuth; bestScore = candidateScore; }
  }
  // Insignificant numerical/viewport changes should not rotate an already good
  // overview. The caller still preserves any manually moved camera separately.
  if (!(bestScore > baselineScore * 1.03)) return fallback();
  return [Math.sin(selected) * cosPitch, sinPitch, Math.cos(selected) * cosPitch];
}

// Center the projected extrema, accounting for each point's individual depth.
function projectedCenter(points, axis, distance, min, max, center = 0) {
  if (center !== 0) {
    min = Infinity; max = -Infinity;
    for (const point of points) {
      const adjusted = point[axis] - center * (distance - point[2]);
      min = Math.min(min, adjusted); max = Math.max(max, adjusted);
    }
  }
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const shift = min / 2 + max / 2;
    let projectedMin = Infinity, projectedMax = -Infinity;
    for (const point of points) {
      const projected = (point[axis] - shift) / (distance - point[2]) - center;
      projectedMin = Math.min(projectedMin, projected);
      projectedMax = Math.max(projectedMax, projected);
    }
    if (projectedMin + projectedMax > 0) min = shift;
    else max = shift;
  }
  return min / 2 + max / 2;
}

/**
 * Fit rendered XYZ points into a perspective camera. Direction points from the
 * target toward the camera. The optional NDC frame reserves an asymmetric screen
 * region; padding contracts that region around its midpoint on both axes.
 * Coordinate conversion belongs to the caller so this also handles height scale.
 */
export function fitPerspectivePoints(points, {
  aspect = 1, fov = 38, direction = [0.52, 0.85, 0.62], up = [0, 1, 0],
  padding = 1.14, minDistance = 25, frame = { left: -1, right: 1, bottom: -1, top: 1 },
} = {}) {
  if (!Array.isArray(points) || !points.length || !points.every(validPoint)
    || !validPoint(direction) || !validPoint(up)
    || !Number.isFinite(aspect) || aspect <= 0
    || !Number.isFinite(fov) || fov <= 0 || fov >= 180
    || !Number.isFinite(padding) || padding < 1
    || !Number.isFinite(minDistance) || minDistance < 0) return null;
  if (!frame || typeof frame !== "object" || Array.isArray(frame)
    || ![frame.left, frame.right, frame.bottom, frame.top].every(Number.isFinite)
    || frame.left < -1 || frame.left >= frame.right || frame.right > 1
    || frame.bottom < -1 || frame.bottom >= frame.top || frame.top > 1) return null;

  const back = normalized(direction.slice(0, 3));
  const requestedUp = normalized(up.slice(0, 3));
  if (!back || !requestedUp) return null;
  const right = normalized(cross(requestedUp, back));
  if (!right) return null;
  const cameraUp = normalized(cross(back, right));
  const tanV = Math.tan(fov * Math.PI / 360) / padding;
  const tanH = tanV * aspect;
  if (!(tanV > 0 && tanH > 0 && Number.isFinite(tanH))) return null;
  const midpointX = (frame.left + frame.right) / 2, midpointY = (frame.bottom + frame.top) / 2;
  // tanH/V already contain padding. Preserve the requested frame's midpoint
  // while shrinking only its width and height, including asymmetric frames.
  const left = frame.left + midpointX * (padding - 1), rightEdge = frame.right + midpointX * (padding - 1);
  const bottom = frame.bottom + midpointY * (padding - 1), top = frame.top + midpointY * (padding - 1);

  const worldMin = [Infinity, Infinity, Infinity];
  const worldMax = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      worldMin[axis] = Math.min(worldMin[axis], point[axis]);
      worldMax[axis] = Math.max(worldMax[axis], point[axis]);
    }
  }
  const center = worldMin.map((value, axis) => value / 2 + worldMax[axis] / 2);
  const local = points.map((point) => {
    const relative = center.map((value, axis) => point[axis] - value);
    return [dot(relative, right), dot(relative, cameraUp), dot(relative, back)];
  });
  if (!local.every(validPoint)) return null;

  let horizontalLower = -Infinity, horizontalUpper = Infinity;
  let verticalLower = -Infinity, verticalUpper = Infinity;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of local) {
    horizontalLower = Math.max(horizontalLower, x + rightEdge * tanH * z);
    horizontalUpper = Math.min(horizontalUpper, x + left * tanH * z);
    verticalLower = Math.max(verticalLower, y + top * tanV * z);
    verticalUpper = Math.min(verticalUpper, y + bottom * tanV * z);
    for (const [axis, value] of [x, y, z].entries()) {
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  // For depth d-z, each axis permits an interval of lateral camera positions.
  // Its lower and upper limits meet at this minimum feasible distance.
  const depthMargin = Math.max(0.1, Math.abs(max[2]) * 1e-10);
  const distance = Math.max(minDistance, max[2] + depthMargin,
    (horizontalLower - horizontalUpper) / ((rightEdge - left) * tanH),
    (verticalLower - verticalUpper) / ((top - bottom) * tanV)) * (1 + 1e-12);
  if (!Number.isFinite(distance)) return null;

  const shiftX = projectedCenter(local, 0, distance, min[0], max[0], midpointX * padding * tanH);
  const shiftY = projectedCenter(local, 1, distance, min[1], max[1], midpointY * padding * tanV);
  const target = center.map((value, axis) => value + right[axis] * shiftX + cameraUp[axis] * shiftY);
  const position = target.map((value, axis) => value + back[axis] * distance);
  const near = Math.max(0.01, (distance - max[2]) * 0.25);
  const far = Math.max(near + 1, (distance - min[2]) * 1.25);
  if (!validPoint(target) || !validPoint(position) || !Number.isFinite(near) || !Number.isFinite(far)) return null;
  return { position, target, up: cameraUp, distance, near, far };
}
