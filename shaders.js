// All GLSL ES 1.00 sources (valid on WebGL1 and WebGL2 contexts).
// Fragment chunks are composed from shared pieces so lighting, fog and tone mapping stay identical everywhere.

const FRAG_PREC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const U_COMMON = `
uniform float u_time;
uniform vec3 u_cam;
uniform vec3 u_moonDir;
uniform vec3 u_moonCol;
uniform vec3 u_ambSky;
uniform vec3 u_ambGnd;
uniform vec3 u_fogCol;
uniform float u_fogDen;
uniform float u_fogBase;
uniform float u_exposure;
`;

const NOISE = `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash31(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash31(i);
  float b = hash31(i + vec3(1.0, 0.0, 0.0));
  float c = hash31(i + vec3(0.0, 1.0, 0.0));
  float d = hash31(i + vec3(1.0, 1.0, 0.0));
  float e = hash31(i + vec3(0.0, 0.0, 1.0));
  float g = hash31(i + vec3(1.0, 0.0, 1.0));
  float h = hash31(i + vec3(0.0, 1.0, 1.0));
  float k = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.0, 9.0);
    a *= 0.5;
  }
  return s;
}
`;

const SKY = `
uniform vec3 u_skyHor;
uniform vec3 u_skyZen;
uniform float u_starAmt;
uniform float u_cloudAmt;

vec3 skyColor(vec3 d) {
  float up = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(u_skyHor, u_skyZen, pow(up, 0.5));
  col = mix(col, u_skyHor * 0.5, 1.0 - smoothstep(-0.3, 0.02, d.y));
  float md = max(dot(d, u_moonDir), 0.0);
  float cloud = 0.0;
  vec3 cc = vec3(0.0);
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.2) * 0.8 + vec2(u_time * 0.006, u_time * 0.003);
    float c = fbm(uv * 1.3);
    float thr = 1.0 - u_cloudAmt;
    cloud = smoothstep(thr, thr + 0.22, c) * smoothstep(0.0, 0.2, d.y);
    float thin = 1.0 - smoothstep(thr, thr + 0.4, c);
    cc = u_skyHor * 0.55 + u_moonCol * (0.10 + 0.9 * pow(md, 3.0)) * (0.25 + 0.75 * thin);
  }
  float sdim = u_starAmt * smoothstep(0.03, 0.4, d.y) * (1.0 - cloud);
  vec3 sd = d * 160.0;
  vec3 id = floor(sd);
  vec3 fp = fract(sd) - 0.5;
  float r = hash31(id);
  vec3 off = (vec3(hash31(id + 7.1), hash31(id + 13.7), hash31(id + 29.3)) - 0.5) * 0.6;
  float sp = (1.0 - smoothstep(0.0, 0.2, length(fp - off))) * step(0.985, r);
  float tw = 0.65 + 0.35 * sin(u_time * (1.5 + r * 4.0) + r * 60.0);
  col += vec3(0.8, 0.9, 1.0) * sp * tw * sdim * (0.6 + 1.8 * hash31(id + 3.3));
  col += u_moonCol * (pow(md, 40.0) * 0.5 + pow(md, 6.0) * 0.06) * (1.0 - cloud * 0.6);
  float disc = smoothstep(0.99935, 0.99965, md);
  col = mix(col, vec3(2.4, 2.5, 2.7), disc * (1.0 - cloud * 0.7));
  col = mix(col, cc, cloud * 0.9);
  col = mix(col, u_fogCol, (1.0 - smoothstep(0.0, 0.3, d.y)) * 0.8);
  return col;
}
`;

const LIGHT = `
uniform vec4 u_fl;
uniform vec3 u_flPos;
uniform vec3 u_flDir;
uniform vec3 u_flCol;
uniform vec4 u_pl[8];
uniform vec3 u_plc[8];
uniform vec4 u_s2p;
uniform vec4 u_s2d;
uniform vec4 u_s2e;
uniform vec3 u_s2c;

float spotFactor(vec3 p) {
  vec3 L = p - u_flPos;
  float d = length(L) + 0.0001;
  float c = dot(L / d, u_flDir);
  return smoothstep(u_fl.y, u_fl.z, c) * (1.0 - smoothstep(u_fl.w * 0.55, u_fl.w, d));
}

vec3 shade(vec3 p, vec3 n, vec3 alb, float ao) {
  float nl = max(dot(n, u_moonDir), 0.0);
  vec3 amb = mix(u_ambGnd, u_ambSky, n.y * 0.5 + 0.5);
  vec3 lit = u_moonCol * nl * ao + amb * (0.5 + 0.5 * ao);
  if (u_fl.x > 0.001) {
    vec3 L = p - u_flPos;
    float d = length(L) + 0.0001;
    vec3 ld = L / d;
    float sp = smoothstep(u_fl.y, u_fl.z, dot(ld, u_flDir));
    if (sp > 0.0) {
      float att = 1.0 / (1.0 + 0.035 * d * d) * (1.0 - smoothstep(u_fl.w * 0.55, u_fl.w, d));
      float ndl = max(dot(n, -ld), 0.0);
      lit += u_flCol * u_fl.x * sp * att * (0.18 + 0.82 * ndl);
    }
  }
  for (int i = 0; i < 8; i++) {
    vec4 pl = u_pl[i];
    if (pl.w > 0.0) {
      vec3 L = pl.xyz - p;
      float d = length(L) + 0.0001;
      float a = clamp(1.0 - d / pl.w, 0.0, 1.0);
      a *= a;
      float ndl = max(dot(n, L / d), 0.0);
      lit += u_plc[i] * a * (0.3 + 0.7 * ndl) * mix(1.0, ao, 0.5);
    }
  }
  if (u_s2p.w > 0.001) {
    vec3 L2 = p - u_s2p.xyz;
    float d2 = length(L2) + 0.0001;
    vec3 ld2 = L2 / d2;
    float sp2 = smoothstep(u_s2d.w, u_s2e.x, dot(ld2, u_s2d.xyz));
    if (sp2 > 0.0) {
      float att2 = 1.0 / (1.0 + 0.0009 * d2 * d2) * (1.0 - smoothstep(u_s2e.y * 0.6, u_s2e.y, d2));
      float ndl2 = max(dot(n, -ld2), 0.0);
      lit += u_s2c * u_s2p.w * sp2 * att2 * (0.2 + 0.8 * ndl2);
    }
  }
  return alb * lit;
}
`;

const FOG = `
vec3 applyFog(vec3 col, vec3 p) {
  vec3 V = p - u_cam;
  float d = length(V) + 0.0001;
  float fn = vnoise(p.xz * 0.045 + vec2(u_time * 0.02, 0.0));
  float dens = u_fogDen * (0.6 + 0.4 * exp(-max(p.y - u_fogBase, 0.0) * 0.06)) * (0.75 + 0.5 * fn);
  float f = 1.0 - exp(-dens * dens * d * d);
  vec3 fc = u_fogCol + u_moonCol * pow(max(dot(V / d, u_moonDir), 0.0), 6.0) * 0.10;
  if (u_fl.x > 0.001) fc += u_flCol * u_fl.x * spotFactor(p) * 0.02;
  if (u_s2p.w > 0.001) {
    vec3 L2 = p - u_s2p.xyz;
    float d2 = length(L2) + 0.0001;
    fc += u_s2c * u_s2p.w * smoothstep(u_s2d.w, u_s2e.x, dot(L2 / d2, u_s2d.xyz)) * 0.012;
  }
  return mix(col, fc, f);
}
`;

const TONE = `
vec3 aces(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 finish(vec3 c) {
  c = aces(c * u_exposure);
  return pow(c, vec3(1.0 / 2.2));
}
`;

// ---------------------------------------------------------------- lit geometry
export const LIT_VS = `
attribute vec3 a_pos;
attribute vec3 a_nrm;
attribute vec3 a_col;
attribute float a_ao;
attribute float a_sway;
uniform mat4 u_vp;
uniform float u_time;
uniform float u_windAmt;
varying vec3 v_pos;
varying vec3 v_nrm;
varying vec3 v_col;
varying float v_ao;
void main() {
  vec3 p = a_pos;
  if (a_sway > 0.0) {
    float ph = p.x * 0.35 + p.z * 0.27;
    float w = sin(u_time * 1.6 + ph) * 0.6 + sin(u_time * 2.9 + ph * 1.7) * 0.4;
    p.x += w * a_sway * u_windAmt;
    p.z += cos(u_time * 1.3 + ph * 0.8) * a_sway * u_windAmt * 0.6;
  }
  v_pos = p;
  v_nrm = a_nrm;
  v_col = a_col;
  v_ao = a_ao;
  gl_Position = u_vp * vec4(p, 1.0);
}
`;

export const LIT_FS = `${FRAG_PREC}${U_COMMON}${NOISE}${LIGHT}${FOG}${TONE}
uniform float u_waterY;
uniform float u_bump;
varying vec3 v_pos;
varying vec3 v_nrm;
varying vec3 v_col;
varying float v_ao;
void main() {
  vec3 N = normalize(v_nrm);
  vec3 V = normalize(u_cam - v_pos);
  if (dot(N, V) < 0.0) N = -N;
  if (u_bump > 0.5) {
    // cheap procedural normal detail on the ground (stones, clods, roots); fades out with distance
    float dcam = length(u_cam - v_pos);
    float k = 1.0 - smoothstep(14.0, 60.0, dcam);
    if (k > 0.001) {
      vec2 q = v_pos.xz * 3.3;
      float h0 = vnoise(q) * 0.65 + vnoise(q * 2.9) * 0.35;
      float hx = vnoise(q + vec2(0.4, 0.0)) * 0.65 + vnoise((q + vec2(0.4, 0.0)) * 2.9) * 0.35;
      float hz = vnoise(q + vec2(0.0, 0.4)) * 0.65 + vnoise((q + vec2(0.0, 0.4)) * 2.9) * 0.35;
      N = normalize(N + vec3(h0 - hx, 0.0, h0 - hz) * 2.2 * k);
    }
  }
  float dn = vnoise(v_pos.xz * 1.7 + v_pos.y * 0.9) * 0.6 + vnoise(v_pos.xz * 7.3) * 0.4;
  vec3 alb = v_col * (0.72 + 0.56 * dn);
  vec3 c = shade(v_pos, N, alb, v_ao);
  float under = clamp(u_waterY - v_pos.y, 0.0, 4.0);
  c *= exp(-under * 0.9);
  c = applyFog(c, v_pos);
  gl_FragColor = vec4(finish(c), 1.0);
}
`;

// ---------------------------------------------------------------- emissive geometry (reuses LIT_VS)
export const EMIS_FS = `${FRAG_PREC}${U_COMMON}${NOISE}${LIGHT}${FOG}${TONE}
uniform float u_emisScale;
varying vec3 v_pos;
varying vec3 v_nrm;
varying vec3 v_col;
varying float v_ao;
void main() {
  vec3 c = v_col * u_emisScale;
  c = mix(applyFog(c, v_pos), c, 0.55);
  gl_FragColor = vec4(finish(c), 1.0);
}
`;

// ---------------------------------------------------------------- sky
export const SKY_VS = `
attribute vec2 a_pos;
varying vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 1.0, 1.0);
}
`;

export const SKY_FS = `${FRAG_PREC}${U_COMMON}${NOISE}${SKY}${TONE}
uniform vec3 u_camRight;
uniform vec3 u_camUp;
uniform vec3 u_camFwd;
uniform float u_tanFov;
uniform float u_aspect;
varying vec2 v_ndc;
void main() {
  vec3 d = normalize(u_camFwd + u_camRight * (v_ndc.x * u_aspect * u_tanFov) + u_camUp * (v_ndc.y * u_tanFov));
  vec3 c = skyColor(d);
  gl_FragColor = vec4(finish(c), 1.0);
}
`;

// ---------------------------------------------------------------- water
export const WATER_VS = `
attribute vec3 a_pos;
attribute float a_depth;
uniform mat4 u_vp;
varying vec3 v_pos;
varying float v_depth;
void main() {
  v_pos = a_pos;
  v_depth = a_depth;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}
`;

export const WATER_FS = `${FRAG_PREC}${U_COMMON}${NOISE}${SKY}${LIGHT}${FOG}${TONE}
varying vec3 v_pos;
varying float v_depth;
float ripple(vec2 uv) {
  return vnoise(uv * 0.8 + vec2(u_time * 0.05, u_time * 0.03)) * 0.6
       + vnoise(uv * 2.6 - vec2(u_time * 0.08, u_time * 0.02)) * 0.4;
}
void main() {
  vec3 toCam = u_cam - v_pos;
  float dist = length(toCam) + 0.0001;
  vec3 V = toCam / dist;
  vec2 uv = v_pos.xz;
  float h0 = ripple(uv);
  float hx = ripple(uv + vec2(0.15, 0.0));
  float hz = ripple(uv + vec2(0.0, 0.15));
  float amp = 0.10 * (1.0 - smoothstep(25.0, 160.0, dist));
  vec3 n = normalize(vec3(-(hx - h0) / 0.15 * amp, 1.0, -(hz - h0) / 0.15 * amp));
  float ndv = max(dot(n, V), 0.0);
  float fr = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, n);
  R.y = max(R.y, 0.01);
  R = normalize(R);
  vec3 refl = skyColor(R);
  vec3 shallow = vec3(0.012, 0.040, 0.045) * (1.0 - smoothstep(0.0, 2.2, v_depth));
  vec3 body = shade(v_pos, n, vec3(0.04, 0.09, 0.10), 1.0) + shallow;
  vec3 col = mix(body, refl, fr);
  float mg = pow(max(dot(R, u_moonDir), 0.0), 220.0);
  col += u_moonCol * mg * 6.0;
  if (u_fl.x > 0.001) {
    vec3 Lf = normalize(u_flPos - v_pos);
    vec3 Hf = normalize(Lf + V);
    float sf = pow(max(dot(n, Hf), 0.0), 90.0) * spotFactor(v_pos) * u_fl.x;
    col += u_flCol * sf * 0.9;
  }
  for (int i = 0; i < 8; i++) {
    vec4 pl = u_pl[i];
    if (pl.w > 0.0) {
      vec3 Lp = pl.xyz - v_pos;
      float dd = length(Lp) + 0.0001;
      vec3 Lh = normalize(Lp / dd + V);
      float spc = pow(max(dot(n, Lh), 0.0), 120.0);
      col += u_plc[i] * spc * clamp(1.0 - dd / (pl.w * 3.0), 0.0, 1.0) * 0.6;
    }
  }
  float foam = (1.0 - smoothstep(0.0, 0.25, abs(v_depth - 0.1 - (h0 - 0.5) * 0.15))) * smoothstep(-0.2, 0.0, v_depth);
  col += vec3(0.30, 0.36, 0.38) * foam * 0.08;
  float a = smoothstep(-0.1, 0.55, v_depth) * mix(0.86, 1.0, fr);
  col = applyFog(col, v_pos);
  gl_FragColor = vec4(finish(col), a);
}
`;

// ---------------------------------------------------------------- enemies (the Unwritten)
export const ENEMY_VS = `
attribute vec3 a_pos;
attribute vec3 a_nrm;
attribute vec3 a_col;
attribute float a_ao;
attribute float a_sway;
uniform mat4 u_vp;
uniform mat4 u_model;
uniform float u_time;
uniform float u_seed;
varying vec3 v_pos;
varying vec3 v_nrm;
varying vec3 v_loc;
void main() {
  vec3 p = a_pos;
  float w = sin(u_time * 5.0 + p.y * 4.0 + u_seed * 7.0) * a_sway;
  p += a_nrm * w * 0.12;
  p += vec3(sin(u_time * 3.1 + u_seed + p.y * 3.0), 0.0, cos(u_time * 2.3 + u_seed + p.y * 2.0)) * a_sway * 0.1;
  vec4 wp = u_model * vec4(p, 1.0);
  v_pos = wp.xyz;
  v_nrm = (u_model * vec4(a_nrm, 0.0)).xyz;
  v_loc = a_pos;
  gl_Position = u_vp * wp;
}
`;

export const ENEMY_FS = `${FRAG_PREC}${U_COMMON}${NOISE}${LIGHT}${FOG}${TONE}
uniform float u_shield;
uniform float u_dissolve;
uniform float u_hit;
uniform float u_alert;
uniform float u_seed;
varying vec3 v_pos;
varying vec3 v_nrm;
varying vec3 v_loc;
void main() {
  float nz = vnoise3(v_loc * 3.2 + u_seed) * 0.65 + vnoise3(v_loc * 9.0 + u_seed * 1.7) * 0.35;
  if (nz < u_dissolve) discard;
  vec3 N = normalize(v_nrm);
  vec3 V = normalize(u_cam - v_pos);
  if (dot(N, V) < 0.0) N = -N;
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.2);
  float pulse = 0.65 + 0.35 * sin(u_time * 3.0 + u_seed + v_pos.y * 2.0);
  vec3 col = vec3(0.002, 0.003, 0.004);
  col += vec3(0.03, 0.16, 0.18) * fres * pulse * u_shield * 1.2;
  float crack = smoothstep(0.58, 0.78, vnoise3(v_loc * 5.0 + vec3(0.0, u_time * 0.6, 0.0)));
  col += vec3(2.2, 0.85, 0.25) * crack * (1.0 - u_shield) * (0.5 + 0.5 * pulse);
  col += shade(v_pos, N, vec3(0.05, 0.045, 0.045), 1.0) * (0.35 + 0.65 * (1.0 - u_shield));
  col += vec3(1.4, 1.25, 0.95) * u_hit * (0.15 + fres * 1.2);
  col += vec3(0.022, 0.04, 0.062) * fres;
  col += vec3(2.0, 0.10, 0.04) * u_alert * (0.2 + fres * 1.5) * (0.65 + 0.35 * sin(u_time * 34.0));
  float edge = (1.0 - smoothstep(u_dissolve, u_dissolve + 0.1, nz)) * step(0.001, u_dissolve);
  col += vec3(2.8, 1.6, 0.6) * edge;
  col = applyFog(col, v_pos);
  gl_FragColor = vec4(finish(col), 1.0);
}
`;

// ---------------------------------------------------------------- light cone (volumetric-style shaft)
export const BEAM_VS = `
attribute float a_t;
attribute float a_ang;
uniform mat4 u_vp;
uniform vec3 u_apex;
uniform vec3 u_bfwd;
uniform vec3 u_bright;
uniform vec3 u_bup;
uniform float u_len;
uniform float u_tanHalf;
varying float v_t;
varying vec3 v_n;
varying vec3 v_pos;
void main() {
  float z = a_t * u_len;
  vec3 radial = u_bright * cos(a_ang) + u_bup * sin(a_ang);
  vec3 p = u_apex + u_bfwd * z + radial * (z * u_tanHalf);
  v_t = a_t;
  v_n = normalize(radial - u_bfwd * u_tanHalf);
  v_pos = p;
  gl_Position = u_vp * vec4(p, 1.0);
}
`;

export const BEAM_FS = `${FRAG_PREC}
uniform vec3 u_cam;
uniform vec3 u_bcol;
uniform float u_bint;
varying float v_t;
varying vec3 v_n;
varying vec3 v_pos;
void main() {
  vec3 V = normalize(u_cam - v_pos);
  float ndv = abs(dot(normalize(v_n), V));
  float body = pow(1.0 - ndv, 1.3) * 0.85 + 0.15;
  float lenFade = 1.0 - v_t;
  lenFade *= lenFade;
  float nearF = smoothstep(0.0, 0.08, v_t);
  float a = body * lenFade * nearF * u_bint;
  gl_FragColor = vec4(u_bcol * a, a);
}
`;

// ---------------------------------------------------------------- point sprites (glows, pages, dust, sparks)
export const SPRITE_VS = `
attribute vec3 a_pos;
attribute vec4 a_col;
attribute float a_size;
attribute float a_type;
uniform mat4 u_vp;
uniform float u_pxScale;
varying vec4 v_col;
varying float v_type;
void main() {
  vec4 c = u_vp * vec4(a_pos, 1.0);
  gl_Position = c;
  float w = max(c.w, 0.1);
  gl_PointSize = clamp(a_size * u_pxScale / w, 1.0, 100.0);
  v_col = a_col;
  v_type = a_type;
}
`;

export const SPRITE_FS = `${FRAG_PREC}
varying vec4 v_col;
varying float v_type;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  float a = 0.0;
  if (v_type < 0.5) {
    a = pow(max(1.0 - r, 0.0), 2.2);
  } else if (v_type < 1.5) {
    float box = max(abs(p.x) * 1.25, abs(p.y) * 0.95);
    float paper = 1.0 - smoothstep(0.72, 0.8, box);
    float lines = 0.55 + 0.45 * step(0.5, fract(p.y * 4.5 + 0.25));
    a = paper * lines * 0.9 + pow(max(1.0 - r, 0.0), 2.0) * 0.25;
  } else {
    a = exp(-r * r * 7.0);
  }
  float k = a * v_col.a;
  gl_FragColor = vec4(v_col.rgb * k, k);
}
`;

// ---------------------------------------------------------------- post (vignette + film grain as blended overlays)
export const POST_VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const POST_FS = `${FRAG_PREC}
uniform float u_mode;
uniform float u_time;
uniform float u_dmg;
uniform float u_vig;
varying vec2 v_uv;
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec2 q = v_uv - 0.5;
  if (u_mode < 0.5) {
    float v = smoothstep(0.16, 0.78, length(q * vec2(1.0, 0.9))) * u_vig;
    v = clamp(v + u_dmg * 0.35 * smoothstep(0.1, 0.7, length(q)), 0.0, 1.0);
    vec3 tint = mix(vec3(0.0), vec3(0.20, 0.025, 0.0), u_dmg);
    gl_FragColor = vec4(tint, v);
  } else {
    float n = hash21(gl_FragCoord.xy + fract(u_time) * vec2(311.0, 577.0));
    float g = n - 0.5;
    gl_FragColor = vec4(vec3(g > 0.0 ? 1.0 : 0.0), abs(g) * 0.075);
  }
}
`;

// ---------------------------------------------------------------- post pipeline (scene texture -> bloom -> grade)
export const BRIGHT_FS = `${FRAG_PREC}
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_thr;
varying vec2 v_uv;
void main() {
  vec3 c = texture2D(u_src, v_uv + u_texel * vec2(-1.0, -1.0)).rgb
         + texture2D(u_src, v_uv + u_texel * vec2(1.0, -1.0)).rgb
         + texture2D(u_src, v_uv + u_texel * vec2(-1.0, 1.0)).rgb
         + texture2D(u_src, v_uv + u_texel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(u_thr, u_thr + 0.3, l);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

export const BLUR_FS = `${FRAG_PREC}
uniform sampler2D u_src;
uniform vec2 u_dir;
varying vec2 v_uv;
void main() {
  vec3 s = texture2D(u_src, v_uv).rgb * 0.2270270270;
  s += (texture2D(u_src, v_uv + u_dir * 1.3846153846).rgb + texture2D(u_src, v_uv - u_dir * 1.3846153846).rgb) * 0.3162162162;
  s += (texture2D(u_src, v_uv + u_dir * 3.2307692308).rgb + texture2D(u_src, v_uv - u_dir * 3.2307692308).rgb) * 0.0702702703;
  gl_FragColor = vec4(s, 1.0);
}
`;

// FXAA (edge-directed blur), bloom (screen blend), colour grade, chromatic aberration, vignette and film grain.
export const COMP_FS = `${FRAG_PREC}
uniform sampler2D u_scene;
uniform sampler2D u_bloomA;
uniform sampler2D u_bloomB;
uniform vec2 u_rcp;
uniform float u_time;
uniform float u_dmg;
uniform float u_vig;
uniform float u_bloom;
varying vec2 v_uv;
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 tex(vec2 uv) { return texture2D(u_scene, uv).rgb; }
void main() {
  vec2 uv = v_uv;
  vec2 q = uv - 0.5;
  vec3 luma = vec3(0.299, 0.587, 0.114);
  vec3 rgbNW = tex(uv + vec2(-1.0, -1.0) * u_rcp);
  vec3 rgbNE = tex(uv + vec2(1.0, -1.0) * u_rcp);
  vec3 rgbSW = tex(uv + vec2(-1.0, 1.0) * u_rcp);
  vec3 rgbSE = tex(uv + vec2(1.0, 1.0) * u_rcp);
  vec3 rgbM = tex(uv);
  float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma), lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma), lM = dot(rgbM, luma);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float dirReduce = max((lNW + lNE + lSW + lSE) * (0.25 * 0.125), 1.0 / 128.0);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * u_rcp;
  vec3 rgbA = 0.5 * (tex(uv + dir * (1.0 / 3.0 - 0.5)) + tex(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 rgbB = rgbA * 0.5 + 0.25 * (tex(uv + dir * -0.5) + tex(uv + dir * 0.5));
  float lB = dot(rgbB, luma);
  vec3 col = (lB < lMin || lB > lMax) ? rgbA : rgbB;

  // chromatic aberration: faint at the corners, strong when hurt
  vec2 off = q * (0.0028 + u_dmg * 0.02);
  col.r = mix(col.r, tex(uv + off).r, 0.75);
  col.b = mix(col.b, tex(uv - off).b, 0.75);

  // bloom (screen blend never clips)
  vec3 bl = texture2D(u_bloomA, uv).rgb * 0.55 + texture2D(u_bloomB, uv).rgb * 0.95;
  col = 1.0 - (1.0 - col) * (1.0 - clamp(bl * u_bloom, 0.0, 0.95));

  // grade: cool shadows, warm highlights, slight saturation and a gentle S-curve
  float l = dot(col, luma);
  col = mix(vec3(l), col, 1.1);
  col = mix(col * vec3(0.90, 0.99, 1.09), col, smoothstep(0.0, 0.5, l));
  col += vec3(0.05, 0.028, 0.0) * smoothstep(0.4, 1.0, l) * 0.6;
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.3);
  col = col * 0.97 + 0.012;

  // vignette + damage tint
  float v = smoothstep(0.16, 0.78, length(q * vec2(1.0, 0.9))) * u_vig;
  v = clamp(v + u_dmg * 0.35 * smoothstep(0.1, 0.7, length(q)), 0.0, 1.0);
  col = mix(col, mix(vec3(0.0), vec3(0.20, 0.025, 0.0), u_dmg), v);

  // film grain
  float n = hash21(gl_FragCoord.xy + fract(u_time) * vec2(311.0, 577.0));
  col += (n - 0.5) * 0.05;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
