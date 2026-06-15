import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { installAtmosphere } from './atmosphere.js';
import { Terrain } from './terrain.js';
import { ExploreControls } from './controls.js';
import { Forest } from './trees.js';
import { Waterfalls } from './waterfalls.js';
import { Lighting } from './lighting.js';
import { Weather } from './weather.js';
import { Wildlife } from './wildlife.js';
import { Village } from './village.js';
import { Ambience } from './audio.js';

installAtmosphere(); // patch the fog chunks before any material compiles

const overlay = document.getElementById('overlay');
const status = document.getElementById('status');
const startBtn = document.getElementById('start');
const hud = document.getElementById('hud');
const hint = document.getElementById('hint');
const toast = document.getElementById('toast');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfdcec, 9000, 80000);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 2, 400000);

const sky = new Sky();
sky.scale.setScalar(450000);
scene.add(sky);

const ambience = new Ambience();

// ---------------------------------------------------------------- UI state

let controls = null;
let lighting = null;
let weather = null;
let ready = false;
let usedFallback = false; // pointer lock unavailable -> click-and-drag look
let lockEverWorked = false;
let toastTimer = 0;

function showToast(text, ms = 2600) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
}

function updateHint() {
  if (!controls) return;
  const look = usedFallback ? 'drag to look' : 'mouse to look';
  hint.textContent =
    controls.mode === 'fly'
      ? `${look} · WASD move · Space/C up/down · Shift boost · scroll speed · F walk · L light · R weather · Esc menu`
      : `${look} · WASD walk · Shift run · F fly · L light · R weather · Esc menu`;
}

function setPlaying(playing) {
  document.body.classList.toggle('playing', playing);
  overlay.classList.toggle('hidden', playing);
  if (!playing && ready) {
    status.textContent = 'Paused';
    startBtn.textContent = 'Click to resume';
  }
  updateHint();
}

function enableFallbackLook() {
  if (usedFallback) return;
  usedFallback = true;
  if (controls) controls.dragLook = true;
  setPlaying(true);
  showToast('Mouse capture unavailable — hold and drag to look around', 4200);
}

function startExploring() {
  if (!ready) return;
  ambience.start();
  if (usedFallback) {
    setPlaying(true);
    return;
  }
  let request;
  try {
    request = renderer.domElement.requestPointerLock();
  } catch {
    enableFallbackLook();
    return;
  }
  // Chrome rejects re-lock within ~1.3 s of pressing Esc; tell the user
  // instead of failing silently. If lock never worked, fall back to drag.
  Promise.resolve(request).catch(() => {
    if (lockEverWorked) {
      status.textContent = 'One moment… click again';
    } else {
      enableFallbackLook();
    }
  });
}

overlay.addEventListener('click', startExploring);

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (locked) lockEverWorked = true;
  setPlaying(locked);
});
document.addEventListener('pointerlockerror', () => {
  if (!lockEverWorked) enableFallbackLook();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && usedFallback) setPlaying(false);
  if (!lighting) return;
  // lighting works from the menu too, so the start screen can preview moods
  if (e.code === 'KeyL') showToast(lighting.cycle());
  const n = e.code.match(/^Digit([1-5])$/);
  if (n) showToast(lighting.set(Number(n[1]) - 1));
  if (e.code === 'KeyR' && weather) showToast(weather.cycle());
  if (e.code === 'KeyM') showToast(ambience.toggleMute() ? 'Sound off' : 'Sound on');
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- load + run

let terrain;
try {
  terrain = await Terrain.load((done, total) => {
    status.textContent = `Loading terrain… ${done}/${total}`;
  });
} catch (err) {
  status.textContent = `Failed to load terrain data (${err.message}). Try reloading the page.`;
  status.classList.add('error');
  throw err;
}
scene.add(terrain.group);

status.textContent = 'Growing the forest…';
await new Promise((r) => setTimeout(r)); // let the status paint

const falls = new Waterfalls(scene, terrain);
const forest = new Forest(scene, terrain);
weather = new Weather(scene);
const wildlife = new Wildlife(scene, terrain);
const village = new Village(scene, terrain);
lighting = new Lighting({ renderer, scene, sky, terrain, forest, falls });
lighting.weather = weather;
lighting.village = village;

controls = new ExploreControls(camera, renderer.domElement, terrain);
controls.onModeChange = (mode) => {
  showToast(mode === 'walk' ? 'Walking — you are at eye height on the ground' : 'Flying');
  updateHint();
};

// Spawn hovering above Tunnel View, facing the classic postcard view
// (El Capitan on the left, Bridalveil right, Half Dome dead ahead).
const spawn = terrain.lonLatToWorld(-119.67738, 37.71562);
spawn.y = terrain.heightAt(spawn.x, spawn.z) + 120;
camera.position.copy(spawn);
const halfDome = terrain.lonLatToWorld(-119.5332, 37.746);
halfDome.y = 2693;
controls.lookAt(halfDome);

forest.prewarm(camera);

ready = true;
status.textContent = 'Real elevation data & satellite imagery — true to scale';
startBtn.textContent = 'Click to explore';
startBtn.classList.remove('disabled');

window.__app = { camera, controls, terrain, forest, falls, lighting, weather, wildlife, village, renderer, tick }; // debug/testing hook

const clock = new THREE.Clock();
let hudTimer = 0;
// One simulation+render step. Exposed on __app so the film rig
// (tools/film.mjs) can drive the world with a fixed timestep.
function tick(dt) {
  const prev = hudTimer <= 0 ? camera.position.clone() : null;
  controls.update(dt);
  weather.update(dt, camera);
  lighting.update(dt);
  falls.update(dt);
  forest.update(camera, dt);
  const storm = weather.mod.rain > 0.4 || weather.mod.snowFall > 0.4;
  wildlife.update(dt, camera, lighting.night, storm);
  village.update(dt, lighting.night, weather.mod.snow);
  renderer.render(scene, camera);

  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.15;
    const alt = camera.position.y.toFixed(0);
    const aglNum = camera.position.y - terrain.heightAt(camera.position.x, camera.position.z);
    const agl = aglNum.toFixed(0);
    const wx = weather.current === 'clear' ? '' : `  ·  ${weather.label}`;
    hud.textContent =
      controls.mode === 'fly'
        ? `FLY  ${controls.flySpeed.toFixed(0)} m/s  alt ${alt} m (${agl} m above ground)  ·  ${lighting.label}${wx}`
        : `WALK  elev ${alt} m  ·  ${lighting.label}${wx}`;
    const speed = prev ? prev.distanceTo(camera.position) / Math.max(dt, 1e-4) : 0;
    ambience.update(falls.nearest(camera.position), aglNum, speed, {
      night: lighting.night,
      rain: weather.mod.rain,
      snow: weather.mod.snow,
      forest: terrain.forestAt(camera.position.x, camera.position.z),
      windAud: weather.mod.windAud,
    });
  }
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (window.__filming) return; // film rig drives tick() itself
  tick(dt);
});
