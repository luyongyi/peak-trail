import assert from "node:assert/strict";
import test from "node:test";
import { buildTeamRouteSegments, teamMemberColor } from "../src/team-route-model.js";

const key = character => character.repeat(64);
const a = key("a"), b = key("b"), c = key("c");
function route(playerKey, coordinates, overrides = {}) {
  return { id: `route-${playerKey}`, playerKey, name: "同名队员", points: coordinates.map((position, index) => [index * 100, ...position]), breaks: [], ...overrides };
}
const xyz = point => point.slice(1);
const hasMembers = (segment, members) => JSON.stringify(segment.members) === JSON.stringify([...members].sort());
function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object") deepFreeze(child);
  return value;
}

test("parallel shared corridors are drawn once with both member identities and a real observed path", () => {
  const first = route(a, [[0, 0, 0], [1000, 0, 0]]), second = route(b, [[0, 0, 20], [1000, 0, 20]]);
  const segments = buildTeamRouteSegments([second, first]);
  assert.equal(segments.length, 1); assert.ok(hasMembers(segments[0], [a, b]));
  assert.deepEqual(xyz(segments[0].start), [0, 0, 0]); assert.deepEqual(xyz(segments[0].end), [1000, 0, 0]);
  assert.equal(segments[0].reference, false);
});

test("a chosen reference retains that member's observed corridor rather than averaging teammates", () => {
  const routes = [route(a, [[0, 0, 0], [1000, 0, 0]]), route(b, [[0, 0, 40], [1000, 0, 40]])];
  const segments = buildTeamRouteSegments(routes, { referencePlayerKey: b });
  assert.equal(segments.length, 1); assert.ok(hasMembers(segments[0], [a, b])); assert.equal(segments[0].reference, true);
  assert.deepEqual(xyz(segments[0].start), [0, 0, 40]); assert.deepEqual(xyz(segments[0].end), [1000, 0, 40]);
  assert.notEqual(segments[0].start[3], 20, "no artificial average position is created");
});

test("partial spatial overlap splits membership at its boundaries and keeps both outer branches", () => {
  const segments = buildTeamRouteSegments([route(a, [[0, 0, 0], [1000, 0, 0]]), route(b, [[-500, 0, 0], [500, 0, 0]])]);
  const spans = segments.map(segment => [segment.start[1], segment.end[1], segment.members]).sort((left, right) => left[0] - right[0]);
  assert.deepEqual(spans, [[-500, 0, [b]], [0, 500, [a, b]], [500, 1000, [a]]]);
});

test("a teammate's different approach remains visible before joining a shared final corridor", () => {
  const segments = buildTeamRouteSegments([route(a, [[0, 0, 0], [1000, 0, 0]]),
    route(b, [[0, 0, 300], [500, 0, 300], [500, 0, 0], [1000, 0, 0]])]);
  assert.ok(segments.some(segment => hasMembers(segment, [a, b]) && segment.start[1] === 500 && segment.end[1] === 1000));
  assert.ok(segments.some(segment => hasMembers(segment, [b]) && segment.start[3] === 300));
  assert.ok(segments.some(segment => hasMembers(segment, [a]) && segment.start[1] === 0 && segment.end[1] === 500));
});

test("paths on different vertical layers are kept separate even when within horizontal merge tolerance", () => {
  const segments = buildTeamRouteSegments([route(a, [[0, 0, 0], [1000, 0, 0]]), route(b, [[0, 26, 0], [1000, 26, 0]])]);
  assert.equal(segments.length, 2); assert.ok(segments.every(segment => segment.members.length === 1));
  assert.deepEqual(segments.map(segment => segment.start[2]).sort((left, right) => left - right), [0, 26]);
});

test("crossing routes are not combined into a shared corridor or an invented connection", () => {
  const segments = buildTeamRouteSegments([route(a, [[0, 0, 0], [1000, 0, 0]]), route(b, [[500, 0, -500], [500, 0, 500]])]);
  assert.equal(segments.length, 2); assert.ok(segments.every(segment => segment.members.length === 1));
  assert.deepEqual(xyz(segments[0].start), [0, 0, 0]); assert.deepEqual(xyz(segments[1].start), [500, 0, -500]);
});

test("opposite travel directions and unrelated recording clocks still represent spatial use only", () => {
  const first = route(a, [[0, 0, 0], [1000, 0, 0]]);
  const second = route(b, [], { points: [[10000, 1000, 0, 0], [10100, 0, 0, 0]] });
  const segments = buildTeamRouteSegments([first, second]);
  assert.equal(segments.length, 1); assert.ok(hasMembers(segments[0], [a, b]));
  assert.deepEqual(segments[0].start, first.points[0]); assert.deepEqual(segments[0].end, first.points[1]);
});

test("recorded interruptions keep two runs separate without bridging the missing segment", () => {
  const segments = buildTeamRouteSegments([route(a, [[0, 0, 0], [100, 0, 0], [200, 0, 0], [300, 0, 0]], { breaks: [200] })]);
  assert.deepEqual(segments.map(segment => [segment.start[1], segment.end[1]]), [[0, 100], [200, 300]]);
});

test("long sample gaps and unmarked implausible jumps leave no connecting line while retaining later motion", () => {
  const gap = route(a, [], { points: [[0, 0, 0, 0], [100, 100, 0, 0], [10000, 200, 0, 0], [10100, 300, 0, 0]] });
  assert.deepEqual(buildTeamRouteSegments([gap]).map(segment => [segment.start[1], segment.end[1]]), [[0, 100], [200, 300]]);
  const warp = route(a, [[0, 0, 0], [100, 0, 0], [10000, 0, 0], [10100, 0, 0]]);
  assert.deepEqual(buildTeamRouteSegments([warp]).map(segment => [segment.start[1], segment.end[1]]), [[0, 100], [10000, 10100]]);
});

test("hiding a member rebuilds shared membership, representatives and reference emphasis from visible data", () => {
  const routes = [route(a, [[0, 0, 0], [1000, 0, 0]]), route(b, [[0, 0, 20], [1000, 0, 20]]), route(c, [[0, 0, 300], [1000, 0, 300]])];
  const segments = buildTeamRouteSegments(routes, { visiblePlayers: new Set([b]), referencePlayerKey: a });
  assert.equal(segments.length, 1); assert.ok(hasMembers(segments[0], [b])); assert.equal(segments[0].reference, false);
  assert.deepEqual(xyz(segments[0].start), [0, 0, 20]);
  assert.deepEqual(buildTeamRouteSegments(routes, { visiblePlayers: new Set() }), []);
  assert.equal(buildTeamRouteSegments(routes, { visiblePlayers: new Set([routes[1].id]) }).length, 1, "old route-id selection remains compatible");
});

test("simplification keeps bends, clips selected altitude and never mutates frozen source observations", () => {
  const source = [route(a, [[0, 0, 0], [100, 0, 0], [200, 0, 0], [300, 100, 0], [400, 300, 0]])];
  const original = structuredClone(source); deepFreeze(source);
  const segments = buildTeamRouteSegments(source, { referencePlayerKey: a });
  assert.ok(segments.some(segment => segment.end[1] === 300 && segment.end[2] === 100));
  const clipped = buildTeamRouteSegments(source, { band: 1, heightBandCm: 200 });
  assert.ok(clipped.length); assert.ok(clipped.every(segment => segment.start[2] >= 200 && segment.end[2] <= 400));
  assert.deepEqual(source, original);
});

test("large disconnected runs survive the bounded spatial index instead of losing later observations", { timeout: 15000 }, () => {
  const points = [], breaks = [], count = 11000;
  for (let index = 0; index < count; index++) {
    const t = index * 300, x = index * 2000;
    if (index) breaks.push(t);
    points.push([t, x, 0, 0], [t + 100, x + 100, 0, 0]);
  }
  const segments = buildTeamRouteSegments([route(a, [], { points, breaks })]);
  assert.equal(segments.length, count);
  assert.deepEqual(segments.at(-1).start, points.at(-2)); assert.deepEqual(segments.at(-1).end, points.at(-1));
  assert.ok(segments.every(segment => segment.members.length === 1 && segment.members[0] === a && segment.end[1] - segment.start[1] === 100));
});

test("member colors follow stable identity and are independent of names and ordering", () => {
  assert.match(teamMemberColor(a), /^#[a-f0-9]{6}$/i);
  const before = [a, b, c].map(member => [member, teamMemberColor(member)]);
  const reordered = new Map([c, a, b].map(member => [member, teamMemberColor(member)]));
  for (const [member, color] of before) assert.equal(reordered.get(member), color);
  assert.equal(teamMemberColor(a), teamMemberColor(a));
});

test("invalid tolerances and malformed observations fail instead of manufacturing schematic geometry", () => {
  for (const toleranceCm of [-1, 101, NaN, Infinity]) assert.throws(() => buildTeamRouteSegments([], { toleranceCm }), /tolerance/);
  assert.throws(() => buildTeamRouteSegments([route(a, [], { points: [[100, 0, 0, 0], [100, 1, 0, 0]] })]), /轨迹时间/);
});
