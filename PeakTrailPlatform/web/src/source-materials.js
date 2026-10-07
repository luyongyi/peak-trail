import { effects25739797 } from './source-materials.25739797.js';

// PEAK build 25306743, read from sharedassets4.assets; no chosen biome palette.
// Full raw color/shader evidence: tools/offline-maps/source-effect-materials.25306743.json.
// These are color-only substitutes for depth/flow shaders, not game screenshots.
const effects = {
  M_Lava: {kind: 'lava', shader: 'Lava', pathId: 93, property: '_BaseColor', flags: 16,
    rgba: [4.083005905151367, 0.33255404233932495, 0.021377036347985268, 0.9882352948188782]},
  M_Water_forest: {kind: 'water', shader: 'GD/Water-GD', pathId: 104, property: '_WaterColorPrimary', flags: 0,
    rgba: [0.08235294371843338, 0.3960784375667572, 0.2622412145137787, 0], depth: 8},
  'M_Water_forest 1': {kind: 'water', shader: 'GD/Water-GD', pathId: 102, property: '_WaterColorPrimary', flags: 0,
    rgba: [0.595720648765564, 0.13830536603927612, 0.698113203048706, 0], depth: 8},
  M_Water_Onsen: {kind: 'water', shader: 'GD/Water-GD', pathId: 101, property: '_WaterColorPrimary', flags: 0,
    rgba: [0.08410467207431793, 0.3338019847869873, 0.3962264060974121, 0], depth: 4},
  M_Water_swamp: {kind: 'water', shader: 'GD/Water-GD', pathId: 107, property: '_WaterColorPrimary', flags: 0,
    rgba: [0.7053561806678772, 0.7452830076217651, 0.28475427627563477, 0], depth: 15.960000038146973,
    // The depth shader multiplies its mixed surface by this independent tint.
    // Omitting it turns the whole swamp into an unnaturally bright yellow plate.
    waterDepth: {
      shallow: [0.14728191494941711, 0.06274504214525223, 0.20784303545951843, 0],
      tint: [0.36078423261642456, 0.5154326558113098, 0.6235294342041016, 0], flags: 0,
    }},
  'M_Void Water': {kind: 'water', shader: 'GD/Water-GD', pathId: 99, property: '_WaterColorPrimary', flags: 0,
    rgba: [0, 0, 0, 0], depth: 0},
  'FogSurface void': {kind: 'fog', shader: 'GD/FogSurface', pathId: 20, property: '_Color', flags: 0,
    rgba: [0.7095718383789062, 0.6693217754364014, 0.8396226167678833, 1], opacity: 0.22100000083446503},
  FogSurface: {kind: 'fog', shader: 'GD/FogSurface', pathId: 21, property: '_Color', flags: 0,
    rgba: [0.2705881893634796, 0.45098042488098145, 0.9058824181556702, 1], opacity: 0.4169999957084656},
  AntiSphere: {kind: 'antisphere', shader: 'AntiSphere', asset: 'resources.assets', pathId: 13,
    property: null, flags: null, rgba: [1, 1, 1, 1], depthWrite: true,
    power: 0.25, softInverse: 0.5, borderLight: 0},
  AntiSphereInterior: {kind: 'antisphere', shader: 'AntiSphere', asset: 'resources.assets', pathId: 14,
    property: null, flags: null, rgba: [1, 1, 1, 1], depthWrite: true,
    power: 0.25, softInverse: 0.5, borderLight: 1},
  // Jelly does not declare the white _BaseColor left in its saved material.
  // Its actual shader blends these authored purple colors with two masks and
  // refracted scene color. Color.a controls that refraction mix, not opacity.
  Jelly: {kind: 'jellyfish', shader: 'Jelly', pathId: 30, property: '_Color', flags: 0,
    rgba: [0.6933333277702332, 0.4470587968826294, 0.7450980544090271, 0.1568627506494522],
    secondaryRgba: [0.7364031076431274, 0.3686273992061615, 0.7529411911964417, 0.3764705955982208],
    textureRgba: [0.01567428931593895, 0, 0.6352200508117676, 1],
    depthWrite: true, cull: 2},
  // _Tint is a neutral shader multiplier, not these mushrooms' albedo. The
  // original exporter selected it and made every hazardous variant grey.
  // Preserve the source HDR base without inventing emission or an alpha layer.
  M_SporeShroomExplo: {kind: 'hazard', shader: 'W/Peak_Standard', pathId: 144, property: '_BaseColor', flags: 16,
    rgba: [0.7169811725616455, 0.25232812762260437, 0, 1]},
  M_SporeShroomPoison: {kind: 'hazard', shader: 'W/Peak_Standard', pathId: 145, property: '_BaseColor', flags: 16,
    rgba: [0.1094617173075676, 0.3564002513885498, 0.2746773660182953, 1]},
  M_SporeShroomPoison_Ivy: {kind: 'hazard', shader: 'W/Peak_Standard', pathId: 146, property: '_BaseColor', flags: 16,
    rgba: [0.14036913216114044, 0.10980391502380371, 0.35686275362968445, 1]},
  M_SporeShroomSpores: {kind: 'hazard', shader: 'W/Peak_Standard', pathId: 147, property: '_BaseColor', flags: 16,
    rgba: [0.24045296013355255, 0.40566039085388184, 0.10906906425952911, 1]},
  // Giant cap colours use _BaseColor multiplied by the independent _Tint.
  // The pale bell's outer shell uses M_MushroomBase, so it keeps its colour.
  // Audit: tools/offline-maps/source-fungal-colors-evidence.json. The normal
  // cap is also verified against archived 25306743 source properties. Evil
  // and Glow primary colours were read from 25739797; their published _Tint
  // inputs match, while full shader/layer identity across builds is unclaimed.
  M_Mushroom_tree: {kind: 'fungus', shader: 'W/Peak_Standard', asset: 'sharedassets3.assets', pathId: 69,
    property: '_BaseColor', flags: 16, evidenceBuildId: 25306743,
    rgba: [0.5377358198165894, 0.04819329082965851, 0.06242681294679642, 1],
    tint: [0.4842766523361206, 0.4842766523361206, 0.4842766523361206, 1], tintFlags: 16},
  M_Mushroom_tree_evil: {kind: 'fungus', shader: 'W/Peak_Standard', pathId: 142,
    property: '_BaseColor', flags: 16, evidenceBuildId: 25739797,
    rgba: [0.27358490228652954, 0.08130117505788803, 0.14009465277194977, 1],
    tint: [0.4842766523361206, 0.4842766523361206, 0.4842766523361206, 1], tintFlags: 16},
  'Glow Shroom': {kind: 'fungus', shader: 'W/Peak_Standard', pathId: 26,
    property: '_BaseColor', flags: 16, evidenceBuildId: 25739797,
    rgba: [0.18783606588840485, 0, 0.3207547068595886, 1],
    tint: [0.7490195631980896, 0.7490195631980896, 0.7490195631980896, 1], tintFlags: 16},
};

function linearComponent(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function getSourceEffectMaterial(buildId, materialName, shader) {
  const registry = String(buildId) === '25306743' ? effects : String(buildId) === '25739797' ? effects25739797 : null;
  if (!registry || !Object.hasOwn(registry, materialName)) return null;
  const effect = registry[materialName];
  if (effect.shader !== shader) return null;
  const primaryRgb = effect.rgba.slice(0, 3).map(v => effect.flags & 16 ? v : linearComponent(v));
  const tintRgb = effect.tint?.slice(0, 3).map(v => effect.tintFlags & 16 ? v : linearComponent(v));
  const rgb = tintRgb ? primaryRgb.map((v, i) => v * tintRgb[i]) : primaryRgb;
  const lava = effect.kind === 'lava';
  const opaque = effect.kind === 'hazard' || effect.kind === 'fungus';
  return {
    kind: effect.kind,
    // Lava uses the source HDR value only as emission; zero diffuse prevents
    // adding a second, lit copy of the same radiance. Do not clamp the HDR RGB.
    baseColor: lava ? [0, 0, 0] : [...rgb],
    emissive: lava ? [...rgb] : [0, 0, 0],
    emissiveIntensity: 1,
    transparent: !opaque,
    depthWrite: effect.depthWrite ?? opaque,
    // Water alpha is generated by a depth shader, NOT _WaterColorPrimary.a.
    // No scene depth buffer is reproduced here. 1 is the explicitly opaque
    // color-only fallback, not a purported source opacity or arbitrary tint.
    opacity: effect.opacity ?? 1,
    source: {
      buildId: effect.evidenceBuildId ?? 25306743,
      mapBuildId: Number(buildId),
      asset: effect.asset || 'sharedassets4.assets',
      pathId: effect.pathId,
      shader: effect.shader,
      material: materialName,
      colorProperty: effect.property,
      storedColor: effect.property ? [...effect.rgba] : null,
      propertyFlags: effect.flags,
      sourceColorLinear: effect.property ? [...primaryRgb] : null,
      tintProperty: tintRgb ? {property: '_Tint', storedColor: [...effect.tint],
        propertyFlags: effect.tintFlags, sourceColorLinear: [...tintRgb]} : null,
      depthProperty: effect.depth === undefined ? null : {_Depth: effect.depth},
      waterDepth: effect.waterDepth ? {
        primaryLinear: [...primaryRgb],
        shallowLinear: effect.waterDepth.shallow.slice(0, 3).map(linearComponent),
        tintLinear: effect.waterDepth.tint.slice(0, 3).map(linearComponent),
        depth: effect.depth,
        shallowStored: [...effect.waterDepth.shallow], tintStored: [...effect.waterDepth.tint],
        propertyFlags: effect.waterDepth.flags,
        shaderEvidenceBuildId: 25739797, crossBuildShaderIdentityVerified: false,
        sameBuildShaderEvidence: String(buildId) === '25739797',
        formula: 'smoothstep(0, 1, min(10 * min(abs(sceneEyeDepth - surfaceEyeDepth) / _Depth, 1), 1))',
        approximation: 'Shallow replaces the missing refracted scene colour; primary branch without noise, secondary colour, foam or waves; native alpha is not reconstructed',
      } : null,
      opacityProperty: effect.opacity === undefined ? null : {_Opacity: effect.opacity},
      alphaShape: effect.kind === 'antisphere' ? {_Alpha: 1, _Power: effect.power,
        _SoftInverse: effect.softInverse, _BorderLight: effect.borderLight} : null,
      colorLayers: effect.kind === 'jellyfish' ? {
        secondary: {property: '_Color2', flags: 0, rgba: [...effect.secondaryRgba]},
        texture: {property: '_Texture2Color', flags: 0, rgba: [...effect.textureRgba]},
        formula: 'lerp(_Texture2Color.rgb, lerp(_Color, _Color2, smoothstep(_Remap.x, _Remap.y, _Texture.r)).rgb, _Texture2.r)',
        alphaUse: '_Color.a and _Color2.a blend the tinted surface with refracted scene color; they are not output opacity',
      } : null,
      cull: effect.cull ?? null,
      pass: opaque ? {srcBlend: 1, dstBlend: 0, zWrite: 1}
        : {srcBlend: 5, dstBlend: 10, zWrite: effect.depthWrite ? 1 : 0},
      approximation: lava ? 'HDR base emitted without flow/noise/edge shader'
        : effect.waterDepth ? 'Source primary/shallow depth mix multiplied by WaterTint; refraction, secondary noise and foam are not reproduced; alpha fixed to 1'
        : effect.kind === 'water' ? 'Primary water color without depth/refraction/foam; alpha fixed to 1'
          : effect.kind === 'antisphere' ? 'Transparent Fresnel shell from source alpha-shape controls; animated top texture and scene-depth fade are not reproduced'
          : effect.kind === 'jellyfish' ? 'Source primary purple color; two texture-driven color layers, vertex tint, refraction and scene-depth alpha are not reproduced; alpha fixed to 1'
          : effect.kind === 'fungus' ? 'Source base albedo multiplied by _Tint; texture-driven colour layers, vertex AO and game lighting are not reproduced'
          : opaque ? 'Source opaque HDR base albedo; multilayer texture masks and hue variation are not reproduced'
            : 'Source fog color and opacity without depth/edge glow',
    },
  };
}
