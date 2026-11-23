// Fade a small cone of terrain between the eye and the followed player.
// Every overlapping surface uses the same screen-space coverage pattern.
// Retained pixels still write solid depth, including the player's backdrop.
const fade = `
  if (peakFollowSubject.w > 0.0 && peakFollowSubject.z < -0.01) {
    vec3 at = -vViewPosition;
    float t = at.z / peakFollowSubject.z;
    if (t > 0.0 && t < 1.0) {
      vec2 delta = at.xy - t * peakFollowSubject.xy;
      float radius = t * peakFollowSubject.w;
      float footprint = 1.0 - smoothstep(radius * 0.32, radius, length(delta));
      // Preserve contact surfaces immediately around the player.
      float foreground = smoothstep(0.12, 0.65, at.z - peakFollowSubject.z);
      if (footprint * foreground > 0.0) {
        ivec2 cell = ivec2(gl_FragCoord.xy) & 3;
        ivec2 hi = cell >> 1;
        int lowRank = ((cell.x ^ cell.y) & 1) * 2 + (cell.y & 1);
        int highRank = ((hi.x ^ hi.y) & 1) * 2 + (hi.y & 1);
        float threshold = (float(4 * lowRank + highRank) + 0.5) / 16.0;
        if (threshold < footprint * foreground) discard;
      }
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
  material.customProgramCacheKey = () => `${key}-follow-fade-v2-${unlit ? "unlit" : "standard"}`;
}
