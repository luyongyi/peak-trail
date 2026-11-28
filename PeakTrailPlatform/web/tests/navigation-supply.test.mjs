import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createNavigationSupply } from "../src/navigation-supply.js";
import { loadGameAssetPack, resolveItemAsset } from "../src/game-assets.js";

class Element {
  constructor(document, tagName = "") {
    this.ownerDocument = document;
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.value = "";
    this.open = false;
  }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  fire(type, target = this) { return Promise.all((this.listeners.get(type) || []).map(handler => handler({ target }))); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  contains() { return false; }
  closest() { return this; }
  getClientRects() { return [1]; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; void this.fire("close"); }
}

const captureId = "DRXPTJAB.0123456789ABCDEF0123";
const context = { captureId, sceneEpoch: 2, followsLive: true, playerId: "p3" };
const available = { enabled: true, sceneEpoch: 2,
  players: [{ playerId: "p3", name: "小王" }, { playerId: "p4", name: "小李" }],
  items: [{ itemId: 65, name: "Rope", category: "climb" }] };
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(fetchImpl) {
  const document = { createElement: tagName => new Element(document, tagName) };
  const elements = Object.fromEntries(["menu", "airportAction", "airportGroup", "dialog", "title", "close", "shop", "recipient", "recipientPicker", "recipientSelect", "search", "filters", "items", "empty", "give", "status"]
    .map(key => [key, new Element(document)]));
  const action = new Element(document);
  const api = createNavigationSupply({ ...elements, actionButtons: [action], fetchImpl });
  const select = async () => {
    await action.fire("click");
    assert.equal(elements.dialog.open, true);
    await elements.items.fire("click", elements.items.children[0]);
  };
  return { ...elements, action, api, select };
}

const gameAssetPack = {
  gameBuildId: "26542162", source: "local-unity-assets",
  catalogUrl: new URL("https://example.test/data/game-assets/26542162/catalog.json"),
  itemIndex: new Map([["65", { itemId: 65, name: "rope spool", prefabName: "RopeSpool", icon: "icons/RopeSpool.png" }]]),
  ui: { defaultIcon: "ui/default-slot.png" },
};

test("the published native build includes the exact icons for every current supply item", async () => {
  const pack = await loadGameAssetPack("26542162", {
    indexUrl: new URL("../../data/avatar-assets/catalog.json", import.meta.url),
    fetchImpl: async url => ({ ok: true, json: async () => JSON.parse(await readFile(url, "utf8")) }),
  });
  const nativeItems = [[65, "RopeSpool"], [18, "ClimbingSpike"], [63, "RopeShooter"], [0, "Airplane Food"],
    [73, "TrailMix"], [71, "Sports Drink"], [7, "Bandages"], [29, "FirstAidKit"], [23, "Compass"],
    [32, "Flare"], [45, "MagicBean"], [13, "BingBong"]];
  for (const [itemId, prefabName] of nativeItems) {
    const asset = resolveItemAsset(pack, { itemId });
    assert.equal(asset?.entry.prefabName, prefabName);
    assert.ok(asset.iconUrl, `Missing native icon for ${prefabName}`);
    const declared = pack.catalog.assets.find(entry => entry.path === asset.entry.icon);
    assert.ok(declared, `Unpublished native icon for ${prefabName}`);
    const bytes = await readFile(new URL(asset.iconUrl));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.length, declared.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), declared.sha256);
  }
});

test("native item art arriving after the dialog opens replaces empty slots and follows the selected item", async () => {
  const f = fixture(async () => response(available));
  f.api.update(context); await tick(); await f.action.fire("click");
  const missing = f.items.children[0].children.find(child => child.className === "navigation-supply-icon");
  assert.equal(missing.textContent, undefined, "missing art must not pretend a category glyph is the item");
  f.api.update({ ...context, gameAssetPack });
  const button = f.items.children[0], image = button.children.find(child => child.tagName === "img");
  const fallback = button.children.find(child => child.className === "navigation-supply-icon");
  assert.equal(image.src, "https://example.test/data/game-assets/26542162/icons/RopeSpool.png");
  assert.equal(image.hidden, true);
  await image.fire("load");
  assert.equal(image.hidden, false); assert.equal(fallback.hidden, true);
  await f.items.fire("click", button);
  const selectedImage = f.give.children.find(child => child.tagName === "img");
  assert.equal(selectedImage.src, image.src);
  assert.equal(selectedImage.className, "navigation-supply-confirm-icon");
  assert.equal(f.give.disabled, false);
});

test("a broken native image keeps its label and neutral empty slot without enlarging the native black pixel", async () => {
  const f = fixture(async () => response(available));
  f.api.update({ ...context, gameAssetPack }); await tick(); await f.action.fire("click");
  const button = f.items.children[0], image = button.children.find(child => child.tagName === "img");
  const fallback = button.children.find(child => child.className === "navigation-supply-icon");
  await image.fire("error");
  assert.equal(image.hidden, true); assert.equal(fallback.hidden, false);
  assert.equal(fallback.children.length, 0);
  assert.equal(button.children.at(-1).textContent.length > 0, true);
  await f.items.fire("click", button);
  assert.equal(f.give.disabled, false);
});

test("live supply submits once for the selected scene and actor, then reports only request sent", async () => {
  const calls = [];
  let release;
  const f = fixture(async (path, init) => {
    calls.push({ path, ...init });
    if (init.method === "GET") return response(available);
    return new Promise(resolve => { release = () => resolve(response({ orderId: JSON.parse(init.body).orderId, status: "sent" })); });
  });
  f.api.update(context);
  await tick();
  assert.equal(f.action.hidden, false);
  await f.select();
  assert.equal(f.recipient.textContent, "给 小王");
  const pending = f.give.fire("click");
  await f.give.fire("click");
  const posts = calls.filter(call => call.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `/api/navigation/captures/${captureId.replace(".", "/")}/supply`);
  assert.deepEqual(JSON.parse(posts[0].body), { orderId: JSON.parse(posts[0].body).orderId, sceneEpoch: 2, playerId: "p3", itemId: 65 });
  release();
  await pending;
  assert.equal(f.status.textContent, "请求已发出，请在游戏内查看。");
  assert.equal(f.status.dataset.state, "sent");
});

test("changing followed player or scene closes selection and never retargets an in-flight order", async () => {
  const posts = [];
  let release;
  const f = fixture(async (path, init) => {
    if (init.method === "GET") return response(available);
    const body = JSON.parse(init.body); posts.push(body);
    return new Promise(resolve => { release = () => resolve(response({ orderId: body.orderId, status: "sent" })); });
  });
  f.api.update(context); await tick(); await f.select();
  const pending = f.give.fire("click");
  f.api.update({ ...context, playerId: "p4" });
  assert.equal(f.dialog.open, false);
  release(); await pending;
  assert.equal(posts[0].playerId, "p3");
  assert.equal(f.status.textContent, "正在发送请求…");
  await f.select();
  assert.equal(f.recipient.textContent, "给 小李");
  f.api.update({ ...context, sceneEpoch: 3, playerId: "p4" });
  assert.equal(f.dialog.open, false);
  assert.equal(f.action.hidden, true);
  await f.give.fire("click");
  assert.equal(posts.length, 1);
  await tick();
  assert.equal(f.action.hidden, true);
});

test("late catalog cannot enable another capture, and historical playback cannot give items", async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = () => resolve(response(available)); }));
  f.api.update(context);
  f.api.update({ ...context, captureId: "DRXPTJAB.FFFFFFFFFFFFFFFFFFFF" });
  release(); await tick();
  assert.equal(f.action.hidden, true);
  f.api.update({ ...context, followsLive: false });
  await f.action.fire("click");
  assert.equal(f.dialog.open, false);
});

test("a lost submission response is resolved by status lookup without a second POST", async () => {
  const calls = [];
  let orderId;
  const f = fixture(async (path, init) => {
    calls.push({ path, method: init.method });
    if (init.method === "POST") { orderId = JSON.parse(init.body).orderId; throw new Error("connection lost"); }
    if (path.endsWith("/supply")) return response(available);
    assert.ok(path.endsWith("/" + orderId));
    return response({ orderId, status: "sent" });
  });
  f.api.update(context); await tick(); await f.select();
  await f.give.fire("click");
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.equal(f.status.dataset.state, "sent");
});

test("airport supply shows its sole recipient without requiring a climbing trace or camera target", async () => {
  const posts = [];
  const f = fixture(async (path, init) => {
    if (init.method === "GET") return response({ ...available, players: [available.players[0]] });
    const body = JSON.parse(init.body); posts.push(body);
    return response({ orderId: body.orderId, status: "sent" });
  });
  f.api.update({ ...context, liveAirport: true, playerId: null }); await tick();
  assert.equal(f.airportGroup.hidden, false);
  assert.equal(f.airportAction.hidden, false);
  assert.equal(f.action.hidden, true);
  await f.airportAction.fire("click");
  assert.equal(f.recipientPicker.hidden, false);
  assert.equal(f.recipientSelect.value, "p3");
  assert.equal(f.recipient.textContent, "给 小王");
  await f.items.fire("click", f.items.children[0]);
  await f.give.fire("click");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].playerId, "p3");
  assert.equal(posts[0].sceneEpoch, 2);
});

test("airport with multiple players requires an explicit current recipient and does not inherit a camera target", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const posts = [];
  const f = fixture(async (path, init) => {
    if (init.method === "GET") return response(available);
    const body = JSON.parse(init.body); posts.push(body);
    return response({ orderId: body.orderId, status: "sent" });
  });
  const airportContext = { ...context, liveAirport: true };
  f.api.update(airportContext); await tick(); await f.airportAction.fire("click");
  assert.equal(f.recipientSelect.value, "");
  assert.equal(f.give.disabled, true);
  await f.items.fire("click", f.items.children[0]);
  await f.give.fire("click");
  assert.equal(posts.length, 0);
  t.mock.timers.tick(4001); f.api.update(airportContext); await tick();
  assert.equal(f.dialog.open, true, "polling does not close an unselected airport dialog");
  f.recipientSelect.value = "p4"; await f.recipientSelect.fire("change");
  assert.equal(f.recipient.textContent, "给 小李");
  await f.items.fire("click", f.items.children[0]); await f.give.fire("click");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].playerId, "p4");
});

test("departed airport recipient closes an open selection instead of assigning another player", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  let roster = available.players;
  const posts = [];
  const f = fixture(async (path, init) => {
    if (init.method === "GET") return response({ ...available, players: roster });
    posts.push(JSON.parse(init.body)); return response({}, 400);
  });
  const airportContext = { ...context, liveAirport: true, playerId: null };
  f.api.update(airportContext); await tick(); await f.airportAction.fire("click");
  f.recipientSelect.value = "p3"; await f.recipientSelect.fire("change");
  await f.items.fire("click", f.items.children[0]);
  roster = [available.players[1]];
  t.mock.timers.tick(4001); f.api.update(airportContext); await tick();
  assert.equal(f.dialog.open, false);
  await f.give.fire("click");
  assert.equal(posts.length, 0);
  assert.equal(f.airportAction.hidden, false, "remaining players can be selected by a new explicit action");
});

test("airport-to-climb and epoch changes invalidate the recipient and hide the airport entry", async () => {
  const f = fixture(async () => response({ ...available, players: [available.players[0]] }));
  const airportContext = { ...context, liveAirport: true, playerId: null };
  f.api.update(airportContext); await tick(); await f.airportAction.fire("click");
  f.api.update({ ...context, liveAirport: false });
  assert.equal(f.dialog.open, false);
  assert.equal(f.airportAction.hidden, true);
  await tick(); await f.select();
  assert.equal(f.recipientPicker.hidden, true);
  assert.equal(f.recipient.textContent, "给 小王");
  f.api.update({ ...airportContext, sceneEpoch: 3 });
  assert.equal(f.dialog.open, false);
  assert.equal(f.airportAction.hidden, true);
  await tick();
  assert.equal(f.airportAction.hidden, true, "old readiness cannot enable a new scene");
});
