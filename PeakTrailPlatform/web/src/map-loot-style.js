// Kept free of renderer dependencies so the filter legend can use the same
// colors before the map's Three.js modules have loaded.
export const MAP_LOOT_MAX_BEAM_HEIGHT = 14;

export const LOOT_TYPE_STYLES = Object.freeze({
  chest: Object.freeze({ color: "#efbc62", beamHeight: 12, beamWidth: 1.65, kind: "chest" }),
  luggage: Object.freeze({ color: "#efbc62", beamHeight: 12, beamWidth: 1.65, kind: "chest" }),
  chest_small: Object.freeze({ color: "#efbc62", beamHeight: 11, beamWidth: 1.5, kind: "chest" }),
  chest_large: Object.freeze({ color: "#eea16b", beamHeight: 13, beamWidth: 1.85, kind: "chest" }),
  chest_epic: Object.freeze({ color: "#bca0ff", beamHeight: 14, beamWidth: 1.85, kind: "chest" }),
  chest_ancient: Object.freeze({ color: "#f3deb1", beamHeight: 14, beamWidth: 1.85, kind: "chest" }),
  chest_trick: Object.freeze({ color: "#ed9486", beamHeight: 12, beamWidth: 1.65, kind: "chest" }),
  ancient_chest: Object.freeze({ color: "#bca0ff", beamHeight: 14, beamWidth: 1.85, kind: "chest" }),
  ice_chest: Object.freeze({ color: "#8cd9f0", beamHeight: 12, beamWidth: 1.65, kind: "chest" }),
  item: Object.freeze({ color: "#88d7c6", beamHeight: 9, beamWidth: 1.2, kind: "item" }),
  item_napberry: Object.freeze({ color: "#c9a7e6", beamHeight: 9, beamWidth: 1.2, kind: "item" }),
  item_bird_nest: Object.freeze({ color: "#b4ce91", beamHeight: 9, beamWidth: 1.2, kind: "item" }),
  item_shelf_shroom: Object.freeze({ color: "#88d7c6", beamHeight: 9, beamWidth: 1.2, kind: "item" }),
  item_backpack: Object.freeze({ color: "#84bfe6", beamHeight: 9, beamWidth: 1.2, kind: "item" }),
  item_piton: Object.freeze({ color: "#c1ccdb", beamHeight: 9, beamWidth: 1.2, kind: "item" }),
  animal: Object.freeze({ color: "#f2ba91", beamHeight: 12, beamWidth: 1.6, kind: "animal" }),
  animal_capybara: Object.freeze({ color: "#f2ba91", beamHeight: 12, beamWidth: 1.6, kind: "animal" }),
});

const CHEST_COLORS = ["#efbc62", "#a8a0ef", "#ee9a82", "#8ccddd", "#b3cf85"];
const ITEM_COLORS = ["#88d7c6", "#b3cf85", "#82b9e8", "#e5adba", "#c6bb8f"];

/** A stable CSS palette is shared by the filter legend and the map markers. */
export function lootTypeStyle(type, category = "item", explicitColor = null) {
  const descriptor = type && typeof type === "object" ? type : null;
  const key = String(descriptor?.id ?? type ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const requestedKind = descriptor?.category ?? category;
  const kind = requestedKind === "chest" || requestedKind === "animal" ? requestedKind : "item";
  const known = LOOT_TYPE_STYLES[key];
  const base = known ?? LOOT_TYPE_STYLES[kind];
  let hash = 0;
  for (let index = 0; index < key.length; index++) hash = (Math.imul(hash, 31) + key.charCodeAt(index)) >>> 0;
  const supplied = explicitColor ?? descriptor?.color;
  const color = typeof supplied === "string" && /^#[\da-f]{6}$/i.test(supplied)
    ? supplied : known?.color ?? (kind === "animal" ? base.color : (kind === "chest" ? CHEST_COLORS : ITEM_COLORS)[hash % 5]);
  return { ...base, color, kind };
}
