import * as THREE from 'three';

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 4;     // m/s
const RUN_SPEED = 14;
const MIN_FLY_SPEED = 5;
const MAX_FLY_SPEED = 1500;
const LOOK_SENSITIVITY = 0.0021;

// Fly/walk controls. Mouse look uses pointer lock when available, and falls
// back to click-and-drag when pointer lock is denied or unsupported.
//   Fly:  WASD/arrows along view, Space|E up, C|Q down, Shift boost, scroll = speed
//   Walk: WASD/arrows on the ground at eye height, Shift run
export class ExploreControls {
  constructor(camera, domElement, terrain) {
    this.camera = camera;
    this.dom = domElement;
    this.terrain = terrain;
    this.mode = 'fly';
    this.flySpeed = 120;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.dragLook = false; // true when pointer lock is unavailable
    this.dragging = false;
    this.onModeChange = null;

    camera.rotation.order = 'YXZ';

    domElement.addEventListener('mousemove', (e) => {
      const locked = document.pointerLockElement === domElement;
      if (!locked && !(this.dragLook && this.dragging)) return;
      this.look(e.movementX, e.movementY);
    });
    domElement.addEventListener('mousedown', () => (this.dragging = true));
    window.addEventListener('mouseup', () => (this.dragging = false));

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyF' && this.active()) this.toggleMode();
      if (e.code.startsWith('Arrow')) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    domElement.addEventListener('wheel', (e) => {
      this.flySpeed *= e.deltaY > 0 ? 1 / 1.18 : 1.18;
      this.flySpeed = Math.max(MIN_FLY_SPEED, Math.min(MAX_FLY_SPEED, this.flySpeed));
    }, { passive: true });
  }

  active() {
    return document.pointerLockElement === this.dom || this.dragLook;
  }

  look(dx, dy) {
    this.yaw -= dx * LOOK_SENSITIVITY;
    this.pitch -= dy * LOOK_SENSITIVITY;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
  }

  toggleMode() {
    this.mode = this.mode === 'fly' ? 'walk' : 'fly';
    this.onModeChange?.(this.mode);
  }

  lookAt(target) {
    const dir = target.clone().sub(this.camera.position).normalize();
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  }

  has(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  update(dt) {
    const cam = this.camera;
    cam.rotation.set(this.pitch, this.yaw, 0);
    if (!this.active()) return;

    const fwdInput = (this.has('KeyW', 'ArrowUp') ? 1 : 0) - (this.has('KeyS', 'ArrowDown') ? 1 : 0);
    const strafeInput = (this.has('KeyD', 'ArrowRight') ? 1 : 0) - (this.has('KeyA', 'ArrowLeft') ? 1 : 0);
    const boost = this.has('ShiftLeft', 'ShiftRight');

    const move = new THREE.Vector3();
    if (this.mode === 'fly') {
      const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      move.addScaledVector(fwd, fwdInput).addScaledVector(right, strafeInput);
      move.y += (this.has('Space', 'KeyE') ? 1 : 0) - (this.has('KeyC', 'KeyQ') ? 1 : 0);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(this.flySpeed * (boost ? 4 : 1) * dt);
        cam.position.add(move);
      }
      const ground = this.terrain.heightAt(cam.position.x, cam.position.z);
      cam.position.y = Math.max(cam.position.y, ground + 2.5);
    } else {
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      move.addScaledVector(fwd, fwdInput).addScaledVector(right, strafeInput);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar((boost ? RUN_SPEED : WALK_SPEED) * dt);
        cam.position.add(move);
      }
      const targetY = this.terrain.heightAt(cam.position.x, cam.position.z) + EYE_HEIGHT;
      // Smooth over the 15 m height grid so steps don't feel like stairs.
      cam.position.y += (targetY - cam.position.y) * (1 - Math.exp(-10 * dt));
    }
    this.terrain.clampToBounds(cam.position);
  }
}
