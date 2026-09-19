/** Screen Wake Lock：直播观看 / 回放播放期间防止屏幕熄屏。
 * 支持 Chrome 84+ / Safari 16.4+（iOS 与 macOS）/ Firefox 126+，且仅安全上下文
 * （HTTPS 或 localhost）可用——局域网 HTTP 下 navigator.wakeLock 不存在。
 * 页面切后台时浏览器会自动释放锁，回前台需重新申请（visibilitychange）。 */
export function createWakeLock({
  navigatorRef = typeof navigator === "undefined" ? null : navigator,
  documentRef = typeof document === "undefined" ? null : document,
  onChange = () => {},
} = {}) {
  let sentinel = null;
  let desired = false;
  let acquireSequence = 0;
  let reportedHeld = null;

  const supported = () => Boolean(navigatorRef?.wakeLock);

  // 手动 release 与 sentinel 的 release 事件会在同一次变更里各来一次，
  // 只在持锁状态真正变化时才通知 UI。
  function report() {
    const held = sentinel != null;
    if (held === reportedHeld) return;
    reportedHeld = held;
    onChange();
  }

  async function acquire() {
    if (!desired || !supported() || sentinel) return;
    if (documentRef && documentRef.visibilityState !== "visible") return;
    const sequence = ++acquireSequence;
    try {
      const next = await navigatorRef.wakeLock.request("screen");
      // 申请期间用户（或 release）已改变意愿：这次申请作废，立即交还。
      if (sequence !== acquireSequence) {
        try { void next.release?.(); } catch { /* 系统已释放 */ }
        return;
      }
      sentinel = next;
      sentinel.addEventListener?.("release", () => {
        // 系统释放（切后台 / 省电模式）。不自动重试，等 visibilitychange。
        sentinel = null;
        report();
      });
      report();
    } catch {
      // 省电模式等场景会拒绝申请；留待下次 setDesired/可见性变化时重试。
      report();
    }
  }

  function release() {
    desired = false;
    acquireSequence += 1; // 让在途的申请作废
    const current = sentinel;
    sentinel = null;
    try { void current?.release?.(); } catch { /* 已被系统释放 */ }
    report();
  }

  return {
    supported,
    get desired() { return desired; },
    get held() { return sentinel != null; },
    /** 想要常亮传 true，允许熄屏传 false；重复调用安全。 */
    setDesired(next) {
      next = Boolean(next);
      if (next === desired) {
        // 之前申请失败（如省电模式）时再试一次；已有锁则无事发生。
        if (next) void acquire();
        return;
      }
      if (next) {
        desired = true;
        void acquire();
      } else {
        release();
      }
    },
    /** 页面回到前台：若锁被系统释放，按需重新申请。 */
    handleVisibilityChange() {
      if (desired && !sentinel) void acquire();
    },
  };
}
