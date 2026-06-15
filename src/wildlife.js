import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attachAtmo } from './atmosphere.js';

// Ambient wildlife, kept deliberately sparse:
//   · ravens soaring on the updrafts where they actually ride them — the
//     El Capitan face, the Yosemite Falls amphitheater, Glacier Point — slow
//     circles with banking, occasional wing-flap bursts in the vertex shader
//   · small mule-deer herds grazing the real valley meadows (El Capitan,
//     Cook's, Ahwahnee), placed only where the forest mask says it's open
//     ground; simple graze → look up → amble behavior
// Both are single-digit draw calls: one InstancedMesh for all birds, one for
// deer bodies, one for deer heads (separate so heads can dip to graze).

const SOAR_SPOTS = [
  { lon: -119.6345, lat: 37.7295, agl: 420, n: 7 },  // El Capitan face
  { lon: -119.5962, lat: 37.7515, agl: 520, n: 6 },  // Yosemite Falls amphitheater
  { lon: -119.5730, lat: 37.7300, agl: 480, n: 5 },  // Glacier Point rim
];

const MEADOWS = [
  { lon: -119.6318, lat: 37.7232, n: 6 },  // El Capitan Meadow
  { lon: -119.5972, lat: 37.7452, n: 5 },  // Cook's Meadow
  { lon: -119.5795, lat: 37.7468, n: 4 },  // Ahwahnee Meadow
];

export class Wildlife {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.time = { value: 0 };
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();

    this.birds = this.makeBirds();
    scene.add(this.birds.mesh);
    this.deer = this.makeDeer();
    scene.add(this.deer.bodies, this.deer.heads);
  }

  // ------------------------------------------------------------ birds

  makeBirds() {
    const flock = [];
    for (const spot of SOAR_SPOTS) {
      const c = this.terrain.lonLatToWorld(spot.lon, spot.lat);
      const baseY = this.terrain.heightAt(c.x, c.z) + spot.agl;
      for (let i = 0; i < spot.n; i++) {
        flock.push({
          cx: c.x, cz: c.z, baseY,
          r: 50 + Math.random() * 110,
          ang: Math.random() * Math.PI * 2,
          angSpeed: (0.07 + Math.random() * 0.08) * (Math.random() < 0.5 ? 1 : -1),
          ph: Math.random() * Math.PI * 2,
        });
      }
    }

    const geo = makeBirdGeometry();
    const mat = new THREE.MeshBasicMaterial({ color: 0x14110d, side: THREE.DoubleSide });
    mat.toneMapped = false;
    const time = this.time;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            // soaring: long glides, occasional flap bursts
            float bPh = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.53;
            float gate = smoothstep(0.55, 0.9, sin(uTime * 0.31 + bPh * 5.0));
            transformed.y += sin(uTime * 17.0 + bPh) * abs(transformed.x) * 0.55 * gate
                           + abs(transformed.x) * 0.18; // slight resting dihedral
          #endif`
        );
    };
    attachAtmo(mat);

    const mesh = new THREE.InstancedMesh(geo, mat, flock.length);
    mesh.frustumCulled = false;
    return { flock, mesh };
  }

  // ------------------------------------------------------------ deer

  makeDeer() {
    const herd = [];
    for (const m of MEADOWS) {
      const c = this.terrain.lonLatToWorld(m.lon, m.lat);
      let placed = 0;
      for (let tries = 0; tries < 60 && placed < m.n; tries++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 55;
        const x = c.x + Math.cos(a) * r;
        const z = c.z + Math.sin(a) * r;
        if (this.terrain.forestAt(x, z) > 0.25) continue; // open meadow only
        herd.push({
          cx: c.x, cz: c.z, x, z,
          yaw: Math.random() * Math.PI * 2,
          state: 'graze',
          timer: 2 + Math.random() * 8,
          headPitch: 1.9,
          targetPitch: 1.9,
          scale: 0.85 + Math.random() * 0.25,
        });
        placed++;
      }
    }

    const { body, head } = makeDeerGeometry();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    mat.toneMapped = false;
    attachAtmo(mat);
    const bodies = new THREE.InstancedMesh(body, mat, herd.length);
    const heads = new THREE.InstancedMesh(head, mat, herd.length);
    bodies.frustumCulled = heads.frustumCulled = false;
    return { herd, bodies, heads };
  }

  // ------------------------------------------------------------ update

  update(dt, camera, night, storm) {
    this.time.value += dt;
    const t = this.time.value;

    // birds roost at dusk/night and sit out storms
    const birdsOut = night < 0.4 && !storm;
    this.birds.mesh.visible = birdsOut;
    if (birdsOut) {
      const m4 = this._m4, q = this._q, e = this._e, v = this._v;
      this.birds.flock.forEach((b, i) => {
        b.ang += b.angSpeed * dt;
        const wob = Math.sin(t * 0.05 + b.ph);
        const x = b.cx + Math.sin(t * 0.013 + b.ph) * 150 + Math.cos(b.ang) * b.r;
        const z = b.cz + Math.cos(t * 0.011 + b.ph * 1.3) * 150 + Math.sin(b.ang) * b.r;
        const y = b.baseY + wob * 45 + Math.sin(t * 0.21 + b.ph * 2.0) * 6;
        // heading = circle tangent (velocity dir); bank into the turn
        const s = Math.sign(b.angSpeed);
        const heading = Math.atan2(Math.sin(b.ang) * s, -Math.cos(b.ang) * s);
        e.set(0, heading, 0.38 * Math.sign(b.angSpeed), 'YXZ');
        q.setFromEuler(e);
        m4.compose(v.set(x, y, z), q, ONE);
        this.birds.mesh.setMatrixAt(i, m4);
      });
      this.birds.mesh.instanceMatrix.needsUpdate = true;
    }

    // deer graze around the clock (crepuscular, even) but vanish in deep night
    const deerOut = night < 0.85;
    this.deer.bodies.visible = this.deer.heads.visible = deerOut;
    if (deerOut && this.deer.herd.length) {
      const m4 = this._m4, q = this._q, e = this._e, v = this._v;
      this.deer.herd.forEach((d, i) => {
        d.timer -= dt;
        if (d.timer <= 0) {
          const r = Math.random();
          if (d.state !== 'walk' && r < 0.4) {
            d.state = 'walk';
            d.timer = 3 + Math.random() * 5;
            d.targetPitch = 0.3;
            // wander, steering back toward the meadow center
            const home = Math.atan2(d.cz - d.z, d.cx - d.x);
            const dist = Math.hypot(d.cx - d.x, d.cz - d.z);
            d.targetYaw = dist > 50 ? home : Math.random() * Math.PI * 2;
          } else if (r < 0.7) {
            d.state = 'graze';
            d.timer = 5 + Math.random() * 9;
            d.targetPitch = 1.9;
          } else {
            d.state = 'alert';
            d.timer = 2 + Math.random() * 3;
            d.targetPitch = -0.05;
          }
        }
        if (d.state === 'walk') {
          let dy = (d.targetYaw ?? d.yaw) - d.yaw;
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          d.yaw += dy * Math.min(1, dt * 1.5);
          d.x += Math.cos(d.yaw) * 0.7 * dt;
          d.z += Math.sin(d.yaw) * 0.7 * dt;
        }
        d.headPitch += (d.targetPitch - d.headPitch) * Math.min(1, dt * 3);

        const y = this.terrain.heightAt(d.x, d.z);
        const bob = d.state === 'walk' ? Math.sin(t * 5 + i) * 0.02 : 0;
        // geometry faces +X; rotate -yaw because three's Y rotation is CCW from +X to -Z
        e.set(0, -d.yaw, 0, 'YXZ');
        q.setFromEuler(e);
        m4.compose(v.set(d.x, y + bob, d.z), q, this._v2.setScalar(d.scale));
        this.deer.bodies.setMatrixAt(i, m4);
        // head pivots at the neck joint (front of body)
        const headM = this._m5.makeRotationZ(-d.headPitch);
        headM.setPosition(0.52, 0.78, 0);
        m4.multiply(headM);
        this.deer.heads.setMatrixAt(i, m4);
      });
      this.deer.bodies.instanceMatrix.needsUpdate = true;
      this.deer.heads.instanceMatrix.needsUpdate = true;
    }
  }

  _v2 = new THREE.Vector3();
  _m5 = new THREE.Matrix4();
}

const ONE = new THREE.Vector3(1, 1, 1);

// A raven: ~1.2 m wingspan silhouette, 8 triangles. Wings are the |x| verts,
// flapped in the vertex shader.
function makeBirdGeometry() {
  const span = 1.2, chord = 0.3;
  const pos = [
    // body diamond (nose, tail, left/right shoulders)
    0, 0, -0.42,   0.08, 0, 0.12,   -0.08, 0, 0.12,
    0, 0, 0.12,    0.07, 0, 0.46,   -0.07, 0, 0.46,   // tail fan
    // left wing (root front, root back, tip)
    -0.06, 0, -0.16,  -0.06, 0, chord - 0.16,  -span / 2, 0, 0.1,
    // right wing
    0.06, 0, -0.16,   span / 2, 0, 0.1,   0.06, 0, chord - 0.16,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
}

// Mule deer from shaded boxes: tan coat, darker legs/belly, pale rump.
// Body geometry faces +X (nose toward +X); head/neck is a separate geometry
// whose origin is the neck joint so it can dip to graze.
function makeDeerGeometry() {
  const C_COAT = new THREE.Color(0x8d7458);
  const C_DARK = new THREE.Color(0x5f4d3a);
  const C_PALE = new THREE.Color(0xb3a489);

  const paint = (geo, top, bottom) => {
    const n = geo.attributes.normal;
    const colors = new Float32Array(n.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n.count; i++) {
      const ny = n.getY(i);
      c.copy(ny > 0.5 ? top : ny < -0.5 ? bottom : top).lerp(bottom, ny < -0.5 ? 0 : 0.25 - ny * 0.25);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  };
  const box = (w, h, d, x, y, z, top = C_COAT, bottom = C_DARK) => {
    const g = paint(new THREE.BoxGeometry(w, h, d), top, bottom);
    g.translate(x, y, z);
    return g;
  };

  const body = mergeGeometries([
    box(1.1, 0.5, 0.42, 0, 0.78, 0),                  // torso
    box(0.28, 0.3, 0.34, -0.6, 0.82, 0, C_PALE, C_PALE), // pale rump
    box(0.09, 0.56, 0.09, 0.42, 0.28, 0.13),          // legs
    box(0.09, 0.56, 0.09, 0.42, 0.28, -0.13),
    box(0.09, 0.56, 0.09, -0.42, 0.28, 0.14),
    box(0.09, 0.56, 0.09, -0.42, 0.28, -0.14),
    box(0.07, 0.18, 0.07, -0.68, 0.86, 0, C_DARK, C_DARK), // tail
  ]);

  // head assembly: origin at the neck joint (translated to (0.52, 0.78) per-frame)
  const head = mergeGeometries([
    box(0.14, 0.42, 0.16, 0.07, 0.2, 0),              // neck, leaning forward
    box(0.34, 0.17, 0.15, 0.26, 0.42, 0),             // head
    box(0.13, 0.1, 0.13, 0.42, 0.36, 0, C_DARK, C_DARK), // muzzle
    box(0.04, 0.18, 0.1, 0.16, 0.56, 0.1, C_PALE, C_COAT), // ears
    box(0.04, 0.18, 0.1, 0.16, 0.56, -0.1, C_PALE, C_COAT),
  ]);
  return { body, head };
}
