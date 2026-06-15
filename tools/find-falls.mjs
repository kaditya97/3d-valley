// Locates waterfall streaks automatically: very bright (white-water) pixels
// on steep slopes near a seed coordinate, clustered; prints the streak's top
// and bottom lon/lat + elevations for waterfalls.js.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const m = JSON.parse(await readFile('public/data/manifest.json', 'utf8'));
const enc = new Uint16Array((await readFile('public/data/heights.bin')).buffer);
const H = (gx, gz) => enc[Math.round(gz) * m.gridW + Math.round(gx)] * m.heightScale + m.heightOffset;

// name, seed lon/lat, search radius m, [min elev, max elev] (excludes snowfields)
const SEEDS = [
  ['Upper Yosemite Fall', -119.59693, 37.75672, 300, [1490, 2030]],
  ['Lower Yosemite Fall', -119.59600, 37.75120, 200, [1200, 1420]],
  ['Bridalveil Fall', -119.64660, 37.71640, 250, [1240, 1540]],
  ['Vernal Fall', -119.54417, 37.72778, 250, [1380, 1600]],
  ['Nevada Fall', -119.53250, 37.71861, 350, [1560, 1880]],
  ['Ribbon Fall', -119.65194, 37.73700, 500, [1600, 2230]],
];

const lonLatToGrid = (lon, lat) => {
  const n = 2 ** m.elevZoom;
  const gx = (((lon + 180) / 360) * n - m.tileX0) * m.tileSize;
  const rad = (lat * Math.PI) / 180;
  const gz = (((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n - m.tileY0) * m.tileSize;
  return [gx, gz];
};
const gridToLonLat = (gx, gz) => {
  const n = 2 ** m.elevZoom;
  const lon = ((gx / m.tileSize + m.tileX0) / n) * 360 - 180;
  const mercY = 1 - (2 * (gz / m.tileSize + m.tileY0)) / n;
  const lat = (Math.atan(Math.sinh(Math.PI * mercY)) * 180) / Math.PI;
  return [lon, lat];
};

// cache decoded chunks
const chunkCache = new Map();
async function chunkPixels(cx, cy) {
  const key = `${cx}_${cy}`;
  if (!chunkCache.has(key)) {
    const { data, info } = await sharp(`public/data/tex/${key}.jpg`).raw().toBuffer({ resolveWithObject: true });
    chunkCache.set(key, { data, size: info.width });
  }
  return chunkCache.get(key);
}

for (const [name, lon, lat, radius, [minElev, maxElev]] of SEEDS) {
  const [sgx, sgz] = lonLatToGrid(lon, lat);
  const rg = radius / m.metersPerPx; // radius in grid samples
  const hits = [];
  for (let gz = Math.floor(sgz - rg); gz <= sgz + rg; gz++) {
    for (let gx = Math.floor(sgx - rg); gx <= sgx + rg; gx++) {
      if (gx < 1 || gz < 1 || gx >= m.gridW - 1 || gz >= m.gridH - 1) continue;
      // slope from DEM
      const dx = (H(gx + 1, gz) - H(gx - 1, gz)) / (2 * m.metersPerPx);
      const dz = (H(gx, gz + 1) - H(gx, gz - 1)) / (2 * m.metersPerPx);
      const slope = Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
      if (slope < 22) continue;
      const elev = H(gx, gz);
      if (elev < minElev || elev > maxElev) continue;
      // imagery pixel at this sample (average the block)
      const cx = Math.floor(gx / m.chunkSpan), cy = Math.floor(gz / m.chunkSpan);
      const chunk = m.chunks.find((c) => c.cx === cx && c.cy === cy);
      if (!chunk) continue;
      const { data, size } = await chunkPixels(cx, cy);
      const pps = size / m.chunkSpan;
      const px = Math.floor((gx - cx * m.chunkSpan) * pps);
      const py = Math.floor((gz - cy * m.chunkSpan) * pps);
      let r = 0, g = 0, b = 0, c = 0;
      for (let j = 0; j < pps; j++) for (let i = 0; i < pps; i++) {
        const p = ((py + j) * size + px + i) * 3;
        r += data[p]; g += data[p + 1]; b += data[p + 2]; c++;
      }
      r /= c; g /= c; b /= c;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const grey = Math.max(Math.abs(r - g), Math.abs(g - b));
      if (lum > 178 && grey < 34 && b > r - 8) hits.push({ gx, gz, h: elev, lum });
    }
  }
  if (!hits.length) { console.log(`${name}: NO white-water pixels found near seed`); continue; }
  // largest cluster (union-find by proximity < ~45 m) to drop stray bright rock
  const R2 = (45 / m.metersPerPx) ** 2;
  const parent = hits.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const d2 = (hits[i].gx - hits[j].gx) ** 2 + (hits[i].gz - hits[j].gz) ** 2;
      if (d2 < R2) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  hits.forEach((h, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(h);
  });
  const cluster = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  cluster.sort((a, b) => b.h - a.h);
  const top = cluster[0], bottom = cluster[cluster.length - 1];
  const [tlon, tlat] = gridToLonLat(top.gx, top.gz);
  const [blon, blat] = gridToLonLat(bottom.gx, bottom.gz);
  console.log(`${name}: ${hits.length} px, drop ${Math.round(top.h - bottom.h)} m`);
  console.log(`  top: [${tlon.toFixed(5)}, ${tlat.toFixed(5)}] @${Math.round(top.h)}m`);
  console.log(`  bottom: [${blon.toFixed(5)}, ${blat.toFixed(5)}] @${Math.round(bottom.h)}m`);
}
