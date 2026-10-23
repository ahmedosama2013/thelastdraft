// The Unwritten: shadow silhouettes shielded by darkness.
// Burn the shield off with the flashlight, then finish them with a flare or a lamp pool.

import { clamp, lerp, TAU, wrapPi } from './math.js';
import { makeRng } from './noise.js';
import { MeshBuilder, addBox, addTube, makeXf } from './props.js';

const ID = makeXf(0, 0, 0, 0);
const DARK = [0.02, 0.022, 0.026];

// Local space: +Z forward, +Y up, ~1.95 m tall. Boss is the same mesh scaled up plus spikes.
export function buildEnemyMeshes() {
  const walker = new MeshBuilder();
  const boss = new MeshBuilder();
  for (const b of [walker, boss]) {
    for (const sx of [-1, 1]) {
      addTube(b, [sx * 0.12, 0, 0], [sx * 0.14, 0.92, 0.05], 0.09, 0.07, 5, DARK, 0.6, 1, 0, 0.1);
      addTube(b, [sx * 0.27, 1.5, 0], [sx * 0.34, 0.55, 0.28], 0.065, 0.04, 5, DARK, 0.8, 1, 0.1, 0.5);
      addTube(b, [sx * 0.34, 0.55, 0.28], [sx * 0.37, 0.18, 0.36], 0.04, 0.012, 4, DARK, 0.9, 1, 0.5, 1.0);
    }
    addTube(b, [0, 0.9, 0], [0, 1.55, 0.06], 0.17, 0.21, 6, DARK, 0.7, 1, 0.05, 0.1);
    addBox(b, ID, -0.3, 1.46, -0.1, 0.3, 1.62, 0.12, DARK, 0.9, 1);
    addTube(b, [0, 1.58, 0.05], [0, 1.72, 0.14], 0.07, 0.06, 5, DARK, 0.9, 1, 0.1, 0.2);
    addBox(b, ID, -0.1, 1.68, 0.02, 0.1, 1.9, 0.26, DARK, 0.9, 1);
    // ragged cloak: triangles hanging from the shoulders (high sway at the hem)
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      const r = 0.3;
      const x0 = Math.cos(a) * r, z0 = Math.sin(a) * r * 0.7 - 0.05;
      const a1 = ((i + 1) / 7) * TAU;
      const x1 = Math.cos(a1) * r, z1 = Math.sin(a1) * r * 0.7 - 0.05;
      const xm = (x0 + x1) * 0.65, zm = (z0 + z1) * 0.65;
      const nx = Math.cos((a + a1) / 2), nz = Math.sin((a + a1) / 2);
      b.vert(x0, 1.5, z0, nx, 0, nz, DARK, 1, 0);
      b.vert(x1, 1.5, z1, nx, 0, nz, DARK, 1, 0);
      b.vert(xm, 0.25 + (i % 3) * 0.12, zm, nx, 0, nz, DARK, 0.6, 1);
    }
  }
  // boss: long quill-spikes sweeping back from the shoulders
  const rng = makeRng(77);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9 - 0.5) * 2.4;
    const ex = Math.sin(a) * 1.3, ey = 2.0 + rng() * 0.9, ez = -0.5 - Math.cos(a) * 0.8;
    addTube(boss, [Math.sin(a) * 0.25, 1.5, -0.05], [ex, ey, ez], 0.05, 0.008, 4, DARK, 0.8, 1, 0.1, 0.6);
  }
  addTube(boss, [0, 1.9, 0.1], [0, 2.35, 0.25], 0.03, 0.006, 4, DARK, 0.9, 1, 0.1, 0.4);
  return { walker: walker.data(), boss: boss.data() };
}

const DEFS = {
  walker: { shield: 100, hp: 38, speed: 2.0, radius: 0.45, height: 1.9, scale: 1.0, dmg: 18, reach: 1.5 },
  runner: { shield: 70, hp: 28, speed: 3.6, radius: 0.4, height: 1.8, scale: 0.95, dmg: 12, reach: 1.4 },
  boss: { shield: 520, hp: 240, speed: 1.7, radius: 1.0, height: 4.4, scale: 2.3, dmg: 32, reach: 3.3 },
};

export class Enemy {
  constructor(kind, x, z, y, rng) {
    const d = DEFS[kind];
    this.kind = kind;
    this.boss = kind === 'boss';
    this.x = x; this.z = z; this.y = y;
    this.yaw = 0;
    this.scale = d.scale;
    this.shieldMax = d.shield;
    this.shield = d.shield;
    this.hp = d.hp;
    this.speed = d.speed;
    this.radius = d.radius;
    this.height = d.height;
    this.dmg = d.dmg;
    this.reach = d.reach;
    this.state = 'appear';
    this.t = 0;
    this.chargeT = 0;
    this.flank = rng() < 0.5 ? -1 : 1;
    this.atkCool = 1.2;
    this.windup = 0;
    this.dissolve = 1;
    this.hit = 0;
    this.sinceHit = 9;
    this.dead = false;
    this.seed = rng() * 100;
    this.wob = rng() * TAU;
    this.whisperT = 1 + rng() * 3;
    this.announced = false;
  }

  get alive() { return this.state !== 'dying' && !this.dead; }

  _applyShield(amount, env) {
    if (this.shield <= 0) return;
    this.shield -= amount;
    this.hit = Math.min(1, this.hit + 0.2);
    if (this.shield <= 0) {
      this.shield = 0;
      this.state = this.boss ? 'stagger' : 'charge';
      this.t = 0;
      this.chargeT = this.boss ? 7 : 0;
      this.windup = 0;
      env.onEvent('shieldBreak', this);
    }
  }

  die(env) {
    if (this.state === 'dying' || this.dead) return;
    this.state = 'dying';
    this.t = 0;
    env.onKill(this);
  }

  update(dt, env) {
    const w = env.world, p = env.player;
    this.y = w.groundAt(this.x, this.z);
    this.hit = Math.max(0, this.hit - dt * 3);

    if (this.state === 'appear') {
      if (!this.announced) { this.announced = true; env.onEvent('appear', this); }
      this.t += dt;
      this.dissolve = clamp(1 - this.t / 1.1, 0, 1);
      if (this.t >= 1.1) { this.state = 'stalk'; this.dissolve = 0; }
      return;
    }
    if (this.state === 'dying') {
      this.t += dt;
      this.dissolve = clamp(this.t / 1.0, 0, 1);
      if (this.t >= 1.0) this.dead = true;
      return;
    }

    let dx = p.x - this.x, dz = p.z - this.z;
    const d = Math.hypot(dx, dz) + 1e-6;
    dx /= d; dz /= d;

    // ---- flashlight exposure
    const fl = env.fl;
    let beamHit = false;
    if (fl.on && fl.power > 0.05) {
      const cx = this.x, cy = this.y + this.height * 0.55, cz = this.z;
      const vx = cx - fl.pos[0], vy = cy - fl.pos[1], vz = cz - fl.pos[2];
      const dist = Math.hypot(vx, vy, vz) || 1;
      const cosA = (vx * fl.dir[0] + vy * fl.dir[1] + vz * fl.dir[2]) / dist;
      const ang = Math.acos(clamp(cosA, -1, 1));
      const beamAng = Math.acos(fl.cosOuter) + Math.atan2(this.radius, dist);
      if (ang < beamAng && dist < fl.range && !w.blocked(fl.pos[0], fl.pos[1], fl.pos[2], cx, cy, cz)) {
        beamHit = true;
        if (dist < env.beamDist) { env.beamTarget = this; env.beamDist = dist; }
        const dps = lerp(26, 90, fl.focus) * (1 - 0.6 * clamp(dist / fl.range, 0, 1)) * fl.power;
        this.sinceHit = 0;
        if (this.shield > 0) this._applyShield(dps * dt, env);
        else this.hp -= dps * 0.08 * dt;
        this.hit = Math.min(1, this.hit + dt * 6);
      }
    }
    this.sinceHit += dt;

    // ---- lamps, flares, lighthouse beam
    let ld = env.light.damageAt(this.x, this.y, this.z);
    if (this.boss) ld *= 0.6;
    if (ld > 0) {
      this.sinceHit = 0;
      if (this.shield > 0) this._applyShield(ld * 0.8 * dt, env);
      else { this.hp -= ld * dt; this.hit = 1; }
    }
    const bd = env.light.beaconDps(this.x, this.y + this.height * 0.5, this.z);
    if (bd > 0) {
      this.sinceHit = 0;
      if (this.shield > 0) this._applyShield(bd * 2.2 * dt, env);
      else { this.hp -= bd * dt; this.hit = 1; }
    }
    if (this.hp <= 0) { this.die(env); return; }

    // shield slowly knits back together when left alone
    if (this.shield > 0 && this.shield < this.shieldMax && this.sinceHit > 2.5) {
      this.shield = Math.min(this.shieldMax, this.shield + (this.boss ? 14 : 8) * dt);
    }

    // ---- state
    if (this.state === 'stagger') {
      this.t += dt;
      if (this.t > 1.8) { this.state = 'charge'; this.t = 0; }
    } else if (this.state === 'charge' && this.boss) {
      this.chargeT -= dt;
      if (this.chargeT <= 0) {
        this.state = 'stalk';
        this.shield = this.shieldMax * 0.5;
      }
    }

    // ---- movement
    let speed = this.speed;
    if (this.state === 'charge') speed *= 1.65;
    const seen = -(p.fwdX * dx + p.fwdZ * dz) > 0.35;
    if (!seen) speed *= 1.35;
    if (beamHit && this.shield > 0) speed *= 0.4;
    if (this.state === 'stagger') speed = 0;

    let ang = Math.atan2(dx, dz);
    if (this.state !== 'charge') {
      ang += this.flank * clamp((d - 7) / 20, 0, 1) * 0.95 * Math.sin(env.time * 0.5 + this.wob);
    }
    let mx = Math.sin(ang), mz = Math.cos(ang);

    if (this.state !== 'charge' && !this.boss) {
      const hv = env.light.havenNear(this.x, this.z, 1.5) || env.light.flareNear(this.x, this.z, 1.5);
      if (hv) {
        const ox = this.x - hv.x, oz = this.z - hv.z;
        const od = Math.hypot(ox, oz) || 1;
        const into = (mx * -ox + mz * -oz) / od;
        if (into > 0) {
          mx = (-oz / od) * this.flank * 0.9 + (ox / od) * 0.35;
          mz = (ox / od) * this.flank * 0.9 + (oz / od) * 0.35;
        }
      }
    }

    // ---- attack
    this.atkCool -= dt;
    if (this.windup > 0) {
      this.windup -= dt;
      speed *= 0.2;
      if (this.windup <= 0) {
        if (d < this.reach + 0.7) env.onHurt(this.dmg, this);
        this.atkCool = 1.3;
      }
    } else if (d < this.reach && this.atkCool <= 0 && this.state !== 'stagger') {
      this.windup = this.boss ? 0.8 : 0.6;
      env.onEvent('windup', this);
    }

    if (d > this.reach * 0.7) {
      const nx = this.x + mx * speed * dt, nz = this.z + mz * speed * dt;
      const out = env.tmp;
      w.colliders.resolve(nx, nz, this.boss ? 0.6 : this.radius, out);
      if (w.groundAt(out.x, out.z) >= w.waterY - 0.5) {
        this.x = clamp(out.x, -w.bound, w.bound);
        this.z = clamp(out.z, -w.bound, w.bound);
      }
    }

    const target = Math.atan2(dx, dz);
    this.yaw += wrapPi(target - this.yaw) * Math.min(1, dt * 6);

    this.whisperT -= dt;
    if (this.whisperT <= 0) {
      this.whisperT = 3 + Math.random() * 4;
      if (d < 40) env.onEvent('whisper', this);
    }
  }
}

export class EnemyManager {
  constructor() {
    this.list = [];
    this.rng = makeRng(1234);
    this.kills = 0;
    this.tmp = { x: 0, z: 0 };
  }

  reset() {
    this.list.length = 0;
    this.kills = 0;
  }

  clearAll() { this.list.length = 0; }

  spawn(kind, x, z, w) {
    const e = new Enemy(kind, x, z, w.groundAt(x, z), this.rng);
    this.list.push(e);
    return e;
  }

  _valid(w, light, x, z) {
    if (Math.abs(x) > w.bound || Math.abs(z) > w.bound) return false;
    if (w.groundAt(x, z) < w.waterY + 0.3) return false;
    if (light.havenNear(x, z, 3)) return false;
    w.colliders.resolve(x, z, 0.6, this.tmp);
    return Math.abs(this.tmp.x - x) < 0.01 && Math.abs(this.tmp.z - z) < 0.01;
  }

  // Spawn on a ring around the player, preferring spots behind them.
  spawnAround(w, player, light, kind, minD, maxD) {
    let x = player.x, z = player.z;
    for (let i = 0; i < 64; i++) {
      // facing = (sin yaw, -cos yaw); "behind" = (-sin yaw, +cos yaw), rotated by a random offset
      const o = i < 24 ? (this.rng() - 0.5) * 2.6 : this.rng() * TAU;
      // if the ring is blocked (lake, dense trees, map edge) the search tightens toward the player
      const shrink = i < 40 ? 1 : 0.75 - (i - 40) * 0.015;
      const r = lerp(minD, maxD, this.rng()) * shrink;
      const cx = player.x - Math.sin(player.yaw + o) * r;
      const cz = player.z + Math.cos(player.yaw + o) * r;
      x = cx; z = cz;
      if (this._valid(w, light, cx, cz)) break;
    }
    return this.spawn(kind, x, z, w);
  }

  spawnNear(w, light, kind, cx, cz, spread) {
    for (let i = 0; i < 30; i++) {
      const x = cx + (this.rng() - 0.5) * 2 * spread;
      const z = cz + (this.rng() - 0.5) * 2 * spread;
      if (this._valid(w, light, x, z)) return this.spawn(kind, x, z, w);
    }
    return null;
  }

  aliveCount() {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }

  nearestDist(x, z) {
    let best = 1e9;
    for (const e of this.list) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < best) best = d;
    }
    return best;
  }

  dissolveAll(env) {
    for (const e of this.list) if (e.alive) e.die(env);
  }

  update(dt, env) {
    env.tmp = this.tmp;
    for (const e of this.list) e.update(dt, env);
    // soft separation
    const L = this.list;
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const a = L[i], b = L[j];
        if (!a.alive || !b.alive) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const min = a.radius + b.radius + 0.3;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2), push = (min - d) * 0.5;
          a.x -= (dx / d) * push; a.z -= (dz / d) * push;
          b.x += (dx / d) * push; b.z += (dz / d) * push;
        }
      }
    }
    for (let i = L.length - 1; i >= 0; i--) if (L[i].dead) L.splice(i, 1);
  }
}
