// Deterministic, explicitly synthetic browser QA. Reads map/assets only, never
// personal recordings. Generated logs remain in the ignored local directory.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localAssetPaths, platformDirectory, repositoryDirectory } from "./lib/local-paths.mjs";
import { loadTraceBundle, tracePlayerStateAtTime } from "../web/src/protocol.js";
import { staminaLayout } from "../web/src/player-conditions.js";

export const QA_PLAYER_ID = "qa:synthetic-status-not-gameplay";
const SOURCE = "synthetic-status-qa-not-gameplay";
const STATUS_NAMES = ["Injury", "Hunger", "Cold", "Poison", "Crab", "Curse", "Drowsy", "Weight", "Hot", "Thorns", "Spores", "Web", "Arrow", "Petrify", "FlyTrap"];
const INDEX_FIELDS = ["skinIndex", "eyesIndex", "mouthIndex", "accessoryIndex", "outfitIndex", "hatIndex", "effectiveHatIndex", "sashIndex", "medalIndex"];

export function createPlayerConditionsFixture({ pack, route, customization, anchor }) {
  const choose = (collection, preferred = null) => {
    const entries = customization[collection];
    const value = entries?.find((entry) => entry.index === preferred) || entries?.find((entry) => Number.isInteger(entry.index));
    if (!value) throw new Error(`QA fixture missing public ${collection} catalog entries`);
    return value;
  };
  const skin = choose("skins", 1), eyes = choose("eyes", 5), mouth = choose("mouths", 12);
  const accessory = choose("accessories", 0), sash = choose("sashes", 0), medal = choose("medals", 0);
  const fit = customization.fits?.find((entry) => !entry.overrideHat && Number.isInteger(entry.index));
  const hat = customization.hats?.find((entry) => /crown/i.test(entry.name) && entry.model) || choose("hats");
  if (!fit || !hat.model || !Array.isArray(skin.color)) throw new Error("QA fixture needs a valid fit, headwear model and skin color");
  const skeleton = customization.forms?.find((entry) => entry.form === "skeleton");
  if (!skeleton?.headModel) throw new Error("QA fixture requires the exported original skeleton head asset");
  const cosmetics = { ready: true, authority: SOURCE, source: SOURCE,
    skinIndex: skin.index, eyesIndex: eyes.index, mouthIndex: mouth.index, accessoryIndex: accessory.index,
    outfitIndex: fit.index, hatIndex: hat.index, effectiveHatIndex: hat.index, sashIndex: sash.index, medalIndex: medal.index,
    skinColor: [...skin.color], outfitName: fit.name, hatName: hat.name };
  const manifest = { schemaVersion: 1, sessionId: "SYNTHETIC-STATUS-QA-LEVEL17",
    sceneName: pack.sceneName, gameVersion: pack.gameVersion, gameBuildId: String(pack.gameBuildId),
    mapSlot: pack.mapSlot, mapPackId: pack.mapPackId, projectionVersion: pack.projectionVersion,
    coordinateSpace: "unity-world-meters", positionAuthority: "synthetic-map-survey-reference",
    segmentResolution: "position-inferred-v1", timeUnit: "milliseconds", sampleHz: 4,
    recordingPurpose: "SYNTHETIC-STATUS-QA（非实录）：状态占用与变形头像的合成测试", recorderVersion: "0.7.0-qa",
    startedAtUtc: "2026-09-16T00:00:00Z", durationMs: 40000, route,
    participants: [{ id: QA_PLAYER_ID, nickname: "SYNTHETIC-STATUS-QA（非实录）", platform: "QA fixture" }] };
  const appearance = (seconds, form, cosmeticReady = true) => {
    const values = cosmeticReady ? { ...cosmetics } : { ready: false, authority: SOURCE, source: SOURCE,
      ...Object.fromEntries(INDEX_FIELDS.map((key) => [key, null])), skinColor: null, outfitName: "", hatName: "" };
    return { type: "appearance", t: seconds * 1000, playerId: QA_PLAYER_ID, appearance: { ...values,
      formReady: form !== "unknown", form, formAuthority: SOURCE, formRendererActive: form === "unknown" ? null : true,
      formMeshName: form === "skeleton" ? skeleton.source?.meshName || null : null,
      formMaterialNames: form === "skeleton" && skeleton.source?.materialName ? [skeleton.source.materialName] : [] } };
  };
  const status = (seconds, { blocked = false, petrify = false, glowing = false, ready = true } = {}) => ({
    type: "status", t: seconds * 1000, playerId: QA_PLAYER_ID,
    status: { ready, complete: ready, authority: SOURCE, source: SOURCE, dead: false,
      values: ready ? STATUS_NAMES.map((type, id) => ({ id, type,
        amount: blocked && type === "Cold" ? 0.2 : blocked && type === "Curse" ? 0.1 : petrify && type === "Petrify" ? 0.4 : 0,
        staminaBlock: blocked && type === "Cold" ? 0.2 : blocked && type === "Curse" ? 0.1 : 0,
        extraStaminaBlock: petrify && type === "Petrify" ? 0.4 : 0 })) : [],
      statusSum: ready ? blocked ? 0.3 : 0 : null,
      baseMaxStamina: ready ? 1 : null, maxStamina: ready ? blocked ? 0.7 : 1 : null,
      baseMaxExtraStamina: ready ? 1 : null, maxExtraStamina: ready ? petrify ? 0.6 : 1 : null,
      effectsReady: true, effectsAuthority: SOURCE,
      // Glowing=4 is from the installed build's Affliction.AfflictionType enum.
      // Its independent 7–18s interval is synthetic, not a claimed real event.
      effects: glowing ? [{ typeId: 4, type: "Glowing" }] : [] },
  });
  const telemetry = (seconds, cap = 1, extraCap = 1, ready = true) => ({ type: "state", t: seconds * 1000,
    playerId: QA_PLAYER_ID, telemetryReady: ready, capacityReady: ready, authority: SOURCE,
    baseMaxStamina: ready ? 1 : null, maxStamina: ready ? cap : null, stamina: ready ? cap < 1 ? 0.35 : 0.8 : null,
    baseMaxExtraStamina: ready ? 1 : null, maxExtraStamina: ready ? extraCap : null, extraStamina: ready ? 0.3 : null });
  const descriptions = [
    [0, "普通形态，状态为空，正常体力上限"], [5, "寒冷20% + 诅咒10%，普通体力35% / 上限70%"],
    [7, "独立效果 Glowing 出现，状态数值不变"], [10, "石化40%，额外体力上限60%"],
    [15, "骷髅形态，保留公开目录中的皇冠"], [18, "Glowing 效果清除，寒冷/诅咒/石化仍在"],
    [22, "恢复普通形态"], [27, "骷髅形态已知，但装扮同步未就绪（索引全null）"],
    [32, "普通形态，完整清空状态"], [37, "状态未就绪、形态未知，不得残留骷髅或假装健康"],
  ];
  const records = [
    { type: "route", t: 0, route },
    appearance(0, "normal"), appearance(15, "skeleton"), appearance(22, "normal"),
    appearance(27, "skeleton", false), appearance(32, "normal"), appearance(37, "unknown", false),
    status(0), status(5, { blocked: true }), status(7, { blocked: true, glowing: true }),
    status(10, { blocked: true, petrify: true, glowing: true }), status(18, { blocked: true, petrify: true }),
    status(32), status(37, { ready: false }),
    telemetry(0), telemetry(5, 0.7), telemetry(10, 0.7, 0.6), telemetry(32), telemetry(37, 1, 1, false),
    ...descriptions.map(([seconds, label]) => ({ type: "event", event: "event", t: seconds * 1000,
      playerId: QA_PLAYER_ID, label: `合成测试 · ${label}`, source: SOURCE, confidence: "synthetic-not-gameplay" })),
  ];
  for (let t = 0; t <= 40000; t += 250) records.push({ type: "sample", t, playerId: QA_PLAYER_ID,
    pos: [anchor[0] + Math.sin(t / 3500) * 0.8, anchor[1], anchor[2]], yaw: 180, segment: 0, activeSegment: 0 });
  records.sort((a, b) => a.t - b.t);
  return { manifest, records, checks: descriptions, cosmeticSelection: cosmetics };
}

export async function validatePlayerConditionsFixture(fixture) {
  const manifestText = JSON.stringify(fixture.manifest, null, 2) + "\n";
  const streamText = fixture.records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const trace = await loadTraceBundle([{ name: "manifest.json", text: async () => manifestText },
    { name: "stream.ndjson", text: async () => streamText }]);
  const at = (time) => tracePlayerStateAtTime(trace, QA_PLAYER_ID, time);
  assert.equal(trace.duration, 40);
  assert.equal(at(0).appearance.form, "normal");
  const five = at(5), fiveBar = staminaLayout(five.telemetry, five.status);
  assert.equal(fiveBar.ratio, 0.35); assert.equal(fiveBar.capacity, 0.7);
  assert.deepEqual(fiveBar.blocks.map((entry) => entry.type), ["Cold", "Curse"]);
  assert.equal(staminaLayout(at(10).telemetry, at(10).status, true).capacity, 0.6);
  assert.deepEqual(at(6.99).status.effects, []); assert.equal(at(7).status.effects[0].type, "Glowing");
  assert.deepEqual(at(18).status.effects, []);
  assert.equal(at(14.99).appearance.form, "normal"); assert.equal(at(15).appearance.form, "skeleton");
  assert.equal(at(15).appearance.effectiveHatIndex, fixture.cosmeticSelection.effectiveHatIndex);
  assert.equal(at(22).appearance.form, "normal");
  assert.equal(at(27).appearance.ready, false); assert.equal(at(27).appearance.formReady, true);
  assert.equal(at(27).appearance.form, "skeleton"); assert.equal(at(27).appearance.effectiveHatIndex, null);
  assert.equal(at(32).appearance.form, "normal"); assert.equal(at(32).status.complete, true);
  assert.ok(at(32).status.values.every((value) => value.amount === 0));
  assert.equal(at(37).appearance.form, "unknown"); assert.equal(at(37).appearance.formReady, false);
  assert.equal(at(37).status.ready, false); assert.equal(at(37).telemetry.ready, false);
  assert.equal(at(16).appearance.form, "skeleton"); assert.equal(at(1).appearance.form, "normal");
  return { trace, manifestText, streamText };
}

async function generateLocalFixture() {
  const catalog = JSON.parse(await readFile(resolve(platformDirectory, "data/maps/catalog.json"), "utf8"));
  const entry = catalog.mapPacks.find((value) => value.sceneName === "Level_17" && value.enabled !== false);
  if (!entry) throw new Error("Existing Level_17 map is required for this synthetic fixture");
  const directory = resolve(localAssetPaths.mapPacksDirectory, entry.mapPackId);
  const pack = JSON.parse(await readFile(resolve(directory, "map-pack.json"), "utf8"));
  const evidence = JSON.parse(await readFile(resolve(platformDirectory, `data/maps/routes.${pack.gameBuildId}.json`), "utf8"));
  const route = evidence.maps.find((value) => value.mapPackId === pack.mapPackId)?.route;
  if (!route) throw new Error("Exact map route metadata is required");
  const assets = JSON.parse(await readFile(resolve(localAssetPaths.gameAssetsDirectory, String(pack.gameBuildId), "catalog.json"), "utf8"));
  const layer = pack.layers.find((value) => value.segment === 0);
  const height = await readFile(resolve(directory, layer.height));
  let anchor = null, distance = Infinity;
  for (let row = 0; row < layer.rows; row++) for (let col = 0; col < layer.columns; col++) {
    const y = height.readFloatLE((row * layer.columns + col) * 4);
    const next = (col - layer.columns / 2) ** 2 + (row - layer.rows / 2) ** 2;
    if (!Number.isFinite(y) || next >= distance) continue;
    distance = next;
    anchor = [layer.minX + (col + 0.5) / layer.columns * (layer.maxX - layer.minX), y + 0.8,
      layer.minZ + (row + 0.5) / layer.rows * (layer.maxZ - layer.minZ)];
  }
  if (!anchor) throw new Error("Shore survey contains no finite reference point");
  const fixture = createPlayerConditionsFixture({ pack, route, customization: assets.customization, anchor });
  const validated = await validatePlayerConditionsFixture(fixture);
  const outputDirectory = resolve(repositoryDirectory, "local/verification/player-conditions-qa");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "manifest.json"), validated.manifestText);
  await writeFile(resolve(outputDirectory, "stream.ndjson"), validated.streamText);
  console.log(JSON.stringify({ outputDirectory, purpose: fixture.manifest.recordingPurpose,
    duration: validated.trace.duration, sampleCount: validated.trace.sampleCount,
    chapter: "Shore / 海岸 (0)", hat: fixture.cosmeticSelection.hatName, checks: fixture.checks }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateLocalFixture();
