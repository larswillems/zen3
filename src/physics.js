// Deterministic physics engine.
//
// Key rules that keep simulations reproducible:
//  1. Step with a FIXED dt (1/60 by default). Wall-clock time never leaks in.
//  2. All random numbers come from the scenario RNG.
//  3. No Math.random, no Date.now, no performance.now in the update path.
//  4. Collision resolution is order-stable: we always iterate objects in a
//     deterministic order (their array order).
//
// The engine mutates objects in place; callers are responsible for snapshotting
// before a run if they want to reset.

const FIXED_DT = 1 / 60;
const GRAVITY = 900; // px/s^2, tuned to feel good at 1080x1920

// Canvas logical size. We keep one coordinate system and scale at render time.
const WORLD_W = 1080;
const WORLD_H = 1920;
const COLLISION_COLOR_PALETTE = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#22d3ee'];

function normalizeAngle(a) {
  a = a % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a;
}

function shortestAngleDelta(from, to) {
  let delta = normalizeAngle(to) - normalizeAngle(from);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Returns true if angle `a` (radians) lies inside a gap whose center rotates
// with `rotation` and spans `gapSize` radians.
function angleInGap(a, gapStart, gapSize, rotation) {
  if (gapSize <= 0) return false;
  const start = normalizeAngle(gapStart + rotation);
  const end = normalizeAngle(start + gapSize);
  a = normalizeAngle(a);
  const edgeEps = 1e-4;
  if (start <= end) return a > start + edgeEps && a < end - edgeEps;
  return a > start + edgeEps || a < end - edgeEps;
}

function spikeInGap(relAngle, gapStart, gapSize) {
  if (gapSize <= 0) return false;
  const start = normalizeAngle(gapStart);
  const end = normalizeAngle(start + gapSize);
  const a = normalizeAngle(relAngle);
  return start <= end ? (a >= start && a <= end) : (a >= start || a <= end);
}

function ballFitsCircleGap(ball, c, time = 0, angle = null, rotationOverride = null) {
  const rawGap = effectiveCircleGapSize(c, time);
  if (rawGap <= 0) return false;
  // The ball's center has to clear the radial gap edges at the INNERMOST part
  // of the ring band, where the angular clearance is tightest. Using the bare
  // ring radius here is too generous and can let a ball clip the gap border.
  const clearanceRadius = Math.max(
    1e-6,
    (c.radius || 0) - ((c.thickness || 0) * 0.5) - (ball.radius || 0),
  );
  const ratio = Math.max(0, Math.min(0.999999, (ball.radius || 0) / clearanceRadius));
  const angularPad = Math.asin(ratio);
  const edgeSafety = Math.max(0.0025, Math.min(0.02, 0.8 / clearanceRadius));
  const totalPad = angularPad + edgeSafety;
  const usableGap = rawGap - totalPad * 2;
  if (usableGap <= 1e-6) return false;
  const a = angle != null ? angle : Math.atan2((ball.y || 0) - (c.y || 0), (ball.x || 0) - (c.x || 0));
  const rotation = rotationOverride != null ? rotationOverride : (c.rotation || 0);
  return angleInGap(a, c.gapStart + totalPad, usableGap, rotation);
}

function ballSweepsThroughCircleGap(ball, c, time = 0, prevAngle = null, angle = null, prevRotation = null, rotation = null, debug = null) {
  const currentRotation = rotation != null ? rotation : (c.rotation || 0);
  const previousRotation = prevRotation != null
    ? prevRotation
    : (c._prevRotation != null ? c._prevRotation : currentRotation);
  const prevX = (ball._prevX != null ? ball._prevX : ball.x) - (c.x || 0);
  const prevY = (ball._prevY != null ? ball._prevY : ball.y) - (c.y || 0);
  const currX = (ball.x || 0) - (c.x || 0);
  const currY = (ball.y || 0) - (c.y || 0);
  const prevDist = Math.hypot(prevX, prevY);
  const currDist = Math.hypot(currX, currY);
  const innerLimit = Math.max(1e-6, (c.radius || 0) - ((c.thickness || 0) * 0.5) - (ball.radius || 0));
  const outerLimit = Math.max(innerLimit + 1e-6, (c.radius || 0) + ((c.thickness || 0) * 0.5) + (ball.radius || 0));
  const intervals = circleBandIntervalsOnSegment(prevX, prevY, currX, currY, innerLimit, outerLimit);
  if (!intervals.length) {
    if (typeof debug === 'function') debug({ result: 'noBandInterval' });
    return false;
  }
  const traversal = selectCircleGapTraversalInterval(intervals, prevDist, currDist, innerLimit, outerLimit);
  if (!traversal) {
    if (typeof debug === 'function') debug({ result: 'noTraversal' });
    return false;
  }
  const rotationDelta = shortestAngleDelta(previousRotation, currentRotation);
  const motionLen = Math.hypot(currX - prevX, currY - prevY);
  const sampleCount = Math.max(
    13,
    Math.min(81, gapTraversalSampleCount(ball, c, traversal.start, traversal.end, motionLen, rotationDelta) * 2),
  );
  const samples = sampleIntervalTimes(traversal.start, traversal.end, sampleCount);
  for (const t of samples) {
    const px = lerp(prevX, currX, t);
    const py = lerp(prevY, currY, t);
    const sampleAngle = Math.atan2(py, px);
    const sampleRotation = previousRotation + rotationDelta * t;
    if (!ballFitsCircleGap(ball, c, time, sampleAngle, sampleRotation)) {
      if (typeof debug === 'function') {
        debug({
          result: 'sampleBlocked',
          t,
          px,
          py,
          sampleAngle,
          sampleRotation,
          sampleCount,
        });
      }
      return false;
    }
  }
  // `_collideCircleGapEdges()` already resolves actual radial-edge contacts with
  // zero extra slack before we get here. Using an additional positive margin in
  // the pass-check makes near-miss trajectories bounce even when the ball does
  // not truly touch the edge.
  const edgeHit = findCircleGapEdgeContact(ball, c, time, 0);
  if (edgeHit) {
    if (typeof debug === 'function') {
      debug({
        result: 'edgeContact',
        sampleCount,
        edgeIndex: edgeHit.edgeIndex,
        edgeAngle: edgeHit.edgeAngle,
        edgeDist: edgeHit.dist,
        edgeT: edgeHit.t,
      });
    }
    return false;
  }
  if (typeof debug === 'function') {
    debug({
      result: 'pass',
      sampleCount,
      traversalStart: traversal.start,
      traversalEnd: traversal.end,
    });
  }
  return true;
}

function effectiveCircleGapSize(c, time = 0) {
  const maxGap = Math.max(0, c.gapSize || 0);
  if (!c.gapPulse || maxGap <= 0) return maxGap;
  const minGap = Math.max(0, Math.min(maxGap, c.gapMinSize || 0));
  const span = maxGap - minGap;
  const speed = Math.max(0, c.gapPulseSpeed || 0);
  if (span <= 1e-6 || speed <= 1e-6) return maxGap;
  // Cosine starts fully open, then closes, then opens again.
  return minGap + span * (0.5 + 0.5 * Math.cos(time * speed * Math.PI * 2));
}

// Returns true if angle `a` lies inside [startAngle+rotation, endAngle+rotation].
function angleInArc(a, startAngle, endAngle, rotation) {
  const span = endAngle - startAngle;
  const start = normalizeAngle(startAngle + rotation);
  const end = normalizeAngle(start + span);
  a = normalizeAngle(a);
  if (start <= end) return a >= start && a <= end;
  return a >= start || a <= end;
}

class Physics {
  constructor(config = {}) {
    this.gravity = config.gravity !== undefined ? config.gravity : GRAVITY;
    this.friction = config.friction !== undefined ? config.friction : 0;
    this.worldW = WORLD_W;
    this.worldH = WORLD_H;
    this.events = []; // collision/destroy/escape events for particles, etc.
    this._debugCollisionCount = 0;
    this._debugSpawnerCount = 0;
  }

  _collisionDebugOptions() {
    const fallback = { enabled: false, maxLogs: 180, toConsole: true };
    if (typeof window === 'undefined') return fallback;
    const user = window.__collisionDebug;
    if (user === false) return { enabled: false, maxLogs: 0, toConsole: false };
    if (user === true) return { enabled: true, maxLogs: fallback.maxLogs, toConsole: true };
    if (user == null) return fallback;
    return {
      enabled: user.enabled !== false,
      maxLogs: Math.max(0, user.maxLogs != null ? user.maxLogs : fallback.maxLogs),
      toConsole: user.toConsole !== false,
      verboseGap: !!user.verboseGap,
    };
  }

  _debugCollision(kind, payload) {
    const opts = this._collisionDebugOptions();
    if (!opts.enabled) return;
    if (this._debugCollisionCount >= opts.maxLogs) return;
    this._debugCollisionCount++;
    const entry = {
      idx: this._debugCollisionCount,
      kind,
      time: Number((payload.time || 0).toFixed(4)),
      ...payload,
    };
    if (typeof window !== 'undefined') {
      if (!Array.isArray(window.__collisionDebugLogs)) window.__collisionDebugLogs = [];
      window.__collisionDebugLogs.push(entry);
      if (window.__collisionDebugLogs.length > opts.maxLogs) {
        window.__collisionDebugLogs.splice(0, window.__collisionDebugLogs.length - opts.maxLogs);
      }
    }
    if (opts.toConsole && typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info('[physics]', entry);
      if (this._debugCollisionCount === opts.maxLogs && typeof console.warn === 'function') {
        console.warn(`[physics] collision debug log limit reached (${opts.maxLogs}). Set window.__collisionDebug = { maxLogs: N } to capture more.`);
      }
    }
  }

  _verboseGapDebugEnabled() {
    return !!this._collisionDebugOptions().verboseGap;
  }

  _debugGap(kind, payload) {
    if (!this._verboseGapDebugEnabled()) return;
    this._debugCollision(kind, payload);
  }

  _spawnerDebugOptions() {
    const fallback = { enabled: false, maxLogs: 240, toConsole: true };
    if (typeof window === 'undefined') return fallback;
    const user = window.__spawnerDebug;
    if (user === false || user == null) return fallback;
    if (user === true) return { ...fallback, enabled: true };
    return {
      enabled: user.enabled !== false,
      maxLogs: Math.max(0, user.maxLogs != null ? user.maxLogs : fallback.maxLogs),
      toConsole: user.toConsole !== false,
    };
  }

  _debugSpawner(kind, payload) {
    const opts = this._spawnerDebugOptions();
    if (!opts.enabled) return;
    if (this._debugSpawnerCount >= opts.maxLogs) return;
    this._debugSpawnerCount++;
    const entry = {
      idx: this._debugSpawnerCount,
      kind,
      elapsedTime: Number((((payload && payload.elapsedTime) || 0)).toFixed(4)),
      loopTime: Number((((payload && payload.loopTime) || 0)).toFixed(4)),
      ...payload,
    };
    if (typeof window !== 'undefined') {
      if (!Array.isArray(window.__spawnerDebugLogs)) window.__spawnerDebugLogs = [];
      window.__spawnerDebugLogs.push(entry);
      if (window.__spawnerDebugLogs.length > opts.maxLogs) {
        window.__spawnerDebugLogs.splice(0, window.__spawnerDebugLogs.length - opts.maxLogs);
      }
    }
    if (opts.toConsole && typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info('[spawner]', entry);
    }
  }

  _shouldPurgeBall(ball) {
    if (!ball || ball.type !== 'ball' || ball.alive) return false;
    if (ball._captured) return true;
    const margin = Math.max(220, (ball.radius || 0) + 120);
    return (
      ball.x < -margin ||
      ball.x > this.worldW + margin ||
      ball.y < -margin ||
      ball.y > this.worldH + margin
    );
  }

  _pickEscapeContainer(ball, structures) {
    let best = null;
    let bestRadius = -Infinity;
    for (const s of structures) {
      if ((s.type !== 'circle' && s.type !== 'arc') || !s.insideOnly) continue;
      const rd = Math.hypot(ball.x - s.x, ball.y - s.y);
      const margin = ball.radius + (s.thickness || 0) * 0.5 + 4;
      if (rd <= (s.radius || 0) + margin && (s.radius || 0) > bestRadius) {
        best = s;
        bestRadius = s.radius || 0;
      }
    }
    return best;
  }

  _getGapPassConfig(obj) {
    const cfg = obj && obj.onGapPass;
    if (!cfg || !cfg.enabled) return null;
    return {
      enabled: true,
      outcome: cfg.outcome || 'escape',
      particleStyle: cfg.particleStyle || 'auto',
      removeObjectOnPass: !!cfg.removeObjectOnPass,
      soundMode: cfg.soundMode || 'none',
      soundPreset: cfg.soundPreset || 'glass',
      soundAssetId: cfg.soundAssetId || '',
      soundVolume: cfg.soundVolume != null ? Math.max(0, Math.min(2, cfg.soundVolume)) : 1,
    };
  }

  _buildGapSoundFields(cfg) {
    if (!cfg) return {};
    return {
      gapSoundMode: cfg.soundMode || 'none',
      gapSoundPreset: cfg.soundPreset || '',
      gapSoundAssetId: cfg.soundAssetId || '',
      gapSoundVolume: cfg.soundVolume != null ? cfg.soundVolume : 1,
    };
  }

  _getCollisionHoleConfig(ball) {
    if (!ball || !ball.collisionHoleEnabled) return null;
    return {
      enabled: true,
      size: Math.max(0.05, Math.min(Math.PI * 2 - 0.05, ball.collisionHoleSize != null ? ball.collisionHoleSize : 0.42)),
      target: ball.collisionHoleTarget || 'auto',
      placement: ball.collisionHolePlacement || 'impact',
      onCircle: !!ball.collisionHoleOnCircle,
      onArc: !!ball.collisionHoleOnArc,
      onSpikes: !!ball.collisionHoleOnSpikes,
      onSpinner: !!ball.collisionHoleOnSpinner,
      onBall: !!ball.collisionHoleOnBall,
      onFixedBall: !!ball.collisionHoleOnFixedBall,
    };
  }

  _collisionHoleEnabledForSource(cfg, sourceType) {
    if (!cfg) return false;
    switch (sourceType) {
      case 'circle': return cfg.onCircle;
      case 'arc': return cfg.onArc;
      case 'spikes': return cfg.onSpikes;
      case 'spinner': return cfg.onSpinner;
      case 'ball': return cfg.onBall;
      case 'fixedBall': return cfg.onFixedBall;
      default: return false;
    }
  }

  _collisionHoleCircles(state) {
    const objects = state && Array.isArray(state.objects) ? state.objects : [];
    return objects.filter((o) => o && o.type === 'circle' && !o._gapRemoved);
  }

  _collisionHoleContainingCircles(state, anchorX, anchorY, ballRadius = 0) {
    const circles = this._collisionHoleCircles(state);
    const margin = Math.max(6, ballRadius || 0);
    return circles
      .filter((circle) => {
        const dist = Math.hypot(anchorX - circle.x, anchorY - circle.y);
        return dist <= (circle.radius || 0) + (circle.thickness || 0) * 0.5 + margin;
      })
      .sort((a, b) => (a.radius || 0) - (b.radius || 0));
  }

  _pickCollisionHoleCircle(ball, source, state, cfg, info = {}) {
    const circles = this._collisionHoleCircles(state);
    if (!circles.length) return null;
    const anchorX = info.anchorX != null ? info.anchorX : (ball.x || 0);
    const anchorY = info.anchorY != null ? info.anchorY : (ball.y || 0);
    const containing = this._collisionHoleContainingCircles(state, anchorX, anchorY, ball.radius || 0);
    const nearest = circles.reduce((best, circle) => {
      const d = Math.hypot(anchorX - circle.x, anchorY - circle.y);
      if (!best || d < best.distance) return { circle, distance: d };
      return best;
    }, null);
    const hitCircle = source && source.type === 'circle' ? source : null;
    switch (cfg.target) {
      case 'hitCircle':
        return hitCircle;
      case 'nearestCircle':
        return nearest ? nearest.circle : null;
      case 'innermostContainingCircle':
        return containing[0] || null;
      case 'outermostContainingCircle':
        return containing.length ? containing[containing.length - 1] : null;
      case 'auto':
      default:
        return hitCircle || containing[0] || (nearest ? nearest.circle : null);
    }
  }

  _collisionHoleWorldAngle(circle, cfg, info = {}) {
    const impactX = info.anchorX != null ? info.anchorX : circle.x;
    const impactY = info.anchorY != null ? info.anchorY : circle.y;
    const impactAngle = Math.atan2(impactY - circle.y, impactX - circle.x);
    const incomingVx = Number.isFinite(info.incomingVx) ? info.incomingVx : 0;
    const incomingVy = Number.isFinite(info.incomingVy) ? info.incomingVy : 0;
    const incomingLen = Math.hypot(incomingVx, incomingVy);
    switch (cfg.placement) {
      case 'oppositeImpact':
        return impactAngle + Math.PI;
      case 'againstIncoming':
        return incomingLen > 1e-6 ? Math.atan2(-incomingVy, -incomingVx) : impactAngle;
      case 'withIncoming':
        return incomingLen > 1e-6 ? Math.atan2(incomingVy, incomingVx) : impactAngle;
      case 'impact':
      default:
        return impactAngle;
    }
  }

  _applyCollisionHole(circle, cfg, worldAngle) {
    if (!circle || !cfg) return false;
    const size = Math.max(0.05, Math.min(Math.PI * 2 - 0.05, cfg.size || 0));
    circle.gapSize = size;
    circle.gapStart = normalizeAngle(worldAngle - (circle.rotation || 0) - size * 0.5);
    if (circle.gapPulse && circle.gapMinSize > circle.gapSize) {
      circle.gapMinSize = circle.gapSize;
    }
    return true;
  }

  _maybeCreateCollisionHole(ball, source, sourceType, state, info = {}) {
    const cfg = this._getCollisionHoleConfig(ball);
    if (!cfg || !this._collisionHoleEnabledForSource(cfg, sourceType)) return false;
    const targetCircle = this._pickCollisionHoleCircle(ball, source, state, cfg, info);
    if (!targetCircle) return false;
    const worldAngle = this._collisionHoleWorldAngle(targetCircle, cfg, info);
    if (!this._applyCollisionHole(targetCircle, cfg, worldAngle)) return false;
    const x = info.anchorX != null ? info.anchorX : ball.x;
    const y = info.anchorY != null ? info.anchorY : ball.y;
    this.events.push({
      type: 'collisionHole',
      source: sourceType,
      x,
      y,
      color: targetCircle.color || ball.color,
      gapObjectId: targetCircle.id || null,
      gapObjectType: 'circle',
      gapObjectX: targetCircle.x != null ? targetCircle.x : null,
      gapObjectY: targetCircle.y != null ? targetCircle.y : null,
      gapObjectRadius: targetCircle.radius != null ? targetCircle.radius : null,
      gapObjectThickness: targetCircle.thickness != null ? targetCircle.thickness : null,
      gapSize: targetCircle.gapSize,
      gapStart: targetCircle.gapStart,
    });
    return true;
  }

  _gapPassOnCooldown(ball, objectId, timeSec) {
    if (!ball || !objectId) return false;
    return ball._lastGapPassObjectId === objectId
      && Math.abs((ball._lastGapPassTime || -Infinity) - timeSec) < 0.14;
  }

  _markGapPass(ball, objectId, timeSec) {
    ball._lastGapPassObjectId = objectId || null;
    ball._lastGapPassTime = timeSec || 0;
  }

  _handleGapPass(ball, object, state, info = {}) {
    const cfg = this._getGapPassConfig(object);
    if (!cfg) return false;
    const now = state && state.elapsedTime != null ? state.elapsedTime : (state.time || 0);
    if (this._gapPassOnCooldown(ball, object.id, now)) return false;
    this._markGapPass(ball, object.id, now);
    this._debugGap('gapPass', {
      ballId: ball.id,
      colliderId: object.id || null,
      colliderType: object.type || null,
      x: Number((ball.x || 0).toFixed(2)),
      y: Number((ball.y || 0).toFixed(2)),
      vx: Number((ball.vx || 0).toFixed(2)),
      vy: Number((ball.vy || 0).toFixed(2)),
      outcome: cfg.outcome,
      time: now,
    });

    const sound = this._buildGapSoundFields(cfg);
    const effect = cfg.particleStyle === 'auto' ? cfg.outcome : cfg.particleStyle;
    const speed = Math.max(260, Math.hypot(ball.vx || 0, ball.vy || 0));
    const dx = info.dx != null ? info.dx : ((ball.x || 0) - (object.x || 0));
    const dy = info.dy != null ? info.dy : ((ball.y || 0) - (object.y || 0));
    const len = Math.hypot(dx, dy) || 1;
    const nx = info.nx != null ? info.nx : dx / len;
    const ny = info.ny != null ? info.ny : dy / len;

    const baseEvent = {
      x: ball.x,
      y: ball.y,
      color: (object && (object.color || (Array.isArray(object.gradientColors) && object.gradientColors[0]))) || ball.color,
      gapObjectId: object.id || null,
      gapObjectType: object.type || null,
      gapObjectX: object.x != null ? object.x : null,
      gapObjectY: object.y != null ? object.y : null,
      gapObjectRadius: object.radius != null ? object.radius : null,
      gapObjectThickness: object.thickness != null ? object.thickness : null,
      gapOutcome: cfg.outcome,
      gapEffect: effect,
      ...sound,
    };

    if (cfg.removeObjectOnPass) {
      object._gapRemoved = true;
      baseEvent.gapRemoved = true;
    }

    if (cfg.outcome === 'escape') {
      ball._escaped = true;
      ball.alive = false;
      if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
      this.events.push({
        type: 'escape',
        escapeSound: ball.escapeSound || '',
        ...baseEvent,
      });
      return true;
    }

    if (cfg.outcome === 'destroy' || cfg.outcome === 'shatter' || cfg.outcome === 'burn') {
      ball.alive = false;
      if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
      this.events.push({
        type: 'destroy',
        destroySound: ball.destroySound || '',
        destroyStyle: cfg.outcome,
        ...baseEvent,
      });
      return true;
    }

    if (cfg.outcome === 'pass') {
      // Pure pass-through: keep the ball's real physics velocity. This is used
      // for entry gates where crossing a gap should not count as an escape.
    } else if (cfg.outcome === 'launchUp') {
      ball.vx = nx * speed * 0.35;
      ball.vy = -Math.max(420, speed * 1.15);
    } else if (cfg.outcome === 'launchDown') {
      ball.vx = nx * speed * 0.35;
      ball.vy = Math.max(420, speed * 1.15);
    } else {
      const launchSpeed = Math.max(460, speed * 1.1);
      ball.vx = nx * launchSpeed;
      ball.vy = ny * launchSpeed - Math.abs(ny) * 120;
    }
    this._clampBallSpeed(ball);

    this.events.push({
      type: 'gapPass',
      ...baseEvent,
    });
    return true;
  }

  _maybeHandleCircleGapPass(ball, circle, state) {
    const cfg = this._getGapPassConfig(circle);
    if (!cfg || !(circle.insideOnly !== false) || !(effectiveCircleGapSize(circle, state.time || 0) > 0)) return false;
    const prevDx = (ball._prevX != null ? ball._prevX : ball.x) - circle.x;
    const prevDy = (ball._prevY != null ? ball._prevY : ball.y) - circle.y;
    const dx = ball.x - circle.x;
    const dy = ball.y - circle.y;
    const prevDist = Math.hypot(prevDx, prevDy);
    const dist = Math.hypot(dx, dy);
    const crossedOut = prevDist <= (circle.radius || 0) && dist > (circle.radius || 0);
    if (!crossedOut) return false;
    const angle = Math.atan2(dy, dx);
    const prevAngle = Math.atan2(prevDy, prevDx);
    const sweepDebug = (details) => this._debugGap('gapSweep', {
      ballId: ball.id,
      colliderId: circle.id || null,
      colliderType: 'circle',
      x: Number((ball.x || 0).toFixed(2)),
      y: Number((ball.y || 0).toFixed(2)),
      prevDist: Number(prevDist.toFixed(2)),
      dist: Number(dist.toFixed(2)),
      angle: Number(angle.toFixed(4)),
      prevAngle: Number(prevAngle.toFixed(4)),
      time: state.time || 0,
      ...details,
    });
    if (!ballSweepsThroughCircleGap(ball, circle, state.time || 0, prevAngle, angle, null, null, sweepDebug)) return false;
    return this._handleGapPass(ball, circle, state, { dx, dy });
  }

  _maybeHandleArcGapPass(ball, arc, state) {
    const cfg = this._getGapPassConfig(arc);
    if (!cfg) return false;
    const prevX = ball._prevX != null ? ball._prevX : ball.x;
    const prevY = ball._prevY != null ? ball._prevY : ball.y;
    const prevDx = prevX - arc.x;
    const prevDy = prevY - arc.y;
    const dx = ball.x - arc.x;
    const dy = ball.y - arc.y;
    const prevDist = Math.hypot(prevDx, prevDy);
    const dist = Math.hypot(dx, dy);
    const band = (arc.thickness || 0) * 0.5 + ball.radius + 6;
    const crossedOut = prevDist <= (arc.radius || 0) && dist >= (arc.radius || 0) + Math.max(2, band * 0.12);
    if (!crossedOut) return false;
    const angle = Math.atan2(dy, dx);
    if (angleInArc(angle, arc.startAngle, arc.endAngle, arc.rotation || 0)) return false;
    return this._handleGapPass(ball, arc, state, { dx, dy });
  }

  _maybeHandleSpikesGapPass(ball, sp, state) {
    const cfg = this._getGapPassConfig(sp);
    if (!cfg || !(sp.gapSize > 0)) return false;
    const prevDx = (ball._prevX != null ? ball._prevX : ball.x) - sp.x;
    const prevDy = (ball._prevY != null ? ball._prevY : ball.y) - sp.y;
    const dx = ball.x - sp.x;
    const dy = ball.y - sp.y;
    const prevDist = Math.hypot(prevDx, prevDy);
    const dist = Math.hypot(dx, dy);
    const tipR = sp.inward ? sp.radius - sp.length : sp.radius + sp.length;
    const minR = Math.min(sp.radius, tipR);
    const maxR = Math.max(sp.radius, tipR);
    const margin = Math.max(8, ball.radius + 6);
    const crossed = Math.min(prevDist, dist) <= maxR + margin && Math.max(prevDist, dist) >= minR - margin;
    if (!crossed) return false;
    const angle = Math.atan2(dy, dx);
    if (!angleInGap(angle, sp.gapStart || 0, sp.gapSize || 0, sp.rotation || 0)) return false;
    return this._handleGapPass(ball, sp, state, { dx, dy });
  }

  _maybeHandleSpiralGapPass(ball, sp, state) {
    const cfg = this._getGapPassConfig(sp);
    if (!cfg || !(sp.gapSize > 0)) return false;
    const prevDx = (ball._prevX != null ? ball._prevX : ball.x) - sp.x;
    const prevDy = (ball._prevY != null ? ball._prevY : ball.y) - sp.y;
    const dx = ball.x - sp.x;
    const dy = ball.y - sp.y;
    const prevDist = Math.hypot(prevDx, prevDy);
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const layers = Math.max(1, sp.layers | 0);
    const step = ((sp.outerRadius || 0) - (sp.innerRadius || 0)) / layers;
    const margin = (sp.thickness || 0) * 0.5 + ball.radius + 4;
    for (let i = 0; i < layers; i++) {
      const r = (sp.innerRadius || 0) + step * (i + 0.5);
      const rot = (sp.rotation || 0) + i * (Math.PI * 2 / layers);
      const crossed = Math.min(prevDist, dist) <= r + margin && Math.max(prevDist, dist) >= r - margin;
      if (!crossed) continue;
      if (!angleInGap(angle, 0, sp.gapSize || 0, rot)) continue;
      return this._handleGapPass(ball, sp, state, { dx, dy });
    }
    return false;
  }

  _maybeHandleStructureGapPass(ball, structure, state) {
    if (!ball.alive || ball._escaped) return false;
    if (structure.type === 'circle') return this._maybeHandleCircleGapPass(ball, structure, state);
    if (structure.type === 'arc') return this._maybeHandleArcGapPass(ball, structure, state);
    if (structure.type === 'spiral') return this._maybeHandleSpiralGapPass(ball, structure, state);
    if (structure.type === 'spikes') return this._maybeHandleSpikesGapPass(ball, structure, state);
    return false;
  }

  _collideCircleGapEdges(ball, c, time, contactKey) {
    const best = findCircleGapEdgeContact(ball, c, time, 0);
    if (!best) return false;
    this._debugGap('gapEdgeCandidate', {
      ballId: ball.id,
      colliderId: c.id || null,
      colliderType: 'circle',
      x: Number((ball.x || 0).toFixed(2)),
      y: Number((ball.y || 0).toFixed(2)),
      distToEdge: Number((best.dist || 0).toFixed(4)),
      edgeIndex: best.edgeIndex,
      edgeAngle: Number((best.edgeAngle || 0).toFixed(4)),
      edgeT: Number(((best.t != null ? best.t : -1)).toFixed(4)),
      time,
    });
    const prevX = ball._prevX != null ? ball._prevX : ball.x;
    const prevY = ball._prevY != null ? ball._prevY : ball.y;
    if (best.t != null) {
      ball.x = lerp(prevX, ball.x, best.t);
      ball.y = lerp(prevY, ball.y, best.t);
    }
    let nx = 0;
    let ny = 0;
    if (best.dist > 1e-6) {
      nx = best.dx / best.dist;
      ny = best.dy / best.dist;
    } else {
      const fallbackAngle = best.edgeAngle + Math.PI * 0.5;
      nx = Math.cos(fallbackAngle);
      ny = Math.sin(fallbackAngle);
    }
    const push = Math.max(0, (ball.radius || 0) - best.dist) + 0.01;
    ball.x += nx * push;
    ball.y += ny * push;
    const impactSpeed = Math.abs(ball.vx * nx + ball.vy * ny);
    this._reflect(ball, nx, ny, ball.bounce);
    this._afterWallBounce(ball, nx, ny);
    this._applySoftBodyImpact(ball, nx, ny, impactSpeed);
    if (!ball._ringContact[contactKey]) {
      this.events.push({
        type: 'bounce',
        source: 'circle',
        x: ball.x,
        y: ball.y,
        color: ball.color,
        ballId: ball.id,
        colliderId: c.id,
        colliderType: 'circle',
        branch: best.edgeIndex === 0 ? 'gapEdgeStart' : 'gapEdgeEnd',
        bounceSound: ball.bounceSound || '',
        bounceSoundOn: ball.bounceSoundOn || 'all',
      });
      this._debugCollision('circle', {
        ballId: ball.id,
        colliderId: c.id,
        colliderType: 'circle',
        branch: best.edgeIndex === 0 ? 'gapEdgeStart' : 'gapEdgeEnd',
        x: Number(ball.x.toFixed(2)),
        y: Number(ball.y.toFixed(2)),
        push: Number(push.toFixed(2)),
        distToEdge: Number(best.dist.toFixed(2)),
        gapSize: Number((effectiveCircleGapSize(c, time) || 0).toFixed(3)),
        insideOnly: !!c.insideOnly,
      });
      ball._ringContact[contactKey] = true;
    }
    return true;
  }

  _circleRectOverlap(cx, cy, radius, rx, ry, rw, rh) {
    const qx = Math.max(rx, Math.min(rx + rw, cx));
    const qy = Math.max(ry, Math.min(ry + rh, cy));
    const dx = cx - qx;
    const dy = cy - qy;
    return dx * dx + dy * dy <= radius * radius;
  }

  _softNoise(ball, salt = 0) {
    const id = String((ball && ball.id) || 'ball');
    let h = 2166136261 >>> 0;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h = (h ^ Math.imul((ball._softImpactCount || 0) + 1 + salt, 2246822519)) >>> 0;
    return (h >>> 0) / 4294967295;
  }

  _awardScoreBin(ball, bin, state) {
    if (ball._scored) return;
    const width = Math.max(20, bin.width || 0);
    const height = Math.max(20, bin.height || 0);
    const top = (bin.y || 0) - height * 0.5;
    const points = Number.isFinite(bin.points) ? (bin.points | 0) : 0;
    const label = bin.label != null && String(bin.label).trim()
      ? String(bin.label)
      : `${points >= 0 ? '+' : ''}${points}`;
    ball._scored = true;
    state.score = (state.score || 0) + points;
    this.events.push({
      type: 'score',
      source: 'scoreBin',
      x: ball.x,
      y: Math.max(top + 24, Math.min(top + height - 24, ball.y)),
      color: bin.color || ball.color,
      textColor: bin.textColor || '#ffffff',
      ballId: ball.id,
      bucketId: bin.id || null,
      points,
      label,
    });
  }

  _stepCapturedScoreBin(ball, state) {
    const bin = ball && ball._capturedBin;
    if (!ball || !bin) return false;
    const width = Math.max(20, bin.width || 0);
    const height = Math.max(20, bin.height || 0);
    const left = (bin.x || 0) - width * 0.5;
    const right = left + width;
    const bottom = (bin.y || 0) + height * 0.5;
    const pad = Math.max(4, Math.min(10, (ball.radius || 0) * 0.35));
    const minX = left + (ball.radius || 0) + pad;
    const maxX = right - (ball.radius || 0) - pad;
    if (minX <= maxX) {
      ball.x = Math.max(minX, Math.min(maxX, ball.x));
    }
    const centerPull = (bin.x || ball.x) - ball.x;
    ball.vx = (ball.vx || 0) * 0.72 + centerPull * 0.08;
    if ((ball.vy || 0) < 140) ball.vy = 140;
    const floorY = bottom - (ball.radius || 0) - pad;
    if (ball.y < floorY) return true;
    ball.y = floorY;
    if (minX <= maxX) {
      ball.x = Math.max(minX, Math.min(maxX, ball.x));
    }
    ball.vx = 0;
    ball.vy = 0;
    ball.fixed = true;
    ball._captured = true;
    if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
    if ((bin.scoreTrigger || 'top') === 'bottom') {
      this._awardScoreBin(ball, bin, state);
    }
    return true;
  }

  _checkScoreBins(ball, scoreBins, state) {
    if (!ball || !ball.alive || ball._escaped || ball.fixed || ball._frozen) return false;
    if (!Array.isArray(scoreBins) || scoreBins.length === 0) return false;
    if ((ball.vy || 0) < -40) return false;
    if (ball._capturedBin) return this._stepCapturedScoreBin(ball, state);
    if (ball._scored) return false;
    if (!ball._scoreBinContact) ball._scoreBinContact = Object.create(null);
    for (let i = 0; i < scoreBins.length; i++) {
      const bin = scoreBins[i];
      const key = bin.id || `scoreBin_${i}`;
      const width = Math.max(20, bin.width || 0);
      const height = Math.max(20, bin.height || 0);
      const captureWidth = Math.max(20, Math.min(width, bin.captureWidth != null ? bin.captureWidth : width));
      const left = (bin.x || 0) - captureWidth * 0.5;
      const top = (bin.y || 0) - height * 0.5;
      const inside = this._circleRectOverlap(ball.x, ball.y, ball.radius || 0, left, top, captureWidth, height);
      if (!inside) {
        ball._scoreBinContact[key] = false;
        continue;
      }
      if (ball._scoreBinContact[key]) continue;
      ball._scoreBinContact[key] = true;
      const captureMode = bin.captureMode || 'consume';
      if (captureMode === 'settle') {
        // `scoreTrigger` lets the user decide whether a settle-bin scores when
        // the ball crosses the top lip ("top") or only after it reaches the
        // bottom and comes to rest ("bottom").
        if ((bin.scoreTrigger || 'top') !== 'bottom') {
          this._awardScoreBin(ball, bin, state);
        }
        ball._capturedBin = bin;
        ball._captured = true;
        if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
        ball.vx *= 0.35;
        if ((ball.vy || 0) < 60) ball.vy = 60;
      } else {
        this._awardScoreBin(ball, bin, state);
      }
      if (captureMode === 'consume') {
        ball.alive = false;
        ball._captured = true;
        ball.vx = 0;
        ball.vy = 0;
        if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
      } else if (captureMode === 'freeze') {
        ball._frozen = true;
        ball.vx = 0;
        ball.vy = 0;
      }
      return true;
    }
    return false;
  }

  _stepSoftBody(ball, dt) {
    if (!ball || !ball.softBody) return;
    const recover = Math.max(0.05, ball.recoverySpeed != null ? ball.recoverySpeed : 7);
    const damping = Math.max(0.05, ball.wobbleDamping != null ? ball.wobbleDamping : 8);
    const hold = Math.max(0, ball._softImpactHold || 0);
    const holdMix = hold > 0 ? Math.min(1, hold / 0.12) : 0;
    const settleBoost = hold <= 0 ? 1.55 : 1.0;
    const effectiveRecover = recover * (0.28 + (1 - holdMix) * 0.72) * settleBoost;
    const effectiveFlowRecover = recover * (0.10 + (1 - holdMix) * 0.55) * (hold <= 0 ? 2.1 : 1.0);
    const effectiveDamping = damping * (0.28 + (1 - holdMix) * 0.72);
    const stretchDecay = Math.exp(-effectiveRecover * dt);
    const wobbleDecay = Math.exp(-effectiveDamping * dt);
    ball._softStretch = (ball._softStretch || 0) * stretchDecay;
    ball._softSquash = (ball._softSquash || 0) * stretchDecay;
    ball._softFlow = (ball._softFlow || 0) * Math.exp(-effectiveFlowRecover * dt);
    ball._softPress = (ball._softPress || 0) * Math.exp(-(effectiveRecover * 0.95) * dt);
    ball._softSkew = (ball._softSkew || 0) * Math.exp(-(effectiveRecover * 0.55) * dt);
    ball._softWobbleAmp = (ball._softWobbleAmp || 0) * wobbleDecay;
    ball._softWobblePhase = (ball._softWobblePhase || 0)
      + dt * (5.5 + (ball.wobbleIntensity || 0) * 8 + effectiveRecover * 0.22 + holdMix * 1.6);
    if (hold > 0) {
      ball._softImpactHold = Math.max(0, hold - dt);
    }
    if (!Number.isFinite(ball._softAxisX) || !Number.isFinite(ball._softAxisY)) {
      ball._softAxisX = 1;
      ball._softAxisY = 0;
    }
    if (hold <= 0) {
      const residual = Math.max(
        Math.abs(ball._softStretch || 0),
        Math.abs(ball._softSquash || 0),
        Math.abs(ball._softFlow || 0),
        Math.abs(ball._softPress || 0),
        Math.abs(ball._softSkew || 0),
        Math.abs(ball._softWobbleAmp || 0)
      );
      if (residual < 0.012) {
        ball._softStretch = 0;
        ball._softSquash = 0;
        ball._softFlow = 0;
        ball._softPress = 0;
        ball._softSkew = 0;
        ball._softWobbleAmp = 0;
      }
    }
  }

  _applySoftBodyImpact(ball, nx, ny, impactSpeed = 0) {
    if (!ball || !ball.softBody) return;
    const len = Math.hypot(nx || 0, ny || 0) || 1;
    nx /= len;
    ny /= len;
    const elasticity = Math.max(0, Math.min(3, ball.elasticity != null ? ball.elasticity : 0.35));
    const wobbleIntensity = Math.max(0, Math.min(3, ball.wobbleIntensity != null ? ball.wobbleIntensity : 0.28));
    const impact = Math.max(0, impactSpeed || 0);
    const squash = Math.max(0, Math.min(1.15, elasticity * (0.10 + impact / 900)));
    const stretch = Math.max(0, Math.min(1.55, elasticity * (0.18 + impact / 720)));
    const flow = Math.max(0, Math.min(1.0, elasticity * (0.08 + impact / 1200)));
    const wobble = Math.max(0, Math.min(0.55, wobbleIntensity * (0.05 + impact / 1250)));
    const hold = Math.max(0.02, Math.min(0.12, 0.02 + impact / 7000 + elasticity * 0.01));
    const press = Math.max(0, Math.min(0.22, squash * 0.18 + impact / 12000));
    const prevX = ball._softAxisX != null ? ball._softAxisX : nx;
    const prevY = ball._softAxisY != null ? ball._softAxisY : ny;
    const blend = 0.78;
    const ax = prevX * (1 - blend) + nx * blend;
    const ay = prevY * (1 - blend) + ny * blend;
    const aLen = Math.hypot(ax, ay) || 1;
    ball._softAxisX = ax / aLen;
    ball._softAxisY = ay / aLen;
    ball._softImpactCount = (ball._softImpactCount || 0) + 1;
    const skewNoise = this._softNoise(ball, 17) * 2 - 1;
    const phaseNoise = this._softNoise(ball, 31) * Math.PI * 2;
    ball._softSquash = Math.max(0, Math.min(1.15, (ball._softSquash || 0) * 0.35 + squash));
    ball._softStretch = Math.max(0, Math.min(1.55, (ball._softStretch || 0) * 0.4 + stretch));
    ball._softFlow = Math.max(0, Math.min(1.0, (ball._softFlow || 0) * 0.45 + flow));
    ball._softPress = Math.max(0, Math.min(0.55, (ball._softPress || 0) * 0.35 + press));
    ball._softSkew = Math.max(-0.75, Math.min(0.75, (ball._softSkew || 0) * 0.28 + skewNoise * (0.18 + wobbleIntensity * 0.16)));
    ball._softNoisePhase = phaseNoise;
    ball._softWobbleAmp = Math.max(0, Math.min(0.55, (ball._softWobbleAmp || 0) * 0.5 + wobble));
    ball._softWobblePhase = (ball._softWobblePhase || 0) + 1.2 + elasticity * 2.1;
    ball._softImpactHold = Math.max(ball._softImpactHold || 0, hold);
  }

  step(state, dt = FIXED_DT) {
    this.events.length = 0;
    if (state.score == null) state.score = 0;
    const balls = state.objects.filter((o) => o.type === 'ball' && o.alive);
    const structures = state.objects.filter((o) => o.type !== 'ball' && o.type !== 'spawner' && o.type !== 'scoreBin' && !o._gapRemoved && !o.visualOnly);
    const scoreBins = state.objects.filter((o) => o.type === 'scoreBin');
    const spawners = state.objects.filter((o) => o.type === 'spawner');

    for (const ball of balls) {
      ball._prevX = ball.x;
      ball._prevY = ball.y;
      if (Number.isFinite(ball._mazeBranchCooldown) && ball._mazeBranchCooldown > 0) {
        ball._mazeBranchCooldown--;
      }
      if (Number.isFinite(ball._mazeSplitIgnoreBallFrames) && ball._mazeSplitIgnoreBallFrames > 0) {
        ball._mazeSplitIgnoreBallFrames--;
      }
      this._stepSoftBody(ball, dt);
    }

    for (const s of structures) {
      s._frameXStart = s.x || 0;
      s._frameYStart = s.y || 0;
      s._frameBranchOriginXStart = s.mazeBranchOriginX != null ? s.mazeBranchOriginX : null;
      s._frameBranchOriginYStart = s.mazeBranchOriginY != null ? s.mazeBranchOriginY : null;
      s._frameRotationStart = s.rotation || 0;
      if (
        typeof s.mazeSpinSpeed === 'number'
        && s.mazeSpinSpeed !== 0
        && Number.isFinite(s.mazeOrbitCx)
        && Number.isFinite(s.mazeOrbitCy)
        && Number.isFinite(s.mazeBaseX)
        && Number.isFinite(s.mazeBaseY)
      ) {
        s._mazeSpinAngle = (s._mazeSpinAngle || 0) + s.mazeSpinSpeed * dt;
        const ox = s.mazeBaseX - s.mazeOrbitCx;
        const oy = s.mazeBaseY - s.mazeOrbitCy;
        const c = Math.cos(s._mazeSpinAngle);
        const sn = Math.sin(s._mazeSpinAngle);
        s.x = s.mazeOrbitCx + ox * c - oy * sn;
        s.y = s.mazeOrbitCy + ox * sn + oy * c;
        s.rotation = (s.mazeBaseRotation || 0) + s._mazeSpinAngle;
        if (Number.isFinite(s.mazeBranchBaseOriginX) && Number.isFinite(s.mazeBranchBaseOriginY)) {
          const box = s.mazeBranchBaseOriginX - s.mazeOrbitCx;
          const boy = s.mazeBranchBaseOriginY - s.mazeOrbitCy;
          s.mazeBranchOriginX = s.mazeOrbitCx + box * c - boy * sn;
          s.mazeBranchOriginY = s.mazeOrbitCy + box * sn + boy * c;
        }
      } else if (typeof s.rotationSpeed === 'number' && s.rotationSpeed !== 0) {
        s.rotation = (s.rotation || 0) + s.rotationSpeed * dt;
      } else if (s.type === 'flipper') {
        const elapsed = state.elapsedTime != null ? state.elapsedTime : (state.time || 0);
        const frequency = Math.max(0.05, s.frequency != null ? s.frequency : 1.35);
        const phase = s.phase || 0;
        const wave = 0.5 + 0.5 * Math.sin((elapsed * frequency + phase) * Math.PI * 2);
        s.rotation = (s.baseRotation != null ? s.baseRotation : (s.rotation || 0)) + (s.swing || 0) * wave;
      }
      s._frameXEnd = s.x || 0;
      s._frameYEnd = s.y || 0;
      s._frameBranchOriginXEnd = s.mazeBranchOriginX != null ? s.mazeBranchOriginX : null;
      s._frameBranchOriginYEnd = s.mazeBranchOriginY != null ? s.mazeBranchOriginY : null;
      s._frameRotationEnd = s.rotation || 0;
      s._prevRotation = s._frameRotationStart;
    }

    // Fire spawners. We test the "just crossed the interval boundary" for
    // the step about to happen (state.time .. state.time + dt) so emissions
    // are deterministic regardless of fps.
    for (const sp of spawners) {
      this._stepSpawner(sp, state, dt);
    }

    const loopDuration = state.loopDuration || 0;

    for (const ball of balls) {
      ball.age += dt;

      if (!ball._frozen && ball.freezeOnTimeout && ball.lifetime > 0 && ball.age >= ball.lifetime) {
        ball._frozen = true;
        ball.vx = 0; ball.vy = 0;
        const burstColor = ball.color;
        if (ball.recolorOnFreeze) ball.color = ball.deadColor || '#3a3a3a';
        if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
        this.events.push({
          type: 'freeze',
          x: ball.x, y: ball.y, color: burstColor,
          deathBurst: !!ball.deathBurstOnFreeze,
          deathSound: ball.deathSound || '',
        });
        continue;
      }

      // Frozen balls don't move, don't gravity, don't test structures. They
      // DO still participate in the ball-ball collision pass below as
      // immovable obstacles.
      if (ball._frozen || ball.fixed) {
        if (ball.fixed) {
          ball.vx = 0;
          ball.vy = 0;
        }
        if (!ball.freezeOnTimeout && ball.lifetime > 0 && ball.age >= ball.lifetime) {
          ball.alive = false;
          this.events.push({
            type: 'destroy', x: ball.x, y: ball.y, color: ball.color,
            destroySound: ball.destroySound || '',
          });
        }
        continue;
      }

      if (ball.motion === 'orbit' || ball.motion === 'lissajous' || ball.motion === 'spiralPath') {
        // Parametric, perfectly-looping motion. No gravity, no collisions --
        // the satisfying path is the source of truth.
        this._integrateParametric(ball, state.time + dt, loopDuration, dt);
        this._consumeTouchedSpikes(ball, structures, state);
      } else {
        // Classic physics path. Fast balls get micro-stepped so thin rotating
        // gap edges are checked multiple times within one frame.
        const substeps = this._physicsSubstepCount(ball, structures, dt);
        const subDt = dt / substeps;
        for (let subIdx = 0; subIdx < substeps; subIdx++) {
          const startT = subIdx / substeps;
          const endT = (subIdx + 1) / substeps;
          const subTime = (state.time || 0) + subDt * subIdx;
          const subState = {
            ...state,
            time: subTime,
            elapsedTime: (state.elapsedTime || 0) + subDt * subIdx,
          };
          this._setStructureRotationsForSubstep(structures, startT, endT);
          ball._prevX = ball.x;
          ball._prevY = ball.y;
          const gravityScaleDelay = Number.isFinite(ball.gravityScaleDelay) ? Math.max(0, ball.gravityScaleDelay) : 0;
          const delayedGravityActive = (ball.age || 0) >= gravityScaleDelay;
          const baseGravityScale = Number.isFinite(ball.gravityScale) ? Math.max(0, ball.gravityScale) : 1;
          const gravityScale = delayedGravityActive && Number.isFinite(ball.lateGravityScale)
            ? Math.max(0, ball.lateGravityScale)
            : baseGravityScale;
          const baseUpwardGravityScale = Number.isFinite(ball.upwardGravityScale) ? Math.max(gravityScale, ball.upwardGravityScale) : gravityScale;
          const upwardGravityScale = delayedGravityActive && Number.isFinite(ball.lateUpwardGravityScale)
            ? Math.max(gravityScale, ball.lateUpwardGravityScale)
            : baseUpwardGravityScale;
          const effectiveGravityScale = (ball.vy || 0) < 0 ? upwardGravityScale : gravityScale;
          ball.vy += this.gravity * effectiveGravityScale * subDt;
          const dampingDelay = Number.isFinite(ball.linearDampingDelay) ? Math.max(0, ball.linearDampingDelay) : 0;
          const dampingActive = (ball.age || 0) >= dampingDelay;
          const linearDamping = dampingActive && Number.isFinite(ball.linearDamping) ? Math.max(0, ball.linearDamping) : 0;
          const totalFriction = this.friction + linearDamping;
          if (totalFriction > 0) {
            const f = Math.max(0, 1 - totalFriction * subDt);
            ball.vx *= f;
            ball.vy *= f;
          }
          this._clampBallSpeed(ball);
          ball.x += ball.vx * subDt;
          ball.y += ball.vy * subDt;

          for (const s of structures) {
            this._collideBallWithStructure(ball, s, subTime, subState);
          }

          this._consumeTouchedSpikes(ball, structures, state);
          if (!ball.alive || ball._escaped) break;

          let gapHandled = false;
          for (const s of structures) {
            if (this._maybeHandleStructureGapPass(ball, s, subState)) {
              gapHandled = true;
              break;
            }
          }
          if (gapHandled || !ball.alive || ball._escaped) break;
        }
        if (!ball.alive || ball._escaped) continue;
        this._snapMazeBallVelocity(ball);
        this._snapMazeBallToCorridorCenter(ball);
        if (this._mazeExitReached(ball)) {
          this._emitEscape(ball);
          continue;
        }

        // Early escape detection: as soon as a physics ball slips outside a
        // containing `insideOnly` ring, treat it as escaped. IMPORTANT: when
        // multiple concentric containers exist, only the OUTERMOST container
        // assigned to this ball counts for escape; leaving an inner ring while
        // still inside a bigger one should not finish the run.
        if (!ball._escaped) {
          let s = structures.find((o) => o.id === ball._escapeContainerId);
          if (!s) {
            s = this._pickEscapeContainer(ball, structures);
            ball._escapeContainerId = s ? s.id : null;
          }
          if (s) {
            const rd = Math.hypot(ball.x - s.x, ball.y - s.y);
            const margin = ball.radius + (s.thickness || 0) * 0.5 + 4;
            if (rd > (s.radius || 0) + margin) {
              const now = state && state.elapsedTime != null ? state.elapsedTime : (state.time || 0);
              if (s.type === 'circle') {
                const a = Math.atan2(ball.y - s.y, ball.x - s.x);
                const prevA = Math.atan2((ball._prevY != null ? ball._prevY : ball.y) - s.y,
                                         (ball._prevX != null ? ball._prevX : ball.x) - s.x);
                if (!ballSweepsThroughCircleGap(ball, s, state.time, prevA, a)) continue;
                if (this._gapPassOnCooldown(ball, s.id, now)) continue;
                if (this._handleGapPass(ball, s, state, { dx: ball.x - s.x, dy: ball.y - s.y })) {
                  continue;
                }
              } else if (s.type === 'arc') {
                const a = Math.atan2(ball.y - s.y, ball.x - s.x);
                if (angleInArc(a, s.startAngle, s.endAngle, s.rotation || 0)) continue;
                if (this._gapPassOnCooldown(ball, s.id, now)) continue;
                if (this._handleGapPass(ball, s, state, { dx: ball.x - s.x, dy: ball.y - s.y })) {
                  continue;
                }
              }
              this._emitEscape(ball);
              continue;
            }
          }
        }

        if (this._checkScoreBins(ball, scoreBins, state)) {
          continue;
        }

        if (ball.x < -200 || ball.x > this.worldW + 200 ||
            ball.y < -200 || ball.y > this.worldH + 400) {
          ball.alive = false;
          // Don't double-emit escape if the ring check already caught it.
          if (!ball._escaped) {
            this._emitEscape(ball);
          }
          continue;
        }

        if (this._maybeRemoveOnUpturnAfterDrop(ball, state)) {
          continue;
        }
      }

      if (ball.lifetime > 0 && ball.age >= ball.lifetime) {
        ball.alive = false;
        if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
        this.events.push({
          type: 'destroy', x: ball.x, y: ball.y, color: ball.color,
          destroySound: ball.destroySound || '',
        });
        continue;
      }

      // Trails are truncated to a fixed length; for perfect looping we also
      // clear them at the loop boundary in Simulator.step.
      if (ball.trail) {
        if (ball._escaped && ball.clearTrailOnDeath) {
          if (ball._trail) ball._trail.length = 0;
        } else {
        if (!ball._trail) ball._trail = [];
        ball._trail.push({ x: ball.x, y: ball.y });
        const maxLen = ball.trailLength || 40;
        if (ball._trail.length > maxLen) {
          ball._trail.splice(0, ball._trail.length - maxLen);
        }
        }
      }
    }

    // Ball-ball collisions. Frozen balls are treated as infinite-mass
    // obstacles: moving balls reflect off them but they never move.
    this._resolveBallBall(balls, state);
    for (const ball of balls) {
      this._snapMazeBallVelocity(ball);
      this._snapMazeBallToCorridorCenter(ball);
    }

    // Any ball that died this tick and has `clearTrailOnDeath` set gets its
    // trail wiped now so it doesn't linger as a ghost snake on the canvas.
    for (const b of balls) {
      if (!b.alive && b.clearTrailOnDeath && b._trail && b._trail.length) {
        b._trail.length = 0;
      }
    }

    // Dead balls that have fully left the visible play area no longer need to
    // stay resident in the simulation state. Purging them keeps large escape /
    // destruction scenes from accumulating invisible objects in memory.
    state.objects = state.objects.filter((o) => !this._shouldPurgeBall(o));

    state.time += dt;
  }

  // Deterministic O(n^2) pair pass. Fine for scenes with <200 balls and
  // simple enough that floating-point behaviour is reproducible across runs.
  _resolveBallBall(balls, state) {
    // Balls that have already been captured by a score bin no longer need
    // expensive ball-ball collision resolution. Letting a whole bucket full of
    // captured balls continue colliding creates an O(n^2) hotspot and can
    // freeze the tab in Plinko-style scenes. Once a ball is inside a pot we let
    // the score-bin logic animate/settle it, but we remove it from the global
    // collision solver entirely.
    const alive = balls.filter((b) => b.alive && !b._capturedBin && !b._captured);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const A = alive[i], B = alive[j];
        const aFrozen = !!A._frozen || !!A.fixed;
        const bFrozen = !!B._frozen || !!B.fixed;
        if (aFrozen && bFrozen) continue;
        if (!A._ballContact) A._ballContact = Object.create(null);
        if (!B._ballContact) B._ballContact = Object.create(null);
        const contactKeyA = B.id || `ball_${j}`;
        const contactKeyB = A.id || `ball_${i}`;
        const sameFreshSplit = A._mazeSplitGroup
          && B._mazeSplitGroup
          && A._mazeSplitGroup === B._mazeSplitGroup
          && ((A._mazeSplitIgnoreBallFrames || 0) > 0 || (B._mazeSplitIgnoreBallFrames || 0) > 0);
        if (sameFreshSplit) {
          A._ballContact[contactKeyA] = false;
          B._ballContact[contactKeyB] = false;
          continue;
        }
        let dx = B.x - A.x, dy = B.y - A.y;
        let d = Math.hypot(dx, dy);
        const r = (A.radius || 0) + (B.radius || 0);
        const releaseMargin = Math.max(1.5, Math.min(A.radius || 0, B.radius || 0) * 0.12);
        if (d >= r + releaseMargin) {
          A._ballContact[contactKeyA] = false;
          B._ballContact[contactKeyB] = false;
          continue;
        }
        if (d >= r) continue;

        let nx, ny;
        if (d <= 1e-6) {
          const rvx = (B.vx || 0) - (A.vx || 0);
          const rvy = (B.vy || 0) - (A.vy || 0);
          const rvLen = Math.hypot(rvx, rvy);
          if (rvLen > 1e-6) {
            nx = rvx / rvLen;
            ny = rvy / rvLen;
          } else {
            nx = 1; ny = 0;
          }
          d = 1e-6;
          dx = nx * d;
          dy = ny * d;
        } else {
          nx = dx / d;
          ny = dy / d;
        }
        const overlap = r - d;
        const sepEps = Math.max(0.05, Math.min(1.2, overlap * 0.08));
        const incomingAVx = A.vx || 0;
        const incomingAVy = A.vy || 0;
        const incomingBVx = B.vx || 0;
        const incomingBVy = B.vy || 0;
        let didBounce = false;
        if (aFrozen) {
          B.x += nx * (overlap + sepEps); B.y += ny * (overlap + sepEps);
          const vn = B.vx * nx + B.vy * ny;
          if (vn < 0) {
            const restitution = Math.max(0, B.bounce != null ? B.bounce : 1.0);
            B.vx -= (1 + restitution) * vn * nx;
            B.vy -= (1 + restitution) * vn * ny;
            this._spreadBallCollision(B, nx, ny, 1);
            this._cycleBallCollisionColor(B);
            this._applySoftBodyImpact(B, nx, ny, Math.abs(vn));
            didBounce = true;
          }
          if (didBounce) this._maybeMazeBranchOnFixedBounce(state, B, A, incomingBVx, incomingBVy);
        } else if (bFrozen) {
          A.x -= nx * (overlap + sepEps); A.y -= ny * (overlap + sepEps);
          const vn = A.vx * nx + A.vy * ny;
          if (vn > 0) {
            const restitution = Math.max(0, A.bounce != null ? A.bounce : 1.0);
            A.vx -= (1 + restitution) * vn * nx;
            A.vy -= (1 + restitution) * vn * ny;
            this._spreadBallCollision(A, -nx, -ny, -1);
            this._cycleBallCollisionColor(A);
            this._applySoftBodyImpact(A, -nx, -ny, Math.abs(vn));
            didBounce = true;
          }
          if (didBounce) this._maybeMazeBranchOnFixedBounce(state, A, B, incomingAVx, incomingAVy);
        } else {
          // Equal-mass elastic exchange of the normal velocity component.
          A.x -= nx * (overlap + sepEps) * 0.5; A.y -= ny * (overlap + sepEps) * 0.5;
          B.x += nx * (overlap + sepEps) * 0.5; B.y += ny * (overlap + sepEps) * 0.5;
          const vAn = A.vx * nx + A.vy * ny;
          const vBn = B.vx * nx + B.vy * ny;
          const relN = vBn - vAn;
          // Only apply a collision impulse if the balls are actually moving
          // into each other along the contact normal. If they're already
          // separating but still slightly overlapping from the fixed-timestep
          // solver, we should only depenetrate -- otherwise crowded groups
          // behave like they have invisible "force field" walls.
          if (relN < 0) {
            A.vx += relN * nx; A.vy += relN * ny;
            B.vx -= relN * nx; B.vy -= relN * ny;
            this._spreadBallCollision(A, -nx, -ny, -1);
            this._spreadBallCollision(B, nx, ny, 1);
            this._cycleBallCollisionColor(A);
            this._cycleBallCollisionColor(B);
            this._applySoftBodyImpact(A, -nx, -ny, Math.abs(relN));
            this._applySoftBodyImpact(B, nx, ny, Math.abs(relN));
            didBounce = true;
          }
        }
        if (didBounce && !A._ballContact[contactKeyA]) {
          // Ball-ball bounce borrows the "moving" ball's sound: if A is
          // frozen/fixed, the sound-emitting contact came from B.
          const voiceBall = aFrozen ? B : A;
          const contactX = (A.x + B.x) * 0.5;
          const contactY = (A.y + B.y) * 0.5;
          this.events.push({
            type: 'bounce',
            source: (A.fixed || B.fixed) ? 'fixedBall' : 'ballBall',
            x: contactX,
            y: contactY,
            color: aFrozen ? B.color : A.color,
            ballId: A.id,
            otherBallId: B.id,
            bounceSound: voiceBall.bounceSound || '',
            bounceSoundOn: voiceBall.bounceSoundOn || 'all',
          });
          this._debugCollision((A.fixed || B.fixed) ? 'fixedBall' : 'ballBall', {
            ballId: A.id,
            otherBallId: B.id,
            x: Number((((A.x + B.x) * 0.5) || 0).toFixed(2)),
            y: Number((((A.y + B.y) * 0.5) || 0).toFixed(2)),
            distance: Number(d.toFixed(2)),
            overlap: Number(overlap.toFixed(2)),
            aFrozen,
            bFrozen,
            didBounce,
          });
          if (A.fixed && Number.isFinite(A.points) && !B.fixed) {
            this._scorePinballContactOnce(B, A, state, contactX, contactY, A.id || contactKeyA);
          }
          if (B.fixed && Number.isFinite(B.points) && !A.fixed) {
            this._scorePinballContactOnce(A, B, state, contactX, contactY, B.id || contactKeyB);
          }
          if (aFrozen) {
            this._maybeCreateCollisionHole(B, A, 'fixedBall', state, {
              anchorX: contactX,
              anchorY: contactY,
              incomingVx: incomingBVx,
              incomingVy: incomingBVy,
            });
            this._maybeCreateCollisionHole(A, B, 'ball', state, {
              anchorX: contactX,
              anchorY: contactY,
              incomingVx: incomingBVx,
              incomingVy: incomingBVy,
            });
          } else if (bFrozen) {
            this._maybeCreateCollisionHole(A, B, 'fixedBall', state, {
              anchorX: contactX,
              anchorY: contactY,
              incomingVx: incomingAVx,
              incomingVy: incomingAVy,
            });
            this._maybeCreateCollisionHole(B, A, 'ball', state, {
              anchorX: contactX,
              anchorY: contactY,
              incomingVx: incomingAVx,
              incomingVy: incomingAVy,
            });
          } else {
            this._maybeCreateCollisionHole(A, B, 'ball', state, {
              anchorX: contactX,
              anchorY: contactY,
              incomingVx: incomingAVx,
              incomingVy: incomingAVy,
            });
            this._maybeCreateCollisionHole(B, A, 'ball', state, {
              anchorX: contactX,
              anchorY: contactY,
              incomingVx: incomingBVx,
              incomingVy: incomingBVy,
            });
          }
        }
        if (didBounce) {
          A._ballContact[contactKeyA] = true;
          B._ballContact[contactKeyB] = true;
        }
      }
    }
  }

  // Update a ball that uses parametric motion (orbit/lissajous). We compute
  // position from t+dt rather than integrating, which means errors can't
  // accumulate and the motion is perfectly periodic with `loopDuration`.
  _integrateParametric(ball, t, loopDuration, dt) {
    const L = loopDuration > 0 ? loopDuration : 10;
    const harmonicX = (ball.orbitHarmonic || 1) * (ball.orbitDirection || 1);
    const thetaX = (Math.PI * 2) * harmonicX * (t / L) + (ball.orbitPhase || 0);
    const prevX = ball.x, prevY = ball.y;

    if (ball.motion === 'spiralPath') {
      const progress = Math.max(0, Math.min(1, t / L));
      const startR = Number.isFinite(ball.spiralStartRadius) ? ball.spiralStartRadius : (ball.orbitRadius || 420);
      const endR = Number.isFinite(ball.spiralEndRadius) ? ball.spiralEndRadius : 60;
      const turns = Number.isFinite(ball.spiralTurns) ? ball.spiralTurns : (ball.orbitHarmonic || 3);
      const radiusEase = Math.pow(progress, Number.isFinite(ball.spiralEase) ? ball.spiralEase : 0.52);
      const angleEase = Math.pow(progress, Number.isFinite(ball.spiralAngleEase) ? ball.spiralAngleEase : 0.9);
      const theta = (Math.PI * 2) * turns * angleEase * (ball.orbitDirection || 1) + (ball.orbitPhase || 0);
      const r = startR + (endR - startR) * radiusEase;
      ball.x = (ball.orbitCx || 540) + r * Math.cos(theta);
      ball.y = (ball.orbitCy || 960) + r * Math.sin(theta);
    } else if (ball.motion === 'lissajous') {
      const harmonicY = (ball.lissaHarmonicY || 1) * (ball.orbitDirection || 1);
      const thetaY = (Math.PI * 2) * harmonicY * (t / L) + (ball.lissaPhaseY || 0);
      ball.x = (ball.orbitCx || 540) + (ball.orbitRadius || 280) * Math.cos(thetaX);
      ball.y = (ball.orbitCy || 960) + (ball.lissaRadiusY || 280) * Math.sin(thetaY);
    } else {
      ball.x = (ball.orbitCx || 540) + (ball.orbitRadius || 280) * Math.cos(thetaX);
      ball.y = (ball.orbitCy || 960) + (ball.orbitRadius || 280) * Math.sin(thetaX);
    }
    // Tangent velocity (used only by trail/collision-aware visuals).
    ball.vx = (ball.x - prevX) / Math.max(1e-6, dt);
    ball.vy = (ball.y - prevY) / Math.max(1e-6, dt);
  }

  _consumeTouchedSpikes(ball, structures, state = null) {
    if (!ball || !ball.consumeSpikesOnTouch || !Array.isArray(structures)) return;
    if (ball._heartCapReached) return;
    const consumeRadius = Math.max(1, Number(ball.consumeRadius) || (ball.radius || 18) + 18);
    const maxPerTick = Math.max(1, ball.consumeMaxPerTick != null ? (ball.consumeMaxPerTick | 0) : 2);
    const minHeartIndex = Number.isFinite(ball.consumeFromHeartIndex) ? Math.max(0, ball.consumeFromHeartIndex | 0) : 0;
    const maxHeartIndex = Number.isFinite(ball.consumeUntilHeartIndex) ? Math.max(0, ball.consumeUntilHeartIndex | 0) : Infinity;
    const removeAfterCap = Number.isFinite(maxHeartIndex) && ball.removeAfterHeartCap === true;
    const prevX = Number.isFinite(ball._consumePrevX) ? ball._consumePrevX : (Number.isFinite(ball._prevX) ? ball._prevX : (ball.x || 0));
    const prevY = Number.isFinite(ball._consumePrevY) ? ball._consumePrevY : (Number.isFinite(ball._prevY) ? ball._prevY : (ball.y || 0));
    const currX = ball.x || 0;
    const currY = ball.y || 0;
    const finalizeConsumeSweep = () => {
      ball._consumePrevX = currX;
      ball._consumePrevY = currY;
    };
    const touchedDuringSweep = (x, y, radius) =>
      Math.hypot(currX - x, currY - y) <= radius ||
      segmentDistance(x, y, prevX, prevY, currX, currY) <= radius;
    const removeBallAtCap = () => {
      if (!removeAfterCap || !ball.alive) return;
      const startY = Number.isFinite(ball._dropStartY)
        ? ball._dropStartY
        : (Number.isFinite(ball.spawnY) ? ball.spawnY : (ball.y || 0));
      const maxY = Number.isFinite(ball._dropMaxY) ? ball._dropMaxY : (ball.y || 0);
      const minDrop = Math.max(0, Number.isFinite(ball.removeAfterDropMinDy) ? ball.removeAfterDropMinDy : 120);
      if (maxY - startY < minDrop) return;
      ball.alive = false;
      if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
      this.events.push({
        type: 'destroy',
        x: ball.x,
        y: ball.y,
        color: ball.color,
        destroySound: ball.destroySound || '',
      });
    };
    let consumed = 0;
    for (const sp of structures) {
      if (!sp || sp.type !== 'spikes' || !sp.consumable) continue;
      const count = Math.max(0, sp.count | 0);
      if (!count) continue;
      if (!sp._eatenSpikes || typeof sp._eatenSpikes !== 'object') sp._eatenSpikes = {};
      if (sp.markerPath === 'spiral') {
        const turns = Math.max(0.25, Number(sp.turns) || 4);
        const inner = Number.isFinite(sp.innerRadius) ? sp.innerRadius : 60;
        const outer = Number.isFinite(sp.outerRadius) ? sp.outerRadius : 430;
        const startAngle = Number.isFinite(sp.startAngle) ? sp.startAngle : 0;
        const direction = sp.direction === -1 ? -1 : 1;
        const pathStartT = Math.max(0, Math.min(1, Number.isFinite(sp.markerStartT) ? sp.markerStartT : 0));
        const pathEndT = Math.max(pathStartT, Math.min(1, Number.isFinite(sp.markerEndT) ? sp.markerEndT : 1));
        for (let i = 0; i < count; i++) {
          if (i < minHeartIndex) continue;
          if (i > maxHeartIndex) continue;
          if (sp._eatenSpikes[i]) continue;
          const t = count <= 1 ? 0 : i / (count - 1);
          const pathT = pathStartT + (pathEndT - pathStartT) * t;
          const a = startAngle + direction * (Math.PI * 2) * turns * pathT;
          const r = outer + (inner - outer) * pathT + (sp.radialOffset || 0);
          const x = (sp.x || 0) + Math.cos(a) * r;
          const y = (sp.y || 0) + Math.sin(a) * r;
          const heartRadius = Math.max(0, (Number(sp.heartSize) || sp.length || 0) * 0.5);
          const touchRadius = Math.max(consumeRadius, (ball.radius || 0) + heartRadius);
          if (!touchedDuringSweep(x, y, touchRadius)) continue;
          if (this._heartPickupBlockedByWall(currX, currY, x, y, structures)) {
            this._debugHeartPickupBlocked(ball, sp, i, x, y);
            continue;
          }
          const fillSmallConsumedGap = (fromIndex, toIndex) => {
            if (!(toIndex > fromIndex + 1) || toIndex - fromIndex > 8) return;
            for (let gapIndex = fromIndex + 1; gapIndex < toIndex; gapIndex++) {
              if (gapIndex < minHeartIndex || gapIndex > maxHeartIndex || sp._eatenSpikes[gapIndex]) continue;
              const gapT = count <= 1 ? 0 : gapIndex / (count - 1);
              const gapPathT = pathStartT + (pathEndT - pathStartT) * gapT;
              const gapA = startAngle + direction * (Math.PI * 2) * turns * gapPathT;
              const gapR = outer + (inner - outer) * gapPathT + (sp.radialOffset || 0);
              const gapX = (sp.x || 0) + Math.cos(gapA) * gapR;
              const gapY = (sp.y || 0) + Math.sin(gapA) * gapR;
              sp._eatenSpikes[gapIndex] = true;
              ball._heartEatCount = (ball._heartEatCount || 0) + 1;
              ball._lastHeartEatAge = ball.age || 0;
              ball._lastHeartEatY = ball.y || 0;
              ball._lastSpiralConsumedSpikesId = sp.id;
              ball._lastSpiralConsumedIndex = gapIndex;
              this._recordConsumedHeart(state, `${sp.id || 'spikes'}:${gapIndex}`);
              this.events.push({
                type: 'heartEat',
                x: gapX,
                y: gapY,
                color: sp.color || ball.color || '#ffffff',
                heartSound: ball.eatSound || 'pop',
                ballId: ball.templateSourceId || ball.id || null,
                heartIndex: gapIndex,
                heartProgress: gapT,
              });
              consumed++;
            }
          };
          for (let delta = 1; delta <= 8; delta++) {
            if (sp._eatenSpikes[i - delta]) {
              fillSmallConsumedGap(i - delta, i);
              break;
            }
          }
          for (let delta = 1; delta <= 8; delta++) {
            if (sp._eatenSpikes[i + delta]) {
              fillSmallConsumedGap(i, i + delta);
              break;
            }
          }
          sp._eatenSpikes[i] = true;
          const consumeVelocityScale = Number.isFinite(ball.consumeVelocityScale)
            ? Math.max(0, Math.min(1, ball.consumeVelocityScale))
            : 1;
          if (consumeVelocityScale < 1) {
            ball.vx *= consumeVelocityScale;
            ball.vy *= consumeVelocityScale;
          }
          ball._heartEatCount = (ball._heartEatCount || 0) + 1;
          ball._lastHeartEatAge = ball.age || 0;
          ball._lastHeartEatY = ball.y || 0;
          ball._lastSpiralConsumedSpikesId = sp.id;
          ball._lastSpiralConsumedIndex = i;
          this._recordConsumedHeart(state, `${sp.id || 'spikes'}:${i}`);
          this.events.push({
            type: 'heartEat',
            x,
            y,
            color: sp.color || ball.color || '#ffffff',
            heartSound: ball.eatSound || 'pop',
            ballId: ball.templateSourceId || ball.id || null,
            heartIndex: i,
            heartProgress: t,
          });
          consumed++;
          if (i >= maxHeartIndex) {
            ball._heartCapReached = true;
            finalizeConsumeSweep();
            removeBallAtCap();
            return;
          }
          if (consumed >= maxPerTick) return;
        }
        continue;
      }
      const baseR = sp.radius || 0;
      const tipR = sp.inward ? baseR - (sp.length || 0) : baseR + (sp.length || 0);
      const biteR = (baseR + tipR) * 0.5;
      const sector = (Math.PI * 2) / count;
      const rotation = sp.rotation || 0;
      for (let i = 0; i < count; i++) {
        if (i < minHeartIndex) continue;
        if (i > maxHeartIndex) continue;
        if (sp._eatenSpikes[i]) continue;
        const relAngle = i * sector;
        if (sp.gapSize > 0 && spikeInGap(relAngle, sp.gapStart, sp.gapSize)) continue;
        const a = rotation + relAngle;
        const x = (sp.x || 0) + Math.cos(a) * biteR;
        const y = (sp.y || 0) + Math.sin(a) * biteR;
        const heartRadius = sp.markerShape === 'heart'
          ? Math.max(0, (Number(sp.heartSize) || sp.length || 0) * 0.5)
          : 0;
        const touchRadius = Math.max(consumeRadius, (ball.radius || 0) + heartRadius);
        if (!touchedDuringSweep(x, y, touchRadius)) continue;
        sp._eatenSpikes[i] = true;
        const consumeVelocityScale = Number.isFinite(ball.consumeVelocityScale)
          ? Math.max(0, Math.min(1, ball.consumeVelocityScale))
          : 1;
        if (consumeVelocityScale < 1) {
          ball.vx *= consumeVelocityScale;
          ball.vy *= consumeVelocityScale;
        }
        ball._heartEatCount = (ball._heartEatCount || 0) + 1;
        ball._lastHeartEatAge = ball.age || 0;
        ball._lastHeartEatY = ball.y || 0;
        this._recordConsumedHeart(state, `${sp.id || 'spikes'}:${i}`);
        this.events.push({
          type: 'heartEat',
          x,
          y,
          color: sp.color || ball.color || '#ffffff',
          heartSound: ball.eatSound || 'pop',
          ballId: ball.templateSourceId || ball.id || null,
          heartIndex: i,
          heartProgress: count <= 1 ? 0 : i / (count - 1),
        });
        consumed++;
        if (i >= maxHeartIndex) {
          ball._heartCapReached = true;
          finalizeConsumeSweep();
          removeBallAtCap();
          return;
        }
        if (consumed >= maxPerTick) return;
      }
    }
    for (const heart of structures) {
      if (!heart || !heart.consumableCenterHeart || heart._centerHeartHit) continue;
      const unlockAfter = Math.max(0, Number.isFinite(heart.unlockAfterHearts) ? heart.unlockAfterHearts : 0);
      if (state && (state._consumedHearts || 0) < unlockAfter) continue;
      const allSmallConsumablesGone = structures.every((obj) => {
        if (!obj || obj.type !== 'spikes' || !obj.consumable) return true;
        const count = Math.max(0, obj.count | 0);
        if (!count) return true;
        const eaten = obj._eatenSpikes || {};
        for (let i = 0; i < count; i++) {
          if (!eaten[i]) return false;
        }
        return true;
      });
      if (!allSmallConsumablesGone) continue;
      const heartRadius = Math.max(1, Number(heart.hitRadius) || (Number(heart.size) || 64) * 0.45);
      const touchRadius = (ball.radius || 0) + heartRadius;
      if (!touchedDuringSweep(heart.x || 0, heart.y || 0, touchRadius)) continue;
      heart._centerHeartHit = true;
      if (state) {
        this._recordConsumedHeart(state, `center:${heart.id || 'heart'}`);
        state._centerHeartHit = true;
      }
      this.events.push({
        type: 'heartEat',
        x: heart.x || 0,
        y: heart.y || 0,
        color: heart.color || ball.color || '#ffffff',
        heartSound: ball.eatSound || 'pop',
        ballId: ball.templateSourceId || ball.id || null,
        heartIndex: unlockAfter,
        heartProgress: 1,
        centerHeart: true,
      });
      finalizeConsumeSweep();
      return;
    }
    finalizeConsumeSweep();
  }

  _recordConsumedHeart(state, key) {
    if (!state) return false;
    const id = String(key || 'heart');
    if (!state._consumedHeartIds || typeof state._consumedHeartIds !== 'object') state._consumedHeartIds = {};
    if (state._consumedHeartIds[id]) return false;
    state._consumedHeartIds[id] = true;
    state._consumedHearts = (state._consumedHearts || 0) + 1;
    return true;
  }

  _heartPickupBlockedByWall(ballX, ballY, heartX, heartY, structures) {
    if (!Array.isArray(structures)) return false;
    for (const wall of structures) {
      if (!wall || wall.type !== 'spiral' || !wall.continuous) continue;
      const turns = Math.max(0.25, Number(wall.turns) || 4);
      const samples = Math.max(80, wall.samples | 0 || Math.round(turns * 96));
      const inner = Number.isFinite(wall.innerRadius) ? wall.innerRadius : 60;
      const outer = Number.isFinite(wall.outerRadius) ? wall.outerRadius : 430;
      const startAngle = Number.isFinite(wall.startAngle) ? wall.startAngle : 0;
      const direction = wall.direction === -1 ? -1 : 1;
      const blockRadius = Math.max(1, (Number(wall.thickness) || 4) * 0.5 + 2);
      let prev = null;
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const a = startAngle + direction * (Math.PI * 2) * turns * t;
        const r = outer + (inner - outer) * t;
        const p = {
          x: (wall.x || 0) + Math.cos(a) * r,
          y: (wall.y || 0) + Math.sin(a) * r,
        };
        if (prev) {
          const closest = closestPointsBetweenSegments(ballX, ballY, heartX, heartY, prev.x, prev.y, p.x, p.y);
          const d = Math.hypot(closest.px - closest.qx, closest.py - closest.qy);
          if (d <= blockRadius && closest.sc > 0.06 && closest.sc < 0.94) return true;
        }
        prev = p;
      }
    }
    return false;
  }

  _debugHeartPickupBlocked(ball, sp, heartIndex, x, y) {
    if (typeof window === 'undefined' || !window.__heartPickupDebug) return;
    const entry = {
      ballId: ball && (ball.templateSourceId || ball.id),
      spikesId: sp && sp.id,
      heartIndex,
      ballX: Number(((ball && ball.x) || 0).toFixed(2)),
      ballY: Number(((ball && ball.y) || 0).toFixed(2)),
      heartX: Number((x || 0).toFixed(2)),
      heartY: Number((y || 0).toFixed(2)),
    };
    if (!Array.isArray(window.__heartPickupDebugLogs)) window.__heartPickupDebugLogs = [];
    window.__heartPickupDebugLogs.push(entry);
    if (window.__heartPickupDebugLogs.length > 200) window.__heartPickupDebugLogs.shift();
    if (window.__heartPickupDebug === 'console') console.info('[heart-pickup-blocked]', entry);
  }

  _maybeRemoveOnUpturnAfterDrop(ball, state = null) {
    if (!ball || !ball.removeOnUpturnAfterDrop || !ball.alive || ball._escaped || ball._frozen || ball.fixed) return false;
    const startY = Number.isFinite(ball._dropStartY)
      ? ball._dropStartY
      : (Number.isFinite(ball.spawnY) ? ball.spawnY : (ball.y || 0));
    ball._dropStartY = startY;
    const maxY = Math.max(Number.isFinite(ball._dropMaxY) ? ball._dropMaxY : startY, ball.y || 0);
    ball._dropMaxY = maxY;
    const minDrop = Math.max(0, Number.isFinite(ball.removeAfterDropMinDy) ? ball.removeAfterDropMinDy : 120);
    const upturnVy = Number.isFinite(ball.removeOnUpturnVy) ? ball.removeOnUpturnVy : -40;
    const minAge = Math.max(0, Number.isFinite(ball.removeOnUpturnMinAge) ? ball.removeOnUpturnMinAge : 0.25);
    if ((ball.age || 0) < minAge) return false;
    const minHearts = Math.max(0, ball.removeOnUpturnMinHearts != null ? (ball.removeOnUpturnMinHearts | 0) : 1);
    if ((ball._heartEatCount || 0) < minHearts) return false;
    if (maxY - startY < minDrop) return false;
    const staleAfter = Math.max(0, Number.isFinite(ball.removeOnUpturnStaleAfter) ? ball.removeOnUpturnStaleAfter : 0.45);
    const lastEatAge = Number.isFinite(ball._lastHeartEatAge) ? ball._lastHeartEatAge : 0;
    if ((ball.age || 0) - lastEatAge < staleAfter) return false;
    const lastEatY = Number.isFinite(ball._lastHeartEatY) ? ball._lastHeartEatY : startY;
    const noProgressDy = Math.max(0, Number.isFinite(ball.removeOnUpturnNoProgressDy) ? ball.removeOnUpturnNoProgressDy : 36);
    if (maxY - lastEatY < noProgressDy) return false;
    const stallAfter = Number.isFinite(ball.removeWhenStalledAfter) ? Math.max(0, ball.removeWhenStalledAfter) : 0;
    if (stallAfter > 0 && (ball.age || 0) - lastEatAge >= stallAfter) {
      const stallSpeed = Math.max(0, Number.isFinite(ball.removeWhenStalledSpeed) ? ball.removeWhenStalledSpeed : 18);
      if (Math.hypot(ball.vx || 0, ball.vy || 0) <= stallSpeed) {
        ball.alive = false;
        if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
        this.events.push({
          type: 'destroy',
          x: ball.x,
          y: ball.y,
          color: ball.color,
          destroySound: ball.destroySound || '',
        });
        return true;
      }
    }
    const capStaleMultiplier = Number.isFinite(ball.removeOnHeartCapStaleMultiplier) ? Math.max(1, ball.removeOnHeartCapStaleMultiplier) : 3;
    const capStaleEnough = !!ball._heartCapReached && (ball.age || 0) - lastEatAge >= staleAfter * capStaleMultiplier;
    if ((ball.vy || 0) >= upturnVy && !capStaleEnough) return false;
    ball.alive = false;
    if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
    this.events.push({
      type: 'destroy',
      x: ball.x,
      y: ball.y,
      color: ball.color,
      destroySound: ball.destroySound || '',
    });
    return true;
  }

  _stepSpawner(sp, state, dt) {
    const interval = Math.max(0.01, sp.interval || 1);
    if (sp._lastSpawn === undefined || sp._lastSpawn === -Infinity || sp._lastSpawn === null) {
      // First spawn at t=0 so the viewer sees something immediately.
      sp._lastSpawn = -interval;
      sp._spawnCount = 0;
      sp._spawnedIds = [];
    }
    // IMPORTANT: schedule spawns off monotonic elapsed time, not looped
    // `state.time`. `state.time` wraps back to 0 every loop, which can make a
    // spawner's nextSpawnTime permanently unreachable after the first wrap.
    const elapsedTime = state.elapsedTime != null ? state.elapsedTime : state.time;
    const nextSpawnTime = sp._lastSpawn + interval;
    const isActiveSpawnedBall = (ball) => ball
      && ball.type === 'ball'
      && ball.alive
      && !ball._escaped
      && !ball._captured
      && !ball._capturedBin
      && !ball.fixed
      && ball._fromSpawner === sp.id;
    sp._spawnedIds = sp._spawnedIds.filter((id) => state.objects.some((o) => o.id === id));
    const activeSpawnedCount = state.objects.filter(isActiveSpawnedBall).length;
    const maxActiveBalls = Math.max(0, sp.maxActiveBalls | 0);
    const maxTotalBalls = Math.max(0, sp.maxTotalBalls | 0);
    if (maxTotalBalls > 0 && (sp._spawnCount || 0) >= maxTotalBalls) {
      if (activeSpawnedCount === 0 && !sp._finished) {
        sp._finished = true;
        state._finished = true;
        const tail = Math.max(0, sp.finishTailSeconds != null ? sp.finishTailSeconds : 1.4);
        this.events.push({
          type: 'finish',
          source: 'spawner',
          spawnerId: sp.id || null,
          at: elapsedTime,
          tail,
        });
      }
      return;
    }
    if (maxActiveBalls > 0 && activeSpawnedCount >= maxActiveBalls) {
      return;
    }
    if (elapsedTime + dt < nextSpawnTime) {
      this._debugSpawner('wait', {
        spawnerId: sp.id,
        elapsedTime,
        loopTime: state.time,
        nextSpawnTime: Number(nextSpawnTime.toFixed(4)),
        interval: Number(interval.toFixed(4)),
      });
      return;
    }

    // Emit the ball. Optional spawn jitter uses a deterministic sine hash so
    // presets can get "random-looking" variety without breaking seed replay.
    const palette = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#22d3ee'];
    const color = sp.colorCycle
      ? palette[sp._spawnCount % palette.length]
      : (sp.ballColor || '#38bdf8');
    const jitterX = sp.ballSpawnJitterX || 0;
    const jitterVx = sp.ballSpawnJitterVx || 0;
    const jitterVy = sp.ballSpawnJitterVy || 0;
    const seq = (sp._spawnCount || 0) + 1;
    const hash = (salt) => {
      const phase = seq * 12.9898 + salt * 78.233 + (sp.x || 0) * 0.017 + (sp.y || 0) * 0.013;
      return Math.sin(phase);
    };
    const spawnX = (sp.x || 0) + hash(1) * jitterX;
    const spawnVx = (sp.ballVx || 0) + hash(2) * jitterVx;
    const spawnVy = (sp.ballVy || 0) + hash(3) * jitterVy;
    let finalVx = spawnVx;
    let finalVy = spawnVy;
    if (sp.ballRandomInitDir) {
      const speed = Math.hypot(spawnVx || 0, spawnVy || 0);
      if (speed > 1e-6) {
        const angle = hash(4) * Math.PI;
        finalVx = Math.cos(angle) * speed;
        finalVy = Math.sin(angle) * speed;
      }
    }
    const ball = {
      id: `${sp.id}_b${sp._spawnCount}`,
      type: 'ball',
      x: spawnX, y: sp.y,
      spawnX,
      spawnY: sp.y,
      vx: finalVx,
      vy: finalVy,
      radius: sp.ballRadius || 18,
      color,
      trail: !!sp.ballTrail,
      trailLength: sp.ballTrailLength || 40,
      clearTrailOnDeath: sp.ballClearTrailOnDeath !== false,
      randomInitDir: !!sp.ballRandomInitDir,
      lifetime: sp.ballLifetime || 0,
      freezeOnTimeout: !!sp.ballFreezeOnTimeout,
      fixed: !!sp.ballFixed,
      ballBehaviorPreset: sp.ballBehaviorPreset || 'custom',
      maxSpeed: sp.ballMaxSpeed || 0,
      bounce: sp.ballBounce != null ? sp.ballBounce : 1.0,
      wallCurve: sp.ballWallCurve != null ? sp.ballWallCurve : 0,
      wallDrift: sp.ballWallDrift != null ? sp.ballWallDrift : 0,
      wallBounceAngleRange: sp.ballWallBounceAngleRange != null ? sp.ballWallBounceAngleRange : 0,
      collisionSpread: sp.ballCollisionSpread != null ? sp.ballCollisionSpread : 0.35,
      softBody: !!sp.ballSoftBody,
      elasticity: sp.ballElasticity != null ? sp.ballElasticity : 0.35,
      recoverySpeed: sp.ballRecoverySpeed != null ? sp.ballRecoverySpeed : 7.0,
      wobbleIntensity: sp.ballWobbleIntensity != null ? sp.ballWobbleIntensity : 0.28,
      wobbleDamping: sp.ballWobbleDamping != null ? sp.ballWobbleDamping : 8.0,
      changeColorOnBallCollision: !!sp.ballChangeColorOnBallCollision,
      deadColor: sp.ballDeadColor || '#3a3a3a',
      recolorOnFreeze: !!sp.ballRecolorOnFreeze,
      deathBurstOnFreeze: !!sp.ballDeathBurstOnFreeze,
      bounceSound: sp.ballBounceSound || '',
      bounceSoundOn: sp.ballBounceSoundOn || 'all',
      escapeSound: sp.ballEscapeSound || '',
      destroySound: sp.ballDestroySound || '',
      deathSound: sp.ballDeathSound || '',
      collisionHoleEnabled: !!sp.ballCollisionHoleEnabled,
      collisionHoleSize: sp.ballCollisionHoleSize != null ? sp.ballCollisionHoleSize : 0.42,
      collisionHoleTarget: sp.ballCollisionHoleTarget || 'auto',
      collisionHolePlacement: sp.ballCollisionHolePlacement || 'impact',
      collisionHoleOnCircle: !!sp.ballCollisionHoleOnCircle,
      collisionHoleOnArc: !!sp.ballCollisionHoleOnArc,
      collisionHoleOnSpikes: !!sp.ballCollisionHoleOnSpikes,
      collisionHoleOnSpinner: !!sp.ballCollisionHoleOnSpinner,
      collisionHoleOnBall: !!sp.ballCollisionHoleOnBall,
      collisionHoleOnFixedBall: !!sp.ballCollisionHoleOnFixedBall,
      destroyOnSpike: sp.ballDestroyOnSpike !== false,
      freezeOnSpike: !!sp.ballFreezeOnSpike,
      alive: true, age: 0,
      motion: 'physics',
      orbitCx: 540, orbitCy: 960, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
      _trail: [],
      _fromSpawner: sp.id,
    };
    state.objects.push(ball);
    sp._spawnedIds.push(ball.id);
    sp._spawnCount++;
    sp._lastSpawn = nextSpawnTime;
    this.events.push({ type: 'spawn', x: sp.x, y: sp.y, color });
    this._debugSpawner('spawn', {
      spawnerId: sp.id,
      elapsedTime,
      loopTime: state.time,
      nextSpawnTime: Number(nextSpawnTime.toFixed(4)),
      spawnCount: sp._spawnCount,
      trackedBalls: sp._spawnedIds.length,
      maxBalls: sp.maxBalls,
      ballId: ball.id,
    });

    // Cap active balls: oldest spawned by THIS spawner is removed first.
    const max = Math.max(1, sp.maxBalls | 0);
    while (sp._spawnedIds.length > max) {
      const oldestId = sp._spawnedIds.shift();
      const idx = state.objects.findIndex((o) => o.id === oldestId);
      if (idx >= 0) {
        state.objects.splice(idx, 1);
        this._debugSpawner('trim', {
          spawnerId: sp.id,
          elapsedTime,
          loopTime: state.time,
          removedBallId: oldestId,
          trackedBalls: sp._spawnedIds.length,
          maxBalls: max,
        });
      }
    }
  }

  // Place every parametric ball at its t=0 formula position AND pre-populate
  // its trail with the positions it would have had in the previous loop.
  // This makes the very first rendered frame look identical to the frame at
  // t=loopDuration, so exports are perfectly seamless on replay.
  snapOrbitBalls(state) {
    const dt = 1 / 60;
    for (const ball of state.objects) {
      if (ball.type !== 'ball') continue;
      if (ball.motion !== 'orbit' && ball.motion !== 'lissajous') continue;
      this._integrateParametric(ball, 0, state.loopDuration, dt);
      if (ball.trail) {
        ball._trail = [];
        const len = Math.max(2, ball.trailLength || 40);
        // Sample positions going backwards in time, then reverse so the most
        // recent sample is last (matches how trail is pushed normally).
        for (let i = -len; i < 0; i++) {
          const t = i * dt; // negative; orbit formula handles any t
          const harmonicX = (ball.orbitHarmonic || 1) * (ball.orbitDirection || 1);
          const L = state.loopDuration > 0 ? state.loopDuration : 10;
          const thetaX = (Math.PI * 2) * harmonicX * (t / L) + (ball.orbitPhase || 0);
          let x, y;
          if (ball.motion === 'lissajous') {
            const harmonicY = (ball.lissaHarmonicY || 1) * (ball.orbitDirection || 1);
            const thetaY = (Math.PI * 2) * harmonicY * (t / L) + (ball.lissaPhaseY || 0);
            x = (ball.orbitCx || 540) + (ball.orbitRadius || 280) * Math.cos(thetaX);
            y = (ball.orbitCy || 960) + (ball.lissaRadiusY || 280) * Math.sin(thetaY);
          } else {
            x = (ball.orbitCx || 540) + (ball.orbitRadius || 280) * Math.cos(thetaX);
            y = (ball.orbitCy || 960) + (ball.orbitRadius || 280) * Math.sin(thetaX);
          }
          ball._trail.push({ x, y });
        }
      }
    }
  }

  _collideBallWithStructure(ball, s, time = 0, state = null) {
    switch (s.type) {
      case 'circle': return this._collideCircleRing(ball, s, time, state);
      case 'arc': return this._collideArc(ball, s, state);
      case 'spiral': return this._collideSpiral(ball, s, state);
      case 'spikes': return this._collideSpikes(ball, s, state);
      case 'spinner': return this._collideSpinner(ball, s, state);
      case 'booster': return this._collideBooster(ball, s, state);
      case 'flipper': return this._collideFlipper(ball, s, state);
    }
    return false;
  }

  _awardPinballScore(ball, target, state, x, y) {
    if (!state || !target || !Number.isFinite(target.points)) return;
    const points = target.points | 0;
    if (points === 0) return;
    state.score = (state.score || 0) + points;
    const label = target.label != null && String(target.label).trim()
      ? String(target.label)
      : `${points >= 0 ? '+' : ''}${points}`;
    this.events.push({
      type: 'score',
      source: target.type || 'pinball',
      x,
      y,
      color: target.accentColor || target.color || ball.color,
      textColor: '#ffffff',
      ballId: ball.id,
      bucketId: target.id || null,
      points,
      label,
    });
  }

  _scorePinballContactOnce(ball, target, state, x, y, contactKey) {
    if (!ball || !target || !state) return;
    if (!ball._pinballScoreContact) ball._pinballScoreContact = Object.create(null);
    const now = state.elapsedTime != null ? state.elapsedTime : (state.time || 0);
    const key = contactKey || target.id || target.type || 'pinball';
    const cooldown = Math.max(0, target.cooldown != null ? target.cooldown : 0.1);
    const last = ball._pinballScoreContact[key];
    if (last != null && now - last < cooldown) return;
    ball._pinballScoreContact[key] = now;
    this._awardPinballScore(ball, target, state, x, y);
  }

  _collideBooster(ball, booster, state = null) {
    const radius = Math.max(4, booster.radius || 0);
    const dx = ball.x - (booster.x || 0);
    const dy = ball.y - (booster.y || 0);
    let dist = Math.hypot(dx, dy);
    const limit = (ball.radius || 0) + radius;
    if (dist > limit) return false;
    let nx = dx;
    let ny = dy;
    if (dist <= 1e-6) {
      nx = 0;
      ny = -1;
      dist = 1e-6;
    } else {
      nx /= dist;
      ny /= dist;
    }
    const push = limit - dist;
    ball.x += nx * push;
    ball.y += ny * push;
    const incomingVx = ball.vx || 0;
    const incomingVy = ball.vy || 0;
    const impactSpeed = Math.abs(incomingVx * nx + incomingVy * ny);
    this._reflect(ball, nx, ny, Math.max(ball.bounce != null ? ball.bounce : 1, 1.08));
    const strength = Math.max(0, booster.strength != null ? booster.strength : 680);
    ball.vx += nx * strength;
    ball.vy += ny * strength;
    this._clampBallSpeed(ball);
    this._applySoftBodyImpact(ball, nx, ny, impactSpeed + strength);
    this.events.push({
      type: 'bounce',
      source: 'booster',
      x: ball.x,
      y: ball.y,
      color: booster.accentColor || booster.color || ball.color,
      ballId: ball.id,
      colliderId: booster.id || null,
      colliderType: 'booster',
      bounceSound: ball.bounceSound || '',
      bounceSoundOn: ball.bounceSoundOn || 'all',
    });
    this._scorePinballContactOnce(ball, booster, state, ball.x, ball.y, booster.id || 'booster');
    return true;
  }

  _collideFlipper(ball, flipper, state = null) {
    const length = Math.max(20, flipper.length || 0);
    const halfThickness = Math.max(2, flipper.thickness || 0) * 0.5;
    const angle = flipper.rotation || 0;
    const ax = flipper.x || 0;
    const ay = flipper.y || 0;
    const bx = ax + Math.cos(angle) * length;
    const by = ay + Math.sin(angle) * length;
    const closest = closestPointOnSegment(ball.x, ball.y, ax, ay, bx, by);
    let nx = ball.x - closest.x;
    let ny = ball.y - closest.y;
    let dist = Math.hypot(nx, ny);
    const limit = (ball.radius || 0) + halfThickness;
    if (dist > limit) return false;
    if (dist <= 1e-6) {
      nx = -Math.sin(angle);
      ny = Math.cos(angle);
      dist = 1e-6;
    } else {
      nx /= dist;
      ny /= dist;
    }
    const push = limit - dist;
    ball.x += nx * push;
    ball.y += ny * push;
    const incomingVx = ball.vx || 0;
    const incomingVy = ball.vy || 0;
    const impactSpeed = Math.abs(incomingVx * nx + incomingVy * ny);
    this._reflect(ball, nx, ny, Math.max(ball.bounce != null ? ball.bounce : 1, 1.05));
    const rotDelta = shortestAngleDelta(flipper._prevRotation || angle, angle);
    const swingBoost = Math.abs(rotDelta) * length * 9;
    const strength = Math.max(0, flipper.strength != null ? flipper.strength : 720);
    const contactT = closest.t != null ? closest.t : 1;
    const lever = 0.45 + contactT * 0.75;
    ball.vx += nx * (strength * lever + swingBoost);
    ball.vy += ny * (strength * lever + swingBoost);
    this._clampBallSpeed(ball);
    this._afterWallBounce(ball, nx, ny);
    this._applySoftBodyImpact(ball, nx, ny, impactSpeed + strength);
    this.events.push({
      type: 'bounce',
      source: 'flipper',
      x: ball.x,
      y: ball.y,
      color: flipper.color || ball.color,
      ballId: ball.id,
      colliderId: flipper.id || null,
      colliderType: 'flipper',
      bounceSound: ball.bounceSound || '',
      bounceSoundOn: ball.bounceSoundOn || 'all',
    });
    this._scorePinballContactOnce(ball, flipper, state, ball.x, ball.y, flipper.id || 'flipper');
    return true;
  }

  _collideSpinner(ball, sp, state = null) {
    const armLength = Math.max(10, sp.armLength || 0);
    const half = armLength * 0.5;
    const halfThickness = Math.max(2, sp.thickness || 0) * 0.5;
    const armCount = Math.max(1, sp.armCount | 0);
    const releaseMargin = Math.max(2, ball.radius * 0.18);
    if (!ball._spinnerContact) ball._spinnerContact = Object.create(null);
    let hit = false;
    for (let i = 0; i < armCount; i++) {
      const a = (sp.rotation || 0) + i * (Math.PI / armCount);
      const dx = Math.cos(a) * half;
      const dy = Math.sin(a) * half;
      const ax = sp.x - dx;
      const ay = sp.y - dy;
      const bx = sp.x + dx;
      const by = sp.y + dy;
      const key = `${sp.id || '__spinner'}:${i}`;
      const closest = closestPointOnSegment(ball.x, ball.y, ax, ay, bx, by);
      let nx = ball.x - closest.x;
      let ny = ball.y - closest.y;
      let dist = Math.hypot(nx, ny);
      const limit = ball.radius + halfThickness;
      if (dist > limit + releaseMargin) {
        ball._spinnerContact[key] = false;
        continue;
      }
      if (dist >= limit) continue;
      if (dist <= 1e-6) {
        nx = -Math.sin(a);
        ny = Math.cos(a);
        dist = 1e-6;
      } else {
        nx /= dist;
        ny /= dist;
      }
      if (sp.oneWayNormal) {
        const blockNx = Number(sp.oneWayNormal.x || 0);
        const blockNy = Number(sp.oneWayNormal.y || 0);
        const blockLen = Math.hypot(blockNx, blockNy);
        if (blockLen > 1e-6) {
          const sideDot = nx * (blockNx / blockLen) + ny * (blockNy / blockLen);
          if (sideDot < 0.2) {
            ball._spinnerContact[key] = false;
            continue;
          }
        }
      }
      const push = limit - dist;
      ball.x += nx * push;
      ball.y += ny * push;
      const incomingVx = ball.vx || 0;
      const incomingVy = ball.vy || 0;
      if (sp.mazeBranchTrigger) {
        if (!ball._mazeVisitedTriggers) ball._mazeVisitedTriggers = Object.create(null);
        if (sp.id && ball._mazeVisitedTriggers[sp.id]) {
          ball._spinnerContact[key] = true;
          hit = true;
          continue;
        }
        if (this._maybeMazeBranchOnWallBounce(
          state,
          ball,
          incomingVx,
          incomingVy,
          halfThickness,
          sp,
        )) {
          if (sp.id) ball._mazeVisitedTriggers[sp.id] = true;
          ball._spinnerContact[key] = true;
          hit = true;
        }
        // Junction triggers are logical markers only; balls should never
        // bounce off them if they merely pass through after a recent split.
        continue;
      }
      if (sp.mazeWall && this._maybeMazeBranchOnWallBounce(
        state,
        ball,
        incomingVx,
        incomingVy,
        halfThickness,
        sp,
      )) {
        ball._spinnerContact[key] = true;
        hit = true;
        continue;
      }
      const impactSpeed = Math.abs(ball.vx * nx + ball.vy * ny);
      this._reflect(ball, nx, ny, ball.bounce);
      this._afterWallBounce(ball, nx, ny);
      this._applySoftBodyImpact(ball, nx, ny, impactSpeed);
      if (!ball._spinnerContact[key]) {
        this.events.push({
          type: 'bounce',
          source: 'spinner',
          x: ball.x,
          y: ball.y,
          color: ball.color,
          ballId: ball.id,
          colliderId: sp.id || null,
          colliderType: 'spinner',
          bounceSound: ball.bounceSound || '',
          bounceSoundOn: ball.bounceSoundOn || 'all',
        });
        this._debugCollision('spinner', {
          ballId: ball.id,
          colliderId: sp.id || null,
          colliderType: 'spinner',
          x: Number(ball.x.toFixed(2)),
          y: Number(ball.y.toFixed(2)),
          armIndex: i,
          push: Number(push.toFixed(2)),
          angle: Number(a.toFixed(3)),
        });
        this._maybeCreateCollisionHole(ball, sp, 'spinner', state, {
          anchorX: closest.x,
          anchorY: closest.y,
          incomingVx,
          incomingVy,
        });
        ball._spinnerContact[key] = true;
      }
      hit = true;
    }
    return hit;
  }

  _reflect(ball, nx, ny, restitution) {
    const dot = ball.vx * nx + ball.vy * ny;
    ball.vx -= 2 * dot * nx * restitution;
    ball.vy -= 2 * dot * ny * restitution;
  }

  _rotateVelocity(ball, radians) {
    if (!radians) return;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const vx = ball.vx;
    const vy = ball.vy;
    ball.vx = vx * c - vy * s;
    ball.vy = vx * s + vy * c;
  }

  _setMazeBallDirection(ball, dir, speed = null) {
    if (!ball || !dir) return;
    const x = Math.sign(dir.x || 0);
    const y = Math.sign(dir.y || 0);
    const nextSpeed = Math.max(
      1e-6,
      speed != null
        ? Math.abs(speed)
        : (ball.mazeBranchSpeed != null ? Math.abs(ball.mazeBranchSpeed) : Math.hypot(ball.vx || 0, ball.vy || 0)),
    );
    if (Math.abs(x) >= Math.abs(y)) {
      ball._mazeAxis = 'h';
      ball._mazeDirX = x || 1;
      ball._mazeDirY = 0;
      ball.vx = (x || 1) * nextSpeed;
      ball.vy = 0;
    } else {
      ball._mazeAxis = 'v';
      ball._mazeDirX = 0;
      ball._mazeDirY = y || 1;
      ball.vx = 0;
      ball.vy = (y || 1) * nextSpeed;
    }
  }

  _snapMazeBallVelocity(ball) {
    if (!ball || !ball.mazeBranchOnFixedBounce || ball._frozen || ball.fixed) return;
    const vx = ball.vx || 0;
    const vy = ball.vy || 0;
    const ax = Math.abs(vx);
    const ay = Math.abs(vy);
    const speed = Math.max(
      1e-6,
      ball.mazeBranchSpeed != null ? Math.abs(ball.mazeBranchSpeed) : Math.hypot(vx, vy),
    );
    if (ax <= 1e-6 && ay <= 1e-6) {
      ball.vx = 0;
      ball.vy = 0;
      return;
    }
    if (ball._mazeAxis === 'h') {
      this._setMazeBallDirection(ball, { x: ball._mazeDirX || Math.sign(vx || 1) || 1, y: 0 }, speed);
      return;
    }
    if (ball._mazeAxis === 'v') {
      this._setMazeBallDirection(ball, { x: 0, y: ball._mazeDirY || Math.sign(vy || 1) || 1 }, speed);
      return;
    }
    this._setMazeBallDirection(ball, ax >= ay
      ? { x: Math.sign(vx) || 1, y: 0 }
      : { x: 0, y: Math.sign(vy) || 1 }, speed);
  }

  _snapMazeBallToCorridorCenter(ball) {
    if (!ball || !ball.mazeBranchOnFixedBounce || ball._frozen || ball.fixed) return;
    const cell = Number(ball.mazeGridCell);
    if (!(cell > 0)) return;
    const originX = Number(ball.mazeGridOriginX);
    const originY = Number(ball.mazeGridOriginY);
    if (!Number.isFinite(originX) || !Number.isFinite(originY)) return;
    const axis = ball._mazeAxis || (Math.abs(ball.vx || 0) >= Math.abs(ball.vy || 0) ? 'h' : 'v');
    if (axis === 'h') {
      const row = Math.round((ball.y - originY) / cell);
      ball.y = originY + row * cell;
    } else {
      const col = Math.round((ball.x - originX) / cell);
      ball.x = originX + col * cell;
    }
  }

  _emitEscape(ball) {
    if (!ball || ball._escaped) return;
    ball._escaped = true;
    ball.alive = false;
    if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
    this.events.push({
      type: 'escape',
      x: ball.x,
      y: ball.y,
      color: ball.color,
      escapeSound: ball.escapeSound || '',
    });
  }

  _mazeExitReached(ball) {
    if (!ball || !ball.mazeBranchOnFixedBounce) return false;
    const side = String(ball.mazeExitSide || '');
    const exitX = Number(ball.mazeExitX);
    const exitY = Number(ball.mazeExitY);
    const cell = Number(ball.mazeGridCell);
    if (!side || !Number.isFinite(exitX) || !Number.isFinite(exitY) || !(cell > 0)) return false;
    const threshold = Number.isFinite(ball.mazeExitThreshold) ? Number(ball.mazeExitThreshold) : Math.max(10, cell * 0.24);
    const span = Number.isFinite(ball.mazeExitSpan) ? Number(ball.mazeExitSpan) : Math.max(8, cell * 0.34);
    const planeOffset = cell * 0.5;
    switch (side) {
      case 'n':
        return Math.abs(ball.x - exitX) <= span && ball.y <= exitY - planeOffset - threshold;
      case 's':
        return Math.abs(ball.x - exitX) <= span && ball.y >= exitY + planeOffset + threshold;
      case 'w':
        return Math.abs(ball.y - exitY) <= span && ball.x <= exitX - planeOffset - threshold;
      case 'e':
        return Math.abs(ball.y - exitY) <= span && ball.x >= exitX + planeOffset + threshold;
      default:
        return false;
    }
  }

  _scatterWallBounce(ball, nx, ny) {
    const rangeDeg = Math.max(0, Math.min(120, ball.wallBounceAngleRange || 0));
    if (rangeDeg <= 0) return;
    const speed = Math.hypot(ball.vx || 0, ball.vy || 0);
    if (speed <= 1e-6) return;
    const tx = -ny;
    const ty = nx;
    const vn = ball.vx * nx + ball.vy * ny;
    const vt = ball.vx * tx + ball.vy * ty;
    if (vn <= 1e-6) return;
    ball._wallScatterCount = (ball._wallScatterCount || 0) + 1;
    const n = ball._wallScatterCount;
    const phase = n * 2.414 + (ball.spawnX != null ? ball.spawnX : ball.x) * 0.013 + (ball.spawnY != null ? ball.spawnY : ball.y) * 0.009;
    const jitter = Math.sin(phase) * (rangeDeg * Math.PI / 180) * 0.5;
    const baseAngle = Math.atan2(vt, vn);
    const maxAngle = Math.min(Math.PI * 0.47, Math.PI * 0.5 - 0.04);
    const targetAngle = Math.max(-maxAngle, Math.min(maxAngle, baseAngle + jitter));
    const nextVn = Math.cos(targetAngle) * speed;
    const nextVt = Math.sin(targetAngle) * speed;
    ball.vx = nx * nextVn + tx * nextVt;
    ball.vy = ny * nextVn + ty * nextVt;
  }

  _afterWallBounce(ball, nx, ny) {
    this._curveBounce(ball, nx, ny);
    this._scatterWallBounce(ball, nx, ny);
    const wallEnergyLoss = Math.max(0, Math.min(0.95, Number(ball.wallEnergyLoss) || 0));
    if (wallEnergyLoss > 0) {
      const scale = 1 - wallEnergyLoss;
      ball.vx *= scale;
      ball.vy *= scale;
    }
    this._clampBallSpeed(ball);
  }

  _clampBallSpeed(ball) {
    const maxSpeed = Math.max(0, ball && ball.maxSpeed || 0);
    if (!(maxSpeed > 0)) return;
    const speed = Math.hypot(ball.vx || 0, ball.vy || 0);
    if (!(speed > maxSpeed) || speed <= 1e-6) return;
    const scale = maxSpeed / speed;
    ball.vx *= scale;
    ball.vy *= scale;
  }

  _physicsSubstepCount(ball, structures, dt) {
    const speed = Math.hypot(ball.vx || 0, ball.vy || 0);
    let edgeTravel = 0;
    for (const s of structures) {
      if (s.type === 'circle') {
        const radius = Math.max(0, (s.radius || 0) + (s.thickness || 0) * 0.5);
        edgeTravel = Math.max(edgeTravel, Math.abs(s.rotationSpeed || 0) * radius * dt);
        continue;
      }
      if (
        s.type === 'spinner'
        && typeof s.mazeSpinSpeed === 'number'
        && Number.isFinite(s.mazeOrbitCx)
        && Number.isFinite(s.mazeOrbitCy)
        && Number.isFinite(s.mazeBaseX)
        && Number.isFinite(s.mazeBaseY)
      ) {
        const orbitRadius = Math.hypot(s.mazeBaseX - s.mazeOrbitCx, s.mazeBaseY - s.mazeOrbitCy);
        const extent = orbitRadius + Math.max(0, (s.armLength || 0) * 0.5) + Math.max(0, (s.thickness || 0) * 0.5);
        edgeTravel = Math.max(edgeTravel, Math.abs(s.mazeSpinSpeed || 0) * extent * dt);
      }
    }
    const travel = speed * dt + Math.abs(this.gravity || 0) * dt * dt + edgeTravel;
    const target = Math.max(2, (ball.radius || 0) * 0.12);
    return Math.max(1, Math.min(48, Math.ceil(travel / target)));
  }

  _setStructureRotationsForSubstep(structures, startT, endT) {
    for (const s of structures) {
      const frameXStart = s._frameXStart != null ? s._frameXStart : (s.x || 0);
      const frameXEnd = s._frameXEnd != null ? s._frameXEnd : (s.x || 0);
      const frameYStart = s._frameYStart != null ? s._frameYStart : (s.y || 0);
      const frameYEnd = s._frameYEnd != null ? s._frameYEnd : (s.y || 0);
      const branchOriginXStart = s._frameBranchOriginXStart != null ? s._frameBranchOriginXStart : s.mazeBranchOriginX;
      const branchOriginXEnd = s._frameBranchOriginXEnd != null ? s._frameBranchOriginXEnd : s.mazeBranchOriginX;
      const branchOriginYStart = s._frameBranchOriginYStart != null ? s._frameBranchOriginYStart : s.mazeBranchOriginY;
      const branchOriginYEnd = s._frameBranchOriginYEnd != null ? s._frameBranchOriginYEnd : s.mazeBranchOriginY;
      const frameStart = s._frameRotationStart != null ? s._frameRotationStart : (s.rotation || 0);
      const frameEnd = s._frameRotationEnd != null ? s._frameRotationEnd : (s.rotation || 0);
      const delta = shortestAngleDelta(frameStart, frameEnd);
      s.x = frameXStart + (frameXEnd - frameXStart) * endT;
      s.y = frameYStart + (frameYEnd - frameYStart) * endT;
      if (branchOriginXStart != null && branchOriginXEnd != null) {
        s.mazeBranchOriginX = branchOriginXStart + (branchOriginXEnd - branchOriginXStart) * endT;
      }
      if (branchOriginYStart != null && branchOriginYEnd != null) {
        s.mazeBranchOriginY = branchOriginYStart + (branchOriginYEnd - branchOriginYStart) * endT;
      }
      s._prevRotation = frameStart + delta * startT;
      s.rotation = frameStart + delta * endT;
    }
  }

  _curveBounce(ball, nx, ny) {
    const strength = Math.max(0, Math.min(1, ball.wallCurve || 0));
    const drift = Math.max(0, Math.min(1, ball.wallDrift || 0));
    if (strength <= 0 && drift <= 0) return;
    const tx = -ny;
    const ty = nx;
    let vt = ball.vx * tx + ball.vy * ty;
    const dir = Math.abs(vt) > 1e-6 ? Math.sign(vt) : 1;
    ball._wallBounceCount = (ball._wallBounceCount || 0) + 1;
    const n = ball._wallBounceCount;
    // Base curve follows the current tangent so rebounds feel less robotic.
    this._rotateVelocity(ball, dir * strength * 0.24);

    if (drift <= 0) return;

    // Deterministic slip gate: only some wall hits START a slide sequence.
    const phase = n * 1.618 + (ball.spawnX != null ? ball.spawnX : ball.x) * 0.01;
    const slipGate = 0.5 + 0.5 * Math.sin(phase);

    // Recompute the tangent component after the base curve. We ONLY enhance a
    // downward slide when the ball is already traveling along the downward
    // tangent of the ring. That prevents the abrupt "instant turn-back"
    // behaviour that looked fake.
    vt = ball.vx * tx + ball.vy * ty;
    const tangentDir = Math.abs(vt) > 1e-6 ? Math.sign(vt) : dir;
    const downwardAlongTangent = tangentDir * ty;
    if (downwardAlongTangent <= 0.08) {
      ball._wallSlideLife = 0;
      return;
    }

    const shouldStartSlide = slipGate >= 0.36;
    if (shouldStartSlide) {
      ball._wallSlideLife = Math.max(ball._wallSlideLife || 0, 2 + Math.round(drift * 3));
    }
    const slideLife = ball._wallSlideLife || 0;
    if (slideLife <= 0) return;

    const speed = Math.hypot(ball.vx || 0, ball.vy || 0);
    if (speed <= 1e-6) return;
    const vn = ball.vx * nx + ball.vy * ny;
    const lifeBoost = Math.min(1, slideLife / 4);
    const slip = Math.max(0, Math.min(
      0.82,
      drift * (0.22 + slipGate * 0.26 + lifeBoost * 0.22) * downwardAlongTangent
    ));

    // Keep the SAME tangential direction, but trade some normal rebound for
    // extra tangent. This creates a believable wall-hugging drop instead of a
    // discontinuous reversal.
    let tanMag = vt * (1 + slip * 0.8);
    let normMag = vn * Math.max(0.10, 1 - slip * 1.05);
    const outSpeed = Math.hypot(tanMag, normMag) || 1;
    tanMag = tanMag / outSpeed * speed;
    normMag = normMag / outSpeed * speed;
    ball.vx = tx * tanMag + nx * normMag;
    ball.vy = ty * tanMag + ny * normMag;
    this._clampBallSpeed(ball);
    ball._wallSlideLife = Math.max(0, slideLife - 1);
  }

  _spreadBallCollision(ball, nx, ny, fallbackDir = 1) {
    const strength = Math.max(0, Math.min(1,
      ball.collisionSpread != null ? ball.collisionSpread : 0.35
    ));
    if (strength <= 0) return;
    const tx = -ny;
    const ty = nx;
    const vt = ball.vx * tx + ball.vy * ty;
    const dir = Math.abs(vt) > 1e-6 ? Math.sign(vt) : fallbackDir;
    // Up to ~20 degrees of extra fan-out after ball-ball hits.
    this._rotateVelocity(ball, dir * strength * 0.35);
    this._clampBallSpeed(ball);
  }

  _cycleBallCollisionColor(ball) {
    if (!ball.changeColorOnBallCollision) return;
    if (ball._collisionColorIndex == null) {
      const idx = COLLISION_COLOR_PALETTE.indexOf(String(ball.color || '').toLowerCase());
      ball._collisionColorIndex = idx >= 0 ? idx : -1;
    }
    ball._collisionColorIndex = (ball._collisionColorIndex + 1) % COLLISION_COLOR_PALETTE.length;
    ball.color = COLLISION_COLOR_PALETTE[ball._collisionColorIndex];
  }

  _mazeBranchSpawnOffset(parent, markerRadius = 0) {
    return Math.max(
      (parent.radius || 0) * 2.4,
      (parent.radius || 0) + markerRadius + 10,
    );
  }

  _resetMazeBranchVisualState(ball) {
    if (!ball) return;
    ball._trail = [];
    ball._softStretch = 0;
    ball._softSquash = 0;
    ball._softFlow = 0;
    ball._softPress = 0;
    ball._softSkew = 0;
    ball._softWobbleAmp = 0;
    ball._softWobblePhase = 0;
    ball._softAxisX = Math.abs(ball.vx || 0) >= Math.abs(ball.vy || 0) ? Math.sign(ball.vx || 1) : 0;
    ball._softAxisY = Math.abs(ball.vy || 0) > Math.abs(ball.vx || 0) ? Math.sign(ball.vy || 1) : 0;
  }

  _spawnMazeBranchChildren(state, parent, directions, speed, options = {}) {
    state._mazeBranchSeq = (state._mazeBranchSeq || 0) + 1;
    const seq = state._mazeBranchSeq;
    const markerRadius = Math.max(0, options.markerRadius || 0);
    const spawnOriginX = options.spawnOriginX != null ? options.spawnOriginX : parent.x;
    const spawnOriginY = options.spawnOriginY != null ? options.spawnOriginY : parent.y;
    const offset = options.startCentered ? 0 : this._mazeBranchSpawnOffset(parent, markerRadius);
    const graceFrames = Math.max(0, parent.mazeBranchGraceFrames != null ? (parent.mazeBranchGraceFrames | 0) : 6);
    const splitIgnoreFrames = options.startCentered ? 2 : 0;
    const nextGeneration = (parent.mazeBranchGeneration | 0) + 1;
    const makeChild = (dir, idx) => ({
      id: `maze_branch_${seq}_${idx}`,
      type: 'ball',
      x: spawnOriginX + dir.x * offset,
      y: spawnOriginY + dir.y * offset,
      spawnX: spawnOriginX + dir.x * offset,
      spawnY: spawnOriginY + dir.y * offset,
      vx: dir.x * speed,
      vy: dir.y * speed,
      radius: parent.radius,
      color: parent.color,
      trail: parent.trail,
      trailLength: parent.trailLength,
      clearTrailOnDeath: parent.clearTrailOnDeath,
      lifetime: parent.lifetime,
      freezeOnTimeout: parent.freezeOnTimeout,
      fixed: false,
      ballBehaviorPreset: parent.ballBehaviorPreset || 'custom',
      maxSpeed: parent.maxSpeed || 0,
      bounce: parent.bounce != null ? parent.bounce : 1.0,
      wallCurve: parent.wallCurve != null ? parent.wallCurve : 0,
      wallDrift: parent.wallDrift != null ? parent.wallDrift : 0,
      wallBounceAngleRange: parent.wallBounceAngleRange != null ? parent.wallBounceAngleRange : 0,
      collisionSpread: parent.collisionSpread != null ? parent.collisionSpread : 0.35,
      softBody: !!parent.softBody,
      elasticity: parent.elasticity != null ? parent.elasticity : 0.55,
      recoverySpeed: parent.recoverySpeed != null ? parent.recoverySpeed : 6.0,
      wobbleIntensity: parent.wobbleIntensity != null ? parent.wobbleIntensity : 0.45,
      wobbleDamping: parent.wobbleDamping != null ? parent.wobbleDamping : 7.0,
      changeColorOnBallCollision: !!parent.changeColorOnBallCollision,
      deadColor: parent.deadColor || '#3a3a3a',
      recolorOnFreeze: !!parent.recolorOnFreeze,
      deathBurstOnFreeze: !!parent.deathBurstOnFreeze,
      bounceSound: parent.bounceSound || '',
      bounceSoundOn: parent.bounceSoundOn || 'all',
      escapeSound: parent.escapeSound || '',
      destroySound: parent.destroySound || '',
      deathSound: parent.deathSound || '',
      collisionHoleEnabled: !!parent.collisionHoleEnabled,
      collisionHoleSize: parent.collisionHoleSize != null ? parent.collisionHoleSize : 0.42,
      collisionHoleTarget: parent.collisionHoleTarget || 'auto',
      collisionHolePlacement: parent.collisionHolePlacement || 'impact',
      collisionHoleOnCircle: !!parent.collisionHoleOnCircle,
      collisionHoleOnArc: !!parent.collisionHoleOnArc,
      collisionHoleOnSpikes: !!parent.collisionHoleOnSpikes,
      collisionHoleOnSpinner: !!parent.collisionHoleOnSpinner,
      collisionHoleOnBall: !!parent.collisionHoleOnBall,
      collisionHoleOnFixedBall: !!parent.collisionHoleOnFixedBall,
      destroyOnSpike: parent.destroyOnSpike !== false,
      freezeOnSpike: !!parent.freezeOnSpike,
      mazeBranchOnFixedBounce: !!parent.mazeBranchOnFixedBounce,
      mazeBranchSpeed: parent.mazeBranchSpeed != null ? parent.mazeBranchSpeed : speed,
      mazeBranchGraceFrames: graceFrames,
      mazeBranchGeneration: nextGeneration,
      mazeBranchMaxGeneration: parent.mazeBranchMaxGeneration != null ? parent.mazeBranchMaxGeneration : 0,
      mazeGridCell: parent.mazeGridCell,
      mazeGridOriginX: parent.mazeGridOriginX,
      mazeGridOriginY: parent.mazeGridOriginY,
      mazeExitSide: parent.mazeExitSide,
      mazeExitX: parent.mazeExitX,
      mazeExitY: parent.mazeExitY,
      mazeExitThreshold: parent.mazeExitThreshold,
      mazeExitSpan: parent.mazeExitSpan,
      alive: true,
      age: 0,
      motion: 'physics',
      orbitCx: parent.orbitCx != null ? parent.orbitCx : 540,
      orbitCy: parent.orbitCy != null ? parent.orbitCy : 960,
      orbitRadius: parent.orbitRadius != null ? parent.orbitRadius : 280,
      orbitHarmonic: parent.orbitHarmonic != null ? parent.orbitHarmonic : 1,
      orbitPhase: parent.orbitPhase != null ? parent.orbitPhase : 0,
      orbitDirection: parent.orbitDirection != null ? parent.orbitDirection : 1,
      lissaRadiusY: parent.lissaRadiusY != null ? parent.lissaRadiusY : 280,
      lissaHarmonicY: parent.lissaHarmonicY != null ? parent.lissaHarmonicY : 1,
      lissaPhaseY: parent.lissaPhaseY != null ? parent.lissaPhaseY : Math.PI / 2,
      _mazeAxis: Math.abs(dir.x || 0) >= Math.abs(dir.y || 0) ? 'h' : 'v',
      _mazeDirX: Math.sign(dir.x || 0),
      _mazeDirY: Math.sign(dir.y || 0),
      _trail: [],
      _mazeBranchCooldown: graceFrames,
      _mazeSplitGroup: seq,
      _mazeSplitIgnoreBallFrames: splitIgnoreFrames,
    });
    for (let i = 0; i < directions.length; i++) {
      const child = makeChild(directions[i], i + 1);
      this._setMazeBallDirection(child, directions[i], speed);
      this._resetMazeBranchVisualState(child);
      state.objects.push(child);
    }
    return seq;
  }

  _mazeProbeHitsSpinner(x, y, radius, sp) {
    const armLength = Math.max(10, sp.armLength || 0);
    const half = armLength * 0.5;
    const halfThickness = Math.max(2, sp.thickness || 0) * 0.5;
    const armCount = Math.max(1, sp.armCount | 0);
    const limit = radius + halfThickness;
    for (let i = 0; i < armCount; i++) {
      const a = (sp.rotation || 0) + i * (Math.PI / armCount);
      const dx = Math.cos(a) * half;
      const dy = Math.sin(a) * half;
      const ax = sp.x - dx;
      const ay = sp.y - dy;
      const bx = sp.x + dx;
      const by = sp.y + dy;
      const closest = closestPointOnSegment(x, y, ax, ay, bx, by);
      const dist = Math.hypot(x - closest.x, y - closest.y);
      if (dist < limit) return true;
    }
    return false;
  }

  _mazeDirectionOpen(state, parent, originX, originY, dir, ignoreSpinner = null) {
    if (!state || !parent || !dir) return false;
    const travel = Math.max(52, (parent.radius || 0) * 4.2);
    const samples = 6;
    const probeRadius = Math.max(3, (parent.radius || 0) * 0.22);
    const structures = (state.objects || []).filter((o) => o && o.type === 'spinner');
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const px = originX + dir.x * travel * t;
      const py = originY + dir.y * travel * t;
      for (const s of structures) {
        if (ignoreSpinner && s === ignoreSpinner) continue;
        if (this._mazeProbeHitsSpinner(px, py, probeRadius, s)) return false;
      }
    }
    return true;
  }

  _maybeMazeBranchOnWallBounce(state, ball, incomingVx, incomingVy, markerRadius = 0, hitWall = null) {
    if (!state || !ball) return false;
    if (!ball.alive || ball.fixed || ball._frozen) return false;
    if (!ball.mazeBranchOnFixedBounce) return false;
    if ((ball._mazeBranchCooldown || 0) > 0) return false;
    const ax = Math.abs(incomingVx || 0);
    const ay = Math.abs(incomingVy || 0);
    if (ax <= 1e-6 && ay <= 1e-6) return false;

    const horizontalIncoming = ax >= ay;
    const sign = horizontalIncoming
      ? (Math.sign(incomingVx || 0) || 1)
      : (Math.sign(incomingVy || 0) || 1);
    const directions = horizontalIncoming
      ? [{ x: 0, y: sign }, { x: 0, y: -sign }]
      : [{ x: sign, y: 0 }, { x: -sign, y: 0 }];
    const forwardDir = horizontalIncoming
      ? { x: sign, y: 0 }
      : { x: 0, y: sign };
    const maxGeneration = Math.max(0, ball.mazeBranchMaxGeneration | 0);
    const nextGeneration = (ball.mazeBranchGeneration | 0) + 1;
    const graceFrames = Math.max(0, ball.mazeBranchGraceFrames != null ? (ball.mazeBranchGraceFrames | 0) : 6);
    const speed = Math.max(180, ball.mazeBranchSpeed != null
      ? Math.abs(ball.mazeBranchSpeed)
      : Math.hypot(incomingVx || 0, incomingVy || 0));
    const backoff = Math.max(
      (ball.radius || 0) + markerRadius + 2,
      (ball.radius || 0) * 1.2,
    );
    const fallbackOriginX = ball.x - forwardDir.x * backoff;
    const fallbackOriginY = ball.y - forwardDir.y * backoff;
    const explicitDirections = Array.isArray(hitWall && hitWall.mazeBranchDirs)
      ? hitWall.mazeBranchDirs
        .map((dir) => {
          const x = Math.sign(dir && dir.x || 0);
          const y = Math.sign(dir && dir.y || 0);
          return (x || y) ? { x, y } : null;
        })
        .filter(Boolean)
      : null;
    const originX = hitWall && hitWall.mazeBranchOriginX != null ? hitWall.mazeBranchOriginX : fallbackOriginX;
    const originY = hitWall && hitWall.mazeBranchOriginY != null ? hitWall.mazeBranchOriginY : fallbackOriginY;
    const openDirections = explicitDirections || directions.filter((dir) => (
      this._mazeDirectionOpen(state, ball, originX, originY, dir, hitWall)
    ));

    if (hitWall && hitWall.mazeBranchTrigger) {
      if (maxGeneration > 0 && nextGeneration > maxGeneration) return false;
      if (openDirections.length <= 0) return false;
      let primaryDir = openDirections[0];
      let bestDot = -Infinity;
      for (const dir of openDirections) {
        const dot = dir.x * (incomingVx || 0) + dir.y * (incomingVy || 0);
        if (dot > bestDot) {
          bestDot = dot;
          primaryDir = dir;
        }
      }
      // Spawn a child ball in EVERY remaining open direction, not just one.
      // Otherwise a 3-way junction (e.g. S + E + W) would only produce two
      // balls and one corridor would stay unexplored forever.
      const extraDirections = openDirections.filter((dir) => dir !== primaryDir);
      let splitGroup = null;
      if (extraDirections.length > 0) {
        splitGroup = this._spawnMazeBranchChildren(state, ball, extraDirections, speed, {
          markerRadius,
          spawnOriginX: originX,
          spawnOriginY: originY,
          startCentered: true,
        });
      }
      ball.x = originX;
      ball.y = originY;
      ball.spawnX = ball.x;
      ball.spawnY = ball.y;
      this._setMazeBallDirection(ball, primaryDir, speed);
      ball.mazeBranchGeneration = nextGeneration;
      ball._mazeBranchCooldown = graceFrames;
      ball._mazeSplitGroup = splitGroup;
      ball._mazeSplitIgnoreBallFrames = splitGroup ? 2 : 0;
      this._resetMazeBranchVisualState(ball);
      return extraDirections.length > 0;
    }

    ball.fixed = true;
    ball.vx = 0;
    ball.vy = 0;
    ball.mazeWall = false;
    ball._mazeBranchCooldown = Number.POSITIVE_INFINITY;

    this.events.push({
      type: 'freeze',
      x: ball.x,
      y: ball.y,
      color: ball.color,
      deathBurst: false,
      deathSound: 'silent',
    });

    if (maxGeneration > 0 && nextGeneration > maxGeneration) return true;
    if (openDirections.length <= 0) return true;
    this._spawnMazeBranchChildren(state, ball, openDirections, speed, {
      markerRadius,
      spawnOriginX: originX,
      spawnOriginY: originY,
    });
    return true;
  }

  _maybeMazeBranchOnFixedBounce(state, ball, fixedBall, incomingVx, incomingVy) {
    if (!state || !ball || !fixedBall) return false;
    if (!fixedBall.mazeWall) return false;
    if (!ball.mazeBranchOnFixedBounce) return false;
    return this._maybeMazeBranchOnWallBounce(
      state,
      ball,
      incomingVx,
      incomingVy,
      fixedBall.radius || 0,
    );
  }

  _collideCircleRing(ball, c, time = 0, state = null) {
    const dx = ball.x - c.x;
    const dy = ball.y - c.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return false;
    const prevX = ball._prevX != null ? ball._prevX : ball.x;
    const prevY = ball._prevY != null ? ball._prevY : ball.y;
    const prevDist = Math.hypot(prevX - c.x, prevY - c.y);
    const nx = dx / dist;
    const ny = dy / dist;
    const angle = Math.atan2(dy, dx);
    const prevAngle = Math.atan2(prevY - c.y, prevX - c.x);
    const contactKey = c.id || '__circle';
    if (!ball._ringContact) ball._ringContact = Object.create(null);
    this._debugGap('gapTrace', {
      ballId: ball.id,
      colliderId: c.id || null,
      colliderType: 'circle',
      x: Number((ball.x || 0).toFixed(2)),
      y: Number((ball.y || 0).toFixed(2)),
      prevX: Number((prevX || 0).toFixed(2)),
      prevY: Number((prevY || 0).toFixed(2)),
      dist: Number(dist.toFixed(2)),
      prevDist: Number(prevDist.toFixed(2)),
      angle: Number(angle.toFixed(4)),
      prevAngle: Number(prevAngle.toFixed(4)),
      gapFitNow: ballFitsCircleGap(ball, c, time, angle),
      time,
    });

    if (this._collideCircleGapEdges(ball, c, time, contactKey)) {
      return true;
    }

    const sweepDebug = (details) => this._debugGap('gapSweep', {
      ballId: ball.id,
      colliderId: c.id || null,
      colliderType: 'circle',
      x: Number((ball.x || 0).toFixed(2)),
      y: Number((ball.y || 0).toFixed(2)),
      dist: Number(dist.toFixed(2)),
      prevDist: Number(prevDist.toFixed(2)),
      angle: Number(angle.toFixed(4)),
      prevAngle: Number(prevAngle.toFixed(4)),
      time,
      ...details,
    });
    if (ballSweepsThroughCircleGap(ball, c, time, prevAngle, angle, null, null, sweepDebug)) {
      // Skip wall -> ball can escape through the gap.
      ball._ringContact[contactKey] = false;
      this._debugGap('gapOpen', {
        ballId: ball.id,
        colliderId: c.id || null,
        colliderType: 'circle',
        x: Number((ball.x || 0).toFixed(2)),
        y: Number((ball.y || 0).toFixed(2)),
        time,
      });
      return false;
    }

    if (c.insideOnly) {
      // Containing rings are solid from BOTH sides. This matters for nested
      // rings: once a ball escapes an inner ring it should still be able to
      // bounce off that ring's outside wall while remaining inside a larger
      // outer ring.
      const innerLimit = c.radius - (c.thickness / 2) - ball.radius;
      const outerLimit = c.radius + (c.thickness / 2) + ball.radius;
      const releaseMargin = Math.max(2, ball.radius * 0.18);
      const farInside = dist < innerLimit - releaseMargin;
      const farOutside = dist > outerLimit + releaseMargin;
      if (farInside || farOutside) ball._ringContact[contactKey] = false;

      // Use the real contact limits for new impacts. `releaseMargin` is only
      // for de-bouncing an existing contact; using it here makes the ring
      // reflect a couple of pixels before the ball truly reaches the band.
      const wasInside = prevDist <= innerLimit;
      const wasOutside = prevDist >= outerLimit;
      const crossedInner = wasInside && dist > innerLimit;
      const crossedOuter = wasOutside && dist < outerLimit;
      const insideWallBand = dist > innerLimit && dist <= c.radius;
      const outsideWallBand = dist < outerLimit && dist >= c.radius;

      // If the ball is nowhere near the visible ring band and did not cross
      // into it this frame, there is nothing to collide with.
      if (!crossedInner && !crossedOuter && !insideWallBand && !outsideWallBand) {
        ball._ringContact[contactKey] = false;
        return false;
      }

      let push = 0;
      let branch = 'insideOnlyInner';
      let reflectNx = nx;
      let reflectNy = ny;

      if (crossedInner || (insideWallBand && (!crossedOuter || prevDist <= c.radius))) {
        push = dist - innerLimit;
        branch = 'insideOnlyInner';
        ball.x -= nx * push;
        ball.y -= ny * push;
        reflectNx = nx;
        reflectNy = ny;
      } else if (crossedOuter || outsideWallBand) {
        push = outerLimit - dist;
        branch = 'insideOnlyOuter';
        ball.x += nx * push;
        ball.y += ny * push;
        reflectNx = nx;
        reflectNy = ny;
      } else {
        // Fallback for very fast overlaps inside the ring thickness: resolve to
        // the nearest visible side of the band.
        const pushToInner = Math.max(0, dist - innerLimit);
        const pushToOuter = Math.max(0, outerLimit - dist);
        if (pushToInner <= pushToOuter) {
          push = pushToInner;
          branch = 'insideOnlyInner';
          ball.x -= nx * push;
          ball.y -= ny * push;
        } else {
          push = pushToOuter;
          branch = 'insideOnlyOuter';
          ball.x += nx * push;
          ball.y += ny * push;
        }
        reflectNx = nx;
        reflectNy = ny;
      }

      if (push > 0) {
        const incomingVx = ball.vx || 0;
        const incomingVy = ball.vy || 0;
        const impactSpeed = Math.abs(ball.vx * reflectNx + ball.vy * reflectNy);
        this._reflect(ball, reflectNx, reflectNy, ball.bounce);
        this._afterWallBounce(ball, reflectNx, reflectNy);
        this._applySoftBodyImpact(ball, reflectNx, reflectNy, impactSpeed);
        if (!ball._ringContact[contactKey]) {
          this.events.push({
            type: 'bounce',
            source: 'circle',
            x: ball.x,
            y: ball.y,
            color: ball.color,
            ballId: ball.id,
            colliderId: c.id,
            colliderType: 'circle',
            branch,
            bounceSound: ball.bounceSound || '',
            bounceSoundOn: ball.bounceSoundOn || 'all',
          });
          this._debugCollision('circle', {
            ballId: ball.id,
            colliderId: c.id,
            colliderType: 'circle',
            branch,
            x: Number(ball.x.toFixed(2)),
            y: Number(ball.y.toFixed(2)),
            dist: Number(dist.toFixed(2)),
            prevDist: Number(prevDist.toFixed(2)),
            innerLimit: Number(innerLimit.toFixed(2)),
            outerLimit: Number(outerLimit.toFixed(2)),
            push: Number(push.toFixed(2)),
            angle: Number(angle.toFixed(3)),
            gapPass: false,
            gapSize: Number((effectiveCircleGapSize(c, time) || 0).toFixed(3)),
            insideOnly: !!c.insideOnly,
            wasInside,
            wasOutside,
            crossedInner,
            crossedOuter,
            insideWallBand,
            outsideWallBand,
          });
          this._maybeCreateCollisionHole(ball, c, 'circle', state, {
            anchorX: c.x + Math.cos(angle) * (c.radius || 0),
            anchorY: c.y + Math.sin(angle) * (c.radius || 0),
            incomingVx,
            incomingVy,
          });
          ball._ringContact[contactKey] = true;
        }
        return true;
      }
    } else {
      // Solid wall from outside.
      const outerLimit = c.radius + (c.thickness / 2) + ball.radius;
      const releaseMargin = Math.max(2, ball.radius * 0.18);
      if (dist > outerLimit + releaseMargin) ball._ringContact[contactKey] = false;
      if (dist < outerLimit) {
        const push = outerLimit - dist;
        ball.x += nx * push;
        ball.y += ny * push;
        const incomingVx = ball.vx || 0;
        const incomingVy = ball.vy || 0;
        const impactSpeed = Math.abs(ball.vx * nx + ball.vy * ny);
        this._reflect(ball, nx, ny, ball.bounce);
        this._afterWallBounce(ball, nx, ny);
        this._applySoftBodyImpact(ball, nx, ny, impactSpeed);
        if (!ball._ringContact[contactKey]) {
          this.events.push({
            type: 'bounce',
            source: 'circle',
            x: ball.x,
            y: ball.y,
            color: ball.color,
            ballId: ball.id,
            colliderId: c.id,
            colliderType: 'circle',
            branch: 'outsideWall',
            bounceSound: ball.bounceSound || '',
            bounceSoundOn: ball.bounceSoundOn || 'all',
          });
          this._debugCollision('circle', {
            ballId: ball.id,
            colliderId: c.id,
            colliderType: 'circle',
            branch: 'outsideWall',
            x: Number(ball.x.toFixed(2)),
            y: Number(ball.y.toFixed(2)),
            dist: Number(dist.toFixed(2)),
            limit: Number(outerLimit.toFixed(2)),
            push: Number(push.toFixed(2)),
            angle: Number(angle.toFixed(3)),
            gapPass: false,
            gapSize: Number((effectiveCircleGapSize(c, time) || 0).toFixed(3)),
            insideOnly: !!c.insideOnly,
          });
          this._maybeCreateCollisionHole(ball, c, 'circle', state, {
            anchorX: c.x + Math.cos(angle) * (c.radius || 0),
            anchorY: c.y + Math.sin(angle) * (c.radius || 0),
            incomingVx,
            incomingVy,
          });
          ball._ringContact[contactKey] = true;
        }
        return true;
      }
    }
    return false;
  }

  _collideArc(ball, a, state = null) {
    const dx = ball.x - a.x;
    const dy = ball.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return false;
    const angle = Math.atan2(dy, dx);
    if (!angleInArc(angle, a.startAngle, a.endAngle, a.rotation || 0)) return false;

    const nx = dx / dist;
    const ny = dy / dist;
    const inner = a.radius - a.thickness / 2 - ball.radius;
    const outer = a.radius + a.thickness / 2 + ball.radius;

    if (dist > inner && dist < outer) {
      const incomingVx = ball.vx || 0;
      const incomingVy = ball.vy || 0;
      if (dist < a.radius) {
        // Hit from the inside -> push ball inward and reflect off outward normal.
        const push = inner - dist;
        ball.x += nx * push; ball.y += ny * push;
        const impactSpeed = Math.abs(ball.vx * -nx + ball.vy * -ny);
        this._reflect(ball, -nx, -ny, ball.bounce);
        this._afterWallBounce(ball, -nx, -ny);
        this._applySoftBodyImpact(ball, -nx, -ny, impactSpeed);
      } else {
        // Hit from the outside -> push outward and reflect off inward normal.
        const push = outer - dist;
        ball.x += nx * push; ball.y += ny * push;
        const impactSpeed = Math.abs(ball.vx * nx + ball.vy * ny);
        this._reflect(ball, nx, ny, ball.bounce);
        this._afterWallBounce(ball, nx, ny);
        this._applySoftBodyImpact(ball, nx, ny, impactSpeed);
      }
      this.events.push({
        type: 'bounce',
        source: 'arc',
        x: ball.x,
        y: ball.y,
        color: ball.color,
        ballId: ball.id,
        colliderId: a.id || null,
        colliderType: 'arc',
        bounceSound: ball.bounceSound || '',
        bounceSoundOn: ball.bounceSoundOn || 'all',
      });
      this._debugCollision('arc', {
        ballId: ball.id,
        colliderId: a.id || null,
        colliderType: 'arc',
        x: Number(ball.x.toFixed(2)),
        y: Number(ball.y.toFixed(2)),
        dist: Number(dist.toFixed(2)),
        inner: Number(inner.toFixed(2)),
        outer: Number(outer.toFixed(2)),
        angle: Number(angle.toFixed(3)),
      });
      this._maybeCreateCollisionHole(ball, a, 'arc', state, {
        anchorX: a.x + Math.cos(angle) * (a.radius || 0),
        anchorY: a.y + Math.sin(angle) * (a.radius || 0),
        incomingVx,
        incomingVy,
      });
      return true;
    }
    return false;
  }

  _collideSpiral(ball, sp, state = null) {
    if (sp.continuous) {
      const turns = Math.max(0.25, Number(sp.turns) || 4);
      const samples = Math.max(80, sp.samples | 0 || Math.round(turns * 96));
      const inner = Number.isFinite(sp.innerRadius) ? sp.innerRadius : 60;
      const outer = Number.isFinite(sp.outerRadius) ? sp.outerRadius : 430;
      const startAngle = Number.isFinite(sp.startAngle) ? sp.startAngle : 0;
      const direction = sp.direction === -1 ? -1 : 1;
      const radius = Math.max(1, (sp.thickness || 8) * 0.5 + (ball.radius || 0));
      let prev = null;
      let nearest = null;
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const a = startAngle + direction * (Math.PI * 2) * turns * t;
        const r = outer + (inner - outer) * t;
        const p = { x: (sp.x || 0) + Math.cos(a) * r, y: (sp.y || 0) + Math.sin(a) * r };
        if (prev) {
          const vx = p.x - prev.x;
          const vy = p.y - prev.y;
          const len2 = vx * vx + vy * vy || 1;
          const u = Math.max(0, Math.min(1, (((ball.x || 0) - prev.x) * vx + ((ball.y || 0) - prev.y) * vy) / len2));
          const x = prev.x + vx * u;
          const y = prev.y + vy * u;
          const d = Math.hypot((ball.x || 0) - x, (ball.y || 0) - y);
          if (!nearest || d < nearest.d) nearest = { d, x, y };
        }
        prev = p;
      }
      if (!nearest || nearest.d >= radius) return false;
      const nx = ((ball.x || 0) - nearest.x) / Math.max(1e-6, nearest.d);
      const ny = ((ball.y || 0) - nearest.y) / Math.max(1e-6, nearest.d);
      const push = radius - nearest.d;
      ball.x += nx * push;
      ball.y += ny * push;
      const impactSpeed = Math.abs((ball.vx || 0) * nx + (ball.vy || 0) * ny);
      this._reflect(ball, nx, ny, ball.bounce);
      this._afterWallBounce(ball, nx, ny);
      this._applySoftBodyImpact(ball, nx, ny, impactSpeed);
      this.events.push({
        type: 'bounce',
        source: 'spiral',
        x: ball.x,
        y: ball.y,
        color: ball.color,
        ballId: ball.id,
        colliderId: sp.id,
        colliderType: 'spiral',
        bounceSound: ball.bounceSound || '',
        bounceSoundOn: ball.bounceSoundOn || 'all',
      });
      if (state) {
        this._maybeCreateCollisionHole(ball, sp, 'spiral', state, {
          anchorX: nearest.x,
          anchorY: nearest.y,
          incomingVx: ball.vx || 0,
          incomingVy: ball.vy || 0,
        });
      }
      return true;
    }
    // Match the renderer exactly: each spiral layer is a visible arc, not a
    // full hidden ring. The previous fake-circle approach created invisible
    // collision walls across the gap, which is why balls appeared to bounce on
    // drawn-nothing semicircles.
    const layers = Math.max(1, sp.layers | 0);
    const step = (sp.outerRadius - sp.innerRadius) / layers;
    let hit = false;
    for (let i = 0; i < layers; i++) {
      const r = sp.innerRadius + step * (i + 0.5);
      const fakeArc = {
        type: 'arc',
        x: sp.x, y: sp.y,
        radius: r,
        thickness: sp.thickness,
        rotation: (sp.rotation || 0) + i * (Math.PI * 2 / layers),
        startAngle: sp.gapSize || 0,
        endAngle: Math.PI * 2,
        color: sp.color,
      };
      if (this._collideArc(ball, fakeArc, state)) hit = true;
    }
    return hit;
  }

  _collideSpikes(ball, sp, state = null) {
    if (sp.markerPath === 'spiral') return false;
    const dx = ball.x - sp.x;
    const dy = ball.y - sp.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return false;
    const spikeTipR = sp.inward ? sp.radius - sp.length : sp.radius + sp.length;
    const minR = Math.min(sp.radius, spikeTipR) - ball.radius - 4;
    const maxR = Math.max(sp.radius, spikeTipR) + ball.radius + 4;
    if (dist < minR || dist > maxR) return false;

    const angle = normalizeAngle(Math.atan2(dy, dx) - (sp.rotation || 0));
    const sector = (Math.PI * 2) / sp.count;
    const idx = Math.round(angle / sector);
    const relAngle = normalizeAngle(idx * sector);
    // Skip the nearest spike if it falls inside the ring's gap -- physics
    // must match the visual: a missing tooth should not collide.
    if (sp.gapSize > 0) {
      const start = normalizeAngle(sp.gapStart || 0);
      const end = normalizeAngle(start + sp.gapSize);
      const inGap = start <= end ? (relAngle >= start && relAngle <= end)
                                 : (relAngle >= start || relAngle <= end);
      if (inGap) return false;
    }
    const spikeAngle = idx * sector + (sp.rotation || 0);

    // Triangle tip + two base corners (in world space).
    const baseR = sp.radius;
    const tipR = spikeTipR;
    const halfWidth = sp.width / 2;
    const halfWidthAngle = halfWidth / baseR;
    const tipX = sp.x + Math.cos(spikeAngle) * tipR;
    const tipY = sp.y + Math.sin(spikeAngle) * tipR;
    const b1x = sp.x + Math.cos(spikeAngle - halfWidthAngle) * baseR;
    const b1y = sp.y + Math.sin(spikeAngle - halfWidthAngle) * baseR;
    const b2x = sp.x + Math.cos(spikeAngle + halfWidthAngle) * baseR;
    const b2y = sp.y + Math.sin(spikeAngle + halfWidthAngle) * baseR;

    // Point-in-triangle or near-edge test.
    if (pointInTriangle(ball.x, ball.y, tipX, tipY, b1x, b1y, b2x, b2y) ||
        segmentDistance(ball.x, ball.y, tipX, tipY, b1x, b1y) < ball.radius ||
        segmentDistance(ball.x, ball.y, tipX, tipY, b2x, b2y) < ball.radius) {
      if (sp.freezes && ball.freezeOnSpike && !ball._frozen) {
        // Hard-freeze: the ball sticks where it is and becomes a solid
        // obstacle for any other ball. Nudge it slightly off the spike
        // (away from its base) so it doesn't keep re-triggering next step.
        // For inward spikes (tips pointing toward the center) "away" means
        // toward the center; for outward spikes it's away from center.
        const nx = (ball.x - sp.x) / dist;
        const ny = (ball.y - sp.y) / dist;
        const nudge = sp.inward ? -2 : 2;
        ball.x += nx * nudge; ball.y += ny * nudge;
        ball._frozen = true;
        ball.vx = 0; ball.vy = 0;
        const burstColor = ball.color;
        if (ball.recolorOnFreeze) ball.color = ball.deadColor || '#3a3a3a';
        if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
        this.events.push({
          type: 'freeze',
          x: ball.x, y: ball.y, color: burstColor,
          deathBurst: !!ball.deathBurstOnFreeze,
          deathSound: ball.deathSound || '',
        });
      } else if (sp.destroys && ball.destroyOnSpike) {
        ball.alive = false;
        this.events.push({
          type: 'destroy', x: ball.x, y: ball.y, color: ball.color,
          destroySound: ball.destroySound || '',
        });
      } else {
        // Bounce off the spike tip as a radial reflection.
        const nx = (ball.x - sp.x) / dist;
        const ny = (ball.y - sp.y) / dist;
        const normalSign = sp.inward ? -1 : 1;
        const reflectNx = nx * normalSign;
        const reflectNy = ny * normalSign;
        const incomingVx = ball.vx || 0;
        const incomingVy = ball.vy || 0;
        const impactSpeed = Math.abs(ball.vx * reflectNx + ball.vy * reflectNy);
        this._reflect(ball, reflectNx, reflectNy, ball.bounce);
        this._afterWallBounce(ball, reflectNx, reflectNy);
        this._applySoftBodyImpact(ball, reflectNx, reflectNy, impactSpeed);
        ball.x += nx * 2;
        ball.y += ny * 2;
        this.events.push({
          type: 'bounce',
          source: 'spikes',
          x: ball.x,
          y: ball.y,
          color: ball.color,
          ballId: ball.id,
          colliderId: sp.id,
          colliderType: 'spikes',
          bounceSound: ball.bounceSound || '',
          bounceSoundOn: ball.bounceSoundOn || 'all',
        });
        this._debugCollision('spikes', {
          ballId: ball.id,
          colliderId: sp.id,
          colliderType: 'spikes',
          x: Number(ball.x.toFixed(2)),
          y: Number(ball.y.toFixed(2)),
          dist: Number(dist.toFixed(2)),
          spikeIndex: idx,
          spikeAngle: Number(spikeAngle.toFixed(3)),
          inward: !!sp.inward,
        });
        this._maybeCreateCollisionHole(ball, sp, 'spikes', state, {
          anchorX: tipX,
          anchorY: tipY,
          incomingVx,
          incomingVy,
        });
      }
      return true;
    }
    return false;
  }
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t, cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return { x: ax, y: ay, t: 0 };
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + abx * t, y: ay + aby * t, t };
}

function closestPointsBetweenSegments(ax, ay, bx, by, cx, cy, dx, dy) {
  const ux = bx - ax, uy = by - ay;
  const vx = dx - cx, vy = dy - cy;
  const wx = ax - cx, wy = ay - cy;
  const a = ux * ux + uy * uy;
  const b = ux * vx + uy * vy;
  const c = vx * vx + vy * vy;
  const d = ux * wx + uy * wy;
  const e = vx * wx + vy * wy;
  const EPS = 1e-9;
  let sN, sD = a * c - b * b;
  let tN, tD = sD;

  if (sD < EPS) {
    sN = 0;
    sD = 1;
    tN = e;
    tD = c;
  } else {
    sN = (b * e - c * d);
    tN = (a * e - b * d);
    if (sN < 0) {
      sN = 0;
      tN = e;
      tD = c;
    } else if (sN > sD) {
      sN = sD;
      tN = e + b;
      tD = c;
    }
  }

  if (tN < 0) {
    tN = 0;
    if (-d < 0) sN = 0;
    else if (-d > a) sN = sD;
    else { sN = -d; sD = a; }
  } else if (tN > tD) {
    tN = tD;
    if ((-d + b) < 0) sN = 0;
    else if ((-d + b) > a) sN = sD;
    else { sN = (-d + b); sD = a; }
  }

  const sc = Math.abs(sN) < EPS ? 0 : sN / sD;
  const tc = Math.abs(tN) < EPS ? 0 : tN / tD;
  return {
    px: ax + sc * ux,
    py: ay + sc * uy,
    qx: cx + tc * vx,
    qy: cy + tc * vy,
    sc,
    tc,
  };
}

function findCircleGapEdgeContact(ball, c, time = 0, margin = 0) {
  const rawGap = effectiveCircleGapSize(c, time);
  if (!(rawGap > 0)) return null;
  const halfThickness = (c.thickness || 0) * 0.5;
  const innerR = Math.max(1, (c.radius || 0) - halfThickness);
  const outerR = Math.max(innerR + 1e-6, (c.radius || 0) + halfThickness);
  const rot = c.rotation || 0;
  const prevRot = c._prevRotation != null ? c._prevRotation : rot;
  const rotDelta = shortestAngleDelta(prevRot, rot);
  const edgeAngles = [
    { prev: c.gapStart + prevRot, curr: c.gapStart + rot, edgeIndex: 0 },
    { prev: c.gapStart + prevRot + rawGap, curr: c.gapStart + rot + rawGap, edgeIndex: 1 },
  ];
  const prevX = ball._prevX != null ? ball._prevX : ball.x;
  const prevY = ball._prevY != null ? ball._prevY : ball.y;
  const relPrevX = prevX - c.x;
  const relPrevY = prevY - c.y;
  const relCurrX = ball.x - c.x;
  const relCurrY = ball.y - c.y;
  const bandIntervals = circleBandIntervalsOnSegment(
    relPrevX,
    relPrevY,
    relCurrX,
    relCurrY,
    Math.max(1e-6, innerR - (ball.radius || 0) - margin),
    outerR + (ball.radius || 0) + margin,
  );
  if (!bandIntervals.length) return null;
  const traversal = selectCircleGapTraversalInterval(
    bandIntervals,
    Math.hypot(relPrevX, relPrevY),
    Math.hypot(relCurrX, relCurrY),
    Math.max(1e-6, innerR - (ball.radius || 0) - margin),
    outerR + (ball.radius || 0) + margin,
  ) || bandIntervals[0];
  const motionLen = Math.hypot(ball.x - prevX, ball.y - prevY);
  const sampleCount = Math.max(
    25,
    Math.min(121, gapTraversalSampleCount(ball, c, traversal.start, traversal.end, motionLen, rotDelta) * 4),
  );
  const samples = sampleIntervalTimes(traversal.start, traversal.end, sampleCount);
  const hitThreshold = (ball.radius || 0) + margin;
  let best = null;
  const considerHit = (dist, dx, dy, closest, edgeIndex, edgeAngle, t) => {
    if (!(dist < hitThreshold)) return;
    const candidate = {
      dist,
      dx,
      dy,
      closest,
      edgeIndex,
      edgeAngle,
      t,
    };
    if (!best) {
      best = candidate;
      return;
    }
    const bestT = best.t != null ? best.t : Infinity;
    const nextT = t != null ? t : Infinity;
    if (nextT < bestT - 1e-6 || (Math.abs(nextT - bestT) <= 1e-6 && dist < best.dist)) {
      best = candidate;
    }
  };

  for (const edge of edgeAngles) {
    for (let i = 0; i < samples.length; i++) {
      const t = samples[i];
      const px = lerp(prevX, ball.x, t);
      const py = lerp(prevY, ball.y, t);
      const edgeAngle = edge.prev + rotDelta * t;
      const ax = c.x + Math.cos(edgeAngle) * innerR;
      const ay = c.y + Math.sin(edgeAngle) * innerR;
      const bx = c.x + Math.cos(edgeAngle) * outerR;
      const by = c.y + Math.sin(edgeAngle) * outerR;
      const closest = closestPointOnSegment(px, py, ax, ay, bx, by);
      considerHit(
        Math.hypot(px - closest.x, py - closest.y),
        px - closest.x,
        py - closest.y,
        { x: closest.x, y: closest.y },
        edge.edgeIndex,
        edgeAngle,
        t,
      );
      considerHit(
        Math.hypot(px - ax, py - ay),
        px - ax,
        py - ay,
        { x: ax, y: ay },
        edge.edgeIndex,
        edgeAngle,
        t,
      );
      considerHit(
        Math.hypot(px - bx, py - by),
        px - bx,
        py - by,
        { x: bx, y: by },
        edge.edgeIndex,
        edgeAngle,
        t,
      );
      if (i >= samples.length - 1) continue;
      const tNext = samples[i + 1];
      const nextPx = lerp(prevX, ball.x, tNext);
      const nextPy = lerp(prevY, ball.y, tNext);
      const nextEdgeAngle = edge.prev + rotDelta * tNext;
      const nextAx = c.x + Math.cos(nextEdgeAngle) * innerR;
      const nextAy = c.y + Math.sin(nextEdgeAngle) * innerR;
      const nextBx = c.x + Math.cos(nextEdgeAngle) * outerR;
      const nextBy = c.y + Math.sin(nextEdgeAngle) * outerR;
      const cornerSweeps = [
        { x0: ax, y0: ay, x1: nextAx, y1: nextAy },
        { x0: bx, y0: by, x1: nextBx, y1: nextBy },
      ];
      for (const seg of cornerSweeps) {
        const sweep = closestPointsBetweenSegments(
          px, py, nextPx, nextPy,
          seg.x0, seg.y0, seg.x1, seg.y1,
        );
        const dx = sweep.px - sweep.qx;
        const dy = sweep.py - sweep.qy;
        const dist = Math.hypot(dx, dy);
        considerHit(
          dist,
          dx,
          dy,
          { x: sweep.qx, y: sweep.qy },
          edge.edgeIndex,
          edge.prev + rotDelta * lerp(t, tNext, sweep.tc),
          lerp(t, tNext, sweep.sc),
        );
      }
    }
  }
  return best;
}

function segmentCircleIntersectionTimes(ax, ay, bx, by, radius) {
  const dx = bx - ax;
  const dy = by - ay;
  const qa = dx * dx + dy * dy;
  if (qa <= 1e-12) return [];
  const qb = 2 * (ax * dx + ay * dy);
  const qc = ax * ax + ay * ay - radius * radius;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return [];
  if (disc < 1e-12) {
    const t = -qb / (2 * qa);
    return t >= 0 && t <= 1 ? [t] : [];
  }
  const sqrtDisc = Math.sqrt(disc);
  const t0 = (-qb - sqrtDisc) / (2 * qa);
  const t1 = (-qb + sqrtDisc) / (2 * qa);
  const out = [];
  if (t0 >= 0 && t0 <= 1) out.push(t0);
  if (t1 >= 0 && t1 <= 1 && Math.abs(t1 - t0) > 1e-6) out.push(t1);
  out.sort((a, b) => a - b);
  return out;
}

function circleBandIntervalsOnSegment(ax, ay, bx, by, innerR, outerR) {
  if (!(outerR > innerR)) return [];
  const times = [0, 1];
  for (const t of segmentCircleIntersectionTimes(ax, ay, bx, by, innerR)) times.push(t);
  for (const t of segmentCircleIntersectionTimes(ax, ay, bx, by, outerR)) times.push(t);
  times.sort((a, b) => a - b);
  const unique = [];
  for (const t of times) {
    if (!unique.length || Math.abs(unique[unique.length - 1] - t) > 1e-6) unique.push(t);
  }
  const out = [];
  for (let i = 0; i < unique.length - 1; i++) {
    const start = unique[i];
    const end = unique[i + 1];
    if (end - start <= 1e-6) continue;
    const mid = (start + end) * 0.5;
    const px = lerp(ax, bx, mid);
    const py = lerp(ay, by, mid);
    const dist = Math.hypot(px, py);
    if (dist >= innerR - 1e-6 && dist <= outerR + 1e-6) {
      out.push({ start, end });
    }
  }
  return out;
}

function selectCircleGapTraversalInterval(intervals, prevDist, currDist, innerR, outerR) {
  if (!intervals.length) return null;
  const outward = currDist >= prevDist;
  const insideAtStart = prevDist >= innerR - 1e-6 && prevDist <= outerR + 1e-6;
  if (insideAtStart) {
    return intervals.find((interval) => interval.start <= 1e-6) || intervals[0];
  }
  return outward ? intervals[0] : intervals[intervals.length - 1];
}

function gapTraversalSampleCount(ball, c, start, end, motionLen, rotationDelta) {
  const span = Math.max(1e-6, end - start);
  const rotationalTravel = Math.abs(rotationDelta) * Math.max(1, c.radius || 0);
  const scale = motionLen + rotationalTravel;
  const base = 9 + Math.ceil(scale * span / Math.max(4, (ball.radius || 0) * 0.45));
  return Math.max(9, Math.min(41, base));
}

function sampleIntervalTimes(start, end, count = 5) {
  if (!(end > start)) return [start];
  const out = [];
  const n = Math.max(2, count | 0);
  for (let i = 0; i < n; i++) {
    out.push(lerp(start, end, i / (n - 1)));
  }
  return out;
}

window.Physics = Physics;
window.PHYSICS_CONST = { FIXED_DT, WORLD_W, WORLD_H, GRAVITY };
