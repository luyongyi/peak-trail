import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { nativeStaminaConditions, updateNativeStaminaCanvas } from "../src/stamina-canvas.js";

const catalog = JSON.parse(await readFile(new URL("../../data/avatar-assets/26542162/catalog.json", import.meta.url), "utf8"));
const style = catalog.uiStyle.stamina;
const layout = { ratio: .5, capacity: .7, base: 1, blocked: .3, blocks: [] };
const statusValue = (id, amount, type = `Status${id}`) => ({ id, type, amount, staminaBlock: amount, extraStaminaBlock: 0 });

test("native afflictions follow serialized UI order rather than enum or packet order", () => {
  const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14];
  const status = { ready: true, values: ids.map(id => statusValue(id, .03)).reverse() };
  const result = nativeStaminaConditions(layout, status, style);
  assert.deepEqual(result.map(entry => entry.native.id), [7, 1, 2, 0, 3, 4, 6, 8, 5, 9, 10, 11, 12, 14]);
  assert.deepEqual(result.map(entry => entry.width), ids.map(() => 18));
});

test("the installed 15-unit visual minimum does not alter recorded capacity or display threshold", () => {
  assert.equal(style.layout.conditions.minimumWidth, 15, "Use the installed scene, not the C# default of 60");
  const status = { ready: true, values: [statusValue(7, .01), statusValue(1, .010001), statusValue(2, .02), statusValue(0, .1)] };
  const before = JSON.stringify({ layout, status });
  const result = nativeStaminaConditions(layout, status, style);
  assert.deepEqual(result.map(entry => [entry.native.id, entry.width]), [[1, 15], [2, 15], [0, 60]]);
  assert.equal(JSON.stringify({ layout, status }), before);
});

test("unknown normal capacity or unsynchronized conditions cannot invent ailment blocks", () => {
  const status = { ready: true, values: [statusValue(0, .2), statusValue(999, .3)] };
  assert.deepEqual(nativeStaminaConditions({ ...layout, capacity: null }, status, style), []);
  assert.deepEqual(nativeStaminaConditions(layout, { ...status, ready: false }, style), []);
  assert.deepEqual(nativeStaminaConditions(layout, null, style), []);
  assert.deepEqual(nativeStaminaConditions(layout, { ready: true, values: [statusValue(999, .3)] }, style), []);
});

test("petrification uses the separate extra bar and survives unknown ordinary capacity", () => {
  const status = { ready: true, values: [statusValue(0, .3, "Injury"),
    { id: 13, type: "Petrify", amount: .2, staminaBlock: 0, extraStaminaBlock: .2 }] };
  const main = nativeStaminaConditions(layout, status, style);
  const extra = nativeStaminaConditions({ ...layout, capacity: null }, status, style, true);
  assert.deepEqual(main.map(entry => [entry.native.id, entry.width]), [[0, 180]]);
  assert.equal(extra.length, 1); assert.equal(extra[0].native.isPetrify, true); assert.equal(extra[0].width, 120);
  assert.deepEqual(nativeStaminaConditions(layout, { ready: true, values: [statusValue(0, .3, "Injury")] }, style, true), []);
});

function imageFixture(t) {
  const previous = { document: globalThis.document, Image: globalThis.Image };
  const pending = [];
  class FakeCanvas {
    constructor() { this.width = 1; this.height = 1; this.hidden = false; this.style = {}; this.draws = []; }
    getContext() {
      return { drawImage: (...args) => this.draws.push(args),
        getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }),
        putImageData() {}, scale() {} };
    }
  }
  class FakeImage {
    constructor() { this.naturalWidth = 2; this.naturalHeight = 2; }
    set src(value) { this.url = value; pending.push(this); }
  }
  globalThis.document = { createElement: () => new FakeCanvas() };
  globalThis.Image = FakeImage;
  t.after(() => { globalThis.document = previous.document; globalThis.Image = previous.Image; });
  const keys = ["staminaFill", "staminaOutline", "staminaBacking", "staminaNoise", "staminaDetail",
    "extraStaminaFill", "extraStaminaOutline", "extraStaminaIcon"];
  const pack = (id, conditions = []) => {
    const assets = [...new Set([...keys, ...conditions.flatMap(entry => [entry.uiKey, entry.fillUiKey, entry.outlineUiKey])])];
    return { catalogUrl: new URL(`https://example.test/${id}/catalog.json`),
      ui: Object.fromEntries(assets.map(key => [key, `${key}.png`])),
      catalog: { uiStyle: { stamina: { ...style, conditions,
        images: Object.fromEntries(assets.map(key => [key, { color: [1, 1, 1, 1], border: [0, 0, 0, 0], size: [2, 2] }])) } } } };
  };
  const load = id => { for (const image of pending.filter(image => image.url.includes(`/${id}/`))) image.onload(); };
  return { target: new FakeCanvas(), pack, load };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const model = { main: layout, extra: { ...layout, ratio: 0, capacity: 1, blocked: 0 }, status: null };

test("a late texture load cannot restore art from the previous build", async t => {
  const f = imageFixture(t), oldPack = f.pack("old"), nextPack = f.pack("next"), results = [];
  updateNativeStaminaCanvas(f.target, oldPack, model, ready => results.push(["old", ready]));
  updateNativeStaminaCanvas(f.target, nextPack, model, ready => results.push(["next", ready]));
  f.load("old"); await flush();
  assert.equal(f.target.hidden, true); assert.equal(f.target.draws.length, 0);
  assert.deepEqual(results.filter(([, ready]) => ready), []);
  f.load("next"); await flush();
  assert.equal(f.target.hidden, false); assert.ok(f.target.draws.length > 0);
  assert.deepEqual(results.filter(([, ready]) => ready), [["next", true]]);
});

test("losing synchronized player data cancels an in-flight native image render", async t => {
  const f = imageFixture(t), pack = f.pack("pending"), results = [];
  updateNativeStaminaCanvas(f.target, pack, model, ready => results.push(ready));
  updateNativeStaminaCanvas(f.target, pack, { main: { ...layout, ratio: null }, extra: { ...layout, ratio: null }, status: null }, ready => results.push(ready));
  f.load("pending"); await flush();
  assert.equal(f.target.hidden, true); assert.equal(f.target.draws.length, 0);
  assert.equal(results.includes(true), false);
});

test("native geometry keeps the icon above its affliction and bonus stamina shorter than the main outline", async t => {
  const f = imageFixture(t), injury = style.conditions.find(entry => entry.id === 0 && !entry.isPetrify);
  const pack = f.pack("geometry", [injury]);
  updateNativeStaminaCanvas(f.target, pack, { main: { ...layout, capacity: .8, blocked: .2 },
    extra: { ...layout, ratio: .2, capacity: 1, blocked: 0 },
    status: { ready: true, statusSum: .2, values: [statusValue(0, .2, "Injury")] } }, () => {});
  f.load("geometry"); await flush();
  const mainOutline = f.target.draws.find(([, , , width, height]) => width === 614 && height === 44);
  const icon = f.target.draws.find(([, , , width, height]) => width === 34 && height === 30);
  const extraOutline = f.target.draws.find(([, , , width, height]) => width === 132 && height === 45);
  assert.ok(mainOutline); assert.ok(icon); assert.ok(extraOutline);
  assert.ok(icon[2] + 30 < mainOutline[2], "The status icon belongs above the bar, not inside its colored block");
  assert.equal(extraOutline[1], 47, "The bonus bar retains its native indentation");
  assert.ok(extraOutline[3] < mainOutline[3]);
});

test("pending samples coalesce to the latest state and identical observations do not repaint", async t => {
  const f = imageFixture(t), pack = f.pack("latest"), ready = [];
  updateNativeStaminaCanvas(f.target, pack, { ...model, main: { ...layout, ratio: .1 } }, result => ready.push(result));
  const latest = { ...model, main: { ...layout, ratio: .7 } };
  updateNativeStaminaCanvas(f.target, pack, latest, result => ready.push(result));
  f.load("latest"); await flush();
  assert.deepEqual(ready.filter(Boolean), [true]);
  assert.ok(f.target.draws.some(([, , , width, height]) => width === 420 && height === 33));
  assert.ok(!f.target.draws.some(([, , , width, height]) => width === 60 && height === 33));
  const draws = f.target.draws.length;
  updateNativeStaminaCanvas(f.target, pack, latest, result => ready.push(result));
  await flush();
  assert.equal(f.target.draws.length, draws);
  assert.deepEqual(ready.filter(Boolean), [true]);
});

test("petrification keeps its native right-side icon and does not invent a blue extra backing", async t => {
  const f = imageFixture(t), petrify = style.conditions.find(entry => entry.isPetrify);
  updateNativeStaminaCanvas(f.target, f.pack("stone", [petrify]), { ...model,
    extra: { ...layout, ratio: .2, capacity: .7, blocked: .3 },
    status: { ready: true, values: [{ id: 13, type: "Petrify", extraStaminaBlock: .3 }] } }, () => {});
  f.load("stone"); await flush();
  const icon = f.target.draws.find(([, , , width, height]) => width === 39.1 && height === 39.1);
  assert.ok(icon); assert.equal(icon[1], 661); assert.equal(icon[2], 54.55);
  assert.ok(!f.target.draws.some(([, x, , width, height]) => x === 53 && width === 600 && height === 33));
});

test("small positive stamina is retained using the scene's zero visibility threshold", async t => {
  const f = imageFixture(t);
  updateNativeStaminaCanvas(f.target, f.pack("low"), { ...model, main: { ...layout, ratio: .02 } }, () => {});
  f.load("low"); await flush();
  assert.ok(f.target.draws.some(([, , , width, height]) => width === 12 && height === 33));
});
