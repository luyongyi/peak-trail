/** Fullscreen is requested only by toggle(), called directly from a user click. */
export function createFullscreen({
  documentRef = typeof document === "undefined" ? null : document,
  onChange = () => {},
} = {}) {
  let pending = false;
  let error = null;
  const active = () => Boolean(documentRef?.fullscreenElement);
  const supported = () => documentRef?.fullscreenEnabled !== false
    && typeof documentRef?.documentElement?.requestFullscreen === "function"
    && typeof documentRef?.exitFullscreen === "function";
  function changed() { error = null; onChange(); }
  documentRef?.addEventListener?.("fullscreenchange", changed);
  return {
    supported,
    get active() { return active(); },
    get pending() { return pending; },
    get error() { return error; },
    async toggle() {
      if (pending) return;
      const exiting = active();
      if (!exiting && !supported()) { error = "unsupported"; onChange(); return; }
      pending = true; error = null; onChange();
      try {
        // Keep the native receiver, and invoke before any await loses user activation.
        if (exiting) await documentRef.exitFullscreen();
        else await documentRef.documentElement.requestFullscreen();
      } catch { error = exiting ? "exit-denied" : "request-denied"; }
      finally { pending = false; onChange(); }
    },
    dispose() { documentRef?.removeEventListener?.("fullscreenchange", changed); },
  };
}
