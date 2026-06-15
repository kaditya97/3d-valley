import * as THREE from 'three';

// v2 atmosphere: replaces three's linear fog with aerial perspective.
//
// The stock fog chunks are patched globally so every fogged material in the
// scene — terrain, trees, roads, buildings, wildlife — shares one model:
//   · exponential distance haze (aerial perspective; cliffs recede in layers)
//   · a grounded valley-fog slab, integrated analytically along the view ray,
//     so dawn mist pools on the valley floor and thins with altitude
//   · sun-direction inscatter, so haze glows warm around the sun at golden
//     hour instead of being a flat grey veil
//
// All parameters live in shared uniform objects (ATMO.uniforms): the lighting
// presets and the weather system write them once per frame and every patched
// material picks them up. fogColor stays renderer-managed via scene.fog.

export const ATMO = {
  uniforms: {
    uAtmoSunDir: { value: new THREE.Vector3(0, 1, 0) },   // glow + relight direction
    uAtmoGlowColor: { value: new THREE.Color(0xffd9b0) },
    uAtmoGlow: { value: 0.15 },        // inscatter strength 0..1
    uAtmoHaze: { value: 0.000038 },    // extinction per meter
    uAtmoValleyFog: { value: 0.0 },    // slab density per meter at the reference top
    uAtmoFogTop: { value: 1280.0 },    // ASL height where valley fog thins out
    uAtmoRelight: { value: 0.1 },      // slope-based terrain relighting strength
    uAtmoSnow: { value: 0.0 },         // snow accumulation 0..1 (weather)
    uAtmoWet: { value: 0.0 },          // rain-soaked darkening 0..1 (weather)
    uAtmoFogColor: { value: new THREE.Color(0xcfdcec) },  // alias of scene.fog.color
  },
};

// Shared fog math, used by the patched chunks and (manually) by the custom
// waterfall/cloud shaders. Expects uniforms declared by ATMO_FOG_PARS.
export const ATMO_FOG_PARS = /* glsl */ `
  uniform vec3 uAtmoSunDir;
  uniform vec3 uAtmoGlowColor;
  uniform float uAtmoGlow;
  uniform float uAtmoHaze;
  uniform float uAtmoValleyFog;
  uniform float uAtmoFogTop;
  vec3 atmoApply(vec3 color, vec3 fogCol, vec3 worldPos, vec3 camPos) {
    vec3 v = worldPos - camPos;
    float dist = length(v);
    vec3 dir = v / max(dist, 1.0);
    // aerial perspective
    float f = 1.0 - exp(-dist * uAtmoHaze);
    // grounded valley fog: exponential slab below uAtmoFogTop
    if (uAtmoValleyFog > 1e-7) {
      float k = 0.016;
      float dy = abs(dir.y) < 0.01 ? (dir.y < 0.0 ? -0.01 : 0.01) : dir.y;
      float od = uAtmoValleyFog * exp(-(camPos.y - uAtmoFogTop) * k)
               * (1.0 - exp(-dist * dy * k)) / (dy * k);
      f = 1.0 - (1.0 - f) * exp(-clamp(od, 0.0, 6.0));
    }
    // warm inscatter toward the sun
    float sunAmt = pow(clamp(dot(dir, uAtmoSunDir), 0.0, 1.0), 10.0);
    vec3 haze = fogCol + uAtmoGlowColor * (sunAmt * uAtmoGlow);
    return mix(color, haze, clamp(f, 0.0, 1.0));
  }
`;

let installed = false;
export function installAtmosphere() {
  if (installed) return;
  installed = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying vec3 vAtmoPos;
    #endif
  `;
  // 'transformed' exists in every Mesh vertex shader (begin_vertex). Sprite
  // and Points materials don't have it — they opt out with material.fog=false.
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      #ifdef USE_INSTANCING
        vAtmoPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vAtmoPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif
    #endif
  `;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying vec3 vAtmoPos;
      ${ATMO_FOG_PARS}
    #endif
  `;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      gl_FragColor.rgb = atmoApply(gl_FragColor.rgb, fogColor, vAtmoPos, cameraPosition);
    #endif
  `;
}

// Attach the shared atmosphere uniforms to a material (preserving any
// existing onBeforeCompile hook). Required for every fogged material, since
// the renderer only auto-updates the stock fog uniforms.
export function attachAtmo(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, ATMO.uniforms);
  };
  return material;
}
