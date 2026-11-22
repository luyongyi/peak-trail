/** A single room/feature projection into the existing map viewer. Operator mode uses its separate protected API. */
export function parseCaptureId(value) {
  const match = String(value ?? "").trim().toUpperCase().match(/^([A-P][A-Z0-9]{5}|[A-P][A-Z][A-Z2-9]{6})\.([A-F0-9]{20})$/);
  return match ? `${match[1]}.${match[2]}` : null;
}

const ACTIVE = new Set(["connecting", "recording", "stopping"]);
const STATUSES = new Set([...ACTIVE, "completed", "cancelled", "failed", "interrupted", "expired"]);
const MOVEMENTS = new Set(["rope", "climbing", "sprinting", "grounded", "off-ground"]);
const sequence = value => Number.isSafeInteger(value) && value >= 0;
const inRange = (value, limit) => Number.isFinite(value) && Math.abs(value) <= limit;

function readMotion(groups, after, last) {
  if (!Array.isArray(groups) || groups.length > 4096) throw new Error("Invalid motion groups");
  const samples = [], seen = new Set(), counts = new Map();
  for (const group of groups) {
    if (!Array.isArray(group) || group.length !== 3) throw new Error("Invalid motion group");
    const [playerId, activeSegment, rows] = group;
    if (typeof playerId !== "string" || !/^p[1-9][0-9]{0,9}$/.test(playerId) || Number(playerId.slice(1)) > 2147483647 ||
        (activeSegment !== null && (!Number.isInteger(activeSegment) || activeSegment < -1 || activeSegment > 1000)) ||
        !Array.isArray(rows) || rows.length + samples.length > 4096) throw new Error("Invalid motion group");
    const count = (counts.get(playerId) ?? 0) + rows.length;
    if (count > 128) throw new Error("Invalid player motion count");
    counts.set(playerId, count);
    let previous = after;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 6) throw new Error("Invalid motion row");
      const [seq, t, x, y, z, yaw] = row;
      if (!sequence(seq) || seq <= previous || seq > last || seen.has(seq) || !inRange(t, 1e12) || t < 0 ||
          !inRange(x, 1e7) || !inRange(y, 1e7) || !inRange(z, 1e7) || !inRange(yaw, 1e6))
        throw new Error("Invalid motion row");
      seen.add(seq); previous = seq;
      samples.push({ playerId, t: t / 1000, pos: [x, y, z], yaw, activeSegment });
    }
  }
  return samples;
}

export class PacketWatchClient {
  constructor({ captureId, watchId, operator = false, fetchImpl = (...args) => globalThis.fetch(...args), onSnapshot = () => {},
    onRecord = () => {}, onMotion = () => {}, onState = () => {}, onConnection = () => {}, now = () => Date.now(),
    setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (...args) => globalThis.clearTimeout(...args) }) {
    this.id = parseCaptureId(captureId ?? watchId);
    if (!this.id) throw new Error("Invalid capture identity");
    this.operator = operator === true;
    Object.assign(this, { fetchImpl, onSnapshot, onRecord, onMotion, onState, onConnection, now, setTimer, clearTimer });
    this.epoch = null; this.seq = 0; this.manifestKey = null; this.closed = false; this.ended = false;
    this.failures = 0; this.generation = 0;
    this.legacyEndpoint = false; this.motionSeq = null; this.needsSnapshot = false;
    this.movements = new Map();
  }
  movementAt(playerId, seconds, activeSegment) {
    const history = this.movements.get(playerId), t = seconds * 1000;
    if (!history || !Number.isFinite(t)) return null;
    const latest = history.findLast(row => row.t <= t);
    return latest && latest.activeSegment === activeSegment && t - latest.t <= 1500 ? latest.movement : null;
  }
  endpoint() {
    const path = `/api/${this.operator ? "packet-replay" : "navigation"}/captures/${this.id.replace(".", "/")}/live`;
    if (this.legacyEndpoint) return path;
    const cursor = this.motionSeq === null ? "" : `&epoch=${this.epoch}&after=${this.seq}&afterMotion=${this.motionSeq}`;
    return `${path}?motion=1${cursor}`;
  }
  async start() { this.onConnection("connecting"); await this.poll(); }
  async poll() {
    if (this.closed || this.ended || this.request) return;
    const generation = this.generation;
    const controller = new AbortController(); this.request = controller;
    const deadline = this.setTimer(() => controller.abort(), 10000);
    try {
      const options = { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal };
      let response = await this.fetchImpl(this.endpoint(), options);
      if (this.closed || generation !== this.generation) return;
      // Older bridges reject query parameters. Keep this room usable during a rolling upgrade.
      if (response.status === 400 && !this.legacyEndpoint) {
        if (this.motionSeq === null) {
          this.legacyEndpoint = true;
          response = await this.fetchImpl(this.endpoint(), options);
        } else {
          this.motionSeq = null; this.needsSnapshot = true;
        }
      }
      if (this.closed || generation !== this.generation) return;
      if ([401, 403].includes(response.status)) {
        this.stop(); this.onConnection("unauthorized", this.operator
          ? "管理登录已过期，请回 Peak导航的管理员入口解锁。"
          : "这份导航链接暂不可用，请检查完整链接或返回 Peak导航。"); return;
      }
      if ([404, 410].includes(response.status)) {
        this.stop(); this.onConnection("error", "这次导航不存在或已过期，请返回 Peak导航。"); return;
      }
      if (!response.ok) throw new Error("Unavailable");
      try {
        const value = await response.json();
        if (this.closed || generation !== this.generation) return;
        this.consume(value);
      } catch (error) {
        this.motionSeq = null; this.needsSnapshot = true;
        throw error;
      }
      this.failures = 0;
    } catch {
      if (!this.closed && generation === this.generation) {
        this.failures++; this.onConnection("reconnecting", "采集数据暂时不可用，正在重新同步。");
      }
    } finally {
      this.clearTimer(deadline); if (this.request === controller) this.request = null;
      if (!this.closed && !this.ended && generation === this.generation)
        this.timer = this.setTimer(() => this.poll(), Math.min(10000, 1000 * Math.max(1, this.failures)));
    }
  }
  consume(value) {
    const capture = value?.capture, live = value?.live;
    if (!capture || `${capture.roomCode}.${capture.featureCode}` !== this.id || !STATUSES.has(capture.status)) throw new Error("Invalid capture");
    const status = ACTIVE.has(capture.status) ? "live" : "ended";
    const projection = live ?? { sceneEpoch: 0, manifest: null, records: [], lastSequence: 0 };
    const { sceneEpoch: epoch, manifest, records, lastSequence, delivery, baseSequence, baseMotionSequence, lastMotionSequence } = projection;
    const appearances = projection.appearanceBaselines ?? [];
    if (!sequence(epoch) || !sequence(lastSequence) ||
      !Array.isArray(records) || records.length > 10000 || !Array.isArray(appearances) || appearances.length > 1024 ||
      appearances.some(record => record?.type !== "appearance" || typeof record.playerId !== "string" || !Number.isFinite(record.t) || record.t < 0) ||
      manifest !== null && (typeof manifest !== "object" || Array.isArray(manifest) || typeof manifest.sceneName !== "string" || !manifest.sceneName.trim())) throw new Error("Invalid projection");
    const manifestKey = manifest === null ? null : JSON.stringify([manifest.sceneName, manifest.mapPackId,
      manifest.gameBuildId, manifest.gameVersion, manifest.projectionVersion, manifest.coordinateSpace, manifest.route]);
    const incremental = delivery !== undefined, delta = delivery === "delta";
    if (incremental && (delivery !== "snapshot" && !delta || !sequence(lastMotionSequence))) throw new Error("Invalid delivery");
    if (delta && (this.motionSeq === null || epoch !== this.epoch || this.manifestKey !== manifestKey ||
        baseSequence !== this.seq || baseMotionSequence !== this.motionSeq ||
        lastSequence < baseSequence || lastMotionSequence < baseMotionSequence)) throw new Error("Stale delta");
    if (delivery === "snapshot" && (baseSequence != null || baseMotionSequence != null)) throw new Error("Invalid snapshot base");
    const samples = incremental ? readMotion(projection.motion, delta ? baseMotionSequence : 0, lastMotionSequence) : [];
    let previous = delta ? baseSequence : 0;
    for (const entry of records) {
      if (!Number.isSafeInteger(entry?.sequence) || entry.sequence <= previous || entry.sequence > lastSequence || !entry.record || typeof entry.record !== "object" || Array.isArray(entry.record)) throw new Error("Invalid record");
      previous = entry.sequence;
    }
    const rebuild = delivery === "snapshot" || !delta && (this.needsSnapshot || this.motionSeq !== null ||
      this.epoch !== epoch || this.manifestKey !== manifestKey || lastSequence < this.seq ||
      this.seq > 0 && records.length > 0 && records[0].sequence > this.seq + 1);
    if (rebuild) this.movements.clear();
    if (manifest?.gameBuildId === "26542162" && Array.isArray(projection.movements) && projection.movements.length <= 1024) {
      const participants = new Set(manifest.participants?.map(p => p.playerId));
      for (const row of projection.movements) {
        if (!row || !participants.has(row.playerId) || !MOVEMENTS.has(row.movement) || !Number.isFinite(row.t) || row.t < 0
            || !Number.isInteger(row.activeSegment) || row.activeSegment < 0 || row.activeSegment > 1000) continue;
        const history = this.movements.get(row.playerId) || [];
        if ((!history.length && this.movements.size >= 1024) || (history.length && row.t <= history.at(-1).t)) continue;
        history.push({ t: row.t, activeSegment: row.activeSegment, movement: row.movement });
        if (history.length > 600) history.shift();
        this.movements.set(row.playerId, history);
      }
    }
    if (samples.length || records.length && (rebuild || lastSequence > this.seq)) this.lastRecordAt = this.now();
    if (!manifest) this.lastRecordAt = null;
    const metadata = { status, epoch, capture, manifest, airport: projection.sceneName === "Airport",
      airportModelAvailable: projection.sceneName === "Airport" && projection.gameBuildId === "26542162",
      sessionId: this.id, watchId: this.id,
      lastSeq: lastSequence, lastRecordAt: this.lastRecordAt ?? null };
    if (rebuild) {
      this.onSnapshot({ ...metadata, snapshotSeq: lastSequence,
        snapshot: { records: manifest ? [
          ...appearances.map(record => ({ record })),
          ...records.map(entry => ({ seq: entry.sequence, record: entry.record })),
        ] : [] } });
    } else if (manifest) {
      for (const entry of records) if (entry.sequence > this.seq)
        this.onRecord({ epoch, seq: entry.sequence, record: entry.record });
    }
    if (rebuild || samples.length || delta && records.length)
      this.onMotion({ reset: rebuild, samples: manifest ? samples : [] });
    this.epoch = epoch; this.seq = lastSequence; this.manifestKey = manifestKey;
    this.motionSeq = incremental ? lastMotionSequence : null; this.needsSnapshot = false;
    this.onState(metadata);
    if (status === "ended") { this.ended = true; this.onConnection("ended"); }
    else this.onConnection(manifest ? "connected" : "waiting");
  }
  stop() {
    this.closed = true; ++this.generation; this.clearTimer(this.timer); this.request?.abort(); this.request = null;
  }
}
