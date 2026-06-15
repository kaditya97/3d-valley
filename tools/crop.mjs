// Crop the stitched chunk imagery around a lon/lat, for visually locating
// features (waterfalls show as white streaks).
// Usage: node tools/crop.mjs <lon> <lat> [halfSizePx] [out.png]
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const [lon, lat, half = 200, out = '/tmp/crop.png'] = [
  Number(process.argv[2]), Number(process.argv[3]),
  process.argv[4] ? Number(process.argv[4]) : 200,
  process.argv[5],
];

const m = JSON.parse(await readFile('public/data/manifest.json', 'utf8'));
const n = 2 ** m.elevZoom;
const gx = (((lon + 180) / 360) * n - m.tileX0) * m.tileSize;
const rad = (lat * Math.PI) / 180;
const gz = (((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n - m.tileY0) * m.tileSize;
const cx = Math.floor(gx / m.chunkSpan);
const cy = Math.floor(gz / m.chunkSpan);
const chunk = m.chunks.find((c) => c.cx === cx && c.cy === cy);
const scale = chunk.texSize / m.chunkSpan; // imagery px per height sample
const px = Math.round((gx - cx * m.chunkSpan) * scale);
const py = Math.round((gz - cy * m.chunkSpan) * scale);
console.log(`chunk ${cx}_${cy} (${chunk.texSize}px), center px ${px},${py}, ${(m.metersPerPx / scale).toFixed(1)} m/px`);
const left = Math.max(0, px - half), top = Math.max(0, py - half);
const img = sharp(`public/data/tex/${cx}_${cy}.jpg`).extract({
  left,
  top,
  width: Math.min(half * 2, chunk.texSize - left),
  height: Math.min(half * 2, chunk.texSize - top),
});
const cw = Math.min(half * 2, chunk.texSize - left);
const chh = Math.min(half * 2, chunk.texSize - top);
// crosshair at the queried point
const ch = Buffer.from(
  `<svg width="${cw}" height="${chh}">
     <line x1="${px - left - 14}" y1="${py - top}" x2="${px - left + 14}" y2="${py - top}" stroke="red" stroke-width="2"/>
     <line x1="${px - left}" y1="${py - top - 14}" x2="${px - left}" y2="${py - top + 14}" stroke="red" stroke-width="2"/>
   </svg>`
);
await img.composite([{ input: ch, left: 0, top: 0 }]).png().toFile(out ?? '/tmp/crop.png');
console.log(`wrote ${out ?? '/tmp/crop.png'}`);
