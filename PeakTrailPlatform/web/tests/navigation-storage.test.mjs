import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mountNavigationStorage, storagePresentation } from "../src/navigation-storage.js";
import { errorMessage } from "../src/packet-recorder.js";

const usage = { recordingBytes: 1.5 * 1024 ** 3, estimatedRemainingCaptures: 1240, canStart: true };

test("recording usage and estimates remain distinct from the minimum-space warning", () => {
  const normal = storagePresentation(usage);
  assert.equal(normal.estimate, "预计还能存约 1,240 局");
  assert.equal(normal.used, "录像已占用 1.5 GiB");
  assert.match(storagePresentation({ ...usage, averageCaptureBytes: 80 * 1024 ** 2, sampleSize: 0 }).title, /80 MiB/);
  assert.equal(storagePresentation({ ...usage, estimatedRemainingCaptures: null }).state, "available");
  const zero = storagePresentation({ ...usage, estimatedRemainingCaptures: 0 });
  assert.equal(zero.state, "available");
  assert.match(zero.estimate, /平均大小/);
  assert.equal(storagePresentation({ ...usage, canStart: false }).state, "limited");
  assert.equal(storagePresentation({ ...usage, recordingBytes: -1 }).state, "unavailable");
  assert.match(errorMessage("capture_disk_capacity"), /录像空间不足/);
});

test("capacity is read without blocking navigation and pauses while the page is hidden", async () => {
  const elements = new Map(["navigationStorage", "navigationStorageEstimate", "navigationStorageUsed"].map(
    id => [id, { hidden: true, dataset: {}, textContent: "" }]));
  const events = new Map(), timers = new Map(), calls = [];
  let nextTimer = 0, status = 200;
  const document = { hidden: false, getElementById: id => elements.get(id), addEventListener: (event, handler) => events.set(event, handler) };
  const window = {
    addEventListener: (event, handler) => events.set(event, handler),
    fetch: async (path, options) => { calls.push({ path, options }); return new Response(JSON.stringify(usage), { status }); },
    setTimeout: (handler, delay) => { const id = ++nextTimer; timers.set(id, { handler, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const settled = () => new Promise(resolve => setImmediate(resolve));
  mountNavigationStorage(document, window);
  await settled();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/navigation/storage");
  assert.equal(calls[0].options.method ?? "GET", "GET");
  assert.equal(elements.get("navigationStorage").dataset.state, "available");
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [45000]);

  document.hidden = true;
  events.get("visibilitychange")();
  assert.equal(timers.size, 0);
  status = 503;
  document.hidden = false;
  events.get("visibilitychange")();
  await settled();
  assert.equal(calls.length, 2);
  assert.equal(elements.get("navigationStorage").dataset.state, "unavailable");
  assert.equal(elements.get("navigationStorageUsed").hidden, true);
  events.get("pagehide")();
  assert.equal(timers.size, 0);
});

test("navigation displays capacity beneath the room form as a live status", async () => {
  const html = await readFile(new URL("../record.html", import.meta.url), "utf8");
  assert.match(html, /src="\.\/src\/navigation-storage\.js"/);
  assert.match(html, /<form id="navigationForm">[\s\S]*?<\/form>\s*<div[^>]*id="navigationStorage" role="status" hidden/);
});
