// Keyboard + mouse. Pointer lock when available, mouse-drag look as a fallback.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressedSet = new Set();
    this.buttons = 0;
    this.dx = 0;
    this.dy = 0;
    this.locked = false;
    this.dragMode = false;
    this.onLockLost = null;
    this.onEscape = null;
    this.wantLock = false; // set by the game while playing: a click re-engages pointer lock
    this._lockTimer = 0;
    this._lostAt = -1e9;
    this._attach();
  }

  _attach() {
    const block = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
    window.addEventListener('keydown', (e) => {
      // only swallow Space/Tab/arrows during play, so the menus stay usable from the keyboard
      if (block.has(e.code) && (this.wantLock || this.locked)) e.preventDefault();
      if (!e.repeat) this.pressedSet.add(e.code);
      this.keys.add(e.code);
      // some browsers deliver Esc right after the pointer lock is lost, which would toggle pause twice
      if (e.code === 'Escape' && !e.repeat && this.onEscape && performance.now() - this._lostAt > 350) this.onEscape();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons = 0;
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (this.wantLock && !this.locked) this.requestLock();
      this.buttons |= 1 << e.button;
      this.pressedSet.add('Mouse' + e.button);
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
    });
    window.addEventListener('mousemove', (e) => {
      if (this.locked || (this.dragMode && (this.buttons & 1))) {
        this.dx += e.movementX || 0;
        this.dy += e.movementY || 0;
      }
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.canvas;
      if (this.locked) this.dragMode = false;
      if (was && !this.locked) {
        this._lostAt = performance.now();
        if (this.onLockLost) this.onLockLost();
      }
    });
    document.addEventListener('pointerlockerror', () => {
      this.dragMode = true;
    });
  }

  // Must be called from a user gesture. Falls back to drag-look if the lock does not engage.
  requestLock() {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock ? this.canvas.requestPointerLock() : null;
      if (p && typeof p.catch === 'function') p.catch(() => { this.dragMode = true; });
      if (!this.canvas.requestPointerLock) this.dragMode = true;
    } catch (e) {
      this.dragMode = true;
    }
    clearTimeout(this._lockTimer);
    this._lockTimer = setTimeout(() => {
      if (!this.locked) this.dragMode = true;
    }, 450);
  }

  releaseLock() {
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch (e) { /* ignore */ }
  }

  isDown(code) { return this.keys.has(code); }
  pressed(code) { return this.pressedSet.has(code); }

  // Hold the beam to focus: left mouse (pointer lock) or right mouse (any mode).
  focusHeld() {
    return !!((this.locked && (this.buttons & 1)) || (this.buttons & 2));
  }

  consumeLook() {
    const r = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return r;
  }

  endFrame() {
    this.pressedSet.clear();
  }
}
