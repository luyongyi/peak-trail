// Clear a broad cone of foreground terrain with a crisp boundary.
// Keep the player's contact surfaces and backdrop solid; this never changes
// the fixed follow camera's position or uses blended/dithered edge pixels.
const fade = `
  if (peakFollowSubject.w > 0.0 && peakFollowSubject.z < -0.01) {
    vec3 at = -vViewPosition;
    float t = at.z / peakFollowSubject.z;
    if (t > 0.0 && t < 1.0) {
      vec2 delta = at.xy - t * peakFollowSubject.xy;
      float radius = t * peakFollowSubject.w;
      // Match the ray test's contact margin, without a depth or edge gradient.
      if (at.z - peakFollowSubject.z > 0.65 && dot(delta, delta) < radius * radius) discard;
    }
  }`;

export function applyFollowOcclusion(material, subject) {
  if ((!material.isMeshStandardMaterial && !material.isMeshBasicMaterial)
      || !material.depthWrite || material.userData.peakSourceEffect) return;
  const compile = material.onBeforeCompile, key = material.customProgramCacheKey();
  const unlit = material.isMeshBasicMaterial;
  material.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.peakFollowSubject = subject;
    if (unlit) {
      // The MeshBasic shader does not expose the standard material view vector.
      shader.vertexShader = "varying vec3 vPeakFollowView;\n" + shader.vertexShader.replace(
        "#include <project_vertex>", "#include <project_vertex>\nvPeakFollowView = mvPosition.xyz;");
    }
    const fragment = unlit ? fade.replace("-vViewPosition", "vPeakFollowView") : fade;
    shader.fragmentShader = "uniform vec4 peakFollowSubject;\n" + (unlit ? "varying vec3 vPeakFollowView;\n" : "") +
      shader.fragmentShader.replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n" + fragment);
  };
  material.customProgramCacheKey = () => `${key}-follow-fade-v3-hard-${unlit ? "unlit" : "standard"}`;
}
