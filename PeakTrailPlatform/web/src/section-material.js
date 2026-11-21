// Original opaque structural draws in the verified finale GLBs. Shared stone
// also occurs on traps, walkways and props. Those draws keep their material.
const rockSurfaces = new Set(["M_Rock", "M_Rock_peak", "M_Rock_Volcano",
  "M_Rock_Volcano_Hot", "M_Rock_Volcano_petrify", "M_Petrified_Stone_Evil", "M_temple_stone_Dagger"]);
const rockMeshes = new Set(["Rock_Hill", "Rock_Round", "Rock_Round.002",
  "Rock_Round.010", "RockFinal", "LavaPillar", "LavaPillar2", "Pillar", "Wall Petrified Stone", "DesertRock1"]);
const towerMeshes = new Set(["Bridge Structure", "Bridge Structure Long", "Bridge Structure match",
  "Central Tower Entry", "Central Tower Exit", "Entrance Celing Decor"]);

function isStructuralDraw(material, sourceMesh, splitShell) {
  if (!material?.isMeshStandardMaterial || material.transparent || material.opacity !== 1 || !material.depthWrite) return false;
  const terrain = material.userData?.peakTerrain;
  const shader = terrain?.sourceColors?.shader, name = terrain?.sourceMaterial || material.name;
  // The authored shell contains its own trim, beams and two emissive eye
  // panels. These slots follow the parent wall. Identically named materials
  // on separate ladders, bridges, loot and statues remain intact.
  if (shader === "W/Peak_Standard")
    return (name === "Tarnished Gold Carving" && (splitShell || towerMeshes.has(sourceMesh)))
      || (splitShell && name === "M_RopeBridgeWood");
  if (splitShell && name === "EyesGlow")
    return shader === "Universal Render Pipeline/Lit" || shader === "Universal Render Pipeline/Simple Lit";
  if (shader !== "W/Peak_Rock") return false;
  if (splitShell) return name === "M_temple_stone_Citadel" || name === "M_Rock_Volcano";
  if (name === "M_temple_stone_Citadel") return towerMeshes.has(sourceMesh);
  return rockSurfaces.has(name) && rockMeshes.has(sourceMesh);
}

// Same half-space and contact tests as section-plane.js. Recover the actual
// world position from Three's view vector (including instancing, glTF affine
// transforms and the scene's reflection). The plane is vertical at all pitches.
const section = `
  if (peakSectionPlane.w > 0.0) {
    vec3 world = cameraPosition - vViewPosition * mat3(viewMatrix);
    bool cut = dot(world.xz, peakSectionPlane.xy) + peakSectionPlane.z > 0.0;
    if (peakSectionFooting.w > 0.0) {
      // Uniform branch: derivatives execute before any fragment-dependent branch.
      vec3 face = cross(dFdx(vViewPosition), dFdy(vViewPosition));
      if (cut) {
        vec2 delta = world.xz - peakSectionFooting.xz;
        float height = world.y - peakSectionFooting.y;
        bool nearFoot = dot(delta, delta) <= peakSectionFooting.w * peakSectionFooting.w
          && height >= -2.0 && height <= 1.25;
        vec2 facing = cameraPosition.xz - peakSectionFooting.xz;
        if (dot(facing, facing) < 0.00000001) facing = peakSectionPlane.xy;
        bool floorFace = height <= 0.0 && dot(face, viewMatrix[1].xyz) >= 0.55 * length(face);
        cut = !(nearFoot && (floorFace || dot(delta, facing) <= 0.0));
      }
    }
    if (cut) discard;
  }`;

export function sectionMaterial(material, sourceMesh, splitShell, plane, cache) {
  if (!isStructuralDraw(material, sourceMesh, splitShell)) return material;
  if (cache.has(material)) return cache.get(material);
  const clone = material.clone();
  const compile = material.onBeforeCompile, programKey = material.customProgramCacheKey();
  clone.userData.peakSectionPlane = true;
  clone.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.peakSectionPlane = plane;
    shader.uniforms.peakSectionFooting = plane.footing;
    shader.fragmentShader = "uniform vec4 peakSectionPlane;\nuniform vec4 peakSectionFooting;\n" + shader.fragmentShader
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n" + section);
  };
  clone.customProgramCacheKey = () => programKey + "-section-v1";
  cache.set(material, clone);
  return clone;
}
