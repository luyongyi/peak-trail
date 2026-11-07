/** A single room/feature projection into the existing map viewer. Operator mode uses its separate protected API. */
export function parseCaptureId(value) {
  const match = String(value ?? "").trim().toUpperCase().match(/^([A-P][A-Z0-9]{5})\.([A-F0-9]{20})$/);
  return match ? `${match[1]}.${match[2]}` : null;
}

const ACTIVE = new Set(["connecting", "recording", "stopping"]);
const STATUSES = new Set([...ACTIVE, "completed", "cancelled", "failed", "interrupted", "expired"]);
export class PacketWatchClient {
  constructor({ captureId, watchId, operator = false, fetchImpl = (...args) => globalThis.fetch(...args), onSnapshot = () => {},
    onRecord = () => {}, onState = () => {}, onConnection = () => {}, now = () => Date.now(),
    setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (...args) => globalThis.clearTimeout(...args) }) {
    this.id = parseCaptureId(captureId ?? watchId);
    if (!this.id) throw new Error("Invalid capture identity");
    this.operator = operator === true;
    Object.assign(this, { fetchImpl, onSnapshot, onRecord, onState, onConnection, now, setTimer, clearTimer });
    this.epoch = null; this.seq = 0; this.manifestKey = null; this.closed = false; this.ended = false;
    this.failures = 0; this.generation = 0;
  }
  endpoint() { return `/api/${this.operator ? "packet-replay" : "navigation"}/captures/${this.id.replace(".", "/")}/live`; }
  async start() { this.onConnection("connecting"); await this.poll(); }
  async poll() {
    if (this.closed || this.ended || this.request) return;
    const generation = this.generation;
    const controller = new AbortController(); this.request = controller;
    const deadline = this.setTimer(() => controller.abort(), 10000);
    try {
      const response = await this.fetchImpl(this.endpoint(), { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
      if (this.closed || generation !== this.generation) return;
      if ([401, 403].includes(response.status)) {
        this.stop(); this.onConnection("unauthorized", this.operator
          ? "管理登录已过期，请回 Peak导航服务的管理员入口解锁。"
          : "这份导航链接暂不可用，请检查完整链接或返回 Peak导航服务。"); return;
      }
      if ([404, 410].includes(response.status)) {
        this.stop(); this.onConnection("error", "这次导航不存在或已过期，请返回 Peak导航服务。"); return;
      }
      if (!response.ok) throw new Error("Unavailable");
      const value = await response.json();
      if (this.closed || generation !== this.generation) return;
      this.consume(value); this.failures = 0;
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
    const { sceneEpoch: epoch, manifest, records, lastSequence } = projection;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(lastSequence) || lastSequence < 0 ||
      !Array.isArray(records) || records.length > 10000 || manifest !== null && (typeof manifest !== "object" || Array.isArray(manifest) || typeof manifest.sceneName !== "string" || !manifest.sceneName.trim())) throw new Error("Invalid projection");
    let previous = 0;
    for (const entry of records) {
      if (!Number.isSafeInteger(entry?.sequence) || entry.sequence <= previous || entry.sequence > lastSequence || !entry.record || typeof entry.record !== "object" || Array.isArray(entry.record)) throw new Error("Invalid record");
      previous = entry.sequence;
    }
    const manifestKey = manifest === null ? null : JSON.stringify([manifest.sceneName, manifest.mapPackId,
      manifest.gameBuildId, manifest.gameVersion, manifest.projectionVersion, manifest.coordinateSpace, manifest.route]);
    const rebuild = this.epoch !== epoch || this.manifestKey !== manifestKey || lastSequence < this.seq ||
      this.seq > 0 && records.length > 0 && records[0].sequence > this.seq + 1;
    if (records.length && (rebuild || lastSequence > this.seq)) this.lastRecordAt = this.now();
    if (!manifest) this.lastRecordAt = null;
    const metadata = { status, epoch, capture, manifest, sessionId: this.id, watchId: this.id,
      lastSeq: lastSequence, lastRecordAt: this.lastRecordAt ?? null };
    if (rebuild) {
      this.onSnapshot({ ...metadata, snapshotSeq: lastSequence,
        snapshot: { records: manifest ? records.map(entry => ({ seq: entry.sequence, record: entry.record })) : [] } });
    } else if (manifest) {
      for (const entry of records) if (entry.sequence > this.seq)
        this.onRecord({ epoch, seq: entry.sequence, record: entry.record });
    }
    this.epoch = epoch; this.seq = lastSequence; this.manifestKey = manifestKey;
    this.onState(metadata);
    if (status === "ended") { this.ended = true; this.onConnection("ended"); }
    else this.onConnection(manifest ? "connected" : "waiting", manifest ? "" : "已连接采集器，等待确认本局关卡；不会加载今日地图代替。");
  }
  stop() {
    this.closed = true; ++this.generation; this.clearTimer(this.timer); this.request?.abort(); this.request = null;
  }
}
