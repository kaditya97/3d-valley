import * as THREE from 'three';
import { attachAtmo } from './atmosphere.js';
import { db } from './db.js';

// Loads the pre-built Yosemite dataset (see tools/fetch-terrain.mjs) and
// builds chunked terrain meshes in a local metric frame:
//   +X east, +Z south, +Y up (meters above sea level), origin at grid center.
//
// Valley-core chunks are meshed at full DEM resolution (~7.6 m), outer chunks
// at half resolution; short skirts around every chunk hide the LOD seams.
export class Terrain {
  constructor(manifest, heights, forest) {
    this.m = manifest;
    this.heights = heights; // Float32Array, gridW x gridH, row-major from NW corner
    this.forest = forest;   // Uint8Array tree density, same grid (0..255)
    this.group = new THREE.Group();
    this.materials = [];
    this.tint = new THREE.Color(1, 1, 1);
    this.halfW = ((manifest.gridW - 1) * manifest.metersPerPx) / 2;
    this.halfH = ((manifest.gridH - 1) * manifest.metersPerPx) / 2;
    this.detailTexture = makeDetailTexture();
  }

  static async load(onProgress, sceneId) {
    let manifest, heightsBuf, forest, customSceneData = null;

    if (sceneId && sceneId !== 'yosemite') {
      customSceneData = await db.getScene(sceneId);
      if (!customSceneData) throw new Error('Scene not found in database');
      manifest = customSceneData.manifest;
      heightsBuf = customSceneData.heights;
      forest = await decodeForestMask(customSceneData.forest);
    } else {
      const forestBlob = await fetch('data/forest.png').then((r) => r.blob());
      [manifest, heightsBuf, forest] = await Promise.all([
        fetch('data/manifest.json').then((r) => r.json()),
        fetch('data/heights.bin').then((r) => r.arrayBuffer()),
        decodeForestMask(forestBlob),
      ]);
    }

    const enc = new Uint16Array(heightsBuf);
    const heights = new Float32Array(enc.length);
    for (let i = 0; i < enc.length; i++) {
      heights[i] = enc[i] * manifest.heightScale + manifest.heightOffset;
    }
    const terrain = new Terrain(manifest, heights, forest);
    terrain.customSceneData = customSceneData;
    await terrain.buildChunks(onProgress);
    return terrain;
  }

  async buildChunks(onProgress) {
    const loader = new THREE.TextureLoader();
    let done = 0;
    const total = this.m.chunks.length;
    const jobs = this.m.chunks.map((chunk) => {
      let url;
      let isBlob = false;
      if (this.customSceneData && this.customSceneData.textures) {
        const blob = this.customSceneData.textures[`${chunk.cx}_${chunk.cy}`];
        if (blob) {
          url = URL.createObjectURL(blob);
          isBlob = true;
        }
      }
      if (!url) {
        url = `data/tex/${chunk.cx}_${chunk.cy}.jpg`;
      }

      return loader.loadAsync(url).then((tex) => {
        if (isBlob) {
          URL.revokeObjectURL(url);
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        const mesh = this.buildChunkMesh(chunk, tex);
        this.group.add(mesh);
        onProgress?.(++done, total);
      });
    });
    await Promise.all(jobs);
  }

  buildChunkMesh(chunk, texture) {
    const { gridW, gridH, chunkSpan, metersPerPx } = this.m;
    const step = chunk.step ?? 1;
    const c0 = chunk.cx * chunkSpan;
    const r0 = chunk.cy * chunkSpan;
    const c1 = Math.min(c0 + chunkSpan, gridW - 1);
    const r1 = Math.min(r0 + chunkSpan, gridH - 1);
    const w = Math.floor((c1 - c0) / step) + 1;
    const h = Math.floor((r1 - r0) / step) + 1;

    // grid vertices + one extra ring (skirt) dropped below the surface to
    // hide cracks where neighbouring chunks have a different mesh step
    const skirt = 25;
    const vertCount = w * h + 2 * (w + h);
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    let p = 0, u = 0;
    const emit = (c, r, drop) => {
      positions[p++] = c * metersPerPx - this.halfW;
      positions[p++] = this.heights[r * gridW + c] - drop;
      positions[p++] = r * metersPerPx - this.halfH;
      uvs[u++] = (c - c0) / chunkSpan;
      uvs[u++] = 1 - (r - r0) / chunkSpan; // texture flipY
    };
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) emit(c0 + c * step, r0 + r * step, 0);
    // skirt rings: north, south rows then west, east columns
    for (let c = 0; c < w; c++) emit(c0 + c * step, r0, skirt);
    for (let c = 0; c < w; c++) emit(c0 + c * step, r1, skirt);
    for (let r = 0; r < h; r++) emit(c0, r0 + r * step, skirt);
    for (let r = 0; r < h; r++) emit(c1, r0 + r * step, skirt);

    const quads = (w - 1) * (h - 1) + 2 * (w - 1) + 2 * (h - 1);
    const index = new Uint32Array(quads * 6);
    let q = 0;
    const quad = (a, b, d, e) => {
      index[q++] = a; index[q++] = d; index[q++] = b;
      index[q++] = b; index[q++] = d; index[q++] = e;
    };
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const a = r * w + c;
        quad(a, a + 1, a + w, a + w + 1);
      }
    }
    const sN = w * h, sS = sN + w, sW = sS + w, sE = sW + h;
    for (let c = 0; c < w - 1; c++) quad(sN + c, sN + c + 1, c, c + 1);
    for (let c = 0; c < w - 1; c++) quad((h - 1) * w + c, (h - 1) * w + c + 1, sS + c, sS + c + 1);
    for (let r = 0; r < h - 1; r++) quad(sW + r, r * w, sW + r + 1, (r + 1) * w);
    for (let r = 0; r < h - 1; r++) quad(r * w + w - 1, sE + r, (r + 1) * w + w - 1, sE + r + 1);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    geo.computeVertexNormals(); // for slope relighting + snow settling (v2)

    // Satellite imagery already has real sun shading baked in, so the terrain
    // is rendered unlit; dynamic lights would double-shade it. Lighting presets
    // tint via material.color. A tiling noise texture adds micro detail up
    // close, fading out by ~2 km so the imagery is untouched at distance.
    const mat = new THREE.MeshBasicMaterial({ map: texture });
    mat.toneMapped = false;
    const detail = this.detailTexture;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.detailMap = { value: detail };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vDetailPos;\nvarying float vDetailDist;\nvarying vec3 vTerrNormal;')
        .replace(
          '#include <fog_vertex>',
          '#include <fog_vertex>\nvDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvDetailDist = -mvPosition.z;\nvTerrNormal = normal;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D detailMap;
          uniform float uAtmoRelight; uniform float uAtmoSnow; uniform float uAtmoWet;
          varying vec3 vDetailPos; varying float vDetailDist; varying vec3 vTerrNormal;`)
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float dNear = texture2D(detailMap, vDetailPos.xz / 4.5).r;
          float dMid  = texture2D(detailMap, vDetailPos.xz / 31.0).r;
          float dFade = smoothstep(2200.0, 200.0, vDetailDist);
          diffuseColor.rgb *= mix(1.0, dNear * dMid * 4.0, dFade * 0.6);

          // v2 grade: tame the imagery's olive-green cast, gentle warmth + contrast
          vec3 g2 = diffuseColor.rgb;
          float gLuma = dot(g2, vec3(0.2126, 0.7152, 0.0722));
          float gGreen = clamp((g2.g - max(g2.r, g2.b)) * 2.8, 0.0, 1.0);
          g2 = mix(g2, vec3(gLuma), 0.14 + 0.30 * gGreen);
          g2 *= vec3(1.05, 1.0, 0.96);
          g2 = (g2 - 0.46) * 1.05 + 0.475; // gentle contrast, shadows kept readable

          // slope relighting from DEM normals: imagery shading is baked at one
          // sun position, so this stays subtle — strongest at dawn/golden hour
          vec3 tN = normalize(vTerrNormal);
          float tNdL = clamp(dot(tN, uAtmoSunDir), 0.0, 1.0);
          g2 *= mix(1.0, 0.60 + 0.65 * tNdL, uAtmoRelight);
          g2 += uAtmoGlowColor * (tNdL * tNdL * uAtmoRelight * 0.07);

          // weather: snow settles on flatter ground (more with elevation),
          // rain soaks everything darker
          if (uAtmoSnow > 0.001) {
            float sFlat = smoothstep(0.55, 0.85, tN.y);
            float sNoise = texture2D(detailMap, vDetailPos.xz / 57.0).r;
            float sAmt = uAtmoSnow * sFlat * (0.5 + 0.5 * smoothstep(1250.0, 2000.0, vDetailPos.y))
                       * smoothstep(0.25, 0.6, sNoise * 0.6 + sFlat * 0.4);
            // tree canopy holds snow even on steep ground — frost the green pixels
            sAmt = max(sAmt, uAtmoSnow * gGreen * 0.6);
            vec3 sCol = vec3(0.84, 0.87, 0.93) * (0.78 + 0.22 * tNdL);
            g2 = mix(g2, sCol, clamp(sAmt, 0.0, 0.95));
          }
          g2 *= 1.0 - uAtmoWet * 0.28;
          diffuseColor.rgb = max(g2, 0.0);`
        );
    };
    attachAtmo(mat);
    this.materials.push(mat);
    return new THREE.Mesh(geo, mat);
  }

  setTint(color) {
    this.tint.copy(color);
    for (const m of this.materials) m.color.copy(color);
  }

  // Bilinear ground height at world (x, z). Returns lowest elevation outside the grid.
  heightAt(x, z) {
    const { gridW, gridH, metersPerPx } = this.m;
    const gx = Math.min(Math.max((x + this.halfW) / metersPerPx, 0), gridW - 1.001);
    const gz = Math.min(Math.max((z + this.halfH) / metersPerPx, 0), gridH - 1.001);
    const c = Math.floor(gx);
    const r = Math.floor(gz);
    const fx = gx - c;
    const fz = gz - r;
    const i = r * gridW + c;
    const h00 = this.heights[i];
    const h10 = this.heights[i + 1];
    const h01 = this.heights[i + gridW];
    const h11 = this.heights[i + gridW + 1];
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  // Tree density 0..1 at world (x, z), from the imagery-derived forest mask.
  forestAt(x, z) {
    if (!this.forest) return 0;
    const { gridW, gridH, metersPerPx } = this.m;
    const gx = Math.round((x + this.halfW) / metersPerPx);
    const gz = Math.round((z + this.halfH) / metersPerPx);
    if (gx < 0 || gz < 0 || gx >= gridW || gz >= gridH) return 0;
    return this.forest[gz * gridW + gx] / 255;
  }

  lonLatToWorld(lon, lat) {
    const { elevZoom, tileX0, tileY0, tileSize, metersPerPx } = this.m;
    const n = 2 ** elevZoom;
    const gx = (((lon + 180) / 360) * n - tileX0) * tileSize;
    const rad = (lat * Math.PI) / 180;
    const gz = (((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n - tileY0) * tileSize;
    return new THREE.Vector3(gx * metersPerPx - this.halfW, 0, gz * metersPerPx - this.halfH);
  }

  clampToBounds(pos, margin = 200) {
    pos.x = Math.min(Math.max(pos.x, -this.halfW + margin), this.halfW - margin);
    pos.z = Math.min(Math.max(pos.z, -this.halfH + margin), this.halfH - margin);
  }
}

// Decode the grayscale forest-density PNG into a flat Uint8Array.
async function decodeForestMask(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const mask = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4];
    bmp.close();
    return mask;
  } catch (err) {
    console.error('Failed to decode forest mask:', err);
    return null; // trees just won't spawn
  }
}

// Tiling value-noise texture multiplied onto the imagery up close.
// Values average 0.5 (x4.0/2 in the shader keeps overall brightness).
function makeDetailTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  // tileable multi-octave noise via wrapped lattice
  const lattice = (n) => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = Math.random();
    return (x, y) => {
      const xi = Math.floor(x) % n, yi = Math.floor(y) % n;
      const xf = x - Math.floor(x), yf = y - Math.floor(y);
      const s = (a) => a * a * (3 - 2 * a);
      const v = (ix, iy) => g[((iy % n) + n) % n * n + (((ix % n) + n) % n)];
      return (
        v(xi, yi) * (1 - s(xf)) * (1 - s(yf)) +
        v(xi + 1, yi) * s(xf) * (1 - s(yf)) +
        v(xi, yi + 1) * (1 - s(xf)) * s(yf) +
        v(xi + 1, yi + 1) * s(xf) * s(yf)
      );
    };
  };
  const n1 = lattice(8), n2 = lattice(32), n3 = lattice(64);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * 8, fy = (y / size) * 8;
      let v = 0.55 * n1(fx, fy) + 0.3 * n2(fx * 4, fy * 4) + 0.15 * n3(fx * 8, fy * 8);
      v = 0.5 + (v - 0.5) * 0.55; // soften contrast around the 0.5 mean
      const b = Math.round(v * 255);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}
