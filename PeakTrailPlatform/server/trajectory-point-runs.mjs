// Wire/storage compression only. A run retains every actual sample timestamp;
// it is never a motion fit, an endpoint simplification or an invented sample.
export const MAX_EXPANDED_POINTS = Math.floor(64 * 1024 * 1024 / 72);
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const POSITION_LIMIT = 100_000_000;
function failure(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw failure(`${label}: integer out of range`);
  return value;
}
function samePosition(left, right) { return left[1] === right[1] && left[2] === right[2] && left[3] === right[3]; }

// Input is the validated v1 point list. Singleton/moving/irregular samples remain
// [t,x,y,z]; >=3 same-position, equal-step samples become [t,x,y,z,step,count].
export function encodePointRuns(points) {
  const encoded = [];
  for (let index = 0; index < points.length;) {
    const first = points[index];
    let count = 1, step = 0;
    if (index + 1 < points.length && samePosition(first, points[index + 1])) {
      step = points[index + 1][0] - first[0];
      if (step > 0) {
        count = 2;
        while (index + count < points.length && samePosition(first, points[index + count])
          && points[index + count][0] - points[index + count - 1][0] === step) count++;
      }
    }
    if (count >= 3) { encoded.push([...first, step, count]); index += count; }
    else { encoded.push(first); index++; }
  }
  return encoded;
}

export function encodeTrajectoryPointRuns(trajectory) {
  return { ...trajectory, format: "trajectory-v2", players: trajectory.players.map(player => ({ ...player, points: encodePointRuns(player.points) })) };
}

export function decodeTrajectoryPointRuns(encoded, { durationMs, maxPoints = Math.floor(durationMs / 100) + 1, checkBuckets = true,
  budget = { points: 0, maxPoints: MAX_EXPANDED_POINTS } } = {}) {
  integer(durationMs, 0, MAX_DURATION_MS, "point-run duration");
  integer(maxPoints, 0, MAX_EXPANDED_POINTS, "point-run limit");
  if (typeof checkBuckets !== "boolean") throw failure("point-run bucket check must be boolean");
  if (!budget || !Number.isSafeInteger(budget.points) || budget.points < 0 || !Number.isSafeInteger(budget.maxPoints)
    || budget.maxPoints < 0 || budget.maxPoints > MAX_EXPANDED_POINTS) throw failure("invalid point-run expansion budget");
  if (!Array.isArray(encoded) || encoded.length > maxPoints) throw failure("point-run encoded array exceeds limit", 413);
  // Validate the complete player and reserve its expansion budget before making
  // any expanded point arrays. Small malicious runs cannot allocate unbounded RAM.
  let expanded = 0, lastTime = -1, lastBucket = -1;
  for (const entry of encoded) {
    if (!Array.isArray(entry) || ![4, 6].includes(entry.length)) throw failure("point-run: [t,x,y,z] or [t,x,y,z,step,count] required");
    const start = integer(entry[0], 0, durationMs, "point-run start");
    for (let coordinate = 1; coordinate <= 3; coordinate++) integer(entry[coordinate], -POSITION_LIMIT, POSITION_LIMIT, "position cm");
    const count = entry.length === 6 ? integer(entry[5], 3, Number.MAX_SAFE_INTEGER, "point-run count") : 1;
    if (count > maxPoints) throw failure("point-run expanded point limit exceeded", 413);
    const step = entry.length === 6 ? integer(entry[4], 1, durationMs, "point-run step") : 0;
    const end = start + step * (count - 1);
    if (!Number.isSafeInteger(end) || end > durationMs) throw failure("point-run end exceeds duration");
    if (expanded + count > maxPoints || budget.points + expanded + count > budget.maxPoints) throw failure("point-run expanded point limit exceeded", 413);
    for (let index = 0; index < count; index++) {
      const time = start + index * step, bucket = Math.floor(time / 100);
      if (time <= lastTime || checkBuckets && bucket === lastBucket) throw failure("points must be ordered and at most one per 100ms bucket");
      lastTime = time; lastBucket = bucket;
    }
    expanded += count;
  }
  budget.points += expanded;
  const points = new Array(expanded);
  let offset = 0;
  for (const entry of encoded) {
    const count = entry.length === 6 ? entry[5] : 1;
    const step = entry.length === 6 ? entry[4] : 0;
    for (let index = 0; index < count; index++) points[offset++] = [entry[0] + index * step, entry[1], entry[2], entry[3]];
  }
  return points;
}
