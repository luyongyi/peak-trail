// These are original opaque W/Peak_Rock terrain draws in the signed finale
// GLBs. The Citadel stone also appears on traps and props, so require the
// source mesh role before giving a draw the spectator-window shader.
const rockSurfaces = new Set(["M_Rock", "M_Rock 1", "M_Rock_peak", "M_Rock_Volcano",
  "M_Rock_Volcano_Hot", "M_Rock_Volcano_petrify", "M_temple_stone_Dagger"]);
const rockMeshes = new Set(["Rock_Hill", "Rock_Hold1", "Rock_Platform", "Rock_Round", "Rock_Round.002",
  "Rock_Round.010", "RockFinal", "LavaPillar", "LavaPillar2", "Pillar", "Wall Petrified Stone", "DesertRock1"]);
const towerMeshes = new Set(["Bridge Structure", "Bridge Structure Long", "Bridge Structure match",
  "Central Tower Entry", "Central Tower Exit", "Entrance Celing Decor"]);

function eligible(material, sourceMesh, splitShell) {
  if (!material?.isMeshStandardMaterial || material.transparent || material.opacity !== 1 || !material.depthWrite) return false;
  const terrain = material.userData?.peakTerrain;
  if (terrain?.sourceColors?.shader !== "W/Peak_Rock") return false;
  const name = terrain.sourceMaterial || material.name;
  if (splitShell) return name === "M_temple_stone_Citadel" || name === "M_Rock_Volcano";
  if (name === "M_temple_stone_Citadel") return towerMeshes.has(sourceMesh);
  return rockSurfaces.has(name) && rockMeshes.has(sourceMesh);
}

// vViewPosition is minus the actual view-space position, including instancing
// and the viewer's mirrored world transform. gl_FragCoord uses framebuffer
// pixels; both sides use the same bottom-left origin and effective pixel ratio.
const opening = `
  if (peakFollowCircle.w > 0.0) {
    vec3 face = cross(dFdx(vViewPosition), dFdy(vViewPosition));
    vec2 offset = gl_FragCoord.xy - peakFollowCircle.xy;
    if (dot(offset, offset) < peakFollowCircle.z * peakFollowCircle.z && vViewPosition.z < peakFollowCircle.w) {
      vec3 up = viewMatrix[1].xyz;
      float height = cameraPosition.y - dot(vViewPosition, up);
      bool support = height <= peakFollowSupportY && dot(face, up) >= 0.55 * length(face);
      if (!support) discard;
    }
  }`;

export function followWindowMaterial(material, sourceMesh, splitShell, window, cache) {
  if (!eligible(material, sourceMesh, splitShell)) return material;
  if (cache.has(material)) return cache.get(material);
  const clone = material.clone();
  const compile = material.onBeforeCompile, programKey = material.customProgramCacheKey();
  clone.userData.peakFollowWindow = true;
  clone.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.peakFollowCircle = window;
    shader.uniforms.peakFollowSupportY = window.supportY;
    shader.fragmentShader = "uniform vec4 peakFollowCircle;\nuniform float peakFollowSupportY;\n" + shader.fragmentShader
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n" + opening);
  };
  clone.customProgramCacheKey = () => programKey + "-follow-window-v1";
  cache.set(material, clone);
  return clone;
}
