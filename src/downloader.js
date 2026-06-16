import { db } from './db.js';

const ELEV_ZOOM = 14;      // ~7.6 m/sample
const IMG_ZOOM = 15;       // ~3.8 m/px
const CHUNK_TILES = 2;     // terrain chunk = 2x2 elevation tiles = 512x512 samples
const TILE = 256;

const ELEV_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMG_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const EARTH_CIRCUMFERENCE = 40075016.686;

const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2tile = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
};
const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load tile image: ${url}`));
    img.src = url;
  });
}

function canopy(r, g, b) {
  const ratio = g / (r + b + 1);
  let s = Math.min(1, Math.max(0, (ratio - 0.555) * 14));
  if (b > g * 0.78) s *= Math.max(0, 1 - (b / g - 0.78) * 6);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < 7) s = 0;
  if (lum > 135) s *= Math.max(0, 1 - (lum - 135) / 35);
  return s;
}

export async function downloadScene(bbox, name, onProgress) {
  onProgress('Calculating grids...', 0);

  const x0 = Math.floor(lon2tile(bbox.west, ELEV_ZOOM));
  let x1 = Math.floor(lon2tile(bbox.east, ELEV_ZOOM));
  const y0 = Math.floor(lat2tile(bbox.north, ELEV_ZOOM));
  let y1 = Math.floor(lat2tile(bbox.south, ELEV_ZOOM));

  // Align grid to chunk boundary (even tile offsets)
  if ((x1 - x0 + 1) % CHUNK_TILES) x1++;
  if ((y1 - y0 + 1) % CHUNK_TILES) y1++;

  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const gridW = cols * TILE;
  const gridH = rows * TILE;

  const latCenter = (bbox.north + bbox.south) / 2;
  const k = Math.cos((latCenter * Math.PI) / 180);
  const mercPerPx = EARTH_CIRCUMFERENCE / 2 ** ELEV_ZOOM / TILE;
  const metersPerPx = mercPerPx * k;

  const HEIGHT_OFFSET = -1000;
  const HEIGHT_SCALE = 0.1;

  // 1. Download elevation tiles
  onProgress('Downloading terrain elevation...', 10);
  const heights = new Float32Array(gridW * gridH);
  const totalElevTiles = cols * rows;
  let downloadedElevTiles = 0;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const tileX = x0 + tx;
      const tileY = y0 + ty;
      const url = ELEV_URL(ELEV_ZOOM, tileX, tileY);
      try {
        const img = await loadImage(url);
        const canvas = document.createElement('canvas');
        canvas.width = TILE;
        canvas.height = TILE;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, TILE, TILE).data;

        for (let py = 0; py < TILE; py++) {
          for (let px = 0; px < TILE; px++) {
            const s = (py * TILE + px) * 4;
            const h = imgData[s] * 256 + imgData[s + 1] + imgData[s + 2] / 256 - 32768;
            heights[(ty * TILE + py) * gridW + (tx * TILE + px)] = h;
          }
        }
      } catch (err) {
        console.warn(`Elevation tile load error: ${url}`, err);
        // Fallback to flat height of 0
      }
      downloadedElevTiles++;
      onProgress(`Downloading terrain elevation (${downloadedElevTiles}/${totalElevTiles})...`, 10 + 30 * (downloadedElevTiles / totalElevTiles));
    }
  }

  let min = Infinity, max = -Infinity;
  for (const h of heights) { if (h < min) min = h; if (h > max) max = h; }

  const encodedHeights = new Uint16Array(gridW * gridH);
  for (let i = 0; i < heights.length; i++) {
    encodedHeights[i] = Math.max(0, Math.min(65535, Math.round((heights[i] - HEIGHT_OFFSET) / HEIGHT_SCALE)));
  }

  // 2. Chunks and imagery textures
  const ccols = cols / CHUNK_TILES;
  const crows = rows / CHUNK_TILES;
  const chunkList = [];
  const textures = {};
  const forest = new Uint8Array(gridW * gridH);

  onProgress('Downloading satellite imagery...', 40);
  const totalChunks = ccols * crows;
  let finishedChunks = 0;

  for (let cy = 0; cy < crows; cy++) {
    for (let cx = 0; cx < ccols; cx++) {
      const w = tile2lon(x0 + cx * CHUNK_TILES, ELEV_ZOOM);
      const e = tile2lon(x0 + (cx + 1) * CHUNK_TILES, ELEV_ZOOM);
      const n = tile2lat(y0 + cy * CHUNK_TILES, ELEV_ZOOM);
      const s = tile2lat(y0 + (cy + 1) * CHUNK_TILES, ELEV_ZOOM);
      chunkList.push({ cx, cy, step: 1 });

      const factor = 2 ** (IMG_ZOOM - ELEV_ZOOM) * CHUNK_TILES; // 2 * 2 = 4 tiles per side
      const size = factor * TILE; // 1024 px

      const chunkCanvas = document.createElement('canvas');
      chunkCanvas.width = size;
      chunkCanvas.height = size;
      const chunkCtx = chunkCanvas.getContext('2d');

      for (let j = 0; j < factor; j++) {
        for (let i = 0; i < factor; i++) {
          const ix = (x0 + cx * CHUNK_TILES) * 2 ** (IMG_ZOOM - ELEV_ZOOM) + i;
          const iy = (y0 + cy * CHUNK_TILES) * 2 ** (IMG_ZOOM - ELEV_ZOOM) + j;
          const imgUrl = IMG_URL(IMG_ZOOM, ix, iy);
          try {
            const tileImg = await loadImage(imgUrl);
            chunkCtx.drawImage(tileImg, i * TILE, j * TILE);
          } catch (err) {
            console.warn(`Imagery tile load error: ${imgUrl}`, err);
          }
        }
      }

      // Classify forest canopy from imagery pixels
      const chunkImgData = chunkCtx.getImageData(0, 0, size, size).data;
      const span = TILE * CHUNK_TILES;          // 512 height samples per chunk
      const pps = size / span;                  // 1024 / 512 = 2 pixels per height sample
      for (let sy = 0; sy < span; sy++) {
        for (let sx = 0; sx < span; sx++) {
          let sum = 0;
          for (let j = 0; j < pps; j++) {
            for (let i = 0; i < pps; i++) {
              const p = ((sy * pps + j) * size + sx * pps + i) * 4;
              sum += canopy(chunkImgData[p], chunkImgData[p + 1], chunkImgData[p + 2]);
            }
          }
          const gx = cx * span + sx;
          const gy = cy * span + sy;
          forest[gy * gridW + gx] = Math.round((255 * sum) / (pps * pps));
        }
      }

      // Export stitched texture to Blob
      const textureBlob = await new Promise((res) => chunkCanvas.toBlob(res, 'image/jpeg', 0.85));
      textures[`${cx}_${cy}`] = textureBlob;

      finishedChunks++;
      onProgress(`Downloading satellite imagery (${finishedChunks}/${totalChunks})...`, 40 + 35 * (finishedChunks / totalChunks));
    }
  }

  // 3. Slope shading and forest mask creation
  onProgress('Generating forest density mask...', 75);
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

  const forestCanvas = document.createElement('canvas');
  forestCanvas.width = gridW;
  forestCanvas.height = gridH;
  const forestCtx = forestCanvas.getContext('2d');
  const forestImgData = forestCtx.createImageData(gridW, gridH);
  for (let i = 0; i < forest.length; i++) {
    const val = forest[i];
    const idx = i * 4;
    forestImgData.data[idx] = val;
    forestImgData.data[idx + 1] = val;
    forestImgData.data[idx + 2] = val;
    forestImgData.data[idx + 3] = 255;
  }
  forestCtx.putImageData(forestImgData, 0, 0);
  const forestBlob = await new Promise((res) => forestCanvas.toBlob(res, 'image/png'));

  // 4. Download OpenStreetMap features (Overpass API)
  onProgress('Fetching OpenStreetMap features...', 80);
  let osmData = { roads: [], buildings: [] };

  const query = `
    [out:json][timeout:45];
    (
      way["highway"~"^(primary|secondary|tertiary|unclassified|residential)$"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      way["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
    );
    out geom tags;
  `;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const osmJson = await res.json();
      
      const r6 = (v) => Math.round(v * 1e6) / 1e6;
      const rawRoads = [];
      const buildings = [];

      for (const el of osmJson.elements) {
        if (el.type !== 'way' || !el.geometry) continue;
        const tags = el.tags ?? {};
        const pts = el.geometry.map((g) => [r6(g.lon), r6(g.lat)]);
        if (tags.building) {
          if (pts.length < 4) continue;
          const levels = Number(tags['building:levels']) || 0;
          buildings.push({ pts, levels, kind: tags.building });
        } else if (tags.highway) {
          if (tags.tunnel || tags.covered === 'yes') continue;
          if (pts.length < 2) continue;
          rawRoads.push({ name: tags.name || tags.ref || '', type: tags.highway, pts });
        }
      }

      // Chain ways
      const close = (a, b) => Math.abs(a[0] - b[0]) < 2e-5 && Math.abs(a[1] - b[1]) < 2e-5;
      const groups = new Map();
      for (const r of rawRoads) {
        const key = `${r.name}|${r.type}`;
        (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
      }
      const roads = [];
      for (const [key, ways] of groups) {
        const [roadName, roadType] = key.split('|');
        const pool = ways.map((w) => w.pts.slice());
        while (pool.length) {
          let chain = pool.pop();
          let grew = true;
          while (grew) {
            grew = false;
            for (let i = 0; i < pool.length; i++) {
              const c = pool[i];
              if (close(chain[chain.length - 1], c[0])) chain = chain.concat(c.slice(1));
              else if (close(chain[chain.length - 1], c[c.length - 1])) chain = chain.concat(c.slice(0, -1).reverse());
              else if (close(chain[0], c[c.length - 1])) chain = c.slice(0, -1).concat(chain);
              else if (close(chain[0], c[0])) chain = c.slice(1).reverse().concat(chain);
              else continue;
              pool.splice(i, 1);
              grew = true;
              break;
            }
          }
          roads.push({ name: roadName, type: roadType, pts: chain });
        }
      }
      osmData = { roads, buildings };
      break; // Success!
    } catch (err) {
      console.warn(`Overpass endpoint failed: ${endpoint}`, err);
    }
  }

  // 5. Save Scene
  onProgress('Saving scene to local database...', 95);
  const sceneId = 'scene_' + Date.now();
  const manifest = {
    bbox,
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
    attribution: 'Elevation: AWS Terrain Tiles. Imagery: Esri. Human layers: OpenStreetMap.'
  };

  const scene = {
    id: sceneId,
    name,
    bbox,
    manifest,
    heights: encodedHeights.buffer,
    forest: forestBlob,
    osm: osmData,
    textures,
    createdAt: Date.now()
  };

  await db.saveScene(scene);
  onProgress('Scene successfully generated!', 100);
  return sceneId;
}
