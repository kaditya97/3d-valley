import * as THREE from 'three';
import { ATMO } from './atmosphere.js';

// Time-of-day lighting presets. The terrain/trees are unlit (sun shading is
// baked into the satellite imagery), so a preset is: sky shader state,
// atmosphere (haze density, grounded valley fog, sun-inscatter glow), a subtle
// slope-relighting strength, tone-mapping exposure, a multiplicative tint on
// every material, and stars. Weather (see weather.js) grades the result —
// greying the tint, thickening the haze, dimming the glow — before it lands
// in the shared uniforms. Transitions lerp smoothly over a couple of seconds.
//
//   haze      extinction per meter (aerial perspective strength)
//   valleyFog grounded fog slab strength 0..1 (dawn mist pooled on the floor)
//   fogTop    ASL height where the valley fog thins out
//   glow      sun-direction inscatter strength; glowColor its tint
//   relight   slope-based terrain relighting (subtle; 0 would be flat imagery)
//   lightElev/lightAzim  relight direction override (night uses the moon)

const PRESETS = [
  {
    key: 'dawn', label: 'Dawn',
    sunElev: 6, sunAzim: 95, turbidity: 7, rayleigh: 2.6, mieC: 0.006, mieG: 0.86,
    exposure: 0.46, fog: 0xe3c4a8, tint: 0xffdfc4, fallTint: 0xffe8d6, stars: 0.25,
    haze: 5.0e-5, valleyFog: 0.85, fogTop: 1330, glow: 0.5, glowColor: 0xffb678, relight: 0.42,
  },
  {
    key: 'day', label: 'Midday',
    sunElev: 38, sunAzim: 155, turbidity: 6, rayleigh: 1.8, mieC: 0.004, mieG: 0.85,
    exposure: 0.62, fog: 0xcfdcec, tint: 0xffffff, fallTint: 0xffffff, stars: 0,
    haze: 3.3e-5, valleyFog: 0, fogTop: 1240, glow: 0.1, glowColor: 0xfff0d8, relight: 0.12,
  },
  {
    key: 'golden', label: 'Golden hour',
    sunElev: 11, sunAzim: 262, turbidity: 4.5, rayleigh: 3.2, mieC: 0.006, mieG: 0.88,
    exposure: 0.55, fog: 0xeccfa6, tint: 0xffd9ae, fallTint: 0xffe9c8, stars: 0,
    haze: 4.4e-5, valleyFog: 0.08, fogTop: 1255, glow: 0.7, glowColor: 0xffa057, relight: 0.5,
  },
  {
    key: 'dusk', label: 'Dusk',
    sunElev: 1.5, sunAzim: 285, turbidity: 5, rayleigh: 3.8, mieC: 0.009, mieG: 0.9,
    exposure: 0.38, fog: 0x9088a8, tint: 0xa2a8c6, fallTint: 0xc2c8e0, stars: 0.55,
    haze: 4.2e-5, valleyFog: 0.2, fogTop: 1280, glow: 0.3, glowColor: 0xde8660, relight: 0.24,
  },
  {
    key: 'night', label: 'Night',
    sunElev: -10, sunAzim: 0, turbidity: 2, rayleigh: 0.6, mieC: 0.002, mieG: 0.8,
    exposure: 0.29, fog: 0x0e131f, tint: 0x55628a, fallTint: 0x8a96b4, stars: 1,
    haze: 2.4e-5, valleyFog: 0.12, fogTop: 1275, glow: 0.05, glowColor: 0x9db4dd, relight: 0.3,
    lightElev: 38, lightAzim: 215, // moonlight
  },
];

const VALLEY_FOG_DENSITY = 3.2e-4; // per meter at full strength

// What the weather contributes when there is no weather system / clear skies.
const NEUTRAL_MOD = {
  cover: 0.12, dark: 0.06, hazeMul: 1, vfAdd: 0, exposureMul: 1, grey: 0,
  glowMul: 1, starsMul: 1, snow: 0, snowFall: 0, wet: 0, rain: 0, windAud: 1,
};

export class Lighting {
  constructor({ renderer, scene, sky, terrain, forest, falls }) {
    this.renderer = renderer;
    this.scene = scene;
    this.sky = sky;
    this.terrain = terrain;
    this.forest = forest;
    this.falls = falls;
    this.weather = null; // wired up in main.js after Weather is created
    this.village = null;
    this.index = 1; // midday
    this.night = 0; // 0 day .. 1 deep night (drives windows, headlights, crickets)
    this.stars = makeStars();
    scene.add(this.stars);

    this._effFog = new THREE.Color();
    this._effTint = new THREE.Color();
    this._effFall = new THREE.Color();
    this._grey = new THREE.Color();

    this.state = this.paramsFor(PRESETS[this.index]);
    this.from = null;
    this.to = null;
    this.t = 1;
    this.applyState();
  }

  get current() { return PRESETS[this.index].key; }
  get label() { return PRESETS[this.index].label; }
  get count() { return PRESETS.length; }

  paramsFor(p) {
    const dir = (elev, azim) =>
      new THREE.Vector3().setFromSphericalCoords(
        1,
        THREE.MathUtils.degToRad(90 - elev),
        THREE.MathUtils.degToRad(azim)
      );
    return {
      sun: dir(p.sunElev, p.sunAzim),
      light: dir(p.lightElev ?? Math.max(p.sunElev, 4), p.lightAzim ?? p.sunAzim),
      turbidity: p.turbidity, rayleigh: p.rayleigh, mieC: p.mieC, mieG: p.mieG,
      exposure: p.exposure,
      fog: new THREE.Color(p.fog),
      tint: new THREE.Color(p.tint), fallTint: new THREE.Color(p.fallTint),
      stars: p.stars,
      haze: p.haze, valleyFog: p.valleyFog, fogTop: p.fogTop,
      glow: p.glow, glowColor: new THREE.Color(p.glowColor),
      relight: p.relight,
    };
  }

  set(index) {
    this.index = ((index % PRESETS.length) + PRESETS.length) % PRESETS.length;
    this.from = this.state;
    this.to = this.paramsFor(PRESETS[this.index]);
    this.t = 0;
    return PRESETS[this.index].label;
  }

  cycle() { return this.set(this.index + 1); }

  update(dt) {
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / 2.2);
      const f = this.t * this.t * (3 - 2 * this.t); // smoothstep
      const a = this.from, b = this.to, s = this.state;
      s.sun.lerpVectors(a.sun, b.sun, f).normalize();
      s.light.lerpVectors(a.light, b.light, f).normalize();
      for (const k of ['turbidity', 'rayleigh', 'mieC', 'mieG', 'exposure', 'stars',
                       'haze', 'valleyFog', 'fogTop', 'glow', 'relight']) {
        s[k] = a[k] + (b[k] - a[k]) * f;
      }
      s.fog.lerpColors(a.fog, b.fog, f);
      s.tint.lerpColors(a.tint, b.tint, f);
      s.fallTint.lerpColors(a.fallTint, b.fallTint, f);
      s.glowColor.lerpColors(a.glowColor, b.glowColor, f);
    }
    // applied every frame: weather grades the preset continuously
    this.applyState();
  }

  applyState() {
    const s = this.state;
    const m = this.weather?.mod ?? NEUTRAL_MOD;
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(s.sun);
    u.turbidity.value = s.turbidity;
    u.rayleigh.value = s.rayleigh;
    u.mieCoefficient.value = s.mieC;
    u.mieDirectionalG.value = s.mieG;
    this.renderer.toneMappingExposure = s.exposure * m.exposureMul;

    // weather greys out the palette: fog + tints slide toward their own luma
    const luma = (c) => c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
    this._effFog.copy(s.fog).lerp(this._grey.setScalar(luma(s.fog) * 0.97), m.grey);
    this._effTint.copy(s.tint).lerp(this._grey.setScalar(luma(s.tint)), m.grey * 0.55);
    this._effFall.copy(s.fallTint).lerp(this._grey.setScalar(luma(s.fallTint)), m.grey * 0.4);

    this.scene.fog.color.copy(this._effFog);
    this.terrain.setTint(this._effTint);
    this.forest?.setTint(this._effTint);
    this.falls?.setTint(this._effFall);
    this.village?.setTint(this._effTint);

    const A = ATMO.uniforms;
    A.uAtmoSunDir.value.copy(s.light);
    A.uAtmoGlowColor.value.copy(s.glowColor);
    A.uAtmoGlow.value = s.glow * m.glowMul;
    A.uAtmoHaze.value = s.haze * m.hazeMul;
    A.uAtmoValleyFog.value = s.valleyFog * VALLEY_FOG_DENSITY + m.vfAdd;
    A.uAtmoFogTop.value = s.fogTop;
    A.uAtmoRelight.value = s.relight * (1 - 0.55 * m.grey); // flat light under clouds
    A.uAtmoSnow.value = m.snow;
    A.uAtmoWet.value = m.wet;
    A.uAtmoFogColor.value.copy(this._effFog);

    this.stars.material.opacity = s.stars * m.starsMul;
    this.stars.visible = this.stars.material.opacity > 0.01;
    this.night = s.stars;

    this.weather?.applyLight(this._effFog, this._effTint);
  }
}

// Star dome with a faint Milky Way band, drawn additively beyond the fog.
function makeStars() {
  const R = 160000;
  const N = 3200;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  let i3 = 0;
  for (let i = 0; i < N; i++) {
    let dir;
    if (i < N * 0.45) {
      // band: scattered around a tilted great circle
      const a = Math.random() * Math.PI * 2;
      const spread = (Math.random() - 0.5) * 0.5 * (Math.random() < 0.7 ? 1 : 2.5);
      dir = new THREE.Vector3(Math.cos(a), spread, Math.sin(a)).normalize();
      dir.applyAxisAngle(new THREE.Vector3(1, 0, 0), 1.0);
    } else {
      dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random(), Math.random() * 2 - 1).normalize();
    }
    if (dir.y < 0.02) dir.y = 0.02 + Math.random() * 0.1;
    dir.normalize();
    positions[i3] = dir.x * R;
    positions[i3 + 1] = dir.y * R;
    positions[i3 + 2] = dir.z * R;
    const m = 0.4 + Math.random() ** 3 * 0.6;
    const warm = Math.random();
    colors[i3] = m * (warm > 0.8 ? 1 : 0.85 + warm * 0.15);
    colors[i3 + 1] = m * 0.92;
    colors[i3 + 2] = m * (warm < 0.2 ? 1 : 0.9);
    i3 += 3;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 2.2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
  mat.toneMapped = false;
  const stars = new THREE.Points(geo, mat);
  stars.visible = false;
  stars.frustumCulled = false;
  return stars;
}
