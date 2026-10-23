// Small math toolkit: scalar helpers and column-major mat4 routines (WebGL convention).
// World space: +X east, +Y up, +Z south (right-handed). Heading 0 faces north (-Z).

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// Works for reversed edges too (a > b), unlike GLSL's smoothstep.
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export const wrapPi = (a) => {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
};

export const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

export function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
export const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function mat4Identity(o) {
  o.fill(0);
  o[0] = o[5] = o[10] = o[15] = 1;
  return o;
}

export function mat4Perspective(o, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  o.fill(0);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = (far + near) * nf;
  o[11] = -1;
  o[14] = 2 * far * near * nf;
  return o;
}

export function mat4LookAt(o, ex, ey, ez, tx, ty, tz, ux, uy, uz) {
  let zx = ex - tx, zy = ey - ty, zz = ez - tz;
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
  o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * ex + xy * ey + xz * ez);
  o[13] = -(yx * ex + yy * ey + yz * ez);
  o[14] = -(zx * ex + zy * ey + zz * ez);
  o[15] = 1;
  return o;
}

// o = a * b
export function mat4Mul(o, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  o[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  o[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  o[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  o[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
  o[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  o[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  o[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  o[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
  o[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  o[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  o[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  o[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
  o[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  o[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  o[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  o[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  return o;
}

// Model matrix: uniform scale, rotation about Y by yaw, translation.
// A local +Z axis maps to world (sin yaw, 0, cos yaw).
export function mat4Model(o, x, y, z, yaw, s) {
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  o[0] = c * s; o[1] = 0; o[2] = -sn * s; o[3] = 0;
  o[4] = 0; o[5] = s; o[6] = 0; o[7] = 0;
  o[8] = sn * s; o[9] = 0; o[10] = c * s; o[11] = 0;
  o[12] = x; o[13] = y; o[14] = z; o[15] = 1;
  return o;
}

// ---------------------------------------------------------------- frustum culling
// Extracts the 6 clip planes (left, right, bottom, top, near, far) from a column-major view-projection matrix.
// Each plane is (a, b, c, d) with the normal pointing into the frustum; written into `out` (Float32Array(24)).
export function frustumPlanes(m, out) {
  const r = [
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
  ];
  for (let i = 0; i < 6; i++) {
    const p = r[i];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    out[i * 4] = p[0] / l; out[i * 4 + 1] = p[1] / l; out[i * 4 + 2] = p[2] / l; out[i * 4 + 3] = p[3] / l;
  }
  return out;
}

// True unless the axis-aligned box (min, max) lies completely outside one of the planes.
export function boxVisible(pl, min, max, pad = 0) {
  for (let i = 0; i < 6; i++) {
    const a = pl[i * 4], b = pl[i * 4 + 1], c = pl[i * 4 + 2], d = pl[i * 4 + 3];
    const x = a >= 0 ? max[0] + pad : min[0] - pad;
    const y = b >= 0 ? max[1] + pad : min[1] - pad;
    const z = c >= 0 ? max[2] + pad : min[2] - pad;
    if (a * x + b * y + c * z + d < 0) return false;
  }
  return true;
}

// Horizontal distance from (x, z) to the box footprint (0 when inside).
export function boxDist2(min, max, x, z) {
  const dx = x < min[0] ? min[0] - x : x > max[0] ? x - max[0] : 0;
  const dz = z < min[2] ? min[2] - z : z > max[2] ? z - max[2] : 0;
  return dx * dx + dz * dz;
}
