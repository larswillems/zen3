// UI wiring: left object-builder panel, right property inspector, top controls,
// selection + drag, and scenario save/load. Extended with the Satisfying Loop
// Generator controls (loop duration, satisfying toggle, symmetry spawner,
// snap-to-clean-ratios buttons, orbit inspector).

const OVERLAY_TITLE_ID = '__overlay_title__';
const OVERLAY_TIMER_ID = '__overlay_timer__';
const OVERLAY_COUNTER_ID = '__overlay_counter__';
const OVERLAY_SCORE_ID = '__overlay_score__';
const OVERLAY_COUNTDOWN_ID = '__overlay_countdown__';
const LEFT_PANEL_WIDTH_STORAGE_KEY = 'zen3.leftPanelWidth';
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'zen3.rightPanelWidth';
const BALL_BEHAVIOR_PRESETS = Object.freeze({
  custom: { label: 'Custom' },
  pinballSpring: {
    label: 'Pinball spring',
    bounce: 1.08,
    wallCurve: 0.28,
    wallDrift: 0.22,
    wallBounceAngleRange: 10,
    collisionSpread: 0.18,
  },
  wallRoller: {
    label: 'Wall roller',
    bounce: 0.98,
    wallCurve: 0.68,
    wallDrift: 0.84,
    wallBounceAngleRange: 18,
    collisionSpread: 0.08,
  },
  mixedChaos: {
    label: 'Mixed chaos',
    bounce: 1.03,
    wallCurve: 0.62,
    wallDrift: 0.76,
    wallBounceAngleRange: 34,
    collisionSpread: 0.12,
  },
});
const BALL_BEHAVIOR_PRESET_OPTIONS = Object.entries(BALL_BEHAVIOR_PRESETS).map(([value, def]) => ({
  value,
  label: def.label,
}));
const BALL_BEHAVIOR_PRESET_KEYS = ['bounce', 'wallCurve', 'wallDrift', 'wallBounceAngleRange', 'collisionSpread'];

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
    this._seedResultsExpanded = false;
    this._seedResultsSortKey = 'match';
    this._seedSearchRunning = false;
    this._seedSearchCancelRequested = false;
    this._exportQueue = [];
    this._activeExportJob = null;
    this._exportWorkerPromise = null;
    this._nextExportJobId = 1;
    this._leftPanelWidth = 280;
    this._rightPanelWidth = 320;
    this._bind();
    this._restoreLeftPanelWidth();
    this._restoreRightPanelWidth();
    this.refreshAll();
  }

  _bind() {
    this._bindLeftPanelResize();
    this._bindRightPanelResize();

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
            obj.vx = 0;
            obj.vy = 260;
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

    const randomColorsBtn = document.getElementById('btn-random-colors');
    if (randomColorsBtn) {
      randomColorsBtn.addEventListener('click', () => this._applyRandomColorCombo());
    }
    const brightColorsBtn = document.getElementById('btn-bright-colors');
    if (brightColorsBtn) {
      brightColorsBtn.addEventListener('click', () => this._applyRandomColorCombo(this._randomBrightColorCombos()));
    }

    // Top bar controls.
    document.getElementById('btn-start').addEventListener('click', () => {
      this.refreshAll();
      // Start button doubles as the audio-unlock gesture: browsers require
      // audio contexts to be created/resumed from a user interaction.
      if (this.app.audio) this.app.audio.ensureReady();
      this.app.start();
    });
    document.getElementById('btn-pause').addEventListener('click', () => this.app.pause());
    document.getElementById('btn-reset').addEventListener('click', () => {
      this.refreshAll();
      this.app.reset();
      if (this.app.audio) this.app.audio.ensureReady();
      this.app.start();
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
      const min = parseFloat(speedSlider.min || '0.01');
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
    const seedResultsSort = document.getElementById('seed-results-sort');
    if (seedResultsSort) {
      seedResultsSort.addEventListener('change', () => {
        this._seedResultsSortKey = String(seedResultsSort.value || 'match');
        this._setSeedResults(this._seedResults, null, { preserveSelection: false });
        this._refreshSeedResultsUI();
      });
    }
    const seedResultsToggle = document.getElementById('btn-seed-results-toggle');
    if (seedResultsToggle) {
      seedResultsToggle.addEventListener('click', () => {
        this._seedResultsExpanded = !this._seedResultsExpanded;
        this._refreshSeedResultsUI();
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
    const testDeterminationBtn = document.getElementById('btn-test-determination');
    if (testDeterminationBtn) {
      testDeterminationBtn.addEventListener('click', () => this._testDeterminationAttempts());
    }

    const branchMazeRotation = document.getElementById('branch-maze-rotation');
    const branchMazeRotationLabel = document.getElementById('branch-maze-rotation-label');
    if (branchMazeRotation && branchMazeRotationLabel) {
      const updateBranchMazeLabel = (value) => {
        branchMazeRotationLabel.textContent = `${Number(value).toFixed(2)} rad/s`;
      };
      updateBranchMazeLabel(branchMazeRotation.value);
      branchMazeRotation.addEventListener('input', () => {
        const value = parseFloat(branchMazeRotation.value) || 0;
        updateBranchMazeLabel(value);
        this._setBranchMazeRotationSpeed(value);
      });
    }

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
    document.getElementById('preset-onechance-4').addEventListener('click', () => {
      this._activePresetId = 'onechance-4';
      this.app.simulator.setScenario(buildOneChanceCircleScenario(this.app.simulator.scenario.seed, '4p1'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-onechance-6').addEventListener('click', () => {
      this._activePresetId = 'onechance-6';
      this.app.simulator.setScenario(buildOneChanceCircleScenario(this.app.simulator.scenario.seed, '6p1'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-onechance-8').addEventListener('click', () => {
      this._activePresetId = 'onechance-8';
      this.app.simulator.setScenario(buildOneChanceCircleScenario(this.app.simulator.scenario.seed, '8p1'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    for (let i = 1; i <= 6; i++) {
      const btn = document.getElementById(`preset-gap-static-${i}`);
      if (!btn) continue;
      btn.addEventListener('click', () => {
        this._activePresetId = `gap-static-${i}`;
        this.app.simulator.setScenario(buildGapStaticSweepScenario(i, this.app.simulator.scenario.seed));
        this._afterScenarioSwitch();
        this.select(null);
        this.refreshAll();
        this._commit();
      });
    }
    document.getElementById('preset-gap-rotate-pass').addEventListener('click', () => {
      this._activePresetId = 'gap-rotate-pass';
      this.app.simulator.setScenario(buildGapEdgeCaseScenario('rotate-pass', this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-gap-rotate-graze').addEventListener('click', () => {
      this._activePresetId = 'gap-rotate-graze';
      this.app.simulator.setScenario(buildGapEdgeCaseScenario('rotate-graze', this.app.simulator.scenario.seed));
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
    document.getElementById('preset-timed2').addEventListener('click', () => {
      this._activePresetId = 'timed2';
      this.app.simulator.setScenario(buildTwoSecEscapeScenario());
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-timed3').addEventListener('click', () => {
      this._activePresetId = 'timed3';
      this.app.simulator.setScenario(buildThreeSecEscapeScenario());
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-burning-rings').addEventListener('click', () => {
      this._activePresetId = 'burning-rings';
      this.app.simulator.setScenario(buildBurningRingsScenario(this.app.simulator.scenario.seed));
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
    document.getElementById('preset-neon-pinball').addEventListener('click', () => {
      this._activePresetId = 'neon-pinball';
      this.app.simulator.setScenario(buildNeonPinballScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-classic-pinball').addEventListener('click', () => {
      this._activePresetId = 'classic-pinball';
      this.app.simulator.setScenario(buildClassicPinballScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-easter').addEventListener('click', () => {
      this._activePresetId = 'easter';
      this.app.simulator.setScenario(buildEasterScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-easter-orbit').addEventListener('click', () => {
      this._activePresetId = 'easter-orbit';
      this.app.simulator.setScenario(buildEggHuntOrbitScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-memory').addEventListener('click', () => {
      this._activePresetId = 'memory';
      this.app.simulator.setScenario(buildMemoryMazeScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-rhythm').addEventListener('click', () => {
      this._activePresetId = 'rhythm';
      this.app.simulator.setScenario(buildRhythmDropScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-prediction').addEventListener('click', () => {
      this._activePresetId = 'prediction';
      this.app.simulator.setScenario(buildPredictionGatesScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-legend-spikes').addEventListener('click', () => {
      this._activePresetId = 'legend-spikes';
      this.app.simulator.setScenario(buildLegendSpikesScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-determination').addEventListener('click', () => {
      this._activePresetId = 'determination';
      this.app.simulator.setScenario(buildDeterminationSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-crystal-spiral').addEventListener('click', () => {
      this._activePresetId = 'crystal-spiral';
      this.app.simulator.setScenario(buildCrystalSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-starlight-spiral').addEventListener('click', () => {
      this._activePresetId = 'starlight-spiral';
      this.app.simulator.setScenario(buildStarlightSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-bubble-spiral').addEventListener('click', () => {
      this._activePresetId = 'bubble-spiral';
      this.app.simulator.setScenario(buildBubbleSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-neon-bolt-spiral').addEventListener('click', () => {
      this._activePresetId = 'neon-bolt-spiral';
      this.app.simulator.setScenario(buildNeonBoltSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-candy-drop-spiral').addEventListener('click', () => {
      this._activePresetId = 'candy-drop-spiral';
      this.app.simulator.setScenario(buildCandyDropSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-moonlit-spiral').addEventListener('click', () => {
      this._activePresetId = 'moonlit-spiral';
      this.app.simulator.setScenario(buildMoonlitSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-blossom-spiral').addEventListener('click', () => {
      this._activePresetId = 'blossom-spiral';
      this.app.simulator.setScenario(buildBlossomSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-ember-spiral').addEventListener('click', () => {
      this._activePresetId = 'ember-spiral';
      this.app.simulator.setScenario(buildEmberSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-frost-rune-spiral').addEventListener('click', () => {
      this._activePresetId = 'frost-rune-spiral';
      this.app.simulator.setScenario(buildFrostRuneSpiralScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-giant-marbles').addEventListener('click', () => {
      this._activePresetId = 'giant-marbles';
      this.app.simulator.setScenario(buildGiantMarbleGauntletScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-spinner-storm').addEventListener('click', () => {
      this._activePresetId = 'spinner-storm';
      this.app.simulator.setScenario(buildSpinnerStormScenario(this.app.simulator.scenario.seed));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-a').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-a';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'repo-a'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-b').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-b';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'repo-b'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-c').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-c';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'repo-c'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-d').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-d';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'repo-d'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-tower').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-tower';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-45'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-tower-b').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-tower-b';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-45-b'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-tower-c').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-tower-c';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-45-c'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-tower-d').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-tower-d';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-45-d'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-tower-e').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-tower-e';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-45-e'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-count').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-count';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-count'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-count-b').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-count-b';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-count-b'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-count-c').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-count-c';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-count-c'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-count-d').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-count-d';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-count-d'));
      this._afterScenarioSwitch();
      this.select(null);
      this.refreshAll();
      this._commit();
    });
    document.getElementById('preset-branch-maze-count-e').addEventListener('click', () => {
      this._activePresetId = 'branch-maze-count-e';
      this.app.simulator.setScenario(buildBranchMazeScenario(this.app.simulator.scenario.seed, 'tower-count-e'));
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
      this.refreshOutline();
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
    document.getElementById('vs-freeze-glow-color').addEventListener('input', (e) => {
      this.app.simulator.scenario.visuals.freezeGlowColor = e.target.value;
      this._scheduleCommit();
    });
    document.getElementById('vs-freeze-rim-color').addEventListener('input', (e) => {
      this.app.simulator.scenario.visuals.freezeRimColor = e.target.value;
      this._scheduleCommit();
    });
    document.getElementById('vs-freeze-opacity').addEventListener('input', (e) => {
      this.app.simulator.scenario.visuals.freezeOpacity = parseFloat(e.target.value);
      this._scheduleCommit();
    });
    document.getElementById('vs-freeze-speck-count').addEventListener('input', (e) => {
      this.app.simulator.scenario.visuals.freezeSpeckCount = Math.max(0, parseInt(e.target.value, 10) || 0);
      this._scheduleCommit();
    });
    document.getElementById('vs-freeze-speck-color').addEventListener('input', (e) => {
      this.app.simulator.scenario.visuals.freezeSpeckColor = e.target.value;
      this._scheduleCommit();
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
    document.getElementById('btn-queue-export-webm').addEventListener('click', () => this._queueExportVideo('mp4'));
    document.getElementById('btn-export-frames').addEventListener('click', () => this._exportVideo('frames'));
    document.getElementById('btn-queue-export-frames').addEventListener('click', () => this._queueExportVideo('frames'));
    document.getElementById('btn-start-export-queue').addEventListener('click', () => this._startQueuedExports());
    document.getElementById('btn-stop-export').addEventListener('click', () => {
      this.app.requestExportCancel();
      this._setExportStatus(this._activeExportJob ? `Stopping ${this._describeExportJob(this._activeExportJob)}…` : 'Stopping…');
    });

    this._bindMelodyEditor();

    // Events system.
    document.getElementById('btn-add-event').addEventListener('click', () => {
      const sc = this.app.simulator.scenario;
      if (!Array.isArray(sc.events)) sc.events = [];
      sc.events.push({
        id: 'rule_' + Math.random().toString(36).slice(2, 8),
        trigger: { type: 'firstEscape' },
        actions: [{ type: 'confetti' }],
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

  _bindLeftPanelResize() {
    const layout = document.querySelector('.layout');
    const handle = document.getElementById('left-panel-resizer');
    const leftPanel = document.getElementById('left-panel');
    if (!layout || !handle || !leftPanel) return;

    const minWidth = 260;
    const maxWidth = 700;
    const applyWidth = (px, persist = false) => {
      const clamped = Math.max(minWidth, Math.min(maxWidth, Math.round(px)));
      this._leftPanelWidth = clamped;
      document.documentElement.style.setProperty('--left-panel-width', `${clamped}px`);
      if (persist) {
        try { localStorage.setItem(LEFT_PANEL_WIDTH_STORAGE_KEY, String(clamped)); } catch (_) {}
      }
    };
    this._applyLeftPanelWidth = applyWidth;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = layout.getBoundingClientRect();
      const startLeft = rect.left;
      document.body.classList.add('resizing-left-panel');
      handle.setPointerCapture(e.pointerId);

      const move = (ev) => {
        applyWidth(ev.clientX - startLeft, false);
      };
      const finish = () => {
        document.body.classList.remove('resizing-left-panel');
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        applyWidth(this._leftPanelWidth, true);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    });
  }

  _restoreLeftPanelWidth() {
    let saved = null;
    try { saved = localStorage.getItem(LEFT_PANEL_WIDTH_STORAGE_KEY); } catch (_) {}
    const parsed = saved != null ? parseInt(saved, 10) : NaN;
    const width = Number.isFinite(parsed) ? parsed : this._leftPanelWidth;
    document.documentElement.style.setProperty('--left-panel-width', `${width}px`);
    this._leftPanelWidth = width;
  }

  _bindRightPanelResize() {
    const layout = document.querySelector('.layout');
    const handle = document.getElementById('right-panel-resizer');
    const rightPanel = document.getElementById('right-panel');
    if (!layout || !handle || !rightPanel) return;

    const minWidth = 280;
    const maxWidth = 760;
    const applyWidth = (px, persist = false) => {
      const clamped = Math.max(minWidth, Math.min(maxWidth, Math.round(px)));
      this._rightPanelWidth = clamped;
      document.documentElement.style.setProperty('--right-panel-width', `${clamped}px`);
      if (persist) {
        try { localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(clamped)); } catch (_) {}
      }
    };
    this._applyRightPanelWidth = applyWidth;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = layout.getBoundingClientRect();
      const endRight = rect.right;
      document.body.classList.add('resizing-right-panel');
      handle.setPointerCapture(e.pointerId);

      const move = (ev) => {
        applyWidth(endRight - ev.clientX, false);
      };
      const finish = () => {
        document.body.classList.remove('resizing-right-panel');
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        applyWidth(this._rightPanelWidth, true);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    });
  }

  _restoreRightPanelWidth() {
    let saved = null;
    try { saved = localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY); } catch (_) {}
    const parsed = saved != null ? parseInt(saved, 10) : NaN;
    const width = Number.isFinite(parsed) ? parsed : this._rightPanelWidth;
    document.documentElement.style.setProperty('--right-panel-width', `${width}px`);
    this._rightPanelWidth = width;
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
      if (running.type === 'ball' && k === 'color' && running[k] !== authoredObj[k]) {
        running._collisionColorIndex = null;
      }
      running[k] = authoredObj[k];
    }
  }

  _syncLiveBallColorsFromScenario() {
    const state = this.app && this.app.simulator ? this.app.simulator.state : null;
    const scenario = this.app && this.app.simulator ? this.app.simulator.scenario : null;
    if (!state || !Array.isArray(state.objects) || !scenario || !Array.isArray(scenario.objects)) return;

    const authoredBallColors = new Map();
    const spawnerColors = new Map();
    for (const obj of scenario.objects) {
      if (!obj || typeof obj !== 'object') continue;
      if (obj.type === 'ball') authoredBallColors.set(obj.id, obj.color || '#ffffff');
      if (obj.type === 'spawner') spawnerColors.set(obj.id, obj.ballColor || '#ffffff');
    }

    for (const liveObj of state.objects) {
      if (!liveObj || liveObj.type !== 'ball') continue;
      let nextColor = null;
      if (authoredBallColors.has(liveObj.id)) {
        nextColor = authoredBallColors.get(liveObj.id);
      } else if (liveObj._fromSpawner && spawnerColors.has(liveObj._fromSpawner)) {
        nextColor = spawnerColors.get(liveObj._fromSpawner);
      }
      if (!nextColor || liveObj.color === nextColor) continue;
      liveObj.color = nextColor;
      liveObj._collisionColorIndex = null;
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

  _setBranchMazeRotationSpeed(speed) {
    const sc = this.app.simulator.scenario;
    if (!sc || !sc.branchMazeVariant) return;
    const nextSpeed = Number.isFinite(speed) ? speed : 0;
    sc.branchMazeRotationSpeed = nextSpeed;
    for (const obj of sc.objects || []) {
      if (!obj || !obj.branchMazeWall) continue;
      obj.mazeSpinSpeed = nextSpeed;
      if (this.app.running) this._syncLive(obj);
    }
    if (!this.app.running) this.app.simulator.rebuild();
    this.refreshScenarioPanel();
    this._scheduleCommit();
  }

  _randomColorCombos() {
    return [
      ['#a855f7', '#f43f5e', '#fb7185', '#f472b6', '#7c3aed'],
      ['#22c55e', '#eab308', '#84cc16', '#fde047', '#65a30d'],
      ['#38bdf8', '#6366f1', '#a78bfa', '#22d3ee', '#0ea5e9'],
      ['#f97316', '#ef4444', '#fbbf24', '#fb7185', '#ea580c'],
      ['#14b8a6', '#06b6d4', '#67e8f9', '#2dd4bf', '#0f766e'],
      ['#e879f9', '#c084fc', '#fb7185', '#f9a8d4', '#9333ea'],
      ['#34d399', '#60a5fa', '#fde68a', '#a3e635', '#10b981'],
      ['#f59e0b', '#84cc16', '#22c55e', '#fde047', '#ca8a04'],
      ['#0f172a', '#1d4ed8', '#38bdf8', '#f8fafc', '#93c5fd'],
      ['#111827', '#7c3aed', '#22d3ee', '#f5f3ff', '#c4b5fd'],
      ['#0b1020', '#ef4444', '#f59e0b', '#fde68a', '#fff7ed'],
      ['#052e16', '#16a34a', '#4ade80', '#dcfce7', '#86efac'],
      ['#1f2937', '#ec4899', '#f472b6', '#fbcfe8', '#fdf2f8'],
      ['#172554', '#2563eb', '#60a5fa', '#bfdbfe', '#eff6ff'],
      ['#3f0d12', '#b91c1c', '#f87171', '#fecaca', '#fff1f2'],
      ['#3b0764', '#9333ea', '#d8b4fe', '#fae8ff', '#f5d0fe'],
      ['#082f49', '#0891b2', '#22d3ee', '#a5f3fc', '#ecfeff'],
      ['#292524', '#78716c', '#d6d3d1', '#fafaf9', '#e7e5e4'],
      ['#14532d', '#15803d', '#facc15', '#fef08a', '#ecfccb'],
      ['#4c0519', '#be123c', '#fb7185', '#fecdd3', '#fff1f2'],
      ['#431407', '#ea580c', '#fdba74', '#ffedd5', '#fff7ed'],
      ['#083344', '#0f766e', '#5eead4', '#ccfbf1', '#f0fdfa'],
      ['#172554', '#1e40af', '#eab308', '#fef08a', '#fefce8'],
      ['#2e1065', '#6d28d9', '#22c55e', '#bbf7d0', '#f0fdf4'],
      ['#111827', '#f43f5e', '#fb7185', '#fda4af', '#ffe4e6'],
      ['#0c4a6e', '#0284c7', '#7dd3fc', '#e0f2fe', '#f0f9ff'],
      ['#365314', '#65a30d', '#bef264', '#ecfccb', '#f7fee7'],
      ['#27272a', '#52525b', '#a1a1aa', '#e4e4e7', '#fafafa'],
      ['#1e1b4b', '#4338ca', '#818cf8', '#c7d2fe', '#eef2ff'],
      ['#164e63', '#0891b2', '#f97316', '#fdba74', '#ffedd5'],
      ['#450a0a', '#dc2626', '#fca5a5', '#fee2e2', '#fef2f2'],
      ['#312e81', '#7c3aed', '#f59e0b', '#fcd34d', '#fffbeb'],
      ['#064e3b', '#10b981', '#34d399', '#a7f3d0', '#ecfdf5'],
      ['#3f3f46', '#e11d48', '#fb7185', '#f9a8d4', '#fdf2f8'],
      ['#082032', '#2c74b3', '#00a8cc', '#90e0ef', '#f1f5f9'],
      ['#2d1b69', '#6c63ff', '#ff6bcb', '#ffd6ff', '#fff0f6'],
      ['#1b4332', '#2d6a4f', '#95d5b2', '#d8f3dc', '#f1faee'],
      ['#3a0ca3', '#7209b7', '#f72585', '#ff99c8', '#fff0f3'],
      ['#03045e', '#0077b6', '#00b4d8', '#90e0ef', '#caf0f8'],
      ['#5f0f40', '#9a031e', '#fb8b24', '#e36414', '#ffd6a5'],
      ['#283618', '#606c38', '#dda15e', '#fefae0', '#bc6c25'],
      ['#001219', '#005f73', '#0a9396', '#94d2bd', '#e9d8a6'],
      ['#2b2d42', '#8d99ae', '#edf2f4', '#ef233c', '#d90429'],
      ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'],
      ['#0d1b2a', '#1b263b', '#415a77', '#778da9', '#e0e1dd'],
    ];
  }

  _randomBrightColorCombos() {
    return [
      ['#ff00b8', '#22d3ee', '#facc15', '#a78bfa', '#34d399'],
      ['#f43f5e', '#fb923c', '#fde047', '#4ade80', '#38bdf8'],
      ['#ec4899', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316'],
      ['#ff4d6d', '#f9a8d4', '#c084fc', '#60a5fa', '#2dd4bf'],
      ['#e879f9', '#818cf8', '#67e8f9', '#bef264', '#fef08a'],
      ['#f472b6', '#fb7185', '#fdba74', '#a3e635', '#22d3ee'],
      ['#d946ef', '#6366f1', '#0ea5e9', '#10b981', '#eab308'],
      ['#ff6bcb', '#6c63ff', '#00e5ff', '#00ff85', '#fff176'],
    ];
  }

  _randomPaletteColor(palette, index, jitter = 0) {
    if (!Array.isArray(palette) || palette.length === 0) return '#ffffff';
    const base = palette[(index + jitter) % palette.length];
    return base || '#ffffff';
  }

  _applyRandomColorCombo(forcedCombos = null) {
    const sc = this.app.simulator.scenario;
    if (!sc || !Array.isArray(sc.objects) || sc.objects.length === 0) return;
    const combos = Array.isArray(forcedCombos) && forcedCombos.length ? forcedCombos : this._randomColorCombos();
    const palette = combos[(Math.random() * combos.length) | 0];
    let idx = 0;
    for (const obj of sc.objects) {
      if (!obj || typeof obj !== 'object') continue;
      if (obj.type === 'text' || obj.type === 'timer') {
        if (obj.color != null) obj.color = this._randomPaletteColor(palette, idx++, 0);
        if (this.app.running) this._syncLive(obj);
        continue;
      }
      if (obj.type === 'scoreBin') {
        obj.color = this._randomPaletteColor(palette, idx++, 0);
        obj.textColor = '#ffffff';
        if (this.app.running) this._syncLive(obj);
        continue;
      }
      if (obj.type === 'spawner') {
        obj.ballColor = this._randomPaletteColor(palette, idx++, 0);
        if (this.app.running) this._syncLive(obj);
        continue;
      }
      if ('color' in obj) {
        obj.color = this._randomPaletteColor(palette, idx++, 0);
      }
      if (Array.isArray(obj.gradientColors) && obj.gradientColors.length) {
        obj.gradientColors = palette.slice(0, Math.max(2, Math.min(5, obj.gradientColors.length)));
      }
      if (this.app.running) this._syncLive(obj);
    }
    if (this.app.running) {
      this._syncLiveBallColorsFromScenario();
    } else {
      this.app.simulator.rebuild();
    }
    this.refreshOutline();
    this.refreshPropertyPanel();
    this._commit();
  }

  _ballBehaviorPresetId(ball) {
    const current = String(ball && ball.ballBehaviorPreset || '');
    if (current && BALL_BEHAVIOR_PRESETS[current] && current !== 'custom') {
      const preset = BALL_BEHAVIOR_PRESETS[current];
      const matches = BALL_BEHAVIOR_PRESET_KEYS.every((key) =>
        Math.abs((ball[key] != null ? ball[key] : 0) - preset[key]) < 1e-6
      );
      if (matches) return current;
    }
    for (const [id, preset] of Object.entries(BALL_BEHAVIOR_PRESETS)) {
      if (id === 'custom') continue;
      const matches = BALL_BEHAVIOR_PRESET_KEYS.every((key) =>
        Math.abs((ball[key] != null ? ball[key] : 0) - preset[key]) < 1e-6
      );
      if (matches) return id;
    }
    return 'custom';
  }

  _applyBallBehaviorPreset(ball, presetId) {
    const preset = BALL_BEHAVIOR_PRESETS[presetId];
    if (!ball || !preset || presetId === 'custom') {
      if (ball) ball.ballBehaviorPreset = 'custom';
      return;
    }
    for (const key of BALL_BEHAVIOR_PRESET_KEYS) {
      ball[key] = preset[key];
    }
    ball.ballBehaviorPreset = presetId;
  }

  _syncBallBehaviorPreset(ball) {
    if (!ball || ball.type !== 'ball') return;
    ball.ballBehaviorPreset = this._ballBehaviorPresetId(ball);
  }

  // --- History shorthands ------------------------------------------------
  _commit()         { if (this.app.history) this.app.history.commit(); }
  _scheduleCommit() { if (this.app.history) this.app.history.scheduleCommit(); }
  _flushCommit()    { if (this.app.history) this.app.history.flush(); }

  // After setScenario() replaces the scene wholesale (preset / load / dup),
  // the EventEngine still holds the OLD rule set + fired-once flags. Re-sync
  // it so rules from the newly loaded scenario actually take effect.
  _afterScenarioSwitch(options = {}) {
    const clearSeedResults = options.clearSeedResults !== false;
    this._migrateLegacyScenarioFixes();
    this._normalizeTemplateSpawnRules();
    this._refreshActivePresetButton();
    const rules = (this.app.simulator.scenario && this.app.simulator.scenario.events) || [];
    if (this.app.events) this.app.events.setRules(rules);
    if (this.app.audio) {
      this.app.audio.setScenario(this.app.simulator.scenario);
      this.app.audio.resetTimelineState();
    }
    if (clearSeedResults) {
      this._seedListQueryKey = '';
      this._seedListNextOffset = 0;
      this._seedListMetricKey = 'ballsUsed';
      this._seedResults = [];
      this._seedResultIndex = -1;
    }
  }

  _refreshActivePresetButton() {
    const activeId = this._activePresetId || '';
    const idByPreset = {
      chaos: 'preset-escape',
      timed4: 'preset-timed',
      timed3: 'preset-timed3',
      'branch-maze-tower-a': 'preset-branch-maze-tower',
    };
    const activeButtonId = idByPreset[activeId] || (activeId ? `preset-${activeId}` : '');
    for (const btn of document.querySelectorAll('button.preset')) {
      const isActive = !!activeButtonId && btn.id === activeButtonId;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
  }

  _migrateLegacyScenarioFixes() {
    const sc = this.app.simulator && this.app.simulator.scenario;
    if (!sc || !Array.isArray(sc.objects)) return false;
    let changed = false;
    if (sc.name === '1 HP to Escape'
        || sc.name === 'Chaos Theory'
        || sc.name === 'Battle of the Colors'
        || /^One Chance Circle\b/.test(String(sc.name || ''))) {
      const outerRing = sc.objects
        .filter((o) => o && o.type === 'circle' && o.insideOnly !== false)
        .sort((a, b) => (Number(b.radius) || 0) - (Number(a.radius) || 0))[0];
      if (outerRing) {
        const currentGap = outerRing.onGapPass && typeof outerRing.onGapPass === 'object' ? outerRing.onGapPass : {};
        if (!currentGap.enabled || currentGap.outcome !== 'escape') {
          outerRing.onGapPass = window.defaultGapPassConfig
            ? window.defaultGapPassConfig({
                ...currentGap,
                enabled: true,
                outcome: 'escape',
                removeObjectOnPass: false,
              })
            : {
                enabled: true,
                outcome: 'escape',
                particleStyle: currentGap.particleStyle || 'auto',
                removeObjectOnPass: false,
                soundMode: currentGap.soundMode || 'none',
                soundPreset: currentGap.soundPreset || 'glass',
                soundAssetId: currentGap.soundAssetId || '',
                soundVolume: currentGap.soundVolume != null ? currentGap.soundVolume : 1,
              };
          changed = true;
        }
      }
    }
    return changed;
  }

  _normalizeTemplateSpawnRules() {
    const sc = this.app.simulator.scenario;
    if (!sc || !Array.isArray(sc.events) || !Array.isArray(sc.objects)) return;
    for (const rule of sc.events) {
      for (const action of this._getRuleActions(rule)) {
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
    this._afterScenarioSwitch({ clearSeedResults: false });
  }

  _replaceScenarioPreservingOverlay(sc, next) {
    const overlay = sc && sc.overlay ? JSON.parse(JSON.stringify(sc.overlay)) : null;
    for (const key of Object.keys(sc)) delete sc[key];
    Object.assign(sc, next);
    if (overlay) {
      sc.overlay = { ...(sc.overlay || {}), ...overlay };
    }
  }

  _applySeedToScenario(sc, seed) {
    if (!Array.isArray(sc.objects)) return false;

    if (sc.name === 'Spinner Storm') {
      const next = buildSpinnerStormScenario(seed);
      this._replaceScenarioPreservingOverlay(sc, next);
      return true;
    }

    if (sc.name === 'Last To Survive' || sc.name === '10 Ball vs 200 Spike') {
      const next = buildLegendSpikesScenario(seed);
      this._replaceScenarioPreservingOverlay(sc, next);
      return true;
    }

    if (sc.name === 'Giant Marble Gauntlet') {
      const next = buildGiantMarbleGauntletScenario(seed);
      this._replaceScenarioPreservingOverlay(sc, next);
      return true;
    }

    if (sc.name === 'Pyramid Plinko' || sc.name === 'Plinko Score Run') {
      const spawner = sc.objects.find((o) => o && o.type === 'spawner');
      if (spawner) {
        spawner.x = 540;
        spawner.ballVx = 0;
        return true;
      }
    }

    if (sc.name === 'Paasei Plinko') {
      const spawner = sc.objects.find((o) => o && o.type === 'spawner' && o.id === 'easter_spawner');
      if (spawner) {
        const seedRng = new SeededRNG(seed).fork(2026);
        const spawnX = 540 + seedRng.range(-110, 110);
        spawner.x = spawnX;
        spawner.ballVx = 0;
        const starters = sc.objects
          .filter((o) => o && o.type === 'ball' && /^easter_start_ball_\d+$/.test(String(o.id || '')))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        for (let i = 0; i < starters.length; i++) {
          const ball = starters[i];
          const x = spawnX + (i - 1) * 18;
          const y = 130 - i * 42;
          ball.x = x;
          ball.y = y;
          ball.spawnX = x;
          ball.spawnY = y;
          ball.vx = (i - 1) * 16;
          ball.vy = 110;
        }
        return true;
      }
    }

    if (sc.easterOrbitVariant) {
      const next = buildEggHuntOrbitScenario(seed);
      this._replaceScenarioPreservingOverlay(sc, next);
      return true;
    }

    if (sc.name === 'Memory Maze') {
      const ball = sc.objects.find((o) => o && o.type === 'ball' && o.id === 'ball_1');
      if (ball) {
        const seedRng = new SeededRNG(seed).fork(641);
        const launchAngle = -Math.PI / 2 + seedRng.range(-0.95, 0.95);
        const speed = Math.hypot(ball.vx || 0, ball.vy || 0) || 780;
        ball.vx = Math.cos(launchAngle) * speed;
        ball.vy = Math.sin(launchAngle) * speed;
        return true;
      }
    }

    if (sc.name === 'Rhythm Drop') {
      const spawner = sc.objects.find((o) => o && o.type === 'spawner' && o.id === 'rhythm_spawner');
      if (spawner) {
        const seedRng = new SeededRNG(seed).fork(775);
        const spawnX = 540 + seedRng.range(-80, 80);
        spawner.x = spawnX;
        spawner.ballVx = 0;
        const starters = sc.objects
          .filter((o) => o && o.type === 'ball' && /^rhythm_start_ball_\d+$/.test(String(o.id || '')))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        for (let i = 0; i < starters.length; i++) {
          const ball = starters[i];
          const x = spawnX + (i === 0 ? -14 : 14);
          const y = 132 - i * 36;
          ball.x = x;
          ball.y = y;
          ball.spawnX = x;
          ball.spawnY = y;
          ball.vx = i === 0 ? -12 : 12;
          ball.vy = 105;
        }
        return true;
      }
    }

    if (sc.name === 'Prediction Gates') {
      const ball = sc.objects.find((o) => o && o.type === 'ball' && o.id === 'ball_1');
      if (ball) {
        const seedRng = new SeededRNG(seed).fork(991);
        const launchAngle = -Math.PI / 2 + seedRng.range(-0.58, 0.58);
        const speed = Math.hypot(ball.vx || 0, ball.vy || 0) || 980;
        ball.vx = Math.cos(launchAngle) * speed;
        ball.vy = Math.sin(launchAngle) * speed;
        return true;
      }
    }

    if (sc.branchMazeVariant) {
      const rotationSpeed = Number(sc.branchMazeRotationSpeed) || 0;
      const next = buildBranchMazeScenario(seed, sc.branchMazeVariant);
      next.branchMazeRotationSpeed = rotationSpeed;
      for (const obj of next.objects || []) {
        if (!obj || !obj.branchMazeWall) continue;
        obj.mazeSpinSpeed = rotationSpeed;
      }
      this._replaceScenarioPreservingOverlay(sc, next);
      return true;
    }

    if (sc.oneChanceCircleVariant) {
      const next = buildOneChanceCircleScenario(seed, sc.oneChanceCircleVariant);
      this._replaceScenarioPreservingOverlay(sc, next);
      return true;
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

    if (sc.name === 'Burning Rings') {
      const ball = sc.objects.find((o) => o && o.type === 'ball' && o.id === 'ball_1');
      if (ball) {
        const seedRng = new SeededRNG(seed).fork(881);
        const angle = -Math.PI / 2 + seedRng.range(-0.22, 0.22);
        const speed = Math.hypot(ball.vx || 0, ball.vy || 0) || 720;
        ball.vx = Math.cos(angle) * speed;
        ball.vy = Math.sin(angle) * speed;
        const ringThickness = 10;
        const ballRadius = ball.radius || 28;
        const targetUsableGap = 0.62;
        const rings = sc.objects
          .filter((o) => o && o.type === 'circle' && /^burn_ring_\d+$/.test(String(o.id || '')))
          .sort((a, b) => (a.radius || 0) - (b.radius || 0));
        for (let i = 0; i < rings.length; i++) {
          const ring = rings[i];
          const clearanceRadius = Math.max(1, (ring.radius || 0) - ringThickness * 0.5);
          const ratio = Math.max(0, Math.min(0.999999, ballRadius / clearanceRadius));
          const angularPad = Math.asin(ratio);
          const gapSize = Math.min(Math.PI * 1.35, targetUsableGap + angularPad * 2);
          const gapCenterAtT0 = seedRng.range(-Math.PI, Math.PI);
          ring.gapSize = gapSize;
          ring.gapStart = gapCenterAtT0 - gapSize / 2;
        }
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
      this._getRuleActions(r).some((action) => action.type === 'spawnBall' && action.templateId === 'ball_1')
    );
    if (!tpl) return false;

    // Timed one-ball-at-a-time preset: preserve user edits (radius, spawn
    // point, trail, etc.) and only refresh the seed-driven launch DIRECTION.
    const hasTimedCycle = Array.isArray(sc.events) && sc.events.some((r) => {
      if (!r || !r.trigger || r.trigger.type !== 'everySeconds') return false;
      const actions = this._getRuleActions(r);
      return actions.some((action) => action.type === 'freezeBall')
        && actions.some((action) => action.type === 'spawnBall' && action.templateId === 'ball_1');
    });

    if (hasTimedCycle) {
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

    if (sc.name === '1 HP to Escape') {
      const outerRing = sc.objects
        .filter((o) => o && o.type === 'circle' && o.insideOnly !== false)
        .sort((a, b) => (Number(b.radius) || 0) - (Number(a.radius) || 0))[0];
      if (outerRing) {
        const currentGap = outerRing.onGapPass && typeof outerRing.onGapPass === 'object' ? outerRing.onGapPass : {};
        outerRing.onGapPass = window.defaultGapPassConfig
          ? window.defaultGapPassConfig({
              ...currentGap,
              enabled: true,
              outcome: 'escape',
              removeObjectOnPass: false,
            })
          : {
              enabled: true,
              outcome: 'escape',
              particleStyle: currentGap.particleStyle || 'auto',
              removeObjectOnPass: false,
              soundMode: currentGap.soundMode || 'none',
              soundPreset: currentGap.soundPreset || 'glass',
              soundAssetId: currentGap.soundAssetId || '',
              soundVolume: currentGap.soundVolume != null ? currentGap.soundVolume : 1,
            };
      }
    }

    const seedRng = new SeededRNG(seed).fork(101);
    const launchAngle = seedRng.angle();
    const speed = Math.hypot(tpl.vx || 0, tpl.vy || 0) || 300;
    tpl.vx = Math.cos(launchAngle) * speed;
    tpl.vy = Math.sin(launchAngle) * speed;
    if (tpl.wallCurve == null) tpl.wallCurve = 0.7;
    if (tpl.bounce == null) tpl.bounce = 0.95;
    return true;
  }

  _analyzeSeed(seed, options = {}) {
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
    const metricKey = options && options.metricKey ? String(options.metricKey) : '';
    const metricMax = Number(options && options.metricMax);
    const fallbackSec = sim.scenario.satisfying
      ? (sim.scenario.loopDuration || 10)
      : (sim.scenario.duration || 12);
    const stepLimitFor = (seconds) => Math.ceil(Math.max(0.1, seconds) / dt);
    const analysisBudgetSec = (() => {
      const tail = ec && ec.tail != null ? Math.max(0, Number(ec.tail) || 0) : 0;
      if (metricKey === 'endSeconds' && Number.isFinite(metricMax) && metricMax > 0) {
        return Math.max(
          metricMax + tail,
          fallbackSec,
        );
      }
      if (!ec || ec.type === 'loopDuration') return sim.scenario.loopDuration || fallbackSec;
      if (ec.type === 'fixed') return ec.seconds || fallbackSec;
      if (ec.type === 'finish') return Math.max(fallbackSec, 20);
      if (ec.type === 'firstEscapeTail') {
        return Math.max(fallbackSec, tail + fallbackSec);
      }
      if (ec.type === 'allBallsGone' || ec.type === 'ballCountTail' || ec.type === 'bucketHitTail') {
        return Math.max(fallbackSec, 20);
      }
      return fallbackSec;
    })();
    const stepBudget = stepLimitFor(analysisBudgetSec);
    const fixedSteps = stepLimitFor(fallbackSec);
    const tailSteps = stepLimitFor(ec && ec.tail != null ? ec.tail : 1.0);

    let firstEscapeAt = -1;
    let allGoneAt = -1;
    let ballCountAt = -1;
    let bucketHitAt = -1;
    let finishAt = -1;
    let finishTailSteps = 0;
    let finishElapsedSec = NaN;
    let finishTailSec = 0;
    let pauseAt = -1;
    let liveStopElapsed = null;
    let seenAlive = false;
    let completed = false;
    let ballCollisionCount = 0;
    let circleBounceCount = 0;
    let melodyHitCount = 0;
    let freezeCount = 0;
    let spawnCount = 0;
    let peakActiveBalls = 0;
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
    const outerRing = sim.scenario.objects
      .filter((o) => o && o.type === 'circle' && o.insideOnly !== false)
      .sort((a, b) => (Number(b.radius) || 0) - (Number(a.radius) || 0))[0] || null;
    const templateBall = sim.scenario.objects.find((o) => o && o.type === 'ball' && o.id === 'ball_1') || null;
    const initialStateBall = sim.state.objects.find((o) => o && o.type === 'ball' && o.id === 'ball_1') || null;
    const arena = sim.scenario.objects.find((o) => o.type === 'circle')
      || sim.scenario.objects.find((o) => o.x != null && o.y != null)
      || { x: 540, y: 960 };
    const cx = arena.x != null ? arena.x : 540;
    const cy = arena.y != null ? arena.y : 960;

    const ballIds = new Set(
      sim.state.objects.filter((o) => o.type === 'ball' && !o.fixed).map((o) => o.id)
    );

    for (let step = 0; step < stepBudget; step++) {
      sim.step(dt);
      const evs = sim.lastEvents();
      events.update(sim.state, evs);
      for (const ev of evs) {
        if (ev.type === 'bounce' && ev.source === 'ballBall') ballCollisionCount++;
        if (ev.type === 'bounce' && ev.source === 'circle') {
          circleBounceCount++;
        }
        if (ev.type === 'freeze') freezeCount++;
        if (ev.type === 'spawn') spawnCount++;
        if (ev.type === 'bounce' && melodySources.includes(ev.source)) {
          melodyHitCount++;
        }
        if (ec && ec.type === 'bucketHitTail' && bucketHitAt < 0 && ev.type === 'score') {
          if (!ec.bucketId || ev.bucketId === ec.bucketId) bucketHitAt = step;
        }
        if (finishAt < 0 && ev.type === 'finish') {
          finishAt = step;
          finishElapsedSec = Number.isFinite(Number(ev.at))
            ? Math.max(0, Number(ev.at))
            : (sim.state.elapsedTime != null ? sim.state.elapsedTime : sim.state.time);
          finishTailSec = Math.max(0, Number(ev.tail) || 0);
          finishTailSteps = stepLimitFor(finishTailSec);
        }
      }
      if (finishAt < 0 && sim.state && sim.state._finished) {
        finishAt = step;
        finishElapsedSec = sim.state.elapsedTime != null ? sim.state.elapsedTime : sim.state.time;
        finishTailSec = Math.max(0, Number(sim.state._finishTail) || 0);
        finishTailSteps = stepLimitFor(finishTailSec);
      }

      for (const o of sim.state.objects) {
        if (o.type === 'ball' && !o.fixed) ballIds.add(o.id);
        if (o.type === 'ball' && o.alive && !o._escaped && !o._frozen && !o.fixed) {
          if (o.x < minX) minX = o.x;
          if (o.x > maxX) maxX = o.x;
          if (o.y < minY) minY = o.y;
          if (o.y > maxY) maxY = o.y;
          const a = Math.atan2(o.y - cy, o.x - cx);
          const bin = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 16);
          angleBins.add(Math.max(0, Math.min(15, bin)));
        }
      }

      const alive = sim.state.objects.filter((o) =>
        o.type === 'ball' && o.alive && !o._escaped && !o._frozen && !o.fixed
      ).length;
      if (alive > peakActiveBalls) peakActiveBalls = alive;
      if (alive > 0) seenAlive = true;
      if (firstEscapeAt < 0 && evs.some((e) => e.type === 'escape')) firstEscapeAt = step;
      if (seenAlive && alive === 0 && allGoneAt < 0) allGoneAt = step;
      if (ec && ec.type === 'ballCountTail' && alive <= Math.max(0, ec.count | 0) && ballCountAt < 0) {
        ballCountAt = step;
      }

      const escapedThisTick = evs.some((e) => e.type === 'escape');
      const bucketHitThisTick = !!(ec && ec.type === 'bucketHitTail' && evs.some((e) =>
        e.type === 'score' && String(e.bucketId || '') === String(ec.bucketId || '')
      ));
      const liveStopThisTick =
        paused ||
        finishAt >= 0 ||
        (sim.scenario.stopOnFirstEscape && escapedThisTick) ||
        bucketHitThisTick ||
        (!!(ec && ec.type === 'ballCountTail') && alive <= Math.max(0, ec.count | 0)) ||
        (!!(ec && ec.type === 'allBallsGone') && alive === 0);
      if (liveStopElapsed == null && liveStopThisTick) {
        liveStopElapsed = sim.state.elapsedTime != null ? sim.state.elapsedTime : sim.state.time;
      }

      // For seed finding, `endSeconds` should reflect the full authored finish
      // timing (e.g. firstEscapeTail) rather than the earlier live-play pause
      // moment. That makes "End seconds" line up with the full ending beat the
      // user is designing, not just the instant the win condition first lands.

      if (paused) {
        if (pauseAt < 0) pauseAt = step;
        completed = true; break;
      }

      if (finishAt >= 0 && (step - finishAt) >= finishTailSteps) {
        completed = true; break;
      } else if (!ec || ec.type === 'loopDuration') {
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
      } else if (ec.type === 'finish') {
        // Finish-driven scenarios must wait for the finish event. Do not fall
        // back to the short authored duration, which is often just UI loop time.
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
    const hasLiveFinishSignal =
      finishAt >= 0 ||
      firstEscapeAt >= 0 ||
      allGoneAt >= 0 ||
      ballCountAt >= 0 ||
      bucketHitAt >= 0 ||
      pauseAt >= 0;
    const goalReached = finishAt >= 0
      ? true
      : (sim.scenario.stopOnFirstEscape)
      ? firstEscapeAt >= 0 || pauseAt >= 0
      : (ec && ec.type === 'finish')
        ? finishAt >= 0
      : (ec && ec.type === 'firstEscapeTail')
        ? firstEscapeAt >= 0
        : (ec && ec.type === 'allBallsGone')
          ? allGoneAt >= 0
          : (ec && ec.type === 'ballCountTail')
            ? ballCountAt >= 0
            : (ec && ec.type === 'bucketHitTail')
              ? bucketHitAt >= 0
              : (ec && (ec.type === 'fixed' || ec.type === 'loopDuration'))
                ? completed
                : completed;
    const resolvedEndSeconds = Number.isFinite(finishElapsedSec)
      ? (finishElapsedSec + finishTailSec)
      : (sim.state.elapsedTime != null ? sim.state.elapsedTime : sim.state.time);
    const endSeconds = goalReached ? resolvedEndSeconds : NaN;
    const debug = {
      metricKey,
      metricMax: Number.isFinite(metricMax) ? metricMax : null,
      scenarioName: sim.scenario && sim.scenario.name ? sim.scenario.name : '',
      stopOnFirstEscape: !!sim.scenario.stopOnFirstEscape,
      endConditionType: ec && ec.type ? ec.type : null,
      endConditionTail: ec && ec.tail != null ? ec.tail : null,
      finishAt: Number.isFinite(finishElapsedSec) ? Number(finishElapsedSec.toFixed(3)) : null,
      finishTail: Number(finishTailSec.toFixed(3)),
      outerRing: outerRing ? {
        id: outerRing.id || null,
        radius: outerRing.radius != null ? Number(outerRing.radius) : null,
        gapStart: outerRing.gapStart != null ? Number(outerRing.gapStart) : null,
        gapSize: outerRing.gapSize != null ? Number(outerRing.gapSize) : null,
        rotationSpeed: outerRing.rotationSpeed != null ? Number(outerRing.rotationSpeed) : null,
        onGapPassEnabled: !!(outerRing.onGapPass && outerRing.onGapPass.enabled),
      } : null,
      templateBall: templateBall ? {
        x: templateBall.x != null ? Number(templateBall.x) : null,
        y: templateBall.y != null ? Number(templateBall.y) : null,
        vx: templateBall.vx != null ? Number(templateBall.vx) : null,
        vy: templateBall.vy != null ? Number(templateBall.vy) : null,
        radius: templateBall.radius != null ? Number(templateBall.radius) : null,
        randomInitDir: !!templateBall.randomInitDir,
        freezeOnSpike: !!templateBall.freezeOnSpike,
      } : null,
      initialStateBall: initialStateBall ? {
        x: initialStateBall.x != null ? Number(initialStateBall.x) : null,
        y: initialStateBall.y != null ? Number(initialStateBall.y) : null,
        vx: initialStateBall.vx != null ? Number(initialStateBall.vx) : null,
        vy: initialStateBall.vy != null ? Number(initialStateBall.vy) : null,
        radius: initialStateBall.radius != null ? Number(initialStateBall.radius) : null,
        randomInitDir: !!initialStateBall.randomInitDir,
        freezeOnSpike: !!initialStateBall.freezeOnSpike,
      } : null,
      fallbackSec,
      analysisBudgetSec,
      stepBudget,
      firstEscapeAtSec: firstEscapeAt >= 0 ? Number(((firstEscapeAt + 1) * dt).toFixed(3)) : null,
      allGoneAtSec: allGoneAt >= 0 ? Number(((allGoneAt + 1) * dt).toFixed(3)) : null,
      ballCountAtSec: ballCountAt >= 0 ? Number(((ballCountAt + 1) * dt).toFixed(3)) : null,
      bucketHitAtSec: bucketHitAt >= 0 ? Number(((bucketHitAt + 1) * dt).toFixed(3)) : null,
      pauseAtSec: pauseAt >= 0 ? Number(((pauseAt + 1) * dt).toFixed(3)) : null,
      liveStopElapsed: liveStopElapsed != null ? Number(liveStopElapsed.toFixed(3)) : null,
      resolvedEndSeconds: Number.isFinite(resolvedEndSeconds) ? Number(resolvedEndSeconds.toFixed(3)) : null,
      freezeCount,
      spawnCount,
      timedOut: !goalReached && !!timedOut,
      escaped: firstEscapeAt >= 0,
      rejectReason: (() => {
        if (goalReached) return 'goal_reached';
        if (timedOut && firstEscapeAt < 0) return 'timed_out_without_escape';
        if (timedOut) return 'timed_out_before_finish_tail';
        if (sim.scenario.stopOnFirstEscape && pauseAt < 0 && firstEscapeAt < 0) return 'stop_on_escape_never_triggered';
        if (ec && ec.type === 'finish' && finishAt < 0) return 'finish_never_triggered';
        if (ec && ec.type === 'ballCountTail' && ballCountAt < 0) return 'ball_count_tail_never_triggered';
        if (ec && ec.type === 'allBallsGone' && allGoneAt < 0) return 'all_balls_gone_never_triggered';
        if (ec && ec.type === 'bucketHitTail' && bucketHitAt < 0) return 'bucket_hit_tail_never_triggered';
        return 'goal_not_reached';
      })(),
    };

    return {
      seed,
      ballsUsed: ballIds.size,
      peakActiveBalls,
      endSeconds,
      endSecondsGoalReached: goalReached,
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
      debug,
    };
  }

  _getSeedSearchStart() {
    const el = document.getElementById('seed-find-start');
    const fallback = 0;
    if (!el) return fallback;
    const raw = String(el.value || '').trim();
    if (!raw) return fallback;
    return /^-?\d+$/.test(raw) ? parseInt(raw, 10) : (Number.isFinite(Number(raw)) ? parseInt(raw, 10) : 0);
  }

  _getSeedSearchEnd(startSeed, defaultSpan = 2000) {
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
      peakActiveBalls: { label: 'peak balls', decimals: 0 },
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
    if (metricKey === 'endSeconds') {
      const v = res && res.endSeconds;
      return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
    }
    const v = res && res[metricKey];
    return Number.isFinite(v) ? v : 0;
  }

  _formatSeedMetricValue(res, metricKey) {
    const cfg = this._getSeedMetricConfig()[metricKey] || { label: metricKey, decimals: 0 };
    if (metricKey === 'endSeconds') {
      const raw = res && res.endSeconds;
      if (!Number.isFinite(raw)) return `-- ${cfg.label}`;
    }
    const v = this._getSeedMetricValue(res, metricKey);
    return `${v.toFixed(cfg.decimals || 0)} ${cfg.label}`;
  }

  async _findSeedByBallCount() {
    return this._findSeedListByBallCount();
  }

  _currentSeedResultSeed() {
    if (this._seedResultIndex < 0 || this._seedResultIndex >= this._seedResults.length) return null;
    const res = this._seedResults[this._seedResultIndex];
    return res && res.seed != null ? res.seed : null;
  }

  _compareSeedResults(a, b, mode = this._seedResultsSortKey || 'match') {
    const metricKey = this._seedListMetricKey || this._getSeedMetricKey();
    const numericCompare = (key, dir = 'asc') => {
      const av = key === 'seed' ? Number(a && a.seed) || 0 : this._getSeedMetricValue(a, key);
      const bv = key === 'seed' ? Number(b && b.seed) || 0 : this._getSeedMetricValue(b, key);
      if (av !== bv) return dir === 'asc' ? av - bv : bv - av;
      return (Number(a && a.seed) || 0) - (Number(b && b.seed) || 0);
    };
    switch (mode) {
      case 'seedAsc': return numericCompare('seed', 'asc');
      case 'seedDesc': return numericCompare('seed', 'desc');
      case 'endSecondsAsc': return numericCompare('endSeconds', 'asc');
      case 'endSecondsDesc': return numericCompare('endSeconds', 'desc');
      case 'ballsUsedDesc': return numericCompare('ballsUsed', 'desc');
      case 'peakActiveBallsDesc': return numericCompare('peakActiveBalls', 'desc');
      case 'ballCollisionCountDesc': return numericCompare('ballCollisionCount', 'desc');
      case 'circleBounceCountDesc': return numericCompare('circleBounceCount', 'desc');
      case 'melodyHitCountDesc': return numericCompare('melodyHitCount', 'desc');
      case 'spreadScoreDesc': return numericCompare('spreadScore', 'desc');
      case 'match':
      default: {
        const minEl = document.getElementById('seed-find-min');
        const maxEl = document.getElementById('seed-find-max');
        let min = parseFloat(minEl && minEl.value);
        let max = parseFloat(maxEl && maxEl.value);
        const av = this._getSeedMetricValue(a, metricKey);
        const bv = this._getSeedMetricValue(b, metricKey);
        if (!Number.isFinite(min)) min = av;
        if (!Number.isFinite(max)) max = bv;
        if (min > max) [min, max] = [max, min];
        if (metricKey === 'endSeconds') {
          const ad = Math.abs(av - max);
          const bd = Math.abs(bv - max);
          if (ad !== bd) return ad - bd;
          if (av !== bv) return bv - av;
          return (Number(a && a.seed) || 0) - (Number(b && b.seed) || 0);
        }
        const targetCenter = (min + max) * 0.5;
        const ad = Math.abs(av - targetCenter);
        const bd = Math.abs(bv - targetCenter);
        if (ad !== bd) return ad - bd;
        if (!!(a && a.escaped) !== !!(b && b.escaped)) return a.escaped ? -1 : 1;
        if (metricKey === 'spreadScore' || metricKey === 'widthSpan' || metricKey === 'heightSpan') {
          if (bv !== av) return bv - av;
        }
        if (av !== bv) return av - bv;
        if (((b && b.spreadScore) || 0) !== ((a && a.spreadScore) || 0)) {
          return ((b && b.spreadScore) || 0) - ((a && a.spreadScore) || 0);
        }
        return (Number(a && a.seed) || 0) - (Number(b && b.seed) || 0);
      }
    }
  }

  _seedResultSummary(res) {
    if (!res) return '';
    const end = this._formatSeedMetricValue(res, 'endSeconds');
    const used = this._formatSeedMetricValue(res, 'ballsUsed');
    const peak = this._formatSeedMetricValue(res, 'peakActiveBalls');
    const ballColls = this._formatSeedMetricValue(res, 'ballCollisionCount');
    const circleHits = this._formatSeedMetricValue(res, 'circleBounceCount');
    return `${end} | ${used} used | ${peak} | ${ballColls} | ${circleHits}`;
  }

  _setSeedResults(results, preferredSeed = null, options = {}) {
    const preserveSelection = options && options.preserveSelection !== false;
    const prevSeed = preferredSeed != null
      ? preferredSeed
      : (preserveSelection ? this._currentSeedResultSeed() : null);
    this._seedResults = Array.isArray(results) ? results.slice() : [];
    this._seedResults.sort((a, b) => this._compareSeedResults(a, b));
    if (this._seedResults.length === 0) {
      this._seedResultIndex = -1;
      return;
    }
    const preservedIndex = prevSeed != null
      ? this._seedResults.findIndex((res) => res && res.seed === prevSeed)
      : -1;
    if (preservedIndex >= 0) {
      this._seedResultIndex = preservedIndex;
      return;
    }
    if (this._seedResultIndex < 0 || this._seedResultIndex >= this._seedResults.length) {
      this._seedResultIndex = 0;
    }
  }

  _refreshSeedResultsUI() {
    const select = document.getElementById('seed-results');
    const actions = document.getElementById('seed-result-actions');
    const prevBtn = document.getElementById('btn-seed-prev');
    const nextBtn = document.getElementById('btn-seed-next');
    const toggleBtn = document.getElementById('btn-seed-results-toggle');
    const sortSelect = document.getElementById('seed-results-sort');
    if (!select) return;
    if (sortSelect) sortSelect.value = this._seedResultsSortKey || 'match';

    select.innerHTML = '';
    if (actions) actions.innerHTML = '';
    if (this._seedResults.length === 0) {
      select.size = 1;
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = this._seedSearchRunning ? 'Searching...' : 'No seed list yet';
      select.appendChild(opt);
      select.size = 1;
      select.disabled = true;
      if (actions) actions.style.display = 'none';
      if (toggleBtn) {
        toggleBtn.disabled = true;
        toggleBtn.textContent = '▾';
        toggleBtn.title = 'Expand seed list';
      }
      if (sortSelect) sortSelect.disabled = true;
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }

    if (this._seedResultIndex < 0 || this._seedResultIndex >= this._seedResults.length) {
      this._seedResultIndex = 0;
    }
    const metricKey = this._seedListMetricKey || 'ballsUsed';
    for (let i = 0; i < this._seedResults.length; i++) {
      const res = this._seedResults[i];
      const opt = document.createElement('option');
      opt.value = String(res.seed);
      const state = res.escaped ? 'escape' : (res.goalReached ? 'done' : 'no finish');
      opt.textContent = `${i + 1}. ${res.seed} | ${this._seedResultSummary(res)} | ${state}`;
      if (i === this._seedResultIndex) opt.selected = true;
      select.appendChild(opt);
    }
    select.size = this._seedResultsExpanded ? Math.min(12, Math.max(2, this._seedResults.length)) : 1;
    select.selectedIndex = this._seedResultIndex;
    select.disabled = false;
    if (sortSelect) sortSelect.disabled = false;
    if (toggleBtn) {
      toggleBtn.disabled = this._seedResults.length <= 1;
      toggleBtn.textContent = this._seedResultsExpanded ? '▴' : '▾';
      toggleBtn.title = this._seedResultsExpanded ? 'Collapse seed list' : 'Expand seed list';
    }
    if (actions) {
      const selected = this._seedResults[this._seedResultIndex];
      const meta = document.createElement('span');
      meta.className = 'seed-result-meta';
      meta.textContent = this._seedSearchRunning
        ? `${this._seedResults.length} live match${this._seedResults.length === 1 ? '' : 'es'}`
        : `${this._seedResults.length} match${this._seedResults.length === 1 ? '' : 'es'}`;
      actions.appendChild(meta);
      if (selected) {
        const summary = document.createElement('span');
        summary.className = 'seed-result-meta';
        summary.textContent = this._seedResultSummary(selected);
        actions.appendChild(summary);
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.textContent = `Load ${selected.seed}`;
        apply.addEventListener('click', () => this._applySeedResultIndex(this._seedResultIndex));
        const play = document.createElement('button');
        play.type = 'button';
        play.textContent = 'Play';
        play.addEventListener('click', () => this._playSeedResultIndex(this._seedResultIndex));
        actions.appendChild(apply);
        actions.appendChild(play);
      }
      actions.style.display = '';
    }
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

  _pushSeedSearchDebug(entry) {
    if (typeof window === 'undefined') return;
    if (!Array.isArray(window.__seedSearchDebugLogs)) window.__seedSearchDebugLogs = [];
    window.__seedSearchDebugLogs.push(entry);
    const maxLogs = 2000;
    if (window.__seedSearchDebugLogs.length > maxLogs) {
      window.__seedSearchDebugLogs.splice(0, window.__seedSearchDebugLogs.length - maxLogs);
    }
    if (typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info('[seed-search]', entry);
    }
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
    const rawStartSeed = this._getSeedSearchStart();
    const rawEndSeed = this._getSeedSearchEnd(rawStartSeed, 2000);
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
      if (typeof window !== 'undefined') window.__seedSearchDebugLogs = [];
      this._pushSeedSearchDebug({
        phase: 'search-start',
        preset: this._activePresetId || null,
        scenarioName: sc.name || '',
        metricKey,
        min,
        max,
        startSeed,
        endSeed,
        scenarioSeed: sc.seed || 0,
      });
      const matches = [];
      const maxMatches = 500;
      const rejectCounts = {};
      this._seedListNextOffset = 0;
      for (let seed = startSeed; seed <= endSeed; seed++) {
        if (this._seedSearchCancelRequested) break;

        const res = this._analyzeSeed(seed, { metricKey, metricMax: max });
        const metricValue = this._getSeedMetricValue(res, metricKey);
        const metricReached = metricKey === 'endSeconds'
          ? !!res.endSecondsGoalReached
          : res.goalReached;
        const isMatch = metricReached && metricValue >= min && metricValue <= max;
        const rejectReason = isMatch
          ? 'match'
          : (!metricReached
              ? ((res && res.debug && res.debug.rejectReason) || 'goal_not_reached')
              : 'metric_out_of_range');
        rejectCounts[rejectReason] = (rejectCounts[rejectReason] || 0) + 1;
        if (isMatch) {
          matches.push(res);
          matches.sort((a, b) => this._compareSeedResults(a, b));
          if (matches.length > maxMatches) matches.length = maxMatches;
          this._setSeedResults(matches, null, { preserveSelection: false });
          this._refreshSeedResultsUI();
          const dbg = res.debug || {};
          this._pushSeedSearchDebug({
            phase: 'match',
            seed,
            metricKey,
            metricValue,
            endSeconds: Number.isFinite(res.endSeconds) ? Number(res.endSeconds.toFixed(3)) : null,
            goalReached: !!res.goalReached,
            escaped: !!res.escaped,
            analysisBudgetSec: dbg.analysisBudgetSec != null ? dbg.analysisBudgetSec : null,
            firstEscapeAtSec: dbg.firstEscapeAtSec != null ? dbg.firstEscapeAtSec : null,
            pauseAtSec: dbg.pauseAtSec != null ? dbg.pauseAtSec : null,
            freezeCount: dbg.freezeCount != null ? dbg.freezeCount : null,
            spawnCount: dbg.spawnCount != null ? dbg.spawnCount : null,
            outerRingOnGapPassEnabled: dbg.outerRing && dbg.outerRing.onGapPassEnabled,
            outerRingGapSize: dbg.outerRing && dbg.outerRing.gapSize != null ? dbg.outerRing.gapSize : null,
            outerRingRotationSpeed: dbg.outerRing && dbg.outerRing.rotationSpeed != null ? dbg.outerRing.rotationSpeed : null,
            templateBallRandomInitDir: dbg.templateBall && !!dbg.templateBall.randomInitDir,
            templateBallSpeed: dbg.templateBall
              ? Number(Math.hypot(dbg.templateBall.vx || 0, dbg.templateBall.vy || 0).toFixed(3))
              : null,
            debug: res.debug || null,
          });
        } else if (seed - startSeed < 12) {
          const dbg = res.debug || {};
          this._pushSeedSearchDebug({
            phase: 'reject-sample',
            seed,
            metricKey,
            metricValue: Number.isFinite(metricValue) ? metricValue : null,
            metricReached,
            rejectReason,
            endSeconds: Number.isFinite(res.endSeconds) ? Number(res.endSeconds.toFixed(3)) : null,
            goalReached: !!res.goalReached,
            escaped: !!res.escaped,
            analysisBudgetSec: dbg.analysisBudgetSec != null ? dbg.analysisBudgetSec : null,
            firstEscapeAtSec: dbg.firstEscapeAtSec != null ? dbg.firstEscapeAtSec : null,
            pauseAtSec: dbg.pauseAtSec != null ? dbg.pauseAtSec : null,
            freezeCount: dbg.freezeCount != null ? dbg.freezeCount : null,
            spawnCount: dbg.spawnCount != null ? dbg.spawnCount : null,
            outerRingOnGapPassEnabled: dbg.outerRing && dbg.outerRing.onGapPassEnabled,
            outerRingGapSize: dbg.outerRing && dbg.outerRing.gapSize != null ? dbg.outerRing.gapSize : null,
            outerRingRotationSpeed: dbg.outerRing && dbg.outerRing.rotationSpeed != null ? dbg.outerRing.rotationSpeed : null,
            templateBallRandomInitDir: dbg.templateBall && !!dbg.templateBall.randomInitDir,
            templateBallSpeed: dbg.templateBall
              ? Number(Math.hypot(dbg.templateBall.vx || 0, dbg.templateBall.vy || 0).toFixed(3))
              : null,
            debug: res.debug || null,
          });
        }

        const scannedOffset = seed - startSeed;
        if (scannedOffset % 25 === 0) {
          if (matches.length > 0) {
            this._setSeedResults(matches, null, { preserveSelection: false });
            this._refreshSeedResultsUI();
          }
          this._pushSeedSearchDebug({
            phase: 'progress',
            scanned: scannedOffset + 1,
            currentSeed: seed,
            matches: matches.length,
            rejectCounts: { ...rejectCounts },
          });
          btn.textContent = `🔎 ${matches.length} / ${seed}`;
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      this._seedListNextOffset = 0;
      if (matches.length > 0 || !this._seedSearchCancelRequested) {
        this._setSeedResults(matches, null, { preserveSelection: false });
      } else {
        this._setSeedResults(previousResults, previousIndex >= 0 && previousResults[previousIndex] ? previousResults[previousIndex].seed : null);
      }
      // Keep the live list visible after the scan finishes; applying a result
      // should be an explicit user action, not an automatic scene change.
      this._refreshSeedResultsUI();
      this._pushSeedSearchDebug({
        phase: 'search-end',
        cancelled: !!this._seedSearchCancelRequested,
        matches: matches.length,
        rejectCounts: { ...rejectCounts },
      });

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
        actions: [{ type: 'text', text: 'FINISH!', seconds: 2.5 }],
        once: true,
      });
    }
    if (mode === 'random' || mode === 'both') {
      sc.events.push({
        id: this._newRuleId('finish_fx'),
        trigger: { ...trigger },
        actions: [this._makeRandomFinishAction()],
        once: true,
      });
    }

    this.app.events.setRules(sc.events);
    this.refreshEvents();
    this._commit();
  }

  refreshAll() {
    if (this._migrateLegacyScenarioFixes()) {
      this.app.simulator.rebuild();
      if (this.app.events) this.app.events.setRules(this.app.simulator.scenario.events || []);
      if (this.app.audio) {
        this.app.audio.setScenario(this.app.simulator.scenario);
        this.app.audio.resetTimelineState();
      }
    }
    this.refreshTopBar();
    this.refreshOutline();
    this.refreshPropertyPanel();
    this.refreshScenarioPanel();
    this.refreshEvents();
    this.refreshMelodyPanel();
    this._updateSatisfyingClass();
    this._refreshActivePresetButton();
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
    for (let i = 0; i < rules.length; i++) {
      list.appendChild(this._makeEventRuleCard(rules[i], i, rules.length));
    }
  }

  _deriveSystemEventCards() {
    const sc = this.app.simulator.scenario || {};
    const cards = [];
    if (sc.endCondition) cards.push({ kind: 'endCondition', ec: sc.endCondition });
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
      else if (rule.kind === 'liveStop') sc.stopOnFirstEscape = false;
      this._refreshSystemRulesAfterEdit();
    });
    badgeRow.appendChild(remove);
    card.appendChild(badgeRow);
    if (rule.kind === 'endCondition') this._fillSystemEndConditionCard(card, rule.ec);
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
      { value: 'finish', label: 'On finish' },
      { value: 'firstEscapeTail', label: 'First ball escapes' },
      { value: 'allBallsGone', label: 'All active balls are gone' },
      { value: 'ballCountTail', label: 'Active ball count drops to N' },
      { value: 'bucketHitTail', label: 'Specific bucket is hit' },
    ], endCondition.type || 'loopDuration', (value) => {
      const next = { type: value };
      if (value === 'fixed') next.seconds = Number(sc.duration) || Number(sc.loopDuration) || 20;
      if (value === 'finish') sc.stopOnFirstEscape = false;
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

  _getRuleActions(rule) {
    if (!rule) return [];
    if (Array.isArray(rule.actions)) {
      const actions = rule.actions.filter((action) => action && typeof action === 'object');
      if (actions.length) return actions;
    }
    if (rule.action && typeof rule.action === 'object') return [rule.action];
    return [];
  }

  _defaultRuleAction(type = 'confetti') {
    if (type === 'finish') return { type: 'finish', seconds: 1.5 };
    return { type };
  }

  _normalizeRuleActions(rule) {
    if (!rule) return [];
    const actions = this._getRuleActions(rule);
    rule.actions = actions.length ? actions : [this._defaultRuleAction('confetti')];
    for (const action of rule.actions) {
      if (!action || typeof action !== 'object') continue;
      if (action.type === 'finish' && action.seconds == null) action.seconds = 1.5;
    }
    // Keep legacy `action` aligned with the first entry for older code paths.
    rule.action = rule.actions[0];
    return rule.actions;
  }

  _moveArrayItem(arr, fromIndex, toIndex) {
    if (!Array.isArray(arr)) return false;
    const len = arr.length;
    if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex > len) return false;
    const [item] = arr.splice(fromIndex, 1);
    const insertAt = Math.max(0, Math.min(arr.length, toIndex));
    if (fromIndex === insertAt) {
      arr.splice(fromIndex, 0, item);
      return false;
    }
    arr.splice(insertAt, 0, item);
    return true;
  }

  _dropInsertIndex(ev, length, targetIndex) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const after = ev.clientY > rect.top + rect.height * 0.5;
    return Math.max(0, Math.min(length, targetIndex + (after ? 1 : 0)));
  }

  _makeDragHandle(title) {
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '::';
    handle.title = title;
    return handle;
  }

  _makeRuleActionEditor(rule, action, index, total) {
    const wrap = document.createElement('div');
    wrap.className = 'event-action-block';
    wrap.draggable = total > 1;
    wrap.dataset.actionIndex = String(index);
    wrap.dataset.ruleId = String(rule.id || '');
    if (total > 1) {
      wrap.addEventListener('dragstart', (ev) => {
        this._dragEventAction = { ruleId: String(rule.id || ''), index };
        wrap.classList.add('is-dragging');
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', `action:${rule.id}:${index}`);
        }
      });
      wrap.addEventListener('dragend', () => {
        this._dragEventAction = null;
        wrap.classList.remove('is-dragging');
      });
      wrap.addEventListener('dragover', (ev) => {
        const drag = this._dragEventAction;
        if (!drag || drag.ruleId !== String(rule.id || '')) return;
        ev.preventDefault();
        wrap.classList.add('is-drop-target');
      });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('is-drop-target'));
      wrap.addEventListener('drop', (ev) => {
        ev.preventDefault();
        wrap.classList.remove('is-drop-target');
        const drag = this._dragEventAction;
        if (!drag || drag.ruleId !== String(rule.id || '')) return;
        const actions = this._normalizeRuleActions(rule);
        const fromIndex = drag.index;
        let toIndex = this._dropInsertIndex(ev, actions.length, index);
        if (fromIndex < toIndex) toIndex--;
        if (this._moveArrayItem(actions, fromIndex, toIndex)) this._syncRulesAndRefresh();
      });
    }

    const doRow = document.createElement('div');
    doRow.className = 'event-row';
    const left = document.createElement('div');
    left.className = 'event-step-label';
    left.appendChild(this._tinyLabel(index === 0 ? 'Do' : 'And'));
    const badge = document.createElement('span');
    badge.className = 'event-order-pill';
    badge.textContent = `#${index + 1}`;
    left.appendChild(badge);
    if (total > 1) left.appendChild(this._makeDragHandle('Drag to reorder actions'));
    doRow.appendChild(left);
    const actSel = document.createElement('select');
    for (const a of window.ACTION_TYPES) {
      const opt = document.createElement('option');
      opt.value = a.value;
      opt.textContent = a.label;
      if ((action || {}).type === a.value) opt.selected = true;
      actSel.appendChild(opt);
    }
    actSel.addEventListener('change', () => {
      const actions = this._normalizeRuleActions(rule);
      actions[index] = this._defaultRuleAction(actSel.value);
      this._syncRulesAndRefresh();
    });
    doRow.appendChild(actSel);
    if (total > 1) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini danger';
      del.textContent = 'Remove do';
      del.addEventListener('click', () => {
        const actions = this._normalizeRuleActions(rule);
        actions.splice(index, 1);
        this._syncRulesAndRefresh();
      });
      doRow.appendChild(del);
    }
    wrap.appendChild(doRow);

    const actDef = window.ACTION_TYPES.find((a) => a.value === (action || {}).type);
    if (actDef && actDef.params) {
      for (const p of actDef.params) {
        const input = this._paramInput(action, p);
        wrap.appendChild(input);
      }
    }
    return wrap;
  }

  _makeEventRuleCard(rule, index = 0, totalRules = 1) {
    const card = document.createElement('div');
    card.className = 'event-card';
    card.draggable = totalRules > 1;
    card.dataset.ruleId = String(rule.id || '');
    if (totalRules > 1) {
      card.addEventListener('dragstart', (ev) => {
        this._dragEventRuleId = String(rule.id || '');
        card.classList.add('is-dragging');
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', `rule:${rule.id}`);
        }
      });
      card.addEventListener('dragend', () => {
        this._dragEventRuleId = null;
        card.classList.remove('is-dragging');
      });
      card.addEventListener('dragover', (ev) => {
        if (!this._dragEventRuleId || this._dragEventRuleId === String(rule.id || '')) return;
        ev.preventDefault();
        card.classList.add('is-drop-target');
      });
      card.addEventListener('dragleave', () => card.classList.remove('is-drop-target'));
      card.addEventListener('drop', (ev) => {
        ev.preventDefault();
        card.classList.remove('is-drop-target');
        const rules = this.app.simulator.scenario.events || [];
        const fromIndex = rules.findIndex((r) => String(r.id || '') === String(this._dragEventRuleId || ''));
        const targetIndex = rules.findIndex((r) => String(r.id || '') === String(rule.id || ''));
        if (fromIndex < 0 || targetIndex < 0) return;
        let toIndex = this._dropInsertIndex(ev, rules.length, targetIndex);
        if (fromIndex < toIndex) toIndex--;
        if (this._moveArrayItem(rules, fromIndex, toIndex)) this._syncRulesAndRefresh();
      });
    }
    const actions = this._normalizeRuleActions(rule);

    const header = document.createElement('div');
    header.className = 'event-card-header';
    const meta = document.createElement('div');
    meta.className = 'event-card-meta';
    const order = document.createElement('span');
    order.className = 'event-order-pill';
    order.textContent = `Rule ${index + 1}`;
    meta.appendChild(order);
    if (totalRules > 1) meta.appendChild(this._makeDragHandle('Drag to reorder rules'));
    const hint = document.createElement('span');
    hint.className = 'tiny';
    hint.textContent = 'top to bottom = runtime order';
    header.appendChild(meta);
    header.appendChild(hint);
    card.appendChild(header);

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
    for (let i = 0; i < actions.length; i++) {
      card.appendChild(this._makeRuleActionEditor(rule, actions[i], i, actions.length));
    }

    const addDoRow = document.createElement('div');
    addDoRow.className = 'event-row';
    addDoRow.appendChild(this._tinyLabel(''));
    const addDo = document.createElement('button');
    addDo.type = 'button';
    addDo.className = 'mini';
    addDo.textContent = '+ Do';
    addDo.addEventListener('click', () => {
      this._normalizeRuleActions(rule).push(this._defaultRuleAction('confetti'));
      this._syncRulesAndRefresh();
    });
    addDoRow.appendChild(addDo);
    card.appendChild(addDoRow);

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
    const labelText = (() => {
      if (key === 'seconds' && target && target.type === 'finish') return 'Delay before finish';
      return key;
    })();
    row.appendChild(this._tinyLabel(labelText));
    let input;
    if (key === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.value = target[key] || '#ffffff';
      input.addEventListener('input', () => {
        target[key] = input.value;
        this._syncRulesAndRefresh(true); // keep focus; no rerender
      });
    } else if (key === 'text' || key === 'templateId' || key === 'circleId') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = target[key] || '';
      if (key === 'templateId') input.placeholder = 'ball id';
      if (key === 'circleId') input.placeholder = 'ring id';
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

  _getTimedCountdownRuleSeconds() {
    const rules = (this.app && this.app.simulator && this.app.simulator.scenario
      && Array.isArray(this.app.simulator.scenario.events))
      ? this.app.simulator.scenario.events
      : [];
    for (const rule of rules) {
      if (!rule || !rule.trigger || rule.trigger.type !== 'everySeconds') continue;
      const seconds = parseFloat(rule.trigger.seconds);
      if (!(seconds > 0)) continue;
      const actions = this._getRuleActions(rule);
      const hasFreeze = actions.some((action) => action && action.type === 'freezeBall');
      const hasSpawn = actions.some((action) => action && action.type === 'spawnBall');
      if (hasFreeze && hasSpawn) return seconds;
    }
    return null;
  }

  _syncCountdownOverlayToTimedRule() {
    const sc = this.app && this.app.simulator ? this.app.simulator.scenario : null;
    if (!sc) return false;
    if (!sc.overlay) sc.overlay = {};
    const seconds = this._getTimedCountdownRuleSeconds();
    if (!(seconds > 0)) return false;
    let changed = false;
    if (!sc.overlay.bigCountdown) {
      sc.overlay.bigCountdown = true;
      changed = true;
    }
    if (sc.overlay.countdownMode !== 'repeatInterval') {
      sc.overlay.countdownMode = 'repeatInterval';
      changed = true;
    }
    if (Math.abs((Number(sc.overlay.countdownInterval) || 0) - seconds) > 1e-6) {
      sc.overlay.countdownInterval = seconds;
      changed = true;
    }
    const nextMax = Math.max(1, Math.ceil(seconds));
    if ((Number(sc.overlay.countdownMax) || 0) !== nextMax) {
      sc.overlay.countdownMax = nextMax;
      changed = true;
    }
    return changed;
  }

  _syncRulesAndRefresh(inplace = false) {
    const rules = this.app.simulator.scenario.events || [];
    for (const rule of rules) this._normalizeRuleActions(rule);
    const countdownChanged = this._syncCountdownOverlayToTimedRule();
    this.app.events.setRules(rules);
    if (!inplace) this.refreshEvents();
    if (countdownChanged || !inplace) {
      this.refreshScenarioPanel();
      this.refreshOutline();
      if (this.selectedId === OVERLAY_COUNTDOWN_ID) this.refreshPropertyPanel();
    }
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
    const branchMazeControls = document.getElementById('branch-maze-controls');
    const branchMazeRotation = document.getElementById('branch-maze-rotation');
    const branchMazeRotationLabel = document.getElementById('branch-maze-rotation-label');
    if (branchMazeControls) branchMazeControls.hidden = !sc.branchMazeVariant;
    if (branchMazeRotation && branchMazeRotationLabel && sc.branchMazeVariant) {
      const rotationSpeed = Number(sc.branchMazeRotationSpeed) || 0;
      branchMazeRotation.value = String(rotationSpeed);
      branchMazeRotationLabel.textContent = `${rotationSpeed.toFixed(2)} rad/s`;
    }
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
    document.getElementById('vs-glow').value = sc.visuals.glow;
    document.getElementById('vs-pulse').checked = !!sc.visuals.pulse;
    document.getElementById('vs-freeze-glow-color').value = sc.visuals.freezeGlowColor || '#bae6fd';
    document.getElementById('vs-freeze-rim-color').value = sc.visuals.freezeRimColor || '#e0f2fe';
    document.getElementById('vs-freeze-opacity').value = sc.visuals.freezeOpacity != null ? sc.visuals.freezeOpacity : 0.75;
    document.getElementById('vs-freeze-speck-count').value = sc.visuals.freezeSpeckCount != null ? sc.visuals.freezeSpeckCount : 3;
    document.getElementById('vs-freeze-speck-color').value = sc.visuals.freezeSpeckColor || '#e0f2fe';
  }

  refreshOutline() {
    const list = document.getElementById('outline-list');
    const textList = document.getElementById('text-outline-list');
    if (!list) return;
    list.innerHTML = '';
    if (textList) textList.innerHTML = '';
    const overlay = this.app.simulator.scenario.overlay || {};
    const appendTextItem = (id, color, labelText, onDelete) => {
      if (!textList) return;
      const item = document.createElement('li');
      item.className = 'outline-item' + (this.selectedId === id ? ' selected' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = color || '#ffffff';
      const label = document.createElement('span');
      label.textContent = labelText;
      label.className = 'label';
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Delete';
      del.className = 'mini';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        onDelete();
      });
      item.appendChild(dot);
      item.appendChild(label);
      item.appendChild(del);
      item.addEventListener('click', () => this.select(id));
      textList.appendChild(item);
    };
    if (overlay.title && textList) {
      const summary = String(overlay.title).split('\n')[0].trim() || 'Title';
      appendTextItem(
        OVERLAY_TITLE_ID,
        overlay.titleColor || '#ffffff',
        `title: ${summary}`,
        () => this._removeOverlayItem(OVERLAY_TITLE_ID),
      );
    }
    if (overlay.showTimer && textList) {
      appendTextItem(OVERLAY_TIMER_ID, '#ffffff', 'timer', () => this._removeOverlayItem(OVERLAY_TIMER_ID));
    }
    if (overlay.showCounter && textList) {
      appendTextItem(OVERLAY_COUNTER_ID, '#ffffff', 'counter', () => this._removeOverlayItem(OVERLAY_COUNTER_ID));
    }
    if (overlay.showScore && textList) {
      appendTextItem(OVERLAY_SCORE_ID, '#ffffff', 'score', () => this._removeOverlayItem(OVERLAY_SCORE_ID));
    }
    if (overlay.bigCountdown && textList) {
      appendTextItem(
        OVERLAY_COUNTDOWN_ID,
        '#ffffff',
        `countdown: ${overlay.countdownMax || 4}`,
        () => this._removeOverlayItem(OVERLAY_COUNTDOWN_ID),
      );
    }
    for (const o of this.app.simulator.scenario.objects) {
      const isTextLike = o.type === 'text' || o.type === 'timer';
      const targetList = isTextLike && textList ? textList : list;
      const li = document.createElement('li');
      li.className = 'outline-item' + (o.id === this.selectedId && !this._selectedSubchild ? ' selected' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = o.color || '#fff';
      const label = document.createElement('span');
      if (o.type === 'text') {
        const summary = String(o.text || '').split('\n')[0].trim() || o.id;
        label.textContent = `text: ${summary}`;
      } else if (o.type === 'timer') {
        const summary = String(o.prefix || o.suffix || '').trim() || o.id;
        label.textContent = `timer: ${summary}`;
      } else {
        label.textContent = `${o.type}: ${o.id}`;
      }
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
      targetList.appendChild(li);
      if (!isTextLike && o.type === 'spawner') {
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
    const overlayObj = this._makeOverlayItemProxy(this.selectedId);
    if (overlayObj) {
      const header = document.createElement('div');
      header.className = 'prop-header';
      header.innerHTML = `<h3>${overlayObj.__panelTitle}</h3><span class="id">${overlayObj.__panelId}</span>`;
      panel.appendChild(header);
      const actions = document.createElement('div');
      actions.className = 'prop-actions';
      const btnDel = document.createElement('button');
      btnDel.textContent = 'Delete';
      btnDel.className = 'danger';
      btnDel.addEventListener('click', () => this._removeOverlayItem(this.selectedId));
      actions.appendChild(btnDel);
      panel.appendChild(actions);
      for (const field of propertySchema(overlayObj)) {
        panel.appendChild(this._makeField(overlayObj, field));
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
        if (target && target.type === 'ball') {
          panel.appendChild(this._makeCollisionHoleSection(target));
        }
      }
    } else {
      const schema = propertySchema(obj);
      for (const field of schema) {
        panel.appendChild(this._makeField(obj, field));
      }
    }

    if (obj.type === 'ball') {
      panel.appendChild(this._makeCollisionHoleSection(obj));
    }

    if (this._supportsGapPassEditor(obj)) {
      panel.appendChild(this._makeGapPassSection(obj));
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
    if (field.key === 'ballBehaviorPreset' && obj.type === 'ball') {
      value = this._ballBehaviorPresetId(obj);
    }
    if (value == null && field.defaultValue !== undefined) value = field.defaultValue;

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

    const bindNumericReadoutEditor = (readout, {
      getEditorValue,
      commitValue,
      getDisplayValue,
    }) => {
      readout.title = 'Double-click to edit';
      readout.addEventListener('dblclick', () => {
        if (readout.querySelector('input')) return;
        const editor = document.createElement('input');
        editor.type = 'number';
        editor.inputMode = 'decimal';
        editor.step = 'any';
        editor.value = getEditorValue();
        editor.className = 'readout-editor';
        editor.setAttribute('aria-label', field.label);
        const finish = (commit) => {
          if (!editor.isConnected) return;
          if (commit) {
            const parsed = parseFloat(editor.value);
            if (Number.isFinite(parsed)) commitValue(parsed);
          }
          readout.textContent = getDisplayValue();
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
        readout.textContent = '';
        readout.appendChild(editor);
        editor.focus();
        editor.select();
      });
    };

    const velocityAngleDeg = () => {
      const vx = obj.vx || 0;
      const vy = obj.vy || 0;
      if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) return 90;
      return Math.atan2(vy, vx) * 180 / Math.PI;
    };

    const applyVelocityAngleDeg = (deg) => {
      while (deg > 180) deg -= 360;
      while (deg < -180) deg += 360;
      const min = field.min != null ? parseFloat(field.min) : -180;
      const max = field.max != null ? parseFloat(field.max) : 180;
      deg = Math.max(min, Math.min(max, deg));
      input.value = deg;
      const speed = Math.hypot(obj.vx || 0, obj.vy || 0);
      const radians = deg * Math.PI / 180;
      obj.vx = Math.cos(radians) * speed;
      obj.vy = Math.sin(radians) * speed;
      this._applyEdit(authoredObj);
      return deg;
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
        if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) angle = Math.PI / 2;
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
      bindNumericReadoutEditor(readout, {
        getEditorValue: () => String(Math.hypot(obj.vx || 0, obj.vy || 0)),
        commitValue: (next) => applySpeed(next),
        getDisplayValue: () => (Math.hypot(obj.vx || 0, obj.vy || 0)).toFixed(field.decimals || 0),
      });
      row.appendChild(readout);
      return row;
    } else if (field.type === 'direction') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = field.min != null ? field.min : -180;
      input.max = field.max != null ? field.max : 180;
      input.step = field.step || 1;
      input.value = velocityAngleDeg();
      const readout = document.createElement('span');
      readout.className = 'readout';
      const randomDir = !!obj.randomInitDir;
      readout.textContent = randomDir
        ? 'random'
        : `${Number(input.value).toFixed(field.decimals || 0)}deg`;
      const applyDirection = (deg) => {
        const applied = applyVelocityAngleDeg(deg);
        readout.textContent = `${applied.toFixed(field.decimals || 0)}deg`;
      };
      input.addEventListener('input', () => applyDirection(parseFloat(input.value)));
      const sliderWrap = makeSliderWrap(input, (dir) => {
        const step = parseFloat(field.step || 1);
        applyDirection(parseFloat(input.value) + dir * step);
      });
      if (randomDir) {
        input.disabled = true;
        sliderWrap.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
        readout.title = 'Direction is seeded-random on reset';
      } else {
        bindNumericReadoutEditor(readout, {
          getEditorValue: () => String(velocityAngleDeg()),
          commitValue: (next) => applyDirection(next),
          getDisplayValue: () => `${velocityAngleDeg().toFixed(field.decimals || 0)}deg`,
        });
      }
      row.appendChild(sliderWrap);
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
        if (field.key === 'ballBehaviorPreset' && obj.type === 'ball') {
          this._applyBallBehaviorPreset(obj, input.value);
          this._applyEdit(authoredObj);
          this.refreshPropertyPanel();
          return;
        }
        obj[field.key] = input.value;
        this._applyEdit(authoredObj);
        if (field.refreshOnChange) this.refreshPropertyPanel();
        if (authoredObj === this.app.simulator.scenario.overlay) {
          this.refreshScenarioPanel();
          this.refreshOutline();
        }
      });
    } else if (field.type === 'soundSelect') {
      // Sound-preset dropdown + inline ▶ preview button. Looks like a select
      // row in the inspector but hears what the user will get at runtime.
      const wrap = document.createElement('div');
      wrap.className = 'sound-field';
      input = document.createElement('select');
      const presets = this._soundOptionsForKind(field.kind);
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
        if (field.key === 'randomInitDir') {
          this.refreshPropertyPanel();
        }
        if (field.refreshOnChange) {
          this.refreshPropertyPanel();
        }
        if (authoredObj === this.app.simulator.scenario.overlay) {
          this.refreshScenarioPanel();
          this.refreshOutline();
        }
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
        if (obj.type === 'ball' && BALL_BEHAVIOR_PRESET_KEYS.includes(field.key)) {
          this._syncBallBehaviorPreset(obj);
        }
        readout.textContent = v.toFixed(field.decimals || 0);
        this._applyEdit(authoredObj);
        if (authoredObj === this.app.simulator.scenario.overlay) {
          this.refreshScenarioPanel();
          this.refreshOutline();
        }
      };
      input.addEventListener('input', () => applyNumber(parseFloat(input.value)));
      row.appendChild(makeSliderWrap(input, (dir) => {
        const step = parseFloat(field.step || 1);
        applyNumber(parseFloat(input.value) + dir * step);
      }));
      bindNumericReadoutEditor(readout, {
        getEditorValue: () => String(obj[field.key]),
        commitValue: (next) => applyNumber(next),
        getDisplayValue: () => Number(obj[field.key]).toFixed(field.decimals || 0),
      });
      row.appendChild(readout);
      return row;
    }
    row.appendChild(input);
    return row;
  }

  _supportsGapPassEditor(obj) {
    return !!obj && (obj.type === 'circle' || obj.type === 'arc' || obj.type === 'spiral' || obj.type === 'spikes');
  }

  _ensureGapPassConfig(obj) {
    if (!obj.onGapPass || typeof obj.onGapPass !== 'object') {
      obj.onGapPass = window.defaultGapPassConfig ? window.defaultGapPassConfig() : {
        enabled: false,
        outcome: 'escape',
        particleStyle: 'auto',
        soundMode: 'none',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 1,
      };
    } else if (window.defaultGapPassConfig) {
      obj.onGapPass = window.defaultGapPassConfig(obj.onGapPass);
    }
    return obj.onGapPass;
  }

  _scenarioSoundAssets() {
    const sc = this.app.simulator.scenario;
    if (!sc.soundAssets || typeof sc.soundAssets !== 'object') sc.soundAssets = {};
    return sc.soundAssets;
  }

  _soundOptionsForKind(kind) {
    const options = ((window.SOUND_PRESETS && window.SOUND_PRESETS[kind]) || []).slice();
    const used = new Set(options.map((opt) => String(opt.value)));
    for (const [assetId, asset] of Object.entries(this._scenarioSoundAssets())) {
      const value = `asset:${assetId}`;
      if (used.has(value)) continue;
      used.add(value);
      const name = asset && (asset.name || asset.filename || asset.mime || asset.type);
      options.push({
        value,
        label: `Uploaded: ${name || assetId}`,
      });
    }
    return options;
  }

  _scanGapAssetRefs(skipObjectId = null) {
    const refs = new Map();
    for (const obj of this.app.simulator.scenario.objects || []) {
      if (!obj || obj.id === skipObjectId || !obj.onGapPass || !obj.onGapPass.soundAssetId) continue;
      const id = obj.onGapPass.soundAssetId;
      refs.set(id, (refs.get(id) || 0) + 1);
    }
    return refs;
  }

  _removeGapAssetIfUnused(assetId, skipObjectId = null) {
    if (!assetId) return;
    const refs = this._scanGapAssetRefs(skipObjectId);
    if (refs.get(assetId)) return;
    delete this._scenarioSoundAssets()[assetId];
  }

  _makeSimpleSelectRow(labelText, value, options, onChange) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('select');
    for (const optDef of options) {
      const opt = document.createElement('option');
      opt.value = optDef.value;
      opt.textContent = optDef.label;
      if (String(opt.value) === String(value)) opt.selected = true;
      input.appendChild(opt);
    }
    input.addEventListener('change', () => onChange(input.value));
    row.appendChild(label);
    row.appendChild(input);
    return row;
  }

  _makeSimpleToggleRow(labelText, checked, onChange) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    row.appendChild(label);
    row.appendChild(input);
    return row;
  }

  async _uploadGapSoundAsset(obj, file) {
    if (!file) return;
    const cfg = this._ensureGapPassConfig(obj);
    const prevAssetId = cfg.soundAssetId || '';
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Failed to read audio file'));
      reader.readAsDataURL(file);
    });
    const assetId = nextId('asset');
    this._scenarioSoundAssets()[assetId] = {
      name: file.name || 'uploaded-audio',
      mime: file.type || 'audio/*',
      dataUrl,
    };
    cfg.soundMode = 'upload';
    cfg.soundAssetId = assetId;
    if (!cfg.soundVolume) cfg.soundVolume = 1;
    this._removeGapAssetIfUnused(prevAssetId, obj.id);
    this._applyEdit(obj);
    this.app.audio.setScenario(this.app.simulator.scenario);
    this.refreshPropertyPanel();
    this._commit();
  }

  _previewGapPassSound(obj) {
    const cfg = this._ensureGapPassConfig(obj);
    if (!this.app.audio) return;
    this.app.audio.ensureReady();
    this.app.audio.setEnabled(true);
    this.app.audio.setScenario(this.app.simulator.scenario);
    this.app.audio.previewEventSound('gapPass', cfg.soundPreset || '', {
      gapOutcome: cfg.outcome || 'escape',
      gapSoundMode: cfg.soundMode || 'none',
      gapSoundPreset: cfg.soundPreset || '',
      gapSoundAssetId: cfg.soundAssetId || '',
      gapSoundVolume: cfg.soundVolume != null ? cfg.soundVolume : 1,
    });
  }

  _makeGapPassSection(obj) {
    const cfg = this._ensureGapPassConfig(obj);
    const frag = document.createDocumentFragment();
    const title = document.createElement('div');
    title.className = 'prop-section-title';
    title.textContent = 'Gap Pass FX';
    frag.appendChild(title);

    const apply = () => {
      this._applyEdit(obj);
      this.app.audio.setScenario(this.app.simulator.scenario);
    };

    frag.appendChild(this._makeSimpleToggleRow('Enable gap FX', cfg.enabled, (checked) => {
      cfg.enabled = checked;
      apply();
      this.refreshPropertyPanel();
    }));

    if (!cfg.enabled) return frag;

    frag.appendChild(this._makeSimpleSelectRow('Outcome', cfg.outcome, [
      { value: 'escape', label: 'Escape' },
      { value: 'destroy', label: 'Destroy' },
      { value: 'shatter', label: 'Shatter' },
      { value: 'burn', label: 'Burn' },
      { value: 'flyAway', label: 'Fly away' },
      { value: 'launchUp', label: 'Launch up' },
      { value: 'launchDown', label: 'Launch down' },
    ], (value) => {
      cfg.outcome = value;
      apply();
    }));

    frag.appendChild(this._makeSimpleSelectRow('Particle style', cfg.particleStyle || 'auto', [
      { value: 'auto', label: 'Auto from outcome' },
      { value: 'burst', label: 'Burst' },
      { value: 'shatter', label: 'Shatter' },
      { value: 'burn', label: 'Burn' },
      { value: 'trail', label: 'Trail / launch' },
    ], (value) => {
      cfg.particleStyle = value;
      apply();
    }));

    frag.appendChild(this._makeSimpleSelectRow('Sound mode', cfg.soundMode || 'none', [
      { value: 'none', label: 'No extra sound' },
      { value: 'preset', label: 'Built-in preset' },
      { value: 'upload', label: 'Uploaded sound' },
    ], (value) => {
      cfg.soundMode = value;
      if (value !== 'upload') cfg.soundAssetId = cfg.soundAssetId || '';
      apply();
      this.refreshPropertyPanel();
    }));

    if ((cfg.soundMode || 'none') === 'preset') {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const label = document.createElement('label');
      label.textContent = 'Gap sound';
      row.appendChild(label);
      const wrap = document.createElement('div');
      wrap.className = 'sound-field';
      const input = document.createElement('select');
      const presets = (window.SOUND_PRESETS && window.SOUND_PRESETS.gapPass) || [];
      for (const preset of presets) {
        const opt = document.createElement('option');
        opt.value = preset.value;
        opt.textContent = preset.label;
        if (String(preset.value) === String(cfg.soundPreset || '')) opt.selected = true;
        input.appendChild(opt);
      }
      input.addEventListener('change', () => {
        cfg.soundPreset = input.value;
        apply();
        this._previewGapPassSound(obj);
      });
      wrap.appendChild(input);
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'sound-play';
      play.textContent = '▶';
      play.title = 'Preview gap sound';
      play.addEventListener('click', () => this._previewGapPassSound(obj));
      wrap.appendChild(play);
      row.appendChild(wrap);
      frag.appendChild(row);
    } else if ((cfg.soundMode || 'none') === 'upload') {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const label = document.createElement('label');
      label.textContent = 'Uploaded sound';
      row.appendChild(label);

      const wrap = document.createElement('div');
      wrap.className = 'gap-sound-upload';
      const asset = cfg.soundAssetId ? this._scenarioSoundAssets()[cfg.soundAssetId] : null;
      const name = document.createElement('span');
      name.className = 'gap-sound-name';
      name.textContent = asset ? asset.name : 'No file selected';
      wrap.appendChild(name);

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.textContent = asset ? 'Replace' : 'Upload';
      pick.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          if (file) await this._uploadGapSoundAsset(obj, file);
        });
        input.click();
      });
      wrap.appendChild(pick);

      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = 'Preview';
      play.disabled = !asset;
      play.addEventListener('click', () => this._previewGapPassSound(obj));
      wrap.appendChild(play);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.disabled = !asset;
      remove.addEventListener('click', () => {
        const current = cfg.soundAssetId || '';
        cfg.soundAssetId = '';
        cfg.soundMode = 'none';
        this._removeGapAssetIfUnused(current, obj.id);
        apply();
        this.refreshPropertyPanel();
        this._commit();
      });
      wrap.appendChild(remove);
      row.appendChild(wrap);
      frag.appendChild(row);
    }

    const volumeRow = document.createElement('div');
    volumeRow.className = 'prop-row';
    const volumeLabel = document.createElement('label');
    volumeLabel.textContent = 'Sound volume';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.max = '2';
    volumeInput.step = '0.01';
    volumeInput.value = String(cfg.soundVolume != null ? cfg.soundVolume : 1);
    const volumeReadout = document.createElement('span');
    volumeReadout.className = 'readout';
    volumeReadout.textContent = Number(volumeInput.value).toFixed(2);
    volumeInput.addEventListener('input', () => {
      cfg.soundVolume = parseFloat(volumeInput.value);
      volumeReadout.textContent = cfg.soundVolume.toFixed(2);
      apply();
    });
    volumeRow.appendChild(volumeLabel);
    volumeRow.appendChild(volumeInput);
    volumeRow.appendChild(volumeReadout);
    frag.appendChild(volumeRow);
    const resetRow = document.createElement('div');
    resetRow.className = 'prop-row';
    resetRow.style.gridTemplateColumns = '1fr';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset gap FX';
    resetBtn.addEventListener('click', () => {
      const currentAsset = cfg.soundAssetId || '';
      obj.onGapPass = window.defaultGapPassConfig ? window.defaultGapPassConfig() : {
        enabled: false,
        outcome: 'escape',
        particleStyle: 'auto',
        soundMode: 'none',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 1,
      };
      this._removeGapAssetIfUnused(currentAsset, obj.id);
      apply();
      this.refreshPropertyPanel();
      this._commit();
    });
    resetRow.appendChild(resetBtn);
    frag.appendChild(resetRow);
    return frag;
  }

  _makeCollisionHoleSection(ballLike) {
    const frag = document.createDocumentFragment();
    const title = document.createElement('div');
    title.className = 'prop-section-title';
    title.textContent = 'Collision Hole';
    frag.appendChild(title);

    const fields = [
      {
        key: 'collisionHoleEnabled',
        label: 'Enable collision hole',
        type: 'bool',
        defaultValue: false,
        refreshOnChange: true,
      },
    ];
    for (const field of fields) frag.appendChild(this._makeField(ballLike, field));
    if (!ballLike.collisionHoleEnabled) return frag;

    const configFields = [
      {
        key: 'collisionHoleSize',
        label: 'Hole size',
        type: 'number',
        min: 0.05,
        max: Math.PI * 2 - 0.05,
        step: 0.01,
        decimals: 2,
        defaultValue: 0.42,
      },
      {
        key: 'collisionHoleTarget',
        label: 'Target circle',
        type: 'select',
        defaultValue: 'auto',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'hitCircle', label: 'Hit circle only' },
          { value: 'nearestCircle', label: 'Nearest circle' },
          { value: 'innermostContainingCircle', label: 'Innermost containing circle' },
          { value: 'outermostContainingCircle', label: 'Outermost containing circle' },
        ],
      },
      {
        key: 'collisionHolePlacement',
        label: 'Place hole',
        type: 'select',
        defaultValue: 'impact',
        options: [
          { value: 'impact', label: 'At impact point' },
          { value: 'oppositeImpact', label: 'Opposite impact point' },
          { value: 'againstIncoming', label: 'Against incoming ball' },
          { value: 'withIncoming', label: 'With incoming direction' },
        ],
      },
      { key: 'collisionHoleOnCircle', label: 'Trigger on circle hit', type: 'bool', defaultValue: true },
      { key: 'collisionHoleOnArc', label: 'Trigger on arc hit', type: 'bool', defaultValue: false },
      { key: 'collisionHoleOnSpikes', label: 'Trigger on spikes hit', type: 'bool', defaultValue: false },
      { key: 'collisionHoleOnSpinner', label: 'Trigger on spinner hit', type: 'bool', defaultValue: false },
      { key: 'collisionHoleOnBall', label: 'Trigger on ball hit', type: 'bool', defaultValue: false },
      { key: 'collisionHoleOnFixedBall', label: 'Trigger on static ball hit', type: 'bool', defaultValue: false },
    ];
    for (const field of configFields) frag.appendChild(this._makeField(ballLike, field));
    return frag;
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
      randomInitDir: 'ballRandomInitDir',
      lifetime: 'ballLifetime',
      freezeOnTimeout: 'ballFreezeOnTimeout',
      fixed: 'ballFixed',
      ballBehaviorPreset: 'ballBehaviorPreset',
      maxSpeed: 'ballMaxSpeed',
      bounce: 'ballBounce',
      wallCurve: 'ballWallCurve',
      wallDrift: 'ballWallDrift',
      wallBounceAngleRange: 'ballWallBounceAngleRange',
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
      collisionHoleEnabled: 'ballCollisionHoleEnabled',
      collisionHoleSize: 'ballCollisionHoleSize',
      collisionHoleTarget: 'ballCollisionHoleTarget',
      collisionHolePlacement: 'ballCollisionHolePlacement',
      collisionHoleOnCircle: 'ballCollisionHoleOnCircle',
      collisionHoleOnArc: 'ballCollisionHoleOnArc',
      collisionHoleOnSpikes: 'ballCollisionHoleOnSpikes',
      collisionHoleOnSpinner: 'ballCollisionHoleOnSpinner',
      collisionHoleOnBall: 'ballCollisionHoleOnBall',
      collisionHoleOnFixedBall: 'ballCollisionHoleOnFixedBall',
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

  _makeOverlayItemProxy(id) {
    const overlay = this.app.simulator.scenario.overlay || (this.app.simulator.scenario.overlay = {});
    let config = null;
    switch (id) {
      case OVERLAY_TIMER_ID:
        config = {
          type: 'overlayToggle',
          panelTitle: 'timer',
          panelId: 'overlay.showTimer',
          mappedKeys: { enabled: 'showTimer' },
        };
        break;
      case OVERLAY_COUNTER_ID:
        config = {
          type: 'overlayToggle',
          panelTitle: 'counter',
          panelId: 'overlay.showCounter',
          mappedKeys: { enabled: 'showCounter' },
        };
        break;
      case OVERLAY_SCORE_ID:
        config = {
          type: 'overlayToggle',
          panelTitle: 'score',
          panelId: 'overlay.showScore',
          mappedKeys: { enabled: 'showScore' },
        };
        break;
      case OVERLAY_COUNTDOWN_ID:
        config = {
          type: 'overlayCountdown',
          panelTitle: 'countdown',
          panelId: 'overlay.bigCountdown',
          mappedKeys: {
            enabled: 'bigCountdown',
            countdownMax: 'countdownMax',
            countdownMode: 'countdownMode',
            countdownInterval: 'countdownInterval',
          },
          defaults: {
            enabled: false,
            countdownMax: 4,
            countdownMode: 'loopTime',
            countdownInterval: 4,
          },
        };
        break;
      default:
        return null;
    }
    const proxy = {
      id,
      type: config.type,
      __sourceObject: overlay,
      __panelTitle: config.panelTitle,
      __panelId: config.panelId,
    };
    const defaults = config.defaults || { enabled: false };
    for (const [proxyKey, sourceKey] of Object.entries(config.mappedKeys)) {
      Object.defineProperty(proxy, proxyKey, {
        enumerable: true,
        configurable: true,
        get: () => (overlay[sourceKey] != null ? overlay[sourceKey] : defaults[proxyKey]),
        set: (value) => { overlay[sourceKey] = value; },
      });
    }
    return proxy;
  }

  _removeOverlayItem(id) {
    const overlay = this.app.simulator.scenario.overlay || (this.app.simulator.scenario.overlay = {});
    switch (id) {
      case OVERLAY_TITLE_ID:
        overlay.title = '';
        break;
      case OVERLAY_TIMER_ID:
        overlay.showTimer = false;
        break;
      case OVERLAY_COUNTER_ID:
        overlay.showCounter = false;
        break;
      case OVERLAY_SCORE_ID:
        overlay.showScore = false;
        break;
      case OVERLAY_COUNTDOWN_ID:
        overlay.bigCountdown = false;
        break;
      default:
        return;
    }
    if (this.selectedId === id) this.select(null);
    this.refreshAll();
    this._commit();
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

  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Keep the blob URL alive long enough for large exports to start saving.
    setTimeout(() => {
      if (a.isConnected) document.body.removeChild(a);
    }, 1000);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  _getExportUi() {
    return {
      statusEl: document.getElementById('export-status'),
      mp4Btn: document.getElementById('btn-export-webm'),
      queueMp4Btn: document.getElementById('btn-queue-export-webm'),
      framesBtn: document.getElementById('btn-export-frames'),
      queueFramesBtn: document.getElementById('btn-queue-export-frames'),
      startQueueBtn: document.getElementById('btn-start-export-queue'),
      stopBtn: document.getElementById('btn-stop-export'),
    };
  }

  _describeExportJob(job) {
    if (!job) return 'render';
    const base = job.kind === 'frames' ? 'PNG render' : 'MP4 render';
    return job.scenario && job.scenario.seed != null ? `${base} seed ${job.scenario.seed}` : base;
  }

  _syncPendingSeedInput() {
    const seedInput = document.getElementById('seed-input');
    if (!seedInput) return;
    const val = String(seedInput.value || '').trim();
    if (!val) return;
    const parsed = /^\d+$/.test(val) ? parseInt(val, 10) : val;
    if (String(parsed) === String(this.app.simulator.scenario.seed)) return;
    this._applySeed(parsed);
    this.refreshAll();
  }

  _queueSuffix({ includeActive = true } = {}) {
    const activeCount = includeActive && this._activeExportJob ? 1 : 0;
    const waitingCount = this._exportQueue.length;
    const totalPending = activeCount + waitingCount;
    if (waitingCount > 0 && activeCount > 0) return ` (${waitingCount} queued, ${totalPending} total)`;
    if (waitingCount > 0) return ` (${waitingCount} queued)`;
    if (activeCount > 0) return ' (1 active)';
    return '';
  }

  _setExportStatus(message, { done, total } = {}) {
    const { statusEl } = this._getExportUi();
    const text = `${message}${this._queueSuffix()}`;
    if (statusEl) statusEl.textContent = text;
    const payload = { status: text };
    if (done != null) payload.done = done;
    if (total != null) payload.total = total;
    this.app.updateExport(payload);
  }

  _refreshExportControls() {
    const { mp4Btn, queueMp4Btn, framesBtn, queueFramesBtn, startQueueBtn, stopBtn } = this._getExportUi();
    if (mp4Btn) mp4Btn.disabled = false;
    if (queueMp4Btn) queueMp4Btn.disabled = false;
    if (framesBtn) framesBtn.disabled = false;
    if (queueFramesBtn) queueFramesBtn.disabled = false;
    const hasActive = !!this._activeExportJob;
    const hasQueued = this._exportQueue.length > 0;
    if (startQueueBtn) {
      startQueueBtn.disabled = hasActive || !hasQueued;
      startQueueBtn.textContent = hasQueued
        ? `▶ Start queued renders (${this._exportQueue.length})`
        : '▶ Start queued renders';
    }
    if (!stopBtn) return;
    stopBtn.hidden = !hasActive;
    stopBtn.disabled = !hasActive;
    stopBtn.textContent = this._exportQueue.length > 0 ? 'Stop current render' : 'Stop render';
  }

  _buildExportJob(kind) {
    this._syncPendingSeedInput();
    const fps = 60;
    const scenario = JSON.parse(JSON.stringify(this.app.simulator.getScenario()));
    const exportSimulator = new window.Simulator();
    exportSimulator.setScenario(scenario);
    const simulatorSnapshot = typeof exportSimulator.createSnapshot === 'function'
      ? JSON.parse(JSON.stringify(exportSimulator.createSnapshot()))
      : null;
    const ecType = scenario.endCondition && scenario.endCondition.type;
    const hasExactFrameTarget = !ecType || ecType === 'loopDuration' || ecType === 'fixed';
    const exactSeconds = !ecType || ecType === 'loopDuration'
      ? (scenario.loopDuration || (scenario.satisfying ? scenario.loopDuration : scenario.duration) || 12)
      : Math.max(0.5, Number(scenario.endCondition && scenario.endCondition.seconds) || Number(scenario.duration) || 12);
    return {
      id: this._nextExportJobId++,
      kind,
      fps,
      simulatorSnapshot,
      scenario,
      eventsSnapshot: null,
      rendererSnapshot: null,
      audioEngine: this.app.audio && typeof this.app.audio.createExportClone === 'function'
        ? this.app.audio.createExportClone()
        : this.app.audio,
      hintFrames: hasExactFrameTarget ? Math.ceil(exactSeconds * fps) : 0,
      hasExactFrameTarget,
      tag: scenario.satisfying ? 'loop' : (scenario.name || 'sim').replace(/\s+/g, '_').toLowerCase(),
    };
  }

  _ensureExportWorker() {
    if (this._exportWorkerPromise) return;
    this._exportWorkerPromise = this._processExportQueue()
      .catch((e) => {
        console.error('Export queue failed:', e);
        this._setExportStatus('Export queue failed: ' + (e && e.message ? e.message : String(e)));
      })
      .finally(() => {
        this._activeExportJob = null;
        this._exportWorkerPromise = null;
        this.app.endExport();
        this._refreshExportControls();
      });
  }

  async _processExportQueue() {
    while (this._exportQueue.length > 0) {
      const job = this._exportQueue.shift();
      this._activeExportJob = job;
      this.app.beginExport();
      this._refreshExportControls();
      await this._runExportJob(job);
      this.app.endExport();
      this._activeExportJob = null;
      this._refreshExportControls();
    }
  }

  async _runExportJob(job) {
    const ExportManagerCtor = window.ExportManager;
    if (typeof ExportManagerCtor !== 'function') {
      throw new Error('ExportManager failed to load. Refresh the page and retry.');
    }
    const exporter = new ExportManagerCtor(
      window.Simulator.fromSnapshot(job.simulatorSnapshot),
      job.audioEngine,
      {
        eventsSnapshot: job.eventsSnapshot,
        rendererSnapshot: job.rendererSnapshot,
      }
    );
    this._setExportStatus(`Preparing ${this._describeExportJob(job)}…`, {
      done: 0,
      total: job.hintFrames,
    });

    try {
      let result;
      const updateProgress = (frameCount) => {
        if (frameCount % 4 !== 0 && frameCount !== 1) return;
        const label = job.hasExactFrameTarget
          ? `Rendering ${this._describeExportJob(job)} ${frameCount} / ${job.hintFrames} frames`
          : `Rendering ${this._describeExportJob(job)} ${frameCount} frames`;
        this._setExportStatus(label, { done: frameCount, total: job.hintFrames });
      };
      if (job.kind === 'mp4') {
        result = await exporter.exportMP4({
          fps: job.fps,
          onStatus: (s) => this._setExportStatus(`${this._describeExportJob(job)}: ${s}`),
          shouldCancel: () => this.app.isExportCancelRequested(),
          onProgress: updateProgress,
        });
      } else {
        result = await exporter.exportFrames({
          fps: job.fps,
          onStatus: (s) => this._setExportStatus(`${this._describeExportJob(job)}: ${s}`),
          shouldCancel: () => this.app.isExportCancelRequested(),
          onProgress: updateProgress,
        });
      }

      const seconds = result.seconds.toFixed(1);
      const filename = `${job.tag}_${job.scenario.seed}_${seconds}s.${result.extension}`;
      this._downloadBlob(result.blob, filename);

      let audioTag = '';
      if (job.kind === 'mp4') {
        const peak = typeof result.audioPeak === 'number'
          ? ` (peak ${result.audioPeak.toFixed(3)})` : '';
        if (result.audioCodec) audioTag = ` · audio: ${result.audioCodec}${peak}`;
        else if (result.audioFailReason) audioTag = ` · no audio (${result.audioFailReason})`;
      }
      this._setExportStatus(
        `Saved ${filename} (${result.frames} frames · ${seconds}s${audioTag})`,
        { done: result.frames, total: Math.max(result.frames, 1) }
      );
    } catch (e) {
      if (e && e.name === 'ExportCancelledError') {
        this._setExportStatus(`Stopped ${this._describeExportJob(job)}`);
      } else {
        console.error(e);
        this._setExportStatus(`Export failed: ${e && e.message ? e.message : String(e)}`);
      }
    }
  }

  _enqueueExportVideo(kind, { autostart = true } = {}) {
    const job = this._buildExportJob(kind);
    this._exportQueue.push(job);
    this._refreshExportControls();
    this._setExportStatus(`${autostart ? 'Queued' : 'Added to queue'} ${this._describeExportJob(job)}`);
    if (autostart) this._ensureExportWorker();
  }

  _queueExportVideo(kind) {
    this._enqueueExportVideo(kind, { autostart: false });
  }

  _startQueuedExports() {
    if (this._activeExportJob || this._exportQueue.length === 0) return;
    this._setExportStatus(`Starting render queue (${this._exportQueue.length} queued)`);
    this._ensureExportWorker();
  }

  _exportVideo(kind) {
    this._enqueueExportVideo(kind, { autostart: true });
  }

  async _testDeterminationAttempts() {
    const source = this.app && this.app.simulator ? this.app.simulator.getScenario() : null;
    if (!source || source.name !== '100% Determination') {
      alert('Load/select the 100% Determination preset first.');
      return;
    }
    const btn = document.getElementById('btn-test-determination');
    const oldLabel = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Testing Determination...';
    }
    const sim = new Simulator();
    sim.setScenario(source);
    const noopRenderer = {
      confettiBurst() {},
      showPopup() {},
      schedulePopup() {},
      shatterObject() {},
      triggerFlash() {},
      addParticle() {},
    };
    const engine = new EventEngine({
      simulator: sim,
      renderer: noopRenderer,
      audio: { playWinFanfare() {} },
      triggerSlowmo() {},
    });
    engine.setRules(sim.scenario.events || []);

    const waitFrame = () => new Promise((resolve) => {
      if (window.requestAnimationFrame) window.requestAnimationFrame(resolve);
      else window.setTimeout(() => resolve((window.performance && window.performance.now) ? window.performance.now() : Date.now()), 16);
    });
    const dt = window.PHYSICS_CONST && window.PHYSICS_CONST.FIXED_DT
      ? window.PHYSICS_CONST.FIXED_DT
      : 1 / 60;
    const maxSeconds = Math.max(20, (sim.scenario.duration || 38.6) * 3);
    const maxSteps = Math.ceil(maxSeconds / dt);
    const startedAt = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    let stepsRun = 0;
    const attempts = new Map();
    const ensureAttempt = (id) => {
      const key = id || 'unknown';
      if (!attempts.has(key)) {
        attempts.set(key, {
          id: key,
          hearts: 0,
          maxHeartIndex: -1,
          maxProgress: 0,
          firstAt: null,
          lastAt: null,
        });
      }
      return attempts.get(key);
    };

    const runOneStep = () => {
      sim.step(dt);
      stepsRun++;
      const events = sim.lastEvents();
      const elapsed = sim.state.elapsedTime || 0;
      for (const ev of events) {
        if (ev.type !== 'heartEat') continue;
        const rec = ensureAttempt(ev.ballId);
        rec.hearts++;
        rec.maxHeartIndex = Math.max(rec.maxHeartIndex, Number.isFinite(ev.heartIndex) ? ev.heartIndex : -1);
        const target = Math.max(1, sim.state && Number.isFinite(sim.state._consumedHeartTarget) ? sim.state._consumedHeartTarget : 1);
        const consumed = sim.state && Number.isFinite(sim.state._consumedHearts) ? sim.state._consumedHearts : 0;
        rec.maxProgress = Math.max(rec.maxProgress, consumed / target);
        if (rec.firstAt == null) rec.firstAt = elapsed;
        rec.lastAt = elapsed;
      }
      engine.update(sim.state, events);
    };
    const testSpeed = 1;
    let lastFrameAt = startedAt;
    let simulatedTarget = 0;
    while (stepsRun < maxSteps && !(sim.state && sim.state._finished)) {
      const frameAt = await waitFrame();
      const frameDelta = Math.max(0, Math.min(0.1, (frameAt - lastFrameAt) / 1000));
      lastFrameAt = frameAt;
      simulatedTarget += frameDelta * testSpeed;
      let stepsThisFrame = 0;
      while ((stepsRun * dt) < simulatedTarget && stepsRun < maxSteps && stepsThisFrame < 8) {
        runOneStep();
        stepsThisFrame++;
        if (sim.state && sim.state._finished) break;
      }
      if (btn) {
        const consumed = sim.state && Number.isFinite(sim.state._consumedHearts) ? sim.state._consumedHearts : 0;
        const target = Math.max(1, sim.state && Number.isFinite(sim.state._consumedHeartTarget) ? sim.state._consumedHeartTarget : 1);
        const pct = Math.min(100, Math.round((consumed / target) * 100));
        btn.textContent = `Testing... ${pct}% (${(stepsRun * dt).toFixed(1)}s)`;
      }
    }
    const finishedAt = (window.performance && window.performance.now) ? window.performance.now() : Date.now();

    const ordered = Array.from(attempts.values()).sort((a, b) => {
      const na = Number(String(a.id).match(/(\d+)$/)?.[1] || 0);
      const nb = Number(String(b.id).match(/(\d+)$/)?.[1] || 0);
      return na - nb || a.id.localeCompare(b.id);
    });
    const total = sim.state && Number.isFinite(sim.state._consumedHearts) ? sim.state._consumedHearts : 0;
    const lines = [
      `Determination attempt test (${total} hearts total)`,
      `finished: ${!!(sim.state && sim.state._finished)}`,
      `simulated: ${(stepsRun * dt).toFixed(2)}s in ${stepsRun} steps`,
      `real time: ${((finishedAt - startedAt) / 1000).toFixed(2)}s`,
      '',
      ...ordered.map((a) =>
        `${a.id}: hearts=${a.hearts}, maxHeart=${a.maxHeartIndex}, progress=${(a.maxProgress * 100).toFixed(1)}%, first=${a.firstAt == null ? '-' : a.firstAt.toFixed(2)}s, last=${a.lastAt == null ? '-' : a.lastAt.toFixed(2)}s`
      ),
    ];
    const text = lines.join('\n');
    console.info(text);
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldLabel || 'Test Determination attempts';
    }
    alert(text);
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
          { key: 'speed', label: 'Speed', type: 'speed', min: 0, max: 6000, step: 10 },
          { key: 'vy', label: 'Vertical speed (vy)', type: 'number', min: -6000, max: 6000, step: 10, decimals: 0 },
          { key: 'initDir', label: 'Init dir', type: 'direction', min: -180, max: 180, step: 1, decimals: 0 },
          { key: 'randomInitDir', label: 'Random init dir', type: 'bool' },
          { key: 'fixed', label: 'Static', type: 'bool' },
          { key: 'ballBehaviorPreset', label: 'Behavior preset', type: 'select', options: BALL_BEHAVIOR_PRESET_OPTIONS },
          { key: 'maxSpeed', label: 'Max speed', type: 'number', min: 0, max: 2400, step: 10, decimals: 0 },
          { key: 'bounce', label: 'Bounce', type: 'number', min: 0, max: 1.5, step: 0.01, decimals: 2 },
          { key: 'wallCurve', label: 'Wall curve', type: 'number', min: 0, max: 1, step: 0.01, decimals: 2 },
          { key: 'wallDrift', label: 'Wall drift', type: 'number', min: 0, max: 1, step: 0.01, decimals: 2 },
          { key: 'wallBounceAngleRange', label: 'Wall bounce angle range', type: 'number', min: 0, max: 120, step: 1, decimals: 0 },
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
      fields.push(
        { key: 'recolorOnFreeze', label: 'Recolor on freeze', type: 'bool' },
        { key: 'deadColor', label: 'Freeze color', type: 'color' },
        { key: 'deathBurstOnFreeze', label: 'Freeze burst', type: 'bool' },
      );
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
    case 'overlayToggle':
      return [
        { key: 'enabled', label: 'Enabled', type: 'bool' },
      ];
    case 'overlayCountdown':
      return [
        { key: 'enabled', label: 'Enabled', type: 'bool' },
        { key: 'countdownMax', label: 'Countdown max', type: 'number', min: 1, max: 60, step: 1 },
        { key: 'countdownMode', label: 'Mode', type: 'select', options: [
          { value: 'loopTime', label: 'Loop time' },
          { value: 'activeBallLifetime', label: 'Active ball lifetime' },
          { value: 'repeatInterval', label: 'Repeat every N seconds' },
        ] },
        { key: 'countdownInterval', label: 'Repeat every (s)', type: 'number', min: 0.1, max: 60, step: 0.1, decimals: 1 },
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
        { key: 'insideOnly', label: 'Contain balls', type: 'bool' },
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
    case 'spinner':
      return [
        ...common,
        { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'armLength', label: 'Arm length', type: 'number', min: 30, max: 720, step: 1 },
        { key: 'thickness', label: 'Thickness', type: 'number', min: 4, max: 120, step: 1 },
        { key: 'rotationSpeed', label: 'Rotation speed', type: 'number', min: -6, max: 6, step: 0.01, decimals: 2 },
      ];
    case 'booster':
      return [
        { key: 'x', label: 'X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'radius', label: 'Radius', type: 'number', min: 8, max: 140, step: 1 },
        { key: 'color', label: 'Color', type: 'color' },
        { key: 'accentColor', label: 'Accent', type: 'color' },
        { key: 'strength', label: 'Boost strength', type: 'number', min: 0, max: 2000, step: 10 },
        { key: 'points', label: 'Points', type: 'number', min: -999, max: 9999, step: 1 },
        { key: 'label', label: 'Label', type: 'text' },
      ];
    case 'flipper':
      return [
        { key: 'x', label: 'Pivot X', type: 'number', min: 0, max: 1080, step: 1 },
        { key: 'y', label: 'Pivot Y', type: 'number', min: 0, max: 1920, step: 1 },
        { key: 'length', label: 'Length', type: 'number', min: 30, max: 520, step: 1 },
        { key: 'thickness', label: 'Thickness', type: 'number', min: 6, max: 100, step: 1 },
        { key: 'baseRotation', label: 'Base rotation', type: 'number', min: -Math.PI * 2, max: Math.PI * 2, step: 0.01, decimals: 2 },
        { key: 'swing', label: 'Swing amount', type: 'number', min: -Math.PI * 2, max: Math.PI * 2, step: 0.01, decimals: 2 },
        { key: 'frequency', label: 'Auto flips / s', type: 'number', min: 0.05, max: 6, step: 0.05, decimals: 2 },
        { key: 'phase', label: 'Phase', type: 'number', min: 0, max: 1, step: 0.01, decimals: 2 },
        { key: 'color', label: 'Color', type: 'color' },
        { key: 'strength', label: 'Hit strength', type: 'number', min: 0, max: 2000, step: 10 },
        { key: 'points', label: 'Points', type: 'number', min: -999, max: 9999, step: 1 },
        { key: 'label', label: 'Label', type: 'text' },
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
