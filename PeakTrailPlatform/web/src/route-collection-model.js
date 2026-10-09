const MAX_POINTS = 200_000;
const MAX_CELLS = 200_000;
const COLORS = ["#edc977", "#88cabb", "#d994b0", "#a8baf0", "#b7cf8e", "#e7a581", "#c8a9db", "#8dbdd8"];
const finiteInteger = value => Number.isSafeInteger(value);

function checkArray(value, limit, label) {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label}格式无效或数据过大`);
  return value;
}

export function normalizeRouteGroups(value) {
  return checkArray(value?.groups, 2000, "地图组").map(group => {
    if (typeof group?.id !== "string" || !group.id || !group.map || typeof group.map.scene !== "string") throw new Error("地图组身份无效");
    return {
      ...group,
      difficulties: checkArray(group.difficulties || [], 100, "难度"),
      stageSummaries: checkArray(group.stageSummaries || [], 64, "关卡").filter(stage => finiteInteger(stage?.index) && stage.index >= 0),
    };
  });
}

export function normalizeRoutes(value, { maximumPoints = MAX_POINTS } = {}) {
  let pointCount = 0;
  const ids = new Set();
  // Counts are not a proxy for data size: a large lobby may have hundreds of
  // short or empty member paths. Network pages retain a point budget, while a
  // verified collection assembled from those pages may exceed one page.
  const routes = checkArray(value?.routes, Infinity, "路线").map(route => {
    if (typeof route?.id !== "string" || !route.id || ids.has(route.id)) throw new Error("路线身份无效");
    ids.add(route.id);
    const points = checkArray(route.points, maximumPoints, "轨迹坐标");
    pointCount += points.length;
    if (pointCount > maximumPoints) throw new Error("轨迹坐标超过单页上限");
    let previous = -1;
    for (const point of points) {
      if (!Array.isArray(point) || point.length !== 4 || !point.every(finiteInteger)
        || point[0] < 0 || point[0] <= previous || point.slice(1).some(v => Math.abs(v) > 2_147_483_647)) throw new Error("轨迹时间或坐标无效");
      previous = point[0];
    }
    const breaks = checkArray(route.breaks || [], maximumPoints, "轨迹断点");
    if (breaks.some(t => !finiteInteger(t) || t < 0)) throw new Error("轨迹断点无效");
    return { ...route, name: typeof route.name === "string" && route.name.trim() ? route.name : "登山者", points,
      breaks: [...breaks].sort((a, b) => a - b) };
  });
  return { ...value, routes, totalRouteCount: finiteInteger(value.totalRouteCount) ? value.totalRouteCount : routes.length };
}

export function normalizeHeatmap(value) {
  if (!finiteInteger(value?.cellSizeCm) || value.cellSizeCm <= 0
    || !finiteInteger(value.heightBandCm) || value.heightBandCm <= 0
    || !finiteInteger(value.routeCount) || value.routeCount < 0) throw new Error("热力图精度无效");
  const cells = checkArray(value.cells, MAX_CELLS, "热力网格");
  if (cells.some(cell => !Array.isArray(cell) || cell.length !== 4 || !cell.every(finiteInteger)
    || cell[3] <= 0 || cell[3] > value.routeCount)) throw new Error("热力网格计数无效");
  return { ...value, cells };
}

export function mapGroupLabel(group) {
  const map = group.map;
  const suffix = map.route?.branch === "volcano-kiln" ? "火山 / 熔炉"
    : map.route?.branch === "swamp-temple" ? "雾沼 / 城塞" : "";
  return `${map.scene}${Number.isInteger(map.levelIndex) ? ` · 轮换 ${map.levelIndex}` : ""}${suffix ? ` · ${suffix}` : ""} · 构建 ${map.buildId}`;
}

export function routeColor(index) { return COLORS[index % COLORS.length]; }

export function heightBands(routes, heatmap, step = 200) {
  const values = new Set();
  for (const route of routes || []) for (const point of route.points) values.add(Math.floor(point[2] / step));
  for (const cell of heatmap?.cells || []) values.add(Math.floor(cell[1] * heatmap.heightBandCm / step));
  return [...values].sort((a, b) => a - b);
}

function clipHeight(start, end, band, size) {
  if (band === null) return [start, end];
  const minimum = band * size, maximum = minimum + size;
  const delta = end[2] - start[2];
  if (delta === 0) return start[2] >= minimum && start[2] < maximum ? [start, end] : null;
  const enter = Math.max(0, Math.min((minimum - start[2]) / delta, (maximum - start[2]) / delta));
  const exit = Math.min(1, Math.max((minimum - start[2]) / delta, (maximum - start[2]) / delta));
  if (enter >= exit) return null;
  const interpolate = fraction => start.map((value, axis) => value + (end[axis] - value) * fraction);
  return [enter === 0 ? start : interpolate(enter), exit === 1 ? end : interpolate(exit)];
}

export function routeEdges(route, { band = null, heightBandCm = 200, maximumGapMs = 1500 } = {}) {
  const result = [];
  let breakIndex = 0;
  for (let i = 1; i < route.points.length; i++) {
    const start = route.points[i - 1], end = route.points[i];
    while (breakIndex < route.breaks.length && route.breaks[breakIndex] <= start[0]) breakIndex++;
    if (end[0] - start[0] > maximumGapMs || (breakIndex < route.breaks.length && route.breaks[breakIndex] <= end[0])) continue;
    const clipped = clipHeight(start, end, band, heightBandCm);
    if (clipped) result.push(clipped);
  }
  return result;
}

export function projectPoint(point, projection) { return [point[1] / 100, point[projection === "xy" ? 2 : 3] / 100]; }

// A projection can overlap several 3D cells. Take their maximum count, never
// sum them and call that an independent-route count.
export function projectedHeatmap(heatmap, { band = null, projection = "xz" } = {}) {
  const grouped = new Map();
  const horizontalSize = heatmap.cellSizeCm / 100;
  const verticalSize = (projection === "xy" ? heatmap.heightBandCm : heatmap.cellSizeCm) / 100;
  for (const [x, y, z, count] of heatmap.cells) {
    if (band !== null && y !== band) continue;
    const v = projection === "xy" ? y : z;
    const key = `${x},${v}`;
    const current = grouped.get(key);
    if (!current || count > current.count) grouped.set(key, { x: x * horizontalSize, y: v * verticalSize, width: horizontalSize, height: verticalSize, count });
  }
  return [...grouped.values()];
}

export function viewBounds(points) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  if (minX === Infinity) return { minX: -5, maxX: 5, minY: -5, maxY: 5 };
  if (maxX - minX < 1) { minX -= .5; maxX += .5; }
  if (maxY - minY < 1) { minY -= .5; maxY += .5; }
  return { minX, maxX, minY, maxY };
}

export function mapCompatibilityNote(group) {
  return group?.mapCompatibility === "matched"
    ? "地图身份已核验 · 当前为无底图坐标视图，保留真实 XYZ。"
    : "等待对应构建的地图 · 先展示真实 XYZ 路线与热力，未叠加其他版本的底图。";
}
