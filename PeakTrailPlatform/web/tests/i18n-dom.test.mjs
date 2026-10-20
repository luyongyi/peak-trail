import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getLocale, setLocale } from "../src/i18n.js";
import { collectStaticTranslations, initLanguageControls } from "../src/i18n-dom.js";
import { UI_TEXT, UI_TEXT_PAIRS } from "../src/ui-text.js";
import "../src/watch-text.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const startupSource = await readFile(new URL("../src/startup.js", import.meta.url), "utf8");

test("every initial Chinese text and accessibility/metadata attribute has explicit English copy", () => {
  const texts = [...html.matchAll(/>([^<]+)</g)].map(match => match[1].trim().replace(/\s+/g, " "));
  const attributes = [...html.matchAll(/(?:aria-label|title|placeholder|alt|content)="([^"]+)"/g)].map(match => match[1]);
  const chinese = [...new Set([...texts, ...attributes].filter(value => /\p{Script=Han}/u.test(value)))];
  assert.ok(chinese.length > 190, "cover the complete initial page, including hidden controls");
  assert.equal(new Map(UI_TEXT_PAIRS).size, UI_TEXT_PAIRS.length, "Chinese keys must be unambiguous");
  for (const text of chinese) {
    assert.ok(UI_TEXT.has(text), `Missing static translation: ${text}`);
    assert.ok(UI_TEXT.get(text).length > 0);
    assert.doesNotMatch(UI_TEXT.get(text), /\p{Script=Han}/u);
  }
  assert.equal((html.match(/data-language-toggle/g) || []).length, 2);
  assert.match(html, /<nav class="home-actions"[^]*?data-language-toggle[^]*?<\/nav>/);
  assert.match(html, /<div class="top-actions"[^]*?data-language-toggle[^]*?<\/header>/);
});

function fixture() {
  const elements = [], texts = [];
  function element(tag, attributes = {}) {
    const attrs = new Map(Object.entries(attributes));
    const node = { tagName: tag, attrs, children: [], listeners: new Map(),
      getAttribute: name => attrs.get(name) ?? null,
      setAttribute: (name, value) => attrs.set(name, String(value)),
      addEventListener(name, handler) { this.listeners.set(name, handler); },
      removeEventListener(name, handler) { if (this.listeners.get(name) === handler) this.listeners.delete(name); },
      querySelector: () => node.label || null };
    elements.push(node); return node;
  }
  function text(value, parent) {
    const node = { nodeValue: value, parentElement: parent };
    parent.children.push(node); texts.push(node); return node;
  }
  const title = text("PEAK Trail · 地图与回忆录", element("TITLE"));
  const meta = element("META", { content: "PEAK 每日地图与玩家线路。下载回忆录 Mod，在游戏内录制和回放，主动分享精简轨迹。" });
  const button = element("BUTTON", { "aria-label": "切换为英语" });
  const icon = element("SVG"), label = element("SPAN");
  button.children.push(icon, label); button.label = label;
  const action = element("BUTTON", { title: "适配当前视图", "aria-label": "适配当前视图" });
  const actionIcon = element("SVG"); action.children.push(actionIcon);
  const caption = text("  进入地图 \n", action);
  const dynamic = text("等待地图", element("SPAN"));
  const user = text("玩家甲", element("SPAN"));
  const script = text("地图", element("SCRIPT"));
  const root = { documentElement: { lang: "zh-CN" },
    createTreeWalker() { let index = 0; return { nextNode: () => texts[index++] || null }; },
    querySelectorAll(selector) { return selector === "*" ? elements : selector === "[data-language-toggle]" ? [button] : []; } };
  return { root, button, icon, label, action, actionIcon, caption, dynamic, user, script, title, meta };
}

test("switching updates static metadata and text without rebuilding icons or overwriting dynamic/user content", () => {
  const view = fixture();
  const dispose = initLanguageControls(view.root);
  assert.equal(initLanguageControls(view.root), dispose, "initialization must not stack listeners");
  view.dynamic.nodeValue = "动态状态：玩家甲";
  view.action.setAttribute("title", "Live camera description");
  try {
    view.button.listeners.get("click")();
    assert.equal(getLocale(), "en");
    assert.equal(view.root.documentElement.lang, "en");
    assert.equal(view.title.nodeValue, "PEAK Trail · Maps & Memories");
    assert.match(view.meta.getAttribute("content"), /^Daily PEAK maps/);
    assert.equal(view.caption.nodeValue, "  Explore map \n");
    assert.equal(view.action.getAttribute("aria-label"), "Fit current view");
    assert.equal(view.action.getAttribute("title"), "Live camera description");
    assert.equal(view.button.children[0], view.icon);
    assert.equal(view.action.children[0], view.actionIcon);
    assert.equal(view.label.textContent, "中文");
    assert.equal(view.button.getAttribute("aria-label"), "Switch to Simplified Chinese");
    assert.equal(view.dynamic.nodeValue, "动态状态：玩家甲");
    assert.equal(view.user.nodeValue, "玩家甲");
    assert.equal(view.script.nodeValue, "地图");
    view.button.listeners.get("click")();
    assert.equal(view.caption.nodeValue, "  进入地图 \n");
    assert.equal(view.action.getAttribute("aria-label"), "适配当前视图");
    assert.equal(view.label.textContent, "English");
    dispose();
    setLocale("en");
    assert.equal(view.title.nodeValue, "PEAK Trail · 地图与回忆录");
    assert.equal(view.button.listeners.has("click"), false);
  } finally { dispose(); setLocale("zh-CN"); }
});

test("translation snapshots do not translate new nodes added after capture", () => {
  const view = fixture();
  const render = collectStaticTranslations(view.root);
  const original = view.root.querySelectorAll;
  const newUserNode = { nodeValue: "地图" };
  view.root.querySelectorAll = () => { throw new Error("No later tree scans"); };
  render("en");
  assert.equal(newUserNode.nodeValue, "地图");
  view.root.querySelectorAll = original;
});

test("explicit language links persist their choice without changing route queries or saving browser defaults", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    for (const [query, locale, saved] of [
      ["?lang=en&routeGroup=abc&stage=2", "en", "en"],
      ["?lang=zh-CN&routeGroup=abc&stage=2", "zh-CN", "zh-CN"],
      ["?routeGroup=abc&stage=2", "en", null],
      ["?lang=fr&routeGroup=abc&stage=2", "en", null],
    ]) {
      const values = new Map();
      const browser = { location: { href: `https://example.invalid/${query}` },
        localStorage: { setItem: (key, value) => values.set(key, value) },
        history: { state: null, replaceState(_state, _title, url) { browser.location.href = String(url); } } };
      Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
      setLocale(locale, { persist: false });
      const view = fixture(); view.root.defaultView = browser;
      const dispose = initLanguageControls(view.root);
      try {
        assert.equal(values.get("peak-trail.language") ?? null, saved);
        const url = new URL(browser.location.href);
        assert.equal(url.searchParams.get("routeGroup"), "abc");
        assert.equal(url.searchParams.get("stage"), "2");
        assert.equal(url.searchParams.get("lang"), new URLSearchParams(query).get("lang"));
      } finally { dispose(); }
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
    setLocale("zh-CN", { persist: false });
  }
});

function startup({ href = "https://example.invalid/", stored = null, languages = ["zh-CN"], protocol = "https:" } = {}) {
  const handlers = new Map();
  const ids = Object.fromEntries(["startupNotice", "dailyScene", "applicationScript"].map(id => [id, { hidden: true, textContent: "", addEventListener: (name, handler) => handlers.set(name, handler) }]));
  const file = { disabled: false };
  const document = { documentElement: {}, getElementById: id => ids[id], querySelectorAll: () => [file] };
  const window = { location: { href, protocol }, navigator: { languages }, localStorage: { getItem: () => stored }, addEventListener: (name, handler) => handlers.set(name, handler) };
  let timer;
  new Function("window", "document", "setTimeout", "clearTimeout", startupSource)(window, document, callback => { timer = callback; return 1; }, () => {});
  return { ids, file, document, timeout: () => timer?.(), fail: () => handlers.get("error")?.(), ready: () => handlers.get("peaktrail-ready")?.() };
}

test("classic startup notices use URL, stored preference, then browser language even for local files", () => {
  for (const [options, locale] of [
    [{ href: "file:///C:/index.html?lang=en", protocol: "file:", stored: "zh-CN", languages: ["zh-CN"] }, "en"],
    [{ href: "https://example.invalid/?lang=zh-CN", stored: "en", languages: ["en-US"] }, "zh-CN"],
    [{ stored: "en", languages: ["zh-CN"] }, "en"],
    [{ languages: ["en-GB"] }, "en"],
    [{ languages: ["de-DE"] }, "en"],
  ]) {
    const result = startup(options);
    assert.equal(result.document.documentElement.lang, locale);
    if (options.protocol === "file:") {
      assert.equal(result.file.disabled, true);
      assert.match(result.ids.startupNotice.textContent, /local HTML file/);
      assert.equal(result.ids.dailyScene.textContent, "Open through the website");
    } else {
      result.timeout();
      assert.equal(result.ids.startupNotice.hidden, false);
      assert.match(result.ids.startupNotice.textContent, locale === "en" ? /still loading/ : /尚未加载完成/);
      result.fail();
      assert.match(result.ids.startupNotice.textContent, locale === "en" ? /failed to load/ : /加载失败/);
      result.ready();
      assert.equal(result.ids.startupNotice.hidden, true);
    }
  }
});
