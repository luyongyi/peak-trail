// Bounds belong to an original renderer instance, after its instance matrix
// and before the batch's model matrix. No per-triangle clipping is involved.
const vertexDeclarations = `
  uniform vec4 peakSectionModulePlane;
  uniform vec4 peakSectionModuleFooting;
  varying float vPeakSectionModuleHidden;
  #ifdef USE_INSTANCING
    attribute vec4 peakSectionModule;
    attribute vec3 peakSectionExtent;
  #endif
`;

const vertexMask = `
  vPeakSectionModuleHidden = 0.0;
  #ifdef USE_INSTANCING
    if (peakSectionModulePlane.w > 0.0 && peakSectionModule.w > 0.5
        && all(greaterThanEqual(peakSectionExtent, vec3(0.0)))) {
      vec3 centre = (modelMatrix * vec4(peakSectionModule.xyz, 1.0)).xyz;
      vec3 localAxis = vec3(
        dot(modelMatrix[0].xz, peakSectionModulePlane.xy),
        dot(modelMatrix[1].xz, peakSectionModulePlane.xy),
        dot(modelMatrix[2].xz, peakSectionModulePlane.xy));
      float support = dot(centre.xz, peakSectionModulePlane.xy) + peakSectionModulePlane.z
        + dot(abs(localAxis), peakSectionExtent);
      bool protectedContact = false;
      if (peakSectionModuleFooting.w > 0.0) {
        vec3 worldExtent = abs(modelMatrix[0].xyz) * peakSectionExtent.x
          + abs(modelMatrix[1].xyz) * peakSectionExtent.y
          + abs(modelMatrix[2].xyz) * peakSectionExtent.z;
        vec2 gap = max(abs(centre.xz - peakSectionModuleFooting.xz) - worldExtent.xz, vec2(0.0));
        protectedContact = dot(gap, gap) <= peakSectionModuleFooting.w * peakSectionModuleFooting.w
          && centre.y + worldExtent.y >= peakSectionModuleFooting.y - 2.0
          && centre.y - worldExtent.y <= peakSectionModuleFooting.y + 1.25;
      }
      if (support > 0.001 && !protectedContact) vPeakSectionModuleHidden = 1.0;
    }
  #endif
`;

export function applySectionModuleMask(material, plane) {
  if (!material.isMeshStandardMaterial && !material.isMeshBasicMaterial) return;
  const compile = material.onBeforeCompile, key = material.customProgramCacheKey();
  material.defaultAttributeValues = { ...material.defaultAttributeValues,
    peakSectionModule: [0, 0, 0, 0], peakSectionExtent: [0, 0, 0] };
  material.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.peakSectionModulePlane = plane;
    shader.uniforms.peakSectionModuleFooting = plane.footing ?? { value: { x: 0, y: 0, z: 0, w: 0 } };
    shader.vertexShader = vertexDeclarations + shader.vertexShader.replace(
      "#include <begin_vertex>", "#include <begin_vertex>\n" + vertexMask);
    shader.fragmentShader = "varying float vPeakSectionModuleHidden;\n" + shader.fragmentShader.replace(
      "#include <clipping_planes_fragment>",
      "#include <clipping_planes_fragment>\nif (vPeakSectionModuleHidden > 0.5) discard;");
  };
  material.customProgramCacheKey = () => `${key}-section-module-mask-v1`;
}

// Match the shader for the caller's plane, including candidate-camera probes.
// Presentation masks never enter this calculation or change instance matrices.
export function cutsSectionModule(section, mesh, instanceId) {
  const plane = section?.value;
  if (!(plane?.w > 0) || !mesh?.isInstancedMesh || !Number.isInteger(instanceId) || instanceId < 0) return false;
  const centre = mesh.geometry?.getAttribute("peakSectionModule");
  const extent = mesh.geometry?.getAttribute("peakSectionExtent");
  if (!centre || !extent || instanceId >= centre.count || instanceId >= extent.count || !(centre.getW(instanceId) > 0.5)) return false;
  const x = centre.getX(instanceId), y = centre.getY(instanceId), z = centre.getZ(instanceId);
  const ex = extent.getX(instanceId), ey = extent.getY(instanceId), ez = extent.getZ(instanceId);
  if (!(ex >= 0 && ey >= 0 && ez >= 0)) return false;
  const m = mesh.matrixWorld.elements;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const support = cx * plane.x + cz * plane.y + plane.z
    + Math.abs(m[0] * plane.x + m[2] * plane.y) * ex
    + Math.abs(m[4] * plane.x + m[6] * plane.y) * ey
    + Math.abs(m[8] * plane.x + m[10] * plane.y) * ez;
  if (!(support > 0.001)) return false;
  const foot = section.footing?.value;
  if (foot?.w > 0) {
    const wx = Math.abs(m[0]) * ex + Math.abs(m[4]) * ey + Math.abs(m[8]) * ez;
    const wy = Math.abs(m[1]) * ex + Math.abs(m[5]) * ey + Math.abs(m[9]) * ez;
    const wz = Math.abs(m[2]) * ex + Math.abs(m[6]) * ey + Math.abs(m[10]) * ez;
    const dx = Math.max(Math.abs(cx - foot.x) - wx, 0);
    const dz = Math.max(Math.abs(cz - foot.z) - wz, 0);
    if (dx * dx + dz * dz <= foot.w * foot.w && cy + wy >= foot.y - 2 && cy - wy <= foot.y + 1.25) return false;
  }
  return true;
}
