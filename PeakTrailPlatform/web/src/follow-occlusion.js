// View-space cone ending at the followed player's torso. Share one screen-space
// coverage pattern across all intervening surfaces so overlapping leaves or
// rocks do not accumulate into an opaque stack. Solid depth and instancing
// still work normally outside that small area.
const fade = `
  if (peakFollowSubject.w > 0.0 && peakFollowSubject.z < -0.01) {
    vec3 at = -vViewPosition;
    float t = at.z / peakFollowSubject.z;
    if (t > 0.0 && t < 1.0) {
      vec2 delta = at.xy - t * peakFollowSubject.xy;
      float radius = t * peakFollowSubject.w;
      float footprint = 1.0 - smoothstep(radius * 0.55, radius, length(delta));
      float foreground = smoothstep(0.2, 1.25, at.z - peakFollowSubject.z);
      if (footprint * foreground > 0.0) {
        ivec2 cell = ivec2(gl_FragCoord.xy) & 3;
        ivec2 hi = cell >> 1;
        int lowRank = ((cell.x ^ cell.y) & 1) * 2 + (cell.y & 1);
        int highRank = ((hi.x ^ hi.y) & 1) * 2 + (hi.y & 1);
        float threshold = (float(4 * lowRank + highRank) + 0.5) / 16.0;
        if (threshold < 0.84 * footprint * foreground) discard;
      }
    }
  }`;

export function applyFollowOcclusion(material, subject) {
  if (!material.isMeshStandardMaterial || !material.depthWrite || material.userData.peakSourceEffect) return;
  const compile = material.onBeforeCompile, key = material.customProgramCacheKey();
  material.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.peakFollowSubject = subject;
    shader.fragmentShader = "uniform vec4 peakFollowSubject;\n" + shader.fragmentShader
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n" + fade);
  };
  material.customProgramCacheKey = () => key + "-follow-fade-v1";
}
