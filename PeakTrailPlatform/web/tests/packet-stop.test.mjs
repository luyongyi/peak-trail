import assert from "node:assert/strict";
import test from "node:test";
import { createPacketStop } from "../src/packet-stop.js";

const roomCode = "PD527J2F", featureCode = "0123456789ABCDEF0123", id = `${roomCode}.${featureCode}`;
const session = "/api/packet-replay/session";
const stop = `/api/packet-replay/captures/${roomCode}/${featureCode}/stop`;
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
const stopAccepted = () => response(202, { roomCode, featureCode, status: "stopping" });
const sessionInfo = authenticated => response(200, { configured: true, authenticated });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(reply) {
  const names = [
    "group", "button", "buttonLabel", "menu", "dialog", "form", "title", "description", "authorization",
    "codeLabel", "code", "status", "cancel", "confirm",
  ];
  const elements = Object.fromEntries(names.map(name => [name, new EventTarget()]));
  const calls = [];
  const summary = { focus() { summary.focused = true; } };
  elements.menu.querySelector = () => summary;
  elements.code.focus = () => { elements.code.focused = true; };
  elements.dialog.showModal = () => { elements.dialog.open = true; };
  elements.dialog.close = () => { elements.dialog.open = false; elements.dialog.dispatchEvent(new Event("close")); };
  const client = createPacketStop({
    ...elements, translate: (_, english) => english,
    fetchImpl(path, options) {
      calls.push({ path, method: options.method, body: options.body });
      return reply(path, options);
    },
  });
  const click = name => elements[name].dispatchEvent(new Event("click"));
  const submit = () => elements.form.dispatchEvent(new Event("submit", { cancelable: true }));
  return { ...elements, client, calls, click, submit, summary };
}

test("opens stop only for an active capture and targets that exact capture after confirmation", async () => {
  const f = fixture(path => path === session ? sessionInfo(true) : stopAccepted());
  f.client.update(id, "completed");
  assert.equal(f.group.hidden, true); f.click("button");
  assert.equal(f.calls.length, 0);
  f.client.update(id, "recording");
  assert.equal(f.group.hidden, false); f.click("button");
  await tick();
  assert.equal(f.dialog.open, true);
  assert.equal(f.authorization.hidden, true);
  assert.deepEqual(f.calls, [{ path: session, method: "GET", body: undefined }]);
  f.click("cancel");
  assert.equal(f.calls.length, 1);
  assert.equal(f.summary.focused, true);
  f.click("button"); await tick(); f.submit(); f.submit(); await tick();
  assert.deepEqual(f.calls.slice(2), [{ path: stop, method: "POST", body: undefined }]);
  assert.equal(f.dialog.open, false);
  assert.equal(f.button.disabled, true);
  f.client.update(id, "stopping");
  assert.equal(f.group.hidden, true);
});

test("expired admin session prompts on the map and stops once authenticated", async () => {
  let allowStop = false;
  const f = fixture((path, options) => {
    if (path === session && options.method === "GET") return sessionInfo(true);
    if (path === session) {
      if (JSON.parse(options.body).accessCode !== "fake valid code") return response(401);
      allowStop = true; return sessionInfo(true);
    }
    return allowStop ? stopAccepted() : response(401);
  });
  f.client.update(id, "connecting"); f.click("button"); await tick(); f.submit(); await tick();
  assert.equal(f.authorization.hidden, false);
  assert.equal(f.code.focused, true);
  f.code.value = "bad code"; f.submit(); await tick();
  assert.match(f.status.textContent, /Incorrect access code/);
  assert.equal(f.calls.filter(call => call.path === stop).length, 1);
  f.code.value = "fake valid code"; f.submit(); await tick();
  assert.equal(f.calls.filter(call => call.path === stop).length, 2);
  assert.equal(f.code.value, "");
  assert.equal(f.dialog.open, false);
});

test("changing views during admin unlock cannot stop either capture", async () => {
  let finishLogin;
  const f = fixture((path, options) => {
    if (path === session && options.method === "GET") return sessionInfo(false);
    return new Promise(resolve => { finishLogin = resolve; });
  });
  f.client.update(id, "recording"); f.click("button"); await tick();
  assert.equal(f.authorization.hidden, false);
  f.code.value = "fake code"; f.submit();
  f.client.update(id, "completed");
  finishLogin(sessionInfo(true)); await tick();
  assert.equal(f.dialog.open, false);
  assert.equal(f.calls.filter(call => call.path === stop).length, 0);
});
