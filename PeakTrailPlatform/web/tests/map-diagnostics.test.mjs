import test from "node:test";
import assert from "node:assert/strict";
import { mountMapDiagnostics, sanitizeMapDiagnostics } from "../src/map-diagnostics.js";

function fixture(saved = null, { storageFailure = false, copyFailure = false } = {}) {
  class Element extends EventTarget {
    style = {}; children = []; textContent = ""; open = false;
    append(...children) { this.children.push(...children); }
    remove() { this.removed = true; }
  }
  const copied = [], timers = new Set(), data = new Map(saved ? [["peaktrail.map-diagnostics.v1", saved]] : []);
  const view = {
    sessionStorage: { getItem: key => { if (storageFailure) throw Error(); return data.get(key); },
      setItem: (key, value) => { if (storageFailure) throw Error(); data.set(key, value); } },
    navigator: { clipboard: { async writeText(text) { if (copyFailure) throw Error(); copied.push(text); } } },
    setInterval(callback) { timers.add(callback); return callback; }, clearInterval(callback) { timers.delete(callback); },
    getSelection: () => null,
  };
  const document = { defaultView: view, visibilityState: "visible", createElement: () => new Element(),
    createRange: () => ({ selectNodeContents() {} }) };
  const canvas = new Element(); canvas.ownerDocument = document; canvas.parentElement = new Element();
  let rendering = { status: "initializing" };
  const diagnostics = mountMapDiagnostics(canvas, { getRenderDiagnostics: () => rendering });
  const panel = canvas.parentElement.children[0], [, , output, copy] = panel.children;
  return { panel, output, copy, timers, copied, diagnostics,
    state: () => JSON.parse(output.textContent),
    emit(name, detail) { canvas.dispatchEvent(new CustomEvent(name, { detail })); },
    render(status) { rendering = { status, drawingWidth: 1200, drawingHeight: 900 }; this.emit("peaktrail-render-status", { status, diagnostics: rendering }); },
  };
}

test("diagnostics accept bounded metrics and never retain source, identity or exception text", () => {
  const state = sanitizeMapDiagnostics({ mapStatus: "loading", phase: "parse", segment: 0, elapsedMs: 25,
    roomCode: "SECRET", url: "https://private", loadedBytes: 100, totalBytes: 2 ** 50,
    rendering: { status: "render-error", errorName: "private-name", error: "SECRET", drawingWidth: 1200,
      drawingHeight: Infinity, pixelRatio: 1.25, contextLost: true, privateToken: "SECRET" } });
  assert.equal(state.loadedBytes, 100); assert.equal(state.totalBytes, undefined);
  assert.deepEqual(state.rendering, { status: "render-error", drawingWidth: 1200, pixelRatio: 1.25, contextLost: true });
  assert.ok(!JSON.stringify(state).includes("SECRET")); assert.ok(!JSON.stringify(state).includes("private"));
});

test("a rendered grid does not mark a model ready; later map completion does", () => {
  const f = fixture();
  f.emit("peaktrail-map-status", { status: "loading", segment: 0 });
  f.render("ready");
  f.emit("peaktrail-geometry-progress", { stage: "parse", segment: 0, loadedBytes: 6000 });
  assert.equal(f.state().mapStatus, "loading"); assert.equal(f.state().phase, "parse");
  f.emit("peaktrail-geometry-progress", { stage: "batch", segment: 0 });
  assert.equal(f.state().loadedBytes, undefined);
  f.emit("peaktrail-map-status", { status: "ready", segment: 0 });
  assert.equal(f.state().mapStatus, "ready"); assert.equal(f.state().phase, "ready");
  f.diagnostics.dispose();
});

test("reload keeps only safe information about an interrupted load", () => {
  const f = fixture(JSON.stringify({ mapStatus: "loading", phase: "decompress", url: "SECRET", roomCode: "SECRET", elapsedMs: 5000 }));
  assert.equal(f.state().previousInterruptedLoad.phase, "decompress");
  assert.ok(!f.output.textContent.includes("SECRET"));
  f.diagnostics.dispose();
  const completed = fixture(JSON.stringify({ mapStatus: "ready", phase: "ready" }));
  assert.equal(completed.state().previousInterruptedLoad, undefined); completed.diagnostics.dispose();
});

test("graphics interruption exposes copyable diagnostics and dispose stops updates", async () => {
  const f = fixture(); f.render("context-lost"); assert.equal(f.panel.open, true);
  f.copy.dispatchEvent(new Event("click")); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.copied.length, 1); assert.equal(JSON.parse(f.copied[0]).rendering.status, "context-lost");
  const text = f.output.textContent;
  f.diagnostics.dispose(); assert.equal(f.timers.size, 0); assert.equal(f.panel.removed, true);
  f.emit("peaktrail-map-status", { status: "error" }); assert.equal(f.output.textContent, text);
});

test("unavailable storage, malformed saved data and denied clipboard cannot break loading", async () => {
  for (const saved of ["{", "x".repeat(5000)]) { const f = fixture(saved); f.diagnostics.dispose(); }
  const f = fixture(null, { storageFailure: true, copyFailure: true });
  f.emit("peaktrail-map-status", { status: "loading", segment: 0 });
  f.copy.dispatchEvent(new Event("click")); await new Promise(resolve => setImmediate(resolve));
  assert.match(f.copy.textContent, /长按/); assert.equal(f.state().mapStatus, "loading"); f.diagnostics.dispose();
});
