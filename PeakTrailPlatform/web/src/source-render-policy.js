// Exact-build effect-volume evidence is documented in
// tools/offline-maps/EFFECT-PROXIES.md. These are projection volumes, not props.
// Do not classify by mesh name: PEAK also has genuine spherical mushrooms,
// glass and AntiSphere objects that must remain visible.
const PROJECTED_DECALS = new Set(["M_VFX_PetrifyDecal", "M_VFX_FireballDecal"]);

export function isSourceProjectionProxy(gameBuildId, materialName, shader) {
  return String(gameBuildId) === "25306743" && shader === "Decal"
    && PROJECTED_DECALS.has(materialName);
}

export function isProjectionProxyMaterial(gameBuildId, material) {
  const source = material?.userData?.peakTerrain;
  return isSourceProjectionProxy(gameBuildId, source?.sourceMaterial || material?.name,
    source?.sourceColors?.shader);
}

// Legacy GLBs omitted MeshRenderer.shadowCastingMode. These exact node indices
// are audited ShadowsOnly renderers, NOT solid terrain. Each pair is one affine
// floor and one GPU-instanced group of three walls. Bind to the verified delivery
// digest, never Quad/Lit names, size, date or a reusable mesh/material index.
// Source evidence: tools/offline-maps/SHADOW-ONLY-RENDERERS.md.
const SHADOW_ONLY_NODES = new Map([
  ["dedd6fd11a4b046c0a4c82b29702fde29076d11f6ba51fa0460a2bf19e4db79b", [0, 1506]], // Level_2
  ["db142d322fc18bc65e85fff216e237d9ea32691fa31be651ba4233c40c0ae78c", [83, 1609]], // Level_4
  ["afe212e9b280fbe6ad7b44ddcf30cc3c4b04e2dc65ecd07f4239571875400bfd", [84, 1592]], // Level_5
  ["ae0dce8bab3731557b5068df80748d0bc0e705782b61a57422d95ad93a2c2c70", [79, 1757]], // Level_7
  ["d674b1af69b5e89536fd48abaacaf5f7557dce2cebf31a6a57163e93c4b24ead", [83, 1650]], // Level_8
  ["0139b61dfa7c8318065abd3d77d6bcea4ea523fe85c37a10288387054cd78ce0", [0, 1429]], // Level_11
  ["039478772c5b9ecbb65d7a38e2f6ec5e548fe7daf53ceb133d1359034c3bbc19", [0, 1419]], // Level_12
  ["443beef703056227d5f6acd23f392f8745c3503ea66635a7b291288c8d8750f4", [79, 1584]], // Level_14
  ["5b2fb552e03f0b508283bc8c9f60e6d51981c6bcd842a71c5799360c89474e28", [83, 1622]], // Level_17
  ["d4cac7f8bd390cdf7527edba8d7f0fda06cd8389af529bed1975b1afceaf3516", [0, 1502]], // Level_19
  ["275a6963d956331828ca53402841ba669eb8788a1494402045227fd57be21653", [0, 1598]], // Level_20
]);

/** Call only after hashing the downloaded bytes, not with an unverified claim. */
export function shadowOnlyNodeIndices(gameBuildId, verifiedDigest) {
  return new Set(String(gameBuildId) === "25306743"
    ? SHADOW_ONLY_NODES.get(verifiedDigest) || [] : []);
}
