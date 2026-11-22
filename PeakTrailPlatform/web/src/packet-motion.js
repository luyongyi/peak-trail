// The live camera needs only the latest poses. Keep them outside the route,
// inventory and chapter histories, which also serve the two-minute scrubber.
const KEEP_SECONDS = 5;
const MAX_INTERPOLATION_GAP = 0.18;
const SMOOTH_SECONDS = 0.035;

function upperBound(samples, t) {
  let low = 0, high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].t <= t) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function appendPacketMotion(trace, { reset, samples }) {
  if (reset) delete trace.packetMotion;
  if (!samples.length && !trace.packetMotion) return;
  const players = trace.packetMotion ??= new Map();
  let latest = trace.duration;
  for (const sample of samples) {
    let player = players.get(sample.playerId);
    if (!player) players.set(sample.playerId, player = { extra: [], poses: [] });
    player.extra.push(sample);
    latest = Math.max(latest, sample.t);
  }
  for (const [id, player] of players) {
    const cutoff = latest - KEEP_SECONDS;
    player.extra = player.extra.filter(sample => sample.t >= cutoff);
    if (!player.extra.length) { players.delete(id); continue; }
    const track = trace.tracks.get(id) || [];
    const regular = track.slice(Math.max(0, upperBound(track, cutoff) - 1));
    // Prefer a regular sample when both sources have the same capture time.
    const sorted = player.extra.concat(regular).sort((a, b) => a.t - b.t);
    player.poses = sorted.filter((point, i) => point.t !== sorted[i + 1]?.t);
  }
}

function continuous(a, b, blockingEvents) {
  return b.t - a.t <= MAX_INTERPOLATION_GAP && a.activeSegment === b.activeSegment &&
    Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) <= 20 &&
    !blockingEvents.some(event => event.t > a.t && event.t <= b.t);
}

// Keep the ordinary sample's telemetry and spatial layer. Only the marker
// position and heading are evaluated at the higher rate.
export function packetPoseAt(poses, t, sample, blockingEvents) {
  if (!sample || t < poses[0].t || t > poses.at(-1).t) return sample;
  const next = upperBound(poses, t);
  const a = poses[next - 1], b = poses[next];
  if (sample.activeSegment !== a.activeSegment) return sample;
  const result = { ...sample, t: a.t, pos: a.pos, yaw: a.yaw };
  if (!b || !continuous(a, b, blockingEvents)) return result;
  const alpha = (t - a.t) / (b.t - a.t);
  const deltaYaw = ((b.yaw - a.yaw) % 360 + 540) % 360 - 180;
  result.t = t;
  result.pos = a.pos.map((v, axis) => v + (b.pos[axis] - v) * alpha);
  result.yaw = a.yaw + alpha * deltaYaw;

  const start = t - SMOOTH_SECONDS, end = t + SMOOTH_SECONDS;
  if (start < poses[0].t || end > poses.at(-1).t) return result;
  // Integrate the piecewise linear path over time. Bursts of packets must
  // not carry more weight than the same movement arriving at regular intervals.
  let index = upperBound(poses, start);
  const sum = [0, 0, 0];
  while (index < poses.length) {
    const left = poses[index - 1], right = poses[index++];
    if (!continuous(left, right, blockingEvents)) return result;
    const from = Math.max(start, left.t), to = Math.min(end, right.t);
    const midpoint = ((from - left.t) + (to - left.t)) / (2 * (right.t - left.t));
    for (let axis = 0; axis < 3; ++axis) {
      sum[axis] += (to - from) * (left.pos[axis] + midpoint * (right.pos[axis] - left.pos[axis]));
    }
    if (right.t >= end) break;
  }
  result.pos = sum.map(value => value / (2 * SMOOTH_SECONDS));
  return result;
}
