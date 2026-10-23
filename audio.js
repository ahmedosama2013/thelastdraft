// Procedural audio (Web Audio API): wind, drone, crickets, flashlight click, whispers, flare hiss,
// page tone, footsteps, heartbeat. No samples, no assets.

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.haven = false;
    this.params = { wind: 0.4, crickets: 0.3, drone: 0.4, surface: 'grass' };
    this._gustT = 0;
    this.flareNodes = [];
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(ctx.destination);

      // noise buffer (white), reused everywhere
      const len = ctx.sampleRate * 2;
      const nb = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = nb.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = nb;

      // synthetic reverb
      const irLen = Math.floor(ctx.sampleRate * 2.4);
      const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const ch = ir.getChannelData(c);
        for (let i = 0; i < irLen; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.6);
      }
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = ir;
      this.revSend = ctx.createGain();
      this.revSend.gain.value = 0.5;
      this.revSend.connect(this.reverb);
      this.reverb.connect(this.master);

      this._buildAmbience();
      this.ready = true;
    } catch (e) {
      this.ctx = null;
      this.ready = false;
    }
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.8;
  }

  _noiseSrc(loop) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = !!loop;
    return s;
  }

  _buildAmbience() {
    const ctx = this.ctx;
    // wind: band-passed noise with a slow sweep + low rumble
    const wsrc = this._noiseSrc(true);
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wsrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    wsrc.start();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 220;
    lfo.connect(lfoG);
    lfoG.connect(this.windFilter.frequency);
    lfo.start();

    const rsrc = this._noiseSrc(true);
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 170;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rsrc.connect(rf);
    rf.connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);
    rsrc.start(0, 0.7);

    // drone: detuned low oscillators
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 220;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.master);
    this.droneGain.connect(this.revSend);
    const defs = [['sawtooth', 55], ['sawtooth', 55.45], ['sine', 82.5], ['triangle', 110.3]];
    for (const [type, f] of defs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = type === 'sawtooth' ? 0.35 : 0.5;
      o.connect(g);
      g.connect(this.droneFilter);
      o.start();
    }
    const dl = ctx.createOscillator();
    dl.frequency.value = 0.045;
    const dlg = ctx.createGain();
    dlg.gain.value = 70;
    dl.connect(dlg);
    dlg.connect(this.droneFilter.frequency);
    dl.start();

    // crickets: high sine gated by two LFOs
    const co = ctx.createOscillator();
    co.type = 'sine';
    co.frequency.value = 4300;
    this.cricketGain = ctx.createGain();
    this.cricketGain.gain.value = 0;
    co.connect(this.cricketGain);
    this.cricketGain.connect(this.master);
    co.start();
    const gate = ctx.createOscillator();
    gate.type = 'square';
    gate.frequency.value = 17;
    const gateG = ctx.createGain();
    gateG.gain.value = 0.0035;
    gate.connect(gateG);
    gateG.connect(this.cricketGain.gain);
    gate.start();

    // beam-burn sizzle: filtered noise, only audible while the flashlight is eating a shield
    const ssrc = this._noiseSrc(true);
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 2100;
    sf.Q.value = 0.9;
    this.sizzleGain = ctx.createGain();
    this.sizzleGain.gain.value = 0;
    ssrc.connect(sf);
    sf.connect(this.sizzleGain);
    this.sizzleGain.connect(this.master);
    ssrc.start(0, 1.1);

    // safe-haven pad (a quiet fifth)
    this.havenGain = ctx.createGain();
    this.havenGain.gain.value = 0;
    this.havenGain.connect(this.master);
    this.havenGain.connect(this.revSend);
    for (const f of [220, 329.6]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      o.connect(g);
      g.connect(this.havenGain);
      o.start();
    }
  }

  setMood(p) {
    this.params = Object.assign({}, this.params, p);
  }

  setHaven(on) {
    this.haven = on;
  }

  _panner(x, y, z) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.rolloffFactor = 1.2;
    if (p.positionX) {
      p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    } else if (p.setPosition) {
      p.setPosition(x, y, z);
    }
    return p;
  }

  setListener(x, y, z, fx, fy, fz) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else if (l.setPosition) {
      l.setPosition(x, y, z);
      l.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  // tension 0..1, dt in seconds
  update(dt, tension, burning) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const p = this.params;
    this._gustT -= dt;
    if (this._gustT <= 0) {
      this._gustT = 2 + Math.random() * 4;
      this.windGain.gain.setTargetAtTime(0.03 + p.wind * (0.05 + Math.random() * 0.07), t, 1.4);
      this.rumbleGain.gain.setTargetAtTime(0.02 + p.wind * 0.10 * Math.random(), t, 1.6);
    }
    const calm = this.haven ? 0.5 : 1;
    this.droneGain.gain.setTargetAtTime((0.02 + p.drone * 0.04 + tension * 0.05) * calm, t, 1.0);
    this.droneFilter.frequency.setTargetAtTime(180 + tension * 420, t, 0.8);
    this.cricketGain.gain.setTargetAtTime(p.crickets * 0.005 * (1 - tension * 0.8), t, 1.2);
    this.havenGain.gain.setTargetAtTime(this.haven ? 0.018 : 0, t, 0.8);
    this.sizzleGain.gain.setTargetAtTime(burning ? 0.05 : 0, t, burning ? 0.06 : 0.12);
  }

  _burst(freq, q, dur, gain, type, dest) {
    const ctx = this.ctx, t = ctx.currentTime;
    const s = this._noiseSrc(false);
    const f = ctx.createBiquadFilter();
    f.type = type || 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(dest || this.master);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
  }

  click(on) {
    if (!this.ready) return;
    this._burst(on ? 2600 : 1800, 1.2, 0.05, 0.5, 'highpass');
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = on ? 190 : 140;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.05);
  }

  step(surface, sprint) {
    if (!this.ready) return;
    const g = sprint ? 0.2 : 0.12;
    if (surface === 'water') { this._burst(520, 0.5, 0.2, g * 1.5, 'bandpass'); this._burst(2400, 0.7, 0.09, g * 0.5, 'highpass'); }
    else if (surface === 'wood') this._burst(380, 1.4, 0.12, g * 1.6, 'bandpass');
    else if (surface === 'dirt') this._burst(1500, 0.8, 0.1, g, 'lowpass');
    else this._burst(700, 0.7, 0.13, g, 'lowpass');
  }

  pageTone() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [f, d] of [[392, 3.2], [587.3, 2.8], [784, 2.4], [1174.7, 2.0]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g);
      g.connect(this.master);
      g.connect(this.revSend);
      o.start(t);
      o.stop(t + d + 0.1);
    }
  }

  pickup() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.3);
  }

  flareThrow() {
    if (!this.ready) return;
    this._burst(1200, 0.6, 0.18, 0.25, 'bandpass');
  }

  flareBurn(dur) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = this._noiseSrc(true);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.2);
    g.gain.setValueAtTime(0.09, t + dur - 3);
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(this.master);
    s.start(t);
    s.stop(t + dur + 0.1);
    const node = { g, s };
    this.flareNodes.push(node);
    s.onended = () => {
      const i = this.flareNodes.indexOf(node);
      if (i >= 0) this.flareNodes.splice(i, 1);
    };
  }

  // Cuts every burning-flare hiss (used when the player dies and the flares are cleared).
  killFlares() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const n of this.flareNodes) {
      n.g.gain.cancelScheduledValues(t);
      n.g.gain.setTargetAtTime(0, t, 0.05);
      try { n.s.stop(t + 0.4); } catch (e) { /* already stopped */ }
      try { n.s.disconnect(); } catch (e) { /* ignore */ }
    }
    this.flareNodes.length = 0;
  }

  whisper(x, y, z) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dur = 0.8 + Math.random() * 1.4;
    const s = this._noiseSrc(true);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 700 + Math.random() * 500;
    f1.Q.value = 6;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 2000 + Math.random() * 1500;
    f2.Q.value = 5;
    const g = ctx.createGain();
    g.gain.value = 0;
    const n = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const a = t + (i / n) * dur;
      g.gain.linearRampToValueAtTime(0.22 + Math.random() * 0.18, a + 0.05);
      g.gain.linearRampToValueAtTime(0.02, a + dur / n * 0.9);
    }
    g.gain.linearRampToValueAtTime(0, t + dur + 0.2);
    const pan = this._panner(x, y, z);
    s.connect(f1);
    s.connect(f2);
    f1.connect(g);
    f2.connect(g);
    g.connect(pan);
    pan.connect(this.master);
    pan.connect(this.revSend);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.3);
  }

  shimmer(x, y, z) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const pan = this._panner(x, y, z);
    pan.connect(this.master);
    pan.connect(this.revSend);
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(700 + i * 330, t);
      o.frequency.exponentialRampToValueAtTime(1800 + i * 500, t + 0.7);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.04, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g);
      g.connect(pan);
      o.start(t);
      o.stop(t + 1.0);
    }
  }

  shieldBreak() {
    if (!this.ready) return;
    this._burst(3000, 1.0, 0.25, 0.3, 'bandpass');
    this.pickup();
  }

  hurt() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.5);
    this._burst(400, 0.8, 0.3, 0.35, 'lowpass');
  }

  heart() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const dt of [0, 0.22]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 58;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(0.35, t + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.22);
      o.connect(g);
      g.connect(this.master);
      o.start(t + dt);
      o.stop(t + dt + 0.3);
    }
  }

  stinger() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const f of [110, 116.5, 164.8, 233]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = 500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 1.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
      o.connect(flt);
      flt.connect(g);
      g.connect(this.master);
      g.connect(this.revSend);
      o.start(t);
      o.stop(t + 3.6);
    }
  }

  // Low growl from the enemy that is about to strike.
  growl(x, y, z) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.6);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    const pan = this._panner(x, y, z);
    o.connect(f);
    f.connect(g);
    g.connect(pan);
    pan.connect(this.master);
    pan.connect(this.revSend);
    o.start(t);
    o.stop(t + 0.75);
  }

  // Sub-bass thud when something steps out of the dark.
  sting() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(62, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    o.connect(g);
    g.connect(this.master);
    g.connect(this.revSend);
    o.start(t);
    o.stop(t + 1.1);
    this._burst(900, 0.6, 0.5, 0.12, 'lowpass', this.revSend);
  }

  // A ragged breath when the player runs out of stamina.
  breath() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = this._noiseSrc(false);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    s.connect(f);
    f.connect(g);
    g.connect(this.master);
    s.start(t, Math.random() * 1.2);
    s.stop(t + 0.8);
  }

  // Small confirmation tick when an enemy is destroyed.
  kill() {
    if (!this.ready) return;
    this._burst(2400, 1.4, 0.12, 0.2, 'bandpass');
  }
}