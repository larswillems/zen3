// The Simulator glues together: scene (objects), RNG, physics, and lifecycle.
// A scenario is always re-created from its seed so Reset is bit-perfect.
//
// Extended for the Satisfying Loop Generator:
//   - scenario.loopDuration is the canonical period.
//   - scenario.satisfying toggles smooth/looping behavior (zero gravity,
//     orbital default motion, auto-snap rotations to integer cycles/loop).
//   - Helpers snap rotation speeds / orbit periods to clean ratios so the
//     final frame equals the first frame.

function getScenarioRuleActions(rule) {
  if (rule && Array.isArray(rule.actions)) return rule.actions.filter((action) => action && typeof action === 'object');
  if (rule && rule.action && typeof rule.action === 'object') return [rule.action];
  return [];
}

function ruleHasActionType(rule, type) {
  return getScenarioRuleActions(rule).some((action) => action && action.type === type);
}

function normalizeScenarioFinishActions(sc) {
  if (!sc || !Array.isArray(sc.events)) return sc;
  for (const rule of sc.events) {
    for (const action of getScenarioRuleActions(rule)) {
      if (action && action.type === 'finish' && action.seconds == null) action.seconds = 1.5;
    }
  }
  return sc;
}

function makeUniqueScenarioRuleId(rules, base) {
  const used = new Set((rules || []).map((rule) => String(rule && rule.id ? rule.id : '')));
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}_${n++}`;
  }
  return id;
}

function upgradeLegacyFinishFlow(sc) {
  if (!sc || !Array.isArray(sc.events)) return sc;
  if (sc.events.some((rule) =>
    (rule && rule.trigger && rule.trigger.type === 'finish') || ruleHasActionType(rule, 'finish')
  )) {
    return sc;
  }
  const ec = sc.endCondition || null;
  const applyUpgrade = (sourceTrigger, matchesRule, finishSeconds = 1.5) => {
    let converted = false;
    for (const rule of sc.events) {
      if (!rule || !rule.trigger || !matchesRule(rule.trigger)) continue;
      rule.trigger = { type: 'finish' };
      converted = true;
    }
    if (!converted) return;
    sc.events.unshift({
      id: makeUniqueScenarioRuleId(sc.events, 'finish_start'),
      once: true,
      trigger: sourceTrigger,
      action: { type: 'finish', seconds: Math.max(0, Number(finishSeconds) || 0) },
    });
    sc.endCondition = { type: 'finish' };
    sc.stopOnFirstEscape = false;
  };

  if (ec && ec.type === 'firstEscapeTail') {
    applyUpgrade(
      { type: 'firstEscape' },
      (trigger) => trigger && trigger.type === 'firstEscape',
      ec.tail != null ? ec.tail : 1.5,
    );
  } else if (ec && ec.type === 'ballCountTail') {
    const count = Math.max(0, ec.count | 0);
    applyUpgrade(
      { type: 'ballCount', count },
      (trigger) => trigger && trigger.type === 'ballCount' && Math.max(0, trigger.count | 0) === count,
      ec.tail != null ? ec.tail : 1.5,
    );
  } else if (ec && ec.type === 'bucketHitTail') {
    const bucketId = String(ec.bucketId || '');
    applyUpgrade(
      { type: 'bucketHit', bucketId },
      (trigger) => trigger && trigger.type === 'bucketHit' && String(trigger.bucketId || '') === bucketId,
      ec.tail != null ? ec.tail : 1.5,
    );
  } else if (ec && ec.type === 'allBallsGone') {
    applyUpgrade(
      { type: 'allGone' },
      (trigger) => trigger && trigger.type === 'allGone',
      ec.tail != null ? ec.tail : 1.5,
    );
  }
  return sc;
}

function clonePlainData(value) {
  return JSON.parse(JSON.stringify(value));
}

class Simulator {
  constructor() {
    this.scenario = this._defaultScenario();
    this.rng = new SeededRNG(this.scenario.seed);
    this.physics = new Physics(this.scenario.physics);
    this.state = { objects: [], time: 0, elapsedTime: 0, loopDuration: this.scenario.loopDuration, score: 0 };
    this._initialObjects = [];
    this.rebuild();
  }

  _defaultScenario() {
    const defaultVisuals = {
      glow: 1.0,
      pulse: true,
      freezeKeepAppearance: false,
      freezeGlowColor: '#bae6fd',
      freezeRimColor: '#e0f2fe',
      freezeOpacity: 0.75,
      freezeSpeckColor: '#e0f2fe',
      freezeSpeckCount: 3,
    };
    return {
      seed: 12345,
      version: 2,
      name: 'Untitled',
      loopDuration: 10,
      duration: 10,
      satisfying: true,
      physics: { gravity: 0, friction: 0 },
      overlay: { title: '', showTimer: false, showCounter: false, showScore: false },
      visuals: { ...defaultVisuals },
      objects: [],
      events: [],                // event-rule list: trigger -> action
      soundAssets: {},
      randomMode: false,
      stopOnFirstEscape: false,
    };
  }

  setScenario(scenario) {
    const defaultVisuals = {
      glow: 1.0,
      pulse: true,
      freezeKeepAppearance: false,
      freezeGlowColor: '#bae6fd',
      freezeRimColor: '#e0f2fe',
      freezeOpacity: 0.75,
      freezeSpeckColor: '#e0f2fe',
      freezeSpeckCount: 3,
    };
    const sc = JSON.parse(JSON.stringify(scenario));
    if (sc.loopDuration == null) sc.loopDuration = sc.duration || 10;
    if (sc.duration == null) sc.duration = sc.loopDuration;
    if (sc.satisfying == null) sc.satisfying = false;
    sc.visuals = { ...defaultVisuals, ...(sc.visuals || {}) };
    if (!sc.physics) sc.physics = { gravity: 0, friction: 0 };
    if (!sc.overlay) sc.overlay = { title: '', showTimer: false, showCounter: false, showScore: false };
    if (!Array.isArray(sc.events)) sc.events = [];
    if (!sc.soundAssets || typeof sc.soundAssets !== 'object') sc.soundAssets = {};
    upgradeLegacyFinishFlow(sc);
    normalizeScenarioFinishActions(sc);
    for (const obj of sc.objects || []) {
      if (!obj || typeof obj !== 'object') continue;
      if (obj.type === 'circle' || obj.type === 'arc' || obj.type === 'spiral' || obj.type === 'spikes') {
        obj.onGapPass = window.defaultGapPassConfig ? window.defaultGapPassConfig(obj.onGapPass || {}) : (obj.onGapPass || {});
      }
      if (obj.type === 'arc' && obj.insideOnly == null) obj.insideOnly = false;
    }
    this.scenario = sc;
    if (typeof window !== 'undefined') {
      const debugCfg = sc && sc.debug && sc.debug.collision;
      const prev = window.__collisionDebug;
      if (debugCfg && debugCfg.enabled) {
        window.__collisionDebug = {
          enabled: true,
          maxLogs: Math.max(0, debugCfg.maxLogs != null ? debugCfg.maxLogs : 1200),
          toConsole: debugCfg.toConsole !== false,
          verboseGap: !!debugCfg.verboseGap,
          _fromScenario: true,
        };
        window.__collisionDebugLogs = [];
      } else if (prev && prev._fromScenario) {
        window.__collisionDebug = false;
        window.__collisionDebugLogs = [];
      }
    }
    this.rebuild();
  }

  getScenario() {
    const scenario = clonePlainData(this.scenario);
    scenario.objects = (this.scenario.objects || []).map((o) => clonePlainData(serializeObject(o)));
    return scenario;
  }

  createSnapshot() {
    return {
      scenario: this.getScenario(),
      state: JSON.parse(JSON.stringify(this.state)),
      initialObjects: JSON.parse(JSON.stringify(this._initialObjects || [])),
      rng: this.rng ? { seed: this.rng.seed, state: this.rng.state } : null,
    };
  }

  static fromSnapshot(snapshot) {
    const sim = new Simulator();
    if (!snapshot || !snapshot.scenario) return sim;
    sim.setScenario(snapshot.scenario);
    if (Array.isArray(snapshot.initialObjects)) {
      sim._initialObjects = JSON.parse(JSON.stringify(snapshot.initialObjects));
    }
    if (snapshot.state) {
      sim.state = JSON.parse(JSON.stringify(snapshot.state));
    }
    if (snapshot.rng) {
      sim.rng = new SeededRNG(snapshot.rng.seed);
      sim.rng.state = snapshot.rng.state >>> 0;
    }
    sim.physics = new Physics(sim.scenario.physics);
    sim.physics.events = [];
    return sim;
  }

  setSeed(seed) {
    this.scenario.seed = seed;
    this.rebuild();
  }

  randomizeSeed() {
    this.scenario.seed = SeededRNG.randomSeed();
    this.rebuild();
  }

  setLoopDuration(seconds) {
    this.scenario.loopDuration = seconds;
    this.scenario.duration = seconds;
    this.rebuild();
  }

  setSatisfying(on) {
    this.scenario.satisfying = !!on;
    if (on) {
      // Turn off gravity/friction and lock every structure's rotation speed
      // to an integer number of revolutions per loop. This guarantees that
      // when t = loopDuration, every structure is back at its starting angle.
      this.scenario.physics.gravity = 0;
      this.scenario.physics.friction = 0;
      this.snapAllRotationsToLoop();
    }
    this.rebuild();
  }

  // --- Snapping helpers -------------------------------------------------

  // Round `speed` (rad/s) to the nearest integer-cycles-per-loop value.
  // Returns 0 when the scenario loop is undefined.
  snapRotationSpeed(speed, loopDuration = this.scenario.loopDuration) {
    if (!loopDuration || loopDuration <= 0) return speed;
    const cyclesPerLoop = Math.round(speed * loopDuration / (Math.PI * 2));
    return (Math.PI * 2) * cyclesPerLoop / loopDuration;
  }

  snapAllRotationsToLoop() {
    for (const o of this.scenario.objects) {
      if (typeof o.rotationSpeed === 'number') {
        o.rotationSpeed = this.snapRotationSpeed(o.rotationSpeed);
      }
    }
  }

  // --- Object management ------------------------------------------------

  _makeUniqueObjectId(desiredId, fallbackPrefix = 'obj', usedIds = null) {
    const used = usedIds || new Set(this.scenario.objects.map((o) => o.id));
    const base = String(desiredId || fallbackPrefix);
    if (!used.has(base)) return base;
    const prefix = base.replace(/_\d+$/, '') || fallbackPrefix;
    let n = 1;
    let candidate = `${prefix}_${n}`;
    while (used.has(candidate)) {
      n++;
      candidate = `${prefix}_${n}`;
    }
    return candidate;
  }

  _ensureUniqueScenarioIds() {
    const used = new Set();
    for (const o of this.scenario.objects) {
      const prefix = o && o.type ? o.type : 'obj';
      o.id = this._makeUniqueObjectId(o.id, prefix, used);
      used.add(o.id);
    }
  }

  addObject(obj) {
    obj.id = this._makeUniqueObjectId(obj.id, obj.type || 'obj');
    this.scenario.objects.push(obj);
    this.rebuild();
    return obj;
  }

  removeObject(id) {
    this.scenario.objects = this.scenario.objects.filter((o) => o.id !== id);
    this.rebuild();
  }

  duplicateObject(id) {
    const src = this.scenario.objects.find((o) => o.id === id);
    if (!src) return null;
    const clone = JSON.parse(JSON.stringify(serializeObject(src)));
    clone.id = this._makeUniqueObjectId(clone.id, clone.type || 'obj');
    if (clone.type === 'ball' && clone.motion === 'orbit') {
      // Nudge the phase so duplicates look like symmetry partners.
      clone.orbitPhase = (clone.orbitPhase || 0) + Math.PI / 6;
    } else {
      clone.x += 40; clone.y += 40;
    }
    this.scenario.objects.push(clone);
    this.rebuild();
    return clone;
  }

  updateObject(id, patch) {
    const obj = this.scenario.objects.find((o) => o.id === id);
    if (!obj) return;
    Object.assign(obj, patch);
    this.rebuild();
  }

  // Add N evenly-phase-offset clones of a source ball (symmetry spawner).
  // The group becomes a perfectly radial pattern when motion === 'orbit'.
  addSymmetryGroup(sourceBall, count) {
    const created = [];
    for (let i = 0; i < count; i++) {
      const clone = JSON.parse(JSON.stringify(serializeObject(sourceBall)));
      clone.id = this._makeUniqueObjectId(clone.id, 'ball');
      clone.orbitPhase = (sourceBall.orbitPhase || 0) + (i * Math.PI * 2 / count);
      this.scenario.objects.push(clone);
      created.push(clone);
    }
    this.rebuild();
    return created;
  }

  // --- Rebuild (canonical reset) ---------------------------------------

  rebuild() {
    this.rng = new SeededRNG(this.scenario.seed);
    this.physics = new Physics(this.scenario.physics);
    this._ensureUniqueScenarioIds();

    if (this.scenario.randomMode && !this.scenario.satisfying) {
      this._randomizeBallKinematics();
    }

    this._initialObjects = JSON.parse(JSON.stringify(
      this.scenario.objects.map((o) => serializeObject(o))
    ));
    this.state = {
      loopDuration: this.scenario.loopDuration,
      objects: this._initialObjects.map((o) => {
        const obj = { ...o, alive: !o.templateOnly, age: 0 };
        if (obj.type === 'ball') { obj._trail = []; obj._frozen = false; obj._escaped = false; }
        if (obj.type === 'timer') { obj._timerStartElapsed = 0; }
        return obj;
      }),
      time: 0,
      elapsedTime: 0,
      score: 0,
      ballsUsedCount: this._initialObjects.filter((o) => o && o.type === 'ball').length,
    };

    const initDirRng = this.rng.fork(17);
    for (const obj of this.state.objects) {
      if (obj.type !== 'ball' || obj.motion !== 'physics' || !obj.randomInitDir) continue;
      const speed = Math.hypot(obj.vx || 0, obj.vy || 0);
      if (speed <= 1e-6) continue;
      const angle = initDirRng.angle();
      obj.vx = Math.cos(angle) * speed;
      obj.vy = Math.sin(angle) * speed;
    }

    // Pre-roll: if any balls use parametric motion we step once at t=0 so
    // their positions match their orbit formula before the first render.
    this.physics.snapOrbitBalls(this.state);
  }

  _randomizeBallKinematics() {
    const ballRng = this.rng.fork(1);
    for (const o of this.scenario.objects) {
      if (o.type !== 'ball' || o.motion !== 'physics') continue;
      const speed = ballRng.range(200, 520);
      const angle = ballRng.angle();
      o.vx = Math.cos(angle) * speed;
      o.vy = Math.sin(angle) * speed;
    }
  }

  step(dt) {
    this.physics.step(this.state, dt);
    const authoredBallCount = (this.scenario.objects || [])
      .filter((o) => o && o.type === 'ball')
      .length;
    const spawnedBallCount = (this.state.objects || [])
      .filter((o) => o && o.type === 'spawner')
      .reduce((sum, spawner) => sum + Math.max(0, spawner._spawnCount || 0), 0);
    this.state.ballsUsedCount = Math.max(
      this.state.ballsUsedCount || 0,
      authoredBallCount + spawnedBallCount,
      this.state.objects.filter((o) => o && o.type === 'ball').length,
    );
    this.state.elapsedTime = (this.state.elapsedTime || 0) + dt;
    // Wrap loop time to keep floating-point error from drifting over long runs.
    // We do NOT clear trails: for orbit balls the path repeats exactly each
    // loop, so the trail ends up looking identical every cycle.
    if (this.state.loopDuration > 0 && this.state.time >= this.state.loopDuration) {
      this.state.time -= this.state.loopDuration;
    }
  }

  lastEvents() {
    return this.physics.events;
  }
}

window.Simulator = Simulator;
