import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../home.css", import.meta.url), "utf8");
const plugin = await readFile(new URL("../../../PeakTrailRecorder/src/PeakTrailRecorder/Plugin.cs", import.meta.url), "utf8");
const project = await readFile(new URL("../../../PeakTrailRecorder/src/PeakTrailRecorder/PeakTrailRecorder.csproj", import.meta.url), "utf8");
const release = JSON.parse(await readFile(new URL("../../data/recorder/release.json", import.meta.url), "utf8"));
const version = plugin.match(/RecorderVersion = "([^"]+)"/)[1];
const download = `./${release.downloadPath}`;
const guide = html.match(/<section class="home-guide"[\s\S]*?<\/section>/)[0];

test("homepage exposes a version-matched DLL download in navigation and the install guide", () => {
  assert.equal(release.version, version);
  assert.equal(project.match(/<Version>([^<]+)<\/Version>/)[1], version);
  assert.equal(release.downloadPath, `downloads/recorder/${version}/PeakTrailRecorder.dll`);
  assert.equal(release.artifactUrl, `https://github.com/luyongyi/peak-trail/releases/download/recorder-v${version}/PeakTrailRecorder.dll`);
  const nav = html.match(/<nav class="home-actions"[\s\S]*?<\/nav>/)[0];
  assert.ok(nav.includes(`href="${download}"`));
  assert.ok(nav.includes('href="#homeGuide"'));
  assert.ok(guide.includes(`href="${download}"`));
  assert.ok(guide.includes(`v${version}`));
  assert.ok(guide.includes(`${release.size / 1024} KiB`));
  assert.match(guide, /id="homeGuide" aria-labelledby="homeGuideTitle"/);
  assert.ok(guide.includes(`download="${release.filename}"`));
  assert.ok(nav.includes(`download="${release.filename}"`));
  assert.ok(guide.includes(release.artifactUrl));
});

test("three install steps cover official prerequisites, DLL placement and local replay", () => {
  const steps = guide.match(/<ol class="home-guide-steps">[\s\S]*?<\/ol>/)[0];
  assert.equal((steps.match(/<li>/g) || []).length, 3);
  assert.match(steps, /github\.com\/BepInEx\/BepInEx\/releases\/tag\/v5\.4\.23\.3/);
  assert.match(steps, /Windows x64/);
  assert.match(steps, /关闭游戏/);
  assert.match(steps, /PEAK\.exe/);
  assert.match(steps, /BepInEx\/plugins\//);
  assert.match(steps, /BepInEx\/PeakTrailRecordings\//);
  assert.match(steps, /PeakTrailHistory\.ndjson/);
  assert.match(guide, /iPad 回放需先把日志文件传到设备/);
});

test("optional live instructions preserve local recording and disclose real upload behavior", () => {
  assert.match(guide, /可选 · 默认关闭/);
  assert.match(guide, /\[Recording\]\s*\nEnabled = true\s*\n\s*\n\[Live\]\s*\nEnabled = true\s*\nServerUrl = https:\/\/peak\.mylus\.cn/);
  assert.match(guide, /征得同局玩家同意/);
  assert.match(guide, /昵称、稳定玩家 ID、位置与游戏状态/);
  assert.match(guide, /能访问本网站的人可观看/);
  assert.match(html, /本地导入不上传 · 直播需主动开启/);
  assert.doesNotMatch(html, /日志只在本机解析，不上传/);
});

test("guide keeps keyboard-visible links and native collapsible advanced help", () => {
  assert.equal((guide.match(/<details>/g) || []).length, 3);
  assert.doesNotMatch(guide, /<details\s+open/);
  assert.match(css, /\.home-page a:focus-visible/);
  assert.match(css, /\.home-actions a[^{]+\{ min-height: 44px/);
  assert.match(css, /\.home-guide-steps \{ grid-template-columns: 1fr; \}/);
});
