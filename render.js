// Renderer: one forward pass (sky, terrain, props, emissives, enemies, water) plus additive light shafts and
// sprites into an offscreen target, then a small post chain (bloom, FXAA, grade, vignette, grain).
// ACES tone mapping happens inside each material shader. If offscreen targets are unavailable the scene is
// drawn straight to the canvas with the old vignette/grain overlays.

import { createGL, createProgram, useProgram, setUniforms, createBuffer, bindLayout, LIT_LAYOUT } from './gl.js';
import * as S from './shaders.js';
import { mat4Perspective, mat4LookAt, mat4Mul, mat4Model, TAU, frustumPlanes, boxVisible, boxDist2 } from './math.js';

const SPRITE_LAYOUT = [['a_pos', 3], ['a_col', 4], ['a_size', 1], ['a_type', 1]];
const WATER_LAYOUT = [['a_pos', 3], ['a_depth', 1]];
const BEAM_LAYOUT = [['a_t', 1], ['a_ang', 1]];
const TRI_LAYOUT = [['a_pos', 2]];

export class SpriteBatch {
  constructor(cap = 2600) {
    this.cap = cap;
    this.data = new Float32Array(cap * 9);
    this.n = 0;
  }
  clear() { this.n = 0; }
  add(x, y, z, r, g, b, a, size, type) {
    if (this.n >= this.cap) return;
    const d = this.data, i = this.n * 9;
    d[i] = x; d[i + 1] = y; d[i + 2] = z;
    d[i + 3] = r; d[i + 4] = g; d[i + 5] = b; d[i + 6] = a;
    d[i + 7] = size; d[i + 8] = type;
    this.n++;
  }
}

function basisFor(dir) {
  let rx = dir[2], ry = 0, rz = -dir[0]; // dir x (0,1,0)
  let l = Math.hypot(rx, ry, rz);
  if (l < 1e-4) { rx = 1; ry = 0; rz = 0; l = 1; }
  rx /= l; ry /= l; rz /= l;
  const ux = ry * dir[2] - rz * dir[1];
  const uy = rz * dir[0] - rx * dir[2];
  const uz = rx * dir[1] - ry * dir[0];
  return { right: [rx, ry, rz], up: [ux, uy, uz] };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = createGL(canvas);
    const gl = this.gl;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { window.location.reload(); });

    this.prog = {
      lit: createProgram(gl, S.LIT_VS, S.LIT_FS, 'lit'),
      emis: createProgram(gl, S.LIT_VS, S.EMIS_FS, 'emissive'),
      sky: createProgram(gl, S.SKY_VS, S.SKY_FS, 'sky'),
      water: createProgram(gl, S.WATER_VS, S.WATER_FS, 'water'),
      enemy: createProgram(gl, S.ENEMY_VS, S.ENEMY_FS, 'enemy'),
      beam: createProgram(gl, S.BEAM_VS, S.BEAM_FS, 'beam'),
      sprite: createProgram(gl, S.SPRITE_VS, S.SPRITE_FS, 'sprite'),
      post: createProgram(gl, S.POST_VS, S.POST_FS, 'post'),
    };
    this.post = null;
    this._initPost();

    this.triVbo = createBuffer(gl, new Float32Array([-1, -1, 3, -1, -1, 3]));
    this.beamVbo = createBuffer(gl, this._beamMesh());
    this.beamCount = 14 * 20 * 6;
    this.spriteVbo = gl.createBuffer();
    this.enemyMesh = {};
    this.world = null;

    this.proj = new Float32Array(16);
    this.view = new Float32Array(16);
    this.vp = new Float32Array(16);
    this.model = new Float32Array(16);
    this.u = {};
    this.scale = 1;
    this.fov = 1.2;
    this.brightness = 1;
    this.planes = new Float32Array(24);
    this.stats = { chunks: 0, drawn: 0 };
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _beamMesh() {
    const R = 14, S2 = 20;
    const v = [];
    for (let r = 0; r < R; r++) {
      const t0 = r / R, t1 = (r + 1) / R;
      for (let k = 0; k < S2; k++) {
        const a0 = (k / S2) * TAU, a1 = ((k + 1) / S2) * TAU;
        v.push(t0, a0, t1, a0, t1, a1, t0, a0, t1, a1, t0, a1);
      }
    }
    return new Float32Array(v);
  }

  setScale(s) {
    this.scale = Math.max(0.55, Math.min(1, s));
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75) * this.scale;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.post) this._sizePost(this.canvas.width, this.canvas.height);
  }

  // ---- offscreen post-processing targets
  _initPost() {
    const gl = this.gl;
    try {
      this.prog.bright = createProgram(gl, S.POST_VS, S.BRIGHT_FS, 'bright');
      this.prog.blur = createProgram(gl, S.POST_VS, S.BLUR_FS, 'blur');
      this.prog.comp = createProgram(gl, S.POST_VS, S.COMP_FS, 'composite');
      this.post = { ok: false, w: 0, h: 0, scene: null, a1: null, b1: null, a2: null, b2: null };
    } catch (e) {
      console.warn('Post-processing disabled:', e && e.message ? e.message : e);
      this.post = null;
    }
  }

  _makeTarget(w, h, depth) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (depth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        // some drivers refuse the packed format: fall back to a plain 16-bit depth buffer
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, null);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      }
    }
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex, fbo, rb, w, h, ok };
  }

  _freeTarget(t) {
    if (!t) return;
    const gl = this.gl;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
    if (t.rb) gl.deleteRenderbuffer(t.rb);
  }

  _sizePost(w, h) {
    const po = this.post;
    if (!po || (po.w === w && po.h === h)) return;
    for (const k of ['scene', 'a1', 'b1', 'a2', 'b2']) { this._freeTarget(po[k]); po[k] = null; }
    const q = (v, d) => Math.max(1, Math.ceil(v / d));
    po.scene = this._makeTarget(w, h, true);
    po.a1 = this._makeTarget(q(w, 4), q(h, 4), false);
    po.b1 = this._makeTarget(q(w, 4), q(h, 4), false);
    po.a2 = this._makeTarget(q(w, 8), q(h, 8), false);
    po.b2 = this._makeTarget(q(w, 8), q(h, 8), false);
    po.w = w;
    po.h = h;
    po.ok = [po.scene, po.a1, po.b1, po.a2, po.b2].every((t) => t.ok);
    if (!po.ok) console.warn('Offscreen targets incomplete; drawing directly to the canvas.');
  }

  _pass(prog, target, textures, uniforms, cw, ch) {
    const gl = this.gl;
    useProgram(gl, prog);
    bindLayout(gl, prog, this.triVbo, TRI_LAYOUT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : cw, target ? target.h : ch);
    for (let i = 0; i < textures.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, textures[i]);
    }
    setUniforms(gl, prog, uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // bright-pass -> two blur levels -> composite (FXAA, bloom, grade, vignette, grain) onto the canvas
  _composite(f, cw, ch) {
    const gl = this.gl, P = this.prog, po = this.post;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(false);
    const tex = (t) => t.tex;
    this._pass(P.bright, po.a1, [tex(po.scene)], { u_src: 0, u_texel: [1 / cw, 1 / ch], u_thr: 0.62 }, cw, ch);
    this._pass(P.blur, po.b1, [tex(po.a1)], { u_src: 0, u_dir: [1 / po.a1.w, 0] }, cw, ch);
    this._pass(P.blur, po.a1, [tex(po.b1)], { u_src: 0, u_dir: [0, 1 / po.a1.h] }, cw, ch);
    this._pass(P.blur, po.a2, [tex(po.a1)], { u_src: 0, u_dir: [2 / po.a1.w, 0] }, cw, ch);
    this._pass(P.blur, po.b2, [tex(po.a2)], { u_src: 0, u_dir: [0, 1 / po.a2.h] }, cw, ch);
    this._pass(P.blur, po.a2, [tex(po.b2)], { u_src: 0, u_dir: [1 / po.a2.w, 0] }, cw, ch);
    this._pass(P.blur, po.b2, [tex(po.a2)], { u_src: 0, u_dir: [0, 1 / po.a2.h] }, cw, ch);
    this._pass(P.comp, null, [tex(po.scene), tex(po.a1), tex(po.b2)], {
      u_scene: 0, u_bloomA: 1, u_bloomB: 2, u_rcp: [1 / cw, 1 / ch],
      u_time: f.time, u_dmg: f.dmg, u_vig: f.vig, u_bloom: 1.0,
    }, cw, ch);
    gl.activeTexture(gl.TEXTURE0);
    gl.depthMask(true);
  }

  setEnemyMeshes(m) {
    const gl = this.gl;
    for (const k in m) this.enemyMesh[k] = { vbo: createBuffer(gl, m[k]), count: m[k].length / 11 };
  }

  disposeWorld() {
    const gl = this.gl;
    const w = this.world;
    if (!w) return;
    const del = (b) => { if (b) gl.deleteBuffer(b); };
    del(w.terrain.vbo); del(w.terrain.ibo);
    for (const c of w.lit) del(c.vbo);
    for (const c of w.grass) del(c.vbo);
    for (const k in w.emis) del(w.emis[k].vbo);
    if (w.water) { del(w.water.vbo); del(w.water.ibo); }
    this.world = null;
  }

  uploadWorld(data) {
    const gl = this.gl;
    this.disposeWorld();
    const mk = (arr) => (arr && arr.length ? { vbo: createBuffer(gl, arr), count: arr.length / 11 } : null);
    const mkChunks = (list) => (list || []).map((c) => ({ vbo: createBuffer(gl, c.data), count: c.count, min: c.min, max: c.max }));
    const w = {
      terrain: {
        vbo: createBuffer(gl, data.terrain.vertices),
        ibo: createBuffer(gl, data.terrain.indices, gl.ELEMENT_ARRAY_BUFFER),
        count: data.terrain.indices.length,
      },
      lit: mkChunks(data.lit),
      grass: mkChunks(data.grass),
      emis: {},
      water: null,
    };
    for (const k in data.emis) { const m = mk(data.emis[k]); if (m) w.emis[k] = m; }
    if (data.water) {
      w.water = {
        vbo: createBuffer(gl, data.water.vertices),
        ibo: createBuffer(gl, data.water.indices, gl.ELEMENT_ARRAY_BUFFER),
        count: data.water.indices.length,
      };
    }
    this.world = w;
  }

  _uniforms(f) {
    const u = this.u, m = f.mood, fl = f.fl, c = f.cam;
    u.u_vp = this.vp;
    u.u_time = f.time;
    u.u_cam = c.pos;
    u.u_moonDir = m.moonDir; u.u_moonCol = m.moonCol;
    u.u_ambSky = m.ambSky; u.u_ambGnd = m.ambGnd;
    u.u_fogCol = m.fogCol; u.u_fogDen = m.fogDen; u.u_fogBase = m.fogBase;
    u.u_exposure = m.exposure * this.brightness;
    u.u_skyHor = m.skyHor; u.u_skyZen = m.skyZen;
    u.u_starAmt = m.starAmt; u.u_cloudAmt = m.cloudAmt;
    u.u_windAmt = m.windAmt;
    u.u_waterY = f.waterY;
    u.u_fl = [fl.on ? fl.intensity : 0, fl.cosOuter, fl.cosInner, fl.range];
    u.u_flPos = fl.pos; u.u_flDir = fl.dir; u.u_flCol = [1.0, 0.93, 0.80];
    u.u_pl = f.pl; u.u_plc = f.plc;
    const b = f.beacon;
    if (b && b.on) {
      u.u_s2p = [b.x, b.y, b.z, 12];
      u.u_s2d = [b.dir[0], b.dir[1], b.dir[2], b.cosOuter];
      u.u_s2e = [b.cosInner, b.range, 0, 0];
      u.u_s2c = [1.0, 0.92, 0.75];
    } else {
      u.u_s2p = [0, 0, 0, 0]; u.u_s2d = [0, -1, 0, 1]; u.u_s2e = [1, 1, 0, 0]; u.u_s2c = [0, 0, 0];
    }
    u.u_camRight = c.right; u.u_camUp = c.up; u.u_camFwd = c.fwd;
    u.u_tanFov = Math.tan(this.fov / 2);
    u.u_aspect = this.canvas.width / this.canvas.height;
    u.u_pxScale = this.canvas.height / (2 * Math.tan(this.fov / 2));
  }

  _beam(apex, dir, len, half, col, bint) {
    const gl = this.gl, p = this.prog.beam;
    const bs = basisFor(dir);
    setUniforms(gl, p, {
      u_vp: this.vp, u_cam: this.u.u_cam, u_apex: apex, u_bfwd: dir, u_bright: bs.right, u_bup: bs.up,
      u_len: len, u_tanHalf: Math.tan(half), u_bcol: col, u_bint: bint,
    });
    gl.drawArrays(gl.TRIANGLES, 0, this.beamCount);
  }

  render(f) {
    if (this.lost || !this.world) return;
    const gl = this.gl, P = this.prog, W = this.world;
    const cw = this.canvas.width, ch = this.canvas.height;
    const c = f.cam;
    mat4Perspective(this.proj, this.fov, cw / ch, 0.08, 520);
    mat4LookAt(this.view, c.pos[0], c.pos[1], c.pos[2], c.pos[0] + c.fwd[0], c.pos[1] + c.fwd[1], c.pos[2] + c.fwd[2], 0, 1, 0);
    mat4Mul(this.vp, this.proj, this.view);
    this._uniforms(f);
    const u = this.u;

    if (this.post) this._sizePost(cw, ch);
    const post = this.post && this.post.ok ? this.post : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, post ? post.scene.fbo : null);
    gl.viewport(0, 0, cw, ch);
    gl.depthMask(true);
    gl.clearColor(f.mood.fogCol[0], f.mood.fogCol[1], f.mood.fogCol[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    // sky
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    useProgram(gl, P.sky);
    setUniforms(gl, P.sky, u);
    bindLayout(gl, P.sky, this.triVbo, TRI_LAYOUT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // opaque world
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    useProgram(gl, P.lit);
    setUniforms(gl, P.lit, u);
    setUniforms(gl, P.lit, { u_bump: 1 });
    bindLayout(gl, P.lit, W.terrain.vbo, LIT_LAYOUT);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, W.terrain.ibo);
    gl.drawElements(gl.TRIANGLES, W.terrain.count, gl.UNSIGNED_SHORT, 0);
    setUniforms(gl, P.lit, { u_bump: 0 });

    // props and grass are split into ground chunks: skip those outside the view or lost in the fog
    frustumPlanes(this.vp, this.planes);
    const fogDen = Math.max(f.mood.fogDen, 0.002);
    const cullLit = Math.min(3.0 / fogDen, 300);
    const cullGrass = Math.min(2.0 / fogDen, 130);
    let seen = 0, drawn = 0;
    for (const [list, maxD] of [[W.lit, cullLit], [W.grass, cullGrass]]) {
      const lim = maxD * maxD;
      for (let i = 0; i < list.length; i++) {
        const ch2 = list[i];
        seen++;
        if (boxDist2(ch2.min, ch2.max, c.pos[0], c.pos[2]) > lim) continue;
        if (!boxVisible(this.planes, ch2.min, ch2.max, 1.0)) continue;
        bindLayout(gl, P.lit, ch2.vbo, LIT_LAYOUT);
        gl.drawArrays(gl.TRIANGLES, 0, ch2.count);
        drawn++;
      }
    }
    this.stats.chunks = seen;
    this.stats.drawn = drawn;

    useProgram(gl, P.emis);
    setUniforms(gl, P.emis, u);
    for (const k in W.emis) {
      const s = f.emisScale[k] === undefined ? 1 : f.emisScale[k];
      if (s <= 0.001) continue;
      setUniforms(gl, P.emis, { u_emisScale: s });
      bindLayout(gl, P.emis, W.emis[k].vbo, LIT_LAYOUT);
      gl.drawArrays(gl.TRIANGLES, 0, W.emis[k].count);
    }

    // enemies
    if (f.enemies.length) {
      useProgram(gl, P.enemy);
      setUniforms(gl, P.enemy, u);
      let bound = '';
      for (const e of f.enemies) {
        const mesh = this.enemyMesh[e.kind === 'boss' ? 'boss' : 'walker'];
        if (!mesh) continue;
        if (bound !== e.kind) { bindLayout(gl, P.enemy, mesh.vbo, LIT_LAYOUT); bound = e.kind; }
        mat4Model(this.model, e.x, e.y, e.z, e.yaw, e.scale);
        setUniforms(gl, P.enemy, {
          u_model: this.model, u_shield: e.shield, u_dissolve: e.dissolve, u_hit: e.hit, u_alert: e.alert || 0, u_seed: e.seed,
        });
        gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      }
    }

    // water (alpha blended)
    if (W.water) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      useProgram(gl, P.water);
      setUniforms(gl, P.water, u);
      bindLayout(gl, P.water, W.water.vbo, WATER_LAYOUT);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, W.water.ibo);
      gl.drawElements(gl.TRIANGLES, W.water.count, gl.UNSIGNED_SHORT, 0);
    }

    // additive: light shafts, then sprites
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    useProgram(gl, P.beam);
    bindLayout(gl, P.beam, this.beamVbo, BEAM_LAYOUT);
    const fl = f.fl;
    if (fl.on && fl.intensity > 0.2) {
      this._beam(fl.pos, fl.dir, fl.range * 0.8, fl.halfAngle, [1.0, 0.93, 0.8], (0.05 + 0.06 * fl.focus) * Math.min(1, fl.intensity / 9));
    }
    const b = f.beacon;
    if (b && b.on) this._beam([b.x, b.y, b.z], b.dir, b.range, b.half, [1.0, 0.92, 0.75], 0.11);

    const sp = f.sprites;
    if (sp.n > 0) {
      useProgram(gl, P.sprite);
      setUniforms(gl, P.sprite, { u_vp: this.vp, u_pxScale: u.u_pxScale });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteVbo);
      gl.bufferData(gl.ARRAY_BUFFER, sp.data.subarray(0, sp.n * 9), gl.DYNAMIC_DRAW);
      bindLayout(gl, P.sprite, this.spriteVbo, SPRITE_LAYOUT);
      gl.drawArrays(gl.POINTS, 0, sp.n);
    }

    if (post) {
      this._composite(f, cw, ch);
    } else {
      // fallback: vignette, then grain, blended over the finished frame
      gl.disable(gl.DEPTH_TEST);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      useProgram(gl, P.post);
      bindLayout(gl, P.post, this.triVbo, TRI_LAYOUT);
      setUniforms(gl, P.post, { u_time: f.time, u_dmg: f.dmg, u_vig: f.vig, u_mode: 0 });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      setUniforms(gl, P.post, { u_mode: 1 });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
