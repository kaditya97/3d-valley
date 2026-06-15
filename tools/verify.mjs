// Headless check: load the app, exercise every control, screenshot key views.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5174/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
// Small viewport: headless software rendering is slow, and the interaction
// tests need the animation loop to actually tick a few times per second.
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const results = [];
const check = (name, ok, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

// New headless Chrome only issues BeginFrames on demand, so the animation
// loop barely ticks on its own; throwaway screenshots pump frames through it.
const pump = async (ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) await page.screenshot({ caret: 'initial' });
};

const state = () =>
  page.evaluate(() => {
    const { camera, controls } = window.__app;
    return {
      pos: camera.position.toArray(),
      yaw: controls.yaw,
      pitch: controls.pitch,
      mode: controls.mode,
      flySpeed: controls.flySpeed,
      playing: document.body.classList.contains('playing'),
      overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
    };
  });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('#loading.hidden, #start:not(.disabled)', { state: 'attached', timeout: 60000 });
await page.waitForTimeout(500);

// Lighten the raster load so software rendering ticks fast enough for the
// interaction tests (restored before the screenshot section).
await page.evaluate(() => {
  const { forest, village, weather } = window.__app;
  forest.group.visible = false;
  village.group.visible = false;
  weather.clouds.visible = false; // per-pixel FBM is heavy under SwiftShader
});

// 1. Click to start (headless usually has no pointer lock -> drag fallback engages)
await page.mouse.click(400, 225);
await page.waitForTimeout(400);
let s = await state();
check('click starts exploring', s.playing && s.overlayHidden);

// 2. Drag look changes view direction
const yaw0 = s.yaw;
await page.mouse.move(400, 225);
await page.mouse.down();
await page.mouse.move(560, 225, { steps: 10 });
await page.mouse.up();
s = await state();
check('drag to look', Math.abs(s.yaw - yaw0) > 0.05, `yaw ${yaw0.toFixed(2)} -> ${s.yaw.toFixed(2)}`);

// 3. W moves forward
let before = s.pos;
await page.keyboard.down('KeyW');
await pump(3000);
await page.keyboard.up('KeyW');
s = await state();
const dist = Math.hypot(s.pos[0] - before[0], s.pos[1] - before[1], s.pos[2] - before[2]);
check('W moves camera', dist > 20, `${dist.toFixed(0)} m`);

// 4. Space gains altitude
before = s.pos;
await page.keyboard.down('Space');
await pump(1800);
await page.keyboard.up('Space');
s = await state();
check('Space flies up', s.pos[1] - before[1] > 10, `+${(s.pos[1] - before[1]).toFixed(0)} m`);

// 5. Scroll changes fly speed (dispatched as a DOM event: CDP wheel input
// doesn't reach the page reliably in the slow headless shell)
const speed0 = s.flySpeed;
await page.evaluate(() =>
  document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
);
s = await state();
check('scroll changes speed', s.flySpeed !== speed0, `${speed0.toFixed(0)} -> ${s.flySpeed.toFixed(0)} m/s`);

// 6. F toggles walk mode and drops to eye height
await page.keyboard.press('KeyF');
// pump frames until the exponential height smoothing settles at eye height
for (let i = 0; i < 20; i++) {
  await page.screenshot({ caret: 'initial' });
  const agl = await page.evaluate(() => {
    const { camera, terrain } = window.__app;
    return camera.position.y - terrain.heightAt(camera.position.x, camera.position.z);
  });
  if (Math.abs(agl - 1.7) < 0.4) break;
}
s = await state();
const agl = await page.evaluate(() => {
  const { camera, terrain } = window.__app;
  return camera.position.y - terrain.heightAt(camera.position.x, camera.position.z);
});
check('F switches to walk at eye height', s.mode === 'walk' && Math.abs(agl - 1.7) < 0.5, `${agl.toFixed(1)} m above ground`);

// 7. Walking moves along the ground
before = s.pos;
await page.keyboard.down('ArrowUp'); // arrow keys as WASD alternates
await pump(4000);
await page.keyboard.up('ArrowUp');
s = await state();
const walked = Math.hypot(s.pos[0] - before[0], s.pos[2] - before[2]);
check('arrow keys walk', walked > 0.5, `${walked.toFixed(1)} m`);

// 8. F back to fly, Esc pauses, click resumes
await page.keyboard.press('KeyF');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
s = await state();
check('Esc opens menu', !s.playing && !s.overlayHidden);
await page.mouse.click(400, 225);
await page.waitForTimeout(300);
s = await state();
check('click resumes', s.playing && s.mode === 'fly');

// --- screenshots of known viewpoints ---
await page.evaluate(() => {
  document.getElementById('overlay').classList.add('hidden');
  const { forest, village, weather } = window.__app;
  forest.group.visible = true;
  village.group.visible = true;
  weather.clouds.visible = true;
});
// [lon, lat, height above ground, look-at lon, lat, look-at elevation]
const views = {
  'tunnel-view': [-119.67738, 37.71562, 120, -119.5332, 37.746, 2693],
  'el-cap-meadow': [-119.6214, 37.7223, 1.7, -119.6377, 37.7339, 2000],
  'half-dome-aerial': [-119.585, 37.737, 900, -119.5332, 37.746, 2600],
  'glacier-point': [-119.5734, 37.7281, 30, -119.5965, 37.7544, 1400],
};
for (const [name, [lon, lat, h, tlon, tlat, telev]] of Object.entries(views)) {
  await page.evaluate(([lon, lat, h, tlon, tlat, telev]) => {
    const { camera, controls, terrain } = window.__app;
    const p = terrain.lonLatToWorld(lon, lat);
    p.y = terrain.heightAt(p.x, p.z) + h;
    camera.position.copy(p);
    const t = terrain.lonLatToWorld(tlon, tlat);
    t.y = telev;
    controls.lookAt(t);
  }, [lon, lat, h, tlon, tlat, telev]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `shots/${name}.png` });
}

console.log(results.join('\n'));
console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join('\n')}` : '\nNo console errors.');
await browser.close();
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
