import * as THREE from "three";

const triple = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

/** Colour-only reduction of the audited GD/Water-GD depth mixing sequence.
 * The shallow input substitutes for refracted opaque-scene colour; noise,
 * foam, crud and Unity lighting remain approximated. This is not native alpha. */
export function sourceWaterColorAtDepth(parameters, gap = null) {
  const ratio = gap === null ? 1 : Math.min(Math.abs(gap) / parameters.depth * 10, 1);
  const weight = ratio * ratio * (3 - 2 * ratio);
  return parameters.primaryLinear.map((value, i) =>
    (parameters.shallowLinear[i] * (1 - weight) + value * weight) * parameters.tintLinear[i]);
}

/** Project the depth gap after reversing the map's optional height exaggeration.
 * At scale 1 this is the native linear-eye-depth difference. Other scales use
 * the equivalent source-space camera direction, rather than scaled metres. */
export function sourceWaterDepthGap(sceneHit, surfaceHit, cameraForward, heightScale = 1) {
  const scale = Number.isFinite(heightScale) && heightScale > 0 ? heightScale : 1;
  const direction = [cameraForward[0], cameraForward[1] / scale, cameraForward[2]];
  const length = Math.hypot(...direction);
  if (!length) return 0;
  const delta = sceneHit.map((value, i) => (value - surfaceHit[i]) / (i === 1 ? scale : 1));
  return Math.abs(delta.reduce((sum, value, i) => sum + value * direction[i] / length, 0));
}

export function applySourceWaterDepth(material, effect) {
  const parameters = effect?.source?.waterDepth;
  if (effect?.kind !== "water" || effect.source?.material !== "M_Water_swamp"
      || effect.source?.shader !== "GD/Water-GD" || !["25306743", "25739797"].includes(String(effect.source?.mapBuildId))
      || !parameters || ![parameters.primaryLinear, parameters.shallowLinear, parameters.tintLinear].every(triple)
      || !Number.isFinite(parameters.depth) || parameters.depth <= 0 || !material?.color) return false;
  if (material.userData.peakWaterDepth) return true;
  const uniforms = {
    hasSceneDepth: { value: false }, sceneDepth: { value: null },
    depthResolution: { value: new THREE.Vector2(1, 1) },
    projectionInverse: { value: new THREE.Matrix4() }, cameraWorld: { value: new THREE.Matrix4() },
    heightScale: { value: 1 }, peakWaterDepthRange: { value: parameters.depth },
    peakWaterPrimary: { value: new THREE.Color().fromArray(parameters.primaryLinear) },
    peakWaterShallow: { value: new THREE.Color().fromArray(parameters.shallowLinear) },
    peakWaterTint: { value: new THREE.Color().fromArray(parameters.tintLinear) },
  };
  material.color.fromArray(sourceWaterColorAtDepth(parameters));
  material.opacity = 1;
  material.transparent = true;
  material.depthWrite = false;
  material.userData.peakWaterDepth = { uniforms, parameters };
  // FogDepthPass can bind these before WebGL compiles the first shader.
  material.uniforms = uniforms;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = `uniform bool hasSceneDepth;
      uniform sampler2D sceneDepth; uniform vec2 depthResolution;
      uniform mat4 projectionInverse, cameraWorld;
      uniform float heightScale, peakWaterDepthRange;
      uniform vec3 peakWaterPrimary, peakWaterShallow, peakWaterTint;
      ${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
      float peakWaterWeight = 1.0;
      if (hasSceneDepth) {
        vec2 peakWaterUv = gl_FragCoord.xy / depthResolution;
        float peakWaterSceneDepth = texture2D(sceneDepth, peakWaterUv).x;
        if (peakWaterSceneDepth < 0.9999999) {
          vec4 peakWaterViewHit = projectionInverse * vec4(peakWaterUv * 2.0 - 1.0, peakWaterSceneDepth * 2.0 - 1.0, 1.0);
          vec3 peakWaterWorldHit = (cameraWorld * vec4(peakWaterViewHit.xyz / peakWaterViewHit.w, 1.0)).xyz;
          vec3 peakWaterSurface = (cameraWorld * vec4(-vViewPosition, 1.0)).xyz;
          vec3 peakWaterDelta = peakWaterWorldHit - peakWaterSurface;
          vec3 peakWaterForward = (cameraWorld * vec4(0.0, 0.0, -1.0, 0.0)).xyz;
          float peakWaterHeightScale = max(heightScale, 0.000001);
          peakWaterDelta.y /= peakWaterHeightScale;
          peakWaterForward.y /= peakWaterHeightScale;
          float peakWaterGap = abs(dot(peakWaterDelta, normalize(peakWaterForward)));
          peakWaterWeight = smoothstep(0.0, 1.0, min(10.0 * peakWaterGap / peakWaterDepthRange, 1.0));
        }
      }
      diffuseColor.rgb = mix(peakWaterShallow, peakWaterPrimary, peakWaterWeight) * peakWaterTint;`);
  };
  const cacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${cacheKey()}:source-swamp-depth-v1`;
  material.needsUpdate = true;
  return true;
}
