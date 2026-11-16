import { isDeepStrictEqual } from "node:util";
import { requireActiveCharacterAssets } from "./game-assets.mjs";
import { readVerifiedMapBuild } from "./verified-map-input.mjs";

// A deliberate marker-only navigation release for this one audited game build.
// This does not certify, relabel or alias an older character model as 3.1 art.
export const MARKER_ONLY_PLAYER_PUBLICATION = Object.freeze({ mode: "markers", gameBuildId: "26542162",
  receiptSha256: "621994e6322473283a100a30e83a4d0849a0fbad72afbca9fb247324b10c77ed" });
const PLAN_SHA256 = "1003401d97ca71d5de6281cfba302e781f4934060da448fc7f2731ac8f37ed7e";
const require = (condition, reason) => { if (!condition) throw new Error(`Player visualization: ${reason}`); };

/** Ordinary publications still require the exact active build's avatar assets. */
export async function requirePublishedCharacterAssets(gameAssets, catalog, { mapsDirectory }) {
  const declaration = catalog?.playerVisualization;
  if (declaration === undefined) return requireActiveCharacterAssets(gameAssets, catalog?.activeGameBuildId);
  require(isDeepStrictEqual(declaration, MARKER_ONLY_PLAYER_PUBLICATION), "unreviewed marker-only declaration");
  require(String(catalog.activeGameBuildId) === declaration.gameBuildId, "marker-only active build mismatch");
  const verified = await readVerifiedMapBuild(declaration.gameBuildId, { mapsDirectory });
  require(verified && verified.planSha256 === PLAN_SHA256 && verified.receiptSha256 === declaration.receiptSha256,
    "marker-only publication requires the pinned map plan and receipt");
  require(verified.plan.sourceGameBuildId === "26155610" && verified.plan.gameVersion === "3.1.0--logFile"
    && verified.plan.packs.length === 208 && verified.proof.maps.length === 208, "incomplete marker-only map proof");
  const planned = new Map(verified.plan.packs.map(pack => [pack.mapPackId, pack]));
  const native = new Map(verified.proof.maps.map(map => [map.sourceMapPackId, map]));
  const current = catalog.mapPacks.filter(entry => String(entry.gameBuildId) === declaration.gameBuildId);
  require(current.length === 208 && new Set(current.map(entry => entry.mapPackId)).size === 208,
    "marker-only catalog must retain the complete verified build");
  for (const entry of current) {
    const pack = planned.get(entry.mapPackId), scene = native.get(pack?.sourceMapPackId);
    require(scene && entry.enabled !== false && entry.gameVersion === verified.plan.gameVersion
      && entry.mapSlot === scene.mapSlot && entry.sceneName === scene.sceneName,
    "marker-only catalog differs from its pinned map inventory");
  }
}
