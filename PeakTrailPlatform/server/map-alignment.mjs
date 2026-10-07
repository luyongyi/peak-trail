// Landmark evidence is independent of a player's route. Never infer a map
// transform from spawn positions, route extents, dates, or a layout hash alone.
const KIND = new Set(["segment-root", "progress-point"]);
const MAX_ERROR_CM = 5;
function invalid(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }
function object(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label}: object required`);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid(`${label}: unexpected or missing field`);
}
function numbers(value, size, label, integer = false, limit = 100_000_000) {
  if (!Array.isArray(value) || value.length !== size || value.some(v => !Number.isFinite(v) || Math.abs(v) > limit || integer && !Number.isSafeInteger(v))) invalid(`${label}: invalid coordinates`);
  return [...value];
}
export function validateMapAlignment(raw) {
  object(raw, ["version", "coordinateSpace", "landmarks"], ["version", "coordinateSpace", "landmarks"], "map.alignment");
  if (raw.version !== 1 || raw.coordinateSpace !== "unity-world-cm" || !Array.isArray(raw.landmarks) || raw.landmarks.length > 16) invalid("map.alignment: unsupported evidence");
  const keys = new Set();
  const landmarks = raw.landmarks.map(item => {
    object(item, ["key", "kind", "stageIndex", "name", "positionCm", "rotation", "scale"], ["key", "kind", "name", "positionCm"], "landmark");
    if (!KIND.has(item.kind) || typeof item.name !== "string" || !item.name.length || item.name.length > 120 || /[\u0000-\u001f]/u.test(item.name)) invalid("landmark: invalid native identity");
    const peak = item.kind === "progress-point" && item.key === "progress-point:peak";
    if (peak ? Object.hasOwn(item, "stageIndex") : !Number.isInteger(item.stageIndex) || item.stageIndex < 0 || item.stageIndex > 15 || item.key !== `${item.kind}:${item.stageIndex}`) invalid("landmark: key and native stage disagree");
    if (keys.has(item.key)) invalid("landmark: duplicate key");
    keys.add(item.key);
    const result = { key: item.key, kind: item.kind, name: item.name, positionCm: numbers(item.positionCm, 3, "landmark.positionCm", true) };
    if (!peak) result.stageIndex = item.stageIndex;
    if (item.kind === "segment-root") {
      result.rotation = numbers(item.rotation, 4, "landmark.rotation", false, 1.001);
      if (Math.abs(Math.hypot(...result.rotation) - 1) > .001) invalid("landmark: rotation must be a unit quaternion");
      result.scale = numbers(item.scale, 3, "landmark.scale", false, 10000);
      if (result.scale.some(v => Math.abs(v) < 1e-6)) invalid("landmark: zero scale");
    } else if (Object.hasOwn(item, "rotation") || Object.hasOwn(item, "scale")) invalid("progress landmark: root transform fields forbidden");
    return result;
  }).sort((a, b) => a.key.localeCompare(b.key));
  return { version: 1, coordinateSpace: "unity-world-cm", landmarks };
}
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const length2 = v => dot(v, v);
function dispersed(points) {
  let pair = null, maximum = 0;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const distance = length2(subtract(points[j], points[i]));
    if (distance > maximum) { maximum = distance; pair = [i, j]; }
  }
  if (!pair || maximum < 1000 ** 2) return false;
  const [a, b] = pair, axis = subtract(points[b], points[a]);
  return points.some(p => { const delta = subtract(p, points[a]); return length2(delta) - dot(delta, axis) ** 2 / maximum >= 100 ** 2; });
}
function largestEigenvector(matrix) {
  const a = matrix.map(row => [...row]), vectors = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => Number(i === j)));
  // Jacobi diagonalization avoids power iteration selecting an eigenvalue by
  // magnitude instead of Horn's largest algebraic eigenvalue.
  for (let sweep = 0; sweep < 80; sweep++) {
    let p = 0, q = 1, largest = 0;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (Math.abs(a[i][j]) > largest) { largest = Math.abs(a[i][j]); p = i; q = j; }
    if (largest <= Math.max(1, ...a.map((row, i) => Math.abs(row[i]))) * 1e-13) break;
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    for (let k = 0; k < 4; k++) if (k !== p && k !== q) {
      const x = a[k][p], y = a[k][q]; a[k][p] = a[p][k] = c * x - s * y; a[k][q] = a[q][k] = s * x + c * y;
    }
    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 4; k++) { const x = vectors[k][p], y = vectors[k][q]; vectors[k][p] = c * x - s * y; vectors[k][q] = s * x + c * y; }
  }
  const index = a.reduce((best, row, i) => row[i] > a[best][best] ? i : best, 0);
  return vectors.map(row => row[index]);
}
const quaternionMultiply = (a, b) => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
const unitQuaternion = value => value.map(part => part / Math.hypot(...value));
const rotate = (rotation, point) => [0, 1, 2].map(row => rotation.slice(row * 3, row * 3 + 3).reduce((sum, value, column) => sum + value * point[column], 0));
export function fitMapAlignment(recorded, canonical) {
  let actual, source;
  try { actual = validateMapAlignment(recorded); source = validateMapAlignment(canonical); }
  catch { return { status: "pending", reason: "invalid-landmarks" }; }
  if (actual.landmarks.length < 3 || source.landmarks.length < 3) return { status: "pending", reason: "insufficient-landmarks" };
  if (actual.landmarks.length !== source.landmarks.length) return { status: "pending", reason: "landmark-identity-mismatch" };
  const pairs = actual.landmarks.map((item, i) => [item, source.landmarks[i]]);
  if (pairs.some(([a, b]) => a.key !== b.key || a.kind !== b.kind || a.name !== b.name || a.stageIndex !== b.stageIndex)) return { status: "pending", reason: "landmark-identity-mismatch" };
  const p = pairs.map(([a]) => a.positionCm), q = pairs.map(([, b]) => b.positionCm);
  if (!dispersed(p) || !dispersed(q)) return { status: "pending", reason: "landmarks-not-dispersed" };
  const centroid = points => [0, 1, 2].map(axis => points.reduce((sum, value) => sum + value[axis], 0) / points.length);
  const pc = centroid(p), qc = centroid(q), h = Array.from({ length: 3 }, () => [0, 0, 0]);
  p.forEach((value, i) => { const a = subtract(value, pc), b = subtract(q[i], qc); for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) h[row][col] += a[row] * b[col]; });
  const [[xx,xy,xz],[yx,yy,yz],[zx,zy,zz]] = h;
  const [w,x,y,z] = largestEigenvector([[xx+yy+zz,yz-zy,zx-xz,xy-yx],[yz-zy,xx-yy-zz,xy+yx,zx+xz],[zx-xz,xy+yx,-xx+yy-zz,yz+zy],[xy-yx,zx+xz,yz+zy,-xx-yy+zz]]);
  const rotation = [1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)];
  const translationCm = subtract(qc, rotate(rotation, pc));
  const maxErrorCm = Math.max(...p.map((value, i) => Math.hypot(...subtract(rotate(rotation, value).map((v, axis) => v + translationCm[axis]), q[i]))));
  if (!Number.isFinite(maxErrorCm) || maxErrorCm > MAX_ERROR_CM) return { status: "pending", reason: "non-rigid-layout" };
  if (pairs.some(([a, b]) => a.kind === "segment-root" && (a.scale.some((value, axis) => Math.abs(value - b.scale[axis]) > Math.max(1e-5, Math.abs(b.scale[axis]) * 1e-4))
    || Math.abs(dot(quaternionMultiply([x,y,z,w], unitQuaternion(a.rotation)), unitQuaternion(b.rotation))) < Math.cos(.1 * Math.PI / 360)))) return { status: "pending", reason: "root-transform-mismatch" };
  const identity = rotation.every((value, index) => Math.abs(value - Number(index % 4 === 0)) < 1e-7) && translationCm.every(value => Math.abs(value) < .01);
  return { status: "verified", method: identity ? "identity" : "rigid", landmarkCount: pairs.length, maxErrorCm, transform: { rotation, translationCm } };
}
export function alignedRoutePoints(points, alignment) {
  if (alignment?.status !== "verified") return points;
  const { rotation, translationCm } = alignment.transform;
  return points.map(point => [point[0], ...rotate(rotation, point.slice(1)).map((value, axis) => Math.round(value + translationCm[axis]))]);
}
