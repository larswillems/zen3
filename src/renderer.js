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
    this.glow = 1.0;
    this.softMode = true;
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

  _visibleCircleGapSize(c) {
    const rawGap = effectiveCircleGapSize(c, this._state ? this._state.time : 0);
    if (rawGap <= 0) return 0;
    const ballRadius = this._maxBallRadiusForCircle(c);
    if (ballRadius <= 0) return rawGap;
    const clearanceRadius = Math.max(1, (c.radius || 0) - ((c.thickness || 0) * 0.5));
    const ratio = Math.max(0, Math.min(0.999999, ballRadius / clearanceRadius));
    const angularPad = Math.asin(ratio);
    return Math.max(0, rawGap - angularPad * 2);
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
    for (const p of outline) {
      const a = Math.atan2(p.y - (s.y || 960), p.x - (s.x || 540)) + (Math.random() - 0.5);
      const spd = (300 + Math.random() * 500) * burstScale;
      this.particles.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        life: 1.4 + Math.random(),
        maxLife: 2.4,
        color,
        size: 3 + Math.random() * 5,
      });
    }
    this._trimParticles();
  }

  triggerFlash(color = '#ffffff', maxLife = 0.8) {
    this.flash = { color, life: maxLife, maxLife };
  }

  showPopup(text, seconds = 2, color = '#ffffff', shadowColor = null) {
    this.popup = {
      text,
      life: seconds,
      maxLife: seconds,
      color,
      shadowColor: shadowColor || color || '#ffffff',
    };
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

    if (this.flash) {
      this.flash.life -= dt;
      if (this.flash.life <= 0) this.flash = null;
    }
    if (this.popup) {
      this.popup.life -= dt;
      if (this.popup.life <= 0) this.popup = null;
    }
  }

  handleEvents(events) {
    for (const ev of events) {
      if (ev.type === 'bounce') this.addParticle(ev.x, ev.y, ev.color, 4);
      else if (ev.type === 'destroy') this.addParticle(ev.x, ev.y, ev.color, 14);
      else if (ev.type === 'escape') this.addParticle(ev.x, ev.y, ev.color, 12);
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
        } else {
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
      if (o.type === 'circle') this._drawCircle(o);
      else if (o.type === 'arc') this._drawArc(o);
      else if (o.type === 'spiral') this._drawSpiral(o);
      else if (o.type === 'spikes') this._drawSpikes(o);
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

    // Re-draw structures lightly on top so dense ball clusters / particles
    // don't visually hide the exact collision boundaries. This doesn't change
    // physics; it only makes "what can I bounce on?" readable on-screen.
    ctx.save();
    ctx.globalAlpha = 0.55;
    for (const o of state.objects) {
      if (o.type === 'circle') this._drawCircle(o);
      else if (o.type === 'arc') this._drawArc(o);
      else if (o.type === 'spiral') this._drawSpiral(o);
      else if (o.type === 'spikes') this._drawSpikes(o);
      else if (o.type === 'scoreBin') this._drawScoreBin(o);
    }
    ctx.restore();

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
    ctx.font = `bold ${Math.round(160 * scale)}px system-ui, sans-serif`;
    ctx.fillText(this.popup.text, W / 2, H / 2);
    ctx.restore();
  }

  _drawBall(b) {
    const ctx = this.ctx;
    ctx.save();
    const pulseScale = 0.9 + (this._pulse || 0.5) * 0.3;
    if (b._frozen) {
      // "Frosted" look: dimmer, cool rim, no breathing pulse.
      ctx.shadowBlur = 10 * this.glow;
      ctx.shadowColor = '#bae6fd';
      ctx.fillStyle = b.color;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#e0f2fe';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.stroke();
      // Small frost specks so frozen balls read as "iced" not "dim".
      ctx.fillStyle = 'rgba(224, 242, 254, 0.9)';
      for (let i = 0; i < 3; i++) {
        const a = i * 2.094;
        ctx.beginPath();
        ctx.arc(b.x + Math.cos(a) * b.radius * 0.45,
                b.y + Math.sin(a) * b.radius * 0.45, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      const softBodyActive = !!b.softBody && (
        (b._softStretch || 0) > 0.002
        || (b._softSquash || 0) > 0.002
        || (b._softFlow || 0) > 0.002
        || (b._softWobbleAmp || 0) > 0.001
      );
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
    ctx.restore();
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
    ctx.lineWidth = c.thickness;
    ctx.strokeStyle = this._makeConicStrokeStyle(c.x, c.y, c.gradientColors, c.color);
    ctx.shadowBlur = 24 * this.glow * (0.85 + (this._pulse || 0.5) * 0.3);
    ctx.shadowColor = c.color;
    const rotation = c.rotation || 0;
    const gapSize = this._visibleCircleGapSize(c);
    if (gapSize > 0) {
      const start = rotation + c.gapStart + gapSize; // draw from end of gap
      const end = rotation + c.gapStart + Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.radius, start, end);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
      ctx.stroke();
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
      ctx.font = 'bold 56px system-ui, sans-serif';
      ctx.fillText(`${alive} / ${total}`, W / 2, H - 120);
    }
    if (overlay.showScore) {
      ctx.save();
      ctx.textAlign = 'right';
      ctx.font = '700 48px system-ui, sans-serif';
      ctx.fillText(`Score ${state.score || 0}`, W - 60, 110);
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
        ctx.font = 'bold 420px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n), W / 2, H / 2);
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
