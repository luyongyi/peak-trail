import * as THREE from 'three';

// Bounded analytic replay volume, NOT the original Unity particle/shader effect.
// Recorded lit protection spheres carve holes in the recorded status-field box.
export function createReplayFogMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
    uniforms: {
      inverseWorld: { value: new THREE.Matrix4() }, worldOrigin: { value: new THREE.Vector3() }, heightScale: { value: 1 },
      fogColor: { value: new THREE.Color('#b698d9') }, sphere: { value: false }, replayTime: { value: 0 },
      safeCount: { value: 0 }, safeZones: { value: Array.from({ length: 32 }, () => new THREE.Vector4()) },
      hasSceneDepth: { value: false }, sceneDepth: { value: null }, depthResolution: { value: new THREE.Vector2(1, 1) },
      projectionInverse: { value: new THREE.Matrix4() }, cameraWorld: { value: new THREE.Matrix4() },
    },
    vertexShader: `varying vec3 worldPoint;
      void main(){ vec4 p=modelMatrix*vec4(position,1.0); worldPoint=p.xyz; gl_Position=projectionMatrix*viewMatrix*p; }`,
    fragmentShader: `varying vec3 worldPoint;
      uniform mat4 inverseWorld; uniform vec3 worldOrigin, fogColor;
      uniform float heightScale, replayTime; uniform bool sphere;
      uniform int safeCount; uniform vec4 safeZones[32];
      uniform bool hasSceneDepth; uniform sampler2D sceneDepth; uniform vec2 depthResolution;
      uniform mat4 projectionInverse, cameraWorld;
      void main(){
        vec3 worldDirection=normalize(worldPoint-cameraPosition);
        vec3 ro=(inverseWorld*vec4(cameraPosition,1.0)).xyz;
        bool inside=all(lessThan(abs(ro),vec3(1.0)));
        if((inside && gl_FrontFacing) || (!inside && !gl_FrontFacing)) discard;
        vec3 rd=(inverseWorld*vec4(worldDirection,0.0)).xyz;
        vec3 inv=1.0/(rd+vec3(0.000001));
        vec3 lo=(-vec3(1.0)-ro)*inv, hi=(vec3(1.0)-ro)*inv;
        vec3 nearV=min(lo,hi), farV=max(lo,hi);
        float start=max(0.0,max(nearV.x,max(nearV.y,nearV.z)));
        float end=min(farV.x,min(farV.y,farV.z));
        // Integrate only the air BEFORE the first opaque surface. Without this
        // bound a nearby fence gets the same blue wash as a distant mountain.
        if(hasSceneDepth){
          vec2 uv=gl_FragCoord.xy/depthResolution;
          float depth=texture2D(sceneDepth,uv).x;
          if(depth<0.9999999){
            vec4 viewHit=projectionInverse*vec4(uv*2.0-1.0,depth*2.0-1.0,1.0);
            vec3 worldHit=(cameraWorld*vec4(viewHit.xyz/viewHit.w,1.0)).xyz;
            end=min(end,length(worldHit-cameraPosition));
          }
        }
        if(end<=start) discard;
        float stepSize=(end-start)/32.0, opacity=0.0;
        for(int i=0;i<32;i++){
          float t=start+(float(i)+0.5)*stepSize;
          vec3 local=ro+rd*t;
          if(sphere && dot(local,local)>1.0) continue;
          vec3 wp=cameraPosition+worldDirection*t;
          vec3 unity=vec3(wp.x,wp.y/heightScale,wp.z)+worldOrigin;
          bool safe=false;
          for(int j=0;j<32;j++){ if(j>=safeCount) break; if(distance(unity,safeZones[j].xyz)<safeZones[j].w) safe=true; }
          if(safe) continue;
          float edge=sphere ? 1.0-length(local) : 1.0-max(abs(local.x),max(abs(local.y),abs(local.z)));
          float noise=0.7+0.18*sin(dot(unity,vec3(0.17,0.11,0.13))+replayTime*0.22)
            +0.12*sin(unity.x*0.34+sin(unity.z*0.26)+unity.y*0.23-replayTime*0.17);
          float density=smoothstep(0.0,0.12,edge)*noise;
          opacity+=(1.0-opacity)*(1.0-exp(-density*stepSize*0.055));
        }
        gl_FragColor=vec4(fogColor,min(opacity,0.58));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
