// Procedural terrain: heightfield, vertex-baked soft shadows, water mesh and the collision grid.

import { clamp, lerp, smoothstep } from './math.js';
import { fbm2 } from './noise.js';

// --------------------------------------------------------------------------- colliders
// Static colliders on a spatial hash. Circles (trunks, rocks, poles) and oriented boxes (buildings).
export class ColliderGrid {
  constructor(cell = 12, half = 170) {
    this.cell = cell;
    this.half = half;
    this.cells = new Map();
    this.stamp = 1;
  }

  _idx(v) {
    return Math.floor((v + this.half) / this.cell);
  }

  _add(c, minx, minz, maxx, maxz) {
    const x0 = this._idx(minx), x1 = this._idx(maxx);
    const z0 = this._idx(minz), z1 = this._idx(maxz);
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const k = ix * 4096 + iz;
        let list = this.cells.get(k);
        if (!list) { list = []; this.cells.set(k, list); }
        list.push(c);
      }
    }
  }

  addCircle(x, z, r, h = 6) {
    const c = { t: 0, x, z, r, h, stamp: 0 };
    this._add(c, x - r, z - r, x + r, z + r);
    return c;
  }

  // Box centred at (x, z), half extents hx/hz in its local frame, rotated by yaw
  // (same convention as props.makeXf: world = centre + R(yaw) * local).
  addBox(x, z, hx, hz, yaw, h = 4) {
    const c = { t: 1, x, z, hx, hz, c: Math.cos(yaw), s: Math.sin(yaw), h, stamp: 0 };
    const br = Math.hypot(hx, hz);
    this._add(c, x - br, z - br, x + br, z + br);
    return c;
  }

  // Pushes the point (x, z) with radius r out of every nearby collider. Writes into `out`.
  resolve(x, z, r, out) {
    for (let pass = 0; pass < 2; pass++) {
      this.stamp++;
      const x0 = this._idx(x - r), x1 = this._idx(x + r);
      const z0 = this._idx(z - r), z1 = this._idx(z + r);
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const list = this.cells.get(ix * 4096 + iz);
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const c = list[i];
            if (c.stamp === this.stamp) continue;
            c.stamp = this.stamp;
            if (c.t === 0) {
              const dx = x - c.x, dz = z - c.z;
              const min = c.r + r;
              const d2 = dx * dx + dz * dz;
              if (d2 < min * min) {
                const d = Math.sqrt(d2) || 0.0001;
                const push = min - d;
                x += (dx / d) * push;
                z += (dz / d) * push;
              }
            } else {
              const dx = x - c.x, dz = z - c.z;
              const lx = c.c * dx - c.s * dz;
              const lz = c.s * dx + c.c * dz;
              const qx = clamp(lx, -c.hx, c.hx), qz = clamp(lz, -c.hz, c.hz);
              let ox = lx - qx, oz = lz - qz;
              const d = Math.hypot(ox, oz);
              let px = 0, pz = 0;
              if (d > 0.00001) {
                if (d < r) { px = (ox / d) * (r - d); pz = (oz / d) * (r - d); }
              } else {
                // centre is inside the box: push out through the nearest face
                const ex = c.hx - Math.abs(lx), ez = c.hz - Math.abs(lz);
                if (ex < ez) px = (lx >= 0 ? 1 : -1) * (ex + r);
                else pz = (lz >= 0 ? 1 : -1) * (ez + r);
              }
              if (px !== 0 || pz !== 0) {
                x += px * c.c + pz * c.s;
                z += -px * c.s + pz * c.c;
              }
            }
          }
        }
      }
    }
    out.x = x;
    out.z = z;
    return out;
  }

  // True if the point lies inside a collider whose height reaches `y` above `ground`.
  hitsPoint(x, z, y, ground) {
    const list = this.cells.get(this._idx(x) * 4096 + this._idx(z));
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (y > ground + c.h) continue;
      if (c.t === 0) {
        const dx = x - c.x, dz = z - c.z;
        if (dx * dx + dz * dz < c.r * c.r) return true;
      } else {
        const dx = x - c.x, dz = z - c.z;
        const lx = c.c * dx - c.s * dz;
        const lz = c.s * dx + c.c * dz;
        if (Math.abs(lx) < c.hx && Math.abs(lz) < c.hz) return true;
      }
    }
    return false;
  }
}

// --------------------------------------------------------------------------- heightfield
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export function makeTerrain(cfg) {
  const size = cfg.size || 300;
  const N = Math.min(cfg.res || 192, 254); // indices are Uint16: (N + 1)^2 vertices must stay below 65536
  const cell = size / N;
  const half = size / 2;
  const seed = cfg.seed || 1;
  const W = N + 1;
  const path = cfg.path || [];
  const pathW = cfg.pathW || 3.2;
  const waterY = cfg.waterY === undefined ? -1e9 : cfg.waterY;

  const pathDist = (x, z) => {
    let best = 1e9;
    for (let i = 0; i + 1 < path.length; i++) {
      const ax = path[i][0], az = path[i][1];
      const bx = path[i + 1][0], bz = path[i + 1][1];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < best) best = d;
    }
    return best;
  };

  const f = cfg.hillFreq === undefined ? 0.012 : cfg.hillFreq;
  const raw = (x, z) => {
    let base = cfg.base || 0;
    if (cfg.ramp) {
      const r = cfg.ramp;
      const t = clamp((z - r.z0) / (r.z1 - r.z0), 0, 1);
      base += t * t * (3 - 2 * t) * r.h;
    }
    let h = (fbm2(x * f, z * f, 4, seed) - 0.5) * 2 * (cfg.hillAmp === undefined ? 8 : cfg.hillAmp);
    h += (fbm2(x * f * 5.3, z * f * 5.3, 3, seed + 11) - 0.5) * (cfg.detailAmp === undefined ? 1.2 : cfg.detailAmp);
    h += base;
    if (path.length > 1) {
      const pd = pathDist(x, z);
      const pw = 1 - smoothstep(pathW * 0.5, pathW * 3.2, pd);
      h = lerp(h, base + (h - base) * 0.22, pw * 0.9);
    }
    if (cfg.flats) {
      for (const fl of cfg.flats) {
        const d = Math.hypot(x - fl.x, z - fl.z);
        const w = 1 - smoothstep(fl.r, fl.r + (fl.fall === undefined ? fl.r * 0.6 : fl.fall), d);
        if (w > 0) h = lerp(h, fl.h, w);
      }
    }
    if (cfg.lakes) {
      for (const lk of cfg.lakes) {
        const d = Math.hypot(x - lk.x, z - lk.z);
        const t = smoothstep(lk.r * 1.12, lk.r * 0.55, d);
        if (t > 0) h = lerp(h, lk.bed + (fbm2(x * 0.05, z * 0.05, 2, seed + 3) - 0.5) * 1.2, t);
      }
    }
    const e = Math.max(Math.abs(x), Math.abs(z)) / half;
    const rim = smoothstep(cfg.rimStart === undefined ? 0.93 : cfg.rimStart, 1.0, e);
    h += rim * rim * (cfg.rimH === undefined ? 45 : cfg.rimH);
    return h;
  };

  const H = new Float32Array(W * W);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      H[j * W + i] = raw(-half + i * cell, -half + j * cell);
    }
  }

  // Triangle-exact sampling matching the index order used by buildTerrainMesh.
  const heightAt = (x, z) => {
    let gx = (x + half) / cell, gz = (z + half) / cell;
    if (gx < 0) gx = 0; else if (gx > N - 0.0001) gx = N - 0.0001;
    if (gz < 0) gz = 0; else if (gz > N - 0.0001) gz = N - 0.0001;
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const h00 = H[j * W + i], h10 = H[j * W + i + 1];
    const h01 = H[(j + 1) * W + i], h11 = H[(j + 1) * W + i + 1];
    if (fx + fz <= 1) return h00 + fx * (h10 - h00) + fz * (h01 - h00);
    return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
  };

  return { size, N, W, cell, half, H, cfg, seed, waterY, pathW, pathDist, heightAt };
}

// --------------------------------------------------------------------------- mesh
// Vertex layout matches gl.LIT_LAYOUT: pos3 nrm3 col3 ao1 sway1.
export function buildTerrainMesh(T, opts) {
  const { N, W, cell, half, H, cfg } = T;
  const pal = cfg.palette;
  const moon = opts.moonDir;
  const hl = Math.hypot(moon[0], moon[2]) || 0.0001;
  const hx = moon[0] / hl, hz = moon[2] / hl;
  const tanE = Math.max(moon[1] / hl, 0.12);

  const shadow = new Float32Array(W * W); // 0 = lit, 1 = fully shadowed

  // Terrain self-shadowing: march toward the moon across the heightfield.
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const x = -half + i * cell, z = -half + j * cell;
      const h0 = H[j * W + i];
      let occ = 0;
      for (let s = 1.5; s < 90; s *= 1.22) {
        const hs = T.heightAt(x + hx * s, z + hz * s);
        const rayH = h0 + s * tanE + 0.3;
        const o = smoothstep(-0.4, 1.2, hs - rayH);
        if (o > occ) occ = o;
        if (occ >= 0.999) break;
      }
      shadow[j * W + i] = occ;
    }
  }

  // Stamp soft shadows and canopy darkening from occluders (trees, buildings).
  const stamp = (cx, cz, rad, strength) => {
    const i0 = Math.max(0, Math.floor((cx - rad + half) / cell));
    const i1 = Math.min(N, Math.ceil((cx + rad + half) / cell));
    const j0 = Math.max(0, Math.floor((cz - rad + half) / cell));
    const j1 = Math.min(N, Math.ceil((cz + rad + half) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(-half + i * cell - cx, -half + j * cell - cz);
        const a = strength * (1 - smoothstep(rad * 0.35, rad, d));
        const k = j * W + i;
        if (a > shadow[k]) shadow[k] = a;
      }
    }
  };
  for (const o of opts.occluders || []) {
    const len = Math.min(o.h / tanE, 26);
    for (let t = 0.15; t <= 1.0; t += 0.28) {
      stamp(o.x - hx * len * t, o.z - hz * len * t, o.r * (1.15 - 0.4 * t) + 0.6, 0.78);
    }
    stamp(o.x, o.z, Math.max(o.r * 0.9, 1.6), 0.4);
  }

  const verts = new Float32Array(W * W * 11);
  const waterY = T.waterY;
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const x = -half + i * cell, z = -half + j * cell, h = H[k];
      const hxm = H[j * W + Math.max(i - 1, 0)], hxp = H[j * W + Math.min(i + 1, N)];
      const hzm = H[Math.max(j - 1, 0) * W + i], hzp = H[Math.min(j + 1, N) * W + i];
      let nx = (hxm - hxp) / (2 * cell), nz = (hzm - hzp) / (2 * cell), ny = 1;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl; ny /= nl; nz /= nl;

      // material
      const slope = 1 - ny;
      const n = fbm2(x * 0.05, z * 0.05, 3, T.seed + 3);
      const pd = T.pathDist(x, z);
      let c = mix3(pal.ground, pal.ground2, n);
      c = mix3(c, pal.path, (1 - smoothstep(T.pathW * 0.35, T.pathW * 0.95, pd)) * 0.9);
      c = mix3(c, pal.rock, smoothstep(0.16, 0.4, slope));
      if (waterY > -1e8) {
        const d = h - waterY;
        c = mix3(c, pal.shore, (1 - smoothstep(0.0, 1.4, d)) * 0.85);
      }
      if (opts.tint) c = mix3(c, opts.tint(x, z, h), 1);

      const o = k * 11;
      verts[o] = x; verts[o + 1] = h; verts[o + 2] = z;
      verts[o + 3] = nx; verts[o + 4] = ny; verts[o + 5] = nz;
      verts[o + 6] = c[0]; verts[o + 7] = c[1]; verts[o + 8] = c[2];
      verts[o + 9] = 1 - 0.85 * shadow[k];
      verts[o + 10] = 0;
    }
  }

  const idx = new Uint16Array(N * N * 6);
  let p = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v00 = j * W + i, v10 = v00 + 1, v01 = v00 + W, v11 = v01 + 1;
      idx[p++] = v00; idx[p++] = v01; idx[p++] = v10;
      idx[p++] = v10; idx[p++] = v01; idx[p++] = v11;
    }
  }
  return { vertices: verts, indices: idx };
}

// Water surface on the same grid. Vertex layout: pos3 depth1. Only cells near water are emitted.
export function buildWaterMesh(T) {
  if (T.waterY < -1e8) return null;
  const { N, W, cell, half, H } = T;
  const wy = T.waterY;
  const verts = new Float32Array(W * W * 4);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      verts[k * 4] = -half + i * cell;
      verts[k * 4 + 1] = wy;
      verts[k * 4 + 2] = -half + j * cell;
      verts[k * 4 + 3] = wy - H[k];
    }
  }
  const list = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v00 = j * W + i, v10 = v00 + 1, v01 = v00 + W, v11 = v01 + 1;
      const dmax = Math.max(wy - H[v00], wy - H[v10], wy - H[v01], wy - H[v11]);
      if (dmax > -0.4) list.push(v00, v01, v10, v10, v01, v11);
    }
  }
  if (!list.length) return null;
  return { vertices: verts, indices: new Uint16Array(list) };
}
