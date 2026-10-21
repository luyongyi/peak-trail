/** Screen Wake Lock is best effort: visibility, browser support and power policy apply. */
export function createWakeLock({
  navigatorRef = typeof navigator === "undefined" ? null : navigator,
  documentRef = typeof document === "undefined" ? null : document,
  onChange = () => {},
} = {}) {
  let sentinel = null;
  let desired = false;
  let pending = null;
  let status = "idle";
  let reported = null;
  const supported = () => typeof navigatorRef?.wakeLock?.request === "function";
  const visible = () => !documentRef || documentRef.visibilityState === "visible";
  function report(next) {
    status = next;
    if (status === reported) return;
    reported = status; onChange();
  }
  function releaseSentinel(value) {
    try { Promise.resolve(value?.release?.()).catch(() => {}); } catch { /* already released */ }
  }
  function release(next) {
    pending = null; // Invalidate a non-cancellable native request.
    const previous = sentinel; sentinel = null;
    releaseSentinel(previous); report(next);
  }
  async function acquire() {
    if (!desired || sentinel || pending) return;
    if (!supported()) { report("unavailable"); return; }
    if (!visible()) { report("suspended"); return; }
    const request = {}; pending = request; report("pending");
    try {
      const next = await navigatorRef.wakeLock.request("screen");
      if (pending !== request || !desired || !visible()) { releaseSentinel(next); return; }
      pending = null;
      if (next.released) { report("released"); return; }
      sentinel = next;
      next.addEventListener?.("release", () => {
        // A delayed event from an old lock must never erase its replacement.
        if (sentinel !== next) return;
        sentinel = null; report(desired ? visible() ? "released" : "suspended" : "idle");
      });
      report("held");
    } catch {
      if (pending !== request) return;
      pending = null; report("denied");
    }
  }
  return {
    supported,
    get desired() { return desired; },
    get held() { return sentinel != null; },
    get status() { return status; },
    setDesired(next) {
      desired = Boolean(next);
      if (desired) void acquire();
      else if (sentinel || pending || status !== "idle") release("idle");
    },
    retry() { if (desired) void acquire(); },
    handleVisibilityChange() {
      if (!visible()) release(desired ? "suspended" : "idle");
      else if (desired) void acquire();
    },
  };
}
