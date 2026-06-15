// One-time terrain data pipeline for Yosemite Valley.
//
// Downloads:
//   - Elevation: AWS Open Data "terrain-tiles" (Terrarium-encoded PNG, no API key)
//   - Imagery:   Esri World Imagery tiles (z16 over the valley core, z15 outside)
// Produces (in public/data/):
//   - manifest.json          geometry + georeferencing metadata + chunk list
//   - heights.bin            Uint16 heightmap, row-major, 0.1 m precision
//   - forest.png             grayscale tree-density mask, one byte per height sample,
//                            classified from the imagery + slope (drives tree placement)
//   - tex/{cx}_{cy}.jpg      one stitched satellite texture per terrain chunk
//
// Run: npm run fetch-terrain

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// ---------------------------------------------------------------- config

// Bounding box covering Yosemite Valley's main attractions:
// Tunnel View, Bridalveil Fall, El Capitan, Cathedral Rocks, Yosemite Falls,
// Sentinel Rock, Glacier Point, Half Dome, Clouds Rest foothills.
const BBOX = { west: -119.78, east: -119.48, south: 37.66, north: 37.79 };

// The valley core gets full-resolution meshes and z16 imagery; the surrounding
// high country renders at half mesh resolution with z15 imagery.
const CORE = { west: -119.69, east: -119.50, south: 37.695, north: 37.78 };

const ELEV_ZOOM = 14;      // ~7.6 m/sample at this latitude
const IMG_ZOOM_BASE = 15;  // ~3.8 m/px
const IMG_ZOOM_CORE = 16;  // ~1.9 m/px
const CHUNK_TILES = 2;     // terrain chunk = 2x2 elevation tiles = 512x512 samples
const TILE = 256;

const ELEV_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMG_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

const ROOT = path.join(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache/tiles');
const OUT = path.join(ROOT, 'public/data');

const HEIGHT_OFFSET = -1000; // encoded = (h - HEIGHT_OFFSET) / HEIGHT_SCALE
const HEIGHT_SCALE = 0.1;

// ---------------------------------------------------------------- tile math

const EARTH_CIRCUMFERENCE = 40075016.686;

const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2tile = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
};
const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// ---------------------------------------------------------------- download

async function fetchWithRetry(url, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'yosemite-3d-builder' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i === attempts - 1) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function cachedFetch(url, cacheKey) {
  const file = path.join(CACHE, cacheKey);
  try {
    await access(file);
    return readFile(file);
  } catch {
    const buf = await fetchWithRetry(url);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buf);
    return buf;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
        if (++done % 25 === 0 || done === items.length) {
          process.stdout.write(`\r  ${done}/${items.length}`);
        }
      }
    })
  );
  process.stdout.write('\n');
  return results;
}

// ---------------------------------------------------------------- main

const x0 = Math.floor(lon2tile(BBOX.west, ELEV_ZOOM));
let x1 = Math.floor(lon2tile(BBOX.east, ELEV_ZOOM));
const y0 = Math.floor(lat2tile(BBOX.north, ELEV_ZOOM));
let y1 = Math.floor(lat2tile(BBOX.south, ELEV_ZOOM));
// chunks are 2x2 elevation tiles, so keep the tile grid even
if ((x1 - x0 + 1) % CHUNK_TILES) x1++;
if ((y1 - y0 + 1) % CHUNK_TILES) y1++;
const cols = x1 - x0 + 1;
const rows = y1 - y0 + 1;
const gridW = cols * TILE;
const gridH = rows * TILE;

const latCenter = (BBOX.north + BBOX.south) / 2;
const k = Math.cos((latCenter * Math.PI) / 180); // mercator -> true meters
const mercPerPx = EARTH_CIRCUMFERENCE / 2 ** ELEV_ZOOM / TILE;
const metersPerPx = mercPerPx * k;

console.log(`Elevation grid: ${cols}x${rows} tiles (${gridW}x${gridH} samples, ~${metersPerPx.toFixed(1)} m/sample)`);
console.log(`Area: ~${((gridW * metersPerPx) / 1000).toFixed(1)} x ${((gridH * metersPerPx) / 1000).toFixed(1)} km`);

await mkdir(path.join(OUT, 'tex'), { recursive: true });

// --- elevation ---
console.log('Downloading + decoding elevation tiles...');
const heights = new Float32Array(gridW * gridH);
const elevTiles = [];
for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) elevTiles.push({ tx, ty });

await mapLimit(elevTiles, 12, async ({ tx, ty }) => {
  const buf = await cachedFetch(
    ELEV_URL(ELEV_ZOOM, x0 + tx, y0 + ty),
    `elev/${ELEV_ZOOM}/${x0 + tx}/${y0 + ty}.png`
  );
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let py = 0; py < TILE; py++) {
    for (let px = 0; px < TILE; px++) {
      const s = (py * TILE + px) * ch;
      const h = data[s] * 256 + data[s + 1] + data[s + 2] / 256 - 32768;
      heights[(ty * TILE + py) * gridW + (tx * TILE + px)] = h;
    }
  }
});

let min = Infinity, max = -Infinity;
for (const h of heights) { if (h < min) min = h; if (h > max) max = h; }
console.log(`Elevation range: ${min.toFixed(0)} .. ${max.toFixed(0)} m`);

const encoded = new Uint16Array(gridW * gridH);
for (let i = 0; i < heights.length; i++) {
  encoded[i] = Math.max(0, Math.min(65535, Math.round((heights[i] - HEIGHT_OFFSET) / HEIGHT_SCALE)));
}
await writeFile(path.join(OUT, 'heights.bin'), Buffer.from(encoded.buffer));

// --- chunk list (2x2 elevation tiles each; core chunks get z16 imagery + full-res mesh) ---
const ccols = cols / CHUNK_TILES;
const crows = rows / CHUNK_TILES;
const chunkList = [];
for (let cy = 0; cy < crows; cy++) {
  for (let cx = 0; cx < ccols; cx++) {
    const w = tile2lon(x0 + cx * CHUNK_TILES, ELEV_ZOOM);
    const e = tile2lon(x0 + (cx + 1) * CHUNK_TILES, ELEV_ZOOM);
    const n = tile2lat(y0 + cy * CHUNK_TILES, ELEV_ZOOM);
    const s = tile2lat(y0 + (cy + 1) * CHUNK_TILES, ELEV_ZOOM);
    const core = w < CORE.east && e > CORE.west && s < CORE.north && n > CORE.south;
    chunkList.push({ cx, cy, core, step: core ? 1 : 2 });
  }
}
console.log(`Chunks: ${ccols}x${crows} (${chunkList.filter((c) => c.core).length} core at z${IMG_ZOOM_CORE})`);

// --- imagery: one stitched JPEG per chunk ---
console.log('Downloading + stitching imagery (this is the slow part)...');

// forest density mask, one byte per elevation sample, filled per chunk below
const forest = new Uint8Array(gridW * gridH);

await mapLimit(chunkList, 6, async (chunk) => {
  const zoom = chunk.core ? IMG_ZOOM_CORE : IMG_ZOOM_BASE;
  const factor = 2 ** (zoom - ELEV_ZOOM) * CHUNK_TILES; // imagery tiles per chunk side
  const composites = [];
  for (let j = 0; j < factor; j++) {
    for (let i = 0; i < factor; i++) {
      const ix = (x0 + chunk.cx * CHUNK_TILES) * 2 ** (zoom - ELEV_ZOOM) + i;
      const iy = (y0 + chunk.cy * CHUNK_TILES) * 2 ** (zoom - ELEV_ZOOM) + j;
      const buf = await cachedFetch(IMG_URL(zoom, ix, iy), `img/${zoom}/${ix}/${iy}.jpg`);
      composites.push({ input: buf, left: i * TILE, top: j * TILE });
    }
  }
  const size = factor * TILE;
  const img = sharp({ create: { width: size, height: size, channels: 3, background: '#000' } })
    .composite(composites);
  await img.clone().jpeg({ quality: 85 }).toFile(path.join(OUT, 'tex', `${chunk.cx}_${chunk.cy}.jpg`));

  // classify forest from the stitched pixels (see canopy() below):
  // density = average canopy score per height sample.
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  const span = TILE * CHUNK_TILES;          // height samples per chunk side (512)
  const pps = size / span;                  // imagery px per height sample (2 or 4)
  for (let sy = 0; sy < span; sy++) {
    for (let sx = 0; sx < span; sx++) {
      let sum = 0;
      for (let j = 0; j < pps; j++) {
        for (let i = 0; i < pps; i++) {
          const p = ((sy * pps + j) * size + sx * pps + i) * 3;
          sum += canopy(data[p], data[p + 1], data[p + 2]);
        }
      }
      const gx = chunk.cx * span + sx;
      const gy = chunk.cy * span + sy;
      forest[gy * gridW + gx] = Math.round((255 * sum) / (pps * pps));
    }
  }
  chunk.texSize = size;
  delete chunk.core;
});

// Canopy score 0..1 per imagery pixel. Conifer/oak canopy in this Esri imagery
// is olive green across a huge brightness range (deep shadow to full sun), so
// classify by green dominance (g vs r+b) rather than brightness; suppress
// water (blue-heavy), near-black voids, and bright meadow/granite.
function canopy(r, g, b) {
  const ratio = g / (r + b + 1);
  let s = Math.min(1, Math.max(0, (ratio - 0.555) * 14));
  if (b > g * 0.78) s *= Math.max(0, 1 - (b / g - 0.78) * 6);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < 7) s = 0;
  if (lum > 135) s *= Math.max(0, 1 - (lum - 135) / 35);
  return s;
}

// --- forest mask: suppress steep slopes (cliff faces), then save as PNG ---
console.log('Building forest mask...');
for (let r = 0; r < gridH; r++) {
  for (let c = 0; c < gridW; c++) {
    const i = r * gridW + c;
    if (!forest[i]) continue;
    const cl = Math.max(c - 1, 0), cr = Math.min(c + 1, gridW - 1);
    const ru = Math.max(r - 1, 0), rd = Math.min(r + 1, gridH - 1);
    const dx = (heights[r * gridW + cr] - heights[r * gridW + cl]) / ((cr - cl) * metersPerPx);
    const dz = (heights[rd * gridW + c] - heights[ru * gridW + c]) / ((rd - ru) * metersPerPx);
    const slopeDeg = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
    // full density below 38 deg, fading to none at 52 deg
    const f = Math.max(0, Math.min(1, (52 - slopeDeg) / 14));
    forest[i] = Math.round(forest[i] * f);
  }
}
let forested = 0;
for (const v of forest) if (v > 64) forested++;
console.log(`Forest cover (density > 25%): ${((forested / forest.length) * 100).toFixed(1)}% of area`);
await sharp(Buffer.from(forest.buffer), { raw: { width: gridW, height: gridH, channels: 1 } })
  .png({ compressionLevel: 9 })
  .toFile(path.join(OUT, 'forest.png'));

// --- manifest ---
const manifest = {
  bbox: BBOX,
  core: CORE,
  elevZoom: ELEV_ZOOM,
  tileX0: x0,
  tileY0: y0,
  cols,
  rows,
  gridW,
  gridH,
  tileSize: TILE,
  chunkTiles: CHUNK_TILES,
  chunkSpan: TILE * CHUNK_TILES,
  chunks: chunkList,
  metersPerPx,
  mercPerPx,
  latCenter,
  k,
  heightOffset: HEIGHT_OFFSET,
  heightScale: HEIGHT_SCALE,
  heightMin: min,
  heightMax: max,
  attribution: 'Elevation: Mapzen/AWS Terrain Tiles. Imagery: Esri World Imagery.'
};
await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest));
console.log('Done. Output in public/data/');
