// These are observations of native renderers, independent of status bars,
// inventory and death. Unknown snapshots clear earlier visuals.
export function observedAppearanceVisuals(appearance) {
  const state = (prefix) => {
    const known = appearance?.[`${prefix}Ready`] === true && typeof appearance?.[`${prefix}Active`] === "boolean";
    return { known, active: known && appearance[`${prefix}Active`] === true };
  };
  return { ghost: state("ghost"), petrification: state("petrification"), blindness: state("blindness") };
}

export function appearanceVisualFingerprint(appearance) {
  return ["ghostReady", "ghostActive", "ghostVisible", "petrificationReady", "petrificationActive",
    "petrificationAmount", "petrificationTriggered", "petrificationProgress", "blindnessReady", "blindnessActive"]
    .map(key => appearance?.[key] ?? "unknown").join(":");
}

/** Static Web preview approximation: map the observed shader value across the
 * exact build's native curve endpoints. This does not reproduce Unity's shader. */
export function petrificationCoverage(amount, entry) {
  if (!Number.isFinite(amount)) return null;
  const keys = entry?.runtimeBinding?.petrifyCurve?.m_Curve;
  const low = keys?.[0]?.value, high = keys?.at(-1)?.value;
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
  return Math.min(1, Math.max(0, (amount - low) / (high - low)));
}
