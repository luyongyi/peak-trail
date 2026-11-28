import assert from "node:assert/strict";
import test from "node:test";
import { createPlayerCard, updatePlayerCard, updatePlayerHud, PLAYER_BASE_SLOTS } from "../src/player-card.js";
import { setLocale } from "../src/i18n.js";
import { updateStaminaHud } from "../src/stamina-hud.js";

// The card's DOM ports are enough to verify language updates without a canvas,
// game assets or requests. Selector matching preserves the actual DOM hierarchy.
class Node {
  constructor(tagName) {
    this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {};
    this.textContent = ""; this.className = ""; this.style = { setProperty() {} };
    this.classList = {
      contains: value => this.className.split(" ").includes(value),
      add: (...values) => { this.className = [...new Set([...this.className.split(" "), ...values])].join(" "); },
      remove: (...values) => { this.className = this.className.split(" ").filter(value => !values.includes(value)).join(" "); },
      toggle: (value, enabled) => enabled ? this.classList.add(value) : this.classList.remove(value),
    };
  }
  append(...values) { for (const value of values) { value.parentElement = this; this.children.push(value); } }
  prepend(...values) { for (const value of values) value.parentElement = this; this.children.unshift(...values); }
  replaceChildren(...values) { this.children = []; this.append(...values); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener() {}
  querySelector(selector) {
    const parts = selector.replace(/\s*>\s*/g, " > ").split(/\s+/);
    const simple = (node, part) => part.startsWith(".") ? node.classList.contains(part.slice(1))
      : part.startsWith("[data-") ? node.dataset[part.match(/^\[data-([^=]+)/)[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] === part.match(/="([^"]+)"/)[1]
        : node.tagName === part;
    function matches(node, index) {
      if (!node || !simple(node, parts[index])) return false;
      if (index === 0) return true;
      if (parts[index - 1] === ">") return matches(node.parentElement, index - 2);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (matches(parent, index - 1)) return true;
      return false;
    }
    const descend = node => { for (const child of node.children) { if (matches(child, parts.length - 1)) return child; const found = descend(child); if (found) return found; } return null; };
    return descend(this);
  }
}

test("fullscreen HUD shows measured altitude and clears missing, stale or unfollowed player data", () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: name => new Node(name), documentElement: {} };
  try {
    setLocale("zh-CN");
    const root = new Node("section");
    const add = (parent, tag, cls = "") => { const n = new Node(tag); n.className = cls; parent.append(n); return n; };
    const name = add(root, "strong", "player-hud-name"), altitude = add(root, "span", "player-hud-altitude");
    const stamina = add(root, "div", "game-stamina");
    const status = add(root, "div", "player-hud-status"), summary = add(status, "span");
    const slots = add(root, "div", "player-hud-slots");
    updatePlayerHud(root, "A", { sample: { pos: [2, 70, 4] }, telemetry: { stamina: 0, maxStamina: 1 },
      inventory: { captured: true, ready: true, selectedSlotKnown: true, selectedSlot: 1,
        slots: [{ index: 1, location: "inventory", item: { name: "Rope", count: 2 } }] } }, null);
    const meter = stamina.querySelector(".game-stamina-track");
    assert.equal(meter.hidden, false); assert.equal(meter.attributes["aria-valuenow"], "0");
    assert.doesNotMatch(summary.textContent, /%/);
    assert.equal(slots.children.length, 4);
    assert.ok(slots.children[1].classList.contains("is-selected"));
    assert.match(slots.children[1].title, /×2/);
    setLocale("en");
    updatePlayerHud(root, "B", { sample: { pos: [1, -4.2, 2] }, life: "unknown" }, null);
    assert.equal(name.textContent, "B"); assert.equal(altitude.textContent, "Altitude -4 m");
    assert.equal(meter.hidden, true); assert.equal(slots.hidden, true); assert.equal(slots.children.length, 0);
    assert.equal(summary.textContent, "Inventory and status not recorded");
    updatePlayerHud(root, "B", { life: "absent" }, null); assert.equal(root.hidden, true);
    updatePlayerHud(root, "", null, null); assert.equal(root.hidden, true);
  } finally { setLocale("zh-CN"); globalThis.document = previous; }
});

test("native stamina bars preserve damage, bonus scale and unknown state without percentage copy", () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: name => new Node(name), documentElement: {} };
  try {
    setLocale("zh-CN");
    const root = new Node("div");
    const status = { ready: true, baseMaxStamina: 1, maxStamina: .7, baseMaxExtraStamina: 1, maxExtraStamina: 1,
      values: [{ id: 0, type: "Injury", amount: .3, staminaBlock: .3, extraStaminaBlock: 0 }] };
    updateStaminaHud(root, { captured: true, stamina: .35, maxStamina: .7, extraStamina: .2, maxExtraStamina: 1 }, status, null);
    const main = root.children[0], extra = root.children[1];
    assert.equal(main.attributes["aria-valuenow"], "35");
    assert.equal(main.querySelector(".game-stamina-fill").style.width, "35%");
    assert.equal(main.querySelector(".game-stamina-condition").style.left, "70%");
    assert.equal(extra.hidden, false);
    assert.equal(extra.querySelector(".game-stamina-track").style.width, "max(18px, 20%)");
    // Switching players must clear the previous values/afflictions, never show
    // zero or a full green bar when the next player's snapshot is absent.
    updateStaminaHud(root, { captured: true, ready: false }, null, null);
    assert.equal(main.hidden, true); assert.equal(main.attributes["aria-valuenow"], undefined);
    assert.equal(extra.hidden, true); assert.equal(root.children[2].textContent, "体力同步中");
    updateStaminaHud(root, { stamina: 0, maxStamina: 1, extraStamina: 0, maxExtraStamina: 1 }, null, null);
    assert.equal(main.hidden, false); assert.equal(main.querySelector(".game-stamina-fill").hidden, true);
    assert.equal(main.querySelector(".game-stamina-blocks").children.length, 0);
    assert.equal(extra.hidden, true);
    updateStaminaHud(root, { stamina: .5, extraStamina: 0, baseMaxExtraStamina: 1 },
      { ready: true, values: [{ id: 13, type: "Petrify", extraStaminaBlock: .3 }] }, null);
    assert.equal(extra.hidden, false, "a known petrification block must survive a missing capacity field");
    assert.equal(extra.querySelector(".game-stamina-track").style.width, "100%");
  } finally { setLocale("zh-CN"); globalThis.document = previous; }
});

test("native stamina art uses the exact build textures and clears them when the build changes", () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: name => new Node(name), documentElement: {} };
  try {
    const root = new Node("div");
    const style = { color: [.3, .8, 0, 1], border: [82, 82, 82, 82], size: [202, 202], pixelsPerUnitMultiplier: 8 };
    const pack = { catalogUrl: new URL("https://example.test/assets/26542162/catalog.json"),
      ui: { staminaFill: "ui/fill.png", staminaOutline: "ui/outline.png", extraStaminaIcon: "ui/bolt.png" },
      catalog: { uiStyle: { stamina: { images: { staminaFill: style, staminaOutline: style } } } } };
    updateStaminaHud(root, { stamina: .5, maxStamina: 1 }, null, pack);
    const fill = root.children[0].querySelector(".game-stamina-fill");
    assert.equal(fill.classList.contains("has-art"), true); assert.equal(fill.children.length, 9);
    updateStaminaHud(root, { stamina: .5, maxStamina: 1 }, null, null);
    assert.equal(fill.classList.contains("has-art"), false);
  } finally { globalThis.document = previous; }
});

test("existing player cards update static and cached labels without changing nickname or controls", () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: name => new Node(name), documentElement: {} };
  const state = { telemetry: { captured: false }, inventory: null, status: null, appearance: null, life: "alive" };
  try {
    setLocale("zh-CN");
    const row = createPlayerCard({ id: "player-1", nickname: "登山者" }, "#ffffff");
    updatePlayerCard(row, state, { assetStatus: "missing" });
    const visibility = row.querySelector(".player-toggle input"), details = row.querySelector(".player-details");
    visibility.checked = false; details.open = true;
    setLocale("en"); updatePlayerCard(row, state, { assetStatus: "missing" });
    assert.equal(row.querySelector(".player-identity strong").textContent, "登山者");
    assert.equal(row.querySelector(".player-details > summary").textContent, "Player details");
    assert.equal(row.querySelector(".condition-life").textContent, "Alive");
    assert.equal(row.querySelector('[data-location="slot/0"] .visual-slot-caption').textContent, "Quick slot 1");
    assert.equal(row.querySelector(".appearance-placeholder").textContent, "Appearance\nnot recorded");
    assert.equal(visibility.checked, false); assert.equal(details.open, true);
    assert.equal(PLAYER_BASE_SLOTS[3].key, "slot/3"); assert.equal(PLAYER_BASE_SLOTS[3].label, "Backpack slot");
    setLocale("zh-CN"); updatePlayerCard(row, state, { assetStatus: "missing" });
    assert.equal(row.querySelector(".player-details > summary").textContent, "玩家详情");
    assert.equal(row.querySelector('[data-location="slot/0"] .visual-slot-caption').textContent, "快捷 1");
    assert.equal(visibility.checked, false); assert.equal(details.open, true);
  } finally { setLocale("zh-CN"); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});
