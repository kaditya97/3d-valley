// Probes the DEM along each waterfall's flow line to locate the true brink
// and base: prints suggested lon/lat pairs and the resulting drop vs the
// published height. Iterate on the seeds below, then copy into waterfalls.js.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5174/';

// [name, published drop, seed lon/lat near brink, flow direction lon/lat delta (unit-ish)]
const SEEDS = [
  ['Upper Yosemite Fall', 436, -119.59693, 37.75672, 0.0000, -1],
  ['Lower Yosemite Fall', 98, -119.59600, 37.75180, 0.0000, -1],
  ['Bridalveil Fall', 188, -119.64640, 37.71540, -0.25, 1],
  ['Vernal Fall', 96, -119.54400, 37.72760, -0.8, 0.45],
  ['Nevada Fall', 181, -119.53306, 37.71944, -1, 0.3],
  ['Ribbon Fall', 491, -119.65222, 37.73560, -0.05, -1],
];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('#start:not(.disabled)', { state: 'attached', timeout: 120000 });

const out = await page.evaluate((seeds) => {
  const t = window.__app.terrain;
  const results = [];
  for (const [name, published, lon0, lat0, dLon, dLat] of seeds) {
    // normalize flow dir to degrees-ish steps (~5 m)
    const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const mPerDegLat = 110540;
    const len = Math.hypot(dLon * mPerDegLon, dLat * mPerDegLat);
    const stepLon = (dLon * mPerDegLon / len) * 5 / mPerDegLon;
    const stepLat = (dLat * mPerDegLat / len) * 5 / mPerDegLat;
    // profile from -300 m to +600 m along flow
    const prof = [];
    for (let s = -60; s <= 120; s++) {
      const lon = lon0 + stepLon * s;
      const lat = lat0 + stepLat * s;
      const p = t.lonLatToWorld(lon, lat);
      prof.push({ s, lon, lat, h: t.heightAt(p.x, p.z) });
    }
    // brink: point with the steepest drop over the next 60 m of travel
    let brink = 0, best = 0;
    for (let i = 0; i < prof.length - 12; i++) {
      const d = prof[i].h - prof[i + 12].h;
      if (d > best) { best = d; brink = i; }
    }
    // base: first point past the brink where height has fallen ~the published
    // drop, or where the profile flattens
    let base = prof.length - 1;
    for (let i = brink + 2; i < prof.length - 4; i++) {
      const fallen = prof[brink].h - prof[i].h;
      const grad = (prof[i].h - prof[i + 4].h) / 20;
      if (fallen >= published * 0.95 || (fallen > published * 0.5 && grad < 0.35)) { base = i; break; }
    }
    results.push({
      name, published,
      brink: [prof[brink].lon, prof[brink].lat, Math.round(prof[brink].h)],
      base: [prof[base].lon, prof[base].lat, Math.round(prof[base].h)],
      drop: Math.round(prof[brink].h - prof[base].h),
      profile: prof.filter((_, i) => i % 6 === 0).map((p) => Math.round(p.h)),
    });
  }
  return results;
}, SEEDS);

for (const r of out) {
  console.log(`${r.name} (real ${r.published} m): drop ${r.drop} m`);
  console.log(`  top: [${r.brink[0].toFixed(5)}, ${r.brink[1].toFixed(5)}] @${r.brink[2]}m  bottom: [${r.base[0].toFixed(5)}, ${r.base[1].toFixed(5)}] @${r.base[2]}m`);
  console.log(`  profile: ${r.profile.join(' ')}`);
}
await browser.close();
