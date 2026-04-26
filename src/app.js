// Application entry point. Owns the main loop and glues Simulator + Renderer
// + EventEngine + UI.

class App {
  constructor() {
    this.canvas = document.getElementById('sim-canvas');
    this.liveRunTimeEl = document.getElementById('live-run-time');
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
    this._exportCancelRequested = false;

    this.simulator.setScenario(buildHarmonicScenario(7));
    this.events.setRules(this.simulator.scenario.events);
    this.audio.setScenario(this.simulator.scenario);
    this.history = new History(this);
    this.ui = new UI(this);
    this.history.init();
    this._updateLiveRunFeedback();
    this.start();

    requestAnimationFrame((t) => this._loop(t));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastWall = performance.now();
    this._updateLiveRunFeedback();
  }

  pause() {
    this.running = false;
    this._updateLiveRunFeedback();
  }

  reset() {
    this.running = false;
    this.simulator.rebuild();
    this.events.setRules(this.simulator.scenario.events);
    this.audio.setScenario(this.simulator.scenario);
    this.audio.resetTimelineState();
    if (this.renderer && typeof this.renderer.clearTransientFx === 'function') {
      this.renderer.clearTransientFx();
    } else {
      this.renderer.flash = null;
      this.renderer.popup = null;
      this.renderer.particles.length = 0;
    }
    this._speedOverride = null;
    this._accumulator = 0;
    this._updateLiveRunFeedback();
  }

  // Temporary speed multiplier, used by the slowmo action.
  triggerSlowmo(factor, seconds) {
    this._speedOverride = { factor, life: seconds };
  }

  _activeBallCount() {
    return this.simulator.state.objects.filter((o) =>
      o.type === 'ball' && o.alive && !o._escaped && !o._frozen && !o.fixed
    ).length;
  }

  _logFinishDebug(entry) {
    if (typeof window === 'undefined') return;
    const cfg = window.__finishDebug;
    if (!cfg || !cfg.enabled) return;
    if (!Array.isArray(window.__finishDebugLogs)) window.__finishDebugLogs = [];
    window.__finishDebugLogs.push(entry);
    const maxLogs = Math.max(10, Number(cfg.maxLogs) || 500);
    if (window.__finishDebugLogs.length > maxLogs) {
      window.__finishDebugLogs.splice(0, window.__finishDebugLogs.length - maxLogs);
    }
    if (cfg.toConsole !== false && typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info('[finish-debug]', entry);
    }
  }

  _formatElapsed(seconds) {
    const total = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const minutes = Math.floor(total / 60);
    const secs = total - minutes * 60;
    return `${minutes}:${secs.toFixed(2).padStart(5, '0')}`;
  }

  _updateLiveRunFeedback() {
    if (!this.liveRunTimeEl) return;
    const elapsed = this.simulator && this.simulator.state
      ? (this.simulator.state.elapsedTime != null ? this.simulator.state.elapsedTime : (this.simulator.state.time || 0))
      : 0;
    this.liveRunTimeEl.textContent = this._formatElapsed(elapsed);
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

    if (this.running) {
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
        if (evs.some((e) => e.type === 'escape' || e.type === 'freeze' || e.type === 'spawn' || e.type === 'finish')) {
          const elapsed = this.simulator.state.elapsedTime != null ? this.simulator.state.elapsedTime : this.simulator.state.time;
          this._logFinishDebug({
            phase: 'runtime-events',
            seed: this.simulator.scenario.seed,
            scenarioName: this.simulator.scenario.name || '',
            elapsed: Number(elapsed.toFixed(3)),
            activeBalls: this._activeBallCount(),
            events: evs
              .filter((e) => e.type === 'escape' || e.type === 'freeze' || e.type === 'spawn' || e.type === 'finish')
              .map((e) => ({
                type: e.type,
                x: e.x != null ? Number(e.x.toFixed(2)) : null,
                y: e.y != null ? Number(e.y.toFixed(2)) : null,
                color: e.color || null,
                tail: e.tail != null ? Number(e.tail) : null,
              })),
          });
        }
        if (!this.running) {
          this._accumulator = 0;
          break;
        }
        const ec = this.simulator.scenario.endCondition || null;
        const activeBalls = this._activeBallCount();
        if (evs.some((e) => e.type === 'finish')) {
          this._logFinishDebug({
            phase: 'runtime-stop',
            reason: 'finish',
            seed: this.simulator.scenario.seed,
            scenarioName: this.simulator.scenario.name || '',
            elapsed: Number((this.simulator.state.elapsedTime != null ? this.simulator.state.elapsedTime : this.simulator.state.time).toFixed(3)),
            activeBalls,
          });
          this.pause();
          this._accumulator = 0;
        } else if (this.simulator.scenario.stopOnFirstEscape && evs.some((e) => e.type === 'escape')) {
          this._logFinishDebug({
            phase: 'runtime-stop',
            reason: 'stopOnFirstEscape',
            seed: this.simulator.scenario.seed,
            scenarioName: this.simulator.scenario.name || '',
            elapsed: Number((this.simulator.state.elapsedTime != null ? this.simulator.state.elapsedTime : this.simulator.state.time).toFixed(3)),
            activeBalls,
          });
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

    this.renderer.stepParticles(wallDt);
    this.renderer.render(this.simulator.state, {
      overlay: this.simulator.scenario.overlay,
      visuals: this.simulator.scenario.visuals,
      softMode: !!this.simulator.scenario.satisfying,
      selectedId: this.selectedId,
    });

    this._updateLiveRunFeedback();

    requestAnimationFrame((t) => this._loop(t));
  }

  // Track export status/cancel state without taking over the live canvas.
  beginExport() {
    this._exporting = true;
    this._exportCancelRequested = false;
    this._exportInfo = { status: 'Starting…', done: 0, total: 0 };
  }
  requestExportCancel() {
    if (!this._exporting) return;
    this._exportCancelRequested = true;
    this.updateExport({ status: 'Stopping…' });
  }
  isExportCancelRequested() {
    return !!this._exportCancelRequested;
  }
  updateExport(info) {
    if (!this._exportInfo) this._exportInfo = {};
    Object.assign(this._exportInfo, info);
  }
  endExport() {
    this._exporting = false;
    this._exportCancelRequested = false;
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
