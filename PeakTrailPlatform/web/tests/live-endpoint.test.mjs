import assert from "node:assert/strict";
import test from "node:test";
import { defaultLiveRelay } from "../src/live-endpoint.js";

test("production live and daily default to HTTPS same-origin; LAN keeps its relay", () => {
  assert.equal(defaultLiveRelay(new URL("https://peak.mylus.cn/")), "https://peak.mylus.cn");
  assert.equal(defaultLiveRelay(new URL("https://peak.example.test:444/")), "https://peak.example.test:444");
  assert.equal(defaultLiveRelay(new URL("http://192.168.1.22:4173/")), "http://192.168.1.22:8787");
  assert.equal(defaultLiveRelay(new URL("http://127.0.0.1:4173/")), "http://127.0.0.1:8787");
  assert.equal(defaultLiveRelay(new URL("file:///tmp/index.html")), "");
});
