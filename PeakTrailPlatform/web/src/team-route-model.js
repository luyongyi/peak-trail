import { normalizeRoutes, routeEdges } from "./route-collection-model.js";

// Member identity, rather than result ordering or nickname, owns the color.
export function teamMemberColor(key) {
  let hash = 2166136261;
  for (const character of String(key || "")) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  const value = hash >>> 0, hue = value % 360 / 60;
  const saturation = (65 + (value >>> 9) % 15) / 100, lightness = (62 + (value >>> 17) % 8) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(hue % 2 - 1)), minimum = lightness - chroma / 2;
  const channels = [[chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
    [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary]][Math.floor(hue)];
  return `#${channels.map(channel => Math.round((channel + minimum) * 255).toString(16).padStart(2, "0")).join("")}`;
}

const xyz = point => point.slice(1, 4);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const lengthSquared = value => dot(value, value);
const at = (a, b, t) => a.map((value, index) => value + (b[index] - value) * t);
const clamp = value => Math.max(0, Math.min(1, value));
function distanceToSegment(point, start, end) {
  const vector = subtract(end, start), square = lengthSquared(vector);
  const t = square ? clamp(dot(subtract(point, start), vector) / square) : 0;
  return lengthSquared(subtract(point, at(start, end, t)));
}

// Simplification selects actual observations, with small spatial error and
// bounded chord lengths. It never crosses a recorded interruption or time gap.
function simplifyRun(points, epsilon) {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]), pending = [[0, points.length - 1]];
  let compared = 0;
  while (pending.length) {
    const [first, last] = pending.pop();
    if (compared + last - first > points.length * 24) {
      for (let i = first + 1; i < last; i++) keep.add(i);
      continue;
    }
    let farthest = -1, maximum = epsilon * epsilon;
    for (let i = first + 1; i < last; i++) {
      compared++;
      const distance = distanceToSegment(xyz(points[i]), xyz(points[first]), xyz(points[last]));
      if (distance > maximum) { maximum = distance; farthest = i; }
    }
    if (farthest >= 0) { keep.add(farthest); pending.push([first, farthest], [farthest, last]); }
  }
  let previous = 0;
  for (let i = 1; i < points.length - 1; i++) {
    if (keep.has(i) || lengthSquared(subtract(xyz(points[i]), xyz(points[previous]))) >= 1000 ** 2) {
      keep.add(i); previous = i;
    }
  }
  return [...keep].sort((a, b) => a - b).map(index => points[index]);
}

function routeSegments(route, options) {
  const runs = []; let run = [], previous = null;
  for (const [start, end] of routeEdges(route, options)) {
    const distance = Math.sqrt(lengthSquared(subtract(xyz(end), xyz(start))));
    if (distance > Math.max(1500, (end[0] - start[0]) * 5)) {
      if (run.length > 1) runs.push(run); run = []; previous = null; continue;
    }
    if (!previous || previous.some((value, index) => value !== start[index])) {
      if (run.length > 1) runs.push(run); run = [start];
    }
    run.push(end); previous = end;
  }
  if (run.length > 1) runs.push(run);
  return runs.flatMap(points => {
    const selected = simplifyRun(points, options.simplifyCm);
    return selected.slice(1).map((end, index) => [selected[index], end]);
  });
}

function overlap(start, end, other, toleranceCm, heightToleranceCm) {
  const a = xyz(start), b = xyz(end), c = xyz(other.start), d = xyz(other.end);
  const vector = subtract(b, a), reference = subtract(d, c);
  const square = lengthSquared(vector), referenceSquare = lengthSquared(reference);
  if (!square || !referenceSquare || Math.abs(dot(vector, reference)) / Math.sqrt(square * referenceSquare) < .985) return null;
  const cAt = dot(subtract(c, a), vector) / square, dAt = dot(subtract(d, a), vector) / square;
  const begin = Math.max(0, Math.min(cAt, dAt)), finish = Math.min(1, Math.max(cAt, dAt));
  if ((finish - begin) * Math.sqrt(square) < 10) return null;
  const referenceAt = [];
  for (const t of [begin, finish]) {
    const p = at(a, b, t), u = clamp(dot(subtract(p, c), reference) / referenceSquare), q = at(c, d, u);
    if (Math.abs(p[1] - q[1]) > heightToleranceCm || lengthSquared(subtract(p, q)) > toleranceCm ** 2) return null;
    referenceAt.push(u);
  }
  return { begin, finish, otherBegin: Math.min(...referenceAt), otherEnd: Math.max(...referenceAt) };
}

// The index is rasterized along each bounded segment instead of filling its
// 3D bounding box. Busy campfires and many coincident uploads stay bounded.
function cellKeys(start, end) {
  const a = xyz(start), b = xyz(end), steps = Math.max(1, Math.ceil(Math.max(...subtract(b, a).map(Math.abs)) / 500));
  const keys = new Set();
  for (let i = 0; i <= steps; i++) {
    const cell = at(a, b, i / steps).map(value => Math.floor(value / 500));
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      keys.add(`${cell[0] + x},${cell[1] + y},${cell[2] + z}`);
    }
  }
  return keys;
}

/** A schematic of a single team's actual corridors. Shared pieces retain one
 * observed path; positions are never averaged between players. Membership is
 * stored per overlapping piece, and no claim of simultaneous travel is made.
 * Original per-member routes remain independent and untouched.
 */
export function buildTeamRouteSegments(input, { visiblePlayers = null, referencePlayerKey = null, band = null,
  heightBandCm = 200, toleranceCm = 75, heightToleranceCm = 25, simplifyCm = 20 } = {}) {
  if (![toleranceCm, heightToleranceCm, simplifyCm].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) throw new Error("Invalid team corridor tolerance");
  const visible = visiblePlayers == null ? null : new Set(visiblePlayers);
  const routes = normalizeRoutes({ routes: input || [] }, { maximumPoints: Infinity }).routes.filter(route => !visible || visible.has(route.id) || visible.has(route.playerKey));
  routes.sort((a, b) => Number(b.playerKey === referencePlayerKey) - Number(a.playerKey === referencePlayerKey)
    || String(a.playerKey || a.id).localeCompare(String(b.playerKey || b.id)) || a.id.localeCompare(b.id));
  const representatives = [], cells = new Map(); let comparisons = 0;
  for (const route of routes) {
    const playerKey = route.playerKey || route.id;
    for (const [start, end] of routeSegments(route, { band, heightBandCm, simplifyCm })) {
      if (lengthSquared(subtract(xyz(end), xyz(start))) < 1) continue;
      const candidates = new Set();
      if (comparisons < 500_000) for (const key of cellKeys(start, end)) for (const index of cells.get(key) || []) candidates.add(index);
      const covered = [];
      // When the cell contains a very dense knot, keep extra observed branches
      // rather than doing unbounded matching or discarding their evidence.
      for (const index of [...candidates].slice(0, 512)) {
        if (++comparisons > 500_000) break;
        const other = representatives[index], match = overlap(start, end, other, toleranceCm, heightToleranceCm);
        if (!match) continue;
        covered.push([match.begin, match.finish]);
        if (!other.memberships.some(value => value[2] === playerKey && value[0] <= match.otherBegin && value[1] >= match.otherEnd)) {
          other.memberships.push([match.otherBegin, match.otherEnd, playerKey]);
        }
      }
      covered.sort((a, b) => a[0] - b[0]);
      const gaps = []; let cursor = 0;
      for (const [begin, finish] of covered) { if (begin > cursor + 1e-8) gaps.push([cursor, begin]); cursor = Math.max(cursor, finish); }
      if (cursor < 1 - 1e-8) gaps.push([cursor, 1]);
      for (const [begin, finish] of gaps) {
        const edge = { start: begin === 0 ? start : at(start, end, begin), end: finish === 1 ? end : at(start, end, finish),
          memberships: [[0, 1, playerKey]], reference: playerKey === referencePlayerKey };
        const index = representatives.push(edge) - 1;
        if (index < 10000 && comparisons < 500_000) for (const key of cellKeys(edge.start, edge.end)) {
          const bucket = cells.get(key) || []; if (bucket.length < 512) bucket.push(index); cells.set(key, bucket);
        }
      }
    }
  }
  const result = [];
  for (const edge of representatives) {
    const boundaries = [...new Set(edge.memberships.flatMap(value => value.slice(0, 2)))].sort((a, b) => a - b);
    for (let i = 1; i < boundaries.length; i++) {
      const begin = boundaries[i - 1], finish = boundaries[i];
      if (finish - begin < 1e-8) continue;
      const middle = (begin + finish) / 2;
      const members = [...new Set(edge.memberships.filter(value => value[0] <= middle && value[1] >= middle).map(value => value[2]))].sort();
      result.push({ start: begin === 0 ? edge.start : at(edge.start, edge.end, begin),
        end: finish === 1 ? edge.end : at(edge.start, edge.end, finish), members, reference: edge.reference });
    }
  }
  return result;
}
