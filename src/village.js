import * as THREE from 'three';
import { attachAtmo } from './atmosphere.js';

// The human layer, from real OpenStreetMap data (tools/fetch-osm.mjs):
//   · road centerlines draped over the DEM as asphalt ribbons — they overlay
//     the roads already visible in the satellite imagery, so alignment is free
//   · building footprints (Yosemite Village, Curry Village, the Ahwahnee)
//     extruded into simple shaded blocks, with warm windows after dark
//   · slow traffic on the valley's long roads (25 mph, like the real speed
//     limit), instanced two-box cars that switch their headlights on at night
// Everything merges into six draw calls total.

const ROAD_WIDTH = { primary: 8.5, secondary: 7.5, tertiary: 6.5, unclassified: 5.5, residential: 5.5 };
const SAMPLE = 12;         // meters between draped road samples
const ROAD_LIFT = 0.4;     // meters above the DEM
const CAR_COLORS = [0xd8d8d4, 0xb8b9bd, 0x6e7076, 0x5b6470, 0x7a4a42, 0x49524a, 0xc9c3b4];

export class Village {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.tint = new THREE.Color(1, 1, 1);
    this.materials = [];   // [{ mat, base }] tinted by the lighting presets
    this.cars = [];
    this.carPaths = [];
    this.ready = false;
    this.load();
  }

  async load() {
    let data;
    try {
      data = await fetch('data/osm.json').then((r) => (r.ok ? r.json() : null));
    } catch { /* offline build without the OSM bake */ }
    if (!data) return;
    this.buildRoads(data.roads);
    this.buildBuildings(data.buildings);
    this.buildCars();
    this.setTint(this.tint);
    this.ready = true;
  }

  // Convert a lon/lat polyline to draped in-bounds world runs, resampled so
  // ribbons follow the terrain between OSM nodes.
  drapedRuns(pts, keepEvery = SAMPLE) {
    const t = this.terrain;
    const inB = (p) => Math.abs(p.x) < t.halfW - 260 && Math.abs(p.z) < t.halfH - 260;
    const runs = [];
    let run = null;
    let prev = null;
    for (const [lon, lat] of pts) {
      const p = t.lonLatToWorld(lon, lat);
      if (!inB(p)) { run = null; prev = null; continue; }
      if (!run) { run = []; runs.push(run); }
      if (prev) {
        const d = Math.hypot(p.x - prev.x, p.z - prev.z);
        for (let s = keepEvery; s < d; s += keepEvery) {
          const f = s / d;
          run.push(new THREE.Vector3(prev.x + (p.x - prev.x) * f, 0, prev.z + (p.z - prev.z) * f));
        }
      }
      run.push(p);
      prev = p;
    }
    for (const r of runs) for (const p of r) p.y = t.heightAt(p.x, p.z) + ROAD_LIFT;
    return runs.filter((r) => r.length >= 3);
  }

  buildRoads(roads) {
    const positions = [];
    const colors = [];
    const index = [];
    const dir = new THREE.Vector2();
    this.carPathCandidates = [];

    for (const road of roads) {
      if (/^Old /.test(road.name)) continue; // historic wagon tracks, unpaved
      const width = ROAD_WIDTH[road.type] ?? 5.5;
      for (const run of this.drapedRuns(road.pts)) {
        let length = 0;
        for (let i = 1; i < run.length; i++) length += run[i].distanceTo(run[i - 1]);
        if (length > 1500 && (road.type === 'primary' || road.type === 'secondary' || road.type === 'tertiary')) {
          this.carPathCandidates.push({ name: road.name, run, length });
        }
        const base = positions.length / 3;
        for (let i = 0; i < run.length; i++) {
          const p = run[i];
          const a = run[Math.max(0, i - 1)], b = run[Math.min(run.length - 1, i + 1)];
          dir.set(b.x - a.x, b.z - a.z).normalize();
          const px = -dir.y, pz = dir.x; // perpendicular in xz
          const hL = this.terrain.heightAt(p.x + px * width * 0.5, p.z + pz * width * 0.5);
          const hR = this.terrain.heightAt(p.x - px * width * 0.5, p.z - pz * width * 0.5);
          // follow the cross-slope a little so the ribbon hugs banked ground
          const yL = p.y * 0.4 + (hL + ROAD_LIFT) * 0.6;
          const yR = p.y * 0.4 + (hR + ROAD_LIFT) * 0.6;
          positions.push(p.x + px * width * 0.5, yL, p.z + pz * width * 0.5);
          positions.push(p.x - px * width * 0.5, yR, p.z - pz * width * 0.5);
          const v = 0.93 + ((i * 2654435761) % 100) / 100 * 0.14; // asphalt tone jitter
          colors.push(v, v, v, v, v, v);
          if (i > 0) {
            const k = base + i * 2;
            index.push(k - 2, k - 1, k, k - 1, k + 1, k);
          }
        }
      }
    }
    if (!positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
    geo.setIndex(positions.length / 3 > 65000 ? new THREE.BufferAttribute(new Uint32Array(index), 1) : index);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    mat.toneMapped = false;
    attachAtmo(mat);
    this.materials.push({ mat, base: new THREE.Color(0x3d3e41) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  buildBuildings(buildings) {
    const t = this.terrain;
    const WALLS = [0x7d6c57, 0x71655a, 0x83755f, 0x6c5e4c].map((c) => new THREE.Color(c));
    const ROOFS = [0x4a4338, 0x3f4438, 0x45403c].map((c) => new THREE.Color(c));
    const SUN = new THREE.Vector2(0.5, -0.86); // fixed bake direction for wall shading

    const positions = [];
    const colors = [];
    const index = [];
    const winPts = [];
    const c = new THREE.Color();
    let skipped = 0;

    for (let bi = 0; bi < buildings.length; bi++) {
      const b = buildings[bi];
      const ring = b.pts.slice();
      if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
      if (ring.length < 3) continue;
      const world = ring.map(([lon, lat]) => t.lonLatToWorld(lon, lat));
      if (world.some((p) => Math.abs(p.x) > t.halfW - 260 || Math.abs(p.z) > t.halfH - 260)) { skipped++; continue; }

      let ground = Infinity;
      let cx = 0, cz = 0;
      for (const p of world) {
        ground = Math.min(ground, t.heightAt(p.x, p.z));
        cx += p.x / world.length;
        cz += p.z / world.length;
      }
      this.punchForest(world); // no trees through roofs
      // shoelace area for a default height
      let area = 0;
      for (let i = 0; i < world.length; i++) {
        const a = world[i], d = world[(i + 1) % world.length];
        area += a.x * d.z - d.x * a.z;
      }
      area = Math.abs(area) / 2;
      const h = b.levels ? b.levels * 3.3 + 1.2 : area > 600 ? 7.5 : area > 150 ? 5.4 : 4.2;
      const top = ground + h;
      const wall = WALLS[bi % WALLS.length];
      const roof = ROOFS[(bi * 7) % ROOFS.length];

      for (let i = 0; i < world.length; i++) {
        const a = world[i], d = world[(i + 1) % world.length];
        const ex = d.x - a.x, ez = d.z - a.z;
        const el = Math.hypot(ex, ez) || 1;
        const nx = ez / el, nz = -ex / el; // wall normal
        const lit = 0.74 + 0.26 * Math.max(0, nx * SUN.x + nz * SUN.y);
        const k = positions.length / 3;
        positions.push(a.x, ground - 1.5, a.z, d.x, ground - 1.5, d.z, d.x, top, d.z, a.x, top, a.z);
        c.copy(wall).multiplyScalar(lit);
        for (let v = 0; v < 4; v++) colors.push(c.r * (v < 2 ? 0.82 : 1), c.g * (v < 2 ? 0.82 : 1), c.b * (v < 2 ? 0.82 : 1));
        index.push(k, k + 1, k + 2, k, k + 2, k + 3);
        // a window or two on the longer walls, lit after dark
        if (el > 6 && winPts.length / 3 < 3600 && (bi + i) % 2 === 0) {
          const f = 0.3 + ((bi * 13 + i * 7) % 40) / 100;
          winPts.push(a.x + ex * f + nx * 0.35, ground + h * 0.55, a.z + ez * f + nz * 0.35);
        }
      }
      const k0 = positions.length / 3;
      const contour = world.map((p) => new THREE.Vector2(p.x, p.z));
      for (const p of world) {
        positions.push(p.x, top, p.z);
        colors.push(roof.r, roof.g, roof.b);
      }
      for (const [fa, fb, fc] of THREE.ShapeUtils.triangulateShape(contour, [])) {
        index.push(k0 + fa, k0 + fb, k0 + fc);
      }
    }
    if (!positions.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.toneMapped = false;
    attachAtmo(mat);
    this.materials.push({ mat, base: new THREE.Color(0xffffff) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);

    // warm windows, visible at dusk and night
    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(winPts), 3));
    this.windowMat = new THREE.PointsMaterial({
      color: 0xffc983,
      size: 3.2,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    this.windowMat.toneMapped = false;
    const windows = new THREE.Points(wgeo, this.windowMat);
    windows.frustumCulled = false;
    this.group.add(windows);
  }

  buildCars() {
    const paths = (this.carPathCandidates ?? []).sort((a, b) => b.length - a.length).slice(0, 7);
    this.carPathCandidates = null;
    if (!paths.length) return;
    for (const p of paths) {
      // cumulative arc length for constant-speed driving
      const cum = [0];
      for (let i = 1; i < p.run.length; i++) cum.push(cum[i - 1] + p.run[i].distanceTo(p.run[i - 1]));
      this.carPaths.push({ run: p.run, cum, length: p.length });
    }
    const totalKm = this.carPaths.reduce((s, p) => s + p.length, 0) / 1000;
    const N = Math.min(28, Math.max(8, Math.round(totalKm * 0.7)));
    for (let i = 0; i < N; i++) {
      const path = this.carPaths[i % this.carPaths.length];
      this.cars.push({
        path,
        s: 40 + Math.random() * (path.length - 80),
        dir: Math.random() < 0.5 ? 1 : -1,
        speed: 10 + Math.random() * 2.5, // ~25 mph valley limit
        seg: 0,
      });
    }

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    mat.toneMapped = false;
    attachAtmo(mat);
    this.materials.push({ mat, base: new THREE.Color(0xffffff) });
    this.carMesh = new THREE.InstancedMesh(makeCarGeometry(), mat, N);
    this.carMesh.frustumCulled = false;
    const col = new THREE.Color();
    for (let i = 0; i < N; i++) {
      this.carMesh.setColorAt(i, col.set(CAR_COLORS[i % CAR_COLORS.length]));
    }
    this.group.add(this.carMesh);

    // head/tail lights: 4 points per car, positions rewritten each frame
    const lgeo = new THREE.BufferGeometry();
    lgeoInit: {
      const pos = new Float32Array(N * 4 * 3);
      const col2 = new Float32Array(N * 4 * 3);
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < 4; j++) {
          const o = (i * 4 + j) * 3;
          const head = j < 2;
          col2[o] = head ? 1 : 0.9;
          col2[o + 1] = head ? 0.93 : 0.08;
          col2[o + 2] = head ? 0.75 : 0.06;
        }
      }
      lgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      lgeo.setAttribute('color', new THREE.BufferAttribute(col2, 3));
    }
    this.lightMat = new THREE.PointsMaterial({
      vertexColors: true,
      size: 2.4,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    this.lightMat.toneMapped = false;
    this.carLights = new THREE.Points(lgeo, this.lightMat);
    this.carLights.frustumCulled = false;
    this.group.add(this.carLights);
  }

  // Zero the imagery-derived tree-density mask under a building footprint
  // (dark roofs classify as canopy, which grew trees through the village).
  punchForest(world) {
    const t = this.terrain;
    if (!t.forest) return;
    const { gridW, gridH, metersPerPx } = t.m;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of world) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    const pad = 3;
    const c0 = Math.max(0, Math.floor((x0 - pad + t.halfW) / metersPerPx));
    const c1 = Math.min(gridW - 1, Math.ceil((x1 + pad + t.halfW) / metersPerPx));
    const r0 = Math.max(0, Math.floor((z0 - pad + t.halfH) / metersPerPx));
    const r1 = Math.min(gridH - 1, Math.ceil((z1 + pad + t.halfH) / metersPerPx));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) t.forest[r * gridW + c] = 0;
    }
  }

  setTint(color) {
    this.tint.copy(color);
    for (const { mat, base } of this.materials) mat.color.copy(base).multiply(color);
  }

  update(dt, night, snow = 0) {
    if (!this.ready) return;
    if (this.windowMat) this.windowMat.opacity = Math.min(1, night * 1.3) * 0.9;
    if (!this.cars.length) return;

    const m4 = this._m4, e = this._e, q = this._q, v = this._v;
    const lightPos = this.carLights.geometry.attributes.position;
    const slow = 1 - 0.45 * snow;
    this.cars.forEach((car, i) => {
      car.s += car.speed * slow * car.dir * dt;
      if (car.s > car.path.length - 30) { car.s = car.path.length - 30; car.dir = -1; }
      if (car.s < 30) { car.s = 30; car.dir = 1; }
      const { run, cum } = car.path;
      while (car.seg < run.length - 2 && cum[car.seg + 1] < car.s) car.seg++;
      while (car.seg > 0 && cum[car.seg] > car.s) car.seg--;
      const a = run[car.seg], b = run[car.seg + 1];
      const f = (car.s - cum[car.seg]) / Math.max(cum[car.seg + 1] - cum[car.seg], 0.01);
      v.lerpVectors(a, b, f);
      const dx = (b.x - a.x) * car.dir, dy = (b.y - a.y) * car.dir, dz = (b.z - a.z) * car.dir;
      const horiz = Math.hypot(dx, dz) || 1;
      // drive on the right: offset half a lane from the centerline
      const lane = 1.9;
      v.x += (dz / horiz) * lane;
      v.z += (-dx / horiz) * lane;
      const yaw = Math.atan2(dz, dx);
      e.set(0, -yaw, Math.atan2(dy, horiz), 'YZX');
      q.setFromEuler(e);
      m4.compose(v, q, ONE);
      this.carMesh.setMatrixAt(i, m4);
      for (let j = 0; j < 4; j++) {
        this._v2.copy(LIGHT_OFFSETS[j]).applyMatrix4(m4);
        lightPos.setXYZ(i * 4 + j, this._v2.x, this._v2.y, this._v2.z);
      }
    });
    this.carMesh.instanceMatrix.needsUpdate = true;
    lightPos.needsUpdate = true;
    this.lightMat.opacity = Math.min(1, night * 1.5) * 0.9;
  }

  _m4 = new THREE.Matrix4();
  _e = new THREE.Euler();
  _q = new THREE.Quaternion();
  _v = new THREE.Vector3();
  _v2 = new THREE.Vector3();
}

const ONE = new THREE.Vector3(1, 1, 1);
const LIGHT_OFFSETS = [
  new THREE.Vector3(2.15, 0.62, 0.55),   // headlights
  new THREE.Vector3(2.15, 0.62, -0.55),
  new THREE.Vector3(-2.2, 0.7, 0.5),     // taillights
  new THREE.Vector3(-2.2, 0.7, -0.5),
];

// A car as two shaded boxes (body + cabin), ~4.4 m long, facing +X.
function makeCarGeometry() {
  const parts = [];
  const addBox = (w, h, d, x, y, z, shade) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    const n = g.attributes.normal;
    const colors = new Float32Array(n.count * 3);
    for (let i = 0; i < n.count; i++) {
      const ny = n.getY(i);
      const v = shade * (ny > 0.5 ? 1 : ny < -0.5 ? 0.5 : 0.78);
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  };
  addBox(4.4, 0.95, 1.82, 0, 0.82, 0, 1.0);    // body
  addBox(2.3, 0.62, 1.6, -0.25, 1.6, 0, 0.55); // cabin (glass-dark)
  // tiny merge without pulling in BufferGeometryUtils
  const merged = new THREE.BufferGeometry();
  const pos = [], col = [], idx = [];
  for (const g of parts) {
    const base = pos.length / 3;
    pos.push(...g.attributes.position.array);
    col.push(...g.attributes.color.array);
    for (const i of g.index.array) idx.push(base + i);
  }
  merged.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  merged.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  merged.setIndex(idx);
  return merged;
}
