/** Read-only v2 viewer. A fresh EventSource always carries its explicit cursor. */
export function parseWatchId(value, base = "https://watch.invalid/") {
  const text = String(value || "").trim();
  if (/^[a-f0-9]{32}$/i.test(text)) return text.toLowerCase();
  try {
    const url = new URL(text, base);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const id = url.searchParams.get("watch");
    return /^[a-f0-9]{32}$/i.test(id || "") ? id.toLowerCase() : null;
  } catch { return null; }
}

export class WatchClient {
  constructor({ watchId, base = "", fetchImpl = (...args) => globalThis.fetch(...args), EventSourceImpl = globalThis.EventSource,
    onSnapshot = () => {}, onRecord = () => {}, onState = () => {}, onConnection = () => {},
    now = () => Date.now(), setTimer = (...args) => globalThis.setTimeout(...args),
    clearTimer = (...args) => globalThis.clearTimeout(...args) }) {
    Object.assign(this, { watchId, base, fetchImpl, EventSourceImpl, onSnapshot, onRecord, onState,
      onConnection, now, setTimer, clearTimer });
    this.epoch = null;
    this.seq = 0;
    this.closed = false;
    this.ended = false;
    this.attempts = 0;
    this.generation = 0;
  }
  endpoint() { return `${this.base}/api/live/v2/watch/${encodeURIComponent(this.watchId)}`; }
  async start() {
    const generation = ++this.generation;
    this.onConnection("connecting");
    try {
      const response = await this.fetchImpl(this.endpoint(), { cache: "no-store" });
      if (this.closed || generation !== this.generation) return;
      if (!response.ok) {
        const message = [404, 410].includes(response.status) ? "链接不存在或已过期" : "暂时无法连接直播服务";
        this.onConnection("error", message);
        return;
      }
      const metadata = await response.json();
      if (this.closed || generation !== this.generation) return;
      this.onState(metadata);
      // Even an ended session needs its final snapshot before the stream closes.
      this.open();
    } catch {
      if (!this.closed && generation === this.generation) this.onConnection("error", "网络不可用，请重试");
    }
  }
  open() {
    if (this.closed || this.ended) return;
    this.es?.close();
    this.clearTimer(this.retryTimer);
    const query = new URLSearchParams();
    if (this.epoch !== null) {
      query.set("epoch", String(this.epoch));
      query.set("after", String(this.seq));
    }
    const es = new this.EventSourceImpl(`${this.endpoint()}/stream${query.size ? `?${query}` : ""}`);
    this.es = es;
    this.lastMessageAt = this.now();
    const current = () => !this.closed && this.es === es;
    const receive = (name, handler) => es.addEventListener(name, event => {
      if (!current()) return;
      this.lastMessageAt = this.now();
      this.attempts = 0;
      try { handler(JSON.parse(event.data)); }
      catch { this.reconnect("数据同步中"); }
    });
    es.onopen = () => { if (current()) this.onConnection("connected"); };
    receive("hello", data => {
      if (!Number.isSafeInteger(data.epoch) || data.epoch < 1
        || !Number.isSafeInteger(data.snapshotSeq) || data.snapshotSeq < 0
        || !Array.isArray(data.snapshot?.records)) throw new Error("Invalid snapshot");
      this.onSnapshot(data);
      this.epoch = data.epoch;
      this.seq = data.snapshotSeq;
      this.onState(data);
      this.onConnection("connected");
      if (data.status === "ended") this.finish();
    });
    receive("record", data => {
      if (data.epoch !== this.epoch) {
        this.epoch = null; this.seq = 0;
        this.reconnect("正在同步新数据");
        return;
      }
      if (!Number.isSafeInteger(data.seq) || data.seq <= this.seq) return;
      if (data.seq !== this.seq + 1) { this.reconnect("正在补齐数据"); return; }
      this.onRecord(data);
      this.seq = data.seq;
    });
    receive("resumed", data => {
      if (data.epoch !== this.epoch) throw new Error("Epoch changed");
      this.onState(data);
      this.onConnection("connected");
    });
    receive("state", data => {
      if (this.epoch !== null && data.epoch !== undefined && data.epoch !== this.epoch) return;
      this.onState(data);
      if (data.status === "ended") this.finish();
    });
    receive("ping", () => {});
    es.onerror = () => { if (current()) this.reconnect("观看连接中断，正在重连"); };
    this.armWatchdog();
  }
  armWatchdog() {
    this.clearTimer(this.watchdog);
    this.watchdog = this.setTimer(() => {
      if (this.closed || this.ended) return;
      if (this.now() - this.lastMessageAt > 25_000) this.reconnect("观看连接中断，正在重连");
      else this.armWatchdog();
    }, 10_000);
  }
  reconnect(message) {
    if (this.closed || this.ended) return;
    this.es?.close();
    this.es = null; // invalidate queued callbacks from the replaced connection
    this.clearTimer(this.watchdog);
    this.clearTimer(this.retryTimer);
    this.onConnection("reconnecting", message);
    const delay = Math.min(10_000, 1000 * 2 ** Math.min(this.attempts++, 4));
    this.retryTimer = this.setTimer(() => this.retry(), delay);
  }
  async retry() {
    if (this.closed || this.ended) return;
    // EventSource hides HTTP response status. A deleted session otherwise looks
    // identical to a transient outage and would reconnect forever after its TTL.
    if (this.attempts >= 3) {
      const generation = this.generation;
      try {
        const response = await this.fetchImpl(this.endpoint(), { cache: "no-store" });
        if (this.closed || this.ended || generation !== this.generation) return;
        if ([404, 410].includes(response.status)) {
          this.stop();
          this.onConnection("error", "链接不存在或已过期，已保留最后收到的路径");
          return;
        }
        if (!response.ok) { this.reconnect("观看连接中断，正在重连"); return; }
        const metadata = await response.json();
        if (this.closed || this.ended || generation !== this.generation) return;
        this.onState(metadata);
      } catch {
        if (!this.closed && !this.ended && generation === this.generation) this.reconnect("观看连接中断，正在重连");
        return;
      }
    }
    this.open();
  }
  finish() {
    this.ended = true;
    this.es?.close();
    this.es = null;
    this.clearTimer(this.watchdog);
    this.clearTimer(this.retryTimer);
    this.onConnection("ended");
  }
  stop() {
    this.closed = true;
    ++this.generation;
    this.es?.close();
    this.es = null;
    this.clearTimer(this.watchdog);
    this.clearTimer(this.retryTimer);
  }
}
