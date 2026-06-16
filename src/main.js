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
import { db } from './db.js';
import { downloadScene } from './downloader.js';

installAtmosphere();

// --- DOM Elements ---
const dashboard = document.getElementById('dashboard');
const mapModal = document.getElementById('map-modal');
const progressOverlay = document.getElementById('progress-overlay');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const status = document.getElementById('status');
const startBtn = document.getElementById('start');
const hud = document.getElementById('hud');
const hint = document.getElementById('hint');
const toast = document.getElementById('toast');
const backToMenuBtn = document.getElementById('back-to-menu');
const sceneList = document.getElementById('scene-list');

// --- Three.js Globals ---
let renderer, scene, camera, sky;
let terrain, forest, waterfalls, weather, wildlife, village, lighting, controls, ambience;
let clock = new THREE.Clock();
let activeSceneId = null;
let ready = false;
let usedFallback = false;
let lockEverWorked = false;
let toastTimer = 0;
let hudTimer = 0;
let animationFrameId = null;

// --- Leaflet Map Globals ---
let map, selectionRect;

// --- Initialize App ---
initApp();

function initApp() {
  // Setup Three.js boilerplate once
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.6;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xcfdcec, 9000, 80000);

  camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 2, 400000);

  sky = new Sky();
  sky.scale.setScalar(450000);
  scene.add(sky);

  ambience = new Ambience();

  // Setup Dashboard event listeners
  document.getElementById('btn-create-scene').addEventListener('click', openMapSelector);
  document.getElementById('btn-import-scene').addEventListener('click', () => document.getElementById('file-import').click());
  document.getElementById('file-import').addEventListener('change', handleImportScene);
  document.getElementById('btn-cancel-map').addEventListener('click', closeMapSelector);
  document.getElementById('btn-generate-scene').addEventListener('click', handleGenerateScene);
  
  // Dashboard Map search UI
  document.getElementById('btn-search').addEventListener('click', handleMapSearch);
  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleMapSearch();
  });

  backToMenuBtn.addEventListener('click', exit3DView);

  // Resize listener
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Render scenes list
  renderSceneList();
}

// --- Dashboard Functions ---
async function renderSceneList() {
  sceneList.innerHTML = '';

  // Add Default Yosemite Scene
  const yosemiteCard = createSceneCard({
    id: 'yosemite',
    name: 'Yosemite Valley (Default)',
    bbox: { west: -119.78, east: -119.48, south: 37.66, north: 37.79 },
    createdAt: new Date('2026-01-01').getTime(),
    isDefault: true
  });
  sceneList.appendChild(yosemiteCard);

  // Add custom scenes from IndexedDB
  const customScenes = await db.listScenes();
  customScenes.forEach((s) => {
    const card = createSceneCard(s);
    sceneList.appendChild(card);
  });
}

function createSceneCard(sceneData) {
  const card = document.createElement('div');
  card.className = 'scene-card';

  const info = document.createElement('div');
  info.className = 'scene-info';

  const title = document.createElement('h3');
  title.className = 'scene-title';
  title.textContent = sceneData.name;
  info.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'scene-meta';
  
  const width = getDistance(sceneData.bbox.south, sceneData.bbox.west, sceneData.bbox.south, sceneData.bbox.east);
  const height = getDistance(sceneData.bbox.south, sceneData.bbox.west, sceneData.bbox.north, sceneData.bbox.west);
  const sizeText = `${width.toFixed(1)} x ${height.toFixed(1)} km`;

  const sizeMeta = document.createElement('span');
  sizeMeta.textContent = `Size: ${sizeText}`;
  meta.appendChild(sizeMeta);

  if (sceneData.sizeEstimate) {
    const mbMeta = document.createElement('span');
    mbMeta.textContent = `Disk: ${(sceneData.sizeEstimate / (1024 * 1024)).toFixed(1)} MB`;
    meta.appendChild(mbMeta);
  }

  const dateMeta = document.createElement('span');
  dateMeta.textContent = new Date(sceneData.createdAt).toLocaleDateString();
  meta.appendChild(dateMeta);

  info.appendChild(meta);
  card.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'scene-actions';

  const playBtn = document.createElement('button');
  playBtn.className = 'btn btn-primary';
  playBtn.textContent = 'Explore';
  playBtn.onclick = () => enter3DView(sceneData.id, sceneData.name);
  actions.appendChild(playBtn);

  if (!sceneData.isDefault) {
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'btn btn-secondary';
    downloadBtn.textContent = 'Export';
    downloadBtn.onclick = () => handleExportScene(sceneData.id);
    actions.appendChild(downloadBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = () => handleDeleteScene(sceneData.id);
    actions.appendChild(deleteBtn);
  }

  card.appendChild(actions);
  return card;
}

// --- Map Selector ---
function openMapSelector() {
  mapModal.classList.remove('hidden');
  
  // Lazily initialize Leaflet Map
  if (!map) {
    map = L.map('map').setView([37.73, -119.58], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    map.on('move', updateSelectionBox);
    map.on('zoomend', updateSelectionBox);
  }
  
  // Set default selection rect in view
  setTimeout(updateSelectionBox, 200);
}

function closeMapSelector() {
  mapModal.classList.add('hidden');
}

function updateSelectionBox() {
  if (!map) return;
  const bounds = map.getBounds();
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const latInset = (ne.lat - sw.lat) * 0.15;
  const lngInset = (ne.lng - sw.lng) * 0.15;

  const selectBounds = [
    [sw.lat + latInset, sw.lng + lngInset],
    [ne.lat - latInset, ne.lng - lngInset]
  ];

  if (!selectionRect) {
    selectionRect = L.rectangle(selectBounds, { color: '#3b82f6', weight: 2, fillOpacity: 0.15 }).addTo(map);
  } else {
    selectionRect.setBounds(selectBounds);
  }

  const west = sw.lng + lngInset;
  const east = ne.lng - lngInset;
  const south = sw.lat + latInset;
  const north = ne.lat - latInset;

  const wKm = getDistance(south, west, south, east);
  const hKm = getDistance(south, west, north, west);

  document.getElementById('stat-w').textContent = `${wKm.toFixed(1)} km`;
  document.getElementById('stat-h').textContent = `${hKm.toFixed(1)} km`;

  const statusText = document.getElementById('stat-status');
  const genBtn = document.getElementById('btn-generate-scene');

  if (wKm > 15 || hKm > 15) {
    statusText.textContent = 'Too large (max 15x15km)';
    statusText.style.color = '#ef4444';
    genBtn.disabled = true;
    genBtn.style.opacity = 0.5;
  } else if (wKm < 1 || hKm < 1) {
    statusText.textContent = 'Too small (min 1x1km)';
    statusText.style.color = '#ef4444';
    genBtn.disabled = true;
    genBtn.style.opacity = 0.5;
  } else {
    statusText.textContent = 'Ready to build';
    statusText.style.color = '#10b981';
    genBtn.disabled = false;
    genBtn.style.opacity = 1;
  }
}

async function handleMapSearch() {
  const query = document.getElementById('search-input').value;
  if (!query) return;

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data && data.length > 0) {
      const result = data[0];
      map.setView([parseFloat(result.lat), parseFloat(result.lon)], 13);
    } else {
      alert('Location not found');
    }
  } catch (err) {
    console.error('Nominatim geocoder error', err);
  }
}

async function handleGenerateScene() {
  const name = document.getElementById('scene-name-input').value.trim() || 'Custom Valley';
  const selectBounds = selectionRect.getBounds();
  const bbox = {
    west: selectBounds.getWest(),
    east: selectBounds.getEast(),
    south: selectBounds.getSouth(),
    north: selectBounds.getNorth()
  };

  closeMapSelector();
  progressOverlay.classList.remove('hidden');
  const bar = document.getElementById('progress-bar-fill');
  const detail = document.getElementById('progress-detail');

  try {
    const sceneId = await downloadScene(bbox, name, (msg, pct) => {
      detail.textContent = msg;
      bar.style.width = `${pct}%`;
    });

    setTimeout(() => {
      progressOverlay.classList.add('hidden');
      renderSceneList();
    }, 1000);
  } catch (err) {
    alert(`Scene generation failed: ${err.message}`);
    progressOverlay.classList.add('hidden');
  }
}

// --- Import / Export Scenes ---
async function handleExportScene(id) {
  const sceneData = await db.getScene(id);
  if (!sceneData) return;

  const zip = new JSZip();
  zip.file('scene_metadata.json', JSON.stringify({
    id: sceneData.id,
    name: sceneData.name,
    bbox: sceneData.bbox,
    createdAt: sceneData.createdAt
  }));
  zip.file('manifest.json', JSON.stringify(sceneData.manifest));
  zip.file('heights.bin', sceneData.heights);
  zip.file('forest.png', sceneData.forest);
  zip.file('osm.json', JSON.stringify(sceneData.osm));

  const texFolder = zip.folder('textures');
  for (const key in sceneData.textures) {
    if (sceneData.textures[key]) {
      texFolder.file(`${key}.jpg`, sceneData.textures[key]);
    }
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(content);
  link.download = `${sceneData.name.replace(/\s+/g, '_')}_3dscene.zip`;
  link.click();
}

async function handleImportScene(e) {
  const file = e.target.files[0];
  if (!file) return;

  progressOverlay.classList.remove('hidden');
  const bar = document.getElementById('progress-bar-fill');
  const detail = document.getElementById('progress-detail');
  
  detail.textContent = 'Parsing zip archive...';
  bar.style.width = '20%';

  try {
    const zip = await JSZip.loadAsync(file);
    const meta = JSON.parse(await zip.file('scene_metadata.json').async('text'));
    const manifest = JSON.parse(await zip.file('manifest.json').async('text'));
    const heights = await zip.file('heights.bin').async('arraybuffer');
    const forest = await zip.file('forest.png').async('blob');
    const osm = JSON.parse(await zip.file('osm.json').async('text'));
    
    bar.style.width = '60%';
    detail.textContent = 'Importing satellite textures...';

    const textures = {};
    const texFolder = zip.folder('textures');
    const texFiles = [];
    texFolder.forEach((relPath, fileObj) => {
      if (!fileObj.dir) texFiles.push(fileObj);
    });

    for (let i = 0; i < texFiles.length; i++) {
      const fileObj = texFiles[i];
      const texKey = fileObj.name.replace('textures/', '').replace('.jpg', '');
      const blob = await fileObj.async('blob');
      textures[texKey] = blob;
    }

    const importedScene = {
      id: meta.id,
      name: meta.name,
      bbox: meta.bbox,
      manifest,
      heights,
      forest,
      osm,
      textures,
      createdAt: meta.createdAt || Date.now()
    };

    bar.style.width = '90%';
    detail.textContent = 'Saving scene locally...';
    await db.saveScene(importedScene);
    
    bar.style.width = '100%';
    setTimeout(() => {
      progressOverlay.classList.add('hidden');
      renderSceneList();
    }, 500);
  } catch (err) {
    alert(`Failed to import scene ZIP: ${err.message}`);
    progressOverlay.classList.add('hidden');
  }
}

async function handleDeleteScene(id) {
  if (confirm('Are you sure you want to delete this scene?')) {
    await db.deleteScene(id);
    renderSceneList();
  }
}

// --- 3D View Transitions ---
async function enter3DView(sceneId, sceneName) {
  activeSceneId = sceneId;
  dashboard.classList.add('hidden');
  overlay.classList.remove('hidden');
  overlayTitle.textContent = sceneName;
  status.textContent = 'Loading terrain…';
  startBtn.textContent = 'Loading…';
  startBtn.classList.add('disabled');
  backToMenuBtn.style.display = 'block';

  try {
    // Reset previous Three.js objects
    cleanupThreeScene();

    terrain = await Terrain.load((done, total) => {
      status.textContent = `Loading terrain… ${done}/${total}`;
    }, sceneId);
    scene.add(terrain.group);

    status.textContent = 'Growing the forest…';
    await new Promise((r) => setTimeout(r));

    waterfalls = new Waterfalls(scene, terrain);
    forest = new Forest(scene, terrain);
    weather = new Weather(scene);
    wildlife = new Wildlife(scene, terrain);
    village = new Village(scene, terrain);
    
    lighting = new Lighting({ renderer, scene, sky, terrain, forest, falls: waterfalls });
    lighting.weather = weather;
    lighting.village = village;

    controls = new ExploreControls(camera, renderer.domElement, terrain);
    controls.onModeChange = (mode) => {
      showToast(mode === 'walk' ? 'Walking — you are at eye height on the ground' : 'Flying');
      updateHint();
    };

    // Calculate Spawn point
    const bbox = terrain.m.bbox;
    const lonCenter = (bbox.west + bbox.east) / 2;
    const latCenter = (bbox.north + bbox.south) / 2;
    const spawn = terrain.lonLatToWorld(lonCenter, latCenter);
    spawn.y = terrain.heightAt(spawn.x, spawn.z) + 120;
    camera.position.copy(spawn);

    // Look slightly downward
    const lookTarget = new THREE.Vector3(spawn.x, spawn.y - 10, spawn.z + 100);
    controls.lookAt(lookTarget);

    forest.prewarm(camera);

    ready = true;
    status.textContent = 'Real elevation data & satellite imagery — true to scale';
    startBtn.textContent = 'Click to explore';
    startBtn.classList.remove('disabled');

    // Start tick loops
    clock.getDelta(); // reset clock
    renderer.setAnimationLoop(tickFrame);

  } catch (err) {
    status.textContent = `Failed to load terrain data: ${err.message}`;
    status.classList.add('error');
    console.error(err);
  }
}

function exit3DView() {
  document.exitPointerLock();
  renderer.setAnimationLoop(null);
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  
  cleanupThreeScene();
  ambience.toggleMute(); // Ensure sound is disabled

  backToMenuBtn.style.display = 'none';
  overlay.classList.add('hidden');
  document.body.classList.remove('playing');
  dashboard.classList.remove('hidden');

  renderSceneList();
}

function cleanupThreeScene() {
  ready = false;
  
  // Dispose all scene children except Sky
  const toRemove = [];
  scene.children.forEach((child) => {
    if (child !== sky) toRemove.push(child);
  });
  toRemove.forEach((child) => {
    scene.remove(child);
    disposeNode(child);
  });

  terrain = null;
  forest = null;
  waterfalls = null;
  weather = null;
  wildlife = null;
  village = null;
  lighting = null;
  controls = null;
}

function disposeNode(node) {
  if (node.geometry) node.geometry.dispose();
  if (node.material) {
    if (Array.isArray(node.material)) {
      node.material.forEach((m) => m.dispose());
    } else {
      node.material.dispose();
    }
  }
  if (node.children) {
    node.children.forEach(disposeNode);
  }
}

// --- WebGL Controls HUD Events ---
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
  if (e.code === 'KeyL') showToast(lighting.cycle());
  const n = e.code.match(/^Digit([1-5])$/);
  if (n) showToast(lighting.set(Number(n[1]) - 1));
  if (e.code === 'KeyR' && weather) showToast(weather.cycle());
  if (e.code === 'KeyM') showToast(ambience.toggleMute() ? 'Sound off' : 'Sound on');
});

// --- Main Simulation Loop ---
function tickFrame() {
  if (!ready) return;
  const dt = Math.min(clock.getDelta(), 0.1);
  tick(dt);
}

function tick(dt) {
  const prev = hudTimer <= 0 ? camera.position.clone() : null;
  controls.update(dt);
  weather.update(dt, camera);
  lighting.update(dt);
  waterfalls.update(dt);
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
    ambience.update(waterfalls.nearest(camera.position), aglNum, speed, {
      night: lighting.night,
      rain: weather.mod.rain,
      snow: weather.mod.snow,
      forest: terrain.forestAt(camera.position.x, camera.position.z),
      windAud: weather.mod.windAud,
    });
  }
}

// --- Distance Calculation Helper ---
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
