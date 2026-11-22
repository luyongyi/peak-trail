import assert from "node:assert/strict";
import test from "node:test";
import { createPlayerCard, updatePlayerCard, updatePlayerHud, PLAYER_BASE_SLOTS } from "../src/player-card.js";
import { setLocale } from "../src/i18n.js";

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
    const status = add(root, "div", "player-hud-status"), meter = add(status, "meter"), summary = add(status, "span");
    const slots = add(root, "div", "player-hud-slots");
    updatePlayerHud(root, "A", { sample: { pos: [2, 70, 4] }, telemetry: { stamina: 0, maxStamina: 1 },
      inventory: { captured: true, ready: true, selectedSlotKnown: true, selectedSlot: 1,
        slots: [{ index: 1, location: "inventory", item: { name: "Rope", count: 2 } }] } }, null);
    assert.equal(meter.hidden, false); assert.equal(meter.value, 0);
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
