import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const guideHtml = await readFile(new URL("../guide.html", import.meta.url), "utf8");
const css = await readFile(new URL("../home.css", import.meta.url), "utf8");
const release = JSON.parse(await readFile(new URL("../../data/memories/release.json", import.meta.url), "utf8"));
const download = `./${release.downloadPath}`;
const guide = guideHtml.match(/<section class="home-guide"[\s\S]*?<\/section>/)[0];

test("the homepage downloads the advertised memories DLL without a retired guide entry", () => {
  assert.equal(release.product, "peak-memories");
  assert.match(release.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(release.filename, "PeakReplayLab.dll");
  assert.equal(release.downloadPath, `downloads/memories/${release.version}/PeakReplayLab.dll`);
  const nav = html.match(/<nav class="home-actions"[\s\S]*?<\/nav>/)[0];
  assert.ok(nav.includes(`href="${download}"`));
  assert.doesNotMatch(nav, /href="\.\/guide\.html"|安装教程/);
  assert.doesNotMatch(html, /<section class="home-guide"|id="homeGuide"/);
  assert.ok(guideHtml.includes('href="./"'));
  assert.ok(guide.includes(`href="${download}"`));
  assert.ok(guide.includes(`v${release.version}`));
  assert.ok(guide.includes(`${(release.size / 1024 ** 2).toFixed(1)} MiB`));
  assert.match(guide, /id="homeGuide" aria-labelledby="homeGuideTitle"/);
  for (const page of [html, guideHtml]) {
    const filenames = [...page.matchAll(/\bdownload="([^"]+)"/g)].map(match => match[1]);
    assert.ok(filenames.length); assert.ok(filenames.every(filename => filename === release.filename));
    assert.doesNotMatch(page, /href="[^"]*(?:downloads\/recorder|recorder-v0\.7\.1)/);
  }
});

test("download publication and source links agree with the manifest without claiming game-runtime acceptance", () => {
  assert.match(guide, /游戏内显示、性能和多人录制仍待实测/);
  assert.doesNotMatch(guide, /已验证 PEAK|已实测/);
  if (release.channel === "development") {
    assert.equal(release.releaseStatus, "unreleased"); assert.equal(release.sourceDirty, true);
    assert.ok(!release.artifactUrl); assert.ok(!release.tag);
    assert.match(guide, /站内开发预览版 · 尚未公开发布/);
    assert.doesNotMatch(guideHtml, /github\.com\/luyongyi\/peak-memories\/releases\/(?:download|tag)\//);
    assert.doesNotMatch(guide, /GitHub 备用下载|正式版/);
  } else {
    assert.equal(release.channel, "release"); assert.equal(release.releaseStatus, "published");
    assert.equal(release.sourceDirty, false); assert.equal(release.tag, "v" + release.version);
    assert.match(release.sourceRevision, /^[a-f0-9]{40}$/);
    assert.equal(release.releaseUrl, release.repositoryUrl + "/releases/tag/" + release.tag);
    assert.equal(release.artifactUrl, release.repositoryUrl + "/releases/download/" + release.tag + "/" + release.filename);
    assert.match(guide, /GitHub 已发布/);
    assert.ok(guide.includes('href="' + release.releaseUrl + '"'));
    assert.ok(guide.includes('href="' + release.artifactUrl + '"'));
    assert.doesNotMatch(guideHtml, /开发预览版|尚未公开发布/);
  }
});

test("three installation steps cover official prerequisites, the new DLL and a reversible upgrade", () => {
  const steps = guide.match(/<ol class="home-guide-steps">[\s\S]*?<\/ol>/)[0];
  assert.equal((steps.match(/<li>/g) || []).length, 3);
  assert.match(steps, /github\.com\/BepInEx\/BepInEx\/releases\/tag\/v5\.4\.23\.3/);
  assert.match(steps, /Windows x64/); assert.match(steps, /关闭游戏/); assert.match(steps, /PEAK\.exe/);
  assert.match(steps, /BepInEx\/plugins\//); assert.match(steps, /PeakReplayLab\.dll/);
  assert.match(steps, /移走 <code>PeakTrailRecorder\.dll<\/code>/);
  assert.match(steps, /保留旧日志、录像和配置/); assert.match(steps, /不要同时保留两份/);
  assert.doesNotMatch(steps, /PeakTrailHistory\.ndjson|BepInEx\/PeakTrailRecordings/);
  assert.match(guide, /BepInEx\/config\/cn\.mylus\.peakreplaylab\.cfg/);
});

test("recording instructions allow concurrent F6 clips and an independent persistent full-recording toggle", () => {
  assert.match(guide, /回忆录 → 录制方式/);
  assert.match(guide, /开启完整录制[\s\S]*进岛自动记录完整录像[\s\S]*F4[\s\S]*独立开启或关闭/);
  assert.match(guide, /BepInEx\/PeakReplayLab\/Recordings\/\*\.peakrun/);
  assert.match(guide, /自动缓存最近最多 120 秒[\s\S]*F6[\s\S]*随时保存片段/);
  assert.match(guide, /BepInEx\/PeakReplayLab\/Memories\/\*\.peakreplay/);
  assert.match(guide, /完整录制开着或关着，都能保存/);
  assert.match(guide, /最近 120 秒缓存仍保留/);
  assert.match(guide, /两者可以同时使用，完整录制设置会保留/);
  assert.match(guide, /游戏主菜单的回忆录中选录像观看/);
  assert.match(guide, /观看回放时不再采集/);
  assert.doesNotMatch(guide, /互斥|选择一种录制方式|二选一|清空.*缓存/);
  assert.match(guide, /<strong>H<\/strong> 收起或展开/);
  assert.match(guide, /没有按保存键的缓存不会在退出时自动保存/);
  assert.match(guide, /\.partial<\/code> 暂不可播放/);
  assert.match(guide, /网站用于看地图与公开路线，不直接播放/);
});

test("manual sharing explains the lightweight review step and the map's initially hidden layer", () => {
  assert.match(guide, /回忆录 → 完整录像 → 详情/); assert.match(guide, /上传轨迹/);
  assert.match(guide, /最多 <strong>10 Hz<\/strong> 的坐标、昵称/);
  assert.match(guide, /预览并确认后发送；不上传原始录像/);
  assert.match(guide, /120 秒片段、录制中和异常中断的文件不支持上传/);
  assert.match(guide, /上传默认待审核，完整走完的个人关卡路线才会公开/);
  assert.match(guide, /进入地图[\s\S]*顶部「返回」旁的「路线与热力」/);
  assert.match(guide, /默认只看地图，侧栏收起/); assert.match(guide, /难度、高度层/);
  assert.match(guide, /分享前请征得同局玩家同意/);
  assert.match(guide, /仅在本机录制、回放或导入旧日志不会上传/);
  assert.doesNotMatch(guide, /\[Live\]|ServerUrl|现场观测|实时观看|开启直播|稳定玩家 ID/);
});

test("archived guide links identify memories; the public homepage hides old log intake", () => {
  const source = guideHtml.match(/<section class="home-source"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(html, /<section class="home-source"|id="homeSource"/);
  assert.ok(source.includes(`href="${release.repositoryUrl}"`));
  assert.match(source, /href="https:\/\/github\.com\/luyongyi\/peak-trail"/);
  assert.ok(source.includes(`href="${release.repositoryUrl}/releases"`));
  assert.equal((source.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 3);
  assert.doesNotMatch(source, /对应源码|recorder-v|开源协议|MIT|随意使用/);
  assert.match(html, /id="gateReplay"[^>]*\bhidden\b[^>]*\bdisabled\b/);
  assert.match(css, /\.home-replay\[hidden\][^{]*\{\s*display:\s*none;/);
  assert.match(guide, /旧足迹 Mod 的日志可继续从首页「导入旧日志」打开/);
  assert.match(guide, /新回忆录录像在游戏里观看，两种文件格式不同/);
  assert.match(html, /id="gateLive"[^>]*\bhidden/);
  assert.doesNotMatch(html, /href="\.\/routes\.html"/);
  assert.match(html, /id="communityToggle"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(html, /本地导入不上传/);
});

test("phone guide paths, source links and five-card maps retain wrapping and accessible links", () => {
  assert.match(html, /viewport-fit=cover/); assert.match(guideHtml, /viewport-fit=cover/);
  assert.match(css, /@media \(max-width: 743px\)/); assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /\.home-guide-path[^}]*max-width: 100%[^}]*white-space: normal[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.home-guide-path \{ min-width: 0; width: auto/);
  assert.match(css, /\.home-chapters \{ height: auto; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); grid-template-rows: repeat\(3,/);
  assert.match(css, /\.home-chapter:first-child \{ grid-column: 1 \/ -1; \}/);
  assert.match(css, /\.home-source-links a:first-child \{ grid-column: 1 \/ -1; \}/);
  assert.match(css, /\.home-destination-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 12px; \}/);
});

test("the guide preserves native collapsed help and visible keyboard focus without requiring script", () => {
  assert.equal((guide.match(/<details>/g) || []).length, 3);
  assert.doesNotMatch(guide, /<details\s+open/);
  assert.match(css, /\.home-page a:focus-visible/);
  assert.match(css, /\.home-actions a[^{]+\{ min-height: 44px/);
  assert.match(css, /\.home-guide-steps \{ grid-template-columns: 1fr; \}/);
  assert.doesNotMatch(guideHtml, /<script|home-live-guide/);
});
