import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [home, mods, guide, record, css] = await Promise.all(
  ["../index.html", "../mods.html", "../guide.html", "../record.html", "../home.css"].map(read));
const release = JSON.parse(await read("../../data/packet-replay/release.json"));

test("all public navigation and download entrypoints use the current Windows package", () => {
  assert.match(home, /href="\.\/record\.html"/);
  for (const page of [mods, guide, record]) {
    assert.ok(page.includes(release.downloadPath));
    assert.match(page, /Windows/);
    assert.match(page, /3\.0\.1/);
    for (const match of page.matchAll(/href="([^"#]+)"/g)) {
      if (match[1].includes("downloads/")) assert.equal(match[1].replace(/^\.?\//, ""), release.downloadPath);
    }
  }
  for (const page of [home, mods, guide, record])
    assert.doesNotMatch(page, /downloads\/(?:recorder|memories)\//);
});

test("navigation instructions keep room consent, retention and native replay prerequisites", () => {
  assert.match(record, /征得队友同意/);
  assert.match(record, /每位房主最近 2 份 · 最长 7 天/);
  assert.match(guide, /Windows x64/);
  assert.match(guide, /正版 PEAK 3\.0\.1/);
  assert.match(guide, /保持 Steam 登录/);
  assert.match(guide, /退出游戏/);
  assert.match(guide, /Play-Replay\.cmd/);
  assert.match(guide, /capture\.peaknet/);
  assert.match(guide, /原 Steam 游戏目录保持原样/);
});

test("a fresh page contains no recorded rooms and keeps session identity out of display", () => {
  assert.match(record, /id="navigationHistoryList"[^>]*><\/div>/);
  assert.match(record, /id="navigationFeature" hidden aria-hidden="true"/);
  assert.match(home, /id="gateReplay"[^>]*\bhidden\b[^>]*\bdisabled\b/);
  assert.match(home, /id="communityToggle"[^>]*aria-expanded="false"/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(guide, /viewport-fit=cover/);
});
