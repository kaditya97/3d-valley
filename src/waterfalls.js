import * as THREE from 'three';
import { ATMO, ATMO_FOG_PARS } from './atmosphere.js';

// The valley's famous falls, each an animated water ribbon draped down the
// real DEM cliff face: brink and base are true positions (verified against
// the elevation data — DEM drops match published fall heights), and every
// ribbon segment is pushed just outside the terrain surface so the water
// visibly sheets down the wall instead of hiding inside the smoothed mesh.
const FALLS = [
  { name: 'Upper Yosemite Fall', top: [-119.59693, 37.75686], bottom: [-119.59693, 37.75620], width: 30 },
  { name: 'Lower Yosemite Fall', top: [-119.59600, 37.75117], bottom: [-119.59600, 37.75067], width: 18 },
  { name: 'Bridalveil Fall',     top: [-119.64667, 37.71646], bottom: [-119.64683, 37.71713], width: 20 },
  { name: 'Vernal Fall',         top: [-119.54335, 37.72723], bottom: [-119.54430, 37.72760], width: 28 },
  { name: 'Nevada Fall',         top: [-119.53365, 37.72416], bottom: [-119.53554, 37.72565], width: 22 },
  { name: 'Ribbon Fall',         top: [-119.65229, 37.73411], bottom: [-119.65245, 37.73000], width: 12 },
];

export class Waterfalls {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.time = { value: 0 };
    this.tint = { value: new THREE.Color(1, 1, 1) };
    this.falls = [];
    this.mistTexture = makeMistTexture();

    for (const def of FALLS) {
      const fall = this.buildFall(def);
      this.falls.push(fall);
      this.group.add(fall.mesh, fall.mist);
    }
  }

  buildFall(def) {
    const t = this.terrain;
    const top = t.lonLatToWorld(def.top[0], def.top[1]);
    top.y = t.heightAt(top.x, top.z);
    const bottom = t.lonLatToWorld(def.bottom[0], def.bottom[1]);
    bottom.y = t.heightAt(bottom.x, bottom.z);
    const drop = top.y - bottom.y;

    // horizontal flow direction; if brink and base are nearly stacked,
    // fall back to the downhill gradient at the brink
    const out = new THREE.Vector3(bottom.x - top.x, 0, bottom.z - top.z);
    if (out.length() < 8) {
      const e = 10;
      out.set(
        t.heightAt(top.x - e, top.z) - t.heightAt(top.x + e, top.z), 0,
        t.heightAt(top.x, top.z - e) - t.heightAt(top.x, top.z + e)
      );
    }
    out.normalize();
    const side = new THREE.Vector3(-out.z, 0, out.x);

    // drape: at each height, march outward from the brink until the ribbon
    // clears the terrain surface, so the sheet hugs the front of the cliff
    const segs = 48;
    const maxReach = Math.hypot(bottom.x - top.x, bottom.z - top.z) + 90;
    const sArr = [];
    let sPrev = 0;
    for (let i = 0; i <= segs; i++) {
      const f = i / segs;
      const cy = top.y - drop * f;
      let s = Math.max(0, sPrev - 14);
      while (s < maxReach && t.heightAt(top.x + out.x * s, top.z + out.z * s) > cy - 1.5) s += 2;
      sPrev = s;
      sArr.push(s + 2.5 + 3.5 * Math.sin(f * Math.PI));
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < segs; i++) sArr[i] = (sArr[i - 1] + sArr[i] * 2 + sArr[i + 1]) / 4;
    }

    const positions = new Float32Array((segs + 1) * 2 * 3);
    const uvs = new Float32Array((segs + 1) * 2 * 2);
    let p = 0, u = 0;
    for (let i = 0; i <= segs; i++) {
      const f = i / segs;
      const cy = top.y - drop * f;
      const cx = top.x + out.x * sArr[i];
      const cz = top.z + out.z * sArr[i];
      const half = (def.width / 2) * (0.7 + 0.5 * f); // spray widens downward
      positions[p++] = cx - side.x * half; positions[p++] = cy; positions[p++] = cz - side.z * half;
      positions[p++] = cx + side.x * half; positions[p++] = cy; positions[p++] = cz + side.z * half;
      uvs[u++] = 0; uvs[u++] = f;
      uvs[u++] = 1; uvs[u++] = f;
    }
    const index = [];
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.time,
        uTint: this.tint,
        uDrop: { value: drop },
        ...ATMO.uniforms,
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uTint;
        uniform float uDrop;
        uniform vec3 uAtmoFogColor;
        varying vec2 vUv;
        varying vec3 vWorld;
        ${ATMO_FOG_PARS}

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                     mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }

        void main() {
          // downward flow: constant phase speed; pow() spacing makes streaks
          // stretch/accelerate toward the base (never reverses)
          float flow = pow(vUv.y, 0.72) * uDrop * 0.055 - uTime * 1.4;
          vec2 p = vec2(vUv.x * 6.0, flow);
          float streak = noise(p) * 0.6 + noise(p * vec2(2.6, 1.6) + 7.3) * 0.4;
          streak = smoothstep(0.26, 0.72, streak);

          // soft side edges; sheet stays solid down the middle
          float edge = sin(vUv.x * 3.14159);
          float across = pow(edge, mix(0.9, 0.4, vUv.y));

          float lip = smoothstep(0.10, 0.0, vUv.y);          // bright brink
          float splash = smoothstep(0.72, 1.0, vUv.y);       // churn at the base
          float body = 0.45 + 0.75 * streak;                 // never fully sheer
          float alpha = across * clamp(body + lip * 0.5 + splash * 0.5 * noise(p * 1.9), 0.0, 1.0);

          vec3 water = mix(vec3(0.78, 0.86, 0.93), vec3(1.04), streak * 0.65 + lip * 0.3 + splash * 0.35);
          vec3 col = atmoApply(water * uTint, uAtmoFogColor, vWorld, cameraPosition);
          gl_FragColor = vec4(col, alpha * 0.96);
        }
      `,
    });
    mat.toneMapped = false;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;

    // mist at the plunge pool
    const mist = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.mistTexture,
        transparent: true,
        depthWrite: false,
        opacity: 0.55,
        color: 0xf2f7fa,
        fog: false, // sprite shaders lack the hook the patched fog needs; tinted per preset instead
      })
    );
    mist.material.toneMapped = false;
    const mistSize = Math.min(110, 30 + drop * 0.22);
    mist.scale.set(mistSize * 1.7, mistSize, 1);
    const mx = top.x + out.x * sArr[segs];
    const mz = top.z + out.z * sArr[segs];
    mist.position.set(mx, bottom.y + mistSize * 0.22, mz);
    mist.renderOrder = 3;

    return { def, mesh, mist, top, bottom, drop, baseMistScale: mistSize };
  }

  update(dt) {
    this.time.value += dt;
    // gentle mist breathing
    for (let i = 0; i < this.falls.length; i++) {
      const f = this.falls[i];
      const s = f.baseMistScale * (1 + 0.07 * Math.sin(this.time.value * 0.7 + i * 1.7));
      f.mist.scale.set(s * 1.7, s, 1);
    }
  }

  setTint(color) {
    this.tint.value.copy(color);
    for (const f of this.falls) f.mist.material.color.copy(color).lerp(new THREE.Color(1, 1, 1), 0.5);
  }

  // distance from a point to the nearest fall, for ambient audio
  nearest(pos) {
    let best = null;
    for (const f of this.falls) {
      const mid = (f.top.y + f.bottom.y) / 2;
      const d = Math.hypot(pos.x - f.bottom.x, pos.y - mid, pos.z - f.bottom.z);
      if (!best || d < best.d) best = { d, fall: f };
    }
    return best;
  }
}

function makeMistTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.36)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
