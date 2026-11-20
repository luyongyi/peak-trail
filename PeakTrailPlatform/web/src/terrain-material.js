// The world-up _TopColor blend is only reproduced where this build's own survey
// capture supports it (W/Peak_Rock: sand-coloured tops on sand and rock, matching
// W/Peak_Rock's authored per-material top colour). Three shader families contradict
// that capture, so painting them by surface slope is not reproducible:
//   GD/FoliageGD  - every material stores the same default _TopColor [0.11,0.19,0.19];
//                   a tall cactus crown stays pink in the capture, not teal.
//   W/Peak_Mirage - same shared default top colour as the foliage shader.
//   W/Peak_Petrified_Rock - M_Petrified_Stone_Char would go cyan [0.11,0.70,0.78]
//                   and M_Petrified_Stone black; the capture shows warm tan stone.
const UNREPRODUCED_TOP_COLOR_SHADERS = new Set(["GD/FoliageGD", "W/Peak_Mirage", "W/Peak_Petrified_Rock"]);

/** Top blend amount that is actually supported by the material evidence. */
export function verifiableTopBlend(shader, amount) {
  const value = Number.isFinite(amount) ? amount : 1;
  return UNREPRODUCED_TOP_COLOR_SHADERS.has(shader) ? 0 : value;
}

export function applyTerrainMaterial(THREE, material) {
  const terrain = material.userData?.peakTerrain;
  if (!terrain) return;
  const base = terrain.baseColor;
  const top = terrain.topColor;
  if (!Array.isArray(base) || !Array.isArray(top)) return;
  // W/Peak_Rock samples _BaseTexture on UV0 for the bottom layer, then blends
  // that layer with the independent top colour. Generated forest ground has
  // constant UV0.u: multiplying this texture over the top creates false stripes.
  const baseTextureOnly = terrain.sourceColors?.shader === "W/Peak_Rock";
  material.color.set(0xffffff);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.peakBase = { value: new THREE.Color(base[0], base[1], base[2]) };
    shader.uniforms.peakTop = { value: new THREE.Color(top[0], top[1], top[2]) };
    const ramp = Array.isArray(terrain.tightness) ? terrain.tightness : [0, 1];
    shader.uniforms.peakRamp = { value: new THREE.Vector2(Number(ramp[0]) || 0, Number(ramp[1]) || 1) };
    shader.uniforms.peakAmount = { value: verifiableTopBlend(terrain.sourceColors?.shader, terrain.amount) };
    shader.uniforms.peakTopAlpha = { value: Number.isFinite(terrain.topAlpha) ? terrain.topAlpha : 1 };
    shader.vertexShader = "varying float vPeakUp;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <defaultnormal_vertex>",
      "#include <defaultnormal_vertex>\nvPeakUp = max(inverseTransformDirection(normalize(transformedNormal), viewMatrix).y, 0.0);");
    shader.fragmentShader = "varying float vPeakUp;\nuniform vec3 peakBase;\nuniform vec3 peakTop;\nuniform vec2 peakRamp;\nuniform float peakAmount;\nuniform float peakTopAlpha;\n" + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>",
      baseTextureOnly
        ? "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb * peakBase, peakTop, smoothstep(peakRamp.x, peakRamp.y, vPeakUp) * peakAmount * peakTopAlpha);"
        : "#include <color_fragment>\ndiffuseColor.rgb *= mix(peakBase, peakTop, smoothstep(peakRamp.x, peakRamp.y, vPeakUp) * peakAmount * peakTopAlpha);");
  };
  material.customProgramCacheKey = () => baseTextureOnly ? "peak-terrain-rock-base-map-v2" : "peak-terrain-original-mesh-v1";
  material.needsUpdate = true;
}
