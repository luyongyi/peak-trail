import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as i18n from "../src/i18n.js";
import { ProtocolError } from "../src/protocol.js";
import { REPLAY_CAMERA_HELP } from "../src/replay-camera.js";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
function appFunction(name) {
  const match = appSource.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(match, `app.js declares ${name}`);
  return match[0];
}

test("language repaint preserves chapter, camera, playback and the selected recording without map IO", () => {
  const calls = [];
  const state = { mapPack: { mapPackId: "unchanged" }, trace: { id: "recording" }, usingCompatibleMap: true,
    currentTime: 83, playing: true, selectedSegment: 2, segmentSelectionMode: "manual", lastRenderSignature: "same-data",
    segmentOptions: [{ segment: 0, name: "Shore", biome: "shore" }, { segment: 2, name: "Alpine", biome: "alpine" },
      { segment: 5, name: "Void", biome: "void", isVoid: true }], sourceLoadingCounts: { map: 1, trace: 0 } };
  const options = ["all", "0", "2", "5"].map(value => ({ value, textContent: "" }));
  const elements = { layerSelect: { options, value: "2" }, sessionSelect: { value: "second-session" },
    dateSelect: { value: "2026-10-19" }, eventList: { scrollTop: 122 },
    playButton: { setAttribute(name, value) { this[name] = value; } }, mapSourceState: {}, traceSourceState: {},
    errorTitle: {}, errorMessage: {}, errorBanner: { classList: { contains() { return true; }, add() {} } } };
  const routeView = { key: "same-route", message: "Recorded route" };
  const camera = { position: [3, 7, 9], target: [1, 2, 3], mode: "free" };
  const ports = { ...i18n, state, elements, historicalRouteTitle() { throw new Error("No history to retitle"); },
    resolveReplayRoute: (map, trace, time) => { assert.equal(map, state.mapPack); assert.equal(trace, state.trace); assert.equal(time, 83); return routeView; },
    segmentDisplayName: entry => i18n.biomeName(entry.biome),
    populateTraceArchive(date) { assert.equal(date, "2026-10-19"); elements.sessionSelect.value = "first-session"; },
    populateSessionSelect(id) { elements.sessionSelect.value = id; },
    updateEvents() { elements.eventList.scrollTop = 0; },
    clearTimeout() {}, setTimeout() { throw new Error("A language repaint cannot restart the error timeout"); },
    viewer: { camera, refreshLocaleUi() { calls.push("scene labels"); },
      setData() { throw new Error("Language changes cannot reload maps"); },
      fitView() { throw new Error("Language changes cannot refit the camera"); } },
  };
  for (const name of ["updateMapUI", "updateTraceSourceLabels", "updateCompatibilityUI", "renderSegmentNavigation",
    "renderEventWindow", "updatePlayerTelemetry", "syncWorkspaceState", "syncFollowHud", "syncWakeLockChip",
    "updatePhonePanelButton", "updateDailyCard", "renderGateRuns"]) ports[name] = () => calls.push(name);
  const api = new Function(...Object.keys(ports), `${["errorUiText", "renderErrorUi", "showError", "refreshLocaleUi"].map(appFunction).join("\n")}; return {showError,refreshLocaleUi};`)(...Object.values(ports));
  api.showError("地图身份无效", "请检查地图文件", 0);
  const previous = { ...state };
  const dispose = i18n.onLocaleChange(api.refreshLocaleUi);
  try {
    i18n.setLocale("en", { persist: false });
    assert.match(options[1].textContent, /^Stage 1 · SHORE/);
    assert.match(options[2].textContent, /^Stage 2 · ALPINE/);
    assert.match(options[3].textContent, /^Extra area · NADIR/);
    assert.equal(elements.layerSelect.value, "2");
    assert.equal(elements.sessionSelect.value, "second-session");
    assert.equal(elements.eventList.scrollTop, 122);
    assert.equal(elements.mapSourceState.textContent, "Loading");
    assert.equal(elements.playButton["aria-label"], "Pause");
    for (const key of ["mapPack", "trace", "currentTime", "playing", "selectedSegment", "segmentSelectionMode", "lastRenderSignature"])
      assert.equal(state[key], previous[key]);
    assert.deepEqual(camera, { position: [3, 7, 9], target: [1, 2, 3], mode: "free" });
    assert.ok(calls.includes("updatePlayerTelemetry"));
    assert.ok(calls.includes("scene labels"));
    assert.equal(elements.errorTitle.textContent, "Unable to complete this action");
    assert.match(elements.errorMessage.textContent, /complete and compatible/);
    i18n.setLocale("zh-CN", { persist: false });
    assert.equal(elements.errorTitle.textContent, "地图身份无效");
    assert.equal(elements.errorMessage.textContent, "请检查地图文件");
    assert.deepEqual(state.errorPresentation, { title: "地图身份无效", message: "请检查地图文件" });
  } finally { dispose(); i18n.setLocale("zh-CN", { persist: false }); }
});

test("language round trips keep a collapsed navigator closed while real chapter and map changes still flash", () => {
  const collapsed = new Set(["is-collapsed"]);
  const timers = [];
  function node() {
    return { textContent: "", value: "", setAttribute() {}, classList: { toggle() {} } };
  }
  const elements = Object.fromEntries(["segmentNavigator", "routeSummary", "segmentOrdinal", "segmentName",
    "segmentOriginalName", "previousSegmentButton", "nextSegmentButton", "followSegmentButton", "segmentOverviewButton",
    "segmentLoadStatus", "compatibilityText", "layerSelect"].map(name => [name, node()]));
  elements.segmentNavigator.classList = { contains: name => collapsed.has(name),
    remove: name => collapsed.delete(name), add: name => collapsed.add(name) };
  const state = { mapPack: { mapPackId: "map-a" }, selectedSegment: 0, workspaceMode: "explore",
    segmentSelectionMode: "manual", segmentOptions: [{ segment: 0, biome: "shore" }, { segment: 1, biome: "roots" }] };
  const ports = { ...i18n, state, elements, segmentDisplayName: entry => i18n.biomeName(entry.biome),
    selectedSegmentStatus: () => ({ status: "ready", text: i18n.tr("已就绪", "Ready") }),
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {} };
  const render = new Function(...Object.keys(ports), `let segmentNavLastName = null, segmentNavFlashTimer = 0;\n${appFunction("adjacentSegment")}\n${appFunction("renderSegmentNavigation")}\nreturn renderSegmentNavigation;`)(...Object.values(ports));
  render();
  const dispose = i18n.onLocaleChange(render);
  try {
    i18n.setLocale("en", { persist: false });
    assert.equal(elements.segmentName.textContent, "SHORE");
    i18n.setLocale("zh-CN", { persist: false });
    assert.equal(elements.segmentName.textContent, "海岸");
    assert.equal(collapsed.has("is-collapsed"), true);
    assert.equal(timers.length, 0);
    state.selectedSegment = 1;
    render();
    assert.equal(collapsed.has("is-collapsed"), false);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 2600);
    timers[0].callback();
    state.mapPack = { mapPackId: "map-b" };
    render();
    assert.equal(collapsed.has("is-collapsed"), false);
    assert.equal(timers.length, 2);
  } finally { dispose(); i18n.setLocale("zh-CN", { persist: false }); }
});

test("English protocol failures use an accurate UI fallback without changing protocol data or plain filenames", () => {
  const ports = { ...i18n, ProtocolError };
  const api = new Function(...Object.keys(ports), `${appFunction("errorUiText")}\n${appFunction("describeError")}\nreturn {errorUiText,describeError};`)(...Object.values(ports));
  i18n.setLocale("en", { persist: false });
  try {
    const error = new ProtocolError("地图身份无效", "请检查地图文件");
    const result = api.describeError(error);
    assert.equal(result.title, "Unable to read this map or recording");
    assert.match(result.message, /complete and compatible/);
    assert.equal(error.message, "地图身份无效");
    assert.equal(api.errorUiText("PeakTrailHistory.ndjson"), "PeakTrailHistory.ndjson");
  } finally { i18n.setLocale("zh-CN", { persist: false }); }
});

test("scene language refresh repaints current geometry status and camera help without moving the camera", async () => {
  const source = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "").replace("export class TrailScene", "class TrailScene");
  i18n.setLocale("en", { persist: false });
  try {
    const Scene = new Function("tr", "formatNumber", "REPLAY_CAMERA_HELP", `${source}\nreturn TrailScene;`)(i18n.tr, i18n.formatNumber, REPLAY_CAMERA_HELP);
    const scene = Object.create(Scene.prototype);
    const events = [];
    const group = { names: {}, members: new Map([["one", {}], ["two", {}]]), nicknames: ["小峰", "Test"] };
    Object.assign(scene, { canvas: { dispatchEvent(event) { events.push(event); } },
      lastMapStatus: { status: "ready", message: ["本关真实网格已就绪", "Stage geometry ready"], segment: 2 },
      cameraPlacementLabels: ["内部几何参考点（非玩家位置）", "Interior geometry reference point (not a player position)"],
      freeCamera: { mode: "free", setMode() { throw new Error("No camera change on language refresh"); } },
      playerGroups: new Map([["pair", group]]), activeSegment: 2, cameraSelectionRevision: 7 });
    scene.refreshLocaleUi();
    assert.equal(events[0].detail.message, "Stage geometry ready");
    assert.equal(events[1].detail.note, "Interior geometry reference point (not a player position)");
    assert.equal(events[2].detail.mode, "free");
    assert.doesNotMatch(events[2].detail.help, /\p{Script=Han}/u);
    assert.equal(group.names.textContent, "2 players · 小峰 · Test");
    assert.equal(scene.activeSegment, 2);
    assert.equal(scene.cameraSelectionRevision, 7);
  } finally { i18n.setLocale("zh-CN", { persist: false }); }
});
