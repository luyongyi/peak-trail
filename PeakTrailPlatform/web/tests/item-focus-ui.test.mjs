import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { tr } from "../src/i18n.js";
import { UI_TEXT } from "../src/ui-text.js";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const source = app.match(/^function bindMapLootFocusUi\([^]*?^\}/m)?.[0];
assert.ok(source, "app exposes a small focus-card binding independent of map loading");
const bind = new Function("tr", `${source}; return bindMapLootFocusUi;`)(tr);

function node() {
  const listeners = new Map();
  return {
    hidden: true, dataset: {}, textContent: "", focusCalls: [],
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, detail) { for (const callback of listeners.get(type) || []) callback({ detail }); },
    key(event) { for (const callback of listeners.get("keydown") || []) callback(event); },
    click() { for (const callback of listeners.get("click") || []) callback({}); },
    focus(options) { this.focusCalls.push(options); },
    listenerCount() { return [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); },
  };
}

function fixture() {
  const canvas = node(), card = node(), name = node(), restoreButton = node(), menu = { open: true };
  const calls = [];
  const dispose = bind({ canvas, card, name, restoreButton, menu,
    getViewer: () => ({ restoreMapLootView() { calls.push("restore"); canvas.emit("peaktrail-loot-focus", { active: false }); },
      fitView() { throw new Error("Restoring a marker view must not refit the map"); },
      setData() { throw new Error("Restoring a marker view must not reload data"); } }) });
  return { canvas, card, name, restoreButton, menu, dispose, calls };
}

test("a marker focus event reveals its localized name; updates preserve the focus and return restores once", () => {
  const ui = fixture();
  ui.canvas.emit("peaktrail-loot-focus", { active: true, markerId: "point-17", name: "治疗菇生成点", category: "item" });
  assert.equal(ui.card.hidden, false);
  assert.equal(ui.card.dataset.markerId, "point-17");
  assert.equal(ui.name.textContent, "治疗菇生成点");
  assert.equal(ui.name.title, "治疗菇生成点");
  assert.equal(ui.menu.open, false, "a new close-up folds the menu away from the model");
  assert.deepEqual(ui.calls, [], "showing the UI never takes over the camera");
  ui.menu.open = true;
  ui.canvas.emit("peaktrail-loot-focus", { active: true, markerId: "point-17", name: "REMEDY FUNGUS spawn site" });
  assert.equal(ui.card.hidden, false);
  assert.equal(ui.card.dataset.markerId, "point-17");
  assert.equal(ui.name.textContent, "REMEDY FUNGUS spawn site");
  assert.deepEqual(ui.calls, [], "a language refresh only repaints the name");
  assert.equal(ui.menu.open, true, "a language refresh does not close a menu the user reopened");
  ui.restoreButton.click();
  assert.deepEqual(ui.calls, ["restore"]);
  assert.equal(ui.card.hidden, true);
  assert.equal(ui.card.dataset.markerId, "");
  assert.equal(ui.name.textContent, "");
  assert.deepEqual(ui.canvas.focusCalls, [{ preventScroll: true }]);
  ui.restoreButton.click();
  assert.deepEqual(ui.calls, ["restore"], "inactive clicks cannot restore stale views");
  ui.dispose();
});

test("Escape is scoped to the canvas and focus card and respects input and consumed events", () => {
  const ui = fixture();
  ui.canvas.emit("peaktrail-loot-focus", { active: true, markerId: "box", name: "LUGGAGE" });
  function key(overrides = {}) { return { key: "Escape", target: { closest: () => null }, prevented: 0, stopped: 0,
    preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...overrides }; }
  ui.card.key(key({ target: { closest: () => ({ tagName: "INPUT" }) } }));
  ui.canvas.key(key({ defaultPrevented: true }));
  ui.canvas.key(key({ key: "Enter" }));
  assert.deepEqual(ui.calls, []);
  const event = key();
  ui.card.key(event);
  assert.deepEqual(ui.calls, ["restore"]);
  assert.equal(event.prevented, 1);
  assert.equal(event.stopped, 1);
  ui.dispose();
});

test("focus UI disposal hides the card and removes all listeners", () => {
  const ui = fixture();
  ui.canvas.emit("peaktrail-loot-focus", { active: true, markerId: "a", name: "<b>user-provided text</b>" });
  assert.equal(ui.name.textContent, "<b>user-provided text</b>", "the name uses plain text");
  ui.dispose();
  assert.equal(ui.card.hidden, true);
  assert.equal(ui.canvas.listenerCount() + ui.card.listenerCount() + ui.restoreButton.listenerCount(), 0);
  ui.canvas.emit("peaktrail-loot-focus", { active: true, markerId: "b", name: "Ignored" });
  ui.restoreButton.click();
  assert.equal(ui.card.hidden, true);
  assert.deepEqual(ui.calls, []);
});

test("marker controls explain the interaction in both languages and remain separate from type filters", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<canvas id="sceneCanvas" tabindex="0">/);
  assert.match(html, /id="mapLootFocus"[^>]*hidden/);
  assert.match(html, /id="mapLootFocusReturn" type="button"/);
  for (const chinese of ["点击地图标记，靠近查看；再次点击返回", "标记特写", "已靠近此标记", "再点一次标记可返回", "返回靠近前的视角", "返回原视角"]) {
    assert.ok(html.includes(chinese));
    assert.ok(UI_TEXT.has(chinese));
    assert.doesNotMatch(UI_TEXT.get(chinese), /\p{Script=Han}/u);
  }
  assert.equal(UI_TEXT.get("返回原视角"), "Return to previous view");
  assert.doesNotMatch(source, /fitView|setActiveSegment|setData|mapLootPanel|selectedTypes|checked|addEventListener\("change"/);
});
