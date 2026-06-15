// Fetch the valley's human layer from OpenStreetMap (Overpass API) and bake
// it to public/data/osm.json: road centerlines (for draped asphalt ribbons and
// car paths) and building footprints (Yosemite Village, Curry Village, the
// Ahwahnee...). Tunnel segments are dropped — the Wawona Road tunnel must not
// drape over the mountain above Tunnel View.
//
// Ways that belong to the same named road are chained into long polylines so
// cars can drive the full length of Northside/Southside Drive.
import { writeFileSync, mkdirSync } from 'node:fs';

const ROAD_BBOX = [37.66, -119.78, 37.79, -119.48];   // s, w, n, e — full map
const BLDG_BBOX = [37.70, -119.68, 37.77, -119.52];   // valley core only

const query = `
[out:json][timeout:120];
(
  way["highway"~"^(primary|secondary|tertiary|unclassified|residential)$"](${ROAD_BBOX.join(',')});
  way["building"](${BLDG_BBOX.join(',')});
);
out geom tags;
`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

let data = null;
for (const url of ENDPOINTS) {
  try {
    console.log(`querying ${url} ...`);
    const res = await fetch(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'yosemite-3d/0.2 (open-source Three.js demo; github.com/shloked)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    break;
  } catch (err) {
    console.warn(`  failed: ${err.message}`);
  }
}
if (!data) {
  console.error('all Overpass endpoints failed');
  process.exit(1);
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const rawRoads = [];
const buildings = [];

for (const el of data.elements) {
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

// Chain ways that share endpoints (same name+type) into long polylines.
const close = (a, b) => Math.abs(a[0] - b[0]) < 2e-5 && Math.abs(a[1] - b[1]) < 2e-5;
const groups = new Map();
for (const r of rawRoads) {
  const key = `${r.name}|${r.type}`;
  (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
}
const roads = [];
for (const [key, ways] of groups) {
  const [name, type] = key.split('|');
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
    roads.push({ name, type, pts: chain });
  }
}

const km = roads.reduce((s, r) => {
  for (let i = 1; i < r.pts.length; i++) {
    const dx = (r.pts[i][0] - r.pts[i - 1][0]) * 88e3; // ~m per deg lon at 37.7°
    const dy = (r.pts[i][1] - r.pts[i - 1][1]) * 111e3;
    s += Math.hypot(dx, dy) / 1000;
  }
  return s;
}, 0);

mkdirSync('public/data', { recursive: true });
const out = { roads, buildings };
writeFileSync('public/data/osm.json', JSON.stringify(out));
console.log(`roads: ${roads.length} chains (${km.toFixed(0)} km), buildings: ${buildings.length}`);
console.log(`wrote public/data/osm.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
