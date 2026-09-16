// World state is observation data, never inferred from player inventory events.
const KINDS = new Set(['item', 'placed_object', 'mine', 'zombie', 'zombie_spawn', 'sleep_fog', 'spore_cloud', 'fog_safe_zone']);
const vector = (value, n) => Array.isArray(value) && value.length === n && value.every(Number.isFinite) ? [...value] : null;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const range = (value) => finite(value) !== null && value >= 0 ? value : null;
const dimensions = (value) => { const result = vector(value, 3); return result?.every((n) => n >= 0) ? result : null; };

export function normalizeWorldObject(value) {
  if (!value || typeof value.objectId !== 'string' || !value.objectId || !KINDS.has(value.kind)) return null;
  const pos = vector(value.pos, 3);
  if (!pos) return null;
  return {
    ...value, objectId: value.objectId.slice(0, 240), kind: value.kind, pos,
    rot: vector(value.rot, 4) || [0, 0, 0, 1], scale: vector(value.scale, 3) || [1, 1, 1],
    size: dimensions(value.size), radius: range(value.radius),
    activationRadius: range(value.activationRadius), warningRadius: range(value.warningRadius),
    prefabName: String(value.prefabName || ''), activity: String(value.activity || 'unknown'),
    source: String(value.source || 'recorded-world-observation'),
  };
}

export function normalizeWorldRecord(record, t) {
  if (!record || typeof record !== 'object' || !Number.isFinite(t) || t < 0) return null;
  if (record.type !== 'world_snapshot' && record.type !== 'world_delta') return null;
  const raw = record.type === 'world_snapshot' ? record.objects : record.upserts;
  if (!Array.isArray(raw)) return null;
  const objects = raw.map(normalizeWorldObject).filter(Boolean);
  // A malformed full snapshot must not falsely remove all previously seen objects.
  return { t, complete: record.type === 'world_snapshot' && record.complete === true && raw.length === objects.length,
    objects, removed: Array.isArray(record.removed) ? record.removed.filter((id) => typeof id === 'string') : [] };
}

export function buildWorldTimeline(records = []) {
  const tracks = new Map(), alive = new Map();
  const append = (id, t, value) => {
    if (!tracks.has(id)) tracks.set(id, []);
    tracks.get(id).push({ t, value });
  };
  const sorted = [...records].sort((a, b) => a.t - b.t);
  for (const record of sorted) {
    const present = new Set(record.objects.map((object) => object.objectId));
    const removed = new Set(record.removed);
    if (record.complete) for (const id of alive.keys()) if (!present.has(id)) removed.add(id);
    for (const id of removed) {
      if (alive.delete(id)) append(id, record.t, null);
    }
    for (const object of record.objects) {
      const fingerprint = JSON.stringify(object);
      if (alive.get(object.objectId) !== fingerprint) {
        alive.set(object.objectId, fingerprint);
        append(object.objectId, record.t, object);
      }
    }
  }
  return { captured: sorted.length > 0, firstTime: sorted[0]?.t ?? null,
    lastTime: sorted.at(-1)?.t ?? null, recordCount: sorted.length, tracks };
}

export function worldObjectsAtTime(timeline, time) {
  const result = [];
  for (const samples of timeline?.tracks?.values?.() || []) {
    let low = 0, high = samples.length;
    while (low < high) { const mid = (low + high) >>> 1; if (samples[mid].t <= time) low = mid + 1; else high = mid; }
    const value = samples[low - 1]?.value;
    if (value) result.push(value);
  }
  return result;
}

export function worldObjectVisible(object) {
  return object.active !== false && !['held', 'inventory', 'stored', 'destroyed', 'inactive', 'exploded', 'spent', 'consumed'].includes(object.activity);
}

export function worldObjectInBounds(object, bounds) {
  if (!bounds) return true;
  const volume = ['sleep_fog', 'spore_cloud', 'fog_safe_zone'].includes(object.kind);
  const half = volume ? object.size?.map((n) => n / 2) || [object.radius || 0, object.radius || 0, object.radius || 0] : [0, 0, 0];
  return object.pos.every((axis, i) => axis + half[i] >= bounds.min[i] - 3 && axis - half[i] <= bounds.max[i] + 3);
}

export function worldWarning(object, players) {
  if (!worldObjectVisible(object) || object.statusEnabled === false || !['zombie', 'zombie_spawn', 'mine', 'sleep_fog', 'spore_cloud'].includes(object.kind)) return null;
  const distances = players.map((player) => Math.hypot(...player.pos.map((v, i) => v - object.pos[i])));
  const distance = distances.length ? Math.min(...distances) : Infinity;
  // This is a viewer warning margin, not a claim about line-of-sight or AI targeting.
  const range = object.warningRadius ?? (object.activationRadius !== null ? object.activationRadius + 20 : null);
  if (range === null || range < 0 || distance > range) return null;
  return { object, distance, range, active: ['wakingup', 'idle', 'chasing', 'lunging', 'lungerecovery', 'awake', 'active', 'triggered', 'exploding'].includes(object.activity) };
}

export function worldEffectsAtTime(events, time) {
  return (events || []).filter((event) => event.pos && ['mine_explosion', 'mine_exploded', 'spore_explosion'].includes(event.type)
    && time >= event.t && time < event.t + 3).map((event) => ({ ...event, progress: (time - event.t) / 3 }));
}

export function worldTelemetryNote(timeline, time) {
  if (!timeline?.captured) return '此日志未采集世界动态（需 0.6+）：放置物、僵尸、爆炸与雾区状态未知。';
  if (time < timeline.firstTime) return '此时尚无世界采样；不提前展示后续物体。';
  return '世界状态按记录采样回放；预警圈为辅助提示，爆炸与雾体为示意效果。';
}
