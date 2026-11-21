import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [home, mods, guide, record, css] = await Promise.all(
  ["../index.html", "../mods.html", "../guide.html", "../record.html", "../home.css"].map(read));
const release = JSON.parse(await read("../../data/packet-replay/release.json"));

test("all public navigation and download entrypoints use the current Windows package", () => {
  const header = home.match(/<header class="home-header">[\s\S]*?<\/header>/)?.[0];
  const services = home.match(/<nav class="home-services"[^>]*>([\s\S]*?)<\/nav>/);
  assert.doesNotMatch(header, /href="\.\/(?:record|mods)\.html"/);
  assert.ok(services);
  assert.ok(home.indexOf('id="homeLandscape"') < services.index);
  assert.ok(services.index < home.indexOf('<footer class="home-footer">'));
  assert.deepEqual([...services[1].matchAll(/<a[^>]+href="([^"]+)"/g)].map(match => match[1]), ["./record.html"]);
  assert.match(services[0], /aria-labelledby="homeNavigationName"/);
  assert.match(services[1], /id="homeNavigationName">Peak导航<\/strong>/);
  assert.match(services[1], /class="home-service-icon" aria-hidden="true">\s*<svg\b/);
  assert.doesNotMatch(home, /href="(?:\.\/mods\.html|[^"]*peak-packet-replay-windows\.zip)"/);
  assert.match(header, /class="gate-brand"[\s\S]*?id="homeTitle">今日地图<\/h1>[\s\S]*?class="home-actions"/);
  assert.match(home, /<section class="home-route"[^>]*aria-labelledby="homeTitle">/);
  assert.match(record, /<header class="record-header">[\s\S]*?href="#windowsReplay"[\s\S]*?返回地图[\s\S]*?<\/header>/);
  assert.match(record, /<div class="record-tools">[\s\S]*?id="navigationForm"[\s\S]*?id="replaySearchForm"[\s\S]*?id="windowsReplay"[\s\S]*?href="\/downloads\/peak-packet-replay-windows\.zip"[\s\S]*?id="replaySearchResults"[\s\S]*?id="navigationHistoryPanel"/);
  for (const page of [mods, guide, record]) {
    assert.ok(page.includes(release.downloadPath));
    assert.match(page, /Windows/);
    assert.match(page, /PEAK 3\.1\.0/);
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
  assert.match(guide, /正版 PEAK 3\.1\.0/);
  assert.match(guide, /3\.0\.1 录像需要 PEAK 3\.0\.1 和对应的旧版组件/);
  assert.ok(guide.includes('href="https://github.com/luyongyi/peak-trail/releases/download/packet-replay-windows-2026.11.09.2/peak-packet-replay-windows.zip"'));
  assert.match(guide, /保持 Steam 登录/);
  assert.match(guide, /退出游戏/);
  assert.match(guide, /BepInEx 5/);
  assert.match(guide, /主菜单按 F8/);
  assert.match(guide, /浏览本地 ZIP/);
  for (const page of [mods, guide, record]) assert.doesNotMatch(page, /Play-Replay\.cmd|独立回放副本|复制本机游戏资源/);
});

test("a fresh page contains no recorded rooms and keeps session identity out of display", () => {
  assert.match(record, /id="navigationHistoryList"[^>]*><\/div>/);
  assert.match(record, /id="navigationFeature" hidden aria-hidden="true"/);
  assert.match(home, /id="gateReplay"[^>]*\bhidden\b[^>]*\bdisabled\b/);
  assert.match(home, /id="communityToggle"[^>]*aria-expanded="false"/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(guide, /viewport-fit=cover/);
});
