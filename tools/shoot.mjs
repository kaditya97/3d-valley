// Quick visual-iteration helper: load the app headless, jump to viewpoints,
// optionally switch lighting preset, screenshot. Also prints waterfall drop
// sanity checks (DEM-sampled drop vs published heights).
// Usage: node tools/shoot.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5174/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('#start:not(.disabled)', { state: 'attached', timeout: 120000 });
await page.evaluate(() => document.getElementById('overlay').classList.add('hidden'));

// waterfall drop check against published heights
const drops = await page.evaluate(() => {
  const known = { 'Upper Yosemite Fall': 436, 'Lower Yosemite Fall': 98, 'Bridalveil Fall': 188, 'Vernal Fall': 96, 'Nevada Fall': 181, 'Ribbon Fall': 491 };
  return window.__app.falls.falls.map((f) => ({
    name: f.def.name,
    dem: Math.round(f.drop),
    published: known[f.def.name],
    topElev: Math.round(f.top.y),
  }));
});
console.log('Waterfall drops (DEM vs published):');
for (const d of drops) console.log(`  ${d.name}: ${d.dem} m (real ${d.published} m), brink at ${d.topElev} m`);

const forestStats = await page.evaluate(() => window.__app.forest.stats);
console.log('Forest:', JSON.stringify(forestStats));

// [name, camLon, camLat, camAGL, lookLon, lookLat, lookElev, preset, weather]
const views = [
  ['tunnel-view', -119.67738, 37.71562, 120, -119.5332, 37.746, 2693, null, null],
  ['yosemite-falls', -119.5965, 37.7430, 180, -119.5969, 37.7556, 1900, null, null],
  ['bridalveil', -119.6515, 37.7215, 60, -119.6466, 37.7155, 1300, null, null],
  ['vernal-nevada', -119.5475, 37.7300, 300, -119.5345, 37.7243, 1800, null, null],
  ['forest-walk', -119.6214, 37.7223, 2, -119.6377, 37.7339, 2200, null, null],
  ['forest-close', -119.6175, 37.7212, 3, -119.6260, 37.7228, 1215, null, null],
  ['golden-tunnel', -119.67738, 37.71562, 120, -119.5332, 37.746, 2693, 2, null],
  ['night-stars', -119.67738, 37.71562, 200, -119.5332, 37.746, 4500, 4, null],
  // v2: atmosphere, weather, village, wildlife
  ['dawn-valley-fog', -119.67738, 37.71562, 160, -119.5332, 37.746, 2400, 0, null],
  ['clouds-el-cap', -119.6214, 37.7223, 60, -119.6377, 37.7339, 2200, 1, 1],
  ['storm-valley', -119.67738, 37.71562, 140, -119.5332, 37.746, 2400, 1, 2],
  ['snow-valley', -119.67738, 37.71562, 140, -119.5332, 37.746, 2400, 1, 3],
  ['snow-meadow', -119.6214, 37.7223, 3, -119.6377, 37.7339, 2200, 1, 3],
  ['village-day', -119.5930, 37.7480, 90, -119.5905, 37.7448, 1210, 1, 0],
  ['village-night', -119.5930, 37.7480, 90, -119.5905, 37.7448, 1210, 4, 0],
  ['deer-meadow', -119.6335, 37.7232, 2, -119.6318, 37.7232, 1190, 2, 0],
  ['roads-aerial', -119.6100, 37.7330, 700, -119.5900, 37.7440, 1200, 1, 0],
];

for (const [name, lon, lat, h, tlon, tlat, telev, preset, wx] of views) {
  await page.evaluate(async ([lon, lat, h, tlon, tlat, telev, preset, wx]) => {
    const { camera, controls, terrain, lighting, forest, weather } = window.__app;
    const p = terrain.lonLatToWorld(lon, lat);
    p.y = terrain.heightAt(p.x, p.z) + h;
    camera.position.copy(p);
    const t = terrain.lonLatToWorld(tlon, tlat);
    t.y = telev;
    controls.lookAt(t);
    if (preset !== null) { lighting.set(preset); lighting.t = 0.999; }
    if (wx !== null && weather) {
      weather.set(wx);
      weather.t = 0.999;
      weather._snowAccum = wx === 3 ? 0.96 : 0; // jump accumulation for stills
    }
    forest.prewarm(camera);
  }, [lon, lat, h, tlon, tlat, telev, preset, wx]);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `shots/${name}.png` });
  console.log(`shot: ${name}`);
}

const info = await page.evaluate(() => {
  const { renderer, village, wildlife } = window.__app;
  return {
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    cars: village?.cars?.length ?? 0,
    deer: wildlife?.deer?.herd?.length ?? 0,
    birds: wildlife?.birds?.flock?.length ?? 0,
  };
});
console.log('Render info:', JSON.stringify(info));

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.');
await browser.close();
