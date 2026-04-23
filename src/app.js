// Application entry point. Owns the main loop and glues Simulator + Renderer
// + EventEngine + UI.

class App {
  constructor() {
    this.canvas = document.getElementById('sim-canvas');
    this.renderer = new Renderer(this.canvas);
    this.simulator = new Simulator();
    this.events = new EventEngine(this);
    this.audio = new AudioEngine();
    this.running = false;
    this.speedMultiplier = 1.0;
    this._speedOverride = null; // { factor, life } for slowmo
    this.selectedId = null;
    this._lastWall = 0;
    this._accumulator = 0;
    this._exporting = false;
    this._exportInfo = null; // { status, done, total }

    this.simulator.setScenario(buildHarmonicScenario(7));
    this.events.setRules(this.simulator.scenario.events);
    this.audio.setScenario(this.simulator.scenario);
    this.history = new History(this);
    this.ui = new UI(this);
    this.history.init();
    this.start();

    requestAnimationFrame((t) => this._loop(t));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastWall = performance.now();
  }

  pause() { this.running = false; }

  reset() {
    this.running = false;
    this.simulator.rebuild();
    this.events.setRules(this.simulator.scenario.events);
    this.audio.setScenario(this.simulator.scenario);
    this.audio.resetTimelineState();
    this.renderer.flash = null;
    this.renderer.popup = null;
    this.renderer.particles.length = 0;
    this._speedOverride = null;
    this._accumulator = 0;
  }

  // Temporary speed multiplier, used by the slowmo action.
  triggerSlowmo(factor, seconds) {
    this._speedOverride = { factor, life: seconds };
  }

  _activeBallCount() {
    return this.simulator.state.objects.filter((o) => o.type === 'ball' && o.alive && !o._escaped).length;
  }

  _loop(timeMs) {
    if (!this._lastWall) this._lastWall = timeMs;
    const wallDt = Math.min(0.1, (timeMs - this._lastWall) / 1000);
    this._lastWall = timeMs;

    // Effective speed = user slider * any active slowmo override.
    let effSpeed = this.speedMultiplier;
    if (this._speedOverride) {
      effSpeed *= this._speedOverride.factor;
      this._speedOverride.life -= wallDt;
      if (this._speedOverride.life <= 0) this._speedOverride = null;
    }

    if (this.running && !this._exporting) {
      this._accumulator += wallDt * effSpeed;
      const dt = window.PHYSICS_CONST.FIXED_DT;
      let steps = 0;
      while (this._accumulator >= dt && steps < 8) {
        this.simulator.step(dt);
        const evs = this.simulator.lastEvents();
        this.renderer.handleEvents(evs);
        this.events.update(this.simulator.state, evs);
        // Route events through the audio engine too, so collisions make sound
        // in real-time. The engine silently no-ops if it hasn't been unlocked
        // by a user gesture yet.
        this.audio.handleEvents(evs, this.canvas.width, this.canvas.height);
        const ec = this.simulator.scenario.endCondition || null;
        const activeBalls = this._activeBallCount();
        if (this.simulator.scenario.stopOnFirstEscape && evs.some((e) => e.type === 'escape')) {
          this.pause();
          this._accumulator = 0;
        } else if (ec && ec.type === 'bucketHitTail'
            && evs.some((e) => e.type === 'score' && String(e.bucketId || '') === String(ec.bucketId || ''))) {
          this.pause();
          this._accumulator = 0;
        } else if (ec && ec.type === 'ballCountTail' && activeBalls <= Math.max(0, ec.count | 0)) {
          this.pause();
          this._accumulator = 0;
        } else if (ec && ec.type === 'allBallsGone' && activeBalls === 0) {
          this.pause();
          this._accumulator = 0;
        }
        this._accumulator -= dt;
        steps++;
      }
    }

    if (this._exporting) {
      // While exporting we leave the live canvas alone except for a
      // lightweight progress overlay. The expensive rendering happens on a
      // separate offscreen canvas in ExportManager, so the UI stays
      // responsive and there's no wasted work on the visible canvas.
      this._drawExportOverlay();
    } else {
      this.renderer.stepParticles(wallDt);
      this.renderer.render(this.simulator.state, {
        overlay: this.simulator.scenario.overlay,
        visuals: this.simulator.scenario.visuals,
        softMode: !!this.simulator.scenario.satisfying,
        selectedId: this.selectedId,
      });
    }

    requestAnimationFrame((t) => this._loop(t));
  }

  // Tell App we're about to export: the next _loop() tick will stop driving
  // the simulation / renderer and switch to a minimal progress overlay.
  beginExport() {
    this._exporting = true;
    this._exportInfo = { status: 'Starting…', done: 0, total: 0 };
  }
  updateExport(info) {
    if (!this._exportInfo) this._exportInfo = {};
    Object.assign(this._exportInfo, info);
  }
  endExport() {
    this._exporting = false;
    this._exportInfo = null;
  }

  _drawExportOverlay() {
    const ctx = this.canvas.getContext('2d');
    const W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.fillStyle = '#05060d';
    ctx.fillRect(0, 0, W, H);
    const info = this._exportInfo || {};
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#7dd3fc';
    ctx.shadowBlur = 30;
    ctx.shadowColor = '#38bdf8';
    ctx.font = 'bold 64px system-ui, sans-serif';
    ctx.fillText('Rendering video…', W / 2, H / 2 - 120);
    ctx.shadowBlur = 0;
    ctx.font = '34px system-ui, sans-serif';
    ctx.fillStyle = '#cbd5f5';
    ctx.fillText(info.status || 'Working…', W / 2, H / 2 - 40);
    if (info.total) {
      const pct = Math.min(1, info.done / info.total);
      const barW = 720, barH = 18;
      const x = (W - barW) / 2, y = H / 2 + 20;
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(x, y, barW, barH);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(x, y, barW * pct, barH);
      ctx.font = '28px system-ui, sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`${info.done} / ${info.total} frames  (${(pct * 100).toFixed(0)}%)`,
                   W / 2, y + barH + 40);
    } else if (info.done) {
      ctx.font = '28px system-ui, sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`${info.done} frames rendered`, W / 2, H / 2 + 40);
    }
    ctx.restore();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
