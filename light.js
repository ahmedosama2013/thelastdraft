// Light is the mechanic: lamps (safe havens), the flashlight and its battery, flares, the lighthouse beacon.

import { clamp, lerp, norm3 } from './math.js';

export function makeLamp(d) {
  return {
    name: d.name || '',
    x: d.x, y: d.y, z: d.z,
    radius: d.radius === undefined ? 8 : d.radius,
    color: d.color || [1.0, 0.68, 0.38],
    intensity: d.intensity === undefined ? 5.5 : d.intensity,
    haven: d.haven !== false,
    on: d.on !== false,
    level: d.on === false ? 0 : 1,
    flick: 0,
    phase: Math.random() * 100,
    glow: d.glow === undefined ? 1 : d.glow,
    out: d.on === false ? 0 : 1,
  };
}

const FLARE_LIFE = 24;
const FLARE_RADIUS = 6;

export class LightSystem {
  constructor() {
    this.lamps = [];
    this.flares = [];
    this.flareCount = 2;
    this.beacon = null;
    this.time = 0;
    this.lastEvent = '';
    this.fl = {
      on: true, battery: 1, spare: 1, focus: 0, flick: 0,
      pos: [0, 0, 0], dir: [0, 0, -1], dirInit: false,
      halfAngle: 0.4, cosOuter: Math.cos(0.4), cosInner: Math.cos(0.38),
      range: 36, intensity: 9, power: 1,
    };
    this.pl = new Float32Array(32);
    this.plc = new Float32Array(24);
    this._cand = [];
    this.glitch = 0;
  }

  reset(lamps) {
    this.lamps = lamps;
    this.flares.length = 0;
    this.beacon = null;
    this.fl.on = true;
    this.fl.battery = 1;
    this.fl.focus = 0;
    this.fl.dirInit = false;
    this.glitch = 0;
  }

  // Brief flashlight stutter (something just appeared).
  triggerGlitch(sec) {
    this.glitch = Math.max(this.glitch, sec);
  }

  toggle() {
    if (this.fl.battery <= 0) return false;
    this.fl.on = !this.fl.on;
    return true;
  }

  swapBattery() {
    if (this.fl.spare > 0 && this.fl.battery < 0.7) {
      this.fl.spare--;
      this.fl.battery = 1;
      return true;
    }
    return false;
  }

  // Aim the flashlight. `fwd` is the camera forward vector; the beam converges ~14 m ahead and lags slightly.
  setPose(eye, fwd, right, up, dt) {
    const fl = this.fl;
    fl.pos[0] = eye[0] + right[0] * 0.2 + up[0] * -0.2 + fwd[0] * 0.35;
    fl.pos[1] = eye[1] + right[1] * 0.2 + up[1] * -0.2 + fwd[1] * 0.35;
    fl.pos[2] = eye[2] + right[2] * 0.2 + up[2] * -0.2 + fwd[2] * 0.35;
    const t = [eye[0] + fwd[0] * 14 - fl.pos[0], eye[1] + fwd[1] * 14 - fl.pos[1], eye[2] + fwd[2] * 14 - fl.pos[2]];
    const want = norm3(t);
    if (!fl.dirInit) {
      fl.dir = want;
      fl.dirInit = true;
    } else {
      const k = 1 - Math.exp(-dt * 16);
      fl.dir = norm3([lerp(fl.dir[0], want[0], k), lerp(fl.dir[1], want[1], k), lerp(fl.dir[2], want[2], k)]);
    }
  }

  update(dt, focusHeld, inHaven, world) {
    this.time += dt;
    this.lastEvent = '';
    const t = this.time;
    for (const l of this.lamps) {
      const target = l.on ? 1 : 0;
      l.level += (target - l.level) * Math.min(1, dt * 6);
      let f = 1;
      if (l.flick > 0) f = 1 - l.flick * (Math.sin(t * 47 + l.phase) > 0.2 ? 0.85 : 0.0);
      l.out = l.level * f;
    }
    const fl = this.fl;
    fl.focus += ((focusHeld && fl.on ? 1 : 0) - fl.focus) * Math.min(1, dt * 9);
    if (fl.on) {
      if (inHaven) fl.battery = Math.min(1, fl.battery + 0.12 * dt);
      else fl.battery -= lerp(1 / 170, 1 / 60, fl.focus) * dt;
      if (fl.battery <= 0) {
        if (fl.spare > 0) {
          fl.spare--;
          fl.battery = 1;
          this.lastEvent = 'swap';
        } else {
          fl.battery = 0;
        }
      }
    } else if (inHaven) {
      fl.battery = Math.min(1, fl.battery + 0.12 * dt);
    }
    const low = fl.battery < 0.18;
    fl.power = fl.battery <= 0 ? 0 : low ? fl.battery / 0.18 : 1;
    fl.flick = low && fl.battery > 0 ? (Math.sin(t * 61) > 0.1 - fl.power * 0.6 ? 0 : 0.8) : 0;
    fl.halfAngle = lerp(0.40, 0.15, fl.focus);
    fl.cosOuter = Math.cos(fl.halfAngle);
    fl.cosInner = Math.cos(Math.max(fl.halfAngle - 0.02, 0.01));
    fl.range = lerp(36, 62, fl.focus);
    this.glitch = Math.max(0, this.glitch - dt);
    const stutter = this.glitch > 0 && Math.sin(t * 83) > -0.1 ? 0.1 : 1;
    fl.intensity = lerp(9, 16, fl.focus) * fl.power * (1 - fl.flick) * stutter;

    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.t += dt;
      if (!f.landed) {
        f.vy -= 14 * dt;
        f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
        const g = world.groundAt(f.x, f.z);
        if (f.y <= g + 0.08) { f.y = g + 0.08; f.landed = true; }
      }
      f.out = (0.8 + 0.2 * Math.sin(t * 31 + f.t * 5)) * clamp((FLARE_LIFE - f.t) / 3, 0, 1) * clamp(f.t * 4, 0, 1);
      if (f.t > FLARE_LIFE) this.flares.splice(i, 1);
    }

    const b = this.beacon;
    if (b && b.on) {
      b.ang += b.speed * dt;
      b.dir = norm3([Math.sin(b.ang), b.tilt, -Math.cos(b.ang)]);
    }
  }

  throwFlare(px, py, pz, dx, dy, dz) {
    if (this.flareCount <= 0) return false;
    this.flareCount--;
    this.flares.push({
      x: px, y: py, z: pz, vx: dx * 10, vy: dy * 10 + 2.5, vz: dz * 10,
      landed: false, t: 0, out: 0,
    });
    return true;
  }

  startBeacon(x, y, z) {
    const half = 0.2;
    // The beam is pitched down so its footprint sweeps the ground 25-65 m around the tower, where enemies close in.
    this.beacon = {
      on: true, x, y, z, ang: 0, speed: 0.6, half, tilt: -0.6, range: 90,
      cosOuter: Math.cos(half), cosInner: Math.cos(half - 0.03),
      dir: norm3([0, -0.6, -1]),
    };
  }

  // Lamp the player stands in (checkpoint / recharge), or null.
  havenAt(x, y, z) {
    for (const l of this.lamps) {
      if (!l.haven || !l.on || l.out < 0.5) continue;
      if (Math.abs(y - l.y) > 8) continue;
      if (Math.hypot(x - l.x, z - l.z) < l.radius * 0.85) return l;
    }
    return null;
  }

  // Lamp whose pool an enemy at (x, z) is about to walk into.
  havenNear(x, z, margin) {
    for (const l of this.lamps) {
      if (!l.haven || !l.on || l.out < 0.5) continue;
      if (Math.hypot(x - l.x, z - l.z) < l.radius * 0.85 + margin) return l;
    }
    return null;
  }

  flareNear(x, z, margin) {
    for (const f of this.flares) {
      if (f.out < 0.3) continue;
      if (Math.hypot(x - f.x, z - f.z) < FLARE_RADIUS + margin) return f;
    }
    return null;
  }

  // Light damage per second to an enemy standing at this point (lamp pools + flares).
  damageAt(x, y, z) {
    let d = 0;
    for (const l of this.lamps) {
      if (!l.haven || !l.on || l.out < 0.5) continue;
      if (Math.abs(y - l.y) > 8) continue;
      if (Math.hypot(x - l.x, z - l.z) < l.radius * 0.85) { d += 45; break; }
    }
    for (const f of this.flares) {
      if (f.out < 0.3) continue;
      if (Math.hypot(x - f.x, z - f.z) < FLARE_RADIUS) { d += 70; break; }
    }
    return d;
  }

  beaconDps(x, y, z) {
    const b = this.beacon;
    if (!b || !b.on) return 0;
    const dx = x - b.x, dy = y - b.y, dz = z - b.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    if (d > b.range) return 0;
    const c = (dx * b.dir[0] + dy * b.dir[1] + dz * b.dir[2]) / d;
    return c > b.cosOuter ? 140 : 0;
  }

  // Fills the shader arrays with the 8 most relevant point lights around the camera (allocation-free).
  gather(cx, cy, cz) {
    const cand = this._cand;
    let n = 0;
    const put = (s, x, y, z, r, c0, c1, c2, i) => {
      let o = cand[n];
      if (!o) { o = cand[n] = { s: 0, x: 0, y: 0, z: 0, r: 0, c0: 0, c1: 0, c2: 0, i: 0 }; }
      o.s = s; o.x = x; o.y = y; o.z = z; o.r = r; o.c0 = c0; o.c1 = c1; o.c2 = c2; o.i = i;
      n++;
    };
    for (const l of this.lamps) {
      if (l.out < 0.02) continue;
      const d = Math.hypot(l.x - cx, l.y - cy, l.z - cz);
      put(d - l.radius, l.x, l.y, l.z, l.radius, l.color[0], l.color[1], l.color[2], l.intensity * l.out);
    }
    for (const f of this.flares) {
      if (f.out < 0.02) continue;
      const d = Math.hypot(f.x - cx, f.y - cy, f.z - cz);
      put(d - 12, f.x, f.y + 0.3, f.z, 12, 1.0, 0.3, 0.18, 6 * f.out);
    }
    this.pl.fill(0);
    this.plc.fill(0);
    const m = Math.min(8, n);
    for (let i = 0; i < m; i++) {
      let best = i;
      for (let j = i + 1; j < n; j++) if (cand[j].s < cand[best].s) best = j;
      if (best !== i) { const t = cand[i]; cand[i] = cand[best]; cand[best] = t; }
      const c = cand[i];
      this.pl[i * 4] = c.x; this.pl[i * 4 + 1] = c.y; this.pl[i * 4 + 2] = c.z; this.pl[i * 4 + 3] = c.r;
      this.plc[i * 3] = c.c0 * c.i; this.plc[i * 3 + 1] = c.c1 * c.i; this.plc[i * 3 + 2] = c.c2 * c.i;
    }
  }
}
