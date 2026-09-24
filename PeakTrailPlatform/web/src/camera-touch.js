/** Hold controls for touch spectators; never synthesize global keyboard events. */
export function bindCameraTouchControls({ root, canvas, getCamera }) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const held = new Map();
  const listeners = [];
  const listen = (target, name, callback) => {
    target?.addEventListener(name, callback);
    listeners.push([target, name, callback]);
  };
  const release = (id) => {
    const entry = held.get(id);
    if (!entry) return;
    held.delete(id);
    entry.camera.setTouchMovement(entry.direction, false, id);
    if (![...held.values()].some((other) => other.button === entry.button)) {
      entry.button.removeAttribute("data-held");
    }
    try {
      if (typeof id === "number" && entry.button.hasPointerCapture?.(id)) entry.button.releasePointerCapture(id);
    } catch { /* Cancellation can release native capture before this listener. */ }
  };
  const clear = () => { for (const id of [...held.keys()]) release(id); };
  const press = (button, id, event) => {
    if (root.hidden || held.has(id)) return;
    const camera = getCamera();
    if (!camera || camera.mode !== "free") return;
    // Keep focus on the canvas: default button focus would immediately clear movement.
    event.preventDefault();
    const direction = button.dataset.cameraMove;
    if (!camera.setTouchMovement(direction, true, id)) return;
    held.set(id, { button, direction, camera });
    button.setAttribute("data-held", "");
    if (typeof id === "number") {
      try { button.setPointerCapture?.(id); } catch { /* Document-level release is the fallback. */ }
    }
  };
  for (const button of root.querySelectorAll("[data-camera-move]")) {
    listen(button, "pointerdown", (event) => {
      if (event.button === 0) press(button, event.pointerId, event);
    });
    listen(button, "lostpointercapture", (event) => release(event.pointerId));
    listen(button, "keydown", (event) => {
      if (!event.repeat && ["Space", "Enter"].includes(event.code)) press(button, `key:${event.code}`, event);
    });
    listen(button, "contextmenu", (event) => event.preventDefault());
  }
  listen(document, "pointerup", (event) => release(event.pointerId));
  listen(document, "pointercancel", (event) => release(event.pointerId));
  // The initial keyboard press focuses the canvas. Repeats are then routed to
  // it, not the original button; don't let a held Space also scroll the page.
  listen(document, "keydown", (event) => {
    if (held.has(`key:${event.code}`)) event.preventDefault();
  });
  listen(document, "keyup", (event) => release(`key:${event.code}`));
  listen(document, "visibilitychange", () => { if (document.hidden) clear(); });
  listen(window, "blur", clear);
  listen(window, "pagehide", clear);
  listen(canvas, "blur", clear);
  listen(canvas, "cameramodechange", clear);
  return () => {
    clear();
    for (const [target, name, callback] of listeners) target?.removeEventListener(name, callback);
    listeners.length = 0;
  };
}
