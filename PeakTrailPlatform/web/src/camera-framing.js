const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const validPoint = (point) => Array.isArray(point) && point.length >= 3
  && point.slice(0, 3).every(Number.isFinite);

function normalized(vector) {
  const length = Math.hypot(...vector);
  return length > 0 && Number.isFinite(length) ? vector.map((value) => value / length) : null;
}

// Center the projected extrema, accounting for each point's individual depth.
function projectedCenter(points, axis, distance, min, max) {
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const shift = min / 2 + max / 2;
    let projectedMin = Infinity, projectedMax = -Infinity;
    for (const point of points) {
      const projected = (point[axis] - shift) / (distance - point[2]);
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
 * target toward the camera; padding reserves the same screen margin on both axes.
 * Coordinate conversion belongs to the caller so this also handles height scale.
 */
export function fitPerspectivePoints(points, {
  aspect = 1, fov = 38, direction = [0.52, 0.85, 0.62], up = [0, 1, 0],
  padding = 1.14, minDistance = 25,
} = {}) {
  if (!Array.isArray(points) || !points.length || !points.every(validPoint)
    || !validPoint(direction) || !validPoint(up)
    || !Number.isFinite(aspect) || aspect <= 0
    || !Number.isFinite(fov) || fov <= 0 || fov >= 180
    || !Number.isFinite(padding) || padding < 1
    || !Number.isFinite(minDistance) || minDistance < 0) return null;

  const back = normalized(direction.slice(0, 3));
  const requestedUp = normalized(up.slice(0, 3));
  if (!back || !requestedUp) return null;
  const right = normalized(cross(requestedUp, back));
  if (!right) return null;
  const cameraUp = normalized(cross(back, right));
  const tanV = Math.tan(fov * Math.PI / 360) / padding;
  const tanH = tanV * aspect;
  if (!(tanV > 0 && tanH > 0 && Number.isFinite(tanH))) return null;

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
    horizontalLower = Math.max(horizontalLower, x + tanH * z);
    horizontalUpper = Math.min(horizontalUpper, x - tanH * z);
    verticalLower = Math.max(verticalLower, y + tanV * z);
    verticalUpper = Math.min(verticalUpper, y - tanV * z);
    for (const [axis, value] of [x, y, z].entries()) {
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  // For depth d-z, each axis permits an interval of lateral camera positions.
  // Its lower and upper limits meet at this minimum feasible distance.
  const depthMargin = Math.max(0.1, Math.abs(max[2]) * 1e-10);
  const distance = Math.max(minDistance, max[2] + depthMargin,
    (horizontalLower - horizontalUpper) / (2 * tanH),
    (verticalLower - verticalUpper) / (2 * tanV)) * (1 + 1e-12);
  if (!Number.isFinite(distance)) return null;

  const shiftX = projectedCenter(local, 0, distance, min[0], max[0]);
  const shiftY = projectedCenter(local, 1, distance, min[1], max[1]);
  const target = center.map((value, axis) => value + right[axis] * shiftX + cameraUp[axis] * shiftY);
  const position = target.map((value, axis) => value + back[axis] * distance);
  const near = Math.max(0.01, (distance - max[2]) * 0.25);
  const far = Math.max(near + 1, (distance - min[2]) * 1.25);
  if (!validPoint(target) || !validPoint(position) || !Number.isFinite(near) || !Number.isFinite(far)) return null;
  return { position, target, up: cameraUp, distance, near, far };
}
