import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attachAtmo } from './atmosphere.js';

// Generative forest, placed from the imagery-derived forest-density mask so
// trees stand exactly where the real forest is (meadows stay open, talus and
// cliff faces stay bare). Three procedurally painted archetypes — ponderosa
// pine, incense cedar, black oak — instanced in streaming cells around the
// camera: full 3D card-trees with real trunks nearby, crossed cards further
// out, satellite canopy texture beyond.
//
// Everything is deterministic per cell (seeded PRNG), so the same forest
// grows every visit.

const CELL = 256;            // meters; placement cell
const NEAR_RADIUS = 780;     // full-detail trees
const FAR_RADIUS = 2700;     // crossed-card trees (in 2x2 cell groups)
const HYSTERESIS = 90;
const BUILD_BUDGET = 3;      // cell builds per frame

const TYPES = {
  pine: { foliageBase: 0.26, planeW: 0.36, trunkR: 0.015, minH: 14, varH: 28 },
  cedar: { foliageBase: 0.05, planeW: 0.27, trunkR: 0.017, minH: 12, varH: 20 },
  oak: { foliageBase: 0.32, planeW: 0.52, trunkR: 0.024, minH: 7, varH: 9 },
};
const TYPE_NAMES = Object.keys(TYPES);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Forest {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.timeUniform = { value: 0 };
    this.tint = new THREE.Color(1, 1, 1);
    this.textures = {};
    this.nearGeo = {};
    this.farGeo = {};
    this.nearMat = {};
    for (const name of TYPE_NAMES) {
      const atlas = paintTreeAtlas(name);
      this.textures[name] = atlas;
      this.nearGeo[name] = buildNearGeometry(name);
      this.farGeo[name] = buildFarGeometry(name);
      this.nearMat[name] = this.makeMaterial(atlas, true);
    }
    // far cells draw all archetypes with the pine atlas (indistinguishable out there)
    this.farMat = this.makeMaterial(this.textures.pine, false);

    this.cellTrees = new Map();  // "cx,cz" -> packed tree list (LRU-ish)
    this.nearCells = new Map();  // "cx,cz" -> {meshes}
    this.farCells = new Map();   // "fx,fz" -> {meshes, nearMask}
    this.stats = { trees: 0, drawCalls: 0 };
    this._camCell = null;
  }

  makeMaterial(map, wind) {
    const mat = new THREE.MeshBasicMaterial({
      map,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      alphaToCoverage: true,
    });
    mat.toneMapped = false;
    const time = this.timeUniform;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      if (wind) {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            #ifdef USE_INSTANCING
              float windPh = instanceMatrix[3].x * 0.171 + instanceMatrix[3].z * 0.131;
              float windSway = sin(uTime * 1.7 + windPh) + 0.6 * sin(uTime * 3.1 + windPh * 1.37);
              transformed.x += windSway * 0.014 * transformed.y * transformed.y;
            #endif`
          );
      }
      // v2 weather: frost the canopy in snowfall, soak it darker in rain
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uAtmoSnow; uniform float uAtmoWet;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float frostL = dot(diffuseColor.rgb, vec3(0.35, 0.5, 0.15));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.84, 0.9) * (0.45 + 1.4 * frostL), uAtmoSnow * 0.55);
          diffuseColor.rgb *= 1.0 - uAtmoWet * 0.22;`
        );
    };
    attachAtmo(mat);
    return mat;
  }

  setTint(color) {
    this.tint.copy(color);
    for (const name of TYPE_NAMES) this.nearMat[name].color.copy(color);
    this.farMat.color.copy(color);
  }

  // Deterministic tree list for a placement cell. Packed per tree:
  // [x, y, z, height, rotY, type, r, g, b]
  treesForCell(cx, cz) {
    const key = `${cx},${cz}`;
    let list = this.cellTrees.get(key);
    if (list) return list;
    const rand = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ 0x9e3779b9);
    const t = this.terrain;
    const out = [];
    const attempts = Math.floor((CELL / 8) ** 2);
    for (let i = 0; i < attempts; i++) {
      const x = (cx + rand()) * CELL;
      const z = (cz + rand()) * CELL;
      const d = t.forestAt(x, z);
      if (d < 0.04 || rand() > d * 0.85) continue;
      const y = t.heightAt(x, z);
      // archetype: oaks on the open valley floor, cedar mixed in below the rim
      let type;
      const r0 = rand();
      if (y < 1340 && d < 0.5 && r0 < 0.3) type = 2;        // oak
      else if (y < 2100 && r0 < 0.35) type = 1;             // cedar
      else type = 0;                                        // pine
      const def = TYPES[TYPE_NAMES[type]];
      let h = def.minH + def.varH * rand() ** 1.6;
      if (y > 2300) h *= 0.65;                              // subalpine, smaller
      else h *= 0.75 + 0.5 * d;                             // closed canopy grows tall
      // per-tree brightness/warmth jitter (textures carry the base color)
      const v = 0.68 + 0.55 * rand();
      const warm = 0.93 + 0.13 * rand();
      out.push(x, y, z, h, rand() * Math.PI * 2, type, v * warm, v, v / warm);
    }
    list = new Float32Array(out);
    this.cellTrees.set(key, list);
    if (this.cellTrees.size > 900) {
      // drop the oldest cached cells
      for (const k of this.cellTrees.keys()) {
        this.cellTrees.delete(k);
        if (this.cellTrees.size <= 700) break;
      }
    }
    return list;
  }

  buildNearCell(cx, cz) {
    const trees = this.treesForCell(cx, cz);
    const counts = [0, 0, 0];
    for (let i = 0; i < trees.length; i += 9) counts[trees[i + 5]]++;
    const meshes = [];
    const cursor = [0, 0, 0];
    const ms = TYPE_NAMES.map((name, ti) =>
      counts[ti] ? new THREE.InstancedMesh(this.nearGeo[name], this.nearMat[name], counts[ti]) : null
    );
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    for (let i = 0; i < trees.length; i += 9) {
      const ti = trees[i + 5];
      const mesh = ms[ti];
      const h = trees[i + 3];
      q.setFromAxisAngle(up, trees[i + 4]);
      m4.compose(
        new THREE.Vector3(trees[i], trees[i + 1], trees[i + 2]),
        q,
        new THREE.Vector3(h * (0.85 + 0.002 * ((i * 7) % 100)), h, h * (0.85 + 0.002 * ((i * 13) % 100)))
      );
      mesh.setMatrixAt(cursor[ti], m4);
      col.setRGB(trees[i + 6], trees[i + 7], trees[i + 8]);
      mesh.setColorAt(cursor[ti], col);
      cursor[ti]++;
    }
    for (const mesh of ms) {
      if (!mesh) continue;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      meshes.push(mesh);
    }
    this.nearCells.set(`${cx},${cz}`, { meshes });
  }

  // Far cells are 2x2 placement cells drawn as crossed cards; placement cells
  // currently shown at near detail are excluded (nearMask tracks that).
  buildFarCell(fx, fz, nearMask) {
    const key = `${fx},${fz}`;
    this.dropCell(this.farCells, key);
    const lists = [];
    let total = 0;
    for (let s = 0; s < 4; s++) {
      if (nearMask & (1 << s)) { lists.push(null); continue; }
      const list = this.treesForCell(fx * 2 + (s & 1), fz * 2 + (s >> 1));
      lists.push(list);
      total += list.length / 9;
    }
    if (!total) {
      this.farCells.set(key, { meshes: [], nearMask });
      return;
    }
    const mesh = new THREE.InstancedMesh(this.farGeo.pine, this.farMat, total);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    let n = 0;
    for (const trees of lists) {
      if (!trees) continue;
      for (let i = 0; i < trees.length; i += 9) {
        const h = trees[i + 3];
        const oak = trees[i + 5] === 2;
        q.setFromAxisAngle(up, trees[i + 4]);
        m4.compose(
          new THREE.Vector3(trees[i], trees[i + 1], trees[i + 2]),
          q,
          new THREE.Vector3(h * (oak ? 1.3 : 0.9), h, h * (oak ? 1.3 : 0.9))
        );
        mesh.setMatrixAt(n, m4);
        col.setRGB(trees[i + 6], trees[i + 7], trees[i + 8]);
        mesh.setColorAt(n, col);
        n++;
      }
    }
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.farCells.set(key, { meshes: [mesh], nearMask });
  }

  dropCell(map, key) {
    const cell = map.get(key);
    if (!cell) return;
    for (const mesh of cell.meshes) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    map.delete(key);
  }

  // Stream cells around the camera; builds are budgeted per frame.
  update(camera, dt, budget = BUILD_BUDGET) {
    this.timeUniform.value += dt;
    const px = camera.position.x;
    const pz = camera.position.z;

    const wantNear = new Set();
    const nr = Math.ceil(NEAR_RADIUS / CELL);
    const ccx = Math.floor(px / CELL), ccz = Math.floor(pz / CELL);
    for (let dz = -nr; dz <= nr; dz++) {
      for (let dx = -nr; dx <= nr; dx++) {
        const cx = ccx + dx, cz = ccz + dz;
        const d = cellDist(px, pz, cx, cz, CELL);
        const key = `${cx},${cz}`;
        const limit = this.nearCells.has(key) ? NEAR_RADIUS + HYSTERESIS : NEAR_RADIUS;
        if (d < limit) wantNear.add(key);
      }
    }
    for (const key of [...this.nearCells.keys()]) {
      if (!wantNear.has(key)) this.dropCell(this.nearCells, key);
    }

    const FAR_CELL = CELL * 2;
    const wantFar = new Map(); // key -> nearMask
    const fr = Math.ceil(FAR_RADIUS / FAR_CELL);
    const fcx = Math.floor(px / FAR_CELL), fcz = Math.floor(pz / FAR_CELL);
    for (let dz = -fr; dz <= fr; dz++) {
      for (let dx = -fr; dx <= fr; dx++) {
        const fx = fcx + dx, fz = fcz + dz;
        const key = `${fx},${fz}`;
        const d = cellDist(px, pz, fx, fz, FAR_CELL);
        const limit = this.farCells.has(key) ? FAR_RADIUS + HYSTERESIS : FAR_RADIUS;
        if (d >= limit) continue;
        let mask = 0;
        for (let s = 0; s < 4; s++) {
          if (wantNear.has(`${fx * 2 + (s & 1)},${fz * 2 + (s >> 1)}`)) mask |= 1 << s;
        }
        wantFar.set(key, mask);
      }
    }
    for (const key of [...this.farCells.keys()]) {
      if (!wantFar.has(key)) this.dropCell(this.farCells, key);
    }

    // build the closest missing cells first
    const jobs = [];
    for (const key of wantNear) {
      if (!this.nearCells.has(key)) {
        const [cx, cz] = key.split(',').map(Number);
        jobs.push({ d: cellDist(px, pz, cx, cz, CELL), f: () => this.buildNearCell(cx, cz) });
      }
    }
    for (const [key, mask] of wantFar) {
      const cell = this.farCells.get(key);
      if (cell && cell.nearMask === mask) continue;
      const [fx, fz] = key.split(',').map(Number);
      jobs.push({
        d: cellDist(px, pz, fx, fz, CELL * 2) + (cell ? 400 : 0), // refreshes are lower priority
        f: () => this.buildFarCell(fx, fz, mask),
      });
    }
    jobs.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(budget, jobs.length); i++) jobs[i].f();

    if (jobs.length === 0 && this._statsDirty !== false) {
      let trees = 0, calls = 0;
      for (const { meshes } of this.nearCells.values()) for (const m of meshes) { trees += m.count; calls++; }
      for (const { meshes } of this.farCells.values()) for (const m of meshes) { trees += m.count; calls++; }
      this.stats = { trees, drawCalls: calls };
      this._statsDirty = false;
    } else if (jobs.length) {
      this._statsDirty = true;
    }
  }

  // Build everything around a point right now (used during the loading screen
  // so the first frame already has its forest).
  prewarm(camera) {
    for (let i = 0; i < 400; i++) {
      this.update(camera, 0, 24);
    }
  }
}

function cellDist(px, pz, cx, cz, size) {
  const dx = Math.max(Math.abs(px - (cx + 0.5) * size) - size / 2, 0);
  const dz = Math.max(Math.abs(pz - (cz + 0.5) * size) - size / 2, 0);
  return Math.hypot(dx, dz);
}

// ------------------------------------------------------------ geometry
// Trees are unit height (scaled per instance). The texture atlas per archetype:
//   x 0.00-0.44  full-tree card (painted trunk) — far LOD
//   x 0.46-0.90  foliage-only card               — near LOD planes
//   x 0.92-1.00  bark strip                      — near LOD trunk

function cardPlane(u0, u1, v0, v1, w, y0, y1, angle, tilt = 0) {
  const geo = new THREE.PlaneGeometry(w, y1 - y0);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  geo.translate(0, (y0 + y1) / 2, 0);
  if (tilt) geo.rotateX(tilt);
  geo.rotateY(angle);
  return geo;
}

function buildNearGeometry(name) {
  const def = TYPES[name];
  const parts = [];
  // six radial foliage planes with slight tilt/size variation
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 + (i % 2) * 0.26;
    const tilt = (i % 3 === 1 ? 1 : -1) * 0.07 * (i % 2);
    const s = i < 3 ? 1 : 0.82;
    parts.push(cardPlane(0.46, 0.90, def.foliageBase, 1, def.planeW * s,
      def.foliageBase + (1 - def.foliageBase) * (1 - s), 1, angle, tilt));
  }
  // real trunk up to mid-foliage, UV-mapped to the bark strip
  const trunkTop = def.foliageBase + (1 - def.foliageBase) * 0.5;
  const trunk = new THREE.CylinderGeometry(def.trunkR * 0.45, def.trunkR, trunkTop, 5, 1, true);
  const tuv = trunk.attributes.uv;
  for (let i = 0; i < tuv.count; i++) tuv.setXY(i, 0.92 + tuv.getX(i) * 0.08, tuv.getY(i));
  trunk.translate(0, trunkTop / 2, 0);
  parts.push(trunk);
  return mergeGeometries(parts);
}

function buildFarGeometry(name) {
  const def = TYPES[name];
  return mergeGeometries([
    cardPlane(0, 0.44, 0, 1, def.planeW, 0, 1, 0),
    cardPlane(0, 0.44, 0, 1, def.planeW, 0, 1, Math.PI / 2),
  ]);
}

// ------------------------------------------------------------ texture painting

function paintTreeAtlas(name) {
  const S = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(name === 'pine' ? 101 : name === 'cedar' ? 202 : 303);

  // foliage painted once on its own layer, blitted into both card slots
  const card = document.createElement('canvas');
  const CW = Math.round(0.44 * S);
  card.width = CW;
  card.height = S;
  const c = card.getContext('2d');
  if (name === 'oak') paintOakFoliage(c, CW, S, rand);
  else paintConiferFoliage(c, CW, S, rand, name === 'cedar');

  ctx.drawImage(card, Math.round(0.46 * S), 0); // foliage-only slot
  // trunk under the foliage for the full-tree card
  paintCardTrunk(c, CW, S, rand, name);
  ctx.drawImage(card, 0, 0);

  paintBarkStrip(ctx, Math.round(0.92 * S), 0, S - Math.round(0.92 * S), S, rand, name);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// y in card space: 0 = top of tree, H = ground
function paintConiferFoliage(c, W, H, rand, cedar) {
  const def = cedar ? TYPES.cedar : TYPES.pine;
  const axis = W / 2;
  const top = H * 0.015;
  const bottom = H * (1 - def.foliageBase) - H * 0.01; // foliage zone maps to plane
  const maxHalf = W * (cedar ? 0.38 : 0.46);
  const hue = cedar ? 108 : 96;

  // crown silhouette: irregular cone, wider whorls broken up by jitter
  const halfAt = (t) => {
    const base = Math.pow(t, cedar ? 0.7 : 0.85);
    return maxHalf * base * (0.7 + 0.3 * rand());
  };

  const whorls = cedar ? 46 : 34;
  for (let wi = 0; wi <= whorls; wi++) {
    const t = wi / whorls;
    const y = top + (bottom - top) * Math.pow(t, 0.92);
    const half = halfAt(t);
    const branches = 2 + Math.floor(rand() * 3);
    for (let side = -1; side <= 1; side += 2) {
      for (let b = 0; b < branches; b++) {
        const len = half * (0.55 + 0.45 * rand());
        const droop = len * (cedar ? 0.34 : 0.22) * (0.6 + rand());
        const y0 = y + (rand() - 0.5) * H * 0.012;
        // needle tufts along the branch
        const steps = Math.max(3, Math.floor(len / 9));
        for (let s = 0; s <= steps; s++) {
          const f = s / steps;
          const px = axis + side * len * f;
          const py = y0 + droop * f * f;
          const inner = 1 - f * 0.75;
          const light = 10 + 16 * (1 - inner) + rand() * 8 - (cedar ? 3 : 0);
          const sat = 18 + rand() * 12;
          const r = (cedar ? 5.5 : 7) * (0.5 + rand() * 0.8) * (0.5 + f * 0.8);
          c.fillStyle = `hsla(${hue + rand() * 18 - 9}, ${sat}%, ${light}%, ${0.5 + rand() * 0.5})`;
          c.beginPath();
          c.arc(px + (rand() - 0.5) * 6, py + (rand() - 0.5) * 6, r, 0, 7);
          c.fill();
        }
      }
    }
  }
  // leader spike at the top
  c.fillStyle = `hsl(${hue}, 26%, 20%)`;
  c.beginPath();
  c.moveTo(axis - 3, top + H * 0.05);
  c.lineTo(axis, top - 2);
  c.lineTo(axis + 3, top + H * 0.05);
  c.fill();
  // interior self-shadow near the axis
  const grad = c.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(8,14,6,0.34)');
  c.globalCompositeOperation = 'source-atop';
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'source-over';
}

function paintOakFoliage(c, W, H, rand) {
  const axis = W / 2;
  const cyT = H * 0.04, cyB = H * (1 - TYPES.oak.foliageBase);
  const cy = (cyT + cyB) / 2;
  const ry = (cyB - cyT) / 2;
  const rx = W * 0.46;
  // clustered round canopy: many overlapping leaf blobs
  for (let i = 0; i < 240; i++) {
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand());
    const px = axis + Math.cos(a) * rx * rr * 0.92;
    const py = cy + Math.sin(a) * ry * rr * 0.92;
    const edge = rr; // lighter at the canopy edge (sun), darker inside
    const light = 12 + edge * 14 + rand() * 6;
    c.fillStyle = `hsla(${80 + rand() * 14}, ${24 + rand() * 10}%, ${light}%, ${0.55 + rand() * 0.45})`;
    c.beginPath();
    c.arc(px, py, (8 + rand() * 26) * (1 - rr * 0.35), 0, 7);
    c.fill();
  }
}

function paintCardTrunk(c, W, H, rand, name) {
  const axis = W / 2;
  const def = TYPES[name];
  const baseW = W * (name === 'oak' ? 0.06 : 0.045);
  const topY = H * (name === 'cedar' ? 0.3 : name === 'oak' ? 0.45 : 0.45);
  c.fillStyle = name === 'pine' ? '#4d3e2d' : name === 'cedar' ? '#4a3528' : '#3e3730';
  c.beginPath();
  c.moveTo(axis - baseW, H);
  c.lineTo(axis - baseW * 0.4, topY);
  c.lineTo(axis + baseW * 0.4, topY);
  c.lineTo(axis + baseW, H);
  c.fill();
  if (name === 'oak') {
    // a couple of limbs forking into the canopy
    c.strokeStyle = '#4a4138';
    c.lineWidth = baseW * 0.5;
    for (let i = 0; i < 3; i++) {
      const dir = i - 1;
      c.beginPath();
      c.moveTo(axis, H * 0.62);
      c.quadraticCurveTo(axis + dir * W * 0.1, H * 0.5, axis + dir * W * 0.2, H * 0.36);
      c.stroke();
    }
  }
  // bark shading streaks
  for (let i = 0; i < 18; i++) {
    const f = rand();
    c.strokeStyle = `rgba(${20 + rand() * 30}, ${15 + rand() * 22}, ${10 + rand() * 16}, 0.35)`;
    c.lineWidth = 1 + rand() * 2;
    const x = axis + (f - 0.5) * baseW * 1.6;
    c.beginPath();
    c.moveTo(x, H);
    c.lineTo(axis + (f - 0.5) * baseW * 0.8, topY + (H - topY) * rand() * 0.4);
    c.stroke();
  }
}

function paintBarkStrip(ctx, x, y, w, h, rand, name) {
  // ponderosa bark is orange-brown puzzle plates; cedar reddish fibrous; oak grey
  const base = name === 'pine' ? [82, 66, 50] : name === 'cedar' ? [76, 56, 44] : [70, 65, 57];
  ctx.fillStyle = `rgb(${base[0]}, ${base[1]}, ${base[2]})`;
  ctx.fillRect(x, y, w, h);
  // vertical fissures
  for (let i = 0; i < 26; i++) {
    const fx = x + rand() * w;
    ctx.strokeStyle = `rgba(${base[0] * 0.3}, ${base[1] * 0.3}, ${base[2] * 0.3}, ${0.4 + rand() * 0.4})`;
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath();
    ctx.moveTo(fx, y);
    let py = y;
    let px = fx;
    while (py < y + h) {
      py += 20 + rand() * 60;
      px += (rand() - 0.5) * 8;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // lighter plates
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${base[0] * 1.25}, ${base[1] * 1.2}, ${base[2] * 1.1}, ${0.12 + rand() * 0.15})`;
    ctx.fillRect(x + rand() * w, y + rand() * h, 3 + rand() * w * 0.4, 8 + rand() * 50);
  }
}
