// Event / trigger system.
//
// A "rule" is a trigger + an action:
//   { id, trigger: {type, ...params}, action: {type, ...params}, once }
//
// After every physics step, the EventEngine evaluates each unfired rule's
// trigger against the current state and the physics events emitted during
// that step. If the trigger matches, the action is applied (renderer
// effects, state mutations, simulator multipliers, etc.).
//
// Rules are deterministic: they only look at simulation state and the
// deterministic physics events.

const TRIGGER_TYPES = [
  { value: 'firstEscape', label: 'First ball escapes' },
  { value: 'firstDestroyed', label: 'First ball destroyed' },
  { value: 'ballFrozen', label: 'Any ball freezes' },
  { value: 'score', label: 'Any score bin hit' },
  { value: 'bucketHit', label: 'Specific bucket hit', params: ['bucketId'] },
  { value: 'scoreCount', label: 'After N scores', params: ['count'] },
  { value: 'scoreTotal', label: 'Score reaches N', params: ['points'] },
  { value: 'allGone', label: 'All balls gone' },
  { value: 'ballCount', label: 'Ball count drops to N', params: ['count'] },
  { value: 'time', label: 'At time t seconds', params: ['seconds'] },
  { value: 'loopEnd', label: 'End of each loop' },
  { value: 'escapeCount', label: 'After N escapes', params: ['count'] },
];

const ACTION_TYPES = [
  { value: 'confetti', label: 'Confetti burst' },
  { value: 'shatter', label: 'Shatter all structures' },
  { value: 'flash', label: 'Screen flash', params: ['color'] },
  { value: 'text', label: 'Show text', params: ['text', 'seconds'] },
  { value: 'slowmo', label: 'Slow motion', params: ['factor', 'seconds'] },
  { value: 'destroyAll', label: 'Destroy all balls' },
  { value: 'spawnBurst', label: 'Spawn burst of balls', params: ['count'] },
  { value: 'spawnBall', label: 'Spawn one ball', params: ['templateId', 'x', 'y', 'vy', 'color'] },
  { value: 'pause', label: 'Pause simulation' },
];

function scenarioHasFinishEvent(scenario) {
  const rules = scenario && Array.isArray(scenario.events) ? scenario.events : [];
  return rules.some((rule) => {
    const t = rule && rule.trigger && rule.trigger.type;
    return t === 'firstEscape' || t === 'escapeCount';
  });
}

class EventEngine {
  constructor(app) {
    this.app = app;
    this.rules = [];
    this._state = {}; // { [ruleId]: { fired, escapeCount, ... } }
    this._prevAlive = 0;
  }

  setRules(rules) {
    this.rules = rules || [];
    this.reset();
  }

  reset() {
    this._state = {};
    for (const r of this.rules) {
      this._state[r.id] = { fired: false, escapeCount: 0, destroyCount: 0, scoreCount: 0 };
    }
    this._prevAlive = -1;
    this._prevLoopTime = 0;
    this._prevScore = 0;
  }

  // Called once per physics step from the main loop.
  update(simState, events) {
    const alive = simState.objects.filter((o) => o.type === 'ball' && o.alive && !o._escaped).length;
    const score = simState && simState.score != null ? simState.score : 0;
    const stopOnEscape = !!(this.app && this.app.simulator && this.app.simulator.scenario
      && this.app.simulator.scenario.stopOnFirstEscape
      && scenarioHasFinishEvent(this.app.simulator.scenario));
    const escapedThisTick = events.some((e) => e.type === 'escape');
    this._updateTimerObjects(simState, events, alive);

    for (const rule of this.rules) {
      if (!this._state[rule.id]) {
        this._state[rule.id] = { fired: false, escapeCount: 0, destroyCount: 0, scoreCount: 0 };
      }
      const s = this._state[rule.id];

      // Accumulate counters even for non-triggering steps.
      for (const ev of events) {
        if (ev.type === 'escape') s.escapeCount++;
        if (ev.type === 'destroy') s.destroyCount++;
        if (ev.type === 'score') s.scoreCount++;
      }

      const fireOnce = rule.once !== false;
      if (fireOnce && s.fired) continue;
      // Once an escape ends the run, only allow the escape/win rules to fire
      // in that same tick. This prevents "one last" freeze/timer/spawn rule
      // from sneaking in before App pauses the simulation.
      if (stopOnEscape && escapedThisTick) {
        const t = rule.trigger && rule.trigger.type;
        if (t !== 'firstEscape' && t !== 'escapeCount') continue;
      }
      if (this._evalTrigger(rule.trigger, simState, events, s, alive, score)) {
        s.fired = true;
        this._applyAction(rule.action || {}, simState);
      }
    }

    this._prevAlive = alive;
    this._prevLoopTime = simState.time;
    this._prevScore = score;
  }

  _updateTimerObjects(state, events, alive) {
    const elapsed = state && state.elapsedTime != null ? state.elapsedTime : (state.time || 0);
    const hadAliveBefore = this._prevAlive > 0;
    const anyBallCollision = events.some((e) => e.type === 'bounce');
    const anyBallBallCollision = events.some((e) => e.type === 'bounce' && (e.source === 'ballBall' || e.source === 'fixedBall'));
    const anyCircleHit = events.some((e) => e.type === 'bounce' && (e.source === 'circle' || e.source === 'arc' || e.source === 'spikes'));
    const ballGone = this._prevAlive >= 0 && alive < this._prevAlive;
    const lastBallGone = hadAliveBefore && alive === 0;
    const firstEscape = events.some((e) => e.type === 'escape');
    for (const o of state.objects) {
      if (o.type !== 'timer') continue;
      if (o._timerStartElapsed == null) o._timerStartElapsed = 0;
      const resetOn = o.resetOn || 'never';
      const shouldReset =
        resetOn === 'ballCollision' ? anyBallCollision :
        resetOn === 'ballBallCollision' ? anyBallBallCollision :
        resetOn === 'circleHit' ? anyCircleHit :
        resetOn === 'ballGone' ? ballGone :
        resetOn === 'lastBallGone' ? lastBallGone :
        resetOn === 'firstEscape' ? firstEscape :
        false;
      if (shouldReset) o._timerStartElapsed = elapsed;
    }
  }

  _evalTrigger(trigger, state, events, s, alive, score = 0) {
    if (!trigger) return false;
    switch (trigger.type) {
      case 'firstEscape':
        return events.some((e) => e.type === 'escape');
      case 'firstDestroyed':
        return events.some((e) => e.type === 'destroy');
      case 'ballFrozen':
        return events.some((e) => e.type === 'freeze');
      case 'score':
        return events.some((e) => e.type === 'score');
      case 'bucketHit':
        return events.some((e) => e.type === 'score' && String(e.bucketId || '') === String(trigger.bucketId || ''));
      case 'scoreCount':
        return s.scoreCount >= (trigger.count || 1);
      case 'scoreTotal':
        return this._prevScore < (trigger.points || 0) && score >= (trigger.points || 0);
      case 'allGone':
        // Fire only after we've had balls alive at some point.
        if (this._prevAlive > 0 && alive === 0) return true;
        return false;
      case 'ballCount':
        return this._prevAlive > (trigger.count | 0) && alive <= (trigger.count | 0);
      case 'time':
        return (state.elapsedTime != null ? state.elapsedTime : state.time) >= (trigger.seconds || 0);
      case 'loopEnd':
        // Loop wrap = time went backwards since the previous step.
        return state.time < this._prevLoopTime - 1e-6;
      case 'escapeCount':
        return s.escapeCount >= (trigger.count || 1);
      default:
        return false;
    }
  }

  _pickActionBall(state, mode) {
    const aliveBalls = state.objects.filter((o) => o.type === 'ball' && o.alive && !o._escaped);
    if (mode === 'lastBall') return aliveBalls[0] || null;
    return aliveBalls[0] || null;
  }

  _resolveActionColor(action, state, fallback = '#ffffff') {
    if (action.colorFrom === 'lastBall') {
      const b = this._pickActionBall(state, 'lastBall');
      if (b && b.color) return b.color;
    }
    return action.color || fallback;
  }

  _applyAction(action, state) {
    const renderer = this.app.renderer;
    const sim = this.app.simulator;
    switch (action.type) {
      case 'confetti': {
        renderer.confettiBurst(540, 960, 260);
        break;
      }
      case 'shatter': {
        const exceptLastBall = action.except === 'lastBall';
        const preservedBall = exceptLastBall ? this._pickActionBall(state, 'lastBall') : null;
        const targets = state.objects.filter((o) => o !== preservedBall);
        const pieces = action.pieces != null ? Math.max(8, action.pieces | 0) : 0;
        const perTarget = pieces > 0 && targets.length > 0 ? Math.max(8, Math.round(pieces / targets.length)) : null;
        for (const o of targets) {
          renderer.shatterObject(o, {
            samples: perTarget,
            burstScale: action.burstScale != null ? action.burstScale : 1,
          });
        }
        state.objects = preservedBall ? [preservedBall] : [];
        if (action.winnerText) {
          const winnerColor = preservedBall && preservedBall.color ? preservedBall.color : '#ffffff';
          renderer.showPopup(action.winnerText, action.seconds || 2, winnerColor, winnerColor);
        }
        // Euphoric win fanfare — this is the moment of resolution.
        if (this.app.audio) this.app.audio.playWinFanfare();
        break;
      }
      case 'flash': {
        renderer.triggerFlash(this._resolveActionColor(action, state, '#ffffff'), 0.9);
        break;
      }
      case 'text': {
        const color = this._resolveActionColor(action, state, '#ffffff');
        renderer.showPopup(action.text || 'ZEN', action.seconds || 2, color, color);
        break;
      }
      case 'slowmo': {
        const factor = action.factor != null ? action.factor : 0.25;
        const seconds = action.seconds != null ? action.seconds : 1.5;
        this.app.triggerSlowmo(factor, seconds);
        break;
      }
      case 'destroyAll': {
        for (const o of state.objects) {
          if (o.type === 'ball' && o.alive) {
            o.alive = false;
            renderer.addParticle(o.x, o.y, o.color, 18);
          }
        }
        break;
      }
      case 'spawnBurst': {
        const n = action.count || 12;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          state.objects.push({
            id: `burst_${Math.random().toString(36).slice(2, 8)}_${i}`,
            type: 'ball',
            x: 540, y: 960,
            vx: Math.cos(a) * 420, vy: Math.sin(a) * 420,
            radius: 16,
            color: `hsl(${(i * 360 / n) | 0}, 80%, 60%)`,
            trail: true, trailLength: 40,
            lifetime: 0, bounce: 1.0, destroyOnSpike: true,
            alive: true, age: 0,
            motion: 'physics',
            orbitCx: 540, orbitCy: 960, orbitRadius: 280,
            orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
            lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
            _trail: [],
          });
        }
        break;
      }
      case 'spawnBall': {
        // Deterministic one-off spawn, typically driven by a ballFrozen
        // trigger. Uses the simulator RNG for the horizontal jitter so
        // replays with the same seed produce the same scene.
        //
        // When `templateId` is set we look that ball up in the AUTHORED
        // scenario (not the live state) so radius/color/trail/bounce/
        // lifetime/destroy+freeze behaviour are read fresh every spawn.
        // Editing the template ball at runtime -- e.g. dragging its radius
        // slider -- makes every subsequent spawn use the new value, which
        // is the whole point of "template ball" semantics.
        state._spawnSeq = (state._spawnSeq || 0) + 1;

        let tpl = null;
        if (action.templateId && sim.scenario && Array.isArray(sim.scenario.objects)) {
          tpl = sim.scenario.objects.find(
            (o) => o.type === 'ball' && o.id === action.templateId
          );
        }

        // Template properties win over action-level fallbacks. Motion is
        // always forced to 'physics' -- a parametric template would be
        // meaningless for a one-shot dynamic spawn.
        const pick = (k, fallback) => (tpl && tpl[k] !== undefined ? tpl[k] : fallback);
        const radius         = pick('radius', action.radius != null ? action.radius : 22);
        const color          = pick('color',  action.color || '#a78bfa');
        const trail          = pick('trail',  true);
        const trailLength    = pick('trailLength', 60);
        const clearTrailOnDeath = pick('clearTrailOnDeath', true);
        const bounce         = pick('bounce', 1.0);
        const wallCurve      = pick('wallCurve', 0);
        const wallDrift      = pick('wallDrift', 0);
        const collisionSpread = pick('collisionSpread', 0.35);
        const softBody       = pick('softBody', false);
        const elasticity     = pick('elasticity', 0.35);
        const recoverySpeed  = pick('recoverySpeed', 7.0);
        const wobbleIntensity = pick('wobbleIntensity', 0.28);
        const wobbleDamping  = pick('wobbleDamping', 8.0);
        const changeColorOnBallCollision = pick('changeColorOnBallCollision', false);
        const lifetime       = pick('lifetime', 0);
        const freezeOnTimeout = pick('freezeOnTimeout', false);
        const deadColor      = pick('deadColor', '#3a3a3a');
        const recolorOnFreeze = pick('recolorOnFreeze', false);
        const deathBurstOnFreeze = pick('deathBurstOnFreeze', false);
        const deathSound     = pick('deathSound', '');
        const bounceSound    = pick('bounceSound', '');
        const escapeSound    = pick('escapeSound', '');
        const destroySound   = pick('destroySound', '');
        const destroyOnSpike = pick('destroyOnSpike', false);
        const freezeOnSpike  = pick('freezeOnSpike', true);

        // Template-ball spawns should follow the template ball's current
        // authored position. That lets the user move the template in the
        // Properties panel and have all future spawns come from the new spot.
        const x = pick('spawnX', pick('x', action.x != null ? action.x : 540));
        const y = pick('spawnY', pick('y', action.y != null ? action.y : 560));
        // vx / vy default to the template ball's initial velocity, so spawns
        // follow the exact same opening trajectory as the authored ball
        // unless the action explicitly overrides them. Pair this with
        // `jitter: 0` in the scenario to get perfectly identical launches.
        const vx0 = action.vx != null ? action.vx : pick('vx', 0);
        const vy = action.vy != null ? action.vy : pick('vy', 260);
        const jitter = action.jitter != null ? action.jitter : 0;
        let spawnColor = color;
        if (action.randomColor && sim.rng) {
          const palette = Array.isArray(action.colorPalette) && action.colorPalette.length
            ? action.colorPalette
            : ['#f43f5e', '#ec4899', '#d946ef', '#a855f7', '#8b5cf6', '#6366f1', '#3b82f6'];
          const last = state._lastSpawnColor || (tpl && tpl.color) || null;
          const choices = palette.filter((c) => c !== last);
          const usable = choices.length > 0 ? choices : palette;
          spawnColor = usable[Math.floor(sim.rng.range(0, usable.length))];
          state._lastSpawnColor = spawnColor;
        }

        const vx = vx0 + (jitter && sim.rng ? sim.rng.range(-jitter, jitter) : 0);
        state.objects.push({
          id: `spawn_${state._spawnSeq}`,
          type: 'ball',
          x, y, vx, vy,
          radius, color: spawnColor,
          trail, trailLength, clearTrailOnDeath,
          lifetime, freezeOnTimeout, bounce, wallCurve, wallDrift, collisionSpread,
          softBody, elasticity, recoverySpeed, wobbleIntensity, wobbleDamping,
          changeColorOnBallCollision,
          deadColor, recolorOnFreeze, deathBurstOnFreeze,
          bounceSound, escapeSound, destroySound, deathSound,
          destroyOnSpike, freezeOnSpike,
          alive: true, age: 0,
          motion: 'physics',
          orbitCx: 540, orbitCy: 960, orbitRadius: 280,
          orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
          lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
          _trail: [], _frozen: false,
        });
        break;
      }
      case 'pause': {
        this.app.pause();
        break;
      }
    }
  }
}

window.TRIGGER_TYPES = TRIGGER_TYPES;
window.ACTION_TYPES = ACTION_TYPES;
window.EventEngine = EventEngine;
window.scenarioHasFinishEvent = scenarioHasFinishEvent;
