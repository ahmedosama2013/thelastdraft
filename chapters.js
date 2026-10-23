// Four chapters: terrain config, mood, props, pickups, pages and the scripted beats (set pieces).
// buildWorld(index) returns a world object holding CPU mesh data (uploaded by render.js) and gameplay data.

import { clamp, norm3 } from './math.js';
import { makeRng } from './noise.js';
import { makeTerrain, buildTerrainMesh, buildWaterMesh, ColliderGrid } from './terrain.js';
import {
  MeshBuilder, addPine, addDeadTree, addRock, addGrass, addStump, addLampPost, addCabin, addCar,
  addGate, addPowerPole, addDock, addBoathouse, addGasStation, addLighthouse, addSignpost, chunkMesh,
} from './props.js';
import { NARR } from './story.js';

// ------------------------------------------------------------------------------------------------ world base
function createWorld(def) {
  const T = makeTerrain(def.terrain);
  const w = {
    index: def.index, def, T, size: T.size, bound: T.half - 4, waterY: T.waterY,
    heightAt: T.heightAt,
    colliders: new ColliderGrid(12, T.half + 10),
    platforms: [], lamps: [], pages: [], pickups: [], interacts: [],
    clear: [], occluders: [], trees: new Map(),
    lit: new MeshBuilder(), grass: new MeshBuilder(), emis: {}, emisScale: {},
    beats: [], start: { x: 0, z: 0, yaw: 0 }, data: null,
  };
  w.emisB = (name) => {
    if (!w.emis[name]) { w.emis[name] = new MeshBuilder(); w.emisScale[name] = 1; }
    return w.emis[name];
  };
  const onPlat = (p, x, z) => {
    const dx = x - p.x, dz = z - p.z;
    const lx = p.c * dx - p.s * dz, lz = p.s * dx + p.c * dz;
    return Math.abs(lx) <= p.hx && Math.abs(lz) <= p.hz;
  };
  w.onPlatform = (x, z) => {
    for (const p of w.platforms) if (onPlat(p, x, z)) return true;
    return false;
  };
  w.groundAt = (x, z) => {
    let g = T.heightAt(x, z);
    for (const p of w.platforms) if (p.y > g && onPlat(p, x, z)) g = p.y;
    return g;
  };
  w.lampByName = (n) => w.lamps.find((l) => l.name === n);
  w.blocked = (ax, ay, az, bx, by, bz) => {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.max(2, Math.ceil(len / 1.5));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      const g = T.heightAt(x, z);
      if (y < g + 0.05) return true;
      if (w.colliders.hitsPoint(x, z, y, g)) return true;
    }
    return false;
  };
  return w;
}

const inClear = (w, x, z) => {
  for (const c of w.clear) if (Math.hypot(x - c.x, z - c.z) < c.r) return true;
  return false;
};

function nearTree(w, x, z, r) {
  const ix = Math.floor(x / 2.6), iz = Math.floor(z / 2.6);
  const k = Math.ceil(r / 2.6);
  for (let a = -k; a <= k; a++) {
    for (let b = -k; b <= k; b++) {
      const list = w.trees.get((ix + a) * 4096 + (iz + b));
      if (!list) continue;
      for (const t of list) if (Math.hypot(t[0] - x, t[1] - z) < r) return true;
    }
  }
  return false;
}

function addPage(w, id, x, z) {
  const p = { id, x, z, y: w.groundAt(x, z) + 1.15, visible: false, read: false };
  w.pages.push(p);
  return p;
}
// Optional margin note: visible from the start, never required by a beat. Kept clear of trees.
function addNote(w, id, x, z) {
  const p = addPage(w, id, x, z);
  p.visible = true;
  p.optional = true;
  w.clear.push({ x, z, r: 2.2 });
  return p;
}
function addPickup(w, kind, x, z) {
  w.pickups.push({ kind, x, z, y: w.groundAt(x, z) + 0.45, taken: false });
  w.clear.push({ x, z, r: 1.4 });
}
function addInteract(w, id, x, z, prompt, hold, onDone) {
  const it = { id, x, z, r: 2.4, prompt, hold, progress: 0, active: false, done: false, onDone };
  w.interacts.push(it);
  return it;
}

// ------------------------------------------------------------------------------------------------ scatter
function scatter(w, rng, s) {
  const T = w.T;
  const half = T.half - 6;
  if (s.trees) {
    const o = s.trees;
    let placed = 0, tries = 0;
    while (placed < o.count && tries < o.count * 14) {
      tries++;
      const x = (rng() * 2 - 1) * half, z = (rng() * 2 - 1) * half;
      const pd = T.pathDist(x, z);
      if (pd < (o.pathClear || 5)) continue;
      if (rng() > clamp(0.25 + pd / 45, 0.25, 1)) continue;
      const g = T.heightAt(x, z);
      if (g < w.waterY + 0.8) continue;
      if (inClear(w, x, z)) continue;
      if (nearTree(w, x, z, o.spacing || 2.4)) continue;
      const key = Math.floor(x / 2.6) * 4096 + Math.floor(z / 2.6);
      let list = w.trees.get(key);
      if (!list) { list = []; w.trees.set(key, list); }
      list.push([x, z]);
      const dead = o.kind === 'dead' || (o.kind === 'mixed' && rng() < (o.deadFrac || 0.5));
      const h = o.hMin + rng() * (o.hMax - o.hMin);
      if (dead) {
        addDeadTree(w.lit, x, g, z, 3.5 + rng() * 3.5, rng);
        w.colliders.addCircle(x, z, 0.3, 6);
        w.occluders.push({ x, z, h: 5, r: 0.9 });
      } else {
        addPine(w.lit, x, g, z, h, rng);
        w.colliders.addCircle(x, z, 0.28 + h * 0.01, h);
        w.occluders.push({ x, z, h, r: h * 0.13 + 0.6 });
      }
      placed++;
    }
  }
  if (s.rocks) {
    const o = s.rocks;
    for (let i = 0, n = 0; i < o.count * 6 && n < o.count; i++) {
      const x = (rng() * 2 - 1) * half, z = (rng() * 2 - 1) * half;
      if (T.pathDist(x, z) < 3.5 || inClear(w, x, z)) continue;
      const g = T.heightAt(x, z);
      if (g < w.waterY + 0.5) continue;
      const r = o.rMin + rng() * (o.rMax - o.rMin);
      addRock(w.lit, x, g, z, r, rng, [0.07, 0.075, 0.08]);
      w.colliders.addCircle(x, z, r * 0.75, r);
      n++;
    }
  }
  if (s.grass) {
    const o = s.grass;
    const path = T.cfg.path;
    for (let i = 0, n = 0; i < o.count * 3 && n < o.count; i++) {
      const si = Math.floor(rng() * (path.length - 1));
      const t = rng();
      const px = path[si][0] + (path[si + 1][0] - path[si][0]) * t;
      const pz = path[si][1] + (path[si + 1][1] - path[si][1]) * t;
      const x = px + (rng() * 2 - 1) * o.maxPath, z = pz + (rng() * 2 - 1) * o.maxPath;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      if (T.pathDist(x, z) < T.pathW * 0.45) continue;
      const g = T.heightAt(x, z);
      if (g < w.waterY + 0.3) continue;
      if (inClear(w, x, z) || nearTree(w, x, z, 1.0)) continue;
      const v = 0.75 + rng() * 0.5;
      const col = [o.color[0] * v, o.color[1] * v, o.color[2] * v];
      addGrass(w.grass, x, g, z, o.hMin + rng() * (o.hMax - o.hMin), rng, col);
      n++;
    }
  }
}

// ------------------------------------------------------------------------------------------------ beat helpers
// Beat: { hint (string | fn(ctx)), target ({x,z} | null), start(c), update(c, dt) -> bool, retry(c), done(c) }
function reachBeat(hint, x, z, r, o = {}) {
  return {
    hint, target: { x, z },
    start(c) { if (o.say) c.say(o.say, 5); if (o.start) o.start(c); },
    update(c) { return c.dist(x, z) < r; },
    retry() {},
    done(c) { if (o.done) o.done(c); },
  };
}

function pageBeat(page, hint, o = {}) {
  return {
    hint, target: { x: page.x, z: page.z },
    start(c) { page.visible = true; if (o.say) c.say(o.say, 5); if (o.start) o.start(c); },
    update() { return page.read; },
    retry() {},
    done(c) { if (o.done) o.done(c); },
  };
}

function holdBeat(it, hint, o = {}) {
  return {
    hint, target: { x: it.x, z: it.z },
    start(c) { it.active = true; it.done = false; it.progress = 0; if (o.start) o.start(c); },
    update() { return it.done; },
    retry() { it.active = true; },
    done(c) { if (o.done) o.done(c); },
  };
}

// waves: [{ kind, n, delay, whenLeft, minD, maxD, at:{x,z,spread}, extra:[{kind,n}] }]
function waveBeat(hint, waves, o = {}) {
  let wi = 0, clearT = 0;
  const spawnOne = (c, wv, kind) => {
    const w = c.world;
    let e = null;
    if (wv.at) e = c.enemies.spawnNear(w, c.light, kind, wv.at.x, wv.at.z, wv.at.spread || 8);
    if (!e) e = c.enemies.spawnAround(w, c.player, c.light, kind, wv.minD || 24, wv.maxD || 34);
    return e;
  };
  return {
    hint, target: o.target || null, combat: true,
    start(c, retry) { wi = 0; clearT = 0; if (retry) c.enemies.clearAll(); else c.killAll(); if (o.start) o.start(c); },
    update(c, dt) {
      if (wi < waves.length) {
        const wv = waves[wi];
        if (c.enemies.aliveCount() <= (wv.whenLeft || 0)) clearT += dt; else clearT = 0;
        if (clearT >= (wv.delay || 0)) {
          for (let i = 0; i < (wv.n || 1); i++) spawnOne(c, wv, wv.kind);
          for (const ex of wv.extra || []) for (let i = 0; i < ex.n; i++) spawnOne(c, wv, ex.kind);
          wi++;
          clearT = 0;
          if (o.onWave) o.onWave(c, wi - 1);
        }
        return false;
      }
      return c.enemies.aliveCount() === 0;
    },
    retry(c) { this.start(c, true); },
    done(c) { if (o.done) o.done(c); },
  };
}

function siegeBeat(seconds) {
  let t = 0, spawnT = 0, failT = 0, fails = [];
  const names = ['canopy0', 'canopy1', 'canopy2'];
  const restore = (c) => {
    for (const n of [...names, 'storeLamp']) {
      const l = c.world.lampByName(n);
      if (l) { l.on = true; l.flick = 0; }
    }
    fails = [];
  };
  return {
    hint: () => `Hold the light. ${Math.max(0, Math.ceil(seconds - t))}`,
    target: null, combat: true,
    start(c, retry) {
      t = 0; spawnT = 1.5; failT = 7; fails = [];
      if (retry) c.enemies.clearAll(); else c.killAll();
      restore(c);
      c.say(NARR.siegeStart, 4);
    },
    update(c, dt) {
      t += dt; spawnT -= dt; failT -= dt;
      if (spawnT <= 0 && t < seconds - 6) {
        spawnT = 11;
        const n = t > 20 ? 3 : 2;
        for (let i = 0; i < n; i++) c.enemies.spawnAround(c.world, c.player, c.light, 'walker', 22, 32);
        if (t > 25) c.enemies.spawnAround(c.world, c.player, c.light, 'runner', 24, 34);
      }
      if (failT <= 0 && t < seconds - 5) {
        failT = 8;
        const l = c.world.lampByName(names[Math.floor(Math.random() * 3)]);
        if (l && l.on) fails.push({ l, t: 0 });
      }
      for (let i = fails.length - 1; i >= 0; i--) {
        const f = fails[i];
        f.t += dt;
        if (f.t < 1) f.l.flick = 1;
        else if (f.t < 6) { f.l.flick = 0; f.l.on = false; }
        else { f.l.on = true; f.l.flick = 0; fails.splice(i, 1); }
      }
      return t >= seconds;
    },
    retry(c) { this.start(c, true); },
    done(c) { restore(c); c.killAll(); c.say(NARR.siegeEnd, 4); },
  };
}

function bossBeat(spawnX, spawnZ) {
  let boss = null, minionT = 0;
  return {
    hint: 'Strip its shield. Then give it light.', combat: true,
    get target() { return boss && boss.alive ? { x: boss.x, z: boss.z } : null; },
    start(c, retry) {
      if (retry) c.enemies.clearAll(); else c.killAll();
      boss = c.enemies.spawnNear(c.world, c.light, 'boss', spawnX, spawnZ, 4) ||
        c.enemies.spawnAround(c.world, c.player, c.light, 'boss', 28, 34);
      minionT = 14;
      c.say(NARR.bossIntro, 5);
    },
    update(c, dt) {
      if (!boss || !boss.alive) return true;
      minionT -= dt;
      if (minionT <= 0) {
        minionT = 17;
        if (c.enemies.aliveCount() < 4) {
          c.enemies.spawnAround(c.world, c.player, c.light, 'walker', 22, 30);
          c.enemies.spawnAround(c.world, c.player, c.light, 'walker', 22, 30);
        }
      }
      return false;
    },
    retry(c) { this.start(c, true); },
    done(c) { c.killAll(); },
  };
}

// ------------------------------------------------------------------------------------------------ moods
const mood = (hor, zen, moon, moonCol, ambSky, ambGnd, fogDen, extra) => Object.assign({
  skyHor: hor, skyZen: zen, moonDir: norm3(moon), moonCol,
  // ambient lifted ~30% so the forest reads outside the beam without losing the dark
  ambSky: ambSky.map((v) => v * 1.3), ambGnd: ambGnd.map((v) => v * 1.35),
  fogCol: hor, fogDen, fogBase: 0, exposure: 1.7, starAmt: 1.0, cloudAmt: 0.35, windAmt: 1.0,
}, extra || {});

// ------------------------------------------------------------------------------------------------ chapters
export const CHAPTERS = [
  // ---------------------------------------------------------------- I. The pine forest
  {
    index: 0, seed: 11,
    name: 'The Pine Forest',
    mood: mood([0.022, 0.036, 0.050], [0.003, 0.007, 0.018], [-0.35, 0.60, -0.72], [0.38, 0.52, 0.82],
      [0.022, 0.036, 0.060], [0.012, 0.016, 0.014], 0.0115),
    audio: { wind: 0.45, crickets: 0.5, drone: 0.4, surface: 'grass' },
    terrain: {
      seed: 11, size: 300, res: 192, hillAmp: 8, hillFreq: 0.012, detailAmp: 1.2, base: 0,
      path: [[0, 142], [0, 126], [-4, 108], [8, 86], [22, 62], [18, 38], [2, 18], [-14, -4], [-24, -26],
        [-12, -52], [6, -76], [10, -100], [0, -125], [-4, -134], [-4, -146]],
      pathW: 3.4,
      flats: [{ x: 0, z: 126, r: 12, h: 0.6, fall: 8 }, { x: -14, z: -4, r: 17, h: 1.0, fall: 9 }, { x: -4, z: -134, r: 9, h: 0.5, fall: 8 }],
      palette: {
        ground: [0.040, 0.055, 0.034], ground2: [0.070, 0.075, 0.045], path: [0.10, 0.082, 0.062],
        rock: [0.085, 0.09, 0.095], shore: [0.12, 0.11, 0.09],
      },
    },
    scatter: {
      trees: { count: 1500, kind: 'pine', hMin: 8, hMax: 15, pathClear: 5 },
      rocks: { count: 70, rMin: 0.5, rMax: 1.6 },
      grass: { count: 9000, maxPath: 60, color: [0.05, 0.085, 0.04], hMin: 0.45, hMax: 0.95 },
    },
    populate(w) {
      w.start = { x: 0, z: 134, yaw: 0 };
      addCar(w, 4.2, 129, 0.12, { name: 'carLights' });
      addLampPost(w, -3.6, 122, { name: 'lamp0', radius: 8.5 });
      const p1 = addPage(w, 'p1', 0.4, 117);
      addLampPost(w, 11, 71, { name: 'lamp1' });
      const p2 = addPage(w, 'p2', 19, 41);
      addLampPost(w, 25, 36, { name: 'lamp2' });
      const ring = [];
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        ring.push(addLampPost(w, -14 + Math.cos(a) * 11, -4 + Math.sin(a) * 11, { name: 'ring' + i, radius: 7.5 }));
      }
      const top = addStump(w, -14, -4);
      const p3 = addPage(w, 'p3', -14, -4);
      p3.y = top + 0.65;
      addLampPost(w, -7, -54, { name: 'lamp5' });
      addLampPost(w, 12, -74, { name: 'lamp6' });
      addGate(w, -4, -134, 0);
      addSignpost(w, 3, 110, 0.4);
      addSignpost(w, 9, -96, -0.3);
      for (const [x, z] of [[6, 100], [24, 56], [-4, 12], [-18, -34], [8, -90]]) addPickup(w, 'flare', x, z);
      for (const [x, z] of [[14, 76], [-20, -30], [12, -98]]) addPickup(w, 'battery', x, z);
      addNote(w, 'n1', 11, 98);
      addNote(w, 'n2', -27, -37);

      const ringOn = () => ring.forEach((l) => { l.on = true; l.flick = 0; });
      w.beats = [
        pageBeat(p1, 'Read the page.', { say: NARR.controls }),
        reachBeat('Follow the road north.', 20, 60, 8),
        waveBeat('Something is waiting. Burn the shadow away, then finish it with light.',
          [{ kind: 'walker', n: 1, delay: 1, minD: 24, maxD: 30 }], { start: (c) => c.say(NARR.firstContact, 5) }),
        pageBeat(p2, 'Read the page.'),
        reachBeat('Into the clearing.', -14, -4, 12),
        pageBeat(p3, 'Read the page on the stump.'),
        waveBeat('The lamps are failing. Hold the light.', [
          { kind: 'walker', n: 2, delay: 1, minD: 22, maxD: 30 },
          { kind: 'walker', n: 2, extra: [{ kind: 'runner', n: 1 }], delay: 3, minD: 22, maxD: 30 },
        ], {
          start: ringOn,
          onWave: (c, i) => { if (i === 1) { ring[0].on = false; ring[2].on = false; } },
          done: (c) => { ringOn(); c.say(NARR.clearingDone, 5); },
        }),
        reachBeat('Follow the road toward the gate.', 6, -76, 8),
        waveBeat('They kept pace with you. Burn the shadow, then give it light.', [
          { kind: 'walker', n: 2, extra: [{ kind: 'runner', n: 1 }], delay: 1, minD: 22, maxD: 30 },
        ]),
        reachBeat('Reach the gate.', -4, -132, 6),
      ];
    },
  },

  // ---------------------------------------------------------------- II. Greywater
  {
    index: 1, seed: 23,
    name: 'Greywater',
    mood: mood([0.030, 0.050, 0.056], [0.004, 0.010, 0.018], [0.40, 0.55, -0.70], [0.34, 0.52, 0.75],
      [0.026, 0.044, 0.058], [0.012, 0.018, 0.018], 0.0150, { cloudAmt: 0.5 }),
    audio: { wind: 0.35, crickets: 0.15, drone: 0.55, surface: 'grass' },
    terrain: {
      seed: 23, size: 300, res: 192, hillAmp: 5, hillFreq: 0.014, detailAmp: 1.0, base: 3.2, waterY: 0.4,
      lakes: [{ x: -22, z: -12, r: 54, bed: -4.2 }],
      path: [[58, 142], [56, 118], [50, 92], [46, 64], [48, 34], [46, 6], [42, -22], [38, -44], [26, -62],
        [8, -78], [-14, -92], [-30, -100], [-36, -112], [-38, -146]],
      pathW: 3.2,
      flats: [{ x: 58, z: 132, r: 10, h: 3.4, fall: 8 }, { x: -2, z: -72, r: 10, h: 2.4, fall: 6 }, { x: -44, z: -108, r: 12, h: 3.4, fall: 8 }],
      palette: {
        ground: [0.040, 0.058, 0.042], ground2: [0.060, 0.072, 0.050], path: [0.09, 0.08, 0.065],
        rock: [0.08, 0.09, 0.095], shore: [0.10, 0.10, 0.085],
      },
    },
    scatter: {
      trees: { count: 1100, kind: 'mixed', deadFrac: 0.2, hMin: 8, hMax: 14, pathClear: 5 },
      rocks: { count: 90, rMin: 0.5, rMax: 1.8 },
      grass: { count: 8000, maxPath: 55, color: [0.045, 0.08, 0.045], hMin: 0.5, hMax: 1.0 },
    },
    populate(w) {
      w.start = { x: 58, z: 138, yaw: 0 };
      const p4 = addPage(w, 'p4', 55, 122);
      addSignpost(w, 53.5, 122, 0.2);
      addLampPost(w, 54, 110, { name: 'lamp0' });
      addLampPost(w, 44, 70, { name: 'lamp1' });
      addLampPost(w, 51, 10, { name: 'lamp2' });
      addLampPost(w, 33, -46, { name: 'lamp3' });
      const dock = addDock(w, 32, -14, -Math.PI / 2, 18, 2.4);
      addLampPost(w, 26.5, -13.0, { baseY: dock.top, name: 'dockLamp0', radius: 8 });
      addLampPost(w, 19.5, -13.0, { baseY: dock.top, name: 'dockLamp1', radius: 8 });
      const p5 = addPage(w, 'p5', 15, -14.5);
      const boat = addBoathouse(w, -2, -72, 0);
      const gen = addInteract(w, 'gen', boat.gen.x, boat.gen.z, 'Hold E to start the generator', 3.2, null);
      const cab = addCabin(w, -44, -108, Math.PI / 2, { name: 'cabin', group: 'cabin', on: false });
      addLampPost(w, 12, -74, { name: 'lamp4' });
      addLampPost(w, -33, -102, { name: 'lamp5' });
      addLampPost(w, -36, -134, { name: 'lamp6' });
      const p6 = addPage(w, 'p6', cab.door.x, cab.door.z);
      for (const [x, z] of [[56, 96], [48, 40], [40, -34], [-10, -86], [-30, -108]]) addPickup(w, 'flare', x, z);
      for (const [x, z] of [[47, 80], [44, -10], [-24, -98]]) addPickup(w, 'battery', x, z);
      addNote(w, 'n3', 62, 90);
      addNote(w, 'n4', -20, -90);

      w.emisScale.cabin = 0;
      w.emisScale.boathouse = 0;
      w.emisScale.genOn = 0;
      gen.onDone = (c) => {
        w.emisScale.genOff = 0;
        w.emisScale.genOn = 1;
        w.emisScale.cabin = 1;
        w.emisScale.boathouse = 1;
        for (const n of ['boatLamp', 'cabinPorch', 'cabinIn']) { const l = w.lampByName(n); if (l) l.on = true; }
        c.say(NARR.generator, 5);
      };
      w.beats = [
        pageBeat(p4, 'Read the page by the trail sign.'),
        reachBeat('Follow the shore road.', 46, 6, 8),
        waveBeat('You are not alone out here. Burn the shadow, then give it light.',
          [{ kind: 'walker', n: 2, delay: 1, minD: 22, maxD: 30 }]),
        reachBeat('Walk out onto the dock.', 19, -14, 4),
        pageBeat(p5, 'Read the page at the end of the dock.'),
        reachBeat('Find the boathouse on the north shore.', -2, -66, 9),
        holdBeat(gen, 'Start the generator beside the boathouse.'),
        waveBeat('The lights drew them. Hold the shore.', [
          { kind: 'walker', n: 3, delay: 2, at: { x: -14, z: -74, spread: 12 }, minD: 22, maxD: 30 },
          { kind: 'walker', n: 2, extra: [{ kind: 'runner', n: 1 }], delay: 4, at: { x: -10, z: -70, spread: 14 }, minD: 22, maxD: 30 },
        ]),
        pageBeat(p6, 'The cabin door is open.'),
        waveBeat('Something followed you off the water.', [
          { kind: 'walker', n: 2, delay: 1, minD: 22, maxD: 30 },
        ]),
        reachBeat('Take the trail north.', -38, -138, 6),
      ];
    },
  },

  // ---------------------------------------------------------------- III. Ottley's
  {
    index: 2, seed: 37,
    name: 'Ottley\u2019s',
    mood: mood([0.040, 0.041, 0.048], [0.006, 0.008, 0.016], [0.10, 0.50, -0.85], [0.42, 0.48, 0.70],
      [0.030, 0.034, 0.048], [0.016, 0.015, 0.014], 0.0095, { cloudAmt: 0.65, starAmt: 0.7 }),
    audio: { wind: 0.6, crickets: 0, drone: 0.5, surface: 'dirt' },
    terrain: {
      seed: 37, size: 300, res: 192, hillAmp: 3.2, hillFreq: 0.01, detailAmp: 0.8, base: 0.5,
      path: [[0, 142], [0, 110], [1, 80], [0, 50], [0, 20], [2, -10], [0, -40], [-1, -70], [0, -100], [0, -130], [0, -146]],
      pathW: 5.0,
      flats: [{ x: 20, z: -8, r: 30, h: 1.2, fall: 14 }, { x: 0, z: 134, r: 10, h: 0.5, fall: 8 }],
      palette: {
        ground: [0.058, 0.054, 0.040], ground2: [0.085, 0.075, 0.050], path: [0.045, 0.045, 0.05],
        rock: [0.08, 0.08, 0.085], shore: [0.1, 0.1, 0.09],
      },
    },
    scatter: {
      trees: { count: 420, kind: 'mixed', deadFrac: 0.7, hMin: 7, hMax: 12, pathClear: 7 },
      rocks: { count: 120, rMin: 0.5, rMax: 1.8 },
      grass: { count: 6000, maxPath: 70, color: [0.07, 0.07, 0.04], hMin: 0.4, hMax: 0.85 },
    },
    populate(w) {
      w.start = { x: 0, z: 134, yaw: 0 };
      addLampPost(w, 3.5, 126, { name: 'startLamp' });
      for (let z = 132; z >= -140; z -= 28) addPowerPole(w, -6, z, 0);
      addLampPost(w, 4, 92, { name: 'road0' });
      addLampPost(w, -3.5, 56, { name: 'road1' });
      addLampPost(w, 4, 26, { name: 'road2' });
      addCar(w, -3.2, 62, 0.25, { noLights: true, color: [0.07, 0.05, 0.04] });
      addCar(w, 8, 20, 1.2, { noLights: true, color: [0.05, 0.06, 0.07] });
      const st = addGasStation(w, 12, -8, 0);
      const p7 = addPage(w, 'p7', 6, 4);
      const p8 = addPage(w, 'p8', 12, -8);
      const p9 = addPage(w, 'p9', 1.5, -17);
      const brk = addInteract(w, 'breaker', st.breaker.x, st.breaker.z, 'Hold E to throw the main breaker', 2.6, null);
      addLampPost(w, 4, -52, { name: 'road3' });
      addLampPost(w, -4, -90, { name: 'road4' });
      addLampPost(w, 4, -122, { name: 'road5' });
      for (const [x, z] of [[2, 100], [6, 70], [-2, 34], [24, 8], [-3, -60], [3, -100]]) addPickup(w, 'flare', x, z);
      for (const [x, z] of [[3, 84], [22, -22], [-4, -80]]) addPickup(w, 'battery', x, z);
      addNote(w, 'n5', 14, 72);
      addNote(w, 'n6', -12, -84);

      for (const g of ['canopy', 'store', 'sign', 'pumps']) w.emisScale[g] = 0;
      brk.onDone = (c) => {
        for (const g of ['canopy', 'store', 'sign', 'pumps']) w.emisScale[g] = 1;
        w.emisScale.breaker = 0;
        for (const n of ['canopy0', 'canopy1', 'canopy2', 'storeLamp', 'signLamp']) { const l = w.lampByName(n); if (l) l.on = true; }
        c.say(NARR.generator.replace('The engine caught.', 'The breaker thunked.'), 5);
      };
      w.beats = [
        reachBeat('Follow the highway north.', 2, 50, 10),
        waveBeat('The dark follows the road. Burn the shadow, then give it light.',
          [{ kind: 'walker', n: 2, delay: 1, minD: 24, maxD: 32 }]),
        reachBeat('Reach the gas station.', 6, 6, 8),
        pageBeat(p7, 'Read the page.'),
        pageBeat(p8, 'Read the page under the canopy.'),
        holdBeat(brk, 'Restore the power. The breaker box is behind the store.'),
        siegeBeat(55),
        pageBeat(p9, 'A page glows beneath the sign.'),
        reachBeat('Follow the highway north.', 0, -100, 8),
        waveBeat('The dark has caught up. Burn the shadow, then give it light.', [
          { kind: 'walker', n: 2, extra: [{ kind: 'runner', n: 1 }], delay: 1, minD: 22, maxD: 30 },
        ]),
        reachBeat('Follow the highway north.', 0, -132, 6),
      ];
    },
  },

  // ---------------------------------------------------------------- IV. Cinder Point
  {
    index: 3, seed: 41,
    name: 'Cinder Point',
    mood: mood([0.020, 0.040, 0.060], [0.002, 0.006, 0.020], [-0.50, 0.62, -0.60], [0.44, 0.58, 0.90],
      [0.022, 0.042, 0.068], [0.012, 0.017, 0.018], 0.0115, { cloudAmt: 0.25, starAmt: 1.2, windAmt: 1.8 }),
    audio: { wind: 0.8, crickets: 0, drone: 0.6, surface: 'grass' },
    terrain: {
      seed: 41, size: 300, res: 192, hillAmp: 5, hillFreq: 0.013, detailAmp: 1.0, base: 1.5, waterY: 0.6,
      ramp: { z0: 50, z1: -70, h: 14 },
      lakes: [{ x: 105, z: -10, r: 75, bed: -8 }, { x: 60, z: -120, r: 55, bed: -8 }],
      path: [[10, 142], [10, 122], [6, 98], [-2, 70], [-12, 48], [-4, 26], [8, 4], [2, -22], [-10, -50], [-14, -72], [-10, -90]],
      pathW: 3.2,
      flats: [{ x: -10, z: -98, r: 36, h: 15.6, fall: 20 }, { x: 10, z: 134, r: 12, h: 2.0, fall: 8 }],
      palette: {
        ground: [0.040, 0.055, 0.040], ground2: [0.065, 0.070, 0.050], path: [0.10, 0.085, 0.07],
        rock: [0.09, 0.095, 0.10], shore: [0.11, 0.105, 0.09],
      },
    },
    scatter: {
      trees: { count: 750, kind: 'pine', hMin: 6, hMax: 12, pathClear: 6 },
      rocks: { count: 150, rMin: 0.6, rMax: 2.2 },
      grass: { count: 7000, maxPath: 55, color: [0.05, 0.075, 0.045], hMin: 0.4, hMax: 0.9 },
    },
    populate(w) {
      w.start = { x: 10, z: 136, yaw: 0 };
      addLampPost(w, 3.5, 128, { name: 'startLamp' });
      const p10 = addPage(w, 'p10', 11, 124);
      addLampPost(w, 10, 96, { name: 'lamp0' });
      addLampPost(w, -6, 66, { name: 'lamp1' });
      const p11 = addPage(w, 'p11', -9, 46);
      addLampPost(w, -10, 40, { name: 'lamp2' });
      addLampPost(w, 12, 2, { name: 'lamp3' });
      addLampPost(w, -7, -48, { name: 'lamp4' });
      addLampPost(w, -18, -70, { name: 'lamp5' });
      const lh = addLighthouse(w, -10, -98);
      addLampPost(w, -1, -88, { name: 'lhLamp0', radius: 9 });
      addLampPost(w, -19, -88, { name: 'lhLamp1', radius: 9 });
      const p12 = addPage(w, 'p12', -10, -91);
      const beacon = addInteract(w, 'beacon', lh.door.x, lh.door.z, 'Hold E to light the beacon', 3.0, null);
      for (const [x, z] of [[8, 110], [-8, 60], [6, 10], [-12, -60], [-6, -86], [-14, -86]]) addPickup(w, 'flare', x, z);
      for (const [x, z] of [[4, 90], [-2, 20], [-14, -66], [-4, -84]]) addPickup(w, 'battery', x, z);
      addNote(w, 'n7', 16, 106);
      addNote(w, 'n8', -22, -60);

      w.emisScale.beacon = 0;
      beacon.onDone = (c) => {
        w.emisScale.beacon = 1;
        c.light.startBeacon(-10, lh.top, -98);
        c.shake(1.2);
        c.say(NARR.beacon, 5);
      };
      w.beats = [
        pageBeat(p10, 'Read the page.'),
        reachBeat('Climb toward the light.', -2, 70, 8),
        waveBeat('They are waiting on the hill.', [
          { kind: 'walker', n: 2, delay: 1, minD: 22, maxD: 30 },
          { kind: 'runner', n: 1, delay: 2, minD: 22, maxD: 30 },
        ]),
        reachBeat('Keep climbing.', -12, 48, 8),
        pageBeat(p11, 'Read the page.'),
        reachBeat('The lighthouse is ahead.', -12, -70, 10),
        waveBeat('The headland is crowded. Hold the light.', [
          { kind: 'walker', n: 3, delay: 1, minD: 22, maxD: 30 },
          { kind: 'walker', n: 2, extra: [{ kind: 'runner', n: 1 }], delay: 3, minD: 22, maxD: 30 },
        ]),
        holdBeat(beacon, 'Light the beacon at the foot of the tower.'),
        bossBeat(10, -74),
        pageBeat(p12, 'Read the last page.'),
      ];
    },
  },
];

// ------------------------------------------------------------------------------------------------ build
export function buildWorld(index) {
  const def = CHAPTERS[index];
  const rng = makeRng(def.seed * 7 + 3);
  const w = createWorld(def);
  def.populate(w, rng);
  scatter(w, rng, def.scatter);
  const terrain = buildTerrainMesh(w.T, { moonDir: def.mood.moonDir, occluders: w.occluders });
  const water = buildWaterMesh(w.T);
  const data = {
    terrain, water,
    lit: chunkMesh(w.lit.data(), 40, w.T.half),
    grass: chunkMesh(w.grass.data(), 40, w.T.half),
    emis: {},
  };
  for (const k in w.emis) data.emis[k] = w.emis[k].data();
  w.data = data;
  w.lit = null;
  w.grass = null;
  w.emis = {};
  w.occluders = [];
  w.trees = new Map();
  return w;
}
