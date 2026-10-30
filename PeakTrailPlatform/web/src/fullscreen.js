import { createViewportLayout } from "./viewport.js";

/** Native fullscreen is requested only by an explicit user toggle.
 * Page expansion is a separate presentation mode for browsers that cannot enter it.
 */
export function createFullscreen({
  documentRef = typeof document === "undefined" ? null : document,
  onChange = () => {},
} = {}) {
  const viewport = createViewportLayout({ documentRef, windowRef: documentRef?.defaultView });
  let pending = false;
  let error = null;
  let pageExpanded = false;
  let disposed = false;
  let enteredDuringRequest = false;
  const element = () => documentRef?.fullscreenElement || documentRef?.webkitFullscreenElement
    || documentRef?.webkitCurrentFullScreenElement || null;
  const active = () => Boolean(element() || documentRef?.webkitIsFullScreen);
  const fallbackAvailable = () => Boolean(documentRef?.documentElement);
  function standard() {
    const target = documentRef?.documentElement;
    return documentRef?.fullscreenEnabled !== false && typeof target?.requestFullscreen === "function"
      && typeof documentRef?.exitFullscreen === "function"
      ? { target, request: target.requestFullscreen, exit: documentRef.exitFullscreen } : null;
  }
  function prefixed() {
    const target = documentRef?.documentElement;
    const request = target?.webkitRequestFullscreen || target?.webkitRequestFullScreen;
    const exit = documentRef?.webkitExitFullscreen || documentRef?.webkitCancelFullScreen;
    return documentRef?.webkitFullscreenEnabled !== false && typeof request === "function" && typeof exit === "function"
      ? { target, request, exit } : null;
  }
  const nativeSupported = () => Boolean(standard() || prefixed());
  function exitOperation() {
    // A prefixed session should use its matching exit, even when both APIs exist.
    if (!documentRef?.fullscreenElement && (documentRef?.webkitFullscreenElement
        || documentRef?.webkitCurrentFullScreenElement || documentRef?.webkitIsFullScreen)) {
      const exit = documentRef?.webkitExitFullscreen || documentRef?.webkitCancelFullScreen;
      if (typeof exit === "function") return exit;
    }
    return typeof documentRef?.exitFullscreen === "function" ? documentRef.exitFullscreen
      : documentRef?.webkitExitFullscreen || documentRef?.webkitCancelFullScreen;
  }
  function expandPage() {
    if (!fallbackAvailable()) { error = "unsupported"; return; }
    pageExpanded = true;
    error = null;
  }
  function notify() { if (!disposed) onChange(); }
  let nativeWasActive = active();
  function changed() {
    if (disposed) return;
    const nativeActive = active();
    if (pending && nativeActive) enteredDuringRequest = true;
    if (nativeActive || nativeWasActive) pageExpanded = false;
    nativeWasActive = nativeActive;
    error = null;
    notify();
  }
  function keydown(event) {
    if (!event.defaultPrevented && !disposed && pageExpanded && !active() && event.key === "Escape") {
      pageExpanded = false; error = null;
      event.preventDefault?.();
      event.stopPropagation?.();
      notify();
    }
  }
  for (const type of ["fullscreenchange", "webkitfullscreenchange"]) documentRef?.addEventListener?.(type, changed);
  documentRef?.addEventListener?.("keydown", keydown);
  return {
    supported: nativeSupported,
    nativeSupported,
    fallbackAvailable,
    get active() { return active(); },
    get presentationActive() { return !disposed && (active() || pageExpanded); },
    get mode() { return disposed ? null : active() ? "native" : pageExpanded ? "page" : null; },
    get pending() { return pending; },
    get error() { return error; },
    async toggle() {
      if (disposed || pending) return;
      const exiting = active();
      if (!exiting && pageExpanded) {
        pageExpanded = false; error = null; notify(); return;
      }
      const operation = exiting ? exitOperation() : standard() || prefixed();
      if (!operation) {
        if (exiting) error = "exit-denied";
        else expandPage();
        notify(); return;
      }
      pending = true; enteredDuringRequest = false; error = null; notify();
      try {
        // Keep the native receiver, and invoke before any await loses user activation.
        if (exiting) await operation.call(documentRef);
        else await operation.request.call(operation.target);
        if (disposed) {
          // Browser requests cannot be cancelled. Do not leave a late owned request
          // fullscreen after its controls have been disposed.
          if (!exiting && element() === operation.target) {
            const exit = exitOperation();
            if (typeof exit === "function") {
              try { await exit.call(documentRef); } catch { /* browser remains authoritative */ }
            }
          }
          return;
        }
        if (!exiting && !active() && !enteredDuringRequest) expandPage();
      } catch {
        if (!disposed) {
          if (exiting) error = "exit-denied";
          else if (!active() && !enteredDuringRequest) expandPage();
        }
      } finally {
        pending = false; notify();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; pending = false; pageExpanded = false; error = null;
      viewport.dispose();
      for (const type of ["fullscreenchange", "webkitfullscreenchange"]) documentRef?.removeEventListener?.(type, changed);
      documentRef?.removeEventListener?.("keydown", keydown);
    },
  };
}
