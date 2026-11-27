import assert from "node:assert/strict";
import test from "node:test";
import { createNavigationSupply } from "../src/navigation-supply.js";

class Element {
  constructor(document) {
    this.ownerDocument = document;
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
  const document = { createElement: () => new Element(document) };
  const elements = Object.fromEntries(["menu", "dialog", "title", "close", "shop", "recipient", "search", "filters", "items", "empty", "give", "status"]
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
