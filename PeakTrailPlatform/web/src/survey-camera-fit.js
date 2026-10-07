const finiteVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(value) {
  if (!finiteVector(value)) return null;
  const maximum = Math.max(...value.map(Math.abs));
  if (!maximum) return null;
  const scaled = value.map(part => part / maximum), length = Math.hypot(...scaled);
  return scaled.map(part => part / length);
}

/** Fit a perspective camera to source Unity world bounds, without moving the model.
 * direction points from target to camera in the displayed, Z-mirrored space.
 * padding is an angular margin: 1.08 keeps every corner within 1 / 1.08 of
 * either frustum edge. Returned up retains the reference orbit axis.
 */
export function fitSurveyCamera(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { bounds, origin = [0, 0, 0], heightScale = 1, aspect,
    verticalFovDegrees = 45, direction = [.52, .7, .62], up = [0, 1, 0], padding = 1.08 } = input;
  if (!bounds || !finiteVector(bounds.min) || !finiteVector(bounds.max)
    || bounds.min.some((value, axis) => value > bounds.max[axis]) || !finiteVector(origin)
    || !Number.isFinite(heightScale) || heightScale <= 0 || !Number.isFinite(aspect) || aspect <= 0
    || !Number.isFinite(verticalFovDegrees) || verticalFovDegrees <= 0 || verticalFovDegrees >= 180
    || !Number.isFinite(padding) || padding < 1) return null;
  const outward = unit(direction), referenceUp = unit(up);
  if (!outward || !referenceUp) return null;
  const forward = outward.map(value => -value), rightRaw = cross(forward, referenceUp);
  if (Math.hypot(...rightRaw) < 1e-8) return null;
  const right = unit(rightRaw), cameraUp = cross(right, forward);
  const size = bounds.max.map((value, axis) => value - bounds.min[axis]);
  const center = bounds.min.map((value, axis) => value + size[axis] / 2);
  const display = value => [value[0] - origin[0], (value[1] - origin[1]) * heightScale, -(value[2] - origin[2])];
  const target = display(center), tangentV = Math.tan(verticalFovDegrees * Math.PI / 360), tangentH = tangentV * aspect;
  if (!finiteVector(target) || !size.every(Number.isFinite) || !Number.isFinite(tangentH) || tangentH <= 0) return null;
  // Relative corners avoid cancellation when a scene uses a large world origin.
  const halfSize = [size[0] / 2, size[1] * heightScale / 2, size[2] / 2];
  const diagonal = 2 * Math.hypot(...halfSize), clearance = Math.max(.01, diagonal * 1e-6);
  const corners = [];
  let distance = 1;
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const corner = [x * halfSize[0], y * halfSize[1], -z * halfSize[2]];
    const outwardOffset = dot(corner, outward);
    distance = Math.max(distance, outwardOffset + clearance,
      outwardOffset + padding * Math.abs(dot(corner, right)) / tangentH,
      outwardOffset + padding * Math.abs(dot(corner, cameraUp)) / tangentV);
    corners.push(corner);
  }
  const depths = corners.map(corner => distance - dot(corner, outward));
  const near = Math.min(Math.max(.01, distance / 10000), Math.min(...depths) / 4);
  const minDistance = Math.max(.05, Math.min(2, distance / 100, diagonal / 100));
  const maxDistance = Math.max(20, distance * 4, diagonal * 4);
  // Cover the full bounding sphere even after orbiting to the allowed zoom-out.
  const far = Math.max(100, maxDistance + diagonal, Math.max(...depths) * 1.5);
  const position = target.map((value, axis) => value + outward[axis] * distance);
  if (!finiteVector(position) || ![distance, near, far, minDistance, maxDistance].every(Number.isFinite)
    || near <= 0 || far <= near) return null;
  return { target, position, distance, near, far, minDistance, maxDistance, up: referenceUp };
}
