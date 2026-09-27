import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HOME_ART, HOME_ART_FILES, HOME_ENDINGS } from "../src/home-art.js";
import { buildHomeDailyView } from "../src/home-daily.js";

test("home illustration registry permits exactly eleven named assets, including distinct special areas", () => {
  const expected = ["shore", "roots", "tropics", "alpine", "mesa", "volcano", "swamp", "kiln", "temple", "peak", "nadir"];
  const files = [
    "shore-v3.png", "roots-v3.png", "tropics-v3.png", "alpine-v3.png", "mesa-v3.png",
    "volcano-v3.png", "swamp-v3.png", "kiln-v3.png", "temple-v3.png",
    "peak-v1.png", "nadir-v1.png",
  ];
  assert.deepEqual(HOME_ART_FILES, files);
  assert.deepEqual(Object.keys(HOME_ART), expected);
  assert.equal(new Set(HOME_ART_FILES).size, 11);
  assert.equal(Object.isFrozen(HOME_ART_FILES), true);
  assert.equal(Object.isFrozen(HOME_ART), true);
  for (const [index, name] of expected.entries()) assert.equal(HOME_ART[name], `./data/home-art/${files[index]}`);
  for (const oldFile of expected.slice(0, 9).flatMap((name) => [1, 2].map((version) => `${name}-v${version}.png`))) {
    assert.equal(HOME_ART_FILES.includes(oldFile), false, `${oldFile} must not be published`);
    assert.equal(Object.values(HOME_ART).includes(`./data/home-art/${oldFile}`), false);
  }
});

test("published illustrations have current prompt provenance and retain superseded history", async () => {
  const provenance = JSON.parse(await readFile(new URL("../../docs/home-art-prompts.json", import.meta.url), "utf8"));
  const specialAreas = JSON.parse(await readFile(new URL("../../docs/peak-nadir-art-prompts.json", import.meta.url), "utf8"));
  assert.equal(provenance.tool, "built-in image_gen");
  assert.equal(provenance.styleReference, "shore-v3.png");
  assert.equal(specialAreas.tool, "built-in image_gen");
  assert.deepEqual([...provenance.assets, ...specialAreas.assets].map(asset => asset.file), HOME_ART_FILES);
  for (const asset of provenance.assets) {
    assert.equal(asset.mode, "edit");
    assert.ok(asset.prompt.length > 100);
    assert.ok(asset.references.length > 0 && asset.references.length <= 5);
    assert.ok(provenance.supersededAssets.some(old => old.file === asset.editTarget));
  }
  for (const asset of specialAreas.assets) {
    assert.equal(asset.mode, "generate");
    assert.ok(asset.prompt.length > 100);
    assert.deepEqual(asset.references, []);
  }
  assert.ok(provenance.supersededAssets.every(old => !HOME_ART_FILES.includes(old.file)));
});

test("confirmed ending branches use interior art, never their preceding biome exterior", () => {
  assert.deepEqual(Object.keys(HOME_ENDINGS).sort(), ["swamp-temple", "volcano-kiln"]);
  assert.equal(Object.isFrozen(HOME_ENDINGS), true);
  assert.equal(HOME_ENDINGS["volcano-kiln"].art, HOME_ART.kiln);
  assert.equal(HOME_ENDINGS["swamp-temple"].art, HOME_ART.temple);
  assert.notEqual(HOME_ART.kiln, HOME_ART.temple);
  for (const ending of Object.values(HOME_ENDINGS)) {
    assert.equal(Object.isFrozen(ending), true);
    assert.notEqual(ending.art, HOME_ART.volcano);
    assert.notEqual(ending.art, HOME_ART.swamp);
    assert.ok(ending.english.length > 0);
    assert.ok(ending.description.length > 0);
  }
});

// The real class runs unchanged except import wiring and browser boundary ports.
// No DOM package, browser, network request, or live timer is needed for tick().
const source = (await readFile(new URL("../src/home-page.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replace("export class HomePage", "class HomePage");
const now = Date.parse("2026-09-22T02:00:00.000Z");
const mapPackId = `sha256-${"a".repeat(64)}`;
const daily = {
  schemaVersion: 1, versionOkay: true, levelIndex: 465, mapCount: 21, mapSlot: 3,
  sceneName: "Level_3", fetchedAtUtc: "2026-09-21T17:01:00.000Z", nextChangeAtUtc: "2026-09-22T17:00:00.000Z",
};
const catalog = {
  schemaVersion: 1, activeGameBuildId: "25306743", mapPacks: [{
    mapPackId, identityVersion: 3, sceneName: "Level_3", mapSlot: 3, gameBuildId: "25306743",
    path: `./packs/${mapPackId}/map-pack.json`, enabled: true,
  }],
};
function mapPack(branch = "swamp-temple") {
  const finalBiome = branch === "swamp-temple" ? "Swamp" : "Volcano";
  const biomes = ["Shore", "Roots", "Alpine", finalBiome, finalBiome];
  const biomeIds = { Shore: 0, Roots: 7, Alpine: 2, Swamp: 8, Volcano: 3 };
  return {
    mapPackId, sceneName: "Level_3", gameBuildId: "25306743", mapSlot: 3,
    mapPeak: { segment: 4, collisionBounds: { min: [-70, 979, 2131], max: [78, 1233, 2315] } },
    route: { authority: "serialized-map-handler", branch, segments: biomes.map((biome, index) => ({ index, biome, biomeId: biomeIds[biome], name: `${biome}_Segment` })) },
    layers: biomes.map((biome, segment) => ({ id: `segment-${segment}`, segment, biome, name: biome })),
  };
}
function element() {
  const attrs = new Map();
  return {
    dataset: {}, hidden: false, open: false, textContent: "", listeners: new Map(), srcWrites: 0,
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    set src(value) { this.srcWrites++; attrs.set("src", value); },
    get src() { return attrs.get("src") || ""; },
    addEventListener(name, handler) { this.listeners.set(name, handler); },
  };
}
function fixture() {
  const ids = [
    "homeRefresh", "homeDate", "homeDateMeta", "homeStatus", "homeRouteLabel", "homeCountdown",
    "homeFinale", "homeEndingExplore", "homeEnding", "homeEndingEnglish", "homeEndingStatus", "homeEndingArt",
    "home-peak-explore", "home-nadir-explore", "home-peak-art", "home-nadir-art",
  ];
  const nodes = Object.fromEntries(ids.map((id) => [id, element()]));
  const cells = Array.from({ length: 4 }, () => {
    const parts = Object.fromEntries(["button", ".home-biome-title", ".home-biome-en", "img", ".home-model-status"].map((selector) => [selector, element()]));
    return { ...element(), querySelector: (selector) => parts[selector] };
  });
  const root = { dataset: {}, querySelector: (selector) => nodes[selector.slice(1)], querySelectorAll: () => cells };
  const ports = {
    HOME_ART, HOME_ENDINGS,
    buildHomeDailyView: (input) => buildHomeDailyView({ ...input, now }),
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    setInterval: () => 1, clearInterval() {},
  };
  const HomePage = new Function(...Object.keys(ports), `${source}\nreturn HomePage;`)(...Object.values(ports));
  const explored = [];
  const page = new HomePage({ root, loadCatalog: async () => ({ catalog }), loadMapPack: async () => mapPack(),
    onExplore: (map, segment, view, intent) => explored.push({ map, segment, view, intent }), onRefresh: async () => {} });
  function show(branch = "swamp-temple") {
    Object.assign(page, { daily, catalog, mapPack: mapPack(branch) });
    page.tick();
  }
  return { page, nodes, cells, show, explored };
}

test("an unconfirmed home initially hides the finale and cannot expose a guessed ending", () => {
  const { nodes, cells } = fixture();
  assert.equal(nodes.homeFinale.hidden, true);
  assert.equal(nodes.homeFinale.dataset.branch, "");
  assert.equal(nodes.homeEndingExplore.disabled, true);
  assert.equal(nodes.homeEnding.textContent, "终段待确认");
  assert.equal(nodes.homeEndingEnglish.textContent, "FINAL ASCENT");
  assert.equal(nodes.homeEndingStatus.textContent, "等待路线确认");
  assert.equal(nodes.homeEndingArt.getAttribute("src"), null);
  assert.ok(cells.every((cell) => cell.querySelector("button").disabled));
});

test("each confirmed finale is a fifth normal map card with the correct interior model", () => {
  for (const [branch, title, precedingTitle, exterior] of [
    ["swamp-temple", "城塞", "雾沼", HOME_ART.swamp],
    ["volcano-kiln", "熔炉", "火山", HOME_ART.volcano],
  ]) {
    const { nodes, cells, show } = fixture();
    show(branch);
    const ending = HOME_ENDINGS[branch];
    assert.equal(nodes.homeFinale.hidden, false);
    assert.equal(nodes.homeFinale.dataset.branch, branch);
    assert.equal(nodes.homeEndingExplore.disabled, false);
    assert.equal(nodes.homeEndingExplore.getAttribute("aria-label"), `查看本轮第5关：${title}`);
    assert.equal(nodes.homeEnding.textContent, title);
    assert.equal(nodes.homeEndingEnglish.textContent, ending.english);
    assert.equal(nodes.homeEndingStatus.textContent, "");
    assert.equal(nodes.homeEndingArt.src, ending.art);
    assert.equal(nodes.homeEndingArt.hidden, false);
    assert.equal(nodes.homeEndingArt.alt, `${title}内部区域插画`);
    assert.equal(cells[3].querySelector("img").src, exterior);
    assert.notEqual(nodes.homeEndingArt.src, cells[3].querySelector("img").src);
  }
});

test("clock ticks do not reload the finale and its card opens segment five", () => {
  const { page, nodes, show, explored } = fixture();
  show("swamp-temple");
  const writes = nodes.homeEndingArt.srcWrites;
  page.tick();
  assert.equal(nodes.homeEndingArt.srcWrites, writes, "same illustration should not be reloaded each second");
  nodes.homeEndingExplore.listeners.get("click")();
  assert.equal(explored.at(-1).segment, 4);
  show("volcano-kiln");
  assert.equal(nodes.homeFinale.hidden, false);
  assert.equal(nodes.homeFinale.dataset.branch, "volcano-kiln");
  assert.equal(nodes.homeEndingArt.src, HOME_ART.kiln);
  assert.equal(nodes.homeEndingArt.srcWrites, writes + 1);
  show("swamp-temple");
  assert.equal(nodes.homeEndingArt.src, HOME_ART.temple);
});

test("missing, unknown or contradictory route evidence hides and disables the finale card", () => {
  for (const invalidate of [
    (page) => { page.mapPack.route = null; },
    (page) => { page.mapPack.route.branch = "unknown"; },
    (page) => { page.mapPack.route.branch = "volcano-kiln"; },
    (page) => { page.mapPack.layers[4].biome = "Volcano"; },
    (page) => { page.mapPack.layers.pop(); },
    (page) => { page.mapPack.gameBuildId = "999"; },
    (page) => { page.daily = null; },
  ]) {
    const { page, nodes, show } = fixture();
    show();
    invalidate(page);
    page.tick();
    assert.equal(nodes.homeFinale.hidden, true);
    assert.equal(nodes.homeFinale.dataset.branch, "");
    assert.equal(nodes.homeEndingExplore.disabled, true);
    assert.equal(nodes.homeEnding.textContent, "终段待确认");
    assert.equal(nodes.homeEndingStatus.textContent, "等待路线确认");
    assert.equal(nodes.homeEndingArt.alt, "");
    assert.equal(nodes.homeEndingArt.hidden, true);
  }
});

test("Roots is rendered as 森蕈 in the card, accessible action and illustration description", () => {
  const { cells, show } = fixture();
  show();
  const roots = cells[1];
  assert.equal(roots.querySelector(".home-biome-title").textContent, "森蕈");
  assert.equal(roots.querySelector(".home-biome-en").textContent, "ROOTS");
  assert.equal(roots.querySelector("button").getAttribute("aria-label"), "查看本轮第2关：森蕈");
  assert.equal(roots.querySelector("img").src, HOME_ART.roots);
  assert.equal(roots.querySelector("img").alt, "森蕈区域插画");
});

test("Tropics is named 雨林 in the card, accessible action and illustration description", () => {
  const { page, cells, show } = fixture();
  show();
  page.mapPack.layers[1].biome = "Tropics";
  Object.assign(page.mapPack.route.segments[1], { biome: "Tropics", biomeId: 1, name: "Jungle_Segment" });
  page.tick();
  const tropics = cells[1];
  assert.equal(tropics.querySelector(".home-biome-title").textContent, "雨林");
  assert.equal(tropics.querySelector("button").getAttribute("aria-label"), "查看本轮第2关：雨林");
  assert.equal(tropics.querySelector("img").src, HOME_ART.tropics);
  assert.equal(tropics.querySelector("img").alt, "雨林区域插画");
});

test("alternative-ending actions pass the source-bound summit intent and open the actual extra model", () => {
  const { page, nodes, show, explored } = fixture();
  assert.equal(nodes["home-peak-explore"].disabled, true);
  assert.equal(nodes["home-nadir-explore"].disabled, true);
  nodes["home-nadir-explore"].listeners.get("click")();
  assert.equal(explored.length, 0);
  show();
  assert.equal(nodes["home-peak-explore"].disabled, false);
  nodes["home-peak-explore"].listeners.get("click")();
  assert.equal(explored.at(-1).segment, 4);
  assert.deepEqual(explored.at(-1).intent, { destinationId: "peak", viewIntent: "summit" });
  page.mapPack.layers.push({ id: "void", segment: 5, biome: "Void" });
  page.tick();
  assert.equal(nodes["home-nadir-explore"].disabled, false);
  assert.equal(nodes["home-nadir-explore"].textContent, "查看天底地图");
  nodes["home-nadir-explore"].listeners.get("click")();
  assert.equal(explored.at(-1).segment, 5);
  assert.equal(explored.at(-1).map, page.mapPack);
  page.mapPack.layers.pop();
  // Click-time validation also rejects stale buttons between clock ticks.
  nodes["home-nadir-explore"].listeners.get("click")();
  assert.equal(explored.length, 2);
  page.tick();
  assert.equal(nodes["home-nadir-explore"].disabled, true);
  page.daily = null;
  page.tick();
  assert.equal(nodes["home-peak-explore"].disabled, true);
});

test("both ending illustrations remain alternatives, including while map evidence is unavailable", () => {
  const { page, nodes, show } = fixture();
  for (const id of ["peak", "nadir"]) {
    const art = nodes[`home-${id}-art`];
    assert.equal(art.src, HOME_ART[id]);
    assert.equal(art.alt, `${id === "peak" ? "顶峰" : "天底"}结局区域插画`);
    assert.equal(nodes[`home-${id}-explore`].disabled, true);
    const writes = art.srcWrites;
    show();
    page.tick();
    assert.equal(art.srcWrites, writes, "clock/map updates must not reload static ending art");
    page.daily = null;
    page.tick();
    assert.equal(art.src, HOME_ART[id]);
  }
});

test("home markup presents ending artwork as two alternatives, not more numbered chapters", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const chapters = html.match(/<ol class="home-chapters"[^]*?<\/ol>/)?.[0];
  const section = html.match(/<section class="home-destinations"[^]*?<\/section>/)?.[0];
  assert.ok(chapters);
  assert.equal((chapters.match(/class="home-chapter(?: |")/g) || []).length, 5);
  assert.match(chapters, /id="homeFinale"[^>]*data-segment="4"/);
  assert.match(chapters, /id="homeEndingExplore" disabled/);
  assert.ok(section);
  assert.match(section, /二选一终局/);
  assert.match(section, /顶峰与天底为互斥结局/);
  assert.doesNotMatch(section, /AI 主题插画|非地图实景|不是连续的第五、第六关/);
  assert.equal((section.match(/class="home-destination"/g) || []).length, 2);
  assert.doesNotMatch(section, /home-chapter-number/);
  for (const id of ["peak", "nadir"]) {
    assert.match(section, new RegExp(`<img id="home-${id}-art"[^>]*loading="lazy"`));
    assert.match(section, new RegExp(`id="home-${id}-explore" disabled`));
  }
});
