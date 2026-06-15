// Rebuilds public/data/forest.png from the already-stitched chunk imagery.
// Lets the canopy classifier be tuned without re-running the full pipeline.
// Run: node tools/build-mask.mjs

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public/data');

const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
const { gridW, gridH, chunkSpan, metersPerPx, heightOffset, heightScale } = manifest;

const enc = new Uint16Array((await readFile(path.join(OUT, 'heights.bin'))).buffer);
const heights = new Float32Array(enc.length);
for (let i = 0; i < enc.length; i++) heights[i] = enc[i] * heightScale + heightOffset;

// Canopy score 0..1 per imagery pixel. Conifer/oak canopy in this Esri imagery
// is olive green across a huge brightness range (deep shadow to full sun), so
// classify by green dominance (g vs r+b) rather than brightness; suppress
// water (blue-heavy) and near-black voids.
function canopy(r, g, b) {
  const ratio = g / (r + b + 1);
  let s = Math.min(1, Math.max(0, (ratio - 0.555) * 14));
  if (b > g * 0.78) s *= Math.max(0, 1 - (b / g - 0.78) * 6); // water/blue shadow
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < 7) s = 0;                                          // void/black
  if (lum > 135) s *= Math.max(0, 1 - (lum - 135) / 35);       // bright meadow/granite
  return s;
}

const forest = new Uint8Array(gridW * gridH);

for (const chunk of manifest.chunks) {
  const file = path.join(OUT, 'tex', `${chunk.cx}_${chunk.cy}.jpg`);
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const size = info.width;
  const pps = size / chunkSpan;
  for (let sy = 0; sy < chunkSpan; sy++) {
    for (let sx = 0; sx < chunkSpan; sx++) {
      let sum = 0;
      for (let j = 0; j < pps; j++) {
        for (let i = 0; i < pps; i++) {
          const p = ((sy * pps + j) * size + sx * pps + i) * 3;
          sum += canopy(data[p], data[p + 1], data[p + 2]);
        }
      }
      forest[(chunk.cy * chunkSpan + sy) * gridW + chunk.cx * chunkSpan + sx] =
        Math.round((255 * sum) / (pps * pps));
    }
  }
  process.stdout.write(`\r  chunk ${chunk.cx}_${chunk.cy}  `);
}
process.stdout.write('\n');

// suppress steep slopes (cliff faces): full density below 38 deg, none past 52
for (let r = 0; r < gridH; r++) {
  for (let c = 0; c < gridW; c++) {
    const i = r * gridW + c;
    if (!forest[i]) continue;
    const cl = Math.max(c - 1, 0), cr = Math.min(c + 1, gridW - 1);
    const ru = Math.max(r - 1, 0), rd = Math.min(r + 1, gridH - 1);
    const dx = (heights[r * gridW + cr] - heights[r * gridW + cl]) / ((cr - cl) * metersPerPx);
    const dz = (heights[rd * gridW + c] - heights[ru * gridW + c]) / ((rd - ru) * metersPerPx);
    const slopeDeg = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
    forest[i] = Math.round(forest[i] * Math.max(0, Math.min(1, (52 - slopeDeg) / 14)));
  }
}

let forested = 0;
for (const v of forest) if (v > 64) forested++;
console.log(`Forest cover (density > 25%): ${((forested / forest.length) * 100).toFixed(1)}% of area`);
await sharp(Buffer.from(forest.buffer), { raw: { width: gridW, height: gridH, channels: 1 } })
  .png({ compressionLevel: 9 })
  .toFile(path.join(OUT, 'forest.png'));
console.log('Wrote forest.png');
