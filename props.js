// Procedural geometry: mesh builder plus pines, rocks, grass, buildings, lamps, docks, the lighthouse...
// Everything is generated in code. Vertex layout: pos3 nrm3 col3 ao1 sway1 (see gl.LIT_LAYOUT).

import { TAU, clamp } from './math.js';
import { makeLamp } from './light.js';

export class MeshBuilder {
  constructor() {
    this.buf = new Float32Array(11 * 8192);
    this.n = 0;
  }
  get count() { return this.n / 11; }
  vert(px, py, pz, nx, ny, nz, c, ao, sw) {
    if (this.n + 11 > this.buf.length) {
      const nb = new Float32Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    const b = this.buf, i = this.n;
    b[i] = px; b[i + 1] = py; b[i + 2] = pz;
    b[i + 3] = nx; b[i + 4] = ny; b[i + 5] = nz;
    b[i + 6] = c[0]; b[i + 7] = c[1]; b[i + 8] = c[2];
    b[i + 9] = ao; b[i + 10] = sw;
    this.n += 11;
  }
  data() { return this.buf.slice(0, this.n); }
}

// Splits an interleaved triangle list (11 floats per vertex) into square ground chunks, assigning each
// triangle by its centroid, so the renderer can frustum- and distance-cull whole chunks.
// Returns [{ data: Float32Array, count, min: [x, y, z], max: [x, y, z] }].
export function chunkMesh(data, cell, half) {
  if (!data || data.length < 33) return [];
  const TRI = 33;
  const triCount = Math.floor(data.length / TRI);
  const nC = Math.max(1, Math.ceil((half * 2) / cell));
  const bins = new Map();
  for (let t = 0; t < triCount; t++) {
    const o = t * TRI;
    const cx = (data[o] + data[o + 11] + data[o + 22]) / 3;
    const cz = (data[o + 2] + data[o + 13] + data[o + 24]) / 3;
    const ix = clamp(Math.floor((cx + half) / cell), 0, nC - 1);
    const iz = clamp(Math.floor((cz + half) / cell), 0, nC - 1);
    const k = iz * nC + ix;
    let list = bins.get(k);
    if (!list) { list = []; bins.set(k, list); }
    list.push(t);
  }
  const out = [];
  for (const tris of bins.values()) {
    const arr = new Float32Array(tris.length * TRI);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tris.length; i++) {
      const o = tris[i] * TRI;
      arr.set(data.subarray(o, o + TRI), i * TRI);
      for (let v = 0; v < 3; v++) {
        const q = o + v * 11;
        for (let a = 0; a < 3; a++) {
          const val = data[q + a];
          if (val < min[a]) min[a] = val;
          if (val > max[a]) max[a] = val;
        }
      }
    }
    out.push({ data: arr, count: tris.length * 3, min, max });
  }
  return out;
}

// Local frame -> world: origin (ox, oy, oz) and rotation about Y.
export function makeXf(ox, oy, oz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    ox, oy, oz, c, s, yaw,
    p(lx, ly, lz) { return [ox + lx * c + lz * s, oy + ly, oz - lx * s + lz * c]; },
    n(nx, ny, nz) { return [nx * c + nz * s, ny, -nx * s + nz * c]; },
  };
}
const ID = makeXf(0, 0, 0, 0);

const pick = (v, i) => (typeof v === 'number' ? v : v[i]);

function flatNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

function tri(b, p0, p1, p2, n, c, ao, sw) {
  b.vert(p0[0], p0[1], p0[2], n[0], n[1], n[2], c, pick(ao, 0), pick(sw, 0));
  b.vert(p1[0], p1[1], p1[2], n[0], n[1], n[2], c, pick(ao, 1), pick(sw, 1));
  b.vert(p2[0], p2[1], p2[2], n[0], n[1], n[2], c, pick(ao, 2), pick(sw, 2));
}

function quad(b, p0, p1, p2, p3, n, c, ao, sw) {
  tri(b, p0, p1, p2, n, c, [pick(ao, 0), pick(ao, 1), pick(ao, 2)], [pick(sw, 0), pick(sw, 1), pick(sw, 2)]);
  tri(b, p0, p2, p3, n, c, [pick(ao, 0), pick(ao, 2), pick(ao, 3)], [pick(sw, 0), pick(sw, 2), pick(sw, 3)]);
}

// Axis-aligned (in local frame) box. The bottom face is omitted.
export function addBox(b, T, x0, y0, z0, x1, y1, z1, col, aoB = 0.6, aoT = 1.0) {
  const faces = [
    [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0]],
    [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [-1, 0, 0]],
    [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]],
    [[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [0, 0, 1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]],
  ];
  for (const f of faces) {
    const q = [];
    const ao = [];
    for (let i = 0; i < 4; i++) {
      q.push(T.p(f[i][0], f[i][1], f[i][2]));
      ao.push(f[i][1] === y0 ? aoB : aoT);
    }
    quad(b, q[0], q[1], q[2], q[3], T.n(f[4][0], f[4][1], f[4][2]), col, ao, 0);
  }
}

// Vertical tapered cylinder (smooth side normals).
export function addCyl(b, T, cx, cy, cz, r0, r1, h, seg, col, aoB = 0.6, aoT = 1.0, swTop = 0, cap = true) {
  const slope = (r0 - r1) / h;
  const nl = Math.hypot(1, slope);
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * TAU, a1 = ((k + 1) / seg) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const b0 = T.p(cx + c0 * r0, cy, cz + s0 * r0), b1 = T.p(cx + c1 * r0, cy, cz + s1 * r0);
    const t0 = T.p(cx + c0 * r1, cy + h, cz + s0 * r1), t1 = T.p(cx + c1 * r1, cy + h, cz + s1 * r1);
    const n0 = T.n(c0 / nl, slope / nl, s0 / nl), n1 = T.n(c1 / nl, slope / nl, s1 / nl);
    b.vert(b0[0], b0[1], b0[2], n0[0], n0[1], n0[2], col, aoB, 0);
    b.vert(b1[0], b1[1], b1[2], n1[0], n1[1], n1[2], col, aoB, 0);
    b.vert(t1[0], t1[1], t1[2], n1[0], n1[1], n1[2], col, aoT, swTop);
    b.vert(b0[0], b0[1], b0[2], n0[0], n0[1], n0[2], col, aoB, 0);
    b.vert(t1[0], t1[1], t1[2], n1[0], n1[1], n1[2], col, aoT, swTop);
    b.vert(t0[0], t0[1], t0[2], n0[0], n0[1], n0[2], col, aoT, swTop);
    if (cap && r1 > 0.001) {
      const c = T.p(cx, cy + h, cz), nn = T.n(0, 1, 0);
      b.vert(c[0], c[1], c[2], nn[0], nn[1], nn[2], col, aoT, swTop);
      b.vert(t0[0], t0[1], t0[2], nn[0], nn[1], nn[2], col, aoT, swTop);
      b.vert(t1[0], t1[1], t1[2], nn[0], nn[1], nn[2], col, aoT, swTop);
    }
  }
}

// Tube between two world-space points (branches, limbs, poles).
export function addTube(b, a, c, r0, r1, seg, col, ao0 = 0.7, ao1 = 1.0, sw0 = 0, sw1 = 0) {
  let dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2];
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl; dy /= dl; dz /= dl;
  let ux, uy, uz;
  if (Math.abs(dy) < 0.95) { ux = dz; uy = 0; uz = -dx; } else { ux = 0; uy = -dz; uz = dy; }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * TAU, a1 = ((k + 1) / seg) * TAU;
    const o0 = [ux * Math.cos(a0) + vx * Math.sin(a0), uy * Math.cos(a0) + vy * Math.sin(a0), uz * Math.cos(a0) + vz * Math.sin(a0)];
    const o1 = [ux * Math.cos(a1) + vx * Math.sin(a1), uy * Math.cos(a1) + vy * Math.sin(a1), uz * Math.cos(a1) + vz * Math.sin(a1)];
    const P = (o, base, r) => [base[0] + o[0] * r, base[1] + o[1] * r, base[2] + o[2] * r];
    const A0 = P(o0, a, r0), A1 = P(o1, a, r0), C0 = P(o0, c, r1), C1 = P(o1, c, r1);
    b.vert(A0[0], A0[1], A0[2], o0[0], o0[1], o0[2], col, ao0, sw0);
    b.vert(A1[0], A1[1], A1[2], o1[0], o1[1], o1[2], col, ao0, sw0);
    b.vert(C1[0], C1[1], C1[2], o1[0], o1[1], o1[2], col, ao1, sw1);
    b.vert(A0[0], A0[1], A0[2], o0[0], o0[1], o0[2], col, ao0, sw0);
    b.vert(C1[0], C1[1], C1[2], o1[0], o1[1], o1[2], col, ao1, sw1);
    b.vert(C0[0], C0[1], C0[2], o0[0], o0[1], o0[2], col, ao1, sw1);
  }
}

// Gabled roof with the ridge along local X.
export function addGable(b, T, x0, z0, x1, z1, yBase, rise, over, col) {
  const zc = (z0 + z1) / 2;
  const xa = x0 - over, xb = x1 + over;
  const zf = z1 + over, zb = z0 - over;
  const half = zf - zc;
  const nf = T.n(0, half / Math.hypot(half, rise), rise / Math.hypot(half, rise));
  const nb = T.n(0, half / Math.hypot(half, rise), -rise / Math.hypot(half, rise));
  const yr = yBase + rise;
  quad(b, T.p(xa, yBase, zf), T.p(xb, yBase, zf), T.p(xb, yr, zc), T.p(xa, yr, zc), nf, col, [0.8, 0.8, 1, 1], 0);
  quad(b, T.p(xb, yBase, zb), T.p(xa, yBase, zb), T.p(xa, yr, zc), T.p(xb, yr, zc), nb, col, [0.8, 0.8, 1, 1], 0);
  tri(b, T.p(x1, yBase, z0), T.p(x1, yBase, z1), T.p(x1, yr, zc), T.n(1, 0, 0), col, 0.8, 0);
  tri(b, T.p(x0, yBase, z1), T.p(x0, yBase, z0), T.p(x0, yr, zc), T.n(-1, 0, 0), col, 0.8, 0);
}

// ----------------------------------------------------------------------- vegetation & rocks
export function addPine(b, x, y, z, h, rng) {
  const tr = 0.15 + h * 0.01;
  const bark = [0.05 + rng() * 0.02, 0.035, 0.025];
  addCyl(b, ID, x, y - 0.3, z, tr * 1.25, tr * 0.45, h * 0.72, 5, bark, 0.5, 0.9, 0.03, false);
  // Layered, spiky tiers: the rim alternates long drooping tips and short notches so the silhouette reads as
  // needles against the sky. Tips are darker, the crown is paler, as if frosted by the moon.
  const tiers = 6;
  const g0 = 0.016 + rng() * 0.012, g1 = 0.042 + rng() * 0.016, g2 = 0.03 + rng() * 0.012;
  const swAt = (yy) => Math.pow(Math.max((yy - y) / h, 0), 1.6) * 0.22;
  const seg = 10;
  const rim = [];
  for (let k = 0; k < seg; k++) rim.push([0, 0, 0, 0]);
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const baseY = y + h * (0.13 + 0.14 * t);
    const H = h * (0.27 - 0.022 * t);
    const R = h * 0.2 * (1 - f * 0.8) + 0.3;
    const apexY = baseY + H;
    const off = rng() * TAU;
    for (let k = 0; k < seg; k++) {
      const a = off + (k / seg) * TAU;
      const tip = (k & 1) === 0;
      const r = R * (tip ? 1.0 + 0.2 * rng() : 0.5 + 0.14 * rng());
      const ry = baseY - (tip ? 0.14 * R : -0.04 * R);
      rim[k][0] = x + Math.cos(a) * r;
      rim[k][1] = ry;
      rim[k][2] = z + Math.sin(a) * r;
      rim[k][3] = r;
    }
    const dark = [g0 * 0.7, g1 * 0.7, g2 * 0.7];
    const crown = [g0 * 1.5 + 0.004, g1 * 1.55 + 0.008, g2 * 1.6 + 0.014];
    const aoB = 0.45 + 0.15 * f, aoA = 0.85;
    const apx = x, apz = z;
    for (let k = 0; k < seg; k++) {
      const p0 = rim[k], p1 = rim[(k + 1) % seg];
      // outward facet normal of the triangle (p1, p0, apex)
      const ax = p0[0] - p1[0], ay = p0[1] - p1[1], az = p0[2] - p1[2];
      const bx = apx - p1[0], by = apexY - p1[1], bz = apz - p1[2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      b.vert(p1[0], p1[1], p1[2], nx, ny, nz, dark, aoB, swAt(p1[1]));
      b.vert(p0[0], p0[1], p0[2], nx, ny, nz, dark, aoB, swAt(p0[1]));
      b.vert(apx, apexY, apz, nx, ny, nz, crown, aoA, swAt(apexY));
    }
  }
}

export function addDeadTree(b, x, y, z, h, rng) {
  const col = [0.07 + rng() * 0.02, 0.06, 0.055];
  addCyl(b, ID, x, y - 0.2, z, 0.28, 0.07, h, 5, col, 0.55, 0.95, 0.02, true);
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const by = y + h * (0.35 + 0.14 * i);
    const len = 1.2 + rng() * 1.6;
    const sx = x + Math.cos(a) * 0.05, sz = z + Math.sin(a) * 0.05;
    const ex = x + Math.cos(a) * len, ez = z + Math.sin(a) * len, ey = by + 0.6 + rng() * 0.9;
    addTube(b, [sx, by, sz], [ex, ey, ez], 0.08, 0.025, 4, col, 0.7, 1, 0, 0.04);
    const a2 = a + (rng() - 0.5) * 1.2;
    addTube(b, [ex, ey, ez], [ex + Math.cos(a2) * 0.9, ey + 0.5, ez + Math.sin(a2) * 0.9], 0.03, 0.01, 3, col, 0.8, 1, 0.03, 0.06);
  }
}

export function addRock(b, x, y, z, r, rng, col) {
  const rings = 4, seg = 6;
  const rad = [];
  for (let i = 0; i <= rings; i++) {
    const row = [];
    for (let k = 0; k < seg; k++) row.push(r * (0.72 + 0.5 * rng()));
    rad.push(row);
  }
  const P = (i, k) => {
    const th = (i / rings) * Math.PI, ph = ((k % seg) / seg) * TAU;
    const rr = (i === 0 || i === rings) ? r * 0.8 : rad[i][k % seg];
    return [x + rr * Math.sin(th) * Math.cos(ph), y + r * 0.2 + rr * Math.cos(th) * 0.65, z + rr * Math.sin(th) * Math.sin(ph)];
  };
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < seg; k++) {
      const a = P(i, k), bq = P(i + 1, k), c = P(i + 1, k + 1), d = P(i, k + 1);
      const shade = [col[0] * (0.85 + 0.3 * rng()), col[1] * (0.85 + 0.3 * rng()), col[2] * (0.85 + 0.3 * rng())];
      tri(b, a, bq, c, flatNormal(a, bq, c), shade, i === 0 ? 1 : 0.7, 0);
      tri(b, a, c, d, flatNormal(a, c, d), shade, i === 0 ? 1 : 0.7, 0);
    }
  }
}

export function addGrass(b, x, y, z, h, rng, col) {
  for (let i = 0; i < 3; i++) {
    const a = rng() * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    const bw = 0.035 * (0.7 + h);
    const lean = 0.25 * h * (0.5 + rng());
    const la = rng() * TAU;
    const px = x + (rng() - 0.5) * 0.25, pz = z + (rng() - 0.5) * 0.25;
    const dark = [col[0] * 0.45, col[1] * 0.45, col[2] * 0.45];
    b.vert(px - sa * bw, y, pz + ca * bw, 0, 1, 0, dark, 0.55, 0);
    b.vert(px + sa * bw, y, pz - ca * bw, 0, 1, 0, dark, 0.55, 0);
    b.vert(px + Math.cos(la) * lean, y + h, pz + Math.sin(la) * lean, 0, 1, 0, col, 1, 0.12 + 0.1 * h);
  }
}

export function addStump(w, x, z) {
  const y = w.groundAt(x, z);
  addCyl(w.lit, ID, x, y - 0.1, z, 0.62, 0.5, 0.95, 8, [0.06, 0.045, 0.032], 0.6, 0.9, 0, true);
  w.colliders.addCircle(x, z, 0.6, 1);
  return y + 0.95;
}

// ----------------------------------------------------------------------- lamps & structures
// `w` is the chapter world (see chapters.js): lit, emisB(), colliders, platforms, lamps, groundAt, waterY.
const METAL = [0.03, 0.032, 0.036];

export function addLampPost(w, x, z, o = {}) {
  const y = o.baseY !== undefined ? o.baseY : w.groundAt(x, z);
  addBox(w.lit, ID, x - 0.06, y - 0.2, z - 0.06, x + 0.06, y + 4.0, z + 0.06, METAL, 0.5, 0.9);
  addBox(w.lit, ID, x - 0.28, y + 4.0, z - 0.28, x + 0.28, y + 4.14, z + 0.28, METAL, 0.8, 1);
  addBox(w.lit, ID, x - 0.12, y + 3.9, z - 0.12, x + 0.12, y + 4.0, z + 0.12, [0.05, 0.045, 0.04], 1, 1);
  w.colliders.addCircle(x, z, 0.2, 4);
  const lamp = makeLamp({
    name: o.name, x, y: y + 3.8, z,
    radius: o.radius === undefined ? 8 : o.radius,
    on: o.on, intensity: o.intensity, color: o.color, haven: o.haven, glow: o.glow,
  });
  w.lamps.push(lamp);
  w.clear.push({ x, z, r: 1.5 });
  return lamp;
}

export function addCabin(w, x, z, yaw, o = {}) {
  const name = o.name || 'cabin';
  const grp = o.group || 'cabin';
  const y0 = w.groundAt(x, z);
  const T = makeXf(x, 0, z, yaw);
  const log = [0.075, 0.048, 0.03], roof = [0.035, 0.032, 0.034], deck = [0.06, 0.045, 0.035];
  addBox(w.lit, T, -3.5, y0 - 0.5, -2.75, 3.5, y0 + 2.7, 2.75, log, 0.5, 1);
  addGable(w.lit, T, -3.5, -2.75, 3.5, 2.75, y0 + 2.7, 1.6, 0.5, roof);
  addBox(w.lit, T, -3.5, y0 - 0.5, 2.75, 3.5, y0 + 0.3, 4.8, deck, 0.6, 1);
  addBox(w.lit, T, -3.5, y0 + 2.6, 2.75, 3.5, y0 + 2.72, 5.0, roof, 0.8, 1);
  addBox(w.lit, T, -3.4, y0 + 0.3, 4.65, -3.2, y0 + 2.6, 4.85, log, 0.6, 1);
  addBox(w.lit, T, 3.2, y0 + 0.3, 4.65, 3.4, y0 + 2.6, 4.85, log, 0.6, 1);
  addBox(w.lit, T, 2.2, y0 + 2.0, -2.2, 3.1, y0 + 4.3, -1.3, [0.08, 0.075, 0.07], 0.6, 1);
  addBox(w.lit, T, -1.5, y0 + 0.3, 2.74, -0.5, y0 + 2.3, 2.8, [0.03, 0.02, 0.015], 0.8, 1);
  const E = w.emisB(grp);
  const glow = [3.0, 1.9, 0.9];
  addBox(E, T, 1.2, y0 + 0.95, 2.76, 2.9, y0 + 1.95, 2.82, glow, 1, 1);
  addBox(E, T, -3.2, y0 + 0.95, 2.76, -2.0, y0 + 1.95, 2.82, glow, 1, 1);
  addBox(E, T, -3.56, y0 + 0.95, -0.8, -3.5, y0 + 1.95, 0.7, glow, 1, 1);
  const c = T.p(0, 0, 0);
  w.colliders.addBox(c[0], c[2], 3.7, 2.95, yaw, 5);
  const pc = T.p(0, 0, 3.775);
  w.platforms.push({ x: pc[0], z: pc[2], hx: 3.5, hz: 1.025, c: Math.cos(yaw), s: Math.sin(yaw), y: y0 + 0.3 });
  const lp = T.p(-3.0, y0 + 2.3, 4.5);
  const porch = makeLamp({ name: name + 'Porch', x: lp[0], y: lp[1], z: lp[2], radius: 10, intensity: 5, on: o.on, haven: true });
  const li = T.p(0, y0 + 1.6, 0.8);
  const inner = makeLamp({ name: name + 'In', x: li[0], y: li[1], z: li[2], radius: 9, intensity: 3.2, on: o.on, haven: false, glow: 0 });
  w.lamps.push(porch, inner);
  const door = T.p(-1.0, 0, 5.4);
  w.clear.push({ x: c[0], z: c[2], r: 8 });
  w.occluders.push({ x: c[0], z: c[2], h: 4.2, r: 4.0 });
  return { door: { x: door[0], z: door[2] }, porch, inner, center: { x: c[0], z: c[2] } };
}

export function addCar(w, x, z, yaw, o = {}) {
  const y = w.groundAt(x, z);
  const T = makeXf(x, 0, z, yaw);
  const body = o.color || [0.04, 0.07, 0.08];
  addBox(w.lit, T, -0.9, y + 0.35, -2.3, 0.9, y + 0.95, 2.3, body, 0.5, 1);
  addBox(w.lit, T, -0.8, y + 0.95, -1.0, 0.8, y + 1.5, 1.1, [0.02, 0.03, 0.035], 0.7, 1);
  for (const sx of [-1, 1]) {
    for (const sz of [-1.4, 1.4]) {
      addTube(w.lit, T.p(sx * 0.92, y + 0.33, sz), T.p(sx * 0.74, y + 0.33, sz), 0.33, 0.33, 8, [0.015, 0.015, 0.016], 0.6, 0.8, 0, 0);
    }
  }
  if (!o.noLights) {
    const E = w.emisB(o.group || 'car');
    addBox(E, T, -0.75, y + 0.6, 2.3, -0.4, y + 0.8, 2.34, [4.0, 3.8, 3.2], 1, 1);
    addBox(E, T, 0.4, y + 0.6, 2.3, 0.75, y + 0.8, 2.34, [4.0, 3.8, 3.2], 1, 1);
    const lp = T.p(0, y + 0.8, 3.4);
    w.lamps.push(makeLamp({ name: o.name || 'carLights', x: lp[0], y: lp[1], z: lp[2], radius: 11, intensity: 4, color: [1.0, 0.95, 0.8], haven: false, glow: 0.4 }));
  }
  const c = T.p(0, 0, 0);
  w.colliders.addBox(c[0], c[2], 1.0, 2.4, yaw, 1.6);
  w.clear.push({ x: c[0], z: c[2], r: 3.5 });
}

export function addGate(w, x, z, yaw) {
  const y = w.groundAt(x, z);
  const T = makeXf(x, 0, z, yaw);
  const wood = [0.05, 0.035, 0.026];
  addBox(w.lit, T, -2.75, y - 0.2, -0.17, -2.4, y + 3.0, 0.17, wood, 0.5, 1);
  addBox(w.lit, T, 2.4, y - 0.2, -0.17, 2.75, y + 3.0, 0.17, wood, 0.5, 1);
  addBox(w.lit, T, -2.75, y + 2.75, -0.12, 2.75, y + 3.0, 0.12, wood, 0.8, 1);
  addBox(w.emisB('gate'), T, -0.5, y + 2.2, -0.08, 0.5, y + 2.6, 0.08, [2.2, 1.0, 0.4], 1, 1);
  for (const sx of [-2.6, 2.6]) {
    const p = T.p(sx, 0, 0);
    w.colliders.addCircle(p[0], p[2], 0.4, 3);
  }
  const lp = T.p(0, y + 2.0, 2.0);
  w.lamps.push(makeLamp({ name: 'gateLamp', x: lp[0], y: lp[1], z: lp[2], radius: 9, intensity: 4.5 }));
  w.clear.push({ x, z, r: 6 });
}

export function addPowerPole(w, x, z, yaw) {
  const y = w.groundAt(x, z);
  const T = makeXf(x, 0, z, yaw);
  addBox(w.lit, T, -0.12, y - 0.3, -0.12, 0.12, y + 8.5, 0.12, [0.06, 0.045, 0.035], 0.5, 0.9);
  addBox(w.lit, T, -1.3, y + 7.6, -0.07, 1.3, y + 7.8, 0.07, [0.06, 0.045, 0.035], 0.8, 1);
  w.colliders.addCircle(x, z, 0.2, 8);
}

export function addDock(w, x, z, yaw, len, wid) {
  const T = makeXf(x, 0, z, yaw);
  const top = w.waterY + 0.55;
  const hw = wid / 2;
  const n = Math.floor(len / 0.55);
  for (let i = 0; i < n; i++) {
    const z0 = i * 0.55;
    const j = 0.05 + (i * 7 % 5) * 0.004;
    addBox(w.lit, T, -hw, top - 0.12, z0, hw, top, z0 + 0.5, [0.05 + j, 0.038 + j * 0.6, 0.028], 0.7, 1);
  }
  addBox(w.lit, T, -hw + 0.2, top - 0.35, 0, -hw + 0.4, top - 0.12, len, [0.035, 0.026, 0.02], 0.5, 0.8);
  addBox(w.lit, T, hw - 0.4, top - 0.35, 0, hw - 0.2, top - 0.12, len, [0.035, 0.026, 0.02], 0.5, 0.8);
  for (let s = 0; s <= len; s += 3) {
    for (const sx of [-hw, hw]) {
      addBox(w.lit, T, sx - 0.1, w.waterY - 2.0, s - 0.1, sx + 0.1, top + (s % 6 === 0 ? 0.7 : 0.15), s + 0.1, [0.04, 0.03, 0.024], 0.4, 0.9);
    }
  }
  const c = T.p(0, 0, len / 2);
  w.platforms.push({ x: c[0], z: c[2], hx: hw, hz: len / 2, c: Math.cos(yaw), s: Math.sin(yaw), y: top });
  w.clear.push({ x: c[0], z: c[2], r: len / 2 + 2 });
  return {
    top,
    tip: (() => { const t = T.p(0, 0, len - 0.4); return { x: t[0], z: t[2] }; })(),
    T,
  };
}

export function addBoathouse(w, x, z, yaw) {
  const y0 = w.groundAt(x, z);
  const T = makeXf(x, 0, z, yaw);
  const wood = [0.06, 0.04, 0.03];
  addBox(w.lit, T, -3.5, y0 - 0.5, -2.5, 3.5, y0 + 3.0, 2.5, wood, 0.5, 1);
  addGable(w.lit, T, -3.5, -2.5, 3.5, 2.5, y0 + 3.0, 1.3, 0.4, [0.03, 0.03, 0.032]);
  addBox(w.lit, T, -1.4, y0 + 0.0, 2.49, 1.4, y0 + 2.6, 2.56, [0.025, 0.018, 0.014], 0.8, 1);
  addBox(w.emisB('boathouse'), T, 2.0, y0 + 1.2, 2.5, 3.0, y0 + 2.2, 2.56, [2.8, 1.8, 0.8], 1, 1);
  addBox(w.lit, T, 4.2, y0 - 0.1, -0.1, 5.4, y0 + 0.9, 1.1, [0.05, 0.07, 0.06], 0.5, 1);
  addBox(w.lit, T, 4.5, y0 + 0.9, 0.5, 4.7, y0 + 1.7, 0.7, [0.03, 0.03, 0.03], 0.8, 1);
  addBox(w.emisB('genOff'), T, 4.6, y0 + 0.7, 1.1, 4.9, y0 + 0.85, 1.14, [3.0, 0.3, 0.2], 1, 1);
  addBox(w.emisB('genOn'), T, 4.6, y0 + 0.7, 1.1, 4.9, y0 + 0.85, 1.14, [0.4, 3.0, 1.2], 1, 1);
  const c = T.p(0, 0, 0);
  w.colliders.addBox(c[0], c[2], 3.7, 2.7, yaw, 4);
  const g = T.p(4.8, 0, 0.5);
  w.colliders.addBox(g[0], g[2], 0.7, 0.7, yaw, 1.4);
  const gi = T.p(4.8, 0, 2.2);
  const lp = T.p(2.0, y0 + 3.0, 3.6);
  w.lamps.push(makeLamp({ name: 'boatLamp', x: lp[0], y: lp[1], z: lp[2], radius: 10, intensity: 5, on: false }));
  w.clear.push({ x: c[0], z: c[2], r: 8 });
  w.occluders.push({ x: c[0], z: c[2], h: 4.0, r: 4 });
  return { gen: { x: gi[0], z: gi[2] } };
}

export function addGasStation(w, x, z, yaw) {
  const y = w.groundAt(x, z);
  const T = makeXf(x, 0, z, yaw);
  const gray = [0.09, 0.11, 0.11];
  addBox(w.lit, T, -8, y - 0.05, -7, 25, y + 0.07, 7, [0.07, 0.07, 0.07], 0.9, 1);
  addBox(w.lit, T, -6, y + 4.6, -4, 6, y + 5.1, 4, gray, 0.7, 1);
  addBox(w.emisB('canopy'), T, -5.8, y + 4.54, -3.8, 5.8, y + 4.6, 3.8, [2.6, 2.3, 1.7], 1, 1);
  for (const sx of [-5.5, 5.5]) {
    for (const sz of [-3.3, 3.3]) {
      addBox(w.lit, T, sx - 0.2, y, sz - 0.2, sx + 0.2, y + 4.6, sz + 0.2, [0.12, 0.12, 0.12], 0.6, 1);
      const p = T.p(sx, 0, sz);
      w.colliders.addCircle(p[0], p[2], 0.35, 5);
    }
  }
  for (const iz of [-2, 2]) {
    addBox(w.lit, T, -3.5, y, iz - 0.6, 3.5, y + 0.2, iz + 0.6, [0.12, 0.12, 0.11], 0.7, 1);
    for (const px of [-1.8, 1.8]) {
      addBox(w.lit, T, px - 0.3, y + 0.2, iz - 0.25, px + 0.3, y + 1.6, iz + 0.25, [0.12, 0.09, 0.08], 0.6, 1);
      addBox(w.emisB('pumps'), T, px - 0.22, y + 1.1, iz - 0.27, px + 0.22, y + 1.4, iz - 0.25, [0.7, 1.6, 1.4], 1, 1);
      const p = T.p(px, 0, iz);
      w.colliders.addBox(p[0], p[2], 0.35, 0.3, yaw, 1.6);
    }
  }
  addBox(w.lit, T, 10, y, -4.5, 22, y + 3.6, 4.5, [0.10, 0.095, 0.09], 0.5, 1);
  addBox(w.lit, T, 9.7, y + 3.6, -4.8, 22.3, y + 3.85, 4.8, [0.05, 0.05, 0.055], 0.8, 1);
  const store = w.emisB('store');
  addBox(store, T, 9.95, y + 1.0, -3.6, 10.0, y + 2.6, -1.0, [2.4, 2.1, 1.5], 1, 1);
  addBox(store, T, 9.95, y + 1.0, 1.0, 10.0, y + 2.6, 3.6, [2.4, 2.1, 1.5], 1, 1);
  addBox(w.lit, T, 9.94, y, -0.5, 10.0, y + 2.3, 0.5, [0.025, 0.025, 0.028], 0.8, 1);
  const sc = T.p(16, 0, 0);
  w.colliders.addBox(sc[0], sc[2], 6.1, 4.6, yaw, 4);
  addBox(w.lit, T, 17.6, y + 1.0, 4.5, 18.4, y + 1.9, 4.65, [0.18, 0.18, 0.19], 0.8, 1);
  addBox(w.emisB('breaker'), T, 17.9, y + 1.5, 4.65, 18.1, y + 1.6, 4.68, [3.0, 0.3, 0.2], 1, 1);
  addBox(w.lit, T, -9.15, y, -7.15, -8.85, y + 8.0, -6.85, [0.06, 0.06, 0.065], 0.5, 1);
  addBox(w.lit, T, -11.1, y + 6.9, -7.1, -6.9, y + 9.2, -6.9, [0.05, 0.05, 0.055], 0.9, 1);
  const sg = w.emisB('sign');
  addBox(sg, T, -10.9, y + 7.1, -6.92, -7.1, y + 8.2, -6.86, [2.6, 1.2, 0.5], 1, 1);
  addBox(sg, T, -10.9, y + 8.3, -6.92, -7.1, y + 9.0, -6.86, [0.5, 1.8, 1.9], 1, 1);
  const sp = T.p(-9, 0, -7);
  w.colliders.addCircle(sp[0], sp[2], 0.35, 8);
  const mk = (n2, lx, ly, lz, rad, inten, haven, col) => {
    const p = T.p(lx, y + ly, lz);
    w.lamps.push(makeLamp({ name: n2, x: p[0], y: p[1], z: p[2], radius: rad, intensity: inten, haven, on: false, color: col, glow: haven ? 1 : 0.3 }));
  };
  mk('canopy0', -3.5, 4.2, 0, 9, 5.5, true);
  mk('canopy1', 0, 4.2, 0, 9, 5.5, true);
  mk('canopy2', 3.5, 4.2, 0, 9, 5.5, true);
  mk('storeLamp', 8.5, 3.2, 0, 8, 4.5, true);
  mk('signLamp', -9, 7.5, -4.5, 10, 3.5, false, [1.0, 0.5, 0.25]);
  const c = T.p(0, 0, 0);
  w.clear.push({ x: c[0], z: c[2], r: 14 }, { x: sc[0], z: sc[2], r: 9 });
  w.occluders.push({ x: sc[0], z: sc[2], h: 4.5, r: 5 });
  const br = T.p(18, 0, 5.6), sgp = T.p(-9, 0, -9), pump = T.p(0, 0, 0);
  return { breaker: { x: br[0], z: br[2] }, signPole: { x: sgp[0], z: sgp[2] }, pumps: { x: pump[0], z: pump[2] }, T };
}

export function addLighthouse(w, x, z) {
  const y0 = w.groundAt(x, z);
  const bone = [0.20, 0.19, 0.17], ember = [0.20, 0.06, 0.035];
  const bands = 5, bh = 4.4;
  for (let i = 0; i < bands; i++) {
    const ra = 3.4 - (i * bh / 22) * 1.3, rb = 3.4 - ((i + 1) * bh / 22) * 1.3;
    addCyl(w.lit, ID, x, y0 + i * bh - 0.3, z, ra, rb, bh + 0.3, 14, i % 2 ? ember : bone, 0.55, 1, 0, false);
  }
  addCyl(w.lit, ID, x, y0 + 22, z, 2.8, 2.8, 0.35, 14, [0.05, 0.05, 0.055], 0.8, 1, 0, true);
  addCyl(w.emisB('beacon'), ID, x, y0 + 22.35, z, 1.35, 1.35, 2.4, 12, [6.0, 5.0, 3.4], 1, 1, 0, false);
  addCyl(w.lit, ID, x, y0 + 24.75, z, 1.8, 0.1, 1.3, 12, [0.04, 0.04, 0.045], 0.8, 1, 0, false);
  addBox(w.lit, ID, x - 0.7, y0, z + 3.05, x + 0.7, y0 + 2.3, z + 3.45, [0.025, 0.02, 0.016], 0.8, 1);
  addBox(w.lit, ID, x + 7, y0 - 0.3, z - 2, x + 12, y0 + 3.0, z + 2, [0.08, 0.07, 0.065], 0.5, 1);
  addGable(w.lit, ID, x + 7, z - 2, x + 12, z + 2, y0 + 3.0, 1.2, 0.4, [0.035, 0.032, 0.034]);
  w.colliders.addCircle(x, z, 3.6, 25);
  w.colliders.addBox(x + 9.5, z, 2.7, 2.2, 0, 4);
  w.clear.push({ x, z, r: 9 }, { x: x + 9.5, z, r: 5 });
  w.occluders.push({ x, z, h: 22, r: 3.4 });
  return { door: { x, z: z + 4.8 }, top: y0 + 23.5, base: y0 };
}

export function addSignpost(w, x, z, yaw) {
  const y = w.groundAt(x, z);
  const T = makeXf(x, 0, z, yaw);
  addBox(w.lit, T, -0.06, y - 0.2, -0.06, 0.06, y + 1.9, 0.06, [0.05, 0.036, 0.026], 0.5, 1);
  addBox(w.lit, T, -0.6, y + 1.35, -0.04, 0.6, y + 1.8, 0.04, [0.07, 0.05, 0.035], 0.8, 1);
  w.colliders.addCircle(x, z, 0.15, 2);
}
