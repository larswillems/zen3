// Event / trigger system.
//
// A "rule" is a trigger + one or more actions:
//   { id, trigger: {type, ...params}, action: {type, ...params}, once }
//   { id, trigger: {type, ...params}, actions: [{type, ...params}, ...], once }
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
  { value: 'finish', label: 'On finish' },
  { value: 'firstDestroyed', label: 'First ball destroyed' },
  { value: 'ballFrozen', label: 'Any ball freezes' },
  { value: 'gapPass', label: 'Any ball goes to outer circle' },
  { value: 'specificGapPass', label: 'Specific circle reached', params: ['circleId'] },
  { value: 'outermostGapPass', label: 'Any ball reaches outermost circle' },
  { value: 'score', label: 'Any score bin hit' },
  { value: 'bucketHit', label: 'Specific bucket hit', params: ['bucketId'] },
  { value: 'scoreCount', label: 'After N scores', params: ['count'] },
  { value: 'scoreTotal', label: 'Score reaches N', params: ['points'] },
  { value: 'allGone', label: 'All active balls gone' },
  { value: 'allCirclesGone', label: 'All circles gone' },
  { value: 'ballCount', label: 'Active ball count drops to N', params: ['count'] },
  { value: 'time', label: 'At time t seconds', params: ['seconds'] },
  { value: 'everySeconds', label: 'Every N seconds', params: ['seconds'] },
  { value: 'loopEnd', label: 'End of each loop' },
  { value: 'escapeCount', label: 'After N escapes', params: ['count'] },
];

const ACTION_TYPES = [
  { value: 'finish', label: 'To finish', params: ['seconds'] },
  { value: 'clearScreen', label: 'Clear screen' },
  { value: 'confetti', label: 'Confetti burst' },
  { value: 'shatter', label: 'Shatter all structures' },
  { value: 'flash', label: 'Screen flash', params: ['color'] },
  { value: 'text', label: 'Show text', params: ['text', 'seconds'] },
  { value: 'slowmo', label: 'Slow motion', params: ['factor', 'seconds'] },
  { value: 'freezeBall', label: 'Freeze active ball' },
  { value: 'destroyAll', label: 'Destroy all balls' },
  { value: 'spawnBurst', label: 'Spawn burst of balls', params: ['count'] },
  { value: 'spawnBall', label: 'Spawn one ball', params: ['templateId', 'x', 'y', 'vy', 'color'] },
  { value: 'pause', label: 'Pause simulation' },
];

function getRuleActions(rule) {
  if (rule && Array.isArray(rule.actions)) {
    const actions = rule.actions.filter((action) => action && typeof action === 'object');
    if (actions.length) return actions;
  }
  if (rule && rule.action && typeof rule.action === 'object') return [rule.action];
  return [];
}

function isActiveBall(o) {
  return !!(o
    && o.type === 'ball'
    && o.alive
    && !o._escaped
    && !o._frozen
    && !o.fixed);
}

function scenarioHasFinishEvent(scenario) {
  const rules = scenario && Array.isArray(scenario.events) ? scenario.events : [];
  return rules.some((rule) => {
    const t = rule && rule.trigger && rule.trigger.type;
    return t === 'firstEscape' || t === 'escapeCount' || t === 'finish';
  });
}

function estimateActionTailSeconds(action) {
  if (!action || typeof action !== 'object') return 0;
  switch (action.type) {
    case 'confetti':
      return 2.2;
    case 'shatter':
      return Math.max(2.4, Number(action.seconds) || 0);
    case 'flash':
      return 0.9;
    case 'text':
      return Math.max(0, Number(action.delay) || 0) + Math.max(0, Number(action.seconds) || 2);
    case 'slowmo':
      return Math.max(0, Number(action.seconds) || 1.5);
    case 'destroyAll':
      return 0.9;
    default:
      return 0;
  }
}

function finishActionDelaySeconds(action) {
  if (!action || typeof action !== 'object') return 1.5;
  if (action.seconds == null || action.seconds === '') return 1.5;
  return Math.max(0, Number(action.seconds) || 0);
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
        this._state[r.id] = { fired: false, escapeCount: 0, destroyCount: 0, scoreCount: 0, intervalCount: 0 };
    }
    this._prevAlive = -1;
    this._prevActiveCircles = -1;
    this._prevLoopTime = 0;
    this._prevScore = 0;
  }

  createSnapshot() {
    return {
      state: JSON.parse(JSON.stringify(this._state || {})),
      prevAlive: this._prevAlive,
      prevActiveCircles: this._prevActiveCircles,
      prevLoopTime: this._prevLoopTime,
      prevScore: this._prevScore,
    };
  }

  applySnapshot(snapshot) {
    if (!snapshot) {
      this.reset();
      return;
    }
    this._state = JSON.parse(JSON.stringify(snapshot.state || {}));
    this._prevAlive = Number.isFinite(snapshot.prevAlive) ? snapshot.prevAlive : -1;
    this._prevActiveCircles = Number.isFinite(snapshot.prevActiveCircles) ? snapshot.prevActiveCircles : -1;
    this._prevLoopTime = Number.isFinite(snapshot.prevLoopTime) ? snapshot.prevLoopTime : 0;
    this._prevScore = Number.isFinite(snapshot.prevScore) ? snapshot.prevScore : 0;
  }

  // Called once per physics step from the main loop.
  update(simState, events) {
    const alive = simState.objects.filter((o) => isActiveBall(o)).length;
    const activeCircles = simState.objects.filter((o) => o.type === 'circle' && !o._gapRemoved).length;
    const score = simState && simState.score != null ? simState.score : 0;
    const stopOnEscape = !!(this.app && this.app.simulator && this.app.simulator.scenario
      && this.app.simulator.scenario.stopOnFirstEscape
      && scenarioHasFinishEvent(this.app.simulator.scenario));
    const escapedThisTick = events.some((e) => e.type === 'escape');
    this._updateTimerObjects(simState, events, alive);
    this._maybeEmitPendingFinish(simState, events);

    const runRulePass = (mode = 'normal') => {
      let finishTriggered = false;
      for (const rule of this.rules) {
        const triggerType = rule && rule.trigger && rule.trigger.type;
        if (mode === 'normal' && triggerType === 'finish') continue;
        if (mode === 'finish' && triggerType !== 'finish') continue;
        if (!this._state[rule.id]) {
          this._state[rule.id] = { fired: false, escapeCount: 0, destroyCount: 0, scoreCount: 0, intervalCount: 0 };
        }
        const s = this._state[rule.id];

        if (mode === 'normal') {
          for (const ev of events) {
            if (ev.type === 'escape') s.escapeCount++;
            if (ev.type === 'destroy') s.destroyCount++;
            if (ev.type === 'score') s.scoreCount++;
          }
        }

        const fireOnce = rule.once !== false;
        if (fireOnce && s.fired) continue;
        if (mode === 'normal' && stopOnEscape && escapedThisTick) {
          if (triggerType !== 'firstEscape' && triggerType !== 'escapeCount') continue;
        }
        if (this._evalTrigger(rule.trigger, simState, events, s, alive, activeCircles, score)) {
          s.fired = true;
          const actions = getRuleActions(rule);
          if (actions.length === 0) {
            if (this._applyAction({}, simState, events)) finishTriggered = true;
          }
          for (const action of actions) {
            if (this._applyAction(action || {}, simState, events)) finishTriggered = true;
          }
          if (mode === 'normal' && finishTriggered) break;
        }
      }
      return finishTriggered;
    };

    const finishTriggered = runRulePass('normal');
    if (finishTriggered || events.some((e) => e.type === 'finish')) runRulePass('finish');

    this._prevAlive = alive;
    this._prevActiveCircles = activeCircles;
    this._prevLoopTime = simState.time;
    this._prevScore = score;
  }

  _estimateFinishTailSeconds() {
    let tail = 0;
    for (const rule of this.rules) {
      if (!rule || !rule.trigger || rule.trigger.type !== 'finish') continue;
      for (const action of getRuleActions(rule)) {
        tail = Math.max(tail, estimateActionTailSeconds(action));
      }
    }
    return tail;
  }

  _maybeEmitPendingFinish(state, events) {
    if (!state || state._finished || !state._finishPending) return false;
    const elapsed = state.elapsedTime != null ? state.elapsedTime : (state.time || 0);
    const dueAt = Number.isFinite(state._finishDueAt) ? state._finishDueAt : elapsed;
    if (elapsed + 1e-6 < dueAt) return false;
    const tail = Math.max(0, Number.isFinite(state._finishTail) ? state._finishTail : this._estimateFinishTailSeconds());
    state._finishPending = false;
    state._finished = true;
    state._finishAt = elapsed;
    state._finishTail = tail;
    events.push({ type: 'finish', at: elapsed, tail });
    return true;
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

  _getOutermostGapObjectIds(state) {
    const objs = state && Array.isArray(state.objects) ? state.objects : [];
    let maxRadius = -Infinity;
    const ids = new Set();
    for (const obj of objs) {
      if (!obj || obj._gapRemoved) continue;
      if ((obj.type !== 'circle' && obj.type !== 'arc') || obj.insideOnly === false) continue;
      const radius = Number(obj.radius);
      if (!Number.isFinite(radius)) continue;
      if (radius > maxRadius + 1e-6) {
        maxRadius = radius;
        ids.clear();
        if (obj.id) ids.add(String(obj.id));
      } else if (Math.abs(radius - maxRadius) <= 1e-6 && obj.id) {
        ids.add(String(obj.id));
      }
    }
    return ids;
  }

  _evalTrigger(trigger, state, events, s, alive, activeCircles, score = 0) {
    if (!trigger) return false;
    switch (trigger.type) {
      case 'firstEscape':
        return events.some((e) => e.type === 'escape');
      case 'finish':
        return events.some((e) => e.type === 'finish');
      case 'firstDestroyed':
        return events.some((e) => e.type === 'destroy');
      case 'ballFrozen':
        return events.some((e) => e.type === 'freeze');
      case 'gapPass':
        return events.some((e) => e.type === 'gapPass');
      case 'specificGapPass':
        return events.some((e) =>
          e.type === 'gapPass' && String(e.gapObjectId || '') === String(trigger.circleId || '')
        );
      case 'outermostGapPass': {
        const ids = this._getOutermostGapObjectIds(state);
        if (ids.size === 0) return false;
        return events.some((e) => e.type === 'gapPass' && ids.has(String(e.gapObjectId || '')));
      }
      case 'score':
        return events.some((e) => e.type === 'score');
      case 'bucketHit':
        return events.some((e) => e.type === 'score' && String(e.bucketId || '') === String(trigger.bucketId || ''));
      case 'scoreCount':
        return s.scoreCount >= (trigger.count || 1);
      case 'scoreTotal':
        return this._prevScore < (trigger.points || 0) && score >= (trigger.points || 0);
      case 'consumedHearts':
        return (state && (state._consumedHearts || 0)) >= Math.max(1, trigger.count || 1);
      case 'allGone':
        // Fire only after we've had balls alive at some point.
        if (this._prevAlive > 0 && alive === 0) return true;
        return false;
      case 'allCirclesGone':
        // Fire only after there were active circles before.
        if (this._prevActiveCircles > 0 && activeCircles === 0) return true;
        return false;
      case 'ballCount':
        return this._prevAlive > (trigger.count | 0) && alive <= (trigger.count | 0);
      case 'time':
        return (state.elapsedTime != null ? state.elapsedTime : state.time) >= (trigger.seconds || 0);
      case 'everySeconds': {
        const seconds = Math.max(0.01, trigger.seconds || 1);
        const elapsed = state.elapsedTime != null ? state.elapsedTime : state.time;
        const intervalCount = Math.floor(Math.max(0, elapsed) / seconds);
        if (intervalCount > (s.intervalCount || 0)) {
          s.intervalCount = intervalCount;
          return true;
        }
        return false;
      }
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
    const activeBalls = state.objects.filter((o) => isActiveBall(o));
    const aliveBalls = state.objects.filter((o) => o.type === 'ball' && o.alive && !o._escaped);
    if (mode === 'activeBall') return activeBalls[0] || null;
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

  _freezeBall(ball, events = []) {
    if (!ball || !ball.alive || ball._escaped || ball._frozen || ball.fixed) return false;
    ball._frozen = true;
    ball.vx = 0;
    ball.vy = 0;
    const burstColor = ball.color;
    if (ball.recolorOnFreeze) ball.color = ball.deadColor || '#3a3a3a';
    if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
    const ev = {
      type: 'freeze',
      x: ball.x, y: ball.y, color: burstColor,
      deathBurst: !!ball.deathBurstOnFreeze,
      deathSound: ball.deathSound || '',
    };
    events.push(ev);
    if (this.app && this.app.renderer && typeof this.app.renderer.handleEvents === 'function') {
      this.app.renderer.handleEvents([ev]);
    }
    return true;
  }

  _applyAction(action, state, events = []) {
    const renderer = this.app.renderer;
    const sim = this.app.simulator;
    switch (action.type) {
      case 'finish': {
        if (state._finished) return false;
        const elapsed = state && state.elapsedTime != null ? state.elapsedTime : (state.time || 0);
        const tail = this._estimateFinishTailSeconds();
        const delay = finishActionDelaySeconds(action);
        if (delay <= 1e-6) {
          state._finishPending = false;
          state._finished = true;
          state._finishAt = elapsed;
          state._finishTail = tail;
          events.push({ type: 'finish', at: elapsed, tail });
          return true;
        }
        const dueAt = elapsed + delay;
        if (state._finishPending) {
          state._finishDueAt = Math.min(
            Number.isFinite(state._finishDueAt) ? state._finishDueAt : dueAt,
            dueAt,
          );
          state._finishTail = Math.max(0, Number(state._finishTail) || 0, tail);
        } else {
          state._finishPending = true;
          state._finishRequestedAt = elapsed;
          state._finishDueAt = dueAt;
          state._finishTail = tail;
        }
        return false;
      }
      case 'clearScreen': {
        state.objects = [];
        if (renderer && typeof renderer.clearTransientFx === 'function') renderer.clearTransientFx();
        break;
      }
      case 'confetti': {
        renderer.confettiBurst(540, 960, 260);
        break;
      }
      case 'shatter': {
        const exceptLastBall = action.except === 'lastBall';
        const preservedBall = exceptLastBall ? this._pickActionBall(state, 'lastBall') : null;
        const targets = state.objects.filter((o) => o !== preservedBall);
        // Default to the "Battle of the Colors" look: lots of tiny shards
        // raining downward, unless a specific shatter config overrides it.
        const defaultPieces = 4000;
        const pieces = action.pieces != null ? Math.max(8, action.pieces | 0) : defaultPieces;
        const perTarget = pieces > 0 && targets.length > 0 ? Math.max(8, Math.round(pieces / targets.length)) : null;
        for (const o of targets) {
          const shatterOpts = {
            samples: perTarget,
            burstScale: action.burstScale != null ? action.burstScale : 1.1,
            downwardBias: action.downwardBias != null ? action.downwardBias : 260,
            lifeBase: action.lifeBase,
            lifeRange: action.lifeRange,
          };
          if (action.rain || action.rain == null) shatterOpts.rain = true;
          if (action.baseSpeed != null) shatterOpts.baseSpeed = action.baseSpeed;
          else shatterOpts.baseSpeed = 180;
          if (action.speedRange != null) shatterOpts.speedRange = action.speedRange;
          else shatterOpts.speedRange = 420;
          if (action.sizeMin != null) shatterOpts.sizeMin = action.sizeMin;
          else shatterOpts.sizeMin = 2;
          if (action.sizeMax != null) shatterOpts.sizeMax = action.sizeMax;
          else shatterOpts.sizeMax = 4;
          renderer.shatterObject(o, shatterOpts);
        }
        state.objects = preservedBall ? [preservedBall] : [];
        if (action.winnerText || action.winnerColorMap) {
          const winnerColor = preservedBall && preservedBall.color ? preservedBall.color : '#ffffff';
          let text = action.winnerText || 'WINNER';
          if (preservedBall && preservedBall.color && action.winnerColorMap) {
            const mapped = action.winnerColorMap[preservedBall.color];
            if (mapped) text = mapped;
          }
          const popupOptions = {};
          if (action.winnerSize != null) popupOptions.size = action.winnerSize;
          renderer.showPopup(text, action.seconds || 2, winnerColor, winnerColor, popupOptions);
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
        const text = String(action.text || 'ZEN')
          .replace(/\{score\}/g, String(state && Number.isFinite(state.score) ? (state.score | 0) : 0));
        const args = [
          text,
          action.seconds || 2,
          color,
          action.shadowColor || color,
          { size: action.size },
        ];
        if (action.delay && renderer && typeof renderer.schedulePopup === 'function') {
          renderer.schedulePopup(action.delay, ...args);
        } else {
          renderer.showPopup(...args);
        }
        break;
      }
      case 'slowmo': {
        const factor = action.factor != null ? action.factor : 0.25;
        const seconds = action.seconds != null ? action.seconds : 1.5;
        this.app.triggerSlowmo(factor, seconds);
        break;
      }
      case 'freezeBall': {
        this._freezeBall(this._pickActionBall(state, 'activeBall'), events);
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
        if (action.maxSpawns != null && (state._spawnSeq || 0) >= Math.max(0, action.maxSpawns | 0)) {
          break;
        }
        if (action.resetConsumablesOnSpawn) {
          for (const obj of state.objects || []) {
            if (obj && obj.type === 'spikes' && obj.consumable) obj._eatenSpikes = {};
          }
        }
        state._spawnSeq = (state._spawnSeq || 0) + 1;

        let tpl = null;
        let templateId = action.templateId;
        if (Array.isArray(action.templateIds) && action.templateIds.length) {
          const idx = Math.max(0, Math.min(action.templateIds.length - 1, (state._spawnSeq || 1) - 1));
          templateId = action.templateIds[idx];
        }
        if (templateId && sim.scenario && Array.isArray(sim.scenario.objects)) {
          tpl = sim.scenario.objects.find(
            (o) => o.type === 'ball' && o.id === templateId
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
        const randomInitDir  = pick('randomInitDir', false);
        const gravityScale   = pick('gravityScale', 1);
        const upwardGravityScale = pick('upwardGravityScale', null);
        const gravityScaleDelay = pick('gravityScaleDelay', 0);
        const lateGravityScale = pick('lateGravityScale', null);
        const lateUpwardGravityScale = pick('lateUpwardGravityScale', null);
        const linearDamping  = pick('linearDamping', 0);
        const linearDampingDelay = pick('linearDampingDelay', 0);
        const bounce         = pick('bounce', 1.0);
        const wallCurve      = pick('wallCurve', 0);
        const wallDrift      = pick('wallDrift', 0);
        const wallEnergyLoss = pick('wallEnergyLoss', 0);
        const wallBounceAngleRange = pick('wallBounceAngleRange', 0);
        const collisionSpread = pick('collisionSpread', 0.35);
        const maxSpeed       = pick('maxSpeed', 0);
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
        const bounceSoundOn  = pick('bounceSoundOn', 'all');
        const escapeSound    = pick('escapeSound', '');
        const destroySound   = pick('destroySound', '');
        const collisionHoleEnabled = pick('collisionHoleEnabled', false);
        const collisionHoleSize = pick('collisionHoleSize', 0.42);
        const collisionHoleTarget = pick('collisionHoleTarget', 'auto');
        const collisionHolePlacement = pick('collisionHolePlacement', 'impact');
        const collisionHoleOnCircle = pick('collisionHoleOnCircle', true);
        const collisionHoleOnArc = pick('collisionHoleOnArc', false);
        const collisionHoleOnSpikes = pick('collisionHoleOnSpikes', false);
        const collisionHoleOnSpinner = pick('collisionHoleOnSpinner', false);
        const collisionHoleOnBall = pick('collisionHoleOnBall', false);
        const collisionHoleOnFixedBall = pick('collisionHoleOnFixedBall', false);
        const destroyOnSpike = pick('destroyOnSpike', false);
        const freezeOnSpike  = pick('freezeOnSpike', true);
        const consumeSpikesOnTouch = pick('consumeSpikesOnTouch', false);
        const consumeRadius = pick('consumeRadius', 0);
        const consumeMaxPerTick = pick('consumeMaxPerTick', 0);
        const consumeVelocityScale = pick('consumeVelocityScale', 1);
        const consumeFromHeartIndex = pick('consumeFromHeartIndex', null);
        const consumeUntilHeartIndex = pick('consumeUntilHeartIndex', null);
        const removeAfterHeartCap = pick('removeAfterHeartCap', true);
        const eatSound = pick('eatSound', '');
        const removeOnUpturnAfterDrop = pick('removeOnUpturnAfterDrop', false);
        const removeAfterDropMinDy = pick('removeAfterDropMinDy', 120);
        const removeOnUpturnVy = pick('removeOnUpturnVy', -40);
        const removeOnUpturnMinAge = pick('removeOnUpturnMinAge', 0.25);
        const removeOnUpturnStaleAfter = pick('removeOnUpturnStaleAfter', 0.45);
        const removeOnUpturnNoProgressDy = pick('removeOnUpturnNoProgressDy', 36);
        const removeOnUpturnMinHearts = pick('removeOnUpturnMinHearts', 1);
        const removeWhenStalledAfter = pick('removeWhenStalledAfter', 0);
        const removeWhenStalledSpeed = pick('removeWhenStalledSpeed', 18);

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

        const baseVx = vx0 + (jitter && sim.rng ? sim.rng.range(-jitter, jitter) : 0);
        let vx = baseVx;
        let spawnVy = vy;
        if (action.vxStepPerSpawn != null) vx += (state._spawnSeq || 0) * Number(action.vxStepPerSpawn);
        if (action.vyStepPerSpawn != null) spawnVy += (state._spawnSeq || 0) * Number(action.vyStepPerSpawn);
        if (action.speedScalePerSpawn != null) {
          const scale = 1 + Math.max(0, state._spawnSeq || 0) * Number(action.speedScalePerSpawn);
          vx *= scale;
          spawnVy *= scale;
        }
        if (randomInitDir && sim.rng) {
          const speed = Math.hypot(baseVx || 0, vy || 0);
          if (speed > 1e-6) {
            const angle = sim.rng.angle();
            vx = Math.cos(angle) * speed;
            spawnVy = Math.sin(angle) * speed;
          }
        }
        state.objects.push({
          id: `spawn_${state._spawnSeq}`,
          type: 'ball',
          templateSourceId: templateId || '',
          x, y, vx, vy: spawnVy,
          radius, color: spawnColor,
          trail, trailLength, clearTrailOnDeath, randomInitDir, gravityScale, upwardGravityScale,
          gravityScaleDelay, lateGravityScale, lateUpwardGravityScale, linearDamping, linearDampingDelay,
          lifetime, freezeOnTimeout, bounce, wallCurve, wallDrift, wallEnergyLoss, wallBounceAngleRange, collisionSpread,
          maxSpeed,
          softBody, elasticity, recoverySpeed, wobbleIntensity, wobbleDamping,
          changeColorOnBallCollision,
          deadColor, recolorOnFreeze, deathBurstOnFreeze,
          bounceSound, bounceSoundOn, escapeSound, destroySound, deathSound,
          collisionHoleEnabled, collisionHoleSize, collisionHoleTarget, collisionHolePlacement,
          collisionHoleOnCircle, collisionHoleOnArc, collisionHoleOnSpikes,
          collisionHoleOnSpinner, collisionHoleOnBall, collisionHoleOnFixedBall,
          destroyOnSpike, freezeOnSpike,
          consumeSpikesOnTouch, consumeRadius, consumeMaxPerTick, consumeVelocityScale, consumeFromHeartIndex, consumeUntilHeartIndex, removeAfterHeartCap, eatSound,
          removeOnUpturnAfterDrop, removeAfterDropMinDy, removeOnUpturnVy, removeOnUpturnMinAge,
          removeOnUpturnStaleAfter, removeOnUpturnNoProgressDy, removeOnUpturnMinHearts,
          removeWhenStalledAfter, removeWhenStalledSpeed,
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
    return false;
  }
}

window.TRIGGER_TYPES = TRIGGER_TYPES;
window.ACTION_TYPES = ACTION_TYPES;
window.EventEngine = EventEngine;
window.scenarioHasFinishEvent = scenarioHasFinishEvent;
