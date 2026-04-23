// UI wiring: left object-builder panel, right property inspector, top controls,
// selection + drag, and scenario save/load. Extended with the Satisfying Loop
// Generator controls (loop duration, satisfying toggle, symmetry spawner,
// snap-to-clean-ratios buttons, orbit inspector).

const OVERLAY_TITLE_ID = '__overlay_title__';

class UI {
  constructor(app) {
    this.app = app;
    this.selectedId = null;
    this._selectedSubchild = null;
    this._drag = null;
    this._symmetryCount = 6;
    this._activePresetId = 'harmonic';
    this._seedResults = [];
    this._seedResultIndex = -1;
    this._seedListQueryKey = '';
    this._seedListNextOffset = 0;
    this._seedListMetricKey = 'ballsUsed';
    this._seedSearchRunning = false;
    this._seedSearchCancelRequested = false;
    this._bind();
    this.refreshAll();
  }

  _bind() {
    // Left panel: object add buttons.
    document.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-add');
        const obj = createObject(type);
        if (type === 'ball' || type === 'static-ball') {
          // Always add a real, collidable physics ball.
          const sc = this.app.simulator.scenario;
          const container = this._findContainingCircle();
          if (type === 'static-ball' && container) {
            obj.x = container.x;
            obj.y = container.y;
            obj.spawnX = container.x;
            obj.spawnY = container.y;
          } else if (container) {
            obj.x = container.x + (Math.random() * 2 - 1) * (container.radius * 0.3);
            obj.y = container.y + (Math.random() * 2 - 1) * (container.radius * 0.3);
          } else {
            obj.x = 540; obj.y = 960;
          }
          obj.motion = 'physics';
          if (type === 'static-ball') {
            obj.vx = 0;
            obj.vy = 0;
            obj.fixed = true;
            obj.trail = false;
          } else {
            obj.vx = (Math.random() * 2 - 1) * 240;
            obj.vy = (Math.random() * 2 - 1) * 240;
            obj.bounce = 1.0;
            obj.trail = true;
            obj.trailLength = Math.round((sc.loopDuration || 10) * 60 * 0.5);
          }
          if (sc.satisfying) sc.physics.gravity = 0;
        } else if (type === 'text') {
          obj.x = 540;
          obj.y = 220;
        } else if (type === 'timer') {
          obj.x = 540;
          obj.y = 260;
        } else if (type === 'score-bin') {
          obj.x = 540;
          obj.y = 1680;
        } else if (type === 'spikes') {
          // Auto-attach to the innermost containing ring so spikes sit flush
          // against the inside of the circle instead of floating off it.
          const ring = this._findContainingCircle();
          if (ring) this._attachSpikesToRing(obj, ring);
        } else if (type === 'spawner') {
          // Drop the spawner at the top-center of any containing circle so
          // emitted balls fall/stream naturally into it.
          const container = this._findContainingCircle();
          if (container) {
            obj.x = container.x;
            obj.y = container.y - container.radius * 0.65;
          } else {
            obj.x = 540; obj.y = 480;
          }
          obj.ballVy = 350;
        }
        this.app.simulator.addObject(obj);
        this.select(obj.id);
        this.refreshAll();
        this._commit();
      });
    });

    // Symmetry spawner: add N phase-offset balls for a radial pattern.
    const symCount = document.getElementById('sym-count');
    symCount.addEventListener('input', () => {
      this._symmetryCount = Math.max(2, parseInt(symCount.value, 10) || 2);
    });
    document.getElementById('btn-add-symmetry').addEventListener('click', () => {
      const sc = this.app.simulator.scenario;
      const loop = sc.loopDuration || 10;
      const template = createObject('ball');
      template.motion = 'orbit';
      template.orbitCx = 540; template.orbitCy = 960;
      template.orbitRadius = 300;
      template.orbitHarmonic = 1;
      template.orbitPhase = 0;
      template.trail = true;
      template.trailLength = Math.round(loop * 60 * 0.5);
      // Use palette so the group looks harmonious.
      const palette = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#22d3ee'];
      const created = this.app.simulator.addSymmetryGroup(template, this._symmetryCount);
      for (let i = 0; i < created.length; i++) {
        created[i].color = palette[i % palette.length];
      }
      this.app.simulator.rebuild();
      if (created[0]) this.select(created[0].id);
      this.refreshAll();
      this._commit();
    });

    // Top bar controls.
    document.getElementById('btn-start').addEventListener('click', () => {
      // Start button doubles as the audio-unlock gesture: browsers require
      // audio contexts to be created/resumed from a user interaction.
      if (this.app.audio) this.app.audio.ensureReady();
      this.app.start();
    });
    document.getElementById('btn-pause').addEventListener('click', () => this.app.pause());
    document.getElementById('btn-reset').addEventListener('click', () => {
      this.app.reset();
      this.refreshAll();
    });
    document.getElementById('btn-randomize').addEventListener('click', () => {
      this._applySeed(SeededRNG.randomSeed());
      this.refreshAll();
      this._commit();
    });

    // Undo / redo.
    document.getElementById('btn-undo').addEventListener('click', () => {
      this.app.history.undo();
    });
    document.getElementById('btn-redo').addEventListener('click', () => {
      this.app.history.redo();
    });

    const speedSlider = document.getElementById('speed-slider');
    const speedLabel = document.getElementById('speed-label');
    const applySpeedValue = (raw) => {
      const min = parseFloat(speedSlider.min || '0.25');
      const max = parseFloat(speedSlider.max || '200');
      const parsed = parseFloat(String(raw).replace(/x$/i, '').trim());
      if (Number.isNaN(parsed)) {
        speedLabel.textContent = `${this.app.speedMultiplier.toFixed(2)}x`;
        return false;
      }
      const clamped = Math.max(min, Math.min(max, parsed));
      this.app.speedMultiplier = clamped;
      speedSlider.value = String(clamped);
      speedLabel.textContent = `${clamped.toFixed(2)}x`;
      return true;
    };
    speedSlider.addEventListener('input', () => applySpeedValue(speedSlider.value));
    speedLabel.title = 'Double-click to edit speed';
    speedLabel.addEventListener('dblclick', () => {
      if (speedLabel.querySelector('input')) return;
      const editor = document.createElement('input');
      editor.type = 'text';
      editor.value = this.app.speedMultiplier.toFixed(2);
      editor.className = 'readout-editor';
      editor.setAttribute('aria-label', 'Playback speed');
      const finish = (commit) => {
        if (!editor.isConnected) return;
        if (commit) applySpeedValue(editor.value);
        else speedLabel.textContent = `${this.app.speedMultiplier.toFixed(2)}x`;
      };
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      });
      editor.addEventListener('blur', () => finish(true));
      speedLabel.textContent = '';
      speedLabel.appendChild(editor);
      editor.focus();
      editor.select();
    });

    // Seed field.
    const seedInput = document.getElementById('seed-input');
    seedInput.addEventListener('change', () => {
      const val = seedInput.value.trim();
      const parsed = /^\d+$/.test(val) ? parseInt(val, 10) : val;
      this._applySeed(parsed);
      this.refreshAll();
      this._commit();
    });
    const findSeedsBtn = document.getElementById('btn-find-seeds');
    if (findSeedsBtn) {
      findSeedsBtn.addEventListener('click', () => this._findSeedListByBallCount());
    }
    const stopSeedsBtn = document.getElementById('btn-stop-seeds');
    if (stopSeedsBtn) {
      stopSeedsBtn.addEventListener('click', () => {
        this._seedSearchCancelRequested = true;
      });
    }
    const seedResults = document.getElementById('seed-results');
    if (seedResults) {
      seedResults.addEventListener('change', () => {
        const idx = seedResults.selectedIndex;
        if (idx >= 0) this._applySeedResultIndex(idx);
      });
    }
    const prevSeedBtn = document.getElementById('btn-seed-prev');
    if (prevSeedBtn) {
      prevSeedBtn.addEventListener('click', () => this._stepSeedResult(-1));
    }
    const nextSeedBtn = document.getElementById('btn-seed-next');
    if (nextSeedBtn) {
      nextSeedBtn.addEventListener('click', () => this._stepSeedResult(1));
    }
    document.getElementById('btn-copy-seed').addEventListener('click', () => {
      navigator.clipboard.writeText(String(this.app.simulator.scenario.seed)).catch(() => {});
    });

    // Sound controls. Audio can only be created in response to a user
    // gesture, so we also attach a one-shot unlock on the first pointer/key
    // event anywhere in the app — that covers users who interact with the
    // canvas before hitting Start.
    const soundToggle = document.getElementById('sound-toggle');
    const soundVol = document.getElementById('sound-volume');
    if (soundToggle) {
      soundToggle.addEventListener('change', () => {
        if (this.app.audio) {
          this.app.audio.ensureReady();
          this.app.audio.setEnabled(soundToggle.checked);
        }
      });
    }
    if (soundVol) {
      soundVol.addEventListener('input', () => {
        if (this.app.audio) {
          this.app.audio.ensureReady();
          this.app.audio.setVolume(parseFloat(soundVol.value));
        }
      });
    }
    const unlockAudio = () => {
      if (this.app.audio) this.app.audio.ensureReady();
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    // Satisfying mode toggle.
    const satisfyingEl = document.getElementById('satisfying-mode');
    satisfyingEl.addEventListener('change', () => {
      this.app.simulator.setSatisfying(satisfyingEl.checked);
      this.refreshAll();
      this._commit();
    });

    // Loop duration.
    const loopEl = document.getElementById('loop-duration');
    loopEl.addEventListener('change', () => {
      const v = parseFloat(loopEl.value);
      if (v > 0) this.app.simulator.setLoopDuration(v);
      this.refreshAll();
      this._commit();
    });

    // Random mode toggle (only meaningful outside satisfying mode).
    const rm = document.getElementById('random-mode');
    rm.addEventListener('change', () => {
      this.app.simulator.scenario.randomMode = rm.checked;
      this.app.simulator.rebuild();
      this.refreshAll();
      this._commit();
    });

    // Snap rotations button.
    document.getElementById('btn-snap-rotations').addEventListener('click', () => {
      this.app.simulator.snapAllRotationsToLoop();
      this.app.simulator.rebuild();
      this.refreshAll();
      this._commit();
    });

    // Scenario save/load/duplicate.
    document.getElementById('btn-save').addEventListener('click', () => {
      const sc = this.app.simulator.getScenario();
      saveScenarioToFile(sc, `scenario_${sc.name || 'scene'}_${sc.seed}.json`.replace(/\s+/g, '_'));
    });
    document.getElementById('btn-load').addEventListener('click', async () => {
      try {
        const sc = await loadScenarioFromFile();
        this.app.simulator.setScenario(sc);
        this._activePresetId = null;
        this._afterScenarioSwitch();
        this.select(null);
        this.refreshAll();
        this._commit();
      } catch (e) { alert('Load failed: ' + e.message); }
    });
    document.getElementById('btn-dupe-scene').addEventListener('click', () => {
      const sc = this.app.simulator.getScenario();
      sc.seed = SeededRNG.randomSeed();
      sc.name = (sc.name || 'Scene') + ' copy';
      this.app.simulator.setScenario(sc);
      this._activePresetId = null;
      this._afterScenarioSwitch();
      this.refreshAll();
      this._commit();
    });

    // Presets.
    document.getElementById('preset-harmonic').addEventListener('click', () => {
      this._activePresetId = 'harmonic';
      this.app.simulator.setScenario(buildHarmonicScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-battle').addEventListener('click', () => {
      this._activePresetId = 'battle';
      this.app.simulator.setScenario(buildBattleOfTheColorsScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-twinkle').addEventListener('click', () => {
      this._activePresetId = 'twinkle';
      this.app.simulator.setScenario(buildTwinkleScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-escape').addEventListener('click', () => {
      this._activePresetId = 'chaos';
      this.app.simulator.setScenario(buildChaosTheoryScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-onehp').addEventListener('click', () => {
      this._activePresetId = 'onehp';
      this.app.simulator.setScenario(buildOneHpScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-timed').addEventListener('click', () => {
      this._activePresetId = 'timed4';
      this.app.simulator.setScenario(buildTimedEscapeScenario(this.app.simulator.scenario.seed, 4));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-timed3').addEventListener('click', () => {
      this._activePresetId = 'timed3';
      this.app.simulator.setScenario(buildTimedEscapeScenario(this.app.simulator.scenario.seed, 3));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-plinko').addEventListener('click', () => {
      this._activePresetId = 'plinko';
      this.app.simulator.setScenario(buildPlinkoScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-wobble').addEventListener('click', () => {
      this._activePresetId = 'wobble';
      this.app.simulator.setScenario(buildWobbleShowcaseScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });

    const enableOverlay = (patch) => {
      Object.assign(this.app.simulator.scenario.overlay, patch);
      this.refreshScenarioPanel();
      this._commit();
    };
    const counterBtn = document.getElementById('btn-add-counter');
    if (counterBtn) {
      counterBtn.addEventListener('click', () => enableOverlay({ showCounter: true }));
    }
    const scoreBtn = document.getElementById('btn-add-score');
    if (scoreBtn) {
      scoreBtn.addEventListener('click', () => enableOverlay({ showScore: true }));
    }
    const countdownBtn = document.getElementById('btn-add-countdown');
    if (countdownBtn) {
      countdownBtn.addEventListener('click', () => enableOverlay({
        bigCountdown: true,
        countdownMax: this.app.simulator.scenario.overlay.countdownMax || 4,
      }));
    }

    // Overlay toggles.
    document.getElementById('ov-title').addEventListener('change', (e) => {
      this.app.simulator.scenario.overlay.title = e.target.value;
      this._commit();
    });
    document.getElementById('ov-title-x').addEventListener('input', (e) => {
      this.app.simulator.scenario.overlay.titleX = parseFloat(e.target.value);
      this._scheduleCommit();
    });
    document.getElementById('ov-title-y').addEventListener('input', (e) => {
      this.app.simulator.scenario.overlay.titleY = parseFloat(e.target.value);
      this._scheduleCommit();
    });
    document.getElementById('ov-title-size').addEventListener('input', (e) => {
      this.app.simulator.scenario.overlay.titleSize = parseFloat(e.target.value);
      this._scheduleCommit();
    });
    document.getElementById('ov-title-color').addEventListener('input', (e) => {
      this.app.simulator.scenario.overlay.titleColor = e.target.value;
      this._scheduleCommit();
    });
    document.getElementById('ov-title-align').addEventListener('change', (e) => {
      this.app.simulator.scenario.overlay.titleAlign = e.target.value;
      this._commit();
    });
    document.getElementById('ov-title-weight').addEventListener('change', (e) => {
      this.app.simulator.scenario.overlay.titleWeight = e.target.value;
      this._commit();
    });
    document.getElementById('ov-title-font').addEventListener('change', (e) => {
      this.app.simulator.scenario.overlay.titleFont = e.target.value;
      this._commit();
    });
    document.getElementById('ov-timer').addEventListener('change', (e) => {
      this.app.simulator.scenario.overlay.showTimer = e.target.checked;
      this._commit();
    });
    document.getElementById('ov-counter').addEventListener('change', (e) => {
      this.app.simulator.scenario.overlay.showCounter = e.target.checked;
      this._commit();
    });
    document.getElementById('ov-score').addEventListener('change', (e) => {
      this.app.simulator.scenario.overlay.showScore = e.target.checked;
      this._commit();
    });
    document.getElementById('ov-countdown').addEventListener('change', (e) => {
      this.app.simulator.scenario.overlay.bigCountdown = e.target.checked;
      this._commit();
    });
    document.getElementById('ov-countdown-max').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isNaN(v) && v > 0) {
        this.app.simulator.scenario.overlay.countdownMax = v;
      }
      this._scheduleCommit();
    });

    // Visuals.
    document.getElementById('vs-glow').addEventListener('input', (e) => {
      this.app.simulator.scenario.visuals.glow = parseFloat(e.target.value);
      this._scheduleCommit();
    });
    document.getElementById('vs-pulse').addEventListener('change', (e) => {
      this.app.simulator.scenario.visuals.pulse = e.target.checked;
      this._commit();
    });

    // Physics.
    document.getElementById('ph-gravity').addEventListener('input', (e) => {
      this.app.simulator.scenario.physics.gravity = parseFloat(e.target.value);
      this.app.simulator.physics.gravity = this.app.simulator.scenario.physics.gravity;
      this._scheduleCommit();
    });
    document.getElementById('ph-friction').addEventListener('input', (e) => {
      this.app.simulator.scenario.physics.friction = parseFloat(e.target.value);
      this.app.simulator.physics.friction = this.app.simulator.scenario.physics.friction;
      this._scheduleCommit();
    });

    // Canvas selection + drag.
    const canvas = document.getElementById('sim-canvas');
    const toLocal = (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width;
      const sy = canvas.height / rect.height;
      return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
    };
    canvas.addEventListener('pointerdown', (e) => {
      const p = toLocal(e);
      const hit = this._pickObject(p.x, p.y);
      if (hit) {
        this.select(hit.id);
        // Orbit balls drag their orbit center, not their current position.
        const anchor = (hit.type === 'ball' && (hit.motion === 'orbit' || hit.motion === 'lissajous'))
          ? { x: hit.orbitCx, y: hit.orbitCy }
          : { x: hit.x, y: hit.y };
        this._drag = { id: hit.id, offsetX: p.x - anchor.x, offsetY: p.y - anchor.y };
        canvas.setPointerCapture(e.pointerId);
      } else {
        this.select(null);
      }
      this.refreshPropertyPanel();
      this.refreshOutline();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const p = toLocal(e);
      const obj = this.app.simulator.scenario.objects.find((o) => o.id === this._drag.id);
      if (!obj) return;
      if (obj.type === 'ball' && (obj.motion === 'orbit' || obj.motion === 'lissajous')) {
        obj.orbitCx = p.x - this._drag.offsetX;
        obj.orbitCy = p.y - this._drag.offsetY;
      } else {
        obj.x = p.x - this._drag.offsetX;
        obj.y = p.y - this._drag.offsetY;
      }
      this._applyEdit(obj);
      this.refreshPropertyPanel();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (this._drag) {
        canvas.releasePointerCapture(e.pointerId);
        this._drag = null;
        // Collapse all drag-tick edits into one history entry.
        this._flushCommit();
      }
    });

    window.addEventListener('keydown', (e) => {
      const inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      // Undo / redo shortcuts always available (even while typing in inputs
      // is arguably fine, but skip to avoid conflict with native text undo).
      if (!inField && (e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) this.app.history.redo();
        else this.app.history.undo();
        return;
      }
      if (!inField && (e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        this.app.history.redo();
        return;
      }
      if (inField) return;
      if (!this.selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.app.simulator.removeObject(this.selectedId);
        this.select(null);
        this.refreshAll();
        this._commit();
      } else if (e.key === 'd' || e.key === 'D') {
        const c = this.app.simulator.duplicateObject(this.selectedId);
        if (c) this.select(c.id);
        this.refreshAll();
        this._commit();
      }
    });

    document.getElementById('btn-export-webm').addEventListener('click', () => this._exportVideo('mp4'));
    document.getElementById('btn-export-frames').addEventListener('click', () => this._exportVideo('frames'));

    document.getElementById('export-duration').addEventListener('input', (e) => {
      // Treat the "Duration" field as a safety cap for the render, not a
      // hard length: presets have their own `endCondition` that decides
      // when to stop (e.g. firstEscape + 3.5s for the 1 HP preset).
      const v = parseFloat(e.target.value);
      if (e.target.value.trim() === '') {
        this.app.simulator.scenario.disableExportHardCap = true;
      } else if (!Number.isNaN(v) && v > 0) {
        this.app.simulator.scenario.disableExportHardCap = false;
        this.app.simulator.scenario.duration = v;
        this.app.simulator.scenario.maxExportSeconds = v;
      }
      this._scheduleCommit();
    });

    this._bindMelodyEditor();

    // Events system.
    document.getElementById('btn-add-event').addEventListener('click', () => {
      const sc = this.app.simulator.scenario;
      if (!Array.isArray(sc.events)) sc.events = [];
      sc.events.push({
        id: 'rule_' + Math.random().toString(36).slice(2, 8),
        trigger: { type: 'firstEscape' },
        action: { type: 'confetti' },
        once: true,
      });
      this.app.events.setRules(sc.events);
      this.refreshEvents();
      this._commit();
    });

    const finishTextBtn = document.getElementById('btn-finish-text');
    if (finishTextBtn) {
      finishTextBtn.addEventListener('click', () => this._addFinishPreset('text'));
    }
    const finishRandomBtn = document.getElementById('btn-finish-random');
    if (finishRandomBtn) {
      finishRandomBtn.addEventListener('click', () => this._addFinishPreset('random'));
    }
    const finishBothBtn = document.getElementById('btn-finish-both');
    if (finishBothBtn) {
      finishBothBtn.addEventListener('click', () => this._addFinishPreset('both'));
    }
  }

  select(id, subchild = null) {
    this.selectedId = id;
    this._selectedSubchild = subchild;
    this.app.selectedId = id;
    this.refreshOutline();
    this.refreshPropertyPanel();
  }

  // Mirror an author-time edit onto the live running-state object so changes
  // are reflected on the canvas IMMEDIATELY, even while the sim is playing.
  // Runtime-only fields (_trail, alive, age) are preserved.
  _syncLive(authoredObj) {
    const running = this.app.simulator.state.objects.find((o) => o.id === authoredObj.id);
    if (!running || running === authoredObj) return;
    for (const k of Object.keys(authoredObj)) {
      // Skip every runtime-only field: anything starting with '_' plus the
      // few name-based ones. This is critical for spawners: we must not
      // clobber _lastSpawn / _spawnCount / _spawnedIds mid-run.
      if (k.startsWith('_')) continue;
      if (k === 'alive' || k === 'age') continue;
      running[k] = authoredObj[k];
    }
  }

  // Apply an edit to both scenario and running state. Rebuild only when the
  // sim is paused so we never reset the simulation clock mid-play.
  _applyEdit(obj) {
    if (this.app.running) {
      this._syncLive(obj);
    } else {
      this.app.simulator.rebuild();
    }
    // Every live edit also schedules a debounced history commit so rapid
    // slider sweeps collapse into a single undo step.
    this._scheduleCommit();
  }

  // --- History shorthands ------------------------------------------------
  _commit()         { if (this.app.history) this.app.history.commit(); }
  _scheduleCommit() { if (this.app.history) this.app.history.scheduleCommit(); }
  _flushCommit()    { if (this.app.history) this.app.history.flush(); }

  // After setScenario() replaces the scene wholesale (preset / load / dup),
  // the EventEngine still holds the OLD rule set + fired-once flags. Re-sync
  // it so rules from the newly loaded scenario actually take effect.
  _afterScenarioSwitch() {
    this._normalizeTemplateSpawnRules();
    const rules = (this.app.simulator.scenario && this.app.simulator.scenario.events) || [];
    if (this.app.events) this.app.events.setRules(rules);
    if (this.app.audio) {
      this.app.audio.setScenario(this.app.simulator.scenario);
      this.app.audio.resetTimelineState();
    }
    this._seedListQueryKey = '';
    this._seedListNextOffset = 0;
    this._seedListMetricKey = 'ballsUsed';
    this._seedResults = [];
    this._seedResultIndex = -1;
  }

  _normalizeTemplateSpawnRules() {
    const sc = this.app.simulator.scenario;
    if (!sc || !Array.isArray(sc.events) || !Array.isArray(sc.objects)) return;
    for (const rule of sc.events) {
      const action = rule && rule.action;
      if (!action || action.type !== 'spawnBall' || !action.templateId) continue;
      const tpl = sc.objects.find((o) => o && o.type === 'ball' && o.id === action.templateId);
      if (!tpl) continue;
      // Migrate older preset/custom scenes that hard-coded the spawn position
      // to exactly the template ball's current position. Once normalized,
      // changing the ball's X/Y in the Properties panel also changes future
      // spawns automatically.
      if (action.x === tpl.x) delete action.x;
      if (action.y === tpl.y) delete action.y;
    }
  }

  _buildScenarioForSeed(seed) {
    const sc = this.app.simulator.getScenario();
    sc.seed = seed;
    this._applySeedToScenario(sc, seed);
    return sc;
  }

  _applySeed(seed) {
    const sim = this.app.simulator;
    sim.scenario.seed = seed;
    this._applySeedToScenario(sim.scenario, seed);
    sim.rebuild();
    this._afterScenarioSwitch();
  }

  _applySeedToScenario(sc, seed) {
    if (!Array.isArray(sc.objects)) return false;

    if (sc.name === 'Pyramid Plinko' || sc.name === 'Plinko Score Run') {
      const spawner = sc.objects.find((o) => o && o.type === 'spawner');
      if (spawner) {
        spawner.x = 540;
        spawner.ballVx = 0;
        return true;
      }
    }

    if (sc.name === 'Liquid Wobble Demo') {
      const ball = sc.objects.find((o) => o && o.type === 'ball' && o.id === 'ball_1');
      if (ball) {
        const seedRng = new SeededRNG(seed).fork(733);
        const angle = -Math.PI / 2 + seedRng.range(-0.55, 0.55);
        const speed = Math.hypot(ball.vx || 0, ball.vy || 0) || seedRng.range(980, 1220);
        ball.vx = Math.cos(angle) * speed;
        ball.vy = Math.sin(angle) * speed;
        return true;
      }
    }

    if (sc.name === 'Battle of the Colors') {
      const balls = sc.objects.filter((o) => o && o.type === 'ball').sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (balls.length) {
        const seedRng = new SeededRNG(seed).fork(523);
        for (let i = 0; i < balls.length; i++) {
          const ball = balls[i];
          const baseAngle = -Math.PI / 2 + (i / balls.length) * Math.PI * 2;
          const angle = baseAngle + seedRng.range(-0.55, 0.55);
          const speed = Math.hypot(ball.vx || 0, ball.vy || 0) || seedRng.range(400, 520);
          ball.vx = Math.cos(angle) * speed;
          ball.vy = Math.sin(angle) * speed;
        }
        return true;
      }
    }

    const tpl = sc.objects.find((o) => o && o.type === 'ball' && o.id === 'ball_1');
    const hasRespawnTemplate = Array.isArray(sc.events) && sc.events.some((r) =>
      r && r.action && r.action.type === 'spawnBall' && r.action.templateId === 'ball_1'
    );
    if (!tpl) return false;

    // Timed one-ball-at-a-time preset: preserve user edits (radius, spawn
    // point, trail, etc.) and only refresh the seed-driven launch DIRECTION.
    if (hasRespawnTemplate && tpl.freezeOnTimeout) {
      const seedRng = new SeededRNG(seed).fork(211);
      const launchAngle = seedRng.angle();
      const speed = Math.hypot(tpl.vx || 0, tpl.vy || 0) || 450;
      tpl.vx = Math.cos(launchAngle) * speed;
      tpl.vy = Math.sin(launchAngle) * speed;
      if (tpl.collisionSpread == null) tpl.collisionSpread = 0.45;
      return true;
    }

    if (sc.melody && sc.melody.enabled && Array.isArray(sc.melody.notes) && sc.melody.notes.length) {
      const seedRng = new SeededRNG(seed).fork(419);
      const launchAngle = -Math.PI / 2 + seedRng.range(0.18, 0.46);
      const speed = Math.hypot(tpl.vx || 0, tpl.vy || 0) || 1180;
      tpl.vx = Math.cos(launchAngle) * speed;
      tpl.vy = Math.sin(launchAngle) * speed;
      return true;
    }

    if (hasRespawnTemplate && tpl.deathBurstOnFreeze) {
      const seedRng = new SeededRNG(seed).fork(307);
      const launchAngle = seedRng.angle();
      const speed = Math.hypot(tpl.vx || 0, tpl.vy || 0) || 420;
      tpl.vx = Math.cos(launchAngle) * speed;
      tpl.vy = Math.sin(launchAngle) * speed;
      return true;
    }

    // 1 HP-style preset/custom scene: vary the opening launch while keeping all
    // other authored edits intact. Only the DIRECTION changes; the current
    // speed magnitude the user set via sliders stays untouched.
    if (!hasRespawnTemplate) return false;

    const seedRng = new SeededRNG(seed).fork(101);
    const launchAngle = seedRng.angle();
    const speed = Math.hypot(tpl.vx || 0, tpl.vy || 0) || 300;
    tpl.vx = Math.cos(launchAngle) * speed;
    tpl.vy = Math.sin(launchAngle) * speed;
    if (tpl.wallCurve == null) tpl.wallCurve = 0.7;
    if (tpl.bounce == null) tpl.bounce = 0.95;
    return true;
  }

  _analyzeSeed(seed) {
    const sc = this._buildScenarioForSeed(seed);
    const sim = new Simulator();
    sim.setScenario(sc);

    let paused = false;
    const fakeRenderer = {
      confettiBurst() {},
      shatterObject() {},
      triggerFlash() {},
      showPopup() {},
      addParticle() {},
    };
    const fakeApp = {
      renderer: fakeRenderer,
      simulator: sim,
      pause: () => { paused = true; },
      triggerSlowmo: () => {},
      audio: null,
    };
    const events = new EventEngine(fakeApp);
    events.setRules(sim.scenario.events || []);

    const dt = window.PHYSICS_CONST.FIXED_DT;
    const ec = sim.scenario.endCondition || null;
    const hardCapSeconds = sim.scenario.disableExportHardCap
      ? 120
      : Math.min(120, Math.max(
          2, Number(sim.scenario.maxExportSeconds) || Number(sim.scenario.duration) || 30
        ));
    const hardCapSteps = Math.ceil(hardCapSeconds / dt);
    const fallbackSec = sim.scenario.satisfying
      ? (sim.scenario.loopDuration || 10)
      : (sim.scenario.duration || 12);
    const stepLimitFor = (seconds) => Math.ceil(Math.max(0.1, seconds) / dt);
    const fixedSteps = stepLimitFor(fallbackSec);
    const tailSteps = stepLimitFor(ec && ec.tail != null ? ec.tail : 1.0);

    let firstEscapeAt = -1;
    let allGoneAt = -1;
    let ballCountAt = -1;
    let seenAlive = false;
    let completed = false;
    let ballCollisionCount = 0;
    let circleBounceCount = 0;
    let melodyHitCount = 0;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    const angleBins = new Set();
    let melodySources = (sim.scenario && sim.scenario.melody)
      ? (Array.isArray(sim.scenario.melody.triggerSources) && sim.scenario.melody.triggerSources.length
          ? sim.scenario.melody.triggerSources
          : [sim.scenario.melody.triggerSource || 'circle'])
      : [];
    if (melodySources.includes('circle') && !melodySources.includes('fixedBall')) {
      melodySources = melodySources.concat('fixedBall');
    }
    const arena = sim.scenario.objects.find((o) => o.type === 'circle')
      || sim.scenario.objects.find((o) => o.x != null && o.y != null)
      || { x: 540, y: 960 };
    const cx = arena.x != null ? arena.x : 540;
    const cy = arena.y != null ? arena.y : 960;

    const ballIds = new Set(
      sim.state.objects.filter((o) => o.type === 'ball' && !o.fixed).map((o) => o.id)
    );

    for (let step = 0; step < hardCapSteps; step++) {
      sim.step(dt);
      const evs = sim.lastEvents();
      events.update(sim.state, evs);
      for (const ev of evs) {
        if (ev.type === 'bounce' && ev.source === 'ballBall') ballCollisionCount++;
        if (ev.type === 'bounce' && ev.source === 'circle') {
          circleBounceCount++;
        }
        if (ev.type === 'bounce' && melodySources.includes(ev.source)) {
          melodyHitCount++;
        }
      }

      for (const o of sim.state.objects) {
        if (o.type === 'ball' && !o.fixed) ballIds.add(o.id);
        if (o.type === 'ball' && o.alive && !o._escaped) {
          if (o.x < minX) minX = o.x;
          if (o.x > maxX) maxX = o.x;
          if (o.y < minY) minY = o.y;
          if (o.y > maxY) maxY = o.y;
          const a = Math.atan2(o.y - cy, o.x - cx);
          const bin = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 16);
          angleBins.add(Math.max(0, Math.min(15, bin)));
        }
      }

      const alive = sim.state.objects.filter((o) => o.type === 'ball' && o.alive && !o._escaped).length;
      if (alive > 0) seenAlive = true;
      if (firstEscapeAt < 0 && evs.some((e) => e.type === 'escape')) firstEscapeAt = step;
      if (seenAlive && alive === 0 && allGoneAt < 0) allGoneAt = step;
      if (ec && ec.type === 'ballCountTail' && alive <= Math.max(0, ec.count | 0) && ballCountAt < 0) {
        ballCountAt = step;
      }

      // Match live gameplay semantics: scenes that stop on first escape should
      // not keep simulating extra tail time for seed analysis, otherwise the
      // finder counts additional spawned/frozen balls the user never actually
      // sees in the live run.
      if (sim.scenario.stopOnFirstEscape && evs.some((e) => e.type === 'escape')) {
        completed = true;
        break;
      }

      if (paused) { completed = true; break; }

      if (!ec || ec.type === 'loopDuration') {
        if (step + 1 >= stepLimitFor(sim.scenario.loopDuration || fallbackSec)) {
          completed = true; break;
        }
      } else if (ec.type === 'fixed') {
        if (step + 1 >= stepLimitFor(ec.seconds || fallbackSec)) {
          completed = true; break;
        }
      } else if (ec.type === 'firstEscapeTail') {
        if (firstEscapeAt >= 0 && (step - firstEscapeAt) >= stepLimitFor(ec.tail != null ? ec.tail : 2.5)) {
          completed = true; break;
        }
      } else if (ec.type === 'allBallsGone') {
        if (allGoneAt >= 0 && (step - allGoneAt) >= tailSteps) {
          completed = true; break;
        }
      } else if (ec.type === 'ballCountTail') {
        if (ballCountAt >= 0 && (step - ballCountAt) >= tailSteps) {
          completed = true; break;
        }
      } else if (step + 1 >= fixedSteps) {
        completed = true; break;
      }
    }
    const timedOut = !completed;
    if (!completed) completed = true;

    const widthSpan = Number.isFinite(minX) && Number.isFinite(maxX) ? (maxX - minX) : 0;
    const heightSpan = Number.isFinite(minY) && Number.isFinite(maxY) ? (maxY - minY) : 0;
    const depthBonus = Number.isFinite(maxY) ? Math.max(0, maxY - cy) : 0;
    const angleCoverage = angleBins.size / 16;
    const spreadScore =
      widthSpan * 0.55 +
      heightSpan * 0.15 +
      depthBonus * 0.45 +
      angleCoverage * 500;
    const melodyTarget = (sim.scenario && sim.scenario.melody
      && Array.isArray(sim.scenario.melody.notes))
      ? sim.scenario.melody.notes.length
      : 0;
    const melodyBounceDelta = melodyTarget > 0 ? melodyHitCount - melodyTarget : 0;
    const goalReached = (sim.scenario.stopOnFirstEscape)
      ? firstEscapeAt >= 0
      : (ec && ec.type === 'firstEscapeTail')
        ? firstEscapeAt >= 0
        : (ec && ec.type === 'allBallsGone')
          ? allGoneAt >= 0
          : completed;
    const endSeconds = sim.state.elapsedTime != null ? sim.state.elapsedTime : sim.state.time;

    return {
      seed,
      ballsUsed: ballIds.size,
      endSeconds,
      ballCollisionCount,
      circleBounceCount,
      melodyHitCount,
      completed,
      timedOut,
      escaped: firstEscapeAt >= 0,
      melodyTarget,
      melodyBounceDelta,
      melodyFinishedBeforeEscape: melodyTarget > 0 && firstEscapeAt >= 0 && melodyHitCount >= melodyTarget,
      goalReached,
      widthSpan,
      heightSpan,
      depthBonus,
      angleCoverage,
      spreadScore,
    };
  }

  _getSeedSearchStart() {
    const el = document.getElementById('seed-find-start');
    const fallback = this.app.simulator.scenario.seed;
    if (!el) return Number.isFinite(Number(fallback)) ? parseInt(fallback, 10) : 0;
    const raw = String(el.value || '').trim();
    if (!raw) return Number.isFinite(Number(fallback)) ? parseInt(fallback, 10) : 0;
    return /^-?\d+$/.test(raw) ? parseInt(raw, 10) : (Number.isFinite(Number(raw)) ? parseInt(raw, 10) : 0);
  }

  _getSeedSearchEnd(startSeed, defaultSpan = 200000) {
    const el = document.getElementById('seed-find-limit');
    const fallback = startSeed + Math.max(0, defaultSpan - 1);
    if (!el) return fallback;
    let endSeed = parseInt(String(el.value || '').trim(), 10);
    if (!Number.isFinite(endSeed)) endSeed = fallback;
    el.value = String(endSeed);
    return endSeed;
  }

  _getSeedMetricConfig() {
    return {
      ballsUsed: { label: 'balls', decimals: 0 },
      endSeconds: { label: 's', decimals: 2 },
      ballCollisionCount: { label: 'ball colls', decimals: 0 },
      circleBounceCount: { label: 'circle hits', decimals: 0 },
      melodyHitCount: { label: 'melody hits', decimals: 0 },
      widthSpan: { label: 'width', decimals: 0 },
      heightSpan: { label: 'height', decimals: 0 },
      spreadScore: { label: 'spread', decimals: 0 },
    };
  }

  _getSeedMetricKey() {
    const el = document.getElementById('seed-find-metric');
    const cfg = this._getSeedMetricConfig();
    const fallback = 'ballsUsed';
    const key = el ? String(el.value || fallback) : fallback;
    return Object.prototype.hasOwnProperty.call(cfg, key) ? key : fallback;
  }

  _getSeedMetricValue(res, metricKey) {
    const v = res && res[metricKey];
    return Number.isFinite(v) ? v : 0;
  }

  _formatSeedMetricValue(res, metricKey) {
    const cfg = this._getSeedMetricConfig()[metricKey] || { label: metricKey, decimals: 0 };
    const v = this._getSeedMetricValue(res, metricKey);
    return `${v.toFixed(cfg.decimals || 0)} ${cfg.label}`;
  }

  async _findSeedByBallCount() {
    return this._findSeedListByBallCount();
  }

  _refreshSeedResultsUI() {
    const select = document.getElementById('seed-results');
    const actions = document.getElementById('seed-result-actions');
    const prevBtn = document.getElementById('btn-seed-prev');
    const nextBtn = document.getElementById('btn-seed-next');
    if (!select) return;

    select.innerHTML = '';
    if (actions) actions.innerHTML = '';
    if (this._seedResults.length === 0) {
      select.size = 1;
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No seed list yet';
      select.appendChild(opt);
      select.disabled = true;
      if (actions) actions.style.display = 'none';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }

    const metricKey = this._seedListMetricKey || 'ballsUsed';
    for (let i = 0; i < this._seedResults.length; i++) {
      const res = this._seedResults[i];
      const opt = document.createElement('option');
      opt.value = String(res.seed);
      const state = res.escaped ? 'escape' : (res.goalReached ? 'done' : 'no finish');
      opt.textContent = `${i + 1}. ${res.seed} (${this._formatSeedMetricValue(res, metricKey)} · ${state})`;
      if (i === this._seedResultIndex) opt.selected = true;
      select.appendChild(opt);

      if (actions) {
        const row = document.createElement('div');
        row.className = 'prop-row';
        row.style.gridTemplateColumns = '1fr auto';
        const label = document.createElement('button');
        label.type = 'button';
        label.textContent = `${i + 1}. ${res.seed}`;
        label.className = (i === this._seedResultIndex) ? 'primary' : '';
        label.addEventListener('click', () => this._applySeedResultIndex(i));
        const play = document.createElement('button');
        play.type = 'button';
        play.textContent = 'Play';
        play.addEventListener('click', () => this._playSeedResultIndex(i));
        row.appendChild(label);
        row.appendChild(play);
        actions.appendChild(row);
      }
    }
    select.size = 1;
    if (this._seedResultIndex < 0) this._seedResultIndex = 0;
    select.selectedIndex = this._seedResultIndex;
    select.disabled = false;
    if (actions) actions.style.display = '';
    if (prevBtn) prevBtn.disabled = this._seedResults.length <= 1;
    if (nextBtn) nextBtn.disabled = this._seedResults.length <= 1;
  }

  _setSeedSearchRunning(running) {
    this._seedSearchRunning = !!running;
    const findBtn = document.getElementById('btn-find-seeds');
    const stopBtn = document.getElementById('btn-stop-seeds');
    if (findBtn) findBtn.disabled = !!running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  _applySeedResultIndex(index) {
    if (index < 0 || index >= this._seedResults.length) return;
    this._seedResultIndex = index;
    const res = this._seedResults[index];
    this._applySeed(res.seed);
    this.refreshAll();
  }

  _playSeedResultIndex(index) {
    this._applySeedResultIndex(index);
    this.app.start();
  }

  _stepSeedResult(delta) {
    if (this._seedResults.length === 0) return;
    const len = this._seedResults.length;
    const next = ((this._seedResultIndex < 0 ? 0 : this._seedResultIndex) + delta + len) % len;
    this._applySeedResultIndex(next);
  }

  async _findSeedListByBallCount() {
    const minEl = document.getElementById('seed-find-min');
    const maxEl = document.getElementById('seed-find-max');
    const btn = document.getElementById('btn-find-seeds');
    if (!minEl || !maxEl || !btn) return;
    if (this._seedSearchRunning) return;

    let min = parseFloat(minEl.value);
    let max = parseFloat(maxEl.value);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (min > max) [min, max] = [max, min];
    minEl.value = String(min);
    maxEl.value = String(max);

    const originalLabel = btn.textContent;
    this._seedSearchCancelRequested = false;
    this._setSeedSearchRunning(true);
    this.app.pause();
    const sc = this.app.simulator.scenario || {};
    const metricKey = this._getSeedMetricKey();
    const targetCenter = (min + max) * 0.5;
    const rawStartSeed = this._getSeedSearchStart();
    const rawEndSeed = this._getSeedSearchEnd(rawStartSeed, 200000);
    const startSeed = Math.min(rawStartSeed, rawEndSeed);
    const endSeed = Math.max(rawStartSeed, rawEndSeed);
    const queryKey = JSON.stringify({
      preset: this._activePresetId || null,
      name: sc.name || '',
      seed: sc.seed || 0,
      metricKey,
      min,
      max,
      startSeed,
      endSeed,
    });
    const previousResults = this._seedResults.slice();
    const previousIndex = this._seedResultIndex;
    if (this._seedListQueryKey !== queryKey) {
      this._seedListQueryKey = queryKey;
      this._seedListNextOffset = 0;
      this._seedListMetricKey = metricKey;
    }

    try {
      const matches = [];
      const targetMatches = 24;
      this._seedListNextOffset = 0;
      for (let seed = startSeed; seed <= endSeed; seed++) {
        if (this._seedSearchCancelRequested) break;

        const res = this._analyzeSeed(seed);
        const metricValue = this._getSeedMetricValue(res, metricKey);
        const isMatch = res.goalReached && metricValue >= min && metricValue <= max;
        if (isMatch) {
          matches.push(res);
          matches.sort((a, b) => {
            const av = this._getSeedMetricValue(a, metricKey);
            const bv = this._getSeedMetricValue(b, metricKey);
            const ad = Math.abs(av - targetCenter);
            const bd = Math.abs(bv - targetCenter);
            if (ad !== bd) return ad - bd;
            if (!!a.escaped !== !!b.escaped) return a.escaped ? -1 : 1;
            if (metricKey === 'spreadScore' || metricKey === 'widthSpan' || metricKey === 'heightSpan') {
              if (bv !== av) return bv - av;
            }
            if (av !== bv) {
              return av - bv;
            }
            if ((b.spreadScore || 0) !== (a.spreadScore || 0)) {
              return (b.spreadScore || 0) - (a.spreadScore || 0);
            }
            return a.seed - b.seed;
          });
          if (matches.length > targetMatches) matches.length = targetMatches;
          this._seedResults = matches.slice();
          this._seedResultIndex = this._seedResults.length > 0 ? 0 : -1;
          this._refreshSeedResultsUI();
        }

        const scannedOffset = seed - startSeed;
        if (scannedOffset % 25 === 0) {
          if (matches.length > 0) {
            this._seedResults = matches.slice();
            this._seedResultIndex = this._seedResults.length > 0 ? 0 : -1;
            this._refreshSeedResultsUI();
          }
          btn.textContent = `🔎 ${matches.length} / ${seed}`;
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      this._seedListNextOffset = 0;
      if (matches.length > 0 || !this._seedSearchCancelRequested) {
        this._seedResults = matches;
        this._seedResultIndex = matches.length > 0 ? 0 : -1;
      } else {
        this._seedResults = previousResults;
        this._seedResultIndex = previousIndex;
      }
      // IMPORTANT: generating the list should NOT change the current seed or
      // scene unexpectedly; we also auto-apply the best hit so the single
      // combined Find button acts like both old Seed and List.
      this._refreshSeedResultsUI();
      if (matches.length > 0) this._applySeedResultIndex(0);

      btn.textContent = this._seedSearchCancelRequested
        ? (matches.length > 0 ? `Stopped (${matches.length})` : 'Stopped')
        : (matches.length > 0 ? `Got ${matches.length}` : 'No match');
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      this._seedSearchCancelRequested = false;
      this._setSeedSearchRunning(false);
      btn.textContent = originalLabel;
      this._refreshSeedResultsUI();
    }
  }

  _newRuleId(prefix = 'rule') {
    return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  }

  _makeRandomFinishAction() {
    const pool = [
      { type: 'confetti' },
      { type: 'shatter' },
      { type: 'flash', color: '#fef3c7' },
      { type: 'spawnBurst', count: 16 },
      { type: 'slowmo', factor: 0.45, seconds: 1.1 },
    ];
    return { ...pool[Math.floor(Math.random() * pool.length)] };
  }

  _addFinishPreset(mode = 'both') {
    const sc = this.app.simulator.scenario;
    if (!Array.isArray(sc.events)) sc.events = [];

    const trigger = { type: 'firstEscape' };
    if (mode === 'text' || mode === 'both') {
      sc.events.push({
        id: this._newRuleId('finish_text'),
        trigger: { ...trigger },
        action: { type: 'text', text: 'FINISH!', seconds: 2.5 },
        once: true,
      });
    }
    if (mode === 'random' || mode === 'both') {
      sc.events.push({
        id: this._newRuleId('finish_fx'),
        trigger: { ...trigger },
        action: this._makeRandomFinishAction(),
        once: true,
      });
    }

    this.app.events.setRules(sc.events);
    this.refreshEvents();
    this._commit();
  }

  refreshAll() {
    this.refreshTopBar();
    this.refreshOutline();
    this.refreshPropertyPanel();
    this.refreshScenarioPanel();
    this.refreshEvents();
    this.refreshMelodyPanel();
    this._updateSatisfyingClass();
  }

  // --- Melody editor ------------------------------------------------------

  _melodyTriggerValues() {
    return ['circle', 'arc', 'fixedBall', 'ballBall', 'spikes'];
  }

  _getMelody(create = false) {
    const sc = this.app.simulator.scenario;
    if (!sc.melody && create) {
      sc.melody = {
        enabled: false,
        triggerSources: ['circle', 'fixedBall'],
        notes: [],
        loop: true,
        wave: 'triangle',
        gain: 0.34,
        decay: 0.2,
      };
    }
    return sc.melody || null;
  }

  _bindMelodyEditor() {
    const enabled = document.getElementById('ml-enabled');
    enabled.addEventListener('change', () => {
      const m = this._getMelody(true);
      m.enabled = enabled.checked;
      this._applyMelody();
      this.refreshMelodyPanel();
      this._commit();
    });

    const loopEl = document.getElementById('ml-loop');
    loopEl.addEventListener('change', () => {
      const m = this._getMelody(true);
      m.loop = loopEl.checked;
      this._applyMelody();
      this._commit();
    });

    const wave = document.getElementById('ml-wave');
    wave.addEventListener('change', () => {
      const m = this._getMelody(true);
      m.wave = wave.value;
      this._applyMelody();
      this._commit();
    });

    const gain = document.getElementById('ml-gain');
    const gainLabel = document.getElementById('ml-gain-label');
    gain.addEventListener('input', () => {
      const m = this._getMelody(true);
      m.gain = parseFloat(gain.value);
      gainLabel.textContent = m.gain.toFixed(2);
      this._applyMelody();
      this._scheduleCommit();
    });

    const decay = document.getElementById('ml-decay');
    const decayLabel = document.getElementById('ml-decay-label');
    decay.addEventListener('input', () => {
      const m = this._getMelody(true);
      m.decay = parseFloat(decay.value);
      decayLabel.textContent = `${m.decay.toFixed(2)}s`;
      this._applyMelody();
      this._scheduleCommit();
    });

    document.querySelectorAll('#ml-triggers input[data-trig]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const m = this._getMelody(true);
        const valid = this._melodyTriggerValues();
        const active = new Set((m.triggerSources || []).filter((t) => valid.includes(t)));
        const val = cb.getAttribute('data-trig');
        if (cb.checked) active.add(val); else active.delete(val);
        m.triggerSources = Array.from(active);
        this._applyMelody();
        this._commit();
      });
    });

    const preset = document.getElementById('ml-preset');
    preset.addEventListener('change', () => {
      const key = preset.value;
      preset.value = '';
      if (!key) return;
      const notes = this._melodyPresets()[key];
      if (!notes) return;
      const m = this._getMelody(true);
      m.notes = notes.slice();
      m.enabled = true;
      this._applyMelody();
      this.refreshMelodyPanel();
      this._commit();
    });

    document.getElementById('btn-ml-add').addEventListener('click', () => {
      const m = this._getMelody(true);
      const last = m.notes.length ? m.notes[m.notes.length - 1] : 60;
      m.notes.push(last);
      this._applyMelody();
      this.refreshMelodyPanel();
      this._commit();
    });

    document.getElementById('btn-ml-clear').addEventListener('click', () => {
      const m = this._getMelody();
      if (!m || !m.notes || m.notes.length === 0) return;
      m.notes = [];
      this._applyMelody();
      this.refreshMelodyPanel();
      this._commit();
    });

    document.getElementById('btn-ml-preview').addEventListener('click', () => {
      const m = this._getMelody();
      if (!m || !m.notes || m.notes.length === 0) return;
      if (!this.app.audio) return;
      this.app.audio.ensureReady();
      this.app.audio.setEnabled(true);
      const chips = document.querySelectorAll('#melody-notes .note-chip');
      this.app.audio.previewMelody(m, {
        onNote: (i) => {
          chips.forEach((el, j) => el.classList.toggle('playing', j === i));
        },
        onDone: () => {
          chips.forEach((el) => el.classList.remove('playing'));
        },
      });
    });

    document.getElementById('btn-ml-stop').addEventListener('click', () => {
      if (this.app.audio) this.app.audio.stopPreview();
      document.querySelectorAll('#melody-notes .note-chip').forEach((el) => {
        el.classList.remove('playing');
      });
    });
  }

  // Push the current scenario.melody into the AudioEngine so live bounces
  // immediately reflect edits (even while the sim is playing).
  _applyMelody() {
    if (this.app.audio) {
      this.app.audio.setScenario(this.app.simulator.scenario);
    }
  }

  refreshMelodyPanel() {
    const sc = this.app.simulator.scenario;
    const m = sc.melody || null;

    const enabled = document.getElementById('ml-enabled');
    const loopEl = document.getElementById('ml-loop');
    const wave = document.getElementById('ml-wave');
    const gain = document.getElementById('ml-gain');
    const gainLabel = document.getElementById('ml-gain-label');
    const decay = document.getElementById('ml-decay');
    const decayLabel = document.getElementById('ml-decay-label');
    if (!enabled || !wave || !gain || !decay) return;

    const cfg = m || {
      enabled: false, loop: true, wave: 'triangle',
      gain: 0.34, decay: 0.2, triggerSources: ['circle', 'fixedBall'], notes: [],
    };
    enabled.checked = !!cfg.enabled;
    loopEl.checked = cfg.loop !== false;
    wave.value = cfg.wave || 'triangle';
    gain.value = cfg.gain != null ? cfg.gain : 0.34;
    gainLabel.textContent = parseFloat(gain.value).toFixed(2);
    decay.value = cfg.decay != null ? cfg.decay : 0.2;
    decayLabel.textContent = `${parseFloat(decay.value).toFixed(2)}s`;

    // Trigger checkboxes. Back-compat: single `triggerSource` string.
    const active = new Set(
      Array.isArray(cfg.triggerSources) && cfg.triggerSources.length
        ? cfg.triggerSources
        : (cfg.triggerSource ? [cfg.triggerSource] : [])
    );
    document.querySelectorAll('#ml-triggers input[data-trig]').forEach((cb) => {
      cb.checked = active.has(cb.getAttribute('data-trig'));
    });

    this._renderMelodyNotes(cfg.notes || []);
  }

  _renderMelodyNotes(notes) {
    const host = document.getElementById('melody-notes');
    if (!host) return;
    host.innerHTML = '';
    for (let i = 0; i < notes.length; i++) {
      host.appendChild(this._makeNoteChip(notes, i));
    }
  }

  _makeNoteChip(notes, index) {
    const chip = document.createElement('div');
    chip.className = 'note-chip';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(index + 1);
    chip.appendChild(idx);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = this._midiToName(notes[index]);
    input.title = `MIDI ${notes[index]}`;
    const commitValue = () => {
      const midi = this._parseNoteInput(input.value);
      if (midi != null) {
        const m = this._getMelody(true);
        m.notes[index] = midi;
        input.value = this._midiToName(midi);
        input.title = `MIDI ${midi}`;
        this._applyMelody();
        this._commit();
      } else {
        // Revert on invalid entry.
        input.value = this._midiToName(notes[index]);
      }
    };
    input.addEventListener('change', commitValue);
    input.addEventListener('blur', commitValue);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); this._nudgeNote(index,  1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this._nudgeNote(index, -1); }
    });
    chip.appendChild(input);

    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '▲';
    up.title = 'Transpose up 1 semitone (Shift: octave)';
    up.addEventListener('click', (e) => this._nudgeNote(index, e.shiftKey ? 12 : 1));
    chip.appendChild(up);

    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '▼';
    down.title = 'Transpose down 1 semitone (Shift: octave)';
    down.addEventListener('click', (e) => this._nudgeNote(index, e.shiftKey ? -12 : -1));
    chip.appendChild(down);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = 'Remove note';
    rm.addEventListener('click', () => {
      const m = this._getMelody();
      if (!m) return;
      m.notes.splice(index, 1);
      this._applyMelody();
      this.refreshMelodyPanel();
      this._commit();
    });
    chip.appendChild(rm);

    return chip;
  }

  _nudgeNote(index, delta) {
    const m = this._getMelody();
    if (!m || m.notes[index] == null) return;
    const next = Math.max(0, Math.min(127, (m.notes[index] | 0) + delta));
    m.notes[index] = next;
    this._applyMelody();
    this.refreshMelodyPanel();
    this._commit();
  }

  _midiToName(midi) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const n = Math.max(0, Math.min(127, midi | 0));
    const octave = Math.floor(n / 12) - 1;
    return `${names[n % 12]}${octave}`;
  }

  // Accepts "C4", "F#3", "Bb5", "gb2", or a raw integer 0..127.
  _parseNoteInput(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (/^-?\d+$/.test(s)) {
      const v = parseInt(s, 10);
      return v >= 0 && v <= 127 ? v : null;
    }
    const match = /^([A-Ga-g])([#bB♭♯]?)(-?\d+)$/.exec(s);
    if (!match) return null;
    const letter = match[1].toUpperCase();
    const accidental = match[2];
    const octave = parseInt(match[3], 10);
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
    let semi = base;
    if (accidental === '#' || accidental === '♯') semi += 1;
    else if (accidental === 'b' || accidental === 'B' || accidental === '♭') semi -= 1;
    const midi = (octave + 1) * 12 + semi;
    return midi >= 0 && midi <= 127 ? midi : null;
  }

  _melodyPresets() {
    return {
      twinkle: [
        60, 60, 67, 67, 69, 69, 67,
        65, 65, 64, 64, 62, 62, 60,
        67, 67, 65, 65, 64, 64, 62,
        67, 67, 65, 65, 64, 64, 62,
        60, 60, 67, 67, 69, 69, 67,
        65, 65, 64, 64, 62, 62, 60,
      ],
      cmajor: [60, 62, 64, 65, 67, 69, 71, 72],
      pentatonic: [60, 62, 64, 67, 69, 72, 74, 76, 79, 81],
      odetojoy: [
        64, 64, 65, 67, 67, 65, 64, 62,
        60, 60, 62, 64, 64, 62, 62,
        64, 64, 65, 67, 67, 65, 64, 62,
        60, 60, 62, 64, 62, 60, 60,
      ],
      mary: [
        64, 62, 60, 62, 64, 64, 64,
        62, 62, 62, 64, 67, 67,
        64, 62, 60, 62, 64, 64, 64, 64,
        62, 62, 64, 62, 60,
      ],
      happybday: [
        67, 67, 69, 67, 72, 71,
        67, 67, 69, 67, 74, 72,
        67, 67, 79, 76, 72, 71, 69,
        77, 77, 76, 72, 74, 72,
      ],
    };
  }

  refreshEvents() {
    const list = document.getElementById('events-list');
    list.innerHTML = '';
    const rules = this.app.simulator.scenario.events || [];
    const systemRules = this._deriveSystemEventCards();
    for (const rule of systemRules) {
      list.appendChild(this._makeSystemEventCard(rule));
    }
    const systemAdd = this._makeSystemRuleAddRow();
    if (systemAdd) list.appendChild(systemAdd);
    if (rules.length === 0 && systemRules.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint small';
      empty.textContent = 'No rules. Add one to react to escapes, destructions, time, etc.';
      list.appendChild(empty);
    }
    for (const rule of rules) {
      list.appendChild(this._makeEventRuleCard(rule));
    }
  }

  _deriveSystemEventCards() {
    const sc = this.app.simulator.scenario || {};
    const cards = [];
    if (sc.endCondition) cards.push({ kind: 'endCondition', ec: sc.endCondition });
    if (!sc.disableExportHardCap) {
      cards.push({ kind: 'hardCap', seconds: Number(sc.maxExportSeconds) || Number(sc.duration) || 20 });
    }
    if (sc.stopOnFirstEscape) cards.push({ kind: 'liveStop', enabled: true });
    return cards;
  }

  _makeSystemEventCard(rule) {
    const card = document.createElement('div');
    card.className = 'event-card system-event-card';

    const badgeRow = document.createElement('div');
    badgeRow.className = 'event-system-header';
    const badge = document.createElement('span');
    badge.className = 'event-system-badge';
    badge.textContent = 'SYSTEM';
    const note = document.createElement('span');
    note.className = 'tiny';
    note.textContent = 'editable preset rule';
    badgeRow.appendChild(badge);
    badgeRow.appendChild(note);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mini';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      const sc = this.app.simulator.scenario;
      if (rule.kind === 'endCondition') sc.endCondition = null;
      else if (rule.kind === 'hardCap') {
        sc.disableExportHardCap = true;
        sc.maxExportSeconds = null;
      } else if (rule.kind === 'liveStop') sc.stopOnFirstEscape = false;
      this._refreshSystemRulesAfterEdit();
    });
    badgeRow.appendChild(remove);
    card.appendChild(badgeRow);
    if (rule.kind === 'endCondition') this._fillSystemEndConditionCard(card, rule.ec);
    else if (rule.kind === 'hardCap') this._fillSystemHardCapCard(card, rule.seconds);
    else if (rule.kind === 'liveStop') this._fillSystemLiveStopCard(card, rule.enabled);
    return card;
  }

  _makeSystemRuleAddRow() {
    const sc = this.app.simulator.scenario || {};
    const row = document.createElement('div');
    row.className = 'system-rule-actions';
    let count = 0;
    const addButton = (label, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mini';
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      row.appendChild(btn);
      count++;
    };
    if (!sc.endCondition) {
      addButton('+ End rule', () => {
        sc.endCondition = { type: 'loopDuration' };
        this._refreshSystemRulesAfterEdit();
      });
    }
    if (sc.disableExportHardCap) {
      addButton('+ Hard cap', () => {
        sc.disableExportHardCap = false;
        sc.maxExportSeconds = Number(sc.duration) || Number(sc.loopDuration) || 20;
        this._refreshSystemRulesAfterEdit();
      });
    }
    if (!sc.stopOnFirstEscape) {
      addButton('+ Live stop', () => {
        sc.stopOnFirstEscape = true;
        this._refreshSystemRulesAfterEdit();
      });
    }
    return count > 0 ? row : null;
  }

  _refreshSystemRulesAfterEdit() {
    this.refreshEvents();
    this.refreshScenarioPanel();
    this._commit();
  }

  _makeSystemStaticRow(labelText, valueText, muted = false) {
    const row = document.createElement('div');
    row.className = 'event-row';
    row.appendChild(this._tinyLabel(labelText));
    const text = document.createElement('div');
    text.className = `event-static${muted ? ' muted' : ''}`;
    text.textContent = valueText;
    row.appendChild(text);
    return row;
  }

  _makeSystemTextInput(value, onCommit, { placeholder = '', type = 'text', step = null, min = null, max = null } = {}) {
    const input = document.createElement('input');
    input.type = type;
    input.value = value != null ? String(value) : '';
    if (placeholder) input.placeholder = placeholder;
    if (step != null) input.step = String(step);
    if (min != null) input.min = String(min);
    if (max != null) input.max = String(max);
    const commit = () => onCommit(input.value);
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    return input;
  }

  _makeSystemSelect(options, currentValue, onChange) {
    const sel = document.createElement('select');
    for (const optDef of options) {
      const opt = document.createElement('option');
      opt.value = optDef.value;
      opt.textContent = optDef.label;
      if (String(opt.value) === String(currentValue)) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  _makeSystemToggle(text, checked, onChange) {
    const label = document.createElement('label');
    label.className = 'event-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!checked;
    box.addEventListener('change', () => onChange(box.checked));
    label.appendChild(box);
    label.appendChild(document.createTextNode(text));
    return label;
  }

  _fillSystemEndConditionCard(card, ec) {
    const sc = this.app.simulator.scenario;
    const endCondition = sc.endCondition || (sc.endCondition = { type: 'loopDuration' });
    const whenRow = document.createElement('div');
    whenRow.className = 'event-row';
    whenRow.appendChild(this._tinyLabel('When'));
    whenRow.appendChild(this._makeSystemSelect([
      { value: 'loopDuration', label: 'Loop duration completes' },
      { value: 'fixed', label: 'Time reaches N seconds' },
      { value: 'firstEscapeTail', label: 'First ball escapes' },
      { value: 'allBallsGone', label: 'All balls are gone' },
      { value: 'ballCountTail', label: 'Ball count drops to N' },
      { value: 'bucketHitTail', label: 'Specific bucket is hit' },
    ], endCondition.type || 'loopDuration', (value) => {
      const next = { type: value };
      if (value === 'fixed') next.seconds = Number(sc.duration) || Number(sc.loopDuration) || 20;
      if (value === 'firstEscapeTail') next.tail = 2.5;
      if (value === 'allBallsGone') next.tail = 1.0;
      if (value === 'ballCountTail') { next.count = 1; next.tail = 1.0; }
      if (value === 'bucketHitTail') { next.bucketId = 'bin_100'; next.tail = 0; }
      sc.endCondition = next;
      this._refreshSystemRulesAfterEdit();
    }));
    card.appendChild(whenRow);

    if (endCondition.type === 'fixed') {
      const row = document.createElement('div');
      row.className = 'event-row';
      row.appendChild(this._tinyLabel('Seconds'));
      row.appendChild(this._makeSystemTextInput(endCondition.seconds != null ? endCondition.seconds : (sc.duration || 20), (value) => {
        const v = Math.max(0.1, parseFloat(value) || 0);
        sc.endCondition.seconds = v;
        this._refreshSystemRulesAfterEdit();
      }, { type: 'number', step: 0.1, min: 0.1, max: 300 }));
      card.appendChild(row);
    } else if (endCondition.type === 'firstEscapeTail' || endCondition.type === 'allBallsGone') {
      const row = document.createElement('div');
      row.className = 'event-row';
      row.appendChild(this._tinyLabel('Tail'));
      row.appendChild(this._makeSystemTextInput(endCondition.tail != null ? endCondition.tail : 1.0, (value) => {
        const v = Math.max(0, parseFloat(value) || 0);
        sc.endCondition.tail = v;
        this._refreshSystemRulesAfterEdit();
      }, { type: 'number', step: 0.1, min: 0, max: 120 }));
      card.appendChild(row);
    } else if (endCondition.type === 'ballCountTail') {
      const countRow = document.createElement('div');
      countRow.className = 'event-row';
      countRow.appendChild(this._tinyLabel('Count'));
      countRow.appendChild(this._makeSystemTextInput(endCondition.count != null ? endCondition.count : 1, (value) => {
        sc.endCondition.count = Math.max(0, parseInt(value, 10) || 0);
        this._refreshSystemRulesAfterEdit();
      }, { type: 'number', step: 1, min: 0, max: 999 }));
      card.appendChild(countRow);

      const tailRow = document.createElement('div');
      tailRow.className = 'event-row';
      tailRow.appendChild(this._tinyLabel('Tail'));
      tailRow.appendChild(this._makeSystemTextInput(endCondition.tail != null ? endCondition.tail : 1.0, (value) => {
        sc.endCondition.tail = Math.max(0, parseFloat(value) || 0);
        this._refreshSystemRulesAfterEdit();
      }, { type: 'number', step: 0.1, min: 0, max: 120 }));
      card.appendChild(tailRow);
    } else if (endCondition.type === 'bucketHitTail') {
      const bucketRow = document.createElement('div');
      bucketRow.className = 'event-row';
      bucketRow.appendChild(this._tinyLabel('Bucket'));
      bucketRow.appendChild(this._makeSystemTextInput(endCondition.bucketId || '', (value) => {
        sc.endCondition.bucketId = value.trim();
        this._refreshSystemRulesAfterEdit();
      }, { placeholder: 'bin_100' }));
      card.appendChild(bucketRow);

      const tailRow = document.createElement('div');
      tailRow.className = 'event-row';
      tailRow.appendChild(this._tinyLabel('Tail'));
      tailRow.appendChild(this._makeSystemTextInput(endCondition.tail != null ? endCondition.tail : 0, (value) => {
        sc.endCondition.tail = Math.max(0, parseFloat(value) || 0);
        this._refreshSystemRulesAfterEdit();
      }, { type: 'number', step: 0.1, min: 0, max: 120 }));
      card.appendChild(tailRow);
    }

    card.appendChild(this._makeSystemStaticRow('Do', 'Stop export'));
    card.appendChild(this._makeSystemStaticRow('Info', 'Preset end condition'));
  }

  _fillSystemHardCapCard(card, seconds) {
    const sc = this.app.simulator.scenario;
    const whenRow = document.createElement('div');
    whenRow.className = 'event-row';
    whenRow.appendChild(this._tinyLabel('When'));
    whenRow.appendChild(this._makeSystemTextInput(seconds, (value) => {
      const v = Math.max(0.5, parseFloat(value) || 0.5);
      sc.disableExportHardCap = false;
      sc.maxExportSeconds = v;
      sc.duration = v;
      this._refreshSystemRulesAfterEdit();
    }, { type: 'number', step: 0.5, min: 0.5, max: 300 }));
    card.appendChild(whenRow);
    card.appendChild(this._makeSystemStaticRow('Do', 'Hard stop export'));
    card.appendChild(this._makeSystemStaticRow('Info', 'Safety cap'));
  }

  _fillSystemLiveStopCard(card, enabled) {
    const sc = this.app.simulator.scenario;
    const whenRow = document.createElement('div');
    whenRow.className = 'event-row';
    whenRow.appendChild(this._tinyLabel('When'));
    whenRow.appendChild(this._makeSystemToggle('First ball escapes', enabled, (checked) => {
      sc.stopOnFirstEscape = checked;
      this._refreshSystemRulesAfterEdit();
    }));
    card.appendChild(whenRow);
    card.appendChild(this._makeSystemStaticRow('Do', 'Pause live preview'));
    card.appendChild(this._makeSystemStaticRow('Info', 'Live runtime rule'));
  }

  _makeEventRuleCard(rule) {
    const card = document.createElement('div');
    card.className = 'event-card';

    const whenRow = document.createElement('div');
    whenRow.className = 'event-row';
    whenRow.appendChild(this._tinyLabel('When'));
    const trigSel = document.createElement('select');
    for (const t of window.TRIGGER_TYPES) {
      const opt = document.createElement('option');
      opt.value = t.value; opt.textContent = t.label;
      if (rule.trigger.type === t.value) opt.selected = true;
      trigSel.appendChild(opt);
    }
    trigSel.addEventListener('change', () => {
      rule.trigger = { type: trigSel.value };
      this._syncRulesAndRefresh();
    });
    whenRow.appendChild(trigSel);
    card.appendChild(whenRow);

    // Trigger params (e.g., seconds for "time", count for "ballCount").
    const trigDef = window.TRIGGER_TYPES.find((t) => t.value === rule.trigger.type);
    if (trigDef && trigDef.params) {
      for (const p of trigDef.params) {
        const input = this._paramInput(rule.trigger, p);
        card.appendChild(input);
      }
    }

    const doRow = document.createElement('div');
    doRow.className = 'event-row';
    doRow.appendChild(this._tinyLabel('Do'));
    const actSel = document.createElement('select');
    for (const a of window.ACTION_TYPES) {
      const opt = document.createElement('option');
      opt.value = a.value; opt.textContent = a.label;
      if ((rule.action || {}).type === a.value) opt.selected = true;
      actSel.appendChild(opt);
    }
    actSel.addEventListener('change', () => {
      rule.action = { type: actSel.value };
      this._syncRulesAndRefresh();
    });
    doRow.appendChild(actSel);
    card.appendChild(doRow);

    // Action params (e.g., text, color, count, seconds, factor).
    const actDef = window.ACTION_TYPES.find((a) => a.value === (rule.action || {}).type);
    if (actDef && actDef.params) {
      for (const p of actDef.params) {
        const input = this._paramInput(rule.action, p);
        card.appendChild(input);
      }
    }

    const footer = document.createElement('div');
    footer.className = 'event-row event-footer';
    const onceLabel = document.createElement('label');
    onceLabel.className = 'tiny';
    const onceBox = document.createElement('input');
    onceBox.type = 'checkbox';
    onceBox.checked = rule.once !== false;
    onceBox.addEventListener('change', () => {
      rule.once = onceBox.checked;
      this._syncRulesAndRefresh();
    });
    onceLabel.appendChild(onceBox);
    onceLabel.appendChild(document.createTextNode(' fire once'));
    footer.appendChild(onceLabel);

    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = 'Remove';
    del.addEventListener('click', () => {
      const sc = this.app.simulator.scenario;
      sc.events = sc.events.filter((r) => r.id !== rule.id);
      this._syncRulesAndRefresh();
    });
    footer.appendChild(del);
    card.appendChild(footer);
    return card;
  }

  _tinyLabel(text) {
    const s = document.createElement('span');
    s.className = 'tiny';
    s.textContent = text;
    return s;
  }

  _paramInput(target, key) {
    const row = document.createElement('div');
    row.className = 'event-row';
    row.appendChild(this._tinyLabel(key));
    let input;
    if (key === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.value = target[key] || '#ffffff';
      input.addEventListener('input', () => {
        target[key] = input.value;
        this._syncRulesAndRefresh(true); // keep focus; no rerender
      });
    } else if (key === 'text' || key === 'templateId') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = target[key] || '';
      if (key === 'templateId') input.placeholder = 'ball id';
      input.addEventListener('input', () => {
        target[key] = input.value;
        this._syncRulesAndRefresh(true);
      });
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      input.value = target[key] != null ? target[key] : '';
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (!Number.isNaN(v)) target[key] = v;
        this._syncRulesAndRefresh(true);
      });
    }
    row.appendChild(input);
    return row;
  }

  _syncRulesAndRefresh(inplace = false) {
    const rules = this.app.simulator.scenario.events;
    this.app.events.setRules(rules);
    if (!inplace) this.refreshEvents();
    // Rule edits (including debounced text/color/number inputs) collapse
    // into one history entry via scheduleCommit.
    this._scheduleCommit();
  }

  _updateSatisfyingClass() {
    document.body.classList.toggle('satisfying', !!this.app.simulator.scenario.satisfying);
  }

  refreshTopBar() {
    const sim = this.app.simulator;
    document.getElementById('seed-input').value = sim.scenario.seed;
    document.getElementById('random-mode').checked = !!sim.scenario.randomMode;
    document.getElementById('satisfying-mode').checked = !!sim.scenario.satisfying;
    document.getElementById('loop-duration').value = sim.scenario.loopDuration;
    this._refreshSeedResultsUI();
  }

  refreshScenarioPanel() {
    const sc = this.app.simulator.scenario;
    document.getElementById('ov-title').value = sc.overlay.title || '';
    document.getElementById('ov-title-x').value = sc.overlay.titleX != null ? sc.overlay.titleX : 540;
    document.getElementById('ov-title-y').value = sc.overlay.titleY != null ? sc.overlay.titleY : 160;
    document.getElementById('ov-title-size').value = sc.overlay.titleSize != null ? sc.overlay.titleSize : 72;
    document.getElementById('ov-title-color').value = sc.overlay.titleColor || '#ffffff';
    document.getElementById('ov-title-align').value = sc.overlay.titleAlign || 'center';
    document.getElementById('ov-title-weight').value = sc.overlay.titleWeight || '700';
    document.getElementById('ov-title-font').value = sc.overlay.titleFont || 'system-ui, sans-serif';
    document.getElementById('ov-timer').checked = !!sc.overlay.showTimer;
    document.getElementById('ov-counter').checked = !!sc.overlay.showCounter;
    document.getElementById('ov-score').checked = !!sc.overlay.showScore;
    document.getElementById('ov-countdown').checked = !!sc.overlay.bigCountdown;
    document.getElementById('ov-countdown-max').value = sc.overlay.countdownMax || 4;
    document.getElementById('ph-gravity').value = sc.physics.gravity;
    document.getElementById('ph-friction').value = sc.physics.friction;
    // Prefer the preset's maxExportSeconds (safety cap) so the field
    // reflects the cap after switching presets. Falls back to `duration`
    // for legacy scenarios that don't define a cap.
    document.getElementById('export-duration').value = sc.disableExportHardCap
      ? ''
      : (sc.maxExportSeconds || sc.duration);
    document.getElementById('vs-glow').value = sc.visuals.glow;
    document.getElementById('vs-pulse').checked = !!sc.visuals.pulse;
  }

  refreshOutline() {
    const list = document.getElementById('outline-list');
    list.innerHTML = '';
    const overlay = this.app.simulator.scenario.overlay || {};
    if (overlay.title) {
      const titleItem = document.createElement('li');
      titleItem.className = 'outline-item' + (this.selectedId === OVERLAY_TITLE_ID ? ' selected' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = overlay.titleColor || '#ffffff';
      const label = document.createElement('span');
      const summary = String(overlay.title).split('\n')[0].trim() || 'Title';
      label.textContent = `title: ${summary}`;
      label.className = 'label';
      titleItem.appendChild(dot);
      titleItem.appendChild(label);
      titleItem.addEventListener('click', () => this.select(OVERLAY_TITLE_ID));
      list.appendChild(titleItem);
    }
    for (const o of this.app.simulator.scenario.objects) {
      const li = document.createElement('li');
      li.className = 'outline-item' + (o.id === this.selectedId && !this._selectedSubchild ? ' selected' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = o.color || '#fff';
      const label = document.createElement('span');
      label.textContent = `${o.type}: ${o.id}`;
      label.className = 'label';
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Delete';
      del.className = 'mini';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.simulator.removeObject(o.id);
        if (this.selectedId === o.id) this.select(null);
        this.refreshAll();
        this._commit();
      });
      li.appendChild(dot);
      li.appendChild(label);
      li.appendChild(del);
      li.addEventListener('click', () => this.select(o.id));
      list.appendChild(li);
      if (o.type === 'spawner') {
        const child = document.createElement('li');
        child.className = 'outline-item outline-child'
          + (o.id === this.selectedId && this._selectedSubchild === 'spawnBall' ? ' selected' : '');
        const childDot = document.createElement('span');
        childDot.className = 'dot';
        childDot.style.background = o.ballColor || '#fff';
        const childLabel = document.createElement('span');
        childLabel.textContent = `ball: ${o.id}::spawn`;
        childLabel.className = 'label';
        child.appendChild(childDot);
        child.appendChild(childLabel);
        child.addEventListener('click', () => this.select(o.id, 'spawnBall'));
        list.appendChild(child);
      }
    }
  }

  refreshPropertyPanel() {
    const panel = document.getElementById('properties');
    panel.innerHTML = '';
    if (!this.selectedId) {
      panel.innerHTML = '<div class="hint">Select an object on the canvas or outline to edit its properties.</div>';
      return;
    }
    if (this.selectedId === OVERLAY_TITLE_ID) {
      const titleObj = this._makeOverlayTitleProxy();
      const header = document.createElement('div');
      header.className = 'prop-header';
      header.innerHTML = `<h3>text</h3><span class="id">overlay.title</span>`;
      panel.appendChild(header);
      for (const field of propertySchema(titleObj)) {
        panel.appendChild(this._makeField(titleObj, field));
      }
      return;
    }
    const obj = this.app.simulator.scenario.objects.find((o) => o.id === this.selectedId);
    if (!obj) { panel.innerHTML = '<div class="hint">Nothing selected.</div>'; return; }

    const header = document.createElement('div');
    header.className = 'prop-header';
    header.innerHTML = `<h3>${obj.type}</h3><span class="id">${obj.id}</span>`;
    panel.appendChild(header);

    const actions = document.createElement('div');
    actions.className = 'prop-actions';
    const btnDup = document.createElement('button');
    btnDup.textContent = 'Duplicate (D)';
    btnDup.addEventListener('click', () => {
      const c = this.app.simulator.duplicateObject(obj.id);
      if (c) this.select(c.id);
      this.refreshAll();
      this._commit();
    });
    const btnDel = document.createElement('button');
    btnDel.textContent = 'Delete';
    btnDel.className = 'danger';
    btnDel.addEventListener('click', () => {
      this.app.simulator.removeObject(obj.id);
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    actions.appendChild(btnDup);
    actions.appendChild(btnDel);
    panel.appendChild(actions);

    // Ball motion selector appears before the usual schema.
    if (obj.type === 'ball') {
      panel.appendChild(this._makeMotionSelector(obj));
    }

    if (obj.type === 'spawner') {
      const spawnBallProxy = this._makeSpawnerBallProxy(obj);
      const parentFields = [
        { key: 'x', label: 'Position X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Position Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'interval', label: 'Every (s)', type: 'number', min: 0.05, max: 10, step: 0.05, decimals: 2 },
        { key: 'maxBalls', label: 'Max balls', type: 'number', min: 1, max: 200, step: 1 },
        { key: 'colorCycle', label: 'Cycle palette', type: 'bool' },
      ];
      const childFields = propertySchema(spawnBallProxy);
      const groups = this._selectedSubchild === 'spawnBall'
        ? [
            ['Spawned Ball', childFields, spawnBallProxy],
            ['Spawner', parentFields],
          ]
        : [
            ['Spawner', parentFields],
            ['Spawned Ball', childFields, spawnBallProxy],
          ];
      for (const [title, fields, target = obj] of groups) {
        const h = document.createElement('div');
        h.className = 'prop-section-title';
        h.textContent = title;
        panel.appendChild(h);
        for (const field of fields) panel.appendChild(this._makeField(target, field));
      }
    } else {
      const schema = propertySchema(obj);
      for (const field of schema) {
        panel.appendChild(this._makeField(obj, field));
      }
    }

    if (obj.type === 'ball') {
      const row = document.createElement('div');
      row.className = 'prop-row';
      row.style.gridTemplateColumns = '1fr';
      const b = document.createElement('button');
      b.textContent = 'Center in nearest circle';
      b.addEventListener('click', () => {
        const ring = this._findNearestCircle(obj);
        if (!ring) return;
        obj.x = ring.x;
        obj.y = ring.y;
        obj.spawnX = ring.x;
        obj.spawnY = ring.y;
        if (obj.motion === 'orbit' || obj.motion === 'lissajous') {
          obj.orbitCx = ring.x;
          obj.orbitCy = ring.y;
        }
        this._applyEdit(obj);
        this.refreshPropertyPanel();
        this._commit();
      });
      row.appendChild(b);
      panel.appendChild(row);
    }

    if (obj.type === 'ball' && (obj.motion === 'orbit' || obj.motion === 'lissajous')) {
      // Snap-to-integer-harmonics helper for the current ball.
      const row = document.createElement('div');
      row.className = 'prop-row';
      row.style.gridTemplateColumns = '1fr';
      const b = document.createElement('button');
      b.textContent = 'Snap harmonics to integers';
      b.addEventListener('click', () => {
        obj.orbitHarmonic = Math.max(1, Math.round(obj.orbitHarmonic));
        if (obj.motion === 'lissajous') obj.lissaHarmonicY = Math.max(1, Math.round(obj.lissaHarmonicY));
        this.app.simulator.rebuild();
        this.refreshPropertyPanel();
        this._commit();
      });
      row.appendChild(b);
      panel.appendChild(row);
    }

    if (typeof obj.rotationSpeed === 'number') {
      const row = document.createElement('div');
      row.className = 'prop-row';
      row.style.gridTemplateColumns = '1fr';
      const b = document.createElement('button');
      b.textContent = 'Snap rotation to loop';
      b.addEventListener('click', () => {
        obj.rotationSpeed = this.app.simulator.snapRotationSpeed(obj.rotationSpeed);
        this.app.simulator.rebuild();
        this.refreshPropertyPanel();
        this._commit();
      });
      row.appendChild(b);
      panel.appendChild(row);
    }

    // "Attach to circle" convenience button for spike rings.
    if (obj.type === 'spikes') {
      const row = document.createElement('div');
      row.className = 'prop-row';
      row.style.gridTemplateColumns = '1fr';
      const b = document.createElement('button');
      b.textContent = 'Attach to nearest circle';
      b.addEventListener('click', () => {
        const ring = this._findNearestCircle(obj);
        if (!ring) return;
        this._attachSpikesToRing(obj, ring);
        this._applyEdit(obj);
        this.refreshPropertyPanel();
        this._commit();
      });
      row.appendChild(b);
      panel.appendChild(row);
    }
  }

  _makeMotionSelector(obj) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const label = document.createElement('label');
    label.textContent = 'Motion';
    const sel = document.createElement('select');
    for (const v of ['physics', 'orbit', 'lissajous']) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      if (obj.motion === v) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      obj.motion = sel.value;
      if (sel.value === 'orbit' || sel.value === 'lissajous') {
        if (obj.orbitCx == null || obj.orbitCy == null) {
          obj.orbitCx = 540; obj.orbitCy = 960;
        }
      }
      // Motion changes are structural -- always rebuild so parametric balls
      // re-snap to their formula and trails are repopulated correctly.
      this.app.simulator.rebuild();
      this.refreshPropertyPanel();
      this._commit();
    });
    row.appendChild(label);
    row.appendChild(sel);
    const readout = document.createElement('span'); readout.className = 'readout';
    row.appendChild(readout);
    return row;
  }

  _makeField(obj, field) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const authoredObj = obj.__sourceObject || obj;
    const label = document.createElement('label');
    label.textContent = field.label;
    row.appendChild(label);

    let input;
    let value = obj[field.key];
    if (field.key === 'spawnX' && value == null) value = obj.x;
    if (field.key === 'spawnY' && value == null) value = obj.y;

    const makeStepper = (text, title, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prop-stepper';
      btn.textContent = text;
      btn.title = title;
      btn.addEventListener('click', onClick);
      return btn;
    };

    const makeSliderWrap = (rangeEl, onAdjust) => {
      const wrap = document.createElement('div');
      wrap.className = 'prop-slider-wrap';
      wrap.appendChild(makeStepper('-', `Decrease ${field.label}`, () => onAdjust(-1)));
      wrap.appendChild(rangeEl);
      wrap.appendChild(makeStepper('+', `Increase ${field.label}`, () => onAdjust(1)));
      return wrap;
    };

    if (field.type === 'speed') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = field.min;
      input.max = field.max;
      input.step = field.step || 1;
      const curSpeed = Math.hypot(obj.vx || 0, obj.vy || 0);
      input.value = curSpeed;
      const readout = document.createElement('span');
      readout.className = 'readout';
      readout.textContent = curSpeed.toFixed(field.decimals || 0);
      const applySpeed = (speed) => {
        const min = field.min != null ? parseFloat(field.min) : 0;
        const max = field.max != null ? parseFloat(field.max) : Infinity;
        speed = Math.max(min, Math.min(max, speed));
        input.value = speed;
        const vx = obj.vx || 0;
        const vy = obj.vy || 0;
        let angle = Math.atan2(vy, vx);
        if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) angle = -Math.PI / 2;
        obj.vx = Math.cos(angle) * speed;
        obj.vy = Math.sin(angle) * speed;
        readout.textContent = speed.toFixed(field.decimals || 0);
        this._applyEdit(authoredObj);
      };
      input.addEventListener('input', () => applySpeed(parseFloat(input.value)));
      row.appendChild(makeSliderWrap(input, (dir) => {
        const step = parseFloat(field.step || 1);
        applySpeed(parseFloat(input.value) + dir * step);
      }));
      row.appendChild(readout);
      return row;
    } else if (field.type === 'text') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = value != null ? value : '';
      input.addEventListener('input', () => {
        obj[field.key] = input.value;
        this._applyEdit(authoredObj);
        if (field.key === 'text') this.refreshOutline();
        if (authoredObj === this.app.simulator.scenario.overlay) this.refreshScenarioPanel();
      });
    } else if (field.type === 'select') {
      input = document.createElement('select');
      for (const optDef of field.options || []) {
        const opt = document.createElement('option');
        if (typeof optDef === 'string') {
          opt.value = optDef;
          opt.textContent = optDef;
        } else {
          opt.value = optDef.value;
          opt.textContent = optDef.label;
        }
        if (String(opt.value) === String(value)) opt.selected = true;
        input.appendChild(opt);
      }
      input.addEventListener('change', () => {
        obj[field.key] = input.value;
        this._applyEdit(authoredObj);
      });
    } else if (field.type === 'soundSelect') {
      // Sound-preset dropdown + inline ▶ preview button. Looks like a select
      // row in the inspector but hears what the user will get at runtime.
      const wrap = document.createElement('div');
      wrap.className = 'sound-field';
      input = document.createElement('select');
      const presets = (window.SOUND_PRESETS && window.SOUND_PRESETS[field.kind]) || [];
      for (const p of presets) {
        const opt = document.createElement('option');
        opt.value = p.value;
        opt.textContent = p.label;
        if (String(p.value) === String(value || '')) opt.selected = true;
        input.appendChild(opt);
      }
      input.addEventListener('change', () => {
        obj[field.key] = input.value;
        this._applyEdit(authoredObj);
        if (this.app.audio && input.value) {
          this.app.audio.ensureReady();
          this.app.audio.setEnabled(true);
          this.app.audio.previewEventSound(field.kind, input.value);
        }
      });
      wrap.appendChild(input);

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'sound-play';
      play.textContent = '▶';
      play.title = 'Preview this sound';
      play.addEventListener('click', () => {
        if (!this.app.audio) return;
        this.app.audio.ensureReady();
        this.app.audio.setEnabled(true);
        this.app.audio.previewEventSound(field.kind, input.value);
      });
      wrap.appendChild(play);

      row.appendChild(wrap);
      return row;
    } else if (field.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.value = value || '#ffffff';
      input.addEventListener('input', () => {
        obj[field.key] = input.value;
        this._applyEdit(authoredObj);
        this.refreshOutline();
        if (authoredObj === this.app.simulator.scenario.overlay) this.refreshScenarioPanel();
      });
    } else if (field.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.addEventListener('change', () => {
        obj[field.key] = input.checked;
        this._applyEdit(authoredObj);
        if (authoredObj === this.app.simulator.scenario.overlay) this.refreshScenarioPanel();
      });
    } else if (field.type === 'number') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = field.min;
      input.max = field.max;
      input.step = field.step || 1;
      input.value = value;
      const readout = document.createElement('span');
      readout.className = 'readout';
      readout.textContent = Number(value).toFixed(field.decimals || 0);
      const applyNumber = (v) => {
        const min = field.min != null ? parseFloat(field.min) : -Infinity;
        const max = field.max != null ? parseFloat(field.max) : Infinity;
        v = Math.max(min, Math.min(max, v));
        input.value = v;
        obj[field.key] = v;
        if (obj.type === 'ball' && (field.key === 'spawnX' || field.key === 'spawnY')) {
          // Spawn position is best edited as a visual placement tool: pause the
          // sim and mirror the selected ball to that spawn point immediately so
          // the user can see where future spawns will come from.
          this.app.pause();
          if (field.key === 'spawnX') obj.x = v;
          if (field.key === 'spawnY') obj.y = v;
        }
        readout.textContent = v.toFixed(field.decimals || 0);
        this._applyEdit(authoredObj);
        if (authoredObj === this.app.simulator.scenario.overlay) this.refreshScenarioPanel();
      };
      input.addEventListener('input', () => applyNumber(parseFloat(input.value)));
      row.appendChild(makeSliderWrap(input, (dir) => {
        const step = parseFloat(field.step || 1);
        applyNumber(parseFloat(input.value) + dir * step);
      }));
      row.appendChild(readout);
      return row;
    }
    row.appendChild(input);
    return row;
  }

  _makeSpawnerBallProxy(spawner) {
    const defaults = createObject('ball');
    const proxy = {
      id: `${spawner.id}::spawn`,
      type: 'ball',
      motion: 'physics',
      __sourceObject: spawner,
    };
    const mappedKeys = {
      color: 'ballColor',
      radius: 'ballRadius',
      x: 'x',
      y: 'y',
      spawnX: 'x',
      spawnY: 'y',
      vx: 'ballVx',
      vy: 'ballVy',
      trail: 'ballTrail',
      trailLength: 'ballTrailLength',
      clearTrailOnDeath: 'ballClearTrailOnDeath',
      lifetime: 'ballLifetime',
      freezeOnTimeout: 'ballFreezeOnTimeout',
      fixed: 'ballFixed',
      bounce: 'ballBounce',
      wallCurve: 'ballWallCurve',
      wallDrift: 'ballWallDrift',
      collisionSpread: 'ballCollisionSpread',
      softBody: 'ballSoftBody',
      elasticity: 'ballElasticity',
      recoverySpeed: 'ballRecoverySpeed',
      wobbleIntensity: 'ballWobbleIntensity',
      wobbleDamping: 'ballWobbleDamping',
      changeColorOnBallCollision: 'ballChangeColorOnBallCollision',
      destroyOnSpike: 'ballDestroyOnSpike',
      freezeOnSpike: 'ballFreezeOnSpike',
      deadColor: 'ballDeadColor',
      recolorOnFreeze: 'ballRecolorOnFreeze',
      deathBurstOnFreeze: 'ballDeathBurstOnFreeze',
      bounceSound: 'ballBounceSound',
      escapeSound: 'ballEscapeSound',
      destroySound: 'ballDestroySound',
      deathSound: 'ballDeathSound',
    };
    for (const [proxyKey, sourceKey] of Object.entries(mappedKeys)) {
      Object.defineProperty(proxy, proxyKey, {
        enumerable: true,
        configurable: true,
        get: () => (spawner[sourceKey] != null ? spawner[sourceKey] : defaults[proxyKey]),
        set: (value) => { spawner[sourceKey] = value; },
      });
    }
    return proxy;
  }

  _makeOverlayTitleProxy() {
    const overlay = this.app.simulator.scenario.overlay || (this.app.simulator.scenario.overlay = {});
    const proxy = {
      id: OVERLAY_TITLE_ID,
      type: 'text',
      __sourceObject: overlay,
    };
    const mappedKeys = {
      text: 'title',
      x: 'titleX',
      y: 'titleY',
      size: 'titleSize',
      color: 'titleColor',
      align: 'titleAlign',
      weight: 'titleWeight',
      font: 'titleFont',
    };
    const defaults = {
      text: '',
      x: 540,
      y: 160,
      size: 72,
      color: '#ffffff',
      align: 'center',
      weight: '700',
      font: 'system-ui, sans-serif',
    };
    for (const [proxyKey, sourceKey] of Object.entries(mappedKeys)) {
      Object.defineProperty(proxy, proxyKey, {
        enumerable: true,
        configurable: true,
        get: () => (overlay[sourceKey] != null ? overlay[sourceKey] : defaults[proxyKey]),
        set: (value) => { overlay[sourceKey] = value; },
      });
    }
    return proxy;
  }

  // Find the smallest circle that contains (cx, cy) within its bouncing
  // radius. Used when adding a ball so it always spawns INSIDE a container.
  _findContainingCircle() {
    const circles = this.app.simulator.scenario.objects.filter((o) => o.type === 'circle' && o.insideOnly !== false);
    if (circles.length === 0) return null;
    circles.sort((a, b) => a.radius - b.radius);
    return circles[0];
  }

  // Find the circle closest to the given object (by center distance).
  _findNearestCircle(obj) {
    const circles = this.app.simulator.scenario.objects.filter((o) => o.type === 'circle');
    if (circles.length === 0) return null;
    let best = null, bestD = Infinity;
    for (const c of circles) {
      const d = Math.hypot((obj.x || 540) - c.x, (obj.y || 960) - c.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // Snap a spikes object so it sits flush against the inside of a ring AND
  // inherits the ring's escape gap + rotation so they stay aligned forever.
  _attachSpikesToRing(spikes, ring) {
    spikes.x = ring.x;
    spikes.y = ring.y;
    spikes.radius = ring.radius - (ring.thickness || 0) / 2;
    spikes.inward = true;
    // Match gap so no teeth block the opening, with a tiny extra margin so
    // the ball doesn't graze a half-tooth at the edge.
    const pad = 0.06; // ~3.4°
    spikes.gapStart = (ring.gapStart || 0) - pad;
    spikes.gapSize = Math.max(0, (ring.gapSize || 0) + pad * 2);
    // Rotate in lock-step with the ring, from the same starting angle, so the
    // gap stays lined up over time.
    spikes.rotation = ring.rotation || 0;
    spikes.rotationSpeed = ring.rotationSpeed || 0;
  }

  _pickObject(x, y) {
    const objs = this.app.simulator.scenario.objects;
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (o.type !== 'ball') continue;
      if (Math.hypot(x - o.x, y - o.y) <= o.radius + 10) return o;
    }
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (o.type === 'ball') continue;
      const b = getObjectBounds(o);
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return o;
    }
    return null;
  }

  async _exportVideo(kind) {
    const statusEl = document.getElementById('export-status');
    const mp4Btn    = document.getElementById('btn-export-webm');
    const framesBtn = document.getElementById('btn-export-frames');
    const sc = this.app.simulator.scenario;
    const fps = 60;
    const wasRunning = this.app.running;
    // Lock the UI: pause the live sim, disable the buttons, and flip the
    // canvas into "rendering…" mode so the user gets clean feedback
    // instead of a frozen or juddery live preview.
    this.app.pause();
    this.app.beginExport();
    mp4Btn.disabled = true; framesBtn.disabled = true;
    const tag = sc.satisfying ? 'loop' : (sc.name || 'sim').replace(/\s+/g, '_').toLowerCase();

    // Estimate total frames up-front so the progress bar has a sensible
    // denominator even for event-driven end conditions. We use the
    // hard-cap seconds as the ceiling; the actual render usually finishes
    // well before this and the bar jumps to 100% when it does.
    const hardCapSeconds = sc.disableExportHardCap
      ? 120
      : Math.min(120, Math.max(2,
          Number(sc.maxExportSeconds) || (sc.satisfying ? sc.loopDuration : (sc.duration || 30))
        ));
    const hintFrames = Math.ceil(hardCapSeconds * fps);
    const ecType = sc.endCondition && sc.endCondition.type;
    const hasExactFrameTarget = !ecType || ecType === 'loopDuration' || ecType === 'fixed';
    this.app.updateExport({ status: 'Preparing…', done: 0, total: hasExactFrameTarget ? hintFrames : 0 });
    statusEl.textContent = 'Preparing…';

    try {
      const exporter = new ExportManager(this.app.simulator, this.app.audio);
      let result;
      if (kind === 'mp4') {
        result = await exporter.exportMP4({
          fps,
          onStatus: (s) => {
            statusEl.textContent = s;
            this.app.updateExport({ status: s });
          },
          onProgress: (f) => {
            if (f % 4 === 0 || f === 1) {
              statusEl.textContent = hasExactFrameTarget
                ? `Rendering ${f} / ${hintFrames} frames`
                : `Rendering ${f} frames (max ~${hintFrames})`;
              this.app.updateExport({ done: f, total: hasExactFrameTarget ? hintFrames : 0 });
            }
          },
        });
      } else {
        result = await exporter.exportFrames({
          fps,
          onStatus: (s) => {
            statusEl.textContent = s;
            this.app.updateExport({ status: s });
          },
          onProgress: (f) => {
            if (f % 4 === 0 || f === 1) {
              statusEl.textContent = hasExactFrameTarget
                ? `Rendering ${f} / ${hintFrames} frames`
                : `Rendering ${f} frames (max ~${hintFrames})`;
              this.app.updateExport({ done: f, total: hasExactFrameTarget ? hintFrames : 0 });
            }
          },
        });
      }

      const seconds = result.seconds.toFixed(1);
      const filename = `${tag}_${sc.seed}_${seconds}s.${result.extension}`;
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Always save the rendered audio as a WAV sidecar when we have one.
      // This is a decisive debug aid: if the sidecar plays fine but the MP4
      // is silent, the bug is in mp4-muxer / the user's player. If the WAV
      // is ALSO silent, the audio engine produced nothing.
      if (kind === 'mp4' && result.audioWav) {
        const wavName = `${tag}_${sc.seed}_${seconds}s.audio.wav`;
        const wavUrl = URL.createObjectURL(result.audioWav);
        const wa = document.createElement('a');
        wa.href = wavUrl; wa.download = wavName;
        document.body.appendChild(wa); wa.click(); document.body.removeChild(wa);
        URL.revokeObjectURL(wavUrl);
      }

      let audioTag = '';
      if (kind === 'mp4') {
        const peak = typeof result.audioPeak === 'number'
          ? ` (peak ${result.audioPeak.toFixed(3)})` : '';
        if (result.audioCodec) audioTag = ` · audio: ${result.audioCodec}${peak}`;
        else if (result.audioFailReason) audioTag = ` · ⚠ no audio (${result.audioFailReason})`;
        if (result.audioWav) audioTag += ' · +sidecar.wav';
      }
      statusEl.textContent =
        `Saved ${filename} (${result.frames} frames · ${seconds}s${audioTag})`;
    } catch (e) {
      console.error(e);
      statusEl.textContent = 'Export failed: ' + e.message;
    } finally {
      this.app.endExport();
      mp4Btn.disabled = false; framesBtn.disabled = false;
      // After export the simulator has been rebuilt back to t=0, but the
      // live EventEngine still carries "fired once" flags from before. Wipe
      // them so hitting Play immediately replays the scene correctly.
      this.app.events.setRules(this.app.simulator.scenario.events || []);
      if (wasRunning) this.app.start();
    }
  }
}

function propertySchema(objOrType) {
  const type = typeof objOrType === 'string' ? objOrType : objOrType.type;
  const obj = typeof objOrType === 'string' ? null : objOrType;
  const common = [
    { key: 'color', label: 'Color', type: 'color' },
  ];
  switch (type) {
    case 'ball': {
      const fields = [
        { key: 'color', label: 'Color', type: 'color' },
        { key: 'radius', label: 'Radius', type: 'number', min: 4, max: 120, step: 1 },
        { key: 'trailLength', label: 'Trail length', type: 'number', min: 0, max: 800, step: 1 },
        { key: 'trail', label: 'Show trail', type: 'bool' },
        { key: 'clearTrailOnDeath', label: 'Clear trail on death', type: 'bool' },
      ];
      if (obj && (obj.motion === 'orbit' || obj.motion === 'lissajous')) {
        fields.push(
          { key: 'orbitCx', label: 'Orbit center X', type: 'number', min: 0, max: 1080, step: 1 },
          { key: 'orbitCy', label: 'Orbit center Y', type: 'number', min: 0, max: 1920, step: 1 },
          { key: 'orbitRadius', label: 'Orbit radius', type: 'number', min: 0, max: 900, step: 1 },
          { key: 'orbitHarmonic', label: 'Cycles / loop', type: 'number', min: -8, max: 8, step: 1 },
          { key: 'orbitPhase', label: 'Phase (rad)', type: 'number', min: 0, max: Math.PI * 2, step: 0.01, decimals: 2 },
          { key: 'orbitDirection', label: 'Direction', type: 'number', min: -1, max: 1, step: 2 },
        );
        if (obj.motion === 'lissajous') {
          fields.push(
            { key: 'lissaRadiusY', label: 'Radius Y', type: 'number', min: 0, max: 900, step: 1 },
            { key: 'lissaHarmonicY', label: 'Cycles Y / loop', type: 'number', min: -8, max: 8, step: 1 },
            { key: 'lissaPhaseY', label: 'Phase Y (rad)', type: 'number', min: 0, max: Math.PI * 2, step: 0.01, decimals: 2 },
          );
        }
      } else {
        fields.push(
        { key: 'spawnX', label: 'Spawn X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'spawnY', label: 'Spawn Y', type: 'number', min: 0, max: 1920, step: 1 },
          { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
          { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
          { key: 'speed', label: 'Speed', type: 'speed', min: 0, max: 1200, step: 1 },
          { key: 'fixed', label: 'Static', type: 'bool' },
          { key: 'bounce', label: 'Bounce', type: 'number', min: 0, max: 1.5, step: 0.01, decimals: 2 },
          { key: 'wallCurve', label: 'Wall curve', type: 'number', min: 0, max: 1, step: 0.01, decimals: 2 },
          { key: 'wallDrift', label: 'Wall drift', type: 'number', min: 0, max: 1, step: 0.01, decimals: 2 },
          { key: 'collisionSpread', label: 'Collision spread', type: 'number', min: 0, max: 1, step: 0.01, decimals: 2 },
          { key: 'softBody', label: 'Wobbly collisions', type: 'bool' },
          { key: 'elasticity', label: 'Elasticity', type: 'number', min: 0, max: 3, step: 0.01, decimals: 2 },
          { key: 'recoverySpeed', label: 'Recovery speed', type: 'number', min: 0.05, max: 20, step: 0.05, decimals: 2 },
          { key: 'wobbleIntensity', label: 'Wobble intensity', type: 'number', min: 0, max: 3, step: 0.01, decimals: 2 },
          { key: 'wobbleDamping', label: 'Wobble damping', type: 'number', min: 0.05, max: 20, step: 0.05, decimals: 2 },
          { key: 'changeColorOnBallCollision', label: 'Change color on ball collision', type: 'bool' },
          { key: 'freezeOnTimeout', label: 'Freeze on timeout', type: 'bool' },
          { key: 'destroyOnSpike', label: 'Destroy on spike', type: 'bool' },
          { key: 'freezeOnSpike', label: 'Freeze on spike', type: 'bool' },
        );
      }
      fields.push(
        { key: 'spawnX', label: 'Spawn X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'spawnY', label: 'Spawn Y', type: 'number', min: 0, max: 1920, step: 1 },
      );
      fields.push({ key: 'lifetime', label: 'Lifetime (s, 0=inf)', type: 'number', min: 0, max: 60, step: 0.1, decimals: 1 });
      // Per-ball sound overrides. See SOUND_PRESETS in src/audio.js.
      fields.push(
        { key: 'bounceSound',  label: 'Bounce sound',  type: 'soundSelect', kind: 'bounce'  },
        { key: 'escapeSound',  label: 'Escape sound',  type: 'soundSelect', kind: 'escape'  },
        { key: 'destroySound', label: 'Destroy sound', type: 'soundSelect', kind: 'destroy' },
        { key: 'deathSound',   label: 'Freeze sound',  type: 'soundSelect', kind: 'freeze'  },
      );
      return fields;
    }
    case 'text':
      return [
        { key: 'text', label: 'Text', type: 'text' },
        { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'size', label: 'Size', type: 'number', min: 12, max: 240, step: 1 },
        { key: 'color', label: 'Color', type: 'color' },
        { key: 'align', label: 'Align', type: 'text' },
        { key: 'weight', label: 'Weight', type: 'text' },
        { key: 'font', label: 'Font', type: 'text' },
      ];
    case 'timer':
      return [
        { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'size', label: 'Size', type: 'number', min: 12, max: 240, step: 1 },
        { key: 'color', label: 'Color', type: 'color' },
        { key: 'prefix', label: 'Prefix', type: 'text' },
        { key: 'suffix', label: 'Suffix', type: 'text' },
        { key: 'decimals', label: 'Decimals', type: 'number', min: 0, max: 3, step: 1 },
        { key: 'resetOn', label: 'Reset when', type: 'select', options: [
          { value: 'never', label: 'Never' },
          { value: 'ballCollision', label: 'Any ball collision' },
          { value: 'ballBallCollision', label: 'Ball touches ball' },
          { value: 'circleHit', label: 'Ball hits circle/spikes' },
          { value: 'ballGone', label: 'Ball disappears' },
          { value: 'lastBallGone', label: 'Last ball disappears' },
          { value: 'firstEscape', label: 'Ball escapes' },
        ] },
        { key: 'align', label: 'Align', type: 'text' },
        { key: 'weight', label: 'Weight', type: 'text' },
        { key: 'font', label: 'Font', type: 'text' },
      ];
    case 'scoreBin':
      return [
        { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'width', label: 'Width', type: 'number', min: 40, max: 420, step: 1 },
        { key: 'height', label: 'Height', type: 'number', min: 40, max: 420, step: 1 },
        { key: 'points', label: 'Points', type: 'number', min: -999, max: 9999, step: 1 },
        { key: 'label', label: 'Label', type: 'text' },
        { key: 'color', label: 'Color', type: 'color' },
        { key: 'textColor', label: 'Text color', type: 'color' },
        { key: 'captureMode', label: 'On score', type: 'select', options: [
          { value: 'consume', label: 'Consume ball' },
          { value: 'freeze', label: 'Freeze ball' },
          { value: 'keep', label: 'Keep moving' },
          { value: 'settle', label: 'Settle at bottom' },
        ] },
        ...(obj && obj.captureMode === 'settle'
          ? [{
              key: 'scoreTrigger',
              label: 'Count at',
              type: 'select',
              options: [
                { value: 'top', label: 'Top / entry' },
                { value: 'bottom', label: 'Bottom / settled' },
              ],
            }]
          : []),
      ];
    case 'circle':
      return [
        ...common,
        { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'radius', label: 'Radius', type: 'number', min: 30, max: 520, step: 1 },
        { key: 'thickness', label: 'Thickness', type: 'number', min: 2, max: 60, step: 1 },
        { key: 'insideOnly', label: 'Contain balls', type: 'bool' },
        { key: 'rotationSpeed', label: 'Rotation speed', type: 'number', min: -5, max: 5, step: 0.01, decimals: 2 },
        { key: 'gapStart', label: 'Gap angle', type: 'number', min: 0, max: Math.PI * 2, step: 0.01, decimals: 2 },
        { key: 'gapSize', label: 'Gap size', type: 'number', min: 0, max: Math.PI * 2, step: 0.01, decimals: 2 },
        { key: 'gapPulse', label: 'Gap open/close', type: 'bool' },
        { key: 'gapMinSize', label: 'Gap min size', type: 'number', min: 0, max: Math.PI * 2, step: 0.01, decimals: 2 },
        { key: 'gapPulseSpeed', label: 'Gap pulse speed', type: 'number', min: 0, max: 6, step: 0.05, decimals: 2 },
      ];
    case 'arc':
      return [
        ...common,
        { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'radius', label: 'Radius', type: 'number', min: 30, max: 520, step: 1 },
        { key: 'thickness', label: 'Thickness', type: 'number', min: 2, max: 60, step: 1 },
        { key: 'startAngle', label: 'Start angle', type: 'number', min: -Math.PI * 2, max: Math.PI * 2, step: 0.01, decimals: 2 },
        { key: 'endAngle', label: 'End angle', type: 'number', min: -Math.PI * 2, max: Math.PI * 2, step: 0.01, decimals: 2 },
        { key: 'rotationSpeed', label: 'Rotation speed', type: 'number', min: -5, max: 5, step: 0.01, decimals: 2 },
      ];
    case 'spiral':
      return [
        ...common,
        { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'innerRadius', label: 'Inner radius', type: 'number', min: 20, max: 400, step: 1 },
        { key: 'outerRadius', label: 'Outer radius', type: 'number', min: 100, max: 520, step: 1 },
        { key: 'layers', label: 'Layers', type: 'number', min: 1, max: 12, step: 1 },
        { key: 'gapSize', label: 'Gap size', type: 'number', min: 0, max: Math.PI * 2, step: 0.01, decimals: 2 },
        { key: 'thickness', label: 'Thickness', type: 'number', min: 2, max: 30, step: 1 },
        { key: 'rotationSpeed', label: 'Rotation speed', type: 'number', min: -5, max: 5, step: 0.01, decimals: 2 },
      ];
    case 'spikes':
      return [
        ...common,
        { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'radius', label: 'Radius', type: 'number', min: 40, max: 520, step: 1 },
        { key: 'count', label: 'Count', type: 'number', min: 3, max: 120, step: 1 },
        { key: 'length', label: 'Length', type: 'number', min: 6, max: 120, step: 1 },
        { key: 'width', label: 'Width', type: 'number', min: 6, max: 120, step: 1 },
        { key: 'inward', label: 'Inward', type: 'bool' },
        { key: 'destroys', label: 'Destroys balls', type: 'bool' },
        { key: 'freezes', label: 'Freezes balls', type: 'bool' },
        { key: 'rotationSpeed', label: 'Rotation speed', type: 'number', min: -5, max: 5, step: 0.01, decimals: 2 },
        { key: 'gapStart', label: 'Gap angle', type: 'number', min: 0, max: Math.PI * 2, step: 0.01, decimals: 2 },
        { key: 'gapSize', label: 'Gap size', type: 'number', min: 0, max: Math.PI * 2, step: 0.01, decimals: 2 },
      ];
    case 'spawner':
      return [
        { key: 'x', label: 'Position X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Position Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'interval', label: 'Every (s)', type: 'number', min: 0.05, max: 10, step: 0.05, decimals: 2 },
        { key: 'maxBalls', label: 'Max balls', type: 'number', min: 1, max: 200, step: 1 },
        { key: 'ballColor', label: 'Ball color', type: 'color' },
        { key: 'colorCycle', label: 'Cycle palette', type: 'bool' },
        { key: 'ballRadius', label: 'Ball radius', type: 'number', min: 4, max: 80, step: 1 },
        { key: 'ballVx', label: 'Ball vx', type: 'number', min: -800, max: 800, step: 5 },
        { key: 'ballVy', label: 'Ball vy', type: 'number', min: -800, max: 800, step: 5 },
        { key: 'ballBounce', label: 'Ball bounce', type: 'number', min: 0, max: 1.5, step: 0.01, decimals: 2 },
        { key: 'ballCollisionSpread', label: 'Ball collision spread', type: 'number', min: 0, max: 1, step: 0.01, decimals: 2 },
        { key: 'ballLifetime', label: 'Ball lifetime (s, 0=inf)', type: 'number', min: 0, max: 60, step: 0.1, decimals: 1 },
        { key: 'ballTrail', label: 'Ball trail', type: 'bool' },
        { key: 'ballTrailLength', label: 'Ball trail length', type: 'number', min: 0, max: 400, step: 1 },
      ];
    default: return common;
  }
}

window.UI = UI;
