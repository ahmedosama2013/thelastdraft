// First-person player: look, WASD + sprint + jump, terrain following and collision.

import { clamp } from './math.js';

const SENS = 0.0022;
const WALK = 3.1;
const SPRINT = 5.6;

export class Player {
  constructor() {
    this.tmp = { x: 0, z: 0 };
    this.reset(0, 0, 0, null);
  }

  reset(x, z, yaw, world) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.pitch = 0;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.y = world ? world.groundAt(x, z) : 0;
    this.camY = this.y;
    this.grounded = true;
    this.bobT = 0;
    this.bob = 0;
    this.stepAcc = 0;
    this.stepEvent = false;
    this.sprinting = false;
    this.speed = 0;
    this.eyeH = 1.7;
    this.stamina = 1;
    this.winded = false;
    this.staminaDelay = 0;
    this.windedEvent = false;
    this.sensMul = this.sensMul || 1;
  }

  get fwdX() { return Math.sin(this.yaw); }
  get fwdZ() { return -Math.cos(this.yaw); }

  eye() {
    return [this.x, this.camY + this.eyeH + this.bob, this.z];
  }

  basis() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fwd = [Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp];
    const right = [Math.cos(this.yaw), 0, Math.sin(this.yaw)];
    // up = right x fwd
    const up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];
    return { fwd, right, up };
  }

  _tryMove(w, nx, nz) {
    w.colliders.resolve(nx, nz, 0.38, this.tmp);
    nx = clamp(this.tmp.x, -w.bound, w.bound);
    nz = clamp(this.tmp.z, -w.bound, w.bound);
    const g = w.groundAt(nx, nz);
    if (g < w.waterY - 0.75) return false;
    if (this.grounded && g - this.y > 0.62) return false;
    this.x = nx;
    this.z = nz;
    return true;
  }

  update(dt, input, w) {
    const look = input.consumeLook();
    const sens = SENS * this.sensMul;
    this.yaw += look.dx * sens;
    this.pitch = clamp(this.pitch - look.dy * sens, -1.5, 1.5);

    let mx = 0, mz = 0;
    if (input.isDown('KeyW') || input.isDown('ArrowUp')) mz += 1;
    if (input.isDown('KeyS') || input.isDown('ArrowDown')) mz -= 1;
    if (input.isDown('KeyA') || input.isDown('ArrowLeft')) mx -= 1;
    if (input.isDown('KeyD') || input.isDown('ArrowRight')) mx += 1;
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }
    // sprinting costs stamina: about 7 s from full, then you are winded until a third has recovered
    this.windedEvent = false;
    const wantSprint = (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) && mz > 0 && !this.winded;
    this.sprinting = wantSprint && this.stamina > 0;
    if (this.sprinting && this.speed > 1) {
      this.stamina = Math.max(0, this.stamina - dt / 7);
      this.staminaDelay = 0.9;
      if (this.stamina <= 0) { this.winded = true; this.windedEvent = true; this.sprinting = false; }
    } else {
      this.staminaDelay -= dt;
      if (this.staminaDelay <= 0) this.stamina = Math.min(1, this.stamina + dt / 3.5);
      if (this.winded && this.stamina > 0.33) this.winded = false;
    }

    const inWater = w.groundAt(this.x, this.z) < w.waterY + 0.1 && w.waterY > -1e8;
    const target = len > 0 ? (this.sprinting ? SPRINT : WALK) * (inWater ? 0.6 : 1) : 0;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const wx = (c * mx + s * mz) * target;
    const wz = (s * mx - c * mz) * target;
    const k = Math.min(1, (this.grounded ? 14 : 3) * dt);
    this.vx += (wx - this.vx) * k;
    this.vz += (wz - this.vz) * k;

    const nx = this.x + this.vx * dt, nz = this.z + this.vz * dt;
    if (!this._tryMove(w, nx, nz)) {
      if (!this._tryMove(w, nx, this.z)) {
        if (!this._tryMove(w, this.x, nz)) { this.vx = 0; this.vz = 0; }
      }
    }

    if (input.pressed('Space') && this.grounded) {
      this.vy = 4.8;
      this.grounded = false;
    }
    const g = w.groundAt(this.x, this.z);
    if (this.grounded) {
      if (Math.abs(g - this.y) < 0.8) this.y = g;
      else this.grounded = false;
    }
    if (!this.grounded) {
      this.vy -= 14 * dt;
      this.y += this.vy * dt;
      if (this.y <= g) {
        this.y = g;
        this.vy = 0;
        this.grounded = true;
      }
    }
    this.camY += (this.y - this.camY) * Math.min(1, dt * 18);

    this.speed = Math.hypot(this.vx, this.vz);
    this.stepEvent = false;
    if (this.grounded && this.speed > 0.5) {
      this.bobT += this.speed * dt * 1.9;
      this.bob = Math.sin(this.bobT) * (this.sprinting ? 0.055 : 0.032);
      this.stepAcc += this.speed * dt;
      const stride = this.sprinting ? 2.2 : 1.8;
      if (this.stepAcc > stride) { this.stepAcc = 0; this.stepEvent = true; }
    } else {
      this.bob *= 0.9;
    }
  }
}
