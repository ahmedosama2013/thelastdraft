// DOM UI: menus, HUD, subtitles, the typewritten manuscript reader, chapter cards, ending.

const WIND = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export class UI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'), compass: $('compass'), mark: $('cm-mark'), heading: $('cm-heading'),
      objective: $('objective'), cells: $('bat-cells'), battery: $('battery'), spare: $('bat-spare'),
      flares: $('flares'), haven: $('haven'), toast: $('toast'),
      prompt: $('prompt'), promptText: $('prompt-text'), promptBar: $('prompt-bar'), promptFill: $('prompt-fill'),
      sub: $('sub'),
      screens: {
        title: $('screen-title'), controls: $('screen-controls'), credits: $('screen-credits'),
        pause: $('screen-pause'), ending: $('screen-ending'),
      },
      endingTitle: $('ending-title'), endingLines: $('ending-lines'), endingActions: $('ending-actions'),
      card: $('chapter-card'), ccRoman: $('cc-roman'), ccTitle: $('cc-title'), ccSub: $('cc-sub'),
      page: $('page-reader'), pgFolio: $('pg-folio'), pgText: $('pg-text'), pgHint: $('pg-hint'),
      loading: $('loading'), fatalBox: $('fatal'), fatalMsg: $('fatal-msg'),
      fade: $('fade'), begin: $('btn-begin'), anew: $('btn-anew'),
      reticle: $('reticle'), retRing: $('ret-ring'), retFill: $('ret-fill'),
      threats: $('threats'), hurt: $('hurtdir'), stamina: $('stamina'), stamFill: $('stam-fill'),
    };
    this.threatEls = [];
    for (let i = 0; i < 5; i++) {
      const t = document.createElement('i');
      this.el.threats.appendChild(t);
      this.threatEls.push(t);
    }
    this._ret = { show: null, s: -1, lock: null, exposed: null, frac: -1 };
    this._stam = { show: null, winded: null, v: -1 };
    this.handlers = {};
    this.cells = [];
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('i');
      this.el.cells.appendChild(c);
      this.cells.push(c);
    }
    document.querySelectorAll('[data-action]').forEach((b) => {
      b.addEventListener('click', () => {
        const fn = this.handlers[b.dataset.action];
        if (fn) fn();
      });
    });
    this.subQueue = [];
    this.subCur = null;
    this.subT = 0;
    this.subGap = 0;
    this.toastT = 0;
    this.objTimer = 0;
    this.page = { open: false, full: '', typed: 0 };
    this._lastObj = '';
    this._promptShown = false;
    this._cardTimer = 0;
  }

  on(action, fn) { this.handlers[action] = fn; }

  showScreen(name) {
    for (const k in this.el.screens) this.el.screens[k].classList.toggle('show', k === name);
  }
  currentScreen() {
    for (const k in this.el.screens) if (this.el.screens[k].classList.contains('show')) return k;
    return null;
  }

  setBeginLabel(hasSave) {
    this.el.begin.textContent = hasSave ? 'Resume' : 'Begin';
    this.el.anew.classList.toggle('hidden', !hasSave);
  }

  showHud(on) { this.el.hud.classList.toggle('hidden', !on); }
  loading(on) { this.el.loading.classList.toggle('hidden', !on); }
  fatal(msg) {
    this.el.fatalMsg.textContent = msg;
    this.el.fatalBox.classList.remove('hidden');
  }

  setBattery(level, spare, low) {
    const n = level * 6;
    for (let i = 0; i < 6; i++) {
      const on = i < Math.floor(n) || (i === Math.floor(n) && n - Math.floor(n) > 0.3 && level < 1);
      this.cells[i].classList.toggle('on', on);
    }
    this.el.battery.classList.toggle('low', low);
    const s = spare > 0 ? 'x' + spare : '';
    if (this.el.spare.textContent !== s) this.el.spare.textContent = s;
  }

  setFlares(n) {
    if (this._flares === n) return;
    this._flares = n;
    this.el.flares.innerHTML = '';
    for (let i = 0; i < n; i++) this.el.flares.appendChild(document.createElement('i'));
  }

  setHaven(on) { this.el.haven.classList.toggle('on', on); }

  setCompass(headingRad, relRad) {
    const TAU = Math.PI * 2;
    const h = ((headingRad % TAU) + TAU) % TAU;
    const label = WIND[Math.round(h / (TAU / 16)) % 16];
    if (this.el.heading.textContent !== label) this.el.heading.textContent = label;
    const m = this.el.mark;
    if (relRad === null) {
      m.classList.remove('on', 'edge');
      return;
    }
    const k = Math.max(-1, Math.min(1, relRad / (Math.PI / 2)));
    m.style.left = 50 + k * 50 + '%';
    const edge = Math.abs(relRad) > Math.PI / 2;
    m.classList.toggle('on', !edge);
    m.classList.toggle('edge', edge);
  }

  // `live` text (a countdown) is swapped in place instead of fading out and in on every change.
  setObjective(text, live) {
    if (text === this._lastObj) return;
    this._lastObj = text;
    if (live && text && this.el.objective.classList.contains('show')) {
      clearTimeout(this._objT);
      this.el.objective.textContent = text;
      return;
    }
    this.el.objective.classList.remove('show');
    clearTimeout(this._objT);
    this._objT = setTimeout(() => {
      this.el.objective.textContent = text;
      this.el.objective.classList.toggle('show', !!text);
    }, 500);
  }

  toast(text, dur = 2.6) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('show');
    this.toastT = dur;
  }

  setPrompt(text, progress) {
    const show = !!text;
    if (show) this.el.promptText.textContent = text;
    this.el.prompt.classList.toggle('show', show);
    const bar = progress !== null && progress !== undefined && progress > 0;
    this.el.promptBar.classList.toggle('show', show && bar);
    if (bar) this.el.promptFill.style.width = Math.round(progress * 100) + '%';
  }

  say(text, dur = 4.5) {
    this.subQueue.push({ text, dur });
  }
  clearSubs() {
    this.subQueue.length = 0;
    this.subCur = null;
    this.el.sub.classList.remove('show');
  }

  // Crosshair: ring tightens with the focused beam, turns ember on a target and shows its shield.
  setReticle(show, focus, target) {
    const r = this._ret, el = this.el;
    if (r.show !== show) { r.show = show; el.reticle.classList.toggle('show', show); }
    if (!show) return;
    const s = Math.round((1 - 0.45 * focus) * 100) / 100;
    if (r.s !== s) { r.s = s; el.retRing.style.setProperty('--s', s); }
    const lock = !!target;
    if (r.lock !== lock) { r.lock = lock; el.reticle.classList.toggle('lock', lock); }
    const exposed = !!target && target.exposed;
    if (r.exposed !== exposed) { r.exposed = exposed; el.reticle.classList.toggle('exposed', exposed); }
    if (target) {
      const f = Math.round(Math.max(0, Math.min(1, target.frac)) * 50) / 50;
      if (r.frac !== f) { r.frac = f; el.retFill.style.width = f * 100 + '%'; }
    }
  }

  reticleKill() {
    const el = this.el.reticle;
    el.classList.add('kill');
    clearTimeout(this._killT);
    this._killT = setTimeout(() => el.classList.remove('kill'), 260);
  }

  // list: [{ rel (radians, 0 = straight ahead, + = right), near (0..1) }], at most 5 used.
  setThreats(list) {
    for (let i = 0; i < this.threatEls.length; i++) {
      const t = this.threatEls[i], d = list[i];
      if (d) {
        t.style.transform = 'rotate(' + d.rel.toFixed(3) + 'rad) translateY(-' + (118 + 14 * (1 - d.near)).toFixed(0) + 'px)';
        t.style.opacity = (0.3 + 0.7 * d.near).toFixed(2);
      } else if (t.style.opacity !== '0') {
        t.style.opacity = '0';
      }
    }
  }

  hurtFrom(rel) {
    const h = this.el.hurt;
    h.style.transform = 'rotate(' + rel.toFixed(3) + 'rad) translateY(-160px)';
    if (h.animate) h.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 900, easing: 'ease-out' });
  }

  setStamina(v, winded) {
    const s = this._stam, el = this.el;
    const show = v < 0.995 || winded;
    if (s.show !== show) { s.show = show; el.stamina.classList.toggle('show', show); }
    if (s.winded !== winded) { s.winded = winded; el.stamina.classList.toggle('winded', winded); }
    const q = Math.round(v * 100) / 100;
    if (s.v !== q) { s.v = q; el.stamFill.style.transform = 'scaleX(' + q + ')'; }
  }

  setOption(name, text) {
    document.querySelectorAll('[data-opt="' + name + '"]').forEach((e) => {
      e.textContent = (name === 'bright' ? 'Brightness: ' : 'Sensitivity: ') + text;
    });
  }

  hideChapterCard() {
    clearTimeout(this._cardTimer);
    this.el.card.classList.remove('show');
  }

  chapterCard(roman, title, sub, ms = 4200) {
    this.el.ccRoman.textContent = 'Chapter ' + roman;
    this.el.ccTitle.textContent = title;
    this.el.ccSub.textContent = sub;
    this.el.card.classList.add('show');
    clearTimeout(this._cardTimer);
    this._cardTimer = setTimeout(() => this.el.card.classList.remove('show'), ms);
  }

  openPage(folio, text) {
    this.page.open = true;
    this.page.full = text;
    this.page.typed = 0;
    this.el.pgFolio.textContent = typeof folio === 'number' ? 'page ' + folio : folio;
    this.el.pgText.textContent = '';
    this.el.pgText.classList.add('typing');
    this.el.page.classList.remove('hidden');
  }

  // Returns 'completed' when it only finished the typing, 'closed' when the page was put away.
  pageAdvance() {
    if (!this.page.open) return 'none';
    if (this.page.typed < this.page.full.length) {
      this.page.typed = this.page.full.length;
      this.el.pgText.textContent = this.page.full;
      this.el.pgText.classList.remove('typing');
      return 'completed';
    }
    this.closePage();
    return 'closed';
  }

  closePage() {
    this.page.open = false;
    this.el.page.classList.add('hidden');
  }

  fade(on, ms = 600) {
    this.el.fade.style.transitionDuration = ms + 'ms';
    this.el.fade.classList.toggle('on', on);
    return new Promise((res) => setTimeout(res, ms));
  }

  showEnding(title, lines) {
    this.el.endingTitle.textContent = title;
    this.el.endingLines.innerHTML = '';
    lines.forEach((l, i) => {
      const p = document.createElement('p');
      p.textContent = l;
      p.style.animationDelay = 2.2 + i * 3.4 + 's';
      this.el.endingLines.appendChild(p);
    });
    this.el.endingActions.classList.remove('show');
    clearTimeout(this._endT);
    this._endT = setTimeout(() => this.el.endingActions.classList.add('show'), (2.2 + lines.length * 3.4 + 1.5) * 1000);
    this.showScreen('ending');
  }

  update(dt) {
    if (this.page.open && this.page.typed < this.page.full.length) {
      this.page.typed = Math.min(this.page.full.length, this.page.typed + dt * 70);
      this.el.pgText.textContent = this.page.full.slice(0, Math.floor(this.page.typed));
      if (this.page.typed >= this.page.full.length) this.el.pgText.classList.remove('typing');
    }
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.el.toast.classList.remove('show');
    }
    // subtitles
    if (this.subCur) {
      this.subT -= dt;
      if (this.subT <= 0) {
        this.el.sub.classList.remove('show');
        this.subCur = null;
        this.subGap = 0.9;
      }
    } else if (this.subGap > 0) {
      this.subGap -= dt;
    } else if (this.subQueue.length) {
      this.subCur = this.subQueue.shift();
      this.subT = this.subCur.dur;
      this.el.sub.textContent = this.subCur.text;
      this.el.sub.classList.add('show');
    }
  }
}
