// THE LAST DRAFT: bootstrap, state machine and the game loop.

import { Renderer, SpriteBatch } from './render.js';
import { Input } from './input.js';
import { AudioSys } from './audio.js';
import { UI } from './ui.js';
import { Player } from './player.js';
import { LightSystem } from './light.js';
import { EnemyManager, buildEnemyMeshes } from './enemy.js';
import { buildWorld, CHAPTERS } from './chapters.js';
import { CHAPTER_INFO, NARR, PAGES, ENDING, NOTE_TOTAL } from './story.js';
import { clamp, lerp, TAU, wrapPi, norm3 } from './math.js';

// ------------------------------------------------------------------------------------------ persistence
const SAVE_KEY = 'lastdraft.save.v1';
let memSave = null;
function loadSave() {
  try {
    const s = window.localStorage.getItem(SAVE_KEY);
    if (s) {
      const o = JSON.parse(s);
      if (o && Number.isInteger(o.chapter) && o.chapter >= 0 && o.chapter < CHAPTERS.length) return o;
    }
  } catch (e) { /* storage unavailable */ }
  return memSave;
}
function writeSave(o) {
  memSave = o;
  try { window.localStorage.setItem(SAVE_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
}
const hasSave = () => { const s = loadSave(); return !!(s && s.chapter > 0); };

// options (brightness, look sensitivity) live under their own key
const OPT_KEY = 'lastdraft.opts.v1';
const BRIGHT = [0.85, 1.0, 1.25, 1.55];
const BRIGHT_LABEL = ['Dim', 'Normal', 'Bright', 'Brighter'];
const SENS = [0.6, 1.0, 1.5, 2.0];
const SENS_LABEL = ['Low', 'Normal', 'High', 'Very high'];
const opts = { bright: 1, sens: 1 };
try {
  const o = JSON.parse(window.localStorage.getItem(OPT_KEY) || 'null');
  if (o && Number.isInteger(o.bright) && o.bright >= 0 && o.bright < BRIGHT.length) opts.bright = o.bright;
  if (o && Number.isInteger(o.sens) && o.sens >= 0 && o.sens < SENS.length) opts.sens = o.sens;
} catch (e) { /* storage unavailable */ }
function saveOpts() {
  try { window.localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------------------------------ systems
const canvas = document.getElementById('gl');
const ui = new UI();
const input = new Input(canvas);
const audio = new AudioSys();
const light = new LightSystem();
const enemies = new EnemyManager();
const player = new Player();
const sprites = new SpriteBatch(2600);

let renderer = null;
try {
  renderer = new Renderer(canvas);
  renderer.setEnemyMeshes(buildEnemyMeshes());
} catch (err) {
  console.error(err);
  ui.fatal('This browser could not start WebGL, so the dark cannot be drawn. Try a current version of Chrome, Edge, Firefox or Safari, with hardware acceleration enabled.');
}

const G = {
  state: 'boot', ch: 0, world: null, beat: 0, beatStarted: false, finishing: false, outroT: 0, transitioning: false,
  clock: 0, time: 0, titleT: 0, resolve: 100, hurt: 0, shake: 0, checkpoint: null, haven: null,
  reading: null, dying: false, target: null, cam: null, prevScreen: null,
  inv: { flares: 2, spare: 1 }, havenSaid: false, breakSaid: false, lowSaid: false, heartT: 0, errors: 0,
  fpsAcc: 0, fpsN: 0, fpsT: 0, lastRegen: 0, fov: 1.2, titleEnemies: [],
  notes: new Set(), quietKill: false, lastHaven: null,
  chT: 0, ambT: 0, ambNext: 60, ambCount: 0, anyPage: false,
  holdUntil: 0, holdLen: 20, upTried: false,
};
{
  const s0 = loadSave();
  if (s0 && Array.isArray(s0.notes)) for (const id of s0.notes) if (typeof id === 'string' && PAGES[id] && PAGES[id].note) G.notes.add(id);
}
const AMBIENT_CAP = [3, 4, 4, 3];
const saveState = () => writeSave({ chapter: G.ch, notes: [...G.notes] });

const particles = [];
const dust = [];
for (let i = 0; i < 140; i++) dust.push({ a: Math.random(), b: Math.random(), c: Math.random(), spd: 0.04 + Math.random() * 0.06, rot: (Math.random() - 0.5) * 0.6 });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------ beat context
const ctx = {
  G, player, light, enemies, ui, audio,
  get world() { return G.world; },
  say: (t, d) => ui.say(t, d || 4.5),
  dist: (x, z) => Math.hypot(player.x - x, player.z - z),
  killAll: () => { G.quietKill = true; enemies.dissolveAll(G.env); G.quietKill = false; },
  shake: (a) => { G.shake = Math.max(G.shake, a); },
};

function burst(x, y, z, n, col, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, s = (0.4 + Math.random()) * (speed || 1.6);
    particles.push({
      x, y, z, vx: Math.cos(a) * s, vy: 0.6 + Math.random() * 1.8, vz: Math.sin(a) * s,
      life: 1.2 + Math.random() * 1.2, max: 2.4, col, size: 0.05 + Math.random() * 0.06,
    });
  }
}

G.env = {
  dt: 0, time: 0, world: null, light, player: { x: 0, y: 0, z: 0, fwdX: 0, fwdZ: -1 }, fl: light.fl, tmp: null,
  beamTarget: null, beamDist: 1e9,
  onHurt(dmg, e) {
    if (G.dying) return;
    G.resolve -= dmg;
    G.hurt = 1;
    G.shake = Math.max(G.shake, 0.7);
    audio.hurt();
    if (e) ui.hurtFrom(wrapPi(Math.atan2(e.x - player.x, -(e.z - player.z)) - player.yaw));
    if (G.resolve <= 0) die();
  },
  onKill(e) {
    if (!G.quietKill) {
      enemies.kills++;
      ui.reticleKill();
      audio.kill();
    }
    audio.shimmer(e.x, e.y + 1, e.z);
    burst(e.x, e.y + e.height * 0.5, e.z, e.boss ? 90 : 36, [1.0, 0.75, 0.4], e.boss ? 3.5 : 1.6);
  },
  onEvent(name, e) {
    if (name === 'shieldBreak') {
      audio.shieldBreak();
      burst(e.x, e.y + e.height * 0.5, e.z, 18, [1.0, 0.9, 0.7], 1.8);
      if (!G.breakSaid) {
        G.breakSaid = true;
        ui.say(NARR.shieldBreak, 4);
        ui.toast('Finish it with a flare, or lure it into a lamp');
      }
    } else if (name === 'whisper') {
      audio.whisper(e.x, e.y + 1.4, e.z);
    } else if (name === 'appear') {
      light.triggerGlitch(0.5);
      audio.sting();
    } else if (name === 'windup') {
      audio.growl(e.x, e.y + 1.2, e.z);
    }
  },
};

// ------------------------------------------------------------------------------------------ chapter lifecycle
const NO_THREATS = [];

function failLoad(e) {
  console.error(e);
  ui.loading(false);
  ui.fade(false, 200);
  ui.fatal('The scene failed to load: ' + (e && e.message ? e.message : e) + ' Reloading the page may help.');
}

function loadChapter(idx) {
  const w = buildWorld(idx);
  G.world = w;
  G.ch = idx;
  G.beat = 0;
  G.beatStarted = false;
  G.finishing = false;
  G.transitioning = false;
  G.target = null;
  renderer.uploadWorld(w.data);
  w.data = null;
  audio.killFlares();
  light.reset(w.lamps);
  light.flareCount = Math.max(G.inv.flares, 2);
  light.fl.spare = Math.max(G.inv.spare, 1);
  enemies.reset();
  particles.length = 0;
  player.reset(w.start.x, w.start.z, w.start.yaw, w);
  G.checkpoint = { x: w.start.x, z: w.start.z, yaw: w.start.yaw };
  G.resolve = 100;
  G.hurt = 0;
  G.haven = null;
  G.reading = null;
  G.dying = false;
  G.lowSaid = false;
  G.lastHaven = null;
  G.chT = 0; G.ambT = 0; G.ambNext = 45 + Math.random() * 40; G.ambCount = 0; G.anyPage = false;
  G.fpsAcc = 0; G.fpsN = 0; G.fpsT = 0;
  for (const pg of w.pages) if (G.notes.has(pg.id)) pg.read = true;
  G.env.world = w;
  audio.setMood(w.def.audio);
  audio.setHaven(false);
  ui.setHaven(false);
  ui.clearSubs();
  ui.hideChapterCard();
  ui.setObjective('');
  ui.setReticle(false, 0, null);
  ui.setThreats(NO_THREATS);
  if (idx > 0) saveState();
}

function introFor(idx) {
  const info = CHAPTER_INFO[idx];
  ui.chapterCard(info.roman, info.title, info.sub, 4600);
  info.intro.forEach((l) => ui.say(l, 4.6));
}

async function startGame(chapter) {
  try {
    ui.showScreen(null);
    await ui.fade(true, 500);
    ui.loading(true);
    await wait(60);
    if (chapter === 0) G.inv = { flares: 2, spare: 1 };
    loadChapter(chapter);
    ui.loading(false);
    G.state = 'play';
    ui.showHud(true);
    ui.setPrompt(null);
    introFor(chapter);
    ui.fade(false, 1400);
  } catch (e) { failLoad(e); }
}

async function transitionTo(idx) {
  G.state = 'busy';
  G.inv = { flares: light.flareCount, spare: light.fl.spare };
  try {
    await ui.fade(true, 1100);
    ui.loading(true);
    await wait(60);
    loadChapter(idx);
    ui.loading(false);
    G.state = 'play';
    introFor(idx);
    ui.fade(false, 1400);
  } catch (e) { failLoad(e); }
}

async function restartChapter() {
  audio.resume();
  ui.showScreen(null);
  G.state = 'busy';
  try {
    await ui.fade(true, 500);
    ui.loading(true);
    await wait(60);
    loadChapter(G.ch);
    ui.loading(false);
    G.state = 'play';
    input.requestLock();
    ui.fade(false, 1000);
  } catch (e) { failLoad(e); }
}

async function gotoTitle() {
  G.state = 'busy';
  ui.closePage();
  ui.setPrompt(null);
  input.releaseLock();
  audio.killFlares();
  audio.resume();
  try {
    await ui.fade(true, 700);
    ui.showHud(false);
    ui.showScreen(null);
    ui.loading(true);
    await wait(60);
    G.inv = { flares: 2, spare: 1 };
    loadChapter(0);
    light.fl.on = false;
    ui.loading(false);
    setupTitle();
    ui.showScreen('title');
    ui.fade(false, 1200);
  } catch (e) { failLoad(e); }
}

function setupTitle() {
  G.state = 'title';
  G.titleT = 0;
  ui.setBeginLabel(hasSave());
  const w = G.world;
  G.titleEnemies = [];
  for (const [x, z] of [[-11, 93], [15, 89], [3, 82]]) {
    G.titleEnemies.push({
      kind: 'walker', x, y: w.groundAt(x, z), z, yaw: Math.PI + Math.random() * 0.6 - 0.3,
      scale: 1, shield: 1, dissolve: 0, hit: 0, seed: Math.random() * 100,
    });
  }
}

async function showEnding() {
  G.state = 'ending';
  await ui.fade(true, 1600);
  audio.killFlares();
  input.releaseLock();
  ui.showHud(false);
  ui.setPrompt(null);
  ui.clearSubs();
  const kept = G.notes.size;
  G.notes = new Set();
  writeSave({ chapter: 0, notes: [] });
  G.inv = { flares: 2, spare: 1 };
  ui.showEnding(ENDING.title, ENDING.lines.concat([ENDING.noteLine(kept)]));
  ui.fade(false, 1500);
}

async function die() {
  if (G.dying || G.state !== 'play') return;
  G.dying = true;
  audio.killFlares();
  ui.say(NARR.death[Math.floor(Math.random() * NARR.death.length)], 4);
  await ui.fade(true, 900);
  const w = G.world;
  const cp = G.checkpoint;
  player.reset(cp.x, cp.z, cp.yaw, w);
  G.resolve = 100;
  G.hurt = 0;
  enemies.clearAll();
  light.flares.length = 0;
  particles.length = 0;
  const b = w.beats[G.beat];
  if (b && b.retry) b.retry(ctx);
  await wait(350);
  await ui.fade(false, 900);
  G.dying = false;
}

// ------------------------------------------------------------------------------------------ pause / menus
function pause() {
  if (G.state !== 'play') return;
  G.state = 'pause';
  ui.closePage();
  if (G.reading) finishRead(G.reading);
  G.reading = null;
  ui.setPrompt(null);
  ui.setReticle(false, 0, null);
  ui.setThreats(NO_THREATS);
  ui.showScreen('pause');
  input.releaseLock();
  audio.suspend();
}
function unpause() {
  if (G.state !== 'pause') return;
  audio.resume();
  input.requestLock();
  ui.showScreen(null);
  G.state = 'play';
}

ui.on('begin', () => {
  audio.init();
  audio.resume();
  input.requestLock();
  const s = loadSave();
  startGame(s && s.chapter > 0 ? s.chapter : 0);
});
ui.on('anew', () => {
  audio.init();
  audio.resume();
  input.requestLock();
  G.notes = new Set();
  writeSave({ chapter: 0, notes: [] });
  startGame(0);
});
function cycleOpt(name) {
  if (name === 'bright') opts.bright = (opts.bright + 1) % BRIGHT.length;
  else opts.sens = (opts.sens + 1) % SENS.length;
  applyOpts();
  saveOpts();
}
function applyOpts() {
  if (renderer) renderer.brightness = BRIGHT[opts.bright];
  player.sensMul = SENS[opts.sens];
  ui.setOption('bright', BRIGHT_LABEL[opts.bright]);
  ui.setOption('sens', SENS_LABEL[opts.sens]);
}
ui.on('bright', () => cycleOpt('bright'));
ui.on('sens', () => cycleOpt('sens'));
applyOpts();
ui.on('controls', () => { G.prevScreen = ui.currentScreen(); ui.showScreen('controls'); });
ui.on('credits', () => { G.prevScreen = ui.currentScreen(); ui.showScreen('credits'); });
ui.on('back', () => ui.showScreen(G.prevScreen || 'title'));
ui.on('unpause', unpause);
ui.on('restart', () => restartChapter());
ui.on('quit', () => gotoTitle());
ui.on('toTitle', () => gotoTitle());

input.onEscape = () => {
  if (G.state === 'play') pause();
  else if (G.state === 'pause') {
    const s = ui.currentScreen();
    if (s === 'controls' || s === 'credits') ui.showScreen(G.prevScreen || 'pause');
    else unpause();
  } else if (G.state === 'title') {
    const s = ui.currentScreen();
    if (s === 'controls' || s === 'credits') ui.showScreen('title');
  }
};
input.onLockLost = () => { if (G.state === 'play') pause(); };
window.addEventListener('blur', () => { if (G.state === 'play') pause(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'play') pause(); });

// ------------------------------------------------------------------------------------------ beats
function startFinish() {
  G.finishing = true;
  G.target = null;
  ui.setObjective('');
  const info = CHAPTER_INFO[G.ch];
  info.outro.forEach((l) => ui.say(l, 4.2));
  G.outroT = info.outro.length ? info.outro.length * 4.6 + 1.5 : 2.5;
}

function updateBeats(dt) {
  const w = G.world;
  if (G.finishing) {
    G.outroT -= dt;
    if (G.outroT <= 0 && !G.transitioning) {
      G.transitioning = true;
      if (G.ch >= CHAPTERS.length - 1) showEnding();
      else transitionTo(G.ch + 1);
    }
    return;
  }
  const b = w.beats[G.beat];
  if (!b) { startFinish(); return; }
  if (!G.beatStarted) {
    G.beatStarted = true;
    if (b.start) b.start(ctx);
  }
  if (typeof b.hint === 'function') ui.setObjective(b.hint(ctx), true);
  else ui.setObjective(b.hint);
  G.target = b.target || null;
  if (b.update(ctx, dt)) {
    if (b.done) b.done(ctx);
    G.beat++;
    G.beatStarted = false;
  }
}

// ------------------------------------------------------------------------------------------ gameplay
// A margin note only counts once it has been put away (or the game was paused while reading it).
function finishRead(pg) {
  const meta = PAGES[pg.id];
  if (!meta || !meta.note || G.notes.has(pg.id)) return;
  G.notes.add(pg.id);
  saveState();
  ui.toast('Margin notes ' + G.notes.size + ' of ' + NOTE_TOTAL, 3.4);
  if (G.notes.size === NOTE_TOTAL) ui.say(NARR.noteAll, 5);
  else if (G.notes.size === 1) ui.say(NARR.noteFound, 4.5);
}

const retTarget = { frac: 0, exposed: false };
const threatPool = [];
for (let i = 0; i < 12; i++) threatPool.push({ rel: 0, near: 0 });
const threatList = [];
const THREAT_RANGE = 26;

function updateThreats() {
  let n = 0;
  for (const e of enemies.list) {
    if (!e.alive || n >= threatPool.length) continue;
    const d = Math.hypot(e.x - player.x, e.z - player.z);
    if (d > THREAT_RANGE) continue;
    const rel = wrapPi(Math.atan2(e.x - player.x, -(e.z - player.z)) - player.yaw);
    if (Math.abs(rel) < 0.45) continue; // straight ahead: you can see it
    const t = threatPool[n++];
    t.rel = rel;
    t.near = clamp(1 - d / THREAT_RANGE, 0, 1);
  }
  threatList.length = 0;
  for (let i = 0; i < n; i++) threatList.push(threatPool[i]);
  if (n > 1) threatList.sort((a, b) => b.near - a.near);
  ui.setThreats(threatList);
}

function updateAmbient(dt) {
  G.chT += dt;
  const w = G.world, b = w.beats[G.beat];
  if (G.finishing || G.haven || (b && b.combat) || G.chT < 25 || !G.anyPage) return;
  if (enemies.aliveCount() > 0 || G.ambCount >= AMBIENT_CAP[G.ch]) return;
  if (!(light.flareCount > 0 || light.fl.battery > 0.4)) return;
  for (const it of w.interacts) if (it.progress > 0) return;
  if (player.speed > 0.8) G.ambT += dt;
  if (G.ambT >= G.ambNext) {
    G.ambT = 0;
    G.ambNext = 45 + Math.random() * 40;
    G.ambCount++;
    enemies.spawnAround(w, player, light, 'walker', 26, 34);
  }
}

function updatePlay(dt) {
  const w = G.world;
  G.time += dt;

  if (G.reading) {
    ui.setReticle(false, 0, null);
    ui.setThreats(NO_THREATS);
    if (input.pressed('KeyE') || input.pressed('Mouse0')) {
      if (ui.pageAdvance() === 'closed') {
        const pg = G.reading;
        G.reading = null;
        finishRead(pg);
      }
    }
    return;
  }

  player.update(dt, input, w);
  if (player.stepEvent) {
    const wet = w.waterY > -1e8 && w.groundAt(player.x, player.z) < w.waterY + 0.1;
    audio.step(w.onPlatform(player.x, player.z) ? 'wood' : wet ? 'water' : w.def.audio.surface, player.sprinting);
  }
  ui.setStamina(player.stamina, player.winded);
  if (player.windedEvent) audio.breath();

  const eye = player.eye();
  const B = player.basis();

  if (input.pressed('KeyQ') && light.toggle()) audio.click(light.fl.on);
  if (input.pressed('KeyR') && light.swapBattery()) { audio.pickup(); ui.toast('A fresh battery'); }
  if (input.pressed('KeyM')) audio.setMuted(!audio.muted);
  if (input.pressed('KeyF')) {
    if (light.throwFlare(eye[0] + B.fwd[0] * 0.5, eye[1] - 0.2, eye[2] + B.fwd[2] * 0.5, B.fwd[0], B.fwd[1], B.fwd[2])) {
      audio.flareThrow();
      audio.flareBurn(24);
    } else ui.toast('No flares left');
  }

  // safe havens
  const hv = light.havenAt(player.x, player.y + 1, player.z);
  const inHaven = !!hv;
  if (hv && hv !== G.haven) {
    G.checkpoint = { x: player.x, z: player.z, yaw: player.yaw };
    if (!G.havenSaid) { G.havenSaid = true; ui.say(NARR.haven, 3.5); }
    if (hv !== G.lastHaven) { G.lastHaven = hv; ui.toast('Checkpoint', 2.2); }
  }
  if (inHaven !== !!G.haven) { audio.setHaven(inHaven); ui.setHaven(inHaven); }
  G.haven = hv;

  light.setPose(eye, B.fwd, B.right, B.up, dt);
  light.update(dt, input.focusHeld(), inHaven, w);
  if (light.lastEvent === 'swap') { audio.pickup(); ui.toast('A fresh battery'); }
  const fl = light.fl;
  if (fl.battery < 0.2 && fl.spare === 0 && !G.lowSaid && fl.on) { G.lowSaid = true; ui.say(NARR.lowBattery, 4); }
  if (fl.battery > 0.6) G.lowSaid = false;

  // resolve
  G.hurt = Math.max(0, G.hurt - dt * 1.2);
  if (inHaven) G.resolve = Math.min(100, G.resolve + 30 * dt);
  else if (G.hurt <= 0.05) G.resolve = Math.min(100, G.resolve + 3 * dt);
  G.shake = Math.max(0, G.shake - dt * 1.6);
  if (G.resolve < 35 && G.resolve > 0) {
    G.heartT -= dt;
    if (G.heartT <= 0) { G.heartT = 0.6 + G.resolve / 60; audio.heart(); }
  }

  // pickups, pages, interactions
  let prompt = null, progress = null;
  for (const pk of w.pickups) {
    if (pk.taken || Math.hypot(pk.x - player.x, pk.z - player.z) > 1.4) continue;
    pk.taken = true;
    if (pk.kind === 'battery') { light.fl.spare = Math.min(3, light.fl.spare + 1); ui.toast('A spare battery'); }
    else { light.flareCount = Math.min(6, light.flareCount + 2); ui.toast('Two flares'); }
    audio.pickup();
  }
  for (const pg of w.pages) {
    if (!pg.visible || pg.read || Math.hypot(pg.x - player.x, pg.z - player.z) > 2.6) continue;
    prompt = pg.optional ? 'E to read the margin note' : 'E to read the page';
    if (input.pressed('KeyE')) {
      pg.read = true;
      G.anyPage = true;
      G.reading = pg;
      ui.openPage(PAGES[pg.id].folio, PAGES[pg.id].text);
      audio.pageTone();
      prompt = null;
    }
  }
  for (const it of w.interacts) {
    if (!it.active || it.done) continue;
    if (Math.hypot(it.x - player.x, it.z - player.z) < it.r + 0.6) {
      prompt = it.prompt;
      if (input.isDown('KeyE')) {
        it.progress += dt;
        progress = it.progress / it.hold;
        if (it.progress >= it.hold) {
          it.done = true;
          it.active = false;
          audio.stinger();
          if (it.onDone) it.onDone(ctx);
        }
      } else it.progress = Math.max(0, it.progress - dt * 1.5);
    } else it.progress = 0;
  }
  ui.setPrompt(prompt, progress);

  // enemies
  const env = G.env;
  env.dt = dt;
  env.time = G.time;
  env.world = w;
  env.player.x = player.x; env.player.y = player.y; env.player.z = player.z;
  env.player.fwdX = player.fwdX; env.player.fwdZ = player.fwdZ;
  env.beamTarget = null;
  env.beamDist = 1e9;
  enemies.update(dt, env);

  const bt = env.beamTarget;
  let burning = false;
  if (bt && bt.alive && fl.on) {
    retTarget.frac = bt.shieldMax ? bt.shield / bt.shieldMax : 0;
    retTarget.exposed = bt.shield <= 0;
    burning = bt.shield > 0 && fl.power > 0.05;
    ui.setReticle(true, fl.focus, retTarget);
  } else {
    ui.setReticle(true, fl.focus, null);
  }
  updateThreats();

  updateBeats(dt);
  updateAmbient(dt);

  // flare sparks and particles
  for (const f of light.flares) {
    if (f.out > 0.2 && Math.random() < dt * 40) {
      particles.push({ x: f.x, y: f.y + 0.1, z: f.z, vx: (Math.random() - 0.5) * 0.8, vy: 1.2 + Math.random() * 1.8, vz: (Math.random() - 0.5) * 0.8, life: 0.7, max: 0.7, col: [1.0, 0.5, 0.25], size: 0.05 });
    }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.vy += 0.4 * dt;
  }

  // audio + hud
  const near = enemies.nearestDist(player.x, player.z);
  audio.update(dt, near < 1e8 ? clamp(1 - near / 30, 0, 1) : 0, burning);
  audio.setListener(eye[0], eye[1], eye[2], B.fwd[0], B.fwd[1], B.fwd[2]);
  ui.setBattery(fl.battery, fl.spare, fl.battery < 0.18);
  ui.setFlares(light.flareCount);
  let rel = null;
  if (G.target) rel = wrapPi(Math.atan2(G.target.x - player.x, -(G.target.z - player.z)) - player.yaw);
  ui.setCompass(player.yaw, rel);
}

// ------------------------------------------------------------------------------------------ camera + frame
function playCamera(dt) {
  const eye = player.eye();
  const B = player.basis();
  const s = G.shake * 0.05;
  G.fov += ((player.sprinting && player.speed > 3 ? 1.27 : 1.2) - G.fov) * Math.min(1, dt * 5);
  return {
    pos: [eye[0] + (Math.random() - 0.5) * s, eye[1] + (Math.random() - 0.5) * s, eye[2] + (Math.random() - 0.5) * s],
    fwd: B.fwd, right: B.right, up: B.up,
  };
}

function titleCamera() {
  const w = G.world;
  const t = G.titleT;
  const a = t * 0.035 + 0.6, r = 24 + 4 * Math.sin(t * 0.07);
  const cx = 0, cz = 112;
  const px = cx + Math.sin(a) * r, pz = cz + Math.cos(a) * r * 0.8;
  const py = Math.max(w.groundAt(px, pz) + 2.6, w.groundAt(px, pz) + 4.2 + 1.0 * Math.sin(t * 0.11));
  const ty = w.groundAt(cx, cz - 6) + 3.4;
  const f = norm3([cx - px, ty - py, cz - 6 - pz]);
  let rx = f[2], rz = -f[0];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  const right = [rx, 0, rz];
  const up = [
    right[1] * f[2] - right[2] * f[1],
    right[2] * f[0] - right[0] * f[2],
    right[0] * f[1] - right[1] * f[0],
  ];
  return { pos: [px, py, pz], fwd: f, right, up };
}

const frameEnemies = [];
const frame = {
  time: 0, cam: null, mood: null, fl: light.fl, pl: light.pl, plc: light.plc, beacon: null, enemies: frameEnemies,
  emisScale: {}, waterY: -1e9, dmg: 0, vig: 0.95, sprites,
};

function drawScene(cam) {
  const w = G.world;
  if (!w || !renderer) return;
  const t = G.clock;
  const fl = light.fl;

  // sprites
  sprites.clear();
  for (const l of w.lamps) {
    if (l.out < 0.03 || l.glow <= 0) continue;
    sprites.add(l.x, l.y, l.z, l.color[0], l.color[1], l.color[2], 0.9 * l.out, 0.5 * l.glow, 2);
    sprites.add(l.x, l.y, l.z, l.color[0], l.color[1], l.color[2], 0.16 * l.out, 5.5 * l.glow, 0);
  }
  for (const pk of w.pickups) {
    if (pk.taken) continue;
    const c = pk.kind === 'battery' ? [0.3, 0.9, 0.9] : [1.0, 0.4, 0.2];
    const y = pk.y + 0.08 * Math.sin(t * 2 + pk.x);
    sprites.add(pk.x, y, pk.z, c[0], c[1], c[2], 0.5, 0.7, 0);
    sprites.add(pk.x, y, pk.z, c[0], c[1], c[2], 0.9, 0.12, 2);
  }
  for (const pg of w.pages) {
    if (!pg.visible || pg.read) continue;
    const y = pg.y + 0.1 * Math.sin(t * 2 + pg.x);
    sprites.add(pg.x, y, pg.z, 1.0, 0.7, 0.35, 0.35, 3.0, 0);
    sprites.add(pg.x, y, pg.z, 1.0, 0.95, 0.8, 0.95, 0.7, 1);
  }
  for (const it of w.interacts) {
    if (!it.active || it.done) continue;
    sprites.add(it.x, w.groundAt(it.x, it.z) + 1.2, it.z, 1.0, 0.55, 0.25, 0.5 + 0.2 * Math.sin(t * 3), 1.3, 0);
  }
  for (const f of light.flares) {
    sprites.add(f.x, f.y + 0.12, f.z, 1.0, 0.38, 0.22, f.out, 0.9, 0);
    sprites.add(f.x, f.y + 0.12, f.z, 1.0, 0.7, 0.5, f.out, 0.2, 2);
    sprites.add(f.x, f.y + 0.4, f.z, 1.0, 0.3, 0.15, 0.18 * f.out, 6, 0);
  }
  for (const p of particles) {
    sprites.add(p.x, p.y, p.z, p.col[0], p.col[1], p.col[2], clamp(p.life / p.max, 0, 1) * 0.9, p.size * 3, 2);
  }
  if (fl.on && fl.intensity > 0.2) {
    const half = Math.acos(fl.cosOuter), tanH = Math.tan(half);
    const reach = fl.range * 0.55 + 1.2;
    const d0 = fl.dir;
    let rx = d0[2], rz = -d0[0];
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const ux = -rz * d0[1], uy = rz * d0[0] - rx * d0[2], uz = rx * d0[1];
    const inten = Math.min(1, fl.intensity / 9);
    for (const s of dust) {
      const k = (s.a + t * s.spd) % 1;
      const d = k * reach + 1.2;
      const ang = s.b * TAU + t * s.rot;
      const rad = Math.sqrt(s.c) * tanH * d * 0.95;
      const ca = Math.cos(ang) * rad, sa = Math.sin(ang) * rad;
      const fade = Math.min(d / 3, 1) * (1 - k);
      const a = inten * 0.55 * fade * (0.5 + 0.5 * Math.sin(t * 2 + s.a * 30));
      sprites.add(
        fl.pos[0] + d0[0] * d + rx * ca + ux * sa,
        fl.pos[1] + d0[1] * d + uy * sa,
        fl.pos[2] + d0[2] * d + rz * ca + uz * sa,
        1.0, 0.95, 0.82, a, 0.035 + 0.025 * s.c, 2,
      );
    }
  }

  // enemies
  frameEnemies.length = 0;
  if (G.state === 'title') {
    for (const e of G.titleEnemies) frameEnemies.push(e);
  } else {
    for (const e of enemies.list) {
      frameEnemies.push({
        kind: e.kind, x: e.x, y: e.y, z: e.z, yaw: e.yaw, scale: e.scale,
        shield: e.shieldMax ? e.shield / e.shieldMax : 0, dissolve: e.dissolve, hit: e.hit, seed: e.seed,
        alert: e.windup > 0 ? 1 : 0,
      });
    }
  }
  // glowing eyes: cyan while shielded, ember once exposed; they fade in and out with the dissolve
  for (const e of frameEnemies) {
    const a = 1 - e.dissolve;
    if (a <= 0.02) continue;
    const exposed = e.shield <= 0;
    const al = e.alert || 0;
    const r = exposed ? 1.0 : 0.3 + 0.5 * al, g = exposed ? 0.5 : 0.95 - 0.55 * al, b2 = exposed ? 0.15 : 1.0 - 0.8 * al;
    const flick = 0.85 + 0.15 * Math.sin(t * 9 + e.seed);
    const c = Math.cos(e.yaw), sn = Math.sin(e.yaw), sc = e.scale;
    for (let k = 0; k < 2; k++) {
      const lx = (k ? 0.05 : -0.05) * sc, lz = 0.27 * sc;
      const ex = e.x + c * lx + sn * lz, ez = e.z - sn * lx + c * lz, ey = e.y + 1.8 * sc;
      sprites.add(ex, ey, ez, r, g, b2, a * flick * (1 + 0.4 * al), 0.075 * sc * (1 + 0.8 * al), 2);
      sprites.add(ex, ey, ez, r, g, b2, 0.14 * a * flick, 0.4 * sc, 0);
    }
  }

  light.gather(cam.pos[0], cam.pos[1], cam.pos[2]);
  renderer.fov = G.fov;
  frame.time = t;
  frame.cam = cam;
  frame.mood = w.def.mood;
  frame.beacon = light.beacon;
  frame.emisScale = w.emisScale;
  frame.waterY = w.waterY;
  frame.dmg = clamp(G.hurt * 0.8 + (G.resolve < 35 ? ((35 - G.resolve) / 35) * 0.4 : 0), 0, 1);
  frame.vig = G.haven ? 0.75 : 0.95;
  renderer.render(frame);
}

// ------------------------------------------------------------------------------------------ main loop
function adaptResolution(dt) {
  G.fpsAcc += dt;
  G.fpsN++;
  G.fpsT += dt;
  if (G.fpsT < 2) return;
  const avg = G.fpsAcc / G.fpsN;
  G.fpsAcc = 0; G.fpsN = 0; G.fpsT = 0;
  if (avg > 0.026 && renderer.scale > 0.56) {
    // slow: scale down, and stay down for a while. Each failed attempt to climb back doubles the hold.
    if (G.upTried) G.holdLen = Math.min(120, G.holdLen * 2);
    G.upTried = false;
    G.holdUntil = G.clock + G.holdLen;
    renderer.setScale(renderer.scale - 0.1);
  } else if (avg < 0.0185 && renderer.scale < 1 && G.clock >= G.holdUntil) {
    // 0.0185 s: a 60 Hz display that keeps up averages about 16.7 ms and must still qualify
    G.upTried = true;
    renderer.setScale(renderer.scale + 0.05);
  }
}

function tick(dt) {
  G.clock += dt;
  input.wantLock = G.state === 'play';
  try {
    ui.update(G.state === 'pause' ? 0 : dt);
    if (G.state === 'title') {
      G.titleT += dt;
      light.update(dt, false, false, G.world);
      G.cam = titleCamera();
      drawScene(G.cam);
    } else if (G.state === 'play') {
      if (!G.dying) updatePlay(dt);
      G.cam = playCamera(dt);
      drawScene(G.cam);
    } else if (G.cam && G.world) {
      drawScene(G.cam);
    }
    if (G.state === 'play' || G.state === 'title') adaptResolution(dt);
    G.errors = 0; // only a run of consecutive failures is fatal
  } finally {
    // mouse movement made while reading, paused, dying or fading must not pile up and snap the view afterwards
    if (!(G.state === 'play' && !G.dying && !G.reading)) input.consumeLook();
    input.endFrame();
  }
}

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, Math.max(0.0005, (now - last) / 1000));
  last = now;
  try {
    tick(dt);
  } catch (e) {
    console.error(e);
    if (++G.errors > 8) ui.fatal('Something went wrong while drawing the scene. Reloading the page may help. (' + e.message + ')');
  }
}

async function boot() {
  if (!renderer) return;
  ui.loading(true);
  await wait(60);
  try {
    loadChapter(0);
    light.fl.on = false;
  } catch (e) {
    console.error(e);
    ui.loading(false);
    ui.fatal('The world failed to generate: ' + e.message);
    return;
  }
  ui.loading(false);
  setupTitle();
  ui.showScreen('title');
  requestAnimationFrame(loop);
}
boot();

// Debug hook: add ?debug to the URL, then use window.__TLD from the console.
if (/[?&]debug\b/.test(location.search)) {
  window.__TLD = {
    G, player, light, enemies, renderer, ui, audio, input, ctx, opts,
    startGame, loadChapter, die,
    stats: () => (renderer ? renderer.stats : null),
    teleport(x, z) { player.x = x; player.z = z; player.y = G.world.groundAt(x, z); player.camY = player.y; },
    skipBeat() { const b = G.world.beats[G.beat]; if (b) { if (b.done) b.done(ctx); G.beat++; G.beatStarted = false; } },
  };
}