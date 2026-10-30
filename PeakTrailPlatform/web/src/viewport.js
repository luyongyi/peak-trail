/** Keep fixed map layouts inside Safari's visible viewport without overriding pinch zoom. */
export function createViewportLayout({ documentRef = null, windowRef = documentRef?.defaultView } = {}) {
  const style = documentRef?.documentElement?.style;
  if (!style?.setProperty || !windowRef?.addEventListener) return { dispose() {} };
  const viewport = windowRef.visualViewport;
  const properties = ["--app-viewport-width", "--app-viewport-height", "--app-viewport-offset-top", "--app-viewport-offset-left"];
  const previous = properties.map(name => [style.getPropertyValue(name), style.getPropertyPriority?.(name) || ""]);
  const written = new Map();
  let disposed = false;
  let frame = null;
  const valid = value => Number.isFinite(value) && value > 0;
  function update() {
    frame = null;
    if (disposed) return;
    // A pinch changes the visual viewport, not the underlying page layout.
    // Resizing the page to that smaller box fights magnification and panning.
    if (viewport && viewport.scale > 1.01 && written.size) return;
    const visual = viewport && !(viewport.scale > 1.01) && valid(viewport.width) && valid(viewport.height);
    const width = visual ? viewport.width : windowRef.innerWidth;
    const height = visual ? viewport.height : windowRef.innerHeight;
    if (!valid(width) || !valid(height)) return;
    const values = [width, height, visual ? Math.max(0, viewport.offsetTop || 0) : 0, visual ? Math.max(0, viewport.offsetLeft || 0) : 0];
    properties.forEach((name, index) => {
      const value = `${Math.round(values[index] * 100) / 100}px`;
      if (written.get(name) === value) return;
      style.setProperty(name, value);
      written.set(name, value);
    });
  }
  function schedule() {
    if (disposed || frame !== null) return;
    if (typeof windowRef.requestAnimationFrame === "function") frame = windowRef.requestAnimationFrame(update);
    else update();
  }
  windowRef.addEventListener("resize", schedule, { passive: true });
  windowRef.addEventListener("orientationchange", schedule, { passive: true });
  viewport?.addEventListener?.("resize", schedule, { passive: true });
  viewport?.addEventListener?.("scroll", schedule, { passive: true });
  update();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      windowRef.removeEventListener("resize", schedule);
      windowRef.removeEventListener("orientationchange", schedule);
      viewport?.removeEventListener?.("resize", schedule);
      viewport?.removeEventListener?.("scroll", schedule);
      if (frame !== null) windowRef.cancelAnimationFrame?.(frame);
      properties.forEach((name, index) => {
        if (style.getPropertyValue(name) !== written.get(name)) return;
        const [value, priority] = previous[index];
        if (value) style.setProperty(name, value, priority);
        else style.removeProperty(name);
      });
    },
  };
}
