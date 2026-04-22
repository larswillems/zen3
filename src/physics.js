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

// Returns true if angle `a` (radians) lies inside a gap whose center rotates
// with `rotation` and spans `gapSize` radians.
function angleInGap(a, gapStart, gapSize, rotation) {
  if (gapSize <= 0) return false;
  const start = normalizeAngle(gapStart + rotation);
  const end = normalizeAngle(start + gapSize);
  a = normalizeAngle(a);
  if (start <= end) return a >= start && a <= end;
  return a >= start || a <= end;
}

function ballFitsCircleGap(ball, c, time = 0, angle = null) {
  const rawGap = effectiveCircleGapSize(c, time);
  if (rawGap <= 0) return false;
  const clearanceRadius = Math.max(1, (c.radius || 0) - ((c.thickness || 0) * 0.5));
  const ratio = Math.max(0, Math.min(0.999999, (ball.radius || 0) / clearanceRadius));
  const angularPad = Math.asin(ratio);
  const usableGap = rawGap - angularPad * 2;
  if (usableGap <= 1e-6) return false;
  const a = angle != null ? angle : Math.atan2((ball.y || 0) - (c.y || 0), (ball.x || 0) - (c.x || 0));
  return angleInGap(a, c.gapStart + angularPad, usableGap, c.rotation || 0);
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
  }

  _collisionDebugOptions() {
    const fallback = { enabled: true, maxLogs: 180, toConsole: true };
    if (typeof window === 'undefined') return fallback;
    const user = window.__collisionDebug;
    if (user === false) return { enabled: false, maxLogs: 0, toConsole: false };
    if (user === true || user == null) return fallback;
    return {
      enabled: user.enabled !== false,
      maxLogs: Math.max(0, user.maxLogs != null ? user.maxLogs : fallback.maxLogs),
      toConsole: user.toConsole !== false,
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
    this._awardScoreBin(ball, bin, state);
    return true;
  }

  _checkScoreBins(ball, scoreBins, state) {
    if (!ball || !ball.alive || ball._escaped || ball.fixed || ball._frozen || ball._scored) return false;
    if (!Array.isArray(scoreBins) || scoreBins.length === 0) return false;
    if ((ball.vy || 0) < -40) return false;
    if (ball._capturedBin) return this._stepCapturedScoreBin(ball, state);
    if (!ball._scoreBinContact) ball._scoreBinContact = Object.create(null);
    for (let i = 0; i < scoreBins.length; i++) {
      const bin = scoreBins[i];
      const key = bin.id || `scoreBin_${i}`;
      const width = Math.max(20, bin.width || 0);
      const height = Math.max(20, bin.height || 0);
      const left = (bin.x || 0) - width * 0.5;
      const top = (bin.y || 0) - height * 0.5;
      const inside = this._circleRectOverlap(ball.x, ball.y, ball.radius || 0, left, top, width, height);
      if (!inside) {
        ball._scoreBinContact[key] = false;
        continue;
      }
      if (ball._scoreBinContact[key]) continue;
      ball._scoreBinContact[key] = true;
      const captureMode = bin.captureMode || 'consume';
      if (captureMode === 'settle') {
        ball._capturedBin = bin;
        ball._captured = true;
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
    const structures = state.objects.filter((o) => o.type !== 'ball' && o.type !== 'spawner' && o.type !== 'scoreBin');
    const scoreBins = state.objects.filter((o) => o.type === 'scoreBin');
    const spawners = state.objects.filter((o) => o.type === 'spawner');

    for (const ball of balls) {
      ball._prevX = ball.x;
      ball._prevY = ball.y;
      this._stepSoftBody(ball, dt);
    }

    for (const s of structures) {
      if (typeof s.rotationSpeed === 'number' && s.rotationSpeed !== 0) {
        s.rotation = (s.rotation || 0) + s.rotationSpeed * dt;
      }
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

      if (ball.motion === 'orbit' || ball.motion === 'lissajous') {
        // Parametric, perfectly-looping motion. No gravity, no collisions --
        // the satisfying path is the source of truth.
        this._integrateParametric(ball, state.time + dt, loopDuration, dt);
      } else {
        // Classic physics path.
        ball.vy += this.gravity * dt;
        if (this.friction > 0) {
          const f = Math.max(0, 1 - this.friction * dt);
          ball.vx *= f;
          ball.vy *= f;
        }
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;

        for (const s of structures) {
          this._collideBallWithStructure(ball, s, state.time);
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
              if (s.type === 'circle') {
                const a = Math.atan2(ball.y - s.y, ball.x - s.x);
                if (!ballFitsCircleGap(ball, s, state.time, a)) continue;
              }
              ball._escaped = true;
              ball.alive = false;
              if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
              this.events.push({
                type: 'escape', x: ball.x, y: ball.y, color: ball.color,
                escapeSound: ball.escapeSound || '',
              });
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
            ball._escaped = true;
            if (ball.clearTrailOnDeath && ball._trail) ball._trail.length = 0;
            this.events.push({
              type: 'escape', x: ball.x, y: ball.y, color: ball.color,
              escapeSound: ball.escapeSound || '',
            });
          }
          continue;
        }
      }

      if (ball.lifetime > 0 && ball.age >= ball.lifetime) {
        ball.alive = false;
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
    this._resolveBallBall(balls);

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
  _resolveBallBall(balls) {
    const alive = balls.filter((b) => b.alive);
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
          this.events.push({
            type: 'bounce',
            source: (A.fixed || B.fixed) ? 'fixedBall' : 'ballBall',
            x: (A.x + B.x) * 0.5,
            y: (A.y + B.y) * 0.5,
            color: aFrozen ? B.color : A.color,
            ballId: A.id,
            otherBallId: B.id,
            bounceSound: voiceBall.bounceSound || '',
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

    if (ball.motion === 'lissajous') {
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

  _stepSpawner(sp, state, dt) {
    const interval = Math.max(0.01, sp.interval || 1);
    if (sp._lastSpawn === undefined || sp._lastSpawn === -Infinity || sp._lastSpawn === null) {
      // First spawn at t=0 so the viewer sees something immediately.
      sp._lastSpawn = -interval;
      sp._spawnCount = 0;
      sp._spawnedIds = [];
    }
    const nextSpawnTime = sp._lastSpawn + interval;
    if (state.time + dt < nextSpawnTime) return;

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
    const ball = {
      id: `${sp.id}_b${sp._spawnCount}`,
      type: 'ball',
      x: spawnX, y: sp.y,
      spawnX,
      spawnY: sp.y,
      vx: spawnVx,
      vy: spawnVy,
      radius: sp.ballRadius || 18,
      color,
      trail: !!sp.ballTrail,
      trailLength: sp.ballTrailLength || 40,
      clearTrailOnDeath: sp.ballClearTrailOnDeath !== false,
      lifetime: sp.ballLifetime || 0,
      freezeOnTimeout: !!sp.ballFreezeOnTimeout,
      fixed: !!sp.ballFixed,
      bounce: sp.ballBounce != null ? sp.ballBounce : 1.0,
      wallCurve: sp.ballWallCurve != null ? sp.ballWallCurve : 0,
      wallDrift: sp.ballWallDrift != null ? sp.ballWallDrift : 0,
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
      escapeSound: sp.ballEscapeSound || '',
      destroySound: sp.ballDestroySound || '',
      deathSound: sp.ballDeathSound || '',
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

    // Cap active balls: oldest spawned by THIS spawner is removed first.
    const max = Math.max(1, sp.maxBalls | 0);
    while (sp._spawnedIds.length > max) {
      const oldestId = sp._spawnedIds.shift();
      const idx = state.objects.findIndex((o) => o.id === oldestId);
      if (idx >= 0) state.objects.splice(idx, 1);
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

  _collideBallWithStructure(ball, s, time = 0) {
    switch (s.type) {
      case 'circle': return this._collideCircleRing(ball, s, time);
      case 'arc': return this._collideArc(ball, s);
      case 'spiral': return this._collideSpiral(ball, s);
      case 'spikes': return this._collideSpikes(ball, s);
    }
    return false;
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

  _collideCircleRing(ball, c, time = 0) {
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
    const contactKey = c.id || '__circle';
    if (!ball._ringContact) ball._ringContact = Object.create(null);

    if (ballFitsCircleGap(ball, c, time, angle)) {
      // Skip wall -> ball can escape through the gap.
      ball._ringContact[contactKey] = false;
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

      const wasInside = prevDist <= innerLimit + releaseMargin;
      const wasOutside = prevDist >= outerLimit - releaseMargin;
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
        const impactSpeed = Math.abs(ball.vx * reflectNx + ball.vy * reflectNy);
        this._reflect(ball, reflectNx, reflectNy, ball.bounce);
        this._curveBounce(ball, reflectNx, reflectNy);
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
        const impactSpeed = Math.abs(ball.vx * nx + ball.vy * ny);
        this._reflect(ball, nx, ny, ball.bounce);
        this._curveBounce(ball, nx, ny);
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
          ball._ringContact[contactKey] = true;
        }
        return true;
      }
    }
    return false;
  }

  _collideArc(ball, a) {
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
      if (dist < a.radius) {
        // Hit from the inside -> push ball inward and reflect off outward normal.
        const push = inner - dist;
        ball.x += nx * push; ball.y += ny * push;
        const impactSpeed = Math.abs(ball.vx * -nx + ball.vy * -ny);
        this._reflect(ball, -nx, -ny, ball.bounce);
        this._curveBounce(ball, -nx, -ny);
        this._applySoftBodyImpact(ball, -nx, -ny, impactSpeed);
      } else {
        // Hit from the outside -> push outward and reflect off inward normal.
        const push = outer - dist;
        ball.x += nx * push; ball.y += ny * push;
        const impactSpeed = Math.abs(ball.vx * nx + ball.vy * ny);
        this._reflect(ball, nx, ny, ball.bounce);
        this._curveBounce(ball, nx, ny);
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
      return true;
    }
    return false;
  }

  _collideSpiral(ball, sp) {
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
        x: sp.x, y: sp.y,
        radius: r,
        thickness: sp.thickness,
        rotation: (sp.rotation || 0) + i * (Math.PI * 2 / layers),
        startAngle: sp.gapSize || 0,
        endAngle: Math.PI * 2,
        color: sp.color,
      };
      if (this._collideArc(ball, fakeArc)) hit = true;
    }
    return hit;
  }

  _collideSpikes(ball, sp) {
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
        const impactSpeed = Math.abs(ball.vx * reflectNx + ball.vy * reflectNy);
        this._reflect(ball, reflectNx, reflectNy, ball.bounce);
        this._curveBounce(ball, reflectNx, reflectNy);
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

window.Physics = Physics;
window.PHYSICS_CONST = { FIXED_DT, WORLD_W, WORLD_H, GRAVITY };
