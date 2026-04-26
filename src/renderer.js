// Canvas renderer with a neon glow aesthetic.
//
// The canvas always renders at 1080x1920 (the "world") internally. CSS scales
// it down to fit. That means export frames and on-screen pixels match exactly.

const W = 1080;
const H = 1920;

// Hard ceiling on concurrent particles. Beyond this we drop the oldest, so a
// big shatter burst never accumulates into a multi-second framerate crater.
const MAX_PARTICLES = 1600;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = W;
    canvas.height = H;
    this.particles = [];
    this.flash = null;   // { color, life, maxLife }
    this.popup = null;   // { text, life, maxLife }
    this.scheduledPopups = [];
    this.glow = 1.0;
    this.softMode = true;
    this._burningObjects = new Map();
    // Pre-rendered glow sprites keyed by hex color. `shadowBlur` on a 1080x1920
    // canvas is the single biggest cost in particle-heavy frames (every spike
    // splash, every confetti burst). A pre-rasterised radial gradient sprite
    // can be `drawImage`'d for 5-10x the speed with an identical look.
    this._glowCache = new Map();
  }

  // Drop oldest particles once we're over the cap. Called after every burst.
  _trimParticles() {
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }
  }

  clearTransientFx() {
    this.particles.length = 0;
    this.flash = null;
    this.popup = null;
    this.scheduledPopups.length = 0;
    this._burningObjects.clear();
  }

  createSnapshot() {
    return {
      particles: JSON.parse(JSON.stringify(this.particles || [])),
      flash: this.flash ? { ...this.flash } : null,
      popup: this.popup ? { ...this.popup } : null,
      scheduledPopups: JSON.parse(JSON.stringify(this.scheduledPopups || [])),
      burningObjects: Array.from(this._burningObjects.entries()).map(([id, fx]) => ({
        id,
        fx: { ...fx },
      })),
    };
  }

  applySnapshot(snapshot) {
    this.clearTransientFx();
    if (!snapshot) return;
    this.particles = JSON.parse(JSON.stringify(snapshot.particles || []));
    this.flash = snapshot.flash ? { ...snapshot.flash } : null;
    this.popup = snapshot.popup ? { ...snapshot.popup } : null;
    this.scheduledPopups = JSON.parse(JSON.stringify(snapshot.scheduledPopups || []));
    this._burningObjects = new Map(
      (snapshot.burningObjects || []).map((entry) => [entry.id, { ...(entry.fx || {}) }])
    );
  }

  hasActiveTransientFx() {
    return this.particles.length > 0
      || !!this.flash
      || !!this.popup
      || this.scheduledPopups.length > 0
      || this._burningObjects.size > 0;
  }

  _burnHash(fx, salt = 0) {
    const src = `${fx && fx.id ? fx.id : 'burn'}:${salt}`;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < src.length; i++) {
      h ^= src.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  _spawnBurnEmbers(fx, dt) {
    const elapsed = fx.maxLife - fx.life;
    const p = Math.max(0, Math.min(1, elapsed / fx.maxLife));
    const spawnCount = Math.max(1, Math.round(dt * 36));
    const burnFront = p * Math.PI * 1.9;
    for (let i = 0; i < spawnCount; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const jitter = (this._burnHash(fx, Math.round(elapsed * 1000) + i) - 0.5) * 0.24;
      const a = (fx.ignitionAngle || 0) + side * burnFront + jitter;
      const r = (fx.radius || 0) - (fx.thickness || 8) * (0.18 + p * 0.35);
      const px = fx.x + Math.cos(a) * r;
      const py = fx.y + Math.sin(a) * r;
      const tangential = side * (120 + 90 * (1 - p));
      const radial = 18 + 30 * (1 - p);
      const tx = -Math.sin(a);
      const ty = Math.cos(a);
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      this.particles.push({
        x: px,
        y: py,
        vx: tx * tangential + nx * radial,
        vy: ty * tangential + ny * radial - 90,
        life: 0.18 + (1 - p) * 0.28,
        maxLife: 0.46,
        color: i % 3 === 0 ? '#ffe7b0' : (fx.color || '#f97316'),
        size: 2 + (1 - p) * 2.5,
      });
    }
    this._trimParticles();
  }

  _drawBurningRingFx(fx) {
    if (!fx) return;
    const ctx = this.ctx;
    const elapsed = fx.maxLife - fx.life;
    const p = Math.max(0, Math.min(1, elapsed / fx.maxLife));
    const lineWidth = Math.max(1.5, (fx.thickness || 8) * (1 - p * 0.82));
    const radius = Math.max(2, (fx.radius || 0) - p * ((fx.thickness || 8) * 0.7 + 8));
    const burnFront = p * Math.PI * 1.9;
    const alpha = Math.max(0, 0.95 - p * 0.72);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = `rgba(255, 150, 55, ${alpha.toFixed(3)})`;
    ctx.shadowBlur = 24 * this.glow * (1 - p * 0.35);
    ctx.shadowColor = fx.color || '#f97316';
    const chunks = 20;
    const baseChunk = (Math.PI * 2) / chunks;
    for (let i = 0; i < chunks; i++) {
      const mid = i * baseChunk + baseChunk * 0.5;
      const rel = Math.atan2(Math.sin(mid - (fx.ignitionAngle || 0)), Math.cos(mid - (fx.ignitionAngle || 0)));
      const dist = Math.abs(rel);
      const edgeNoise = (this._burnHash(fx, i) - 0.5) * 0.22;
      if (dist < burnFront + edgeNoise) continue;
      const segStart = mid - baseChunk * 0.34;
      const segEnd = mid + baseChunk * 0.34;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, radius, segStart, segEnd);
      ctx.stroke();
    }

    ctx.lineWidth = Math.max(1, lineWidth * 0.42);
    ctx.strokeStyle = `rgba(255, 235, 180, ${(0.16 + (1 - p) * 0.22).toFixed(3)})`;
    for (let i = 0; i < 8; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const a = (fx.ignitionAngle || 0) + side * burnFront + (i - 3.5) * 0.045;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, radius + lineWidth * 0.25, a - 0.05, a + 0.05);
      ctx.stroke();
    }
    ctx.restore();
  }

  _hexToRgb(hex) {
    if (typeof hex !== 'string') return { r: 255, g: 255, b: 255 };
    const m = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return { r: 255, g: 255, b: 255 };
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  _paletteColorAt(colors, t) {
    if (!Array.isArray(colors) || colors.length === 0) return '#ffffff';
    if (colors.length === 1) return colors[0];
    const n = colors.length - 1;
    const x = Math.max(0, Math.min(0.999999, t)) * n;
    const i = Math.floor(x);
    const f = x - i;
    const a = this._hexToRgb(colors[i]);
    const b = this._hexToRgb(colors[Math.min(n, i + 1)]);
    const lerp = (u, v) => Math.round(u + (v - u) * f);
    return `rgb(${lerp(a.r, b.r)}, ${lerp(a.g, b.g)}, ${lerp(a.b, b.b)})`;
  }

  _makeConicStrokeStyle(x, y, colors, fallback) {
    if (!Array.isArray(colors) || colors.length < 2 || typeof this.ctx.createConicGradient !== 'function') {
      return fallback;
    }
    const g = this.ctx.createConicGradient(-Math.PI / 2, x, y);
    const denom = Math.max(1, colors.length - 1);
    for (let i = 0; i < colors.length; i++) {
      g.addColorStop(i / denom, colors[i]);
    }
    return g;
  }

  _maxBallRadiusForCircle(c) {
    const objects = this._state && Array.isArray(this._state.objects) ? this._state.objects : [];
    let maxR = 0;
    for (const o of objects) {
      if (o.type === 'ball' && o.alive) maxR = Math.max(maxR, o.radius || 0);
      if (o.type === 'spawner') maxR = Math.max(maxR, o.ballRadius || 0);
    }
    return maxR;
  }

  _visibleCircleGapSpec(c) {
    const rawGap = effectiveCircleGapSize(c, this._state ? this._state.time : 0);
    // Draw the real ring geometry. Physics may use a stricter "ball-fit"
    // clearance test, but shrinking the rendered gap makes presets look like
    // the ring loses an extra chunk even when collisions are correct.
    return {
      startOffset: 0,
      size: Math.max(0, rawGap),
    };
  }

  _visibleCircleGapSize(c) {
    return this._visibleCircleGapSpec(c).size;
  }

  _collisionDebugOptions() {
    const fallback = { enabled: false, verboseGap: false };
    if (typeof window === 'undefined') return fallback;
    const user = window.__collisionDebug;
    if (user === false || user == null) return fallback;
    if (user === true) return { enabled: true, verboseGap: false };
    return {
      enabled: user.enabled !== false,
      verboseGap: !!user.verboseGap,
    };
  }

  _verboseGapDebugEnabled() {
    const opts = this._collisionDebugOptions();
    return !!(opts.enabled && opts.verboseGap);
  }

  _latestGapDebugEntry(ballId, colliderId) {
    if (typeof window === 'undefined' || !Array.isArray(window.__collisionDebugLogs)) return null;
    for (let i = window.__collisionDebugLogs.length - 1; i >= 0; i--) {
      const entry = window.__collisionDebugLogs[i];
      if (!entry || typeof entry !== 'object') continue;
      if (entry.ballId !== ballId || entry.colliderId !== colliderId) continue;
      if (typeof entry.kind !== 'string' || !entry.kind.startsWith('gap')) continue;
      return entry;
    }
    return null;
  }

  _drawGapDebugOverlay(state) {
    if (!this._verboseGapDebugEnabled()) return;
    const ctx = this.ctx;
    const objects = Array.isArray(state && state.objects) ? state.objects : [];
    const balls = objects.filter((o) => o && o.type === 'ball' && o.alive);
    const circles = objects.filter((o) => o && o.type === 'circle' && !o._gapRemoved && effectiveCircleGapSize(o, state.time || 0) > 0);
    if (!balls.length || !circles.length) return;

    const rows = [];
    ctx.save();
    ctx.font = '20px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (const c of circles) {
      const rawGap = effectiveCircleGapSize(c, state.time || 0);
      const rotation = c.rotation || 0;
      const rawStart = normalizeAngle((c.gapStart || 0) + rotation);
      const halfThickness = Math.max(0, (c.thickness || 0) * 0.5);
      const ringInner = Math.max(0, (c.radius || 0) - halfThickness);
      const ringOuter = Math.max(ringInner, (c.radius || 0) + halfThickness);

      for (const ball of balls) {
        const dx = (ball.x || 0) - (c.x || 0);
        const dy = (ball.y || 0) - (c.y || 0);
        const dist = Math.hypot(dx, dy);
        const innerLimit = Math.max(1e-6, ringInner - (ball.radius || 0));
        const outerLimit = Math.max(innerLimit + 1e-6, ringOuter + (ball.radius || 0));
        if (Math.abs(dist - (c.radius || 0)) > Math.max(220, (ball.radius || 0) * 4 + (c.thickness || 0))) continue;

        const clearanceRadius = Math.max(1e-6, ringInner - (ball.radius || 0));
        const ratio = Math.max(0, Math.min(0.999999, (ball.radius || 0) / clearanceRadius));
        const angularPad = Math.asin(ratio);
        const edgeSafety = Math.max(0.0025, Math.min(0.02, 0.8 / clearanceRadius));
        const totalPad = angularPad + edgeSafety;
        const usableGap = Math.max(0, rawGap - totalPad * 2);
        const usableStart = normalizeAngle(rawStart + totalPad);
        const angle = normalizeAngle(Math.atan2(dy, dx));
        const fit = usableGap > 1e-6 && angleInGapDebug(angle, usableStart, usableGap);
        const latest = this._latestGapDebugEntry(ball.id, c.id);

        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(ball.x || 0, ball.y || 0);
        ctx.stroke();

        const prevX = ball._prevX != null ? ball._prevX : ball.x;
        const prevY = ball._prevY != null ? ball._prevY : ball.y;
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath();
        ctx.arc(prevX || 0, prevY || 0, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 8]);
        ctx.beginPath();
        ctx.arc(c.x, c.y, clearanceRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.setLineDash([]);
        drawAngleRay(ctx, c.x, c.y, rawStart, ringOuter + 48, 'rgba(34, 211, 238, 0.95)', 3);
        drawAngleRay(ctx, c.x, c.y, rawStart + rawGap, ringOuter + 48, 'rgba(34, 211, 238, 0.95)', 3);
        if (usableGap > 0) {
          drawAngleRay(ctx, c.x, c.y, usableStart, ringOuter + 74, 'rgba(251, 191, 36, 0.95)', 3);
          drawAngleRay(ctx, c.x, c.y, usableStart + usableGap, ringOuter + 74, 'rgba(251, 191, 36, 0.95)', 3);
          ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(c.x, c.y, clearanceRadius, usableStart, usableStart + usableGap);
          ctx.stroke();
        }

        rows.push(`gap ${c.id || 'circle'} / ${ball.id || 'ball'} | fit=${fit ? 'yes' : 'no'} | latest=${latest ? latest.kind : 'n/a'} @ ${latest && latest.time != null ? latest.time.toFixed(4) : '-'}`);
        rows.push(`dist=${dist.toFixed(2)} angle=${angle.toFixed(4)} inner=${innerLimit.toFixed(2)} outer=${outerLimit.toFixed(2)}`);
        rows.push(`rawGap=${rawGap.toFixed(4)} usable=${usableGap.toFixed(4)} pad=${totalPad.toFixed(4)} clearanceR=${clearanceRadius.toFixed(2)}`);
        rows.push(`pos=(${(ball.x || 0).toFixed(2)}, ${(ball.y || 0).toFixed(2)}) prev=(${(prevX || 0).toFixed(2)}, ${(prevY || 0).toFixed(2)})`);
      }
    }

    if (rows.length) {
      const lineH = 24;
      const pad = 12;
      const boxH = pad * 2 + rows.length * lineH;
      ctx.fillStyle = 'rgba(3, 7, 18, 0.78)';
      ctx.fillRect(24, 24, 820, boxH);
      for (let i = 0; i < rows.length; i++) {
        ctx.fillStyle = i % 4 === 0 ? '#f8fafc' : '#cbd5e1';
        ctx.fillText(rows[i], 36, 36 + i * lineH);
      }
    }
    ctx.restore();
  }

  // Build (once, then cached) a soft radial-glow sprite tinted toward `color`.
  // Center is white-hot; the outer halo fades through the tint to full
  // transparency. With `globalCompositeOperation = 'lighter'` this reads as a
  // neon glow without any expensive per-draw blur filter.
  _getGlowSprite(color) {
    let c = this._glowCache.get(color);
    if (c) return c;
    const size = 64;
    const { r, g, b } = this._hexToRgb(color);
    c = document.createElement('canvas');
    c.width = c.height = size;
    const cctx = c.getContext('2d');
    const gr = cctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gr.addColorStop(0,    'rgba(255,255,255,1)');
    gr.addColorStop(0.28, `rgba(${r},${g},${b},0.85)`);
    gr.addColorStop(1,    `rgba(${r},${g},${b},0)`);
    cctx.fillStyle = gr;
    cctx.fillRect(0, 0, size, size);
    this._glowCache.set(color, c);
    return c;
  }

  _getBallDeformState(b) {
    // Simple, area-preserving squash-and-stretch. We only care about HOW MUCH
    // the ball is deformed, and along which axis the impact came from. The
    // result is always a clean ellipse whose visual area matches the original
    // ball, no matter how hard it hit.
    const rawSquash = Math.abs(b._softSquash || 0);
    const rawStretch = Math.abs(b._softStretch || 0);
    // Cap deformation so the ball visually never balloons much bigger than its
    // original size. At d=0.45, tangent = 1 / (1 - 0.45*0.55) ≈ 1.33, which is
    // clearly deformed but still recognisable as "the same ball".
    const d = Math.max(0, Math.min(0.45, Math.max(rawSquash * 0.85, rawStretch * 0.55)));
    const wobbleAmp = Math.max(0, Math.min(0.08, (b._softWobbleAmp || 0) * 0.25));
    const axisX = Number.isFinite(b._softAxisX) ? b._softAxisX : 1;
    const axisY = Number.isFinite(b._softAxisY) ? b._softAxisY : 0;
    const axisAngle = Math.atan2(axisY, axisX);
    // Compress along the impact normal, then stretch the perpendicular axis
    // by exactly 1/normal so the blob's area is conserved.
    const normalScale = 1 - d * 0.55;
    const tangentScale = 1 / normalScale;
    return {
      d,
      wobbleAmp,
      axisAngle,
      phase: b._softWobblePhase || 0,
      tangentScale,
      normalScale,
    };
  }

  _traceBallBlobPath(b, extraScale = 1) {
    const ctx = this.ctx;
    const deform = this._getBallDeformState(b);
    const segs = 48;
    const radius = (b.radius || 0) * extraScale;
    const cx = b.x;
    const cy = b.y;
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = (i / segs) * Math.PI * 2;
      const rel = t - deform.axisAngle;
      const cosRel = Math.cos(rel);
      const sinRel = Math.sin(rel);
      // Clean ellipse aligned to the impact axis, plus a very light periodic
      // edge wobble. No asymmetric bulges, no press offsets, no pinching.
      const baseScale = Math.hypot(cosRel * deform.normalScale, sinRel * deform.tangentScale);
      const ripple = deform.wobbleAmp > 0.001
        ? Math.sin(rel * 2 + deform.phase) * deform.wobbleAmp * 0.35
        : 0;
      const r = radius * baseScale * (1 + ripple);
      const x = cx + Math.cos(t) * r;
      const y = cy + Math.sin(t) * r;
      if (i < segs) pts.push({ x, y });
    }
    if (pts.length >= 3) {
      const firstMidX = (pts[0].x + pts[1].x) * 0.5;
      const firstMidY = (pts[0].y + pts[1].y) * 0.5;
      ctx.moveTo(firstMidX, firstMidY);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        const next = pts[(i + 1) % pts.length];
        const midX = (p.x + next.x) * 0.5;
        const midY = (p.y + next.y) * 0.5;
        ctx.quadraticCurveTo(p.x, p.y, midX, midY);
      }
      ctx.closePath();
    } else {
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    }
    return deform;
  }

  // --- Event-driven visual effects (called by EventEngine) -----------------

  confettiBurst(x, y, count = 160) {
    const colors = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#22d3ee', '#f87171'];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 200 + Math.random() * 900;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd - 200,
        life: 1.5 + Math.random() * 1.0,
        maxLife: 2.2,
        color: colors[(Math.random() * colors.length) | 0],
        size: 4 + Math.random() * 6,
      });
    }
    this._trimParticles();
  }

  shatterObject(s, opts = {}) {
    // Throw a shower of particles along the object's outline. Sample count
    // scales with the structure's visual size so we don't always pay for 80
    // samples on a small ring -- and we cap the upper bound hard so a big
    // shatter with many structures can't flood the particle pool.
    const color = s.color || '#ffffff';
    const sizeHint = s.radius || s.outerRadius || 300;
    const samples = opts.samples != null
      ? Math.max(8, Math.round(opts.samples))
      : Math.max(24, Math.min(42, Math.round(sizeHint / 12)));
    const outline = sampleOutline(s, samples);
    const burstScale = opts.burstScale != null ? opts.burstScale : 1;
    const downwardBias = opts.downwardBias != null ? opts.downwardBias : 0;
    const lifeBase = opts.lifeBase != null ? opts.lifeBase : 1.4;
    const lifeRange = opts.lifeRange != null ? opts.lifeRange : 1.0;
    for (const p of outline) {
      const a = Math.atan2(p.y - (s.y || 960), p.x - (s.x || 540)) + (Math.random() - 0.5);
      const spd = (300 + Math.random() * 500) * burstScale;
      const life = lifeBase + Math.random() * lifeRange;
      this.particles.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd + downwardBias,
        life,
        maxLife: life,
        color,
        size: 3 + Math.random() * 5,
      });
    }
    this._trimParticles();
  }

  triggerFlash(color = '#ffffff', maxLife = 0.8) {
    this.flash = { color, life: maxLife, maxLife };
  }

  showPopup(text, seconds = 2, color = '#ffffff', shadowColor = null, options = {}) {
    this.popup = {
      text,
      life: seconds,
      maxLife: seconds,
      color,
      shadowColor: shadowColor || color || '#ffffff',
      size: options.size,
    };
  }

  schedulePopup(delay = 0, text, seconds = 2, color = '#ffffff', shadowColor = null, options = {}) {
    this.scheduledPopups.push({
      delay: Math.max(0, Number(delay) || 0),
      text,
      seconds,
      color,
      shadowColor,
      options: options || {},
    });
  }

  addParticle(x, y, color, count = 6) {
    // In "soft" mode (Satisfying Loop Generator) we emit FEWER, slower, longer
    // particles that look like a gentle shimmer instead of an explosion.
    let actualCount = this.softMode ? Math.max(1, Math.round(count * 0.35)) : count;
    // If we're already close to the cap, emit fewer particles per event so a
    // ball that rapid-fires collisions doesn't stutter the framerate.
    const headroom = MAX_PARTICLES - this.particles.length;
    if (actualCount > headroom) actualCount = Math.max(1, headroom);
    const baseSpd = this.softMode ? 40 : 100;
    const spdRange = this.softMode ? 60 : 300;
    const life = this.softMode ? 0.9 : 0.5;
    for (let i = 0; i < actualCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = baseSpd + Math.random() * spdRange;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        life,
        maxLife: life,
        color,
        size: (this.softMode ? 2 : 3) + Math.random() * (this.softMode ? 2 : 4),
      });
    }
    this._trimParticles();
  }

  _emitGapParticles(ev) {
    const x = ev.x || 0;
    const y = ev.y || 0;
    const color = ev.color || '#ffffff';
    const effect = ev.destroyStyle || ev.gapEffect || ev.gapOutcome || 'destroy';
    if (effect === 'shatter') {
      this.addParticle(x, y, color, 18);
      this.addParticle(x, y, '#ffffff', 10);
      return;
    }
    if (effect === 'burn') {
      const colors = ['#fb7185', '#f97316', '#fbbf24'];
      for (let i = 0; i < 20; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
        const spd = 160 + Math.random() * 320;
        this.particles.push({
          x, y,
          vx: Math.cos(a) * spd * 0.55,
          vy: Math.sin(a) * spd - 80,
          life: 0.7 + Math.random() * 0.4,
          maxLife: 1.0,
          color: colors[(Math.random() * colors.length) | 0],
          size: 3 + Math.random() * 5,
        });
      }
      this._trimParticles();
      return;
    }
    if (effect === 'flyAway' || effect === 'launchUp' || effect === 'launchDown' || effect === 'trail') {
      this.addParticle(x, y, color, 10);
      return;
    }
    this.addParticle(x, y, color, 14);
  }

  // Important: particles are purely visual and not part of the deterministic
  // simulation. They use wall-clock dt (passed in) and are never serialized.
  stepParticles(dt) {
    const gravity = this.softMode ? 0 : 400;
    const drag = this.softMode ? 0.6 : 0;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += gravity * dt;
      if (drag > 0) {
        const f = Math.max(0, 1 - drag * dt);
        p.vx *= f; p.vy *= f;
      }
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const [id, fx] of this._burningObjects) {
      fx.life -= dt;
      this._spawnBurnEmbers(fx, dt);
      if (fx.life <= 0) this._burningObjects.delete(id);
    }

    if (this.flash) {
      this.flash.life -= dt;
      if (this.flash.life <= 0) this.flash = null;
    }
    if (this.popup) {
      this.popup.life -= dt;
      if (this.popup.life <= 0) this.popup = null;
    }
    if (this.scheduledPopups.length > 0) {
      const pending = [];
      for (const item of this.scheduledPopups) {
        item.delay -= dt;
        if (item.delay <= 0) {
          this.showPopup(item.text, item.seconds, item.color, item.shadowColor, item.options);
        } else {
          pending.push(item);
        }
      }
      this.scheduledPopups = pending;
    }
  }

  handleEvents(events) {
    for (const ev of events) {
      if (ev.type === 'bounce') this.addParticle(ev.x, ev.y, ev.color, 4);
      else if (ev.type === 'collisionHole') this.addParticle(ev.x, ev.y, ev.color || '#ffffff', 10);
      else if (ev.type === 'destroy') this._emitGapParticles(ev);
      else if (ev.type === 'escape') this.addParticle(ev.x, ev.y, ev.color, 12);
      else if (ev.type === 'gapPass') {
        this._emitGapParticles(ev);
        if ((ev.gapEffect === 'burn' || ev.gapOutcome === 'burn' || ev.gapSoundPreset === 'burn')
            && ev.gapObjectId && ev.gapObjectType === 'circle') {
          this._burningObjects.set(ev.gapObjectId, {
            id: ev.gapObjectId,
            color: ev.color || '#f97316',
            x: ev.gapObjectX != null ? ev.gapObjectX : ev.x,
            y: ev.gapObjectY != null ? ev.gapObjectY : ev.y,
            radius: ev.gapObjectRadius != null ? ev.gapObjectRadius : 0,
            thickness: ev.gapObjectThickness != null ? ev.gapObjectThickness : 8,
            ignitionAngle: Math.atan2(
              (ev.y != null ? ev.y : 0) - (ev.gapObjectY != null ? ev.gapObjectY : 0),
              (ev.x != null ? ev.x : 0) - (ev.gapObjectX != null ? ev.gapObjectX : 0),
            ),
            life: 1.05,
            maxLife: 1.05,
          });
        }
      }
      else if (ev.type === 'score') {
        this.addParticle(ev.x, ev.y, ev.color || '#fbbf24', 10);
        this.showPopup(ev.label || `${ev.points >= 0 ? '+' : ''}${ev.points || 0}`, 1.1, ev.color || '#fbbf24', ev.color || '#fbbf24');
      }
      else if (ev.type === 'freeze') {
        if (ev.deathBurst) {
          for (let i = 0; i < 18; i++) {
            const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
            const spd = 240 + Math.random() * 480;
            this.particles.push({
              x: ev.x, y: ev.y,
              vx: Math.cos(a) * spd,
              vy: Math.sin(a) * spd - 220,
              life: 1.2 + Math.random() * 0.6,
              maxLife: 1.8,
              color: ev.color || '#666666',
              size: 3 + Math.random() * 4,
            });
          }
          this._trimParticles();
        } else if (!this.freezeKeepAppearance) {
          // Icy chunk burst: a mix of the ball's own color and an icy white so
          // it reads as "shattered shards" without matching the confetti look.
          this.addParticle(ev.x, ev.y, ev.color, 6);
          this.addParticle(ev.x, ev.y, '#e0f2fe', 8);
          this.addParticle(ev.x, ev.y, '#ffffff', 4);
        }
      }
    }
  }

  render(state, opts = {}) {
    const ctx = this.ctx;
    this._state = state;

    // Pick up scenario-level visual config each frame; these are ~1 when the
    // user hasn't touched anything and scale all glow/pulse effects uniformly.
    const visuals = opts.visuals || {};
    this.glow = (visuals.glow != null ? visuals.glow : 1.0);
    this.freezeKeepAppearance = !!visuals.freezeKeepAppearance;
    this.freezeGlowColor = visuals.freezeGlowColor || '#bae6fd';
    this.freezeRimColor = visuals.freezeRimColor || '#e0f2fe';
    this.freezeOpacity = visuals.freezeOpacity != null ? visuals.freezeOpacity : 0.75;
    this.freezeSpeckColor = visuals.freezeSpeckColor || '#e0f2fe';
    this.freezeSpeckCount = visuals.freezeSpeckCount != null ? visuals.freezeSpeckCount : 3;
    this.softMode = opts.softMode !== false;

    // A single "pulse" value driven by loop time: smooth 0..1 breathing that
    // finishes an integer number of cycles per loop, keeping the pulse
    // perfectly aligned with the loop boundary.
    const L = state.loopDuration || 0;
    const pulse = (visuals.pulse !== false && L > 0)
      ? 0.5 + 0.5 * Math.sin((state.time / L) * Math.PI * 2)
      : 1.0;
    this._pulse = pulse;

    ctx.fillStyle = '#05060d';
    ctx.fillRect(0, 0, W, H);

    // Subtle radial vignette (slightly pulsing in soft mode).
    const grad = ctx.createRadialGradient(W/2, H/2, 200, W/2, H/2, Math.max(W, H));
    const vigAlpha = 0.18 + pulse * 0.12;
    grad.addColorStop(0, `rgba(30, 20, 80, ${vigAlpha.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Draw non-ball structures first.
    for (const o of state.objects) {
      if (o._gapRemoved) continue;
      if (o.type === 'circle') this._drawCircle(o);
      else if (o.type === 'arc') this._drawArc(o);
      else if (o.type === 'spiral') this._drawSpiral(o);
      else if (o.type === 'spikes') this._drawSpikes(o);
      else if (o.type === 'spinner') this._drawSpinner(o);
      else if (o.type === 'booster') this._drawBooster(o);
      else if (o.type === 'flipper') this._drawFlipper(o);
      else if (o.type === 'scoreBin') this._drawScoreBin(o);
      else if (o.type === 'spawner') this._drawSpawner(o, state.time);
    }

    // Trails.
    for (const o of state.objects) {
      if (o.type !== 'ball' || !o.trail || !o._trail) continue;
      this._drawTrail(o);
    }

    // Balls.
    for (const o of state.objects) {
      if (o.type === 'ball' && o.alive) this._drawBall(o);
    }

    // Text objects sit on top of scene objects but below FX overlays.
    for (const o of state.objects) {
      if (o.type === 'text') this._drawText(o);
      else if (o.type === 'timer') this._drawTimer(o, state);
    }

    // Particles.
    this._drawParticles();

    for (const fx of this._burningObjects.values()) {
      this._drawBurningRingFx(fx);
    }

    // Re-draw structures lightly on top so dense ball clusters / particles
    // don't visually hide the exact collision boundaries. This doesn't change
    // physics; it only makes "what can I bounce on?" readable on-screen.
    ctx.save();
    ctx.globalAlpha = 0.55;
    for (const o of state.objects) {
      if (o._gapRemoved) continue;
      if (o.type === 'circle') this._drawCircle(o);
      else if (o.type === 'arc') this._drawArc(o);
      else if (o.type === 'spiral') this._drawSpiral(o);
      else if (o.type === 'spikes') this._drawSpikes(o);
      else if (o.type === 'spinner') this._drawSpinner(o);
      else if (o.type === 'booster') this._drawBooster(o);
      else if (o.type === 'flipper') this._drawFlipper(o);
      else if (o.type === 'scoreBin') this._drawScoreBin(o);
    }
    ctx.restore();

    this._drawGapDebugOverlay(state);

    // Selection highlight.
    if (opts.selectedId) {
      const sel = state.objects.find((o) => o.id === opts.selectedId);
      if (sel) this._drawSelection(sel);
    }

    // Overlays (HUD).
    if (opts.overlay) this._drawOverlay(opts.overlay, state);

    // Event effects that sit on top of everything else.
    this._drawFlash();
    this._drawPopup();
  }

  _drawFlash() {
    if (!this.flash) return;
    const ctx = this.ctx;
    const alpha = Math.max(0, this.flash.life / this.flash.maxLife);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.flash.color;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  _drawPopup() {
    if (!this.popup) return;
    const ctx = this.ctx;
    const t = this.popup.life / this.popup.maxLife;
    // Ease in quickly, fade out slowly.
    const alpha = Math.min(1, Math.max(0, Math.sin(Math.min(1, this.popup.life / 0.35) * Math.PI * 0.5)));
    const scale = 1 + (1 - t) * 0.2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowBlur = 60;
    ctx.shadowColor = this.popup.shadowColor || this.popup.color || '#ffffff';
    ctx.fillStyle = this.popup.color || '#ffffff';
    const baseSize = Math.max(24, Number(this.popup.size) || 160);
    ctx.font = `bold ${Math.round(baseSize * scale)}px system-ui, sans-serif`;
    ctx.fillText(this.popup.text, W / 2, H / 2);
    ctx.restore();
  }

  _drawBall(b) {
    const ctx = this.ctx;
    ctx.save();
    const pulseScale = 0.9 + (this._pulse || 0.5) * 0.3;
    if (b._frozen && !this.freezeKeepAppearance) {
      // "Frosted" look: dimmer, cool rim, no breathing pulse.
      const freezeGlowColor = this.freezeGlowColor || '#bae6fd';
      const freezeRimColor = this.freezeRimColor || '#e0f2fe';
      const freezeSpeckColor = this.freezeSpeckColor || '#e0f2fe';
      const freezeOpacity = this.freezeOpacity != null ? this.freezeOpacity : 0.75;
      const freezeSpeckCount = Math.max(0, Math.min(12, Math.round(this.freezeSpeckCount != null ? this.freezeSpeckCount : 3)));
      ctx.shadowBlur = 10 * this.glow;
      ctx.shadowColor = freezeGlowColor;
      ctx.fillStyle = b.color;
      ctx.globalAlpha = freezeOpacity;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = freezeRimColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.stroke();
      // Small frost specks so frozen balls read as "iced" not "dim".
      ctx.fillStyle = freezeSpeckColor;
      ctx.globalAlpha = 0.9;
      for (let i = 0; i < freezeSpeckCount; i++) {
        const a = freezeSpeckCount > 0 ? (i / freezeSpeckCount) * Math.PI * 2 : 0;
        ctx.beginPath();
        ctx.arc(b.x + Math.cos(a) * b.radius * 0.45,
                b.y + Math.sin(a) * b.radius * 0.45, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      const softBodyActive = !!b.softBody && (
        (b._softStretch || 0) > 0.002
        || (b._softSquash || 0) > 0.002
        || (b._softFlow || 0) > 0.002
        || (b._softWobbleAmp || 0) > 0.001
      );
      if (b.eggStyle) {
        this._drawEggBall(b, pulseScale);
      } else {
        ctx.shadowBlur = 30 * this.glow * pulseScale;
        ctx.shadowColor = b.color;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        if (softBodyActive) this._traceBallBlobPath(b);
        else ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        const deform = softBodyActive ? this._getBallDeformState(b) : null;
        const highlightX = b.x - (b.radius * 0.24);
        const highlightY = b.y - (b.radius * 0.28);
        const highlightR = b.radius * (softBodyActive && deform ? (0.26 + deform.normalScale * 0.12) : 0.35);
        ctx.beginPath();
        ctx.arc(highlightX, highlightY, highlightR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  _traceEggPath(x, y, radius) {
    const ctx = this.ctx;
    const r = Math.max(2, radius || 0);
    ctx.beginPath();
    ctx.moveTo(x, y - r * 1.14);
    ctx.bezierCurveTo(
      x + r * 0.94, y - r * 0.96,
      x + r * 1.02, y + r * 0.16,
      x, y + r * 1.02,
    );
    ctx.bezierCurveTo(
      x - r * 1.02, y + r * 0.16,
      x - r * 0.94, y - r * 0.96,
      x, y - r * 1.14,
    );
    ctx.closePath();
  }

  _drawEggBall(b, pulseScale = 1) {
    const ctx = this.ctx;
    const style = b.eggStyle || {};
    const stripeColors = Array.isArray(style.stripeColors) && style.stripeColors.length
      ? style.stripeColors
      : ['rgba(255,255,255,0.9)', 'rgba(255,255,255,0.75)'];
    const dotColor = style.dotColor || stripeColors[stripeColors.length - 1] || '#ffffff';
    const rimColor = style.rimColor || 'rgba(255,255,255,0.75)';
    const rotation = Number(style.rotation) || 0;
    const r = Math.max(2, b.radius || 0);
    ctx.translate(b.x, b.y);
    ctx.rotate(rotation);
    ctx.translate(-b.x, -b.y);
    ctx.shadowBlur = 26 * this.glow * pulseScale;
    ctx.shadowColor = b.color;
    ctx.fillStyle = b.color;
    this._traceEggPath(b.x, b.y, r);
    ctx.fill();

    ctx.save();
    this._traceEggPath(b.x, b.y, r);
    ctx.clip();
    const bandHeight = Math.max(3, r * 0.2);
    stripeColors.forEach((color, i) => {
      const yy = b.y - r * 0.38 + i * r * 0.35;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(b.x - r * 1.2, yy);
      ctx.quadraticCurveTo(b.x - r * 0.35, yy - bandHeight * 0.8, b.x, yy);
      ctx.quadraticCurveTo(b.x + r * 0.35, yy + bandHeight * 0.8, b.x + r * 1.2, yy);
      ctx.lineTo(b.x + r * 1.2, yy + bandHeight);
      ctx.quadraticCurveTo(b.x + r * 0.35, yy + bandHeight * 1.8, b.x, yy + bandHeight);
      ctx.quadraticCurveTo(b.x - r * 0.35, yy + bandHeight * 0.2, b.x - r * 1.2, yy + bandHeight);
      ctx.closePath();
      ctx.fill();
    });
    ctx.fillStyle = dotColor;
    const dots = [
      [-0.34, -0.06, 0.1],
      [0.32, 0.02, 0.085],
      [-0.08, 0.25, 0.09],
      [0.12, -0.28, 0.07],
    ];
    for (const [dx, dy, rr] of dots) {
      ctx.beginPath();
      ctx.arc(b.x + dx * r, b.y + dy * r, r * rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = rimColor;
    ctx.lineWidth = Math.max(1.4, r * 0.08);
    this._traceEggPath(b.x, b.y, r);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.beginPath();
    ctx.ellipse(b.x - r * 0.24, b.y - r * 0.42, r * 0.17, r * 0.28, -0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawText(t) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = t.color || '#ffffff';
    ctx.shadowBlur = 18 * this.glow;
    ctx.shadowColor = t.color || '#ffffff';
    ctx.textAlign = t.align || 'center';
    ctx.textBaseline = 'middle';
    const size = Math.max(12, t.size || 72);
    const weight = t.weight || '700';
    const font = t.font || 'system-ui, sans-serif';
    ctx.font = `${weight} ${size}px ${font}`;
    const lines = String(t.text || '').split('\n');
    const lineH = size * 1.1;
    let y = t.y - ((lines.length - 1) * lineH) * 0.5;
    for (const line of lines) {
      ctx.fillText(line, t.x, y);
      y += lineH;
    }
    ctx.restore();
  }

  _drawTimer(t, state) {
    const elapsed = Math.max(0, (state && state.elapsedTime != null ? state.elapsedTime : (state.time || 0)) - (t._timerStartElapsed || 0));
    const decimals = Math.max(0, Math.min(3, t.decimals != null ? (t.decimals | 0) : 2));
    const text = `${t.prefix || ''}${elapsed.toFixed(decimals)}${t.suffix != null ? t.suffix : 's'}`;
    this._drawText({
      ...t,
      text,
    });
  }

  _drawScoreBin(bin) {
    const ctx = this.ctx;
    const w = Math.max(24, bin.width || 0);
    const h = Math.max(24, bin.height || 0);
    const left = (bin.x || 0) - w * 0.5;
    const top = (bin.y || 0) - h * 0.5;
    const right = left + w;
    const bottom = top + h;
    const color = bin.color || '#38bdf8';
    const textColor = bin.textColor || '#ffffff';
    ctx.save();
    ctx.shadowBlur = 26 * this.glow;
    ctx.shadowColor = color;
    const fill = ctx.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, 'rgba(255,255,255,0.05)');
    fill.addColorStop(1, 'rgba(255,255,255,0.14)');
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(left, top + 28);
    ctx.lineTo(left, bottom);
    ctx.lineTo(right, bottom);
    ctx.lineTo(right, top + 28);
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 34px system-ui, sans-serif';
    ctx.fillText(String(bin.label || ''), bin.x, top + h * 0.42);
    ctx.font = '600 24px system-ui, sans-serif';
    const pts = Number.isFinite(bin.points) ? (bin.points | 0) : 0;
    ctx.fillText(`${pts >= 0 ? '+' : ''}${pts}`, bin.x, top + h * 0.67);
    ctx.restore();
  }

  _drawTrail(b) {
    const ctx = this.ctx;
    const pts = b._trail;
    if (pts.length < 2) return;
    const trailStretch = b.softBody ? Math.max(0, Math.min(0.22, b._softStretch || 0)) : 0;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = b.color;
    ctx.shadowBlur = 18 * this.glow;
    ctx.shadowColor = b.color;
    for (let i = 1; i < pts.length; i++) {
      const t = i / pts.length;
      // Quadratic fade-in gives the "silk ribbon" feel preferred for loops.
      ctx.globalAlpha = (t * t) * 0.7;
      ctx.lineWidth = b.radius * t * (1.05 + trailStretch * 0.35);
      ctx.beginPath();
      ctx.moveTo(pts[i-1].x, pts[i-1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawCircle(c) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = this._makeConicStrokeStyle(c.x, c.y, c.gradientColors, c.color);
    ctx.shadowBlur = 24 * this.glow * (0.85 + (this._pulse || 0.5) * 0.3);
    ctx.shadowColor = c.color;
    const rotation = c.rotation || 0;
    const gap = this._visibleCircleGapSpec(c);
    const gapSize = gap.size;
    const halfThickness = Math.max(0, (c.thickness || 0) * 0.5);
    const outerRadius = Math.max(0, (c.radius || 0) + halfThickness);
    const innerRadius = Math.max(0, (c.radius || 0) - halfThickness);
    if (gapSize > 0) {
      const start = rotation + c.gapStart + gap.startOffset + gapSize;
      const end = rotation + c.gapStart + gap.startOffset + Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, outerRadius, start, end);
      if (innerRadius > 0) {
        ctx.arc(c.x, c.y, innerRadius, end, start, true);
      } else {
        ctx.lineTo(c.x, c.y);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(c.x, c.y, outerRadius, 0, Math.PI * 2);
      if (innerRadius > 0) {
        ctx.arc(c.x, c.y, innerRadius, Math.PI * 2, 0, true);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  _drawArc(a) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = a.thickness;
    ctx.strokeStyle = a.color;
    ctx.shadowBlur = 22 * this.glow * (0.85 + (this._pulse || 0.5) * 0.3);
    ctx.shadowColor = a.color;
    ctx.lineCap = 'round';
    const rot = a.rotation || 0;
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.radius, a.startAngle + rot, a.endAngle + rot);
    ctx.stroke();
    ctx.restore();
  }

  _drawSpiral(sp) {
    const ctx = this.ctx;
    const layers = Math.max(1, sp.layers | 0);
    const step = (sp.outerRadius - sp.innerRadius) / layers;
    ctx.save();
    ctx.strokeStyle = sp.color;
    ctx.lineWidth = sp.thickness;
    ctx.shadowBlur = 22 * this.glow;
    ctx.shadowColor = sp.color;
    for (let i = 0; i < layers; i++) {
      const r = sp.innerRadius + step * (i + 0.5);
      const rot = (sp.rotation || 0) + i * (Math.PI * 2 / layers);
      const start = rot + sp.gapSize;
      const end = rot + Math.PI * 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, start, end);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawSpikes(sp) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowBlur = 18 * this.glow;
    ctx.shadowColor = sp.color;
    const baseR = sp.radius;
    const tipR = sp.inward ? sp.radius - sp.length : sp.radius + sp.length;
    const sector = (Math.PI * 2) / sp.count;
    const halfWidthAngle = (sp.width / 2) / baseR;
    const rotation = sp.rotation || 0;
    for (let i = 0; i < sp.count; i++) {
      const relAngle = i * sector;
      // Skip spikes whose angle falls in the ring's gap (aligned with an
      // escape gap in a parent circle).
      if (sp.gapSize > 0 && spikeInGap(relAngle, sp.gapStart, sp.gapSize)) continue;
      ctx.fillStyle = Array.isArray(sp.gradientColors) && sp.gradientColors.length
        ? this._paletteColorAt(sp.gradientColors, i / Math.max(1, sp.count - 1))
        : sp.color;
      const a = rotation + relAngle;
      const tipX = sp.x + Math.cos(a) * tipR;
      const tipY = sp.y + Math.sin(a) * tipR;
      const b1x = sp.x + Math.cos(a - halfWidthAngle) * baseR;
      const b1y = sp.y + Math.sin(a - halfWidthAngle) * baseR;
      const b2x = sp.x + Math.cos(a + halfWidthAngle) * baseR;
      const b2y = sp.y + Math.sin(a + halfWidthAngle) * baseR;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(b1x, b1y);
      ctx.lineTo(b2x, b2y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  _drawSpinner(sp) {
    if (sp && sp.invisible) return;
    const ctx = this.ctx;
    const armLength = Math.max(10, sp.armLength || 0);
    const half = armLength * 0.5;
    const thickness = Math.max(2, sp.thickness || 0);
    const rotation = sp.rotation || 0;
    const armCount = Math.max(1, sp.armCount | 0);
    ctx.save();
    ctx.strokeStyle = sp.color || '#f8fafc';
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 20 * this.glow * (0.85 + (this._pulse || 0.5) * 0.3);
    ctx.shadowColor = sp.color || '#f8fafc';
    for (let i = 0; i < armCount; i++) {
      const a = rotation + i * (Math.PI / armCount);
      const dx = Math.cos(a) * half;
      const dy = Math.sin(a) * half;
      ctx.beginPath();
      ctx.moveTo(sp.x - dx, sp.y - dy);
      ctx.lineTo(sp.x + dx, sp.y + dy);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawBooster(booster) {
    const ctx = this.ctx;
    const radius = Math.max(4, booster.radius || 0);
    const color = booster.color || '#22d3ee';
    const accent = booster.accentColor || '#f0abfc';
    const pulse = 0.82 + (this._pulse || 0.5) * 0.28;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowBlur = 30 * this.glow * pulse;
    ctx.shadowColor = accent;
    const glow = ctx.createRadialGradient(booster.x, booster.y, radius * 0.18, booster.x, booster.y, radius * 1.45);
    glow.addColorStop(0, accent);
    glow.addColorStop(0.42, color);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(booster.x, booster.y, radius * 1.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = Math.max(4, radius * 0.14);
    ctx.strokeStyle = accent;
    ctx.fillStyle = '#080816';
    ctx.beginPath();
    ctx.arc(booster.x, booster.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = Math.max(2, radius * 0.06);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(booster.x, booster.y, radius * 0.68, 0, Math.PI * 2);
    ctx.stroke();
    if (booster.label) {
      ctx.shadowBlur = 10 * this.glow;
      ctx.shadowColor = accent;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.max(16, radius * 0.38)}px system-ui, sans-serif`;
      ctx.fillText(String(booster.label), booster.x, booster.y + 1);
    }
    ctx.restore();
  }

  _drawFlipper(flipper) {
    const ctx = this.ctx;
    const length = Math.max(20, flipper.length || 0);
    const thickness = Math.max(4, flipper.thickness || 0);
    const angle = flipper.rotation || 0;
    const ax = flipper.x || 0;
    const ay = flipper.y || 0;
    const bx = ax + Math.cos(angle) * length;
    const by = ay + Math.sin(angle) * length;
    const color = flipper.color || '#f472b6';
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowBlur = 26 * this.glow * (0.85 + (this._pulse || 0.5) * 0.3);
    ctx.shadowColor = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.82)';
    ctx.lineWidth = Math.max(2, thickness * 0.18);
    ctx.beginPath();
    ctx.moveTo(ax + Math.cos(angle) * thickness * 0.55, ay + Math.sin(angle) * thickness * 0.55);
    ctx.lineTo(bx - Math.cos(angle) * thickness * 0.55, by - Math.sin(angle) * thickness * 0.55);
    ctx.stroke();
    ctx.fillStyle = '#05060d';
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, thickness * 0.12);
    ctx.beginPath();
    ctx.arc(ax, ay, thickness * 0.58, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _drawSpawner(sp, time) {
    const ctx = this.ctx;
    const interval = Math.max(0.01, sp.interval || 1);
    // Progress 0..1 since last emission; draws a countdown ring so the
    // user can see the tempo.
    const sinceSpawn = time - (sp._lastSpawn != null && sp._lastSpawn > -1e9 ? sp._lastSpawn : 0);
    const progress = Math.max(0, Math.min(1, (sinceSpawn % interval) / interval));
    const color = sp.ballColor || '#38bdf8';
    ctx.save();
    ctx.shadowBlur = 16 * this.glow;
    ctx.shadowColor = color;
    // Outer dashed ring.
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 36, 0, Math.PI * 2);
    ctx.stroke();
    // Progress arc.
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 44, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
    // Center dot.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawParticles() {
    const ctx = this.ctx;
    if (this.particles.length === 0) return;
    // The old path used canvas `shadowBlur` per particle: on a 1080x1920
    // canvas that costs several ms per burst (shadowBlur is O(canvas-area)).
    // We replace it with a cheap `drawImage` of a cached per-color radial
    // gradient sprite. Additive compositing gives the neon glow for free,
    // and there's zero shadow work. Result: spike-splash bursts that used
    // to stutter the frame are now effectively free.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowBlur = 0;
    // Slightly larger halo in soft (Satisfying) mode; tighter in chaos mode
    // so spike splashes feel punchy rather than bloomy.
    const haloMult = this.softMode ? 6.5 : 5.0;
    const glowScale = Math.max(0.6, Math.min(1.8, this.glow));
    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.maxLife);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      const spr = this._getGlowSprite(p.color);
      const size = p.size * haloMult * glowScale;
      ctx.drawImage(spr, p.x - size / 2, p.y - size / 2, size, size);
    }
    ctx.restore();
  }

  _drawSelection(o) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 3;
    ctx.shadowBlur = 16;
    ctx.shadowColor = '#ffffff';
    const bounds = getObjectBounds(o);
    ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.restore();
  }

  _drawOverlay(overlay, state) {
    const ctx = this.ctx;
    ctx.save();
    if (overlay.title) {
      // Supports multi-line titles via \n, and shrinks to fit the canvas
      // width so long titles still read comfortably on 9:16.
      const lines = String(overlay.title).split('\n');
      const titleAlign = overlay.titleAlign || 'center';
      const titleWeight = overlay.titleWeight || 'bold';
      const titleFont = overlay.titleFont || 'system-ui, sans-serif';
      const titleColor = overlay.titleColor || '#ffffff';
      const titleShadow = overlay.titleShadowColor || '#7dd3fc';
      let size = Math.max(12, overlay.titleSize || 72);
      ctx.fillStyle = titleColor;
      ctx.shadowBlur = 18;
      ctx.shadowColor = titleShadow;
      ctx.textAlign = titleAlign;
      ctx.font = `${titleWeight} ${size}px ${titleFont}`;
      const maxW = W - 120;
      const widest = () => Math.max(...lines.map((l) => ctx.measureText(l).width));
      while (widest() > maxW && size > 28) {
        size -= 4;
        ctx.font = `${titleWeight} ${size}px ${titleFont}`;
      }
      const lineH = size * 1.1;
      const x = Math.max(60, Math.min(W - 60, overlay.titleX != null ? overlay.titleX : W / 2));
      let y = overlay.titleY != null ? overlay.titleY : 160;
      for (const line of lines) {
        ctx.fillText(line, x, y);
        y += lineH;
      }
    }
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 18;
    ctx.shadowColor = '#7dd3fc';
    ctx.textAlign = 'center';
    if (overlay.showTimer) {
      ctx.font = 'bold 60px system-ui, sans-serif';
      const elapsed = state.elapsedTime != null ? state.elapsedTime : state.time;
      ctx.fillText(elapsed.toFixed(2) + 's', W / 2, 260);
    }
    if (overlay.showCounter) {
      const alive = state.objects.filter((o) => o.type === 'ball' && o.alive && !o._escaped).length;
      const total = state.objects.filter((o) => o.type === 'ball').length;
      const counterSize = Math.max(18, overlay.counterSize || 56);
      ctx.font = `bold ${counterSize}px system-ui, sans-serif`;
      if (overlay.counterMode === 'survivors') {
        const active = state.objects.filter((o) => (
          o.type === 'ball' && o.alive && !o._escaped && !o._frozen && !o.fixed
        )).length;
        ctx.save();
        ctx.textAlign = overlay.counterAlign || 'center';
        ctx.fillStyle = overlay.counterColor || '#fb7185';
        ctx.shadowColor = overlay.counterShadowColor || '#fb7185';
        ctx.fillText(
          `${active}/${Math.max(1, overlay.counterTotal || total || 1)}`,
          overlay.counterX != null ? overlay.counterX : W / 2,
          overlay.counterY != null ? overlay.counterY : H - 150,
        );
        ctx.restore();
      } else if (overlay.counterMode === 'ballsUsedPlain') {
        ctx.save();
        ctx.textAlign = overlay.counterAlign || 'left';
        ctx.fillText(
          String(Math.max(total, Number(state.ballsUsedCount) || 0)),
          overlay.counterX != null ? overlay.counterX : 60,
          overlay.counterY != null ? overlay.counterY : 110,
        );
        ctx.restore();
      } else if (overlay.counterMode === 'ballsUsedFraction') {
        const used = Math.max(total, Number(state.ballsUsedCount) || 0);
        const max = Math.max(1, overlay.counterTotal || total || 1);
        ctx.save();
        ctx.textAlign = overlay.counterAlign || 'center';
        ctx.fillStyle = overlay.counterColor || '#fb7185';
        ctx.shadowColor = overlay.counterShadowColor || '#fb7185';
        ctx.fillText(
          `${Math.min(used, max)}/${max}`,
          overlay.counterX != null ? overlay.counterX : W / 2,
          overlay.counterY != null ? overlay.counterY : H - 150,
        );
        ctx.restore();
      } else if (overlay.counterMode === 'ballsUsed') {
        const label = String(overlay.counterLabel || 'BALLS');
        const used = Math.max(total, Number(state.ballsUsedCount) || 0);
        ctx.fillText(`${label}: ${used}`, W / 2, H - 120);
      } else {
        ctx.fillText(`${alive} / ${total}`, W / 2, H - 120);
      }
    }
    if (overlay.showScore) {
      ctx.save();
      ctx.textAlign = overlay.scoreAlign || 'right';
      ctx.fillStyle = overlay.scoreColor || '#ffffff';
      ctx.shadowColor = overlay.scoreShadowColor || '#7dd3fc';
      ctx.font = `700 ${Math.max(18, overlay.scoreSize || 48)}px system-ui, sans-serif`;
      ctx.fillText(
        `Score ${state.score || 0}`,
        overlay.scoreX != null ? overlay.scoreX : W - 60,
        overlay.scoreY != null ? overlay.scoreY : 110,
      );
      ctx.restore();
    }
    // Big center countdown: a giant semi-transparent integer that ticks each
    // second and fades during that second. Used for the "timed escape"
    // preset. `countdownMax` caps the displayed number; after that the
    // countdown stops rendering so it doesn't pollute the final frame.
    if (overlay.bigCountdown) {
      const max = overlay.countdownMax || 4;
      let n = 0;
      let alpha = 0;
      if (overlay.countdownMode === 'activeBallLifetime') {
        const active = state.objects.find((o) => o.type === 'ball' && o.alive && !o._frozen && o.lifetime > 0);
        if (active) {
          const remaining = Math.max(0, (active.lifetime || 0) - (active.age || 0));
          n = Math.ceil(remaining);
          const local = Math.max(0, Math.min(1, n - remaining));
          alpha = Math.max(0, 1 - local);
        }
      } else if (overlay.countdownMode === 'repeatInterval') {
        const interval = Math.max(0.01, overlay.countdownInterval || max || 4);
        const elapsed = Math.max(0, state && state.elapsedTime != null ? state.elapsedTime : (state.time || 0));
        const wrapped = elapsed % interval;
        const remaining = wrapped < 1e-6 && elapsed > 0 ? interval : (interval - wrapped);
        n = Math.ceil(remaining);
        const local = Math.max(0, Math.min(1, n - remaining));
        alpha = Math.max(0, 1 - local);
      } else {
        const t = state.time;
        n = Math.floor(t) + 1;
        const local = t - (n - 1);
        alpha = Math.max(0, 1 - local);
      }
      if (n > 0 && n <= max) {
        ctx.save();
        ctx.globalAlpha = alpha * 0.40;
        ctx.fillStyle = '#e5e7eb';
        ctx.shadowBlur = 60;
        ctx.shadowColor = '#ffffff';
        const countdownSize = Math.max(48, Number(overlay.countdownSize) || 420);
        const countdownY = Number.isFinite(overlay.countdownY) ? overlay.countdownY : (H / 2);
        ctx.font = `bold ${Math.round(countdownSize)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n), W / 2, countdownY);
        ctx.restore();
      }
    }
    ctx.restore();
  }
}

function effectiveCircleGapSize(c, time = 0) {
  const maxGap = Math.max(0, c.gapSize || 0);
  if (!c.gapPulse || maxGap <= 0) return maxGap;
  const minGap = Math.max(0, Math.min(maxGap, c.gapMinSize || 0));
  const span = maxGap - minGap;
  const speed = Math.max(0, c.gapPulseSpeed || 0);
  if (span <= 1e-6 || speed <= 1e-6) return maxGap;
  return minGap + span * (0.5 + 0.5 * Math.cos(time * speed * Math.PI * 2));
}

function normalizeAngle(a) {
  a = a % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a;
}

function angleInGapDebug(a, start, gapSize) {
  if (gapSize <= 0) return false;
  const s = normalizeAngle(start);
  const e = normalizeAngle(s + gapSize);
  const n = normalizeAngle(a);
  return s <= e ? (n >= s && n <= e) : (n >= s || n <= e);
}

function drawAngleRay(ctx, cx, cy, angle, length, color, width) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(angle) * length, cy + Math.sin(angle) * length);
  ctx.stroke();
  ctx.restore();
}

// Returns true if `relAngle` (spike-local angle, before ring rotation) lies
// inside the gap [gapStart, gapStart+gapSize]. Used to align a spike ring's
// missing teeth with a circle's escape gap.
function spikeInGap(relAngle, gapStart, gapSize) {
  const TWO_PI = Math.PI * 2;
  const norm = (a) => { a = a % TWO_PI; return a < 0 ? a + TWO_PI : a; };
  const start = norm(gapStart);
  const end = norm(start + gapSize);
  const a = norm(relAngle);
  return start <= end ? (a >= start && a <= end) : (a >= start || a <= end);
}

// Sample N points around an object's visible outline; used by shatter.
function sampleOutline(o, count = 80) {
  const pts = [];
  const push = (x, y) => pts.push({ x, y });
  if (o.type === 'circle') {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      push(o.x + Math.cos(a) * o.radius, o.y + Math.sin(a) * o.radius);
    }
  } else if (o.type === 'arc') {
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const a = o.startAngle + t * (o.endAngle - o.startAngle) + (o.rotation || 0);
      push(o.x + Math.cos(a) * o.radius, o.y + Math.sin(a) * o.radius);
    }
  } else if (o.type === 'spikes') {
    const sector = (Math.PI * 2) / o.count;
    const tipR = o.inward ? o.radius - o.length : o.radius + o.length;
    for (let i = 0; i < o.count; i++) {
      const a = (o.rotation || 0) + i * sector;
      push(o.x + Math.cos(a) * tipR, o.y + Math.sin(a) * tipR);
    }
  } else if (o.type === 'spinner') {
    const half = Math.max(10, o.armLength || 0) * 0.5;
    const arms = Math.max(1, o.armCount | 0);
    for (let i = 0; i < arms; i++) {
      const a = (o.rotation || 0) + i * (Math.PI / arms);
      push(o.x + Math.cos(a) * half, o.y + Math.sin(a) * half);
      push(o.x - Math.cos(a) * half, o.y - Math.sin(a) * half);
    }
  } else if (o.type === 'booster') {
    const r = Math.max(4, o.radius || 0);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      push(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r);
    }
  } else if (o.type === 'flipper') {
    const len = Math.max(20, o.length || 0);
    const a = o.rotation || 0;
    push(o.x, o.y);
    push(o.x + Math.cos(a) * len, o.y + Math.sin(a) * len);
  } else if (o.type === 'spiral') {
    const layers = Math.max(1, o.layers | 0);
    const step = (o.outerRadius - o.innerRadius) / layers;
    for (let i = 0; i < layers; i++) {
      const r = o.innerRadius + step * (i + 0.5);
      const samples = Math.max(8, (count / layers) | 0);
      for (let j = 0; j < samples; j++) {
        const a = (j / samples) * Math.PI * 2 + (o.rotation || 0);
        push(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r);
      }
    }
  } else if (o.type === 'scoreBin') {
    const w = Math.max(24, o.width || 0);
    const h = Math.max(24, o.height || 0);
    const left = (o.x || 0) - w * 0.5;
    const top = (o.y || 0) - h * 0.5;
    const right = left + w;
    push(left, top + 28);
    push(left, top);
    push(right, top);
    push(right, top + 28);
    push(right, top + h);
    push(left, top + h);
  } else {
    push(o.x, o.y);
  }
  return pts;
}

function getObjectBounds(o) {
  switch (o.type) {
    case 'ball': return { x: o.x - o.radius - 6, y: o.y - o.radius - 6, w: (o.radius + 6) * 2, h: (o.radius + 6) * 2 };
    case 'text': {
      const lines = String(o.text || '').split('\n');
      const size = Math.max(12, o.size || 72);
      const width = Math.max(...lines.map((line) => Math.max(1, line.length) * size * 0.58));
      const height = lines.length * size * 1.1;
      let x = o.x - width * 0.5;
      if ((o.align || 'center') === 'left') x = o.x;
      else if ((o.align || 'center') === 'right') x = o.x - width;
      return { x: x - 8, y: o.y - height * 0.5 - 8, w: width + 16, h: height + 16 };
    }
    case 'timer': {
      const size = Math.max(12, o.size || 60);
      const sample = `${o.prefix || ''}88${(o.decimals | 0) > 0 ? '.' + '8'.repeat(Math.max(0, Math.min(3, o.decimals | 0))) : ''}${o.suffix != null ? o.suffix : 's'}`;
      const width = Math.max(1, sample.length) * size * 0.58;
      let x = o.x - width * 0.5;
      if ((o.align || 'center') === 'left') x = o.x;
      else if ((o.align || 'center') === 'right') x = o.x - width;
      return { x: x - 8, y: o.y - size * 0.55 - 8, w: width + 16, h: size * 1.1 + 16 };
    }
    case 'circle':
    case 'spikes':
      return { x: o.x - o.radius - 20, y: o.y - o.radius - 20, w: (o.radius + 20) * 2, h: (o.radius + 20) * 2 };
    case 'spinner': {
      const half = Math.max(10, o.armLength || 0) * 0.5;
      const pad = Math.max(12, (o.thickness || 0) * 0.5 + 10);
      return { x: o.x - half - pad, y: o.y - half - pad, w: (half + pad) * 2, h: (half + pad) * 2 };
    }
    case 'booster': {
      const r = Math.max(4, o.radius || 0) + 14;
      return { x: o.x - r, y: o.y - r, w: r * 2, h: r * 2 };
    }
    case 'flipper': {
      const len = Math.max(20, o.length || 0);
      const angle = o.rotation || 0;
      const ax = o.x || 0;
      const ay = o.y || 0;
      const bx = ax + Math.cos(angle) * len;
      const by = ay + Math.sin(angle) * len;
      const pad = Math.max(12, (o.thickness || 0) * 0.5 + 10);
      return {
        x: Math.min(ax, bx) - pad,
        y: Math.min(ay, by) - pad,
        w: Math.abs(bx - ax) + pad * 2,
        h: Math.abs(by - ay) + pad * 2,
      };
    }
    case 'arc':
      return { x: o.x - o.radius - 10, y: o.y - o.radius - 10, w: (o.radius + 10) * 2, h: (o.radius + 10) * 2 };
    case 'spiral':
      return { x: o.x - o.outerRadius - 10, y: o.y - o.outerRadius - 10, w: (o.outerRadius + 10) * 2, h: (o.outerRadius + 10) * 2 };
    case 'spawner':
      return { x: o.x - 50, y: o.y - 50, w: 100, h: 100 };
    case 'scoreBin':
      return {
        x: (o.x || 0) - Math.max(24, o.width || 0) * 0.5 - 8,
        y: (o.y || 0) - Math.max(24, o.height || 0) * 0.5 - 8,
        w: Math.max(24, o.width || 0) + 16,
        h: Math.max(24, o.height || 0) + 16,
      };
    default: return { x: o.x - 40, y: o.y - 40, w: 80, h: 80 };
  }
}

window.Renderer = Renderer;
window.getObjectBounds = getObjectBounds;
