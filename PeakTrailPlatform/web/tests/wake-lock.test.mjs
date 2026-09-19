import assert from "node:assert/strict";
import test from "node:test";
import { createWakeLock } from "../src/wake-lock.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeNavigator({ supported = true } = {}) {
  const sentinels = [];
  const navigatorRef = {
    requestCalls: 0,
    requestTypes: [],
    async request(type) {
      navigatorRef.requestCalls += 1;
      navigatorRef.requestTypes.push(type);
      if (!supported) {
        const error = new Error("denied");
        error.name = "NotAllowedError";
        throw error;
      }
      const sentinel = {
        type,
        released: false,
        releaseListeners: [],
        release() {
          if (sentinel.released) return Promise.resolve();
          sentinel.released = true;
          sentinel.releaseListeners.forEach((listener) => listener());
          return Promise.resolve();
        },
        addEventListener(_name, listener) { sentinel.releaseListeners.push(listener); },
      };
      sentinels.push(sentinel);
      return sentinel;
    },
  };
  if (supported) navigatorRef.wakeLock = navigatorRef;
  return { navigatorRef, sentinels };
}

function fakeDocument(initial = "visible") {
  return { visibilityState: initial };
}

test("wake lock requests the screen while desired and releases on setDesired(false)", async () => {
  const { navigatorRef, sentinels } = fakeNavigator();
  const lock = createWakeLock({ navigatorRef, documentRef: fakeDocument() });
  assert.equal(lock.supported(), true);
  assert.equal(lock.held, false);

  lock.setDesired(true);
  await tick();
  assert.equal(navigatorRef.requestCalls, 1);
  assert.deepEqual(navigatorRef.requestTypes, ["screen"]);
  assert.equal(lock.held, true);

  lock.setDesired(false);
  await tick();
  assert.equal(lock.held, false);
  assert.equal(sentinels[0].released, true, "sentinel.release() called so the screen may sleep");
});

test("wake lock stays idle when the API is missing (HTTP LAN or old browser)", async () => {
  const lock = createWakeLock({ navigatorRef: {}, documentRef: fakeDocument() });
  assert.equal(lock.supported(), false);
  lock.setDesired(true);
  await tick();
  assert.equal(lock.held, false, "no crash, no lock when navigator.wakeLock is absent");
});

test("wake lock waits for a visible page and re-acquires on visibility change", async () => {
  const { navigatorRef } = fakeNavigator();
  const documentRef = fakeDocument("hidden");
  const lock = createWakeLock({ navigatorRef, documentRef });

  lock.setDesired(true);
  await tick();
  assert.equal(lock.held, false, "hidden pages must not request a wake lock");

  documentRef.visibilityState = "visible";
  lock.handleVisibilityChange();
  await tick();
  assert.equal(lock.held, true, "returning to the foreground acquires the pending lock");
});

test("wake lock re-acquires after the system released it", async () => {
  const { navigatorRef, sentinels } = fakeNavigator();
  const lock = createWakeLock({ navigatorRef, documentRef: fakeDocument() });
  lock.setDesired(true);
  await tick();
  assert.equal(lock.held, true);

  // 系统侧释放（切后台 / 省电模式）：sentinel 触发 release 事件。
  sentinels[0].release();
  assert.equal(lock.held, false);
  assert.equal(lock.desired, true, "desire persists across a system release");

  lock.handleVisibilityChange();
  await tick();
  assert.equal(navigatorRef.requestCalls, 2, "a fresh sentinel is requested");
  assert.equal(lock.held, true);
});

test("wake lock discards an in-flight request when the desire is revoked", async () => {
  const { navigatorRef, sentinels } = fakeNavigator();
  const lock = createWakeLock({ navigatorRef, documentRef: fakeDocument() });
  lock.setDesired(true);
  lock.setDesired(false); // 申请尚在途中
  await tick();
  assert.equal(lock.held, false);
  assert.equal(sentinels[0]?.released, true, "late sentinel is released immediately, never left dangling");
});

test("wake lock reports state changes through onChange", async () => {
  const { navigatorRef } = fakeNavigator();
  const changes = [];
  const lock = createWakeLock({
    navigatorRef,
    documentRef: fakeDocument(),
    onChange: () => changes.push(lock.held),
  });
  lock.setDesired(true);
  await tick();
  lock.setDesired(false);
  await tick();
  assert.deepEqual(changes, [true, false]);
});

test("wake lock tolerates denied requests and retries on the next desire bump", async () => {
  const { navigatorRef } = fakeNavigator({ supported: false });
  let denied = true;
  navigatorRef.wakeLock = { request: async () => { if (denied) throw new Error("low power mode"); } };
  const lock = createWakeLock({ navigatorRef, documentRef: fakeDocument() });
  lock.setDesired(true);
  await tick();
  assert.equal(lock.held, false, "denied request leaves no lock and no crash");
  // 省电模式结束后：再次 setDesired(true) 重试（same-value retry path）。
  denied = false;
  navigatorRef.wakeLock.request = async () => ({ release: async () => {}, addEventListener: () => {} });
  lock.setDesired(true);
  await tick();
  assert.equal(lock.held, true);
});
