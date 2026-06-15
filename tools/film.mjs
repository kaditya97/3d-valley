// Cinematic film rig. Drives the world with a fixed 1/30 s timestep (the RAF
// loop idles behind window.__filming), captures every canvas frame, renders a
// procedural soundtrack with OfflineAudioContext — no recorded audio, like
// everything else here — and cuts the final film with ffmpeg crossfades.
//
//   node tools/film.mjs [url] --preview   # first/mid/last still per shot
//   node tools/film.mjs [url]             # full render -> yosemite-v2.mp4
//
// Runs a headed (GPU) browser: SwiftShader would take an hour per minute.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const url = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5174/';
const preview = process.argv.includes('--preview');

const FPS = 30;
const FADE = 0.6; // crossfade between shots, seconds
const W = 1920, H = 1080;
const OUT = 'yosemite-v2.mp4';
const WORK = '/tmp/yosemite-film';

// One shot: a slow camera move between two lon/lat/(m above ground) points,
// eyes on a lon/lat/elevation target, under one lighting preset + weather.
//   warm  seconds of simulation before frame 1 (clouds drift in, snow settles)
//   snow0 initial snow accumulation (builds on camera during the shot)
const SHOTS = [
  { name: 'dawn-tunnel', dur: 10, preset: 0, wx: 0, warm: 4, ease: 'inout',
    cam: [[-119.6800, 37.7140, 260], [-119.6757, 37.7159, 150]],
    look: [[-119.5332, 37.7460, 2500], [-119.5332, 37.7460, 2500]] },
  { name: 'elcap-clouds', dur: 10, preset: 1, wx: 1, warm: 6, ease: 'inout',
    cam: [[-119.6214, 37.7223, 55], [-119.6242, 37.7252, 330]],
    look: [[-119.6377, 37.7339, 2000], [-119.6377, 37.7339, 2350]] },
  { name: 'yosemite-falls', dur: 9, preset: 1, wx: 0, warm: 6, ease: 'inout',
    cam: [[-119.5963, 37.7402, 250], [-119.5966, 37.7448, 160]],
    look: [[-119.5969, 37.7556, 1880], [-119.5969, 37.7556, 1880]] },
  { name: 'storm', dur: 8, preset: 1, wx: 2, warm: 6, ease: 'linear',
    cam: [[-119.6690, 37.7168, 135], [-119.6655, 37.7183, 115]],
    look: [[-119.5332, 37.7460, 2300], [-119.5332, 37.7460, 2300]] },
  { name: 'snow-valley', dur: 9, preset: 1, wx: 3, snow0: 0.5, warm: 1.5, ease: 'linear',
    cam: [[-119.6150, 37.7260, 260], [-119.6215, 37.7259, 235]],
    look: [[-119.6440, 37.7250, 1600], [-119.6440, 37.7250, 1600]] },
  { name: 'golden-halfdome', dur: 9, preset: 2, wx: 0, warm: 6, ease: 'linear',
    cam: [[-119.5950, 37.7330, 760], [-119.5878, 37.7362, 820]],
    look: [[-119.5332, 37.7460, 2400], [-119.5332, 37.7460, 2400]] },
  { name: 'deer-meadow', dur: 7, preset: 2, wx: 0, warm: 3, ease: 'linear', special: 'deer' },
  { name: 'village-dusk', dur: 9, preset: 3, wx: 0, warm: 4, ease: 'inout',
    cam: [[-119.5930, 37.7480, 95], [-119.5912, 37.7457, 45]],
    look: [[-119.5897, 37.7446, 1209], [-119.5897, 37.7446, 1209]] },
  { name: 'night-stars', dur: 9, preset: 4, wx: 0, warm: 4, ease: 'inout',
    cam: [[-119.6757, 37.7158, 170], [-119.6757, 37.7158, 230]],
    look: [[-119.5332, 37.7460, 2400], [-119.5600, 37.7480, 14000]] },
];

// Where each shot lands on the final (crossfaded) timeline.
const starts = [];
{
  let t = 0;
  for (const s of SHOTS) { starts.push(t); t += s.dur - FADE; }
}
const TOTAL = starts[SHOTS.length - 1] + SHOTS[SHOTS.length - 1].dur;
console.log(`${SHOTS.length} shots, ${TOTAL.toFixed(1)} s final cut`);

const ease = (t, kind) => (kind === 'inout' ? t * t * (3 - 2 * t) : t);

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(`${WORK}/preview`, { recursive: true });

const browser = await chromium.launch({ headless: false, args: ['--window-position=80,60', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('#start:not(.disabled)', { state: 'attached', timeout: 120000 });
await page.evaluate(() => {
  window.__filming = true;
  document.getElementById('overlay').classList.add('hidden');
});

async function setupShot(shot) {
  await page.evaluate(([shot, FPS]) => {
    const { camera, controls, terrain, lighting, weather, forest, wildlife, tick } = window.__app;

    if (shot.special === 'deer') {
      lighting.set(shot.preset); lighting.t = 0.999;
      weather.set(shot.wx); weather.t = 0.999;
      weather._snowAccum = 0;
      const m = terrain.lonLatToWorld(-119.6318, 37.7232); // settle the herds first
      camera.position.set(m.x, terrain.heightAt(m.x, m.z) + 30, m.z);
      for (let i = 0; i < shot.warm * FPS; i++) tick(1 / FPS);
      // The forest mask is zeroed under buildings, so "open ground" alone
      // walks the camera into a wall — exclude real OSM footprints outright,
      // and approach from the south so the look runs toward the north wall
      // (El Cap, the falls, Royal Arches — depending on the meadow).
      return fetch('/data/osm.json').then((r) => r.json()).then((osm) => {
        const bldg = osm.buildings.map((b) => {
          let lon = 0, lat = 0;
          for (const p of b.pts) { lon += p[0]; lat += p[1]; }
          const w = terrain.lonLatToWorld(lon / b.pts.length, lat / b.pts.length);
          return [w.x, w.z];
        });
        const nearBldg = (x, z, r) => bldg.some((p) => (p[0] - x) ** 2 + (p[1] - z) ** 2 < r * r);
        const open = (x, z) => 1 - Math.min(1, terrain.forestAt(x, z) * 2);
        let best = null;
        for (const d of wildlife.deer.herd) {
          if (nearBldg(d.x, d.z, 80)) continue;
          for (let a = 15; a <= 165; a += 15) {
            const r = (a * Math.PI) / 180;
            const dx = Math.cos(r), dz = Math.sin(r);
            if (nearBldg(d.x + dx * 16, d.z + dz * 16, 50) || nearBldg(d.x - dx * 30, d.z - dz * 30, 50)) continue;
            let score = 0;
            for (const dist of [6, 10, 14, 18]) score += open(d.x + dx * dist, d.z + dz * dist);
            score += open(d.x - dx * 8, d.z - dz * 8) * 2;
            if (!best || score > best.score) best = { score, d, dx, dz };
          }
        }
        const { d, dx, dz } = best;
        const at = (k) => {
          const x = d.x + dx * k, z = d.z + dz * k;
          return new camera.position.constructor(x, terrain.heightAt(x, z) + 1.9, z);
        };
        const L = new camera.position.constructor(d.x, terrain.heightAt(d.x, d.z) + 1.6, d.z);
        const S = { A: at(16), B: at(11.5), LA: L, LB: L.clone() };
        S.tmp = S.LA.clone();
        window.__shot = S;
        camera.position.copy(S.A);
        controls.lookAt(S.LA);
        forest.prewarm(camera);
      });
    }
    const place = ([lon, lat, agl]) => {
      const p = terrain.lonLatToWorld(lon, lat);
      p.y = terrain.heightAt(p.x, p.z) + agl;
      return p;
    };
    const at = ([lon, lat, elev]) => {
      const p = terrain.lonLatToWorld(lon, lat);
      p.y = elev;
      return p;
    };
    const S = {
      A: place(shot.cam[0]), B: place(shot.cam[1]),
      LA: at(shot.look[0]), LB: at(shot.look[1]),
    };
    S.tmp = S.LA.clone();
    window.__shot = S;

    lighting.set(shot.preset); lighting.t = 0.999;       // snap the preset
    weather.set(shot.wx); weather.t = 0.999;
    weather._snowAccum = shot.snow0 ?? 0;

    camera.position.copy(S.B); forest.prewarm(camera);   // stream both ends
    camera.position.copy(S.A); forest.prewarm(camera);
    controls.lookAt(S.LA);
    for (let i = 0; i < shot.warm * FPS; i++) tick(1 / FPS);
  }, [shot, FPS]);
}

const captureFrame = (ePos, eLook) =>
  page.evaluate(([ePos, eLook, FPS]) => {
    const S = window.__shot;
    const { camera, controls, tick, renderer } = window.__app;
    camera.position.copy(S.A).lerp(S.B, ePos);
    S.tmp.copy(S.LA).lerp(S.LB, eLook);
    controls.lookAt(S.tmp);
    tick(1 / FPS);
    return renderer.domElement.toDataURL('image/jpeg', 0.92);
  }, [ePos, eLook, FPS]);

const save = (file, dataUrl) =>
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));

const t0 = Date.now();
for (let si = 0; si < SHOTS.length; si++) {
  const shot = SHOTS[si];
  await setupShot(shot);
  if (preview) {
    for (const [tag, t] of [['a', 0], ['b', 0.5], ['c', 1]]) {
      const e = ease(t, shot.ease);
      save(`${WORK}/preview/${String(si + 1).padStart(2, '0')}-${shot.name}-${tag}.jpg`, await captureFrame(e, e));
    }
    console.log(`preview: ${shot.name}`);
    continue;
  }
  const dir = `${WORK}/s${String(si + 1).padStart(2, '0')}`;
  fs.mkdirSync(dir, { recursive: true });
  const n = Math.round(shot.dur * FPS);
  for (let f = 0; f < n; f++) {
    const e = ease(n === 1 ? 0 : f / (n - 1), shot.ease);
    save(`${dir}/f${String(f + 1).padStart(5, '0')}.jpg`, await captureFrame(e, e));
  }
  console.log(`shot ${si + 1}/${SHOTS.length}  ${shot.name}  ${n} frames  (${((Date.now() - t0) / 1000).toFixed(0)} s elapsed)`);
}

if (preview) {
  console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.');
  await browser.close();
  process.exit(0);
}

// ---------------------------------------------------------------- soundtrack
// Rendered offline in the page: wind bed shaped per shot, the falls' roar,
// rain + one distant thunder roll, songbird chirps, a hawk cry, crickets.
console.log('rendering soundtrack…');
const sections = SHOTS.map((s, i) => ({ name: s.name, t: starts[i], dur: s.dur }));
const wavLen = await page.evaluate(async ([sections, TOTAL]) => {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(TOTAL * sr), sr);
  const master = ctx.createGain();
  master.connect(ctx.destination);
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(1, 1.2);
  master.gain.setValueAtTime(1, TOTAL - 2);
  master.gain.linearRampToValueAtTime(0, TOTAL - 0.05);

  const noiseBuf = ctx.createBuffer(1, sr * 4, sr);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const noise = (type, freq, q = 1) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    src.connect(f); src.start(0);
    return { src, out: f };
  };

  // wind bed, breathing, levels keyed to each shot's mood
  const windLevel = { 'dawn-tunnel': 0.030, 'elcap-clouds': 0.040, 'yosemite-falls': 0.034,
    storm: 0.085, 'snow-valley': 0.018, 'golden-halfdome': 0.034, 'deer-meadow': 0.016,
    'village-dusk': 0.020, 'night-stars': 0.014 };
  {
    const w = noise('lowpass', 460, 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(windLevel[sections[0].name], 0);
    for (const s of sections) g.gain.setTargetAtTime(windLevel[s.name], s.t, 1.6);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.35;
    lfo.connect(lfoG).connect(g.gain); lfo.start(0);
    w.out.connect(g).connect(master);
  }

  const section = (name) => sections.find((s) => s.name === name);

  // Yosemite Falls roar — swells through its shot
  {
    const s = section('yosemite-falls');
    const r = noise('lowpass', 300, 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.setTargetAtTime(0.10, s.t - 1, 2.0);
    g.gain.setTargetAtTime(0, s.t + s.dur - 0.5, 1.2);
    r.out.connect(g).connect(master);
  }

  // rain + one distant thunder roll
  {
    const s = section('storm');
    const r = noise('highpass', 700);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.setTargetAtTime(0.075, s.t - 0.5, 0.9);
    g.gain.setTargetAtTime(0, s.t + s.dur - 0.6, 0.9);
    r.out.connect(lp).connect(g).connect(master);

    const th = noise('lowpass', 95, 0.4);
    const tg = ctx.createGain();
    const t = s.t + 2.2;
    tg.gain.setValueAtTime(0, t);
    tg.gain.linearRampToValueAtTime(0.16, t + 0.7);
    tg.gain.setTargetAtTime(0, t + 1.0, 1.1);
    th.out.connect(tg).connect(master);
  }

  // songbird chirps: short descending sine notes, panned
  const chirp = (t, pan) => {
    const o = ctx.createOscillator(); o.type = 'sine';
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    const notes = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < notes; i++) {
      const nt = t + i * 0.14;
      const f0 = 2600 + Math.random() * 1400;
      o.frequency.setValueAtTime(f0, nt);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.78, nt + 0.09);
      g.gain.setValueAtTime(0.0, nt);
      g.gain.linearRampToValueAtTime(0.020, nt + 0.02);
      g.gain.setTargetAtTime(0, nt + 0.07, 0.03);
    }
    o.connect(g).connect(p).connect(master);
    o.start(t); o.stop(t + notes * 0.14 + 0.3);
  };
  for (const [sec, offs] of [['elcap-clouds', [1.5, 4.2, 7.0]], ['yosemite-falls', [1.0, 3.4]], ['deer-meadow', [1.2, 3.8, 5.4]]]) {
    const s = section(sec);
    offs.forEach((o, i) => chirp(s.t + o, i % 2 ? 0.5 : -0.5));
  }

  // one red-tailed-hawk cry over the golden-hour aerial
  {
    const s = section('golden-halfdome');
    const t = s.t + 3.0;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(2900, t);
    o.frequency.exponentialRampToValueAtTime(1500, t + 1.1);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 3400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.016, t + 0.08);
    g.gain.setTargetAtTime(0, t + 0.75, 0.16);
    o.connect(f).connect(g).connect(master);
    o.start(t); o.stop(t + 1.4);
  }

  // crickets carry the village dusk into the night finale
  {
    const s = section('village-dusk');
    for (const [freq, pan, rate] of [[4150, -0.45, 14], [4550, 0.5, 17]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 9;
      const trill = ctx.createGain(); trill.gain.value = 0;
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      const lvl = ctx.createGain();
      lvl.gain.setValueAtTime(0, 0);
      lvl.gain.setTargetAtTime(0.011, s.t + 2, 2.5);
      let t = s.t + 2 + Math.random() * 0.5;
      while (t < TOTAL) { // trains of 3 short pulses
        for (let i = 0; i < 3; i++) {
          const pt = t + i * (1 / rate);
          trill.gain.setValueAtTime(1, pt);
          trill.gain.setValueAtTime(0, pt + 0.030);
        }
        t += 0.55 + Math.random() * 0.6;
      }
      o.connect(bp).connect(trill).connect(p).connect(lvl).connect(master);
      o.start(s.t); o.stop(TOTAL);
    }
  }

  const buf = await ctx.startRendering();
  const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1);
  const wav = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); wav.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt ');
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 2, true);
  wav.setUint32(24, sr, true); wav.setUint32(28, sr * 4, true); wav.setUint16(32, 4, true);
  wav.setUint16(34, 16, true); str(36, 'data'); wav.setUint32(40, n * 4, true);
  const clip = (x) => Math.max(-1, Math.min(1, x));
  for (let i = 0; i < n; i++) {
    wav.setInt16(44 + i * 4, clip(L[i]) * 32767, true);
    wav.setInt16(46 + i * 4, clip(R[i]) * 32767, true);
  }
  const bytes = new Uint8Array(wav.buffer);
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  window.__wav = btoa(b64);
  return window.__wav.length;
}, [sections, TOTAL]);

{
  const CHUNK = 5_000_000;
  const parts = [];
  for (let i = 0; i < wavLen; i += CHUNK) {
    parts.push(await page.evaluate(([a, b]) => window.__wav.slice(a, b), [i, i + CHUNK]));
  }
  fs.writeFileSync(`${WORK}/soundtrack.wav`, Buffer.from(parts.join(''), 'base64'));
}

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'No console errors.');
await browser.close();

// ---------------------------------------------------------------- final cut
console.log('encoding…');
const FONT = '/System/Library/Fonts/Helvetica.ttc';
const args = [];
for (let i = 0; i < SHOTS.length; i++) {
  args.push('-framerate', String(FPS), '-i', `${WORK}/s${String(i + 1).padStart(2, '0')}/f%05d.jpg`);
}
args.push('-i', `${WORK}/soundtrack.wav`);

const chains = [];
let prev = '[0:v]';
for (let i = 1; i < SHOTS.length; i++) {
  const out = i === SHOTS.length - 1 ? '[vx]' : `[x${i}]`;
  chains.push(`${prev}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${starts[i].toFixed(3)}${out}`);
  prev = out;
}
const title = (text, size, y, t1, t2) =>
  `drawtext=fontfile=${FONT}:text='${text}':fontsize=${size}:fontcolor=white@0.92:` +
  `x=(w-text_w)/2:y=${y}:alpha='if(lt(t,${t1}),0,if(lt(t,${t1 + 1.4}),(t-${t1})/1.4,` +
  `if(lt(t,${t2}),1,if(lt(t,${t2 + 1.4}),(${t2 + 1.4}-t)/1.4,0))))'`;
const endT = starts[SHOTS.length - 1];
chains.push(
  `${prev}` +
  `fade=t=in:st=0:d=1.2,fade=t=out:st=${(TOTAL - 1.8).toFixed(2)}:d=1.8,` +
  title('Y O S E M I T E   V A L L E Y', 74, 'h*0.40', 1.6, 6.2) + ',' +
  title('a to-scale world in the browser — built by Fable 5', 30, 'h*0.40+108', 2.2, 6.2) + ',' +
  title('ode-to-yosemite.vercel.app', 40, 'h*0.44', endT + 2.5, TOTAL - 2.5) + ',' +
  `format=yuv420p[v]`
);
chains.push(`[${SHOTS.length}:a]anull[a]`);

args.push(
  '-filter_complex', chains.join(';'),
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-r', String(FPS),
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest',
  '-y', OUT
);
execFileSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
const size = (fs.statSync(OUT).size / 1e6).toFixed(1);
console.log(`\n${OUT}  ${TOTAL.toFixed(1)} s  ${size} MB`);
