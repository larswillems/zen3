// Lightweight Web Audio engine that turns simulation events into satisfying,
// musical blips. Everything is synthesized on the fly (no asset files) so the
// app stays self-contained.
//
// The voice builders are context-agnostic: they take `(ctx, dest, startTime)`
// so the exact same code path drives either:
//   - the live AudioContext during playback, OR
//   - an OfflineAudioContext during MP4 export (via `renderOffline`).
// That guarantees the audio in the exported video matches what the user hears
// live, sample-for-sample.

// Per-ball sound preset registry. Each kind (bounce/escape/destroy/freeze)
// has a set of named voices a ball can opt into via its `bounceSound`,
// `escapeSound`, `destroySound`, or `deathSound` property. Each voice is a
// plain function `(engine, ctx, dest, t0, ev, pan, step)` so it works in
// both the live AudioContext and the OfflineAudioContext used for exports.
//
// `'' / default` means "fall through to the scenario-wide default behavior"
// (current pentatonic bounce, chime freeze, etc.). `'silent'` explicitly
// mutes that event for the ball.
const SOUND_PRESETS = {
  bounce: [
    { value: '',         label: 'Default (pentatonic)' },
    { value: 'blip',     label: 'Blip (triangle)' },
    { value: 'click',    label: 'Wood click' },
    { value: 'thud',     label: 'Thud (low)' },
    { value: 'chirp',    label: 'Chirp (up-sweep)' },
    { value: 'pop',      label: 'Pop (noise burst)' },
    { value: 'piano',    label: 'Piano' },
    { value: 'pianoRise', label: 'Piano rise' },
    { value: 'bell',     label: 'Bell' },
    { value: 'legendChime', label: 'Legend chime' },
    { value: 'soft',     label: 'Soft sine' },
    { value: 'laser',    label: 'Laser (down-sweep)' },
    { value: 'silent',   label: 'Silent' },
  ],
  escape: [
    { value: '',         label: 'Default (up-sweep)' },
    { value: 'zap',      label: 'Zap (fast sweep)' },
    { value: 'boom',     label: 'Boom (sub-bass)' },
    { value: 'chime',    label: 'Chime (triad)' },
    { value: 'whoosh',   label: 'Whoosh (noise)' },
    { value: 'riser',    label: 'Riser (long)' },
    { value: 'silent',   label: 'Silent' },
  ],
  destroy: [
    { value: '',         label: 'Default (saw + noise)' },
    { value: 'crunch',   label: 'Crunch' },
    { value: 'glass',    label: 'Glass shatter' },
    { value: 'hollowEcho', label: 'Hollow echo' },
    { value: 'pop',      label: 'Pop' },
    { value: 'poof',     label: 'Poof (soft)' },
    { value: 'explode',  label: 'Explode' },
    { value: 'silent',   label: 'Silent' },
  ],
  freeze: [
    { value: '',         label: 'Default (chime)' },
    { value: 'hollowEcho', label: 'Hollow echo' },
    { value: 'chime',    label: 'Bright chime' },
    { value: 'thud',     label: 'Thud' },
    { value: 'crystal',  label: 'Crystal shimmer' },
    { value: 'freezer',  label: 'Freezer (low chirp)' },
    { value: 'silent',   label: 'Silent' },
  ],
  gapPass: [
    { value: '',         label: 'Auto by outcome' },
    { value: 'glass',    label: 'Glass shatter' },
    { value: 'burst',    label: 'Burst' },
    { value: 'burn',     label: 'Burn' },
    { value: 'whoosh',   label: 'Whoosh' },
    { value: 'zap',      label: 'Zap' },
    { value: 'explode',  label: 'Explode' },
    { value: 'silent',   label: 'Silent' },
  ],
};
window.SOUND_PRESETS = SOUND_PRESETS;

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.35;
    this._ready = false;
    // Live per-type throttle map (wall-clock seconds on the live context).
    this._lastPlay = new Map();

    // Major-pentatonic (C D E G A) — every combination sounds consonant.
    this._pentatonic = [0, 2, 4, 7, 9];
    this._rootMidi = 60; // C4
    this._melody = null;
    this._melodyIndex = 0;
    this._pianoRiseIndex = 0;
    this._soundAssets = {};
    this._assetBytes = new Map();
    this._liveAssetBuffers = new Map();
    this._assetDecodePromises = new Map();
    this._pendingAssetPlaybacks = new Map();
    this._assetMixes = new Map();
    this._assetPlaybackWindows = new Map();
    this._activeAssetBuffers = null;
    this._buildVoiceMap();
  }

  // Must be called from a user gesture. Safe to call repeatedly.
  ensureReady() {
    if (this._ready && this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      this.ctx = new Ctx();
    } catch (_) { return false; }
    const { master } = this._buildMasterChain(this.ctx, this.volume);
    this.master = master;
    this._ready = true;
    for (const assetId of Object.keys(this._soundAssets || {})) {
      this._ensureLiveAssetBuffer(assetId).catch(() => {});
    }
    return true;
  }

  setEnabled(on) { this.enabled = !!on; }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setScenario(scenario) {
    this._soundAssets = (scenario && scenario.soundAssets && typeof scenario.soundAssets === 'object')
      ? scenario.soundAssets
      : {};
    for (const key of Array.from(this._liveAssetBuffers.keys())) {
      if (!this._soundAssets[key]) this._liveAssetBuffers.delete(key);
    }
    for (const key of Array.from(this._assetMixes.keys())) {
      if (!this._soundAssets[key]) this._assetMixes.delete(key);
    }
    for (const key of Array.from(this._assetPlaybackWindows.keys())) {
      if (!this._soundAssets[key]) this._assetPlaybackWindows.delete(key);
    }
    for (const key of Array.from(this._pendingAssetPlaybacks.keys())) {
      if (!this._soundAssets[key]) this._pendingAssetPlaybacks.delete(key);
    }
    if (this.ctx) {
      for (const assetId of Object.keys(this._soundAssets)) {
        this._ensureLiveAssetBuffer(assetId).catch(() => {});
      }
    }
    const melody = scenario && scenario.melody;
    if (!melody || !melody.enabled || !Array.isArray(melody.notes) || melody.notes.length === 0) {
      this._melody = null;
      this._melodyIndex = 0;
      return;
    }
    let triggerSources = Array.isArray(melody.triggerSources) && melody.triggerSources.length
      ? melody.triggerSources.slice()
      : [melody.triggerSource || 'circle'];
    // Backward-compatible upgrade for older Twinkle/custom scenes that only
    // stored `triggerSource: "circle"` before static-ball melody support
    // existed. Those scenes should continue the same melody on fixed-ball hits.
    if (triggerSources.includes('circle') && !triggerSources.includes('fixedBall')) {
      triggerSources.push('fixedBall');
    }
    this._melody = {
      triggerSources,
      notes: melody.notes.slice(),
      loop: melody.loop !== false,
      wave: melody.wave || 'triangle',
      gain: melody.gain != null ? melody.gain : 0.34,
      decay: melody.decay != null ? melody.decay : 0.22,
    };
    this._melodyIndex = 0;
  }

  resetTimelineState() {
    this._melodyIndex = 0;
    this._pianoRiseIndex = 0;
    this._assetPlaybackWindows.clear();
  }

  createExportClone() {
    const clone = new AudioEngine();
    clone.enabled = this.enabled;
    clone.volume = this.volume;
    clone._soundAssets = JSON.parse(JSON.stringify(this._soundAssets || {}));
    clone._melody = this._melody ? {
      ...this._melody,
      triggerSources: Array.isArray(this._melody.triggerSources) ? this._melody.triggerSources.slice() : [],
      notes: Array.isArray(this._melody.notes) ? this._melody.notes.slice() : [],
    } : null;
    clone._melodyIndex = this._melodyIndex;
    clone._pianoRiseIndex = this._pianoRiseIndex;
    clone._assetBytes = new Map(this._assetBytes);
    return clone;
  }

  // --- Shared helpers ------------------------------------------------------

  _pickNote(step) {
    const len = this._pentatonic.length;
    const deg = ((step % len) + len) % len;
    const oct = Math.floor(step / len);
    return this._rootMidi + this._pentatonic[deg] + oct * 12;
  }

  _midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  _isOfflineContext(ctx) {
    return !!ctx && typeof ctx.startRendering === 'function';
  }

  // Build the master chain connected to `ctx.destination`.
  // Live audio uses a compressor for polish. Offline export uses a safer,
  // simpler direct gain path because some browsers are flaky with compressor /
  // panner nodes during OfflineAudioContext rendering.
  _buildMasterChain(ctx, volume) {
    const master = ctx.createGain();
    master.gain.value = volume;
    if (this._isOfflineContext(ctx)) {
      master.connect(ctx.destination);
      return { master, limiter: null };
    }
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 24;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    return { master, limiter };
  }

  _routeWithPan(ctx, dest, node, pan) {
    if (!this._isOfflineContext(ctx) && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p);
      p.connect(dest);
    } else {
      node.connect(dest);
    }
  }

  // --- Context-agnostic voice primitives ----------------------------------

  _blip(ctx, dest, t0, freq, {
    pan = 0, gain = 0.4, attack = 0.002, decay = 0.18,
    wave = 'triangle', detuneCents = 0,
  } = {}) {
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = freq;
    if (detuneCents) osc.detune.value = detuneCents;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    osc.connect(g);
    this._routeWithPan(ctx, dest, g, pan);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.05);
  }

  _pianoTone(ctx, dest, t0, freq, {
    pan = 0, gain = 0.28, decay = 0.42, detuneCents = 0,
  } = {}) {
    const partials = [
      { mul: 1.00, gain: 1.00, wave: 'sine', decay: 1.00 },
      { mul: 2.00, gain: 0.20, wave: 'sine', decay: 0.62 },
      { mul: 4.00, gain: 0.055, wave: 'sine', decay: 0.32 },
    ];
    for (const p of partials) {
      this._blip(ctx, dest, t0, freq * p.mul, {
        pan,
        gain: gain * p.gain,
        attack: 0.004,
        decay: decay * p.decay,
        wave: p.wave,
        detuneCents,
      });
    }
  }

  _sweep(ctx, dest, t0, {
    pan = 0, startFreq = 220, endFreq = 880, decay = 0.6, gain = 0.5,
  } = {}) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(startFreq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    osc.connect(g);
    this._routeWithPan(ctx, dest, g, pan);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }

  _noise(ctx, dest, t0, { pan = 0, decay = 0.15, gain = 0.4, lowpass = 1400 } = {}) {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * decay), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.pow(1 - i / data.length, 1.6);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = lowpass;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filt); filt.connect(g);
    this._routeWithPan(ctx, dest, g, pan);
    src.start(t0);
    src.stop(t0 + decay + 0.05);
  }

  _shimmer(ctx, dest, t0, duration) {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.pow(1 - i / data.length, 0.9);
      data[i] = (Math.random() * 2 - 1) * env * 0.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 6200;
    filt.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filt); filt.connect(g);
    this._routeWithPan(ctx, dest, g, 0);
    src.start(t0);
    src.stop(t0 + duration + 0.05);
  }

  _hollowEcho(ctx, dest, t0, { pan = 0, freq = 220, gain = 0.32 } = {}) {
    const hits = [
      { dt: 0.00, f: freq, mul: 1.00, body: gain },
      { dt: 0.09, f: freq * 0.74, mul: 0.55, body: gain * 0.55 },
      { dt: 0.18, f: freq * 0.56, mul: 0.35, body: gain * 0.35 },
    ];
    for (const hit of hits) {
      const start = t0 + hit.dt;
      this._blip(ctx, dest, start, hit.f, {
        pan,
        gain: hit.body,
        attack: 0.002,
        decay: 0.38 * hit.mul,
        wave: 'sine',
      });
      this._noise(ctx, dest, start, {
        pan,
        decay: 0.22 * hit.mul,
        gain: 0.045 * hit.mul,
        lowpass: 650,
      });
    }
  }

  _playMelodyBounce(ctx, dest, t0, ev, pan, throttle) {
    const m = this._melody;
    if (!m || ev.type !== 'bounce') return false;
    if (!m.triggerSources.includes(ev.source || '')) return false;
    const note = m.notes[this._melodyIndex] != null ? m.notes[this._melodyIndex] : m.notes[0];
    this._melodyIndex++;
    if (m.loop && this._melodyIndex >= m.notes.length) this._melodyIndex = 0;
    else if (!m.loop) this._melodyIndex = Math.min(this._melodyIndex, m.notes.length - 1);
    const freq = this._midiToFreq(note);
    this._blip(ctx, dest, t0, freq, {
      pan,
      gain: m.gain,
      attack: 0.001,
      decay: m.decay,
      wave: m.wave,
    });
    return true;
  }

  _assetEntry(assetId) {
    if (!assetId) return null;
    return this._soundAssets && this._soundAssets[assetId] ? this._soundAssets[assetId] : null;
  }

  async _assetBytesFor(assetId) {
    if (!assetId) return null;
    if (this._assetBytes.has(assetId)) return this._assetBytes.get(assetId);
    const entry = this._assetEntry(assetId);
    if (!entry) return null;
    if (entry.url && typeof entry.url === 'string' && typeof fetch === 'function') {
      try {
        const response = await fetch(entry.url);
        if (!response.ok) return null;
        const buf = await response.arrayBuffer();
        this._assetBytes.set(assetId, buf);
        return buf;
      } catch (_) {
        return null;
      }
    }
    if (!entry.dataUrl || typeof entry.dataUrl !== 'string') return null;
    const comma = entry.dataUrl.indexOf(',');
    if (comma < 0) return null;
    try {
      const raw = atob(entry.dataUrl.slice(comma + 1));
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      const buf = out.buffer;
      this._assetBytes.set(assetId, buf);
      return buf;
    } catch (_) {
      return null;
    }
  }

  async _decodeAssetForContext(ctx, assetId) {
    const bytes = await this._assetBytesFor(assetId);
    if (!bytes || !ctx || typeof ctx.decodeAudioData !== 'function') return null;
    try {
      return await ctx.decodeAudioData(bytes.slice(0));
    } catch (_) {
      return null;
    }
  }

  async _ensureLiveAssetBuffer(assetId) {
    if (!assetId || !this.ctx) return null;
    if (this._liveAssetBuffers.has(assetId)) return this._liveAssetBuffers.get(assetId);
    if (this._assetDecodePromises.has(assetId)) return this._assetDecodePromises.get(assetId);
    const pending = this._decodeAssetForContext(this.ctx, assetId).then((buffer) => {
      this._assetDecodePromises.delete(assetId);
      if (buffer) this._liveAssetBuffers.set(assetId, buffer);
      return buffer;
    });
    this._assetDecodePromises.set(assetId, pending);
    return pending;
  }

  _playSampleBuffer(ctx, dest, t0, buffer, pan = 0, volume = 1, onEnded = null) {
    if (!buffer) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (typeof onEnded === 'function') src.onended = onEnded;
    const g = ctx.createGain();
    g.gain.value = Math.max(0, Math.min(2, volume != null ? volume : 1));
    src.connect(g);
    this._routeWithPan(ctx, dest, g, pan);
    src.start(t0);
    return true;
  }

  _assetMixFor(assetId) {
    if (!assetId || !this.ctx || !this.master) return null;
    const existing = this._assetMixes.get(assetId);
    if (existing) return existing;
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    gain.connect(this.master);
    const mix = { gain, active: 0 };
    this._assetMixes.set(assetId, mix);
    return mix;
  }

  _setAssetMixGain(mix, ctx, t0) {
    if (!mix || !ctx) return;
    const gain = 1 / Math.max(1, mix.active || 0);
    const at = Math.max(ctx.currentTime || 0, t0 || 0);
    mix.gain.gain.cancelScheduledValues(at);
    mix.gain.gain.setTargetAtTime(gain, at, 0.012);
  }

  _playUploadedAssetBuffer(ctx, dest, t0, assetId, buffer, pan = 0, volume = 1) {
    if (!buffer) return false;
    if (ctx === this.ctx && dest === this.master) {
      const mix = this._assetMixFor(assetId);
      if (mix) {
        mix.active += 1;
        this._setAssetMixGain(mix, ctx, t0);
        return this._playSampleBuffer(ctx, mix.gain, t0, buffer, pan, volume, () => {
          mix.active = Math.max(0, mix.active - 1);
          this._setAssetMixGain(mix, ctx, ctx.currentTime);
        });
      }
    }

    const windows = this._assetPlaybackWindows.get(assetId) || [];
    const now = Math.max(0, t0 || 0);
    const active = windows.filter((end) => end > now);
    active.push(now + (buffer.duration || 0));
    this._assetPlaybackWindows.set(assetId, active);
    return this._playSampleBuffer(ctx, dest, t0, buffer, pan, volume / active.length);
  }

  _playUploadedAsset(ctx, dest, t0, assetId, pan = 0, volume = 1) {
    if (!assetId) return false;
    if (this._activeAssetBuffers && this._activeAssetBuffers.has(assetId)) {
      return this._playUploadedAssetBuffer(ctx, dest, t0, assetId, this._activeAssetBuffers.get(assetId), pan, volume);
    }
    if (ctx === this.ctx) {
      const ready = this._liveAssetBuffers.get(assetId);
      if (ready) return this._playUploadedAssetBuffer(ctx, dest, t0, assetId, ready, pan, volume);
      const pendingCount = this._pendingAssetPlaybacks.get(assetId) || 0;
      if (pendingCount < 12) {
        this._pendingAssetPlaybacks.set(assetId, pendingCount + 1);
        this._ensureLiveAssetBuffer(assetId).then((buffer) => {
          this._pendingAssetPlaybacks.set(assetId, Math.max(0, (this._pendingAssetPlaybacks.get(assetId) || 1) - 1));
          if (!buffer || !this.ctx || !this.master || !this.enabled) return;
          this._playUploadedAssetBuffer(this.ctx, this.master, this.ctx.currentTime, assetId, buffer, pan, volume);
        }).catch(() => {
          this._pendingAssetPlaybacks.set(assetId, Math.max(0, (this._pendingAssetPlaybacks.get(assetId) || 1) - 1));
        });
      } else {
        this._ensureLiveAssetBuffer(assetId).catch(() => {});
      }
    }
    return false;
  }

  _autoGapPreset(ev) {
    switch (ev && ev.gapOutcome) {
      case 'burn': return 'burn';
      case 'flyAway':
      case 'launchUp':
      case 'launchDown': return 'whoosh';
      case 'destroy': return 'burst';
      case 'shatter': return 'glass';
      default: return 'zap';
    }
  }

  _playConfiguredGapSound(ctx, dest, t0, ev, pan, step) {
    if (!ev || !ev.gapSoundMode || ev.gapSoundMode === 'none') return false;
    if (ev.gapSoundMode === 'preset') {
      const preset = ev.gapSoundPreset || this._autoGapPreset(ev);
      if (preset) return this._playPreset('gapPass', preset, ctx, dest, t0, ev, pan, step);
      return false;
    }
    if (ev.gapSoundMode === 'upload') {
      const assetId = ev.gapSoundAssetId || '';
      const volume = ev.gapSoundVolume != null ? ev.gapSoundVolume : 1;
      return this._playUploadedAsset(ctx, dest, t0, assetId, pan, volume);
    }
    return false;
  }

  // --- Named voice presets ------------------------------------------------
  //
  // Every voice is self-contained and context-agnostic so it runs identically
  // live and in the offline exporter. `step` is the melodic step derived from
  // the event's Y position; presets that care about pitch should use it via
  // `this._pickNote(step + N)` so they stay in key with the scenario.

  _buildVoiceMap() {
    this._voices = {
      bounce: {
        blip: (e, ctx, dest, t0, ev, pan, step) => {
          const f = e._midiToFreq(e._pickNote(step));
          e._blip(ctx, dest, t0, f, {
            pan, gain: 0.32, attack: 0.001, decay: 0.14, wave: 'triangle',
            detuneCents: (Math.random() - 0.5) * 14,
          });
        },
        click: (e, ctx, dest, t0, ev, pan) => {
          e._noise(ctx, dest, t0, { pan, decay: 0.05, gain: 0.38, lowpass: 3200 });
          e._blip(ctx, dest, t0, 1500, { pan, gain: 0.18, attack: 0.001, decay: 0.04, wave: 'square' });
        },
        thud: (e, ctx, dest, t0, ev, pan) => {
          e._blip(ctx, dest, t0, 95, { pan, gain: 0.55, attack: 0.001, decay: 0.22, wave: 'sine' });
          e._noise(ctx, dest, t0, { pan, decay: 0.08, gain: 0.12, lowpass: 400 });
        },
        chirp: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step + 5));
          e._sweep(ctx, dest, t0, {
            pan, startFreq: base, endFreq: base * 2.0, decay: 0.12, gain: 0.38,
          });
        },
        pop: (e, ctx, dest, t0, ev, pan, step) => {
          const f = e._midiToFreq(e._pickNote(step));
          e._blip(ctx, dest, t0, f * 1.5, { pan, gain: 0.28, attack: 0.001, decay: 0.08, wave: 'sine' });
          e._noise(ctx, dest, t0, { pan, decay: 0.06, gain: 0.25, lowpass: 1800 });
        },
        piano: (e, ctx, dest, t0, ev, pan, step) => {
          const f = e._midiToFreq(e._pickNote(step + 2));
          e._blip(ctx, dest, t0, f, {
            pan, gain: 0.28, attack: 0.002, decay: 0.30, wave: 'triangle',
          });
          e._blip(ctx, dest, t0 + 0.003, f * 2, {
            pan, gain: 0.09, attack: 0.001, decay: 0.16, wave: 'sine',
          });
          e._noise(ctx, dest, t0, {
            pan, decay: 0.035, gain: 0.018, lowpass: 2200,
          });
        },
        pianoRise: (e, ctx, dest, t0, ev, pan, step) => {
          const phrase = e._pianoRiseIndex++;
          const root = 72 + Math.min(12, Math.floor((phrase % 24) / 6) * 2);
          const offsets = [0, 4, 7, 12];
          const notes = [
            root + offsets[0],
            root + offsets[1],
            root + offsets[2 + (phrase % 2)],
          ];
          const baseGain = 0.125 + Math.min(0.045, (phrase % 8) * 0.006);
          notes.forEach((note, i) => {
            const f = e._midiToFreq(note);
            e._pianoTone(ctx, dest, t0 + i * 0.055, f, {
              pan,
              gain: baseGain * (i === 0 ? 0.95 : i === 1 ? 0.82 : 0.74),
              decay: 0.22 + i * 0.055,
              detuneCents: 0,
            });
          });
        },
        bell: (e, ctx, dest, t0, ev, pan, step) => {
          const f = e._midiToFreq(e._pickNote(step + 7));
          e._blip(ctx, dest, t0, f,     { pan, gain: 0.32, attack: 0.001, decay: 0.45, wave: 'sine' });
          e._blip(ctx, dest, t0, f * 2, { pan, gain: 0.14, attack: 0.003, decay: 0.35, wave: 'sine' });
          e._blip(ctx, dest, t0, f * 3, { pan, gain: 0.06, attack: 0.003, decay: 0.25, wave: 'sine' });
        },
        legendChime: (e, ctx, dest, t0, ev, pan) => {
          // Based on the reference clip: a loud retro chime centered around
          // A#/Bb4 (~466 Hz), with a detuned body and a bright arcade partial.
          const body = [
            { f: 466.2, g: 0.24, d: 0.46, w: 'sine', dt: 0.000 },
            { f: 456.7, g: 0.14, d: 0.42, w: 'sine', dt: 0.002 },
            { f: 430.0, g: 0.08, d: 0.36, w: 'triangle', dt: 0.004 },
            { f: 493.9, g: 0.08, d: 0.34, w: 'triangle', dt: 0.005 },
            { f: 932.4, g: 0.08, d: 0.25, w: 'sine', dt: 0.010 },
            { f: 1306.0, g: 0.055, d: 0.22, w: 'sine', dt: 0.014 },
          ];
          for (const p of body) {
            e._blip(ctx, dest, t0 + p.dt, p.f, {
              pan, gain: p.g, attack: 0.0015, decay: p.d, wave: p.w,
            });
          }
          e._noise(ctx, dest, t0, { pan, decay: 0.025, gain: 0.035, lowpass: 5200 });
          // Short slap echoes create the recognizable "old arcade cabinet"
          // bloom without needing an external sample.
          e._blip(ctx, dest, t0 + 0.085, 466.2, {
            pan, gain: 0.075, attack: 0.001, decay: 0.22, wave: 'sine',
          });
          e._blip(ctx, dest, t0 + 0.17, 466.2, {
            pan, gain: 0.035, attack: 0.001, decay: 0.18, wave: 'sine',
          });
        },
        soft: (e, ctx, dest, t0, ev, pan, step) => {
          const f = e._midiToFreq(e._pickNote(step));
          e._blip(ctx, dest, t0, f, { pan, gain: 0.22, attack: 0.012, decay: 0.28, wave: 'sine' });
        },
        laser: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step + 7));
          e._sweep(ctx, dest, t0, {
            pan, startFreq: base * 2, endFreq: base * 0.5, decay: 0.18, gain: 0.4,
          });
        },
        silent: () => {},
      },

      escape: {
        zap: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step + 3));
          e._sweep(ctx, dest, t0, {
            pan, startFreq: base, endFreq: base * 6, decay: 0.25, gain: 0.5,
          });
          e._noise(ctx, dest, t0, { pan, decay: 0.12, gain: 0.18, lowpass: 5000 });
        },
        boom: (e, ctx, dest, t0, ev, pan) => {
          const sub = ctx.createOscillator();
          sub.type = 'sine';
          sub.frequency.setValueAtTime(120, t0);
          sub.frequency.exponentialRampToValueAtTime(40, t0 + 0.45);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.6, t0 + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
          sub.connect(g); e._routeWithPan(ctx, dest, g, pan);
          sub.start(t0); sub.stop(t0 + 0.55);
          e._noise(ctx, dest, t0, { pan, decay: 0.35, gain: 0.2, lowpass: 250 });
        },
        chime: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step));
          const intervals = [0, 4, 7, 12];
          for (let i = 0; i < intervals.length; i++) {
            const f = base * Math.pow(2, intervals[i] / 12);
            e._blip(ctx, dest, t0 + i * 0.04, f, {
              pan, gain: 0.3, attack: 0.005, decay: 0.55, wave: 'sine',
            });
          }
        },
        whoosh: (e, ctx, dest, t0, ev, pan) => {
          const dur = 0.55;
          const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
          const data = buf.getChannelData(0);
          for (let i = 0; i < data.length; i++) {
            const env = Math.sin(Math.PI * i / data.length);
            data[i] = (Math.random() * 2 - 1) * env;
          }
          const src = ctx.createBufferSource(); src.buffer = buf;
          const filt = ctx.createBiquadFilter();
          filt.type = 'bandpass';
          filt.frequency.setValueAtTime(400, t0);
          filt.frequency.exponentialRampToValueAtTime(4500, t0 + dur);
          filt.Q.value = 3;
          const g = ctx.createGain(); g.gain.value = 0.5;
          src.connect(filt); filt.connect(g);
          e._routeWithPan(ctx, dest, g, pan);
          src.start(t0); src.stop(t0 + dur + 0.05);
        },
        riser: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step));
          e._sweep(ctx, dest, t0, {
            pan, startFreq: base * 0.5, endFreq: base * 4, decay: 1.1, gain: 0.45,
          });
          e._shimmer(ctx, dest, t0, 1.1);
        },
        silent: () => {},
      },

      destroy: {
        crunch: (e, ctx, dest, t0, ev, pan) => {
          e._noise(ctx, dest, t0, { pan, decay: 0.2, gain: 0.5, lowpass: 1600 });
          e._blip(ctx, dest, t0, 140, { pan, gain: 0.35, attack: 0.001, decay: 0.12, wave: 'square' });
        },
        glass: (e, ctx, dest, t0, ev, pan) => {
          e._noise(ctx, dest, t0, { pan, decay: 0.25, gain: 0.35, lowpass: 9000 });
          e._shimmer(ctx, dest, t0, 0.35);
          e._blip(ctx, dest, t0, 2200, { pan, gain: 0.2, attack: 0.001, decay: 0.08, wave: 'triangle' });
        },
        hollowEcho: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step + 7));
          e._hollowEcho(ctx, dest, t0, { pan, freq: base * 0.75, gain: 0.34 });
        },
        pop: (e, ctx, dest, t0, ev, pan, step) => {
          const f = e._midiToFreq(e._pickNote(step));
          e._blip(ctx, dest, t0, f * 1.5, { pan, gain: 0.42, attack: 0.001, decay: 0.08, wave: 'triangle' });
        },
        poof: (e, ctx, dest, t0, ev, pan) => {
          e._noise(ctx, dest, t0, { pan, decay: 0.22, gain: 0.32, lowpass: 900 });
        },
        explode: (e, ctx, dest, t0, ev, pan) => {
          e._noise(ctx, dest, t0, { pan, decay: 0.4, gain: 0.55, lowpass: 700 });
          const sub = ctx.createOscillator();
          sub.type = 'sine';
          sub.frequency.setValueAtTime(160, t0);
          sub.frequency.exponentialRampToValueAtTime(45, t0 + 0.35);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.55, t0 + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
          sub.connect(g); e._routeWithPan(ctx, dest, g, pan);
          sub.start(t0); sub.stop(t0 + 0.45);
        },
        silent: () => {},
      },

      freeze: {
        hollowEcho: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step + 7));
          e._hollowEcho(ctx, dest, t0, { pan, freq: base * 0.75, gain: 0.34 });
        },
        chime: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step + 7));
          e._blip(ctx, dest, t0,      base,       { pan, gain: 0.32, attack: 0.001, decay: 0.6,  wave: 'sine' });
          e._blip(ctx, dest, t0 + 0.05, base * 1.5, { pan, gain: 0.22, attack: 0.003, decay: 0.55, wave: 'sine' });
          e._blip(ctx, dest, t0 + 0.10, base * 2.0, { pan, gain: 0.14, attack: 0.003, decay: 0.45, wave: 'sine' });
        },
        thud: (e, ctx, dest, t0, ev, pan) => {
          e._blip(ctx, dest, t0, 80, { pan, gain: 0.55, attack: 0.001, decay: 0.35, wave: 'sine' });
          e._noise(ctx, dest, t0, { pan, decay: 0.1, gain: 0.12, lowpass: 300 });
        },
        crystal: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step + 14));
          e._blip(ctx, dest, t0, base, { pan, gain: 0.3, attack: 0.001, decay: 0.8, wave: 'sine' });
          e._shimmer(ctx, dest, t0, 0.8);
        },
        freezer: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step + 2));
          e._sweep(ctx, dest, t0, {
            pan, startFreq: base * 2.5, endFreq: base * 0.5, decay: 0.45, gain: 0.38,
          });
        },
        silent: () => {},
      },

      gapPass: {
        glass: (e, ctx, dest, t0, ev, pan) => {
          e._noise(ctx, dest, t0, { pan, decay: 0.22, gain: 0.32, lowpass: 9000 });
          e._shimmer(ctx, dest, t0, 0.28);
          e._blip(ctx, dest, t0, 1900, { pan, gain: 0.18, attack: 0.001, decay: 0.07, wave: 'triangle' });
        },
        burst: (e, ctx, dest, t0, ev, pan, step) => {
          const f = e._midiToFreq(e._pickNote(step - 2));
          e._blip(ctx, dest, t0, f, { pan, gain: 0.45, attack: 0.001, decay: 0.18, wave: 'sawtooth' });
          e._noise(ctx, dest, t0, { pan, decay: 0.16, gain: 0.22, lowpass: 1000 });
        },
        burn: (e, ctx, dest, t0, ev, pan, step) => {
          const base = e._midiToFreq(e._pickNote(step));
          e._sweep(ctx, dest, t0, {
            pan, startFreq: base * 0.8, endFreq: base * 2.6, decay: 0.38, gain: 0.42,
          });
          e._noise(ctx, dest, t0, { pan, decay: 0.18, gain: 0.16, lowpass: 2600 });
        },
        whoosh: (e, ctx, dest, t0, ev, pan) => {
          e._voices.escape.whoosh(e, ctx, dest, t0, ev, pan, 0);
        },
        zap: (e, ctx, dest, t0, ev, pan, step) => {
          e._voices.escape.zap(e, ctx, dest, t0, ev, pan, step);
        },
        explode: (e, ctx, dest, t0, ev, pan) => {
          e._voices.destroy.explode(e, ctx, dest, t0, ev, pan, 0);
        },
        silent: () => {},
      },
    };
  }

  _playPreset(kind, name, ctx, dest, t0, ev, pan, step) {
    const group = this._voices[kind];
    if (!group) return false;
    const fn = group[name];
    if (typeof fn !== 'function') return false;
    fn(this, ctx, dest, t0, ev, pan, step);
    return true;
  }

  // --- Event -> voice mapping ---------------------------------------------

  // Schedule all voices for a single tick's worth of events starting at `t0`.
  // `throttleMap` is a `Map<type, lastPlayTime>` that the caller owns so the
  // live context and an offline render keep independent throttle state.
  _dispatchEvents(ctx, dest, t0, events, W, H, throttleMap) {
    if (!events || events.length === 0) return;
    const throttle = (type, minGap) => {
      const last = throttleMap.get(type);
      if (last != null && t0 - last < minGap) return false;
      throttleMap.set(type, t0);
      return true;
    };

    let bouncePlayed = 0;
    for (const ev of events) {
      const pan = ev.x != null ? Math.max(-1, Math.min(1, (ev.x / W) * 2 - 1)) : 0;
      const yNorm = ev.y != null ? 1 - Math.max(0, Math.min(1, ev.y / H)) : 0.5;
      const step = Math.round(yNorm * 10) - 3;

      switch (ev.type) {
        case 'bounce': {
          // Per-ball override takes priority over the scenario melody and
          // default bounce voice. 'silent' cleanly mutes this ball's hits.
          const override = ev.bounceSound || '';
          if (override) {
            if (ev.bounceSoundOn === 'ballBall' && ev.source !== 'ballBall' && ev.source !== 'fixedBall') break;
            if (String(override).startsWith('asset:')) {
              this._playUploadedAsset(ctx, dest, t0, String(override).slice(6), pan, 1);
              break;
            }
            if (bouncePlayed < 3 || throttle('bounce', 0.045)) {
              this._playPreset('bounce', override, ctx, dest, t0, ev,
                               pan, step + bouncePlayed);
              if (bouncePlayed < 3) bouncePlayed++;
            }
            break;
          }
          if (this._playMelodyBounce(ctx, dest, t0, ev, pan, throttle)) break;
          if (bouncePlayed < 3) {
            const freq = this._midiToFreq(this._pickNote(step + bouncePlayed));
            this._blip(ctx, dest, t0, freq, {
              pan, gain: 0.32, attack: 0.001, decay: 0.14,
              wave: 'triangle',
              detuneCents: (Math.random() - 0.5) * 14,
            });
            bouncePlayed++;
          } else if (throttle('bounce', 0.045)) {
            const freq = this._midiToFreq(this._pickNote(step));
            this._blip(ctx, dest, t0, freq, {
              pan, gain: 0.28, attack: 0.001, decay: 0.12, wave: 'triangle',
            });
          }
          break;
        }
        case 'heartEat': {
          const sound = ev.heartSound || 'pop';
          if (String(sound).startsWith('asset:')) {
            this._playUploadedAsset(ctx, dest, t0, String(sound).slice(6), pan, 1);
          } else if (sound && sound !== 'silent') {
            this._playPreset('bounce', sound, ctx, dest, t0, ev, pan, step);
          }
          break;
        }
        case 'freeze': {
          const override = ev.deathSound || '';
          if (String(override).startsWith('asset:')) {
            this._playUploadedAsset(ctx, dest, t0, String(override).slice(6), pan, 1);
            break;
          }
          if (!throttle('freeze', 0.05)) break;
          if (override && this._playPreset('freeze', override, ctx, dest, t0, ev, pan, step)) break;
          const base = this._midiToFreq(this._pickNote(step + 7));
          this._blip(ctx, dest, t0, base, {
            pan, gain: 0.3, attack: 0.001, decay: 0.42, wave: 'sine',
          });
          // Second chime partial 40ms later for a chime-like bloom.
          const t2 = t0 + 0.04;
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = base * 1.5;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t2);
          g.gain.exponentialRampToValueAtTime(0.22, t2 + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.55);
          osc.connect(g);
          this._routeWithPan(ctx, dest, g, pan);
          osc.start(t2);
          osc.stop(t2 + 0.6);
          break;
        }
        case 'destroy': {
          if (!throttle('destroy', 0.05)) break;
          if (this._playConfiguredGapSound(ctx, dest, t0, ev, pan, step)) break;
          const override = ev.destroySound || '';
          if (String(override).startsWith('asset:')) {
            this._playUploadedAsset(ctx, dest, t0, String(override).slice(6), pan, 1);
            break;
          }
          if (override && this._playPreset('destroy', override, ctx, dest, t0, ev, pan, step)) break;
          const freq = this._midiToFreq(this._pickNote(step - 7));
          this._blip(ctx, dest, t0, freq, {
            pan, gain: 0.45, attack: 0.001, decay: 0.22, wave: 'sawtooth',
          });
          this._noise(ctx, dest, t0, { pan, decay: 0.14, gain: 0.22, lowpass: 900 });
          break;
        }
        case 'escape': {
          if (!throttle('escape', 0.25)) break;
          if (this._playConfiguredGapSound(ctx, dest, t0, ev, pan, step)) break;
          const override = ev.escapeSound || '';
          if (String(override).startsWith('asset:')) {
            this._playUploadedAsset(ctx, dest, t0, String(override).slice(6), pan, 1);
            break;
          }
          if (override && this._playPreset('escape', override, ctx, dest, t0, ev, pan, step)) break;
          const base = this._midiToFreq(this._pickNote(step));
          this._sweep(ctx, dest, t0, {
            pan, startFreq: base, endFreq: base * 4, decay: 0.7, gain: 0.5,
          });
          break;
        }
        case 'gapPass': {
          if (!throttle('gapPass', 0.06)) break;
          if (this._playConfiguredGapSound(ctx, dest, t0, ev, pan, step)) break;
          this._playPreset('gapPass', this._autoGapPreset(ev), ctx, dest, t0, ev, pan, step);
          break;
        }
        case 'spawn': {
          if (!throttle('spawn', 0.04)) break;
          const freq = this._midiToFreq(this._pickNote(step + 2));
          this._blip(ctx, dest, t0, freq, {
            pan, gain: 0.22, attack: 0.001, decay: 0.12, wave: 'sine',
          });
          break;
        }
        default:
          break;
      }
    }
  }

  _dispatchFanfare(ctx, dest, t0, pan = 0) {
    const steps    = [0,    4,    7,    12,   16,   19,   24];
    const offsets  = [0.00, 0.07, 0.14, 0.22, 0.33, 0.44, 0.58];
    const rootFreq = this._midiToFreq(60);

    for (let i = 0; i < steps.length; i++) {
      const freq  = rootFreq * Math.pow(2, steps[i] / 12);
      const start = t0 + offsets[i];
      const decay = 0.55 + i * 0.05;
      const body  = Math.max(0.15, 0.38 - i * 0.02);
      this._blip(ctx, dest, start, freq, {
        pan, gain: body, attack: 0.012, decay, wave: 'triangle',
      });
      this._blip(ctx, dest, start, freq * 2, {
        pan, gain: body * 0.45, attack: 0.012, decay: decay * 0.7, wave: 'sine',
      });
    }

    // Sub-bass boom that drops an octave.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(rootFreq * 0.5, t0);
    sub.frequency.exponentialRampToValueAtTime(rootFreq * 0.25, t0 + 0.55);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.0001, t0);
    subG.gain.exponentialRampToValueAtTime(0.55, t0 + 0.015);
    subG.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.85);
    sub.connect(subG);
    this._routeWithPan(ctx, dest, subG, 0);
    sub.start(t0);
    sub.stop(t0 + 0.9);

    // High shimmer wash on top.
    this._shimmer(ctx, dest, t0, 1.25);
  }

  // --- Public live API ----------------------------------------------------

  handleEvents(events, W = 1080, H = 1920) {
    if (!this._ready || !this.enabled || !events || events.length === 0) return;
    this._dispatchEvents(
      this.ctx, this.master, this.ctx.currentTime, events, W, H, this._lastPlay,
    );
  }

  playWinFanfare(pan = 0) {
    if (!this._ready || !this.enabled) return;
    const now = this.ctx.currentTime;
    const last = this._lastPlay.get('fanfare');
    if (last != null && now - last < 2.0) return;
    this._lastPlay.set('fanfare', now);
    this._dispatchFanfare(this.ctx, this.master, now, pan);
  }

  // Fire a single event-sound preset on demand for the UI inspector.
  // `kind` is 'bounce'|'escape'|'destroy'|'freeze'; `name` is a registry key
  // (e.g. 'chirp'). Empty/unknown names play the default behavior for that
  // kind so the user can preview what a blank dropdown will sound like.
  async previewEventSound(kind, name, options = {}) {
    this.ensureReady();
    if (!this._ready) return;
    this.stopPreview();
    if (typeof name === 'string' && name.startsWith('asset:')) {
      await this._ensureLiveAssetBuffer(name.slice(6));
    }
    if (options.gapSoundMode === 'upload' && options.gapSoundAssetId) {
      await this._ensureLiveAssetBuffer(options.gapSoundAssetId);
    }
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.03;
    const W = 1080, H = 1920;
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.master);
    const preview = { bus, timers: [] };
    this._preview = preview;
    const ev = { x: W / 2, y: H / 2, type: kind };
    if (kind === 'bounce')  ev.bounceSound  = name || '';
    if (kind === 'escape')  ev.escapeSound  = name || '';
    if (kind === 'destroy') ev.destroySound = name || '';
    if (kind === 'freeze')  ev.deathSound   = name || '';
    if (kind === 'gapPass') {
      ev.gapOutcome = options.gapOutcome || 'shatter';
      ev.gapSoundMode = options.gapSoundMode || (options.gapSoundAssetId ? 'upload' : 'preset');
      ev.gapSoundPreset = name || options.gapSoundPreset || '';
      ev.gapSoundAssetId = options.gapSoundAssetId || '';
      ev.gapSoundVolume = options.gapSoundVolume != null ? options.gapSoundVolume : 1;
    }
    // Use a fresh throttle map so rapid preview clicks aren't swallowed.
    this._dispatchEvents(ctx, bus, t0, [ev], W, H, new Map());
    const maxPreviewSec = options.maxPreviewSec != null ? options.maxPreviewSec : 3.0;
    preview.timers.push(setTimeout(() => {
      if (this._preview === preview) this.stopPreview();
    }, Math.max(0.25, maxPreviewSec) * 1000));
    return preview;
  }

  // Play a melody straight through for editor preview. `onNote(index)` fires
  // at each note's scheduled start time so the UI can highlight the chip
  // currently sounding. `onDone()` fires shortly after the last note decays.
  previewMelody(melodyCfg, { onNote, onDone, gapSec = 0.28 } = {}) {
    this.ensureReady();
    if (!this._ready) return null;
    const notes = melodyCfg && Array.isArray(melodyCfg.notes) ? melodyCfg.notes : [];
    if (!notes.length) return null;

    // Cancel any previous preview so two clicks don't stack.
    this.stopPreview();

    const ctx = this.ctx;
    // Isolated gain so stopPreview() can silence this burst without touching
    // the main program master.
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.master);

    const wave = melodyCfg.wave || 'triangle';
    const gain = melodyCfg.gain != null ? melodyCfg.gain : 0.34;
    const decay = melodyCfg.decay != null ? melodyCfg.decay : 0.22;

    const startTime = ctx.currentTime + 0.05;
    const timers = [];
    for (let i = 0; i < notes.length; i++) {
      const t = startTime + i * gapSec;
      const freq = this._midiToFreq(notes[i]);
      this._blip(ctx, bus, t, freq, {
        pan: 0, gain, attack: 0.002, decay, wave,
      });
      if (typeof onNote === 'function') {
        const delay = Math.max(0, (t - ctx.currentTime) * 1000);
        timers.push(setTimeout(() => onNote(i), delay));
      }
    }
    if (typeof onDone === 'function') {
      const total = (notes.length - 1) * gapSec + decay + 0.1;
      timers.push(setTimeout(onDone, total * 1000));
    }

    this._preview = { bus, timers };
    return this._preview;
  }

  stopPreview() {
    const p = this._preview;
    if (!p) return;
    this._preview = null;
    for (const id of p.timers) clearTimeout(id);
    if (p.bus && this.ctx) {
      try {
        p.bus.gain.cancelScheduledValues(this.ctx.currentTime);
        p.bus.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.01);
        setTimeout(() => { try { p.bus.disconnect(); } catch (_) {} }, 80);
      } catch (_) { /* noop */ }
    }
  }

  // --- Offline render for MP4 export --------------------------------------

  // Render all collected events + fanfare triggers into an AudioBuffer whose
  // timeline matches the exported video exactly. Returns null if offline
  // audio isn't supported by the browser.
  //
  //   timedEvents:  Array<{ time: secondsFromStart, events: Array<SimEvent> }>
  //   fanfareCalls: Array<{ time: secondsFromStart, pan?: number }>
  //   durationSec:  total video duration in seconds
  async renderOffline({
    timedEvents = [], fanfareCalls = [],
    durationSec = 0, W = 1080, H = 1920, sampleRate = 48000,
  } = {}) {
    const OCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OCtx) return null;

    // Add a little tail so the last fanfare / shimmer has room to decay
    // without being cut off.
    const totalSec = Math.max(0.1, durationSec + 1.5);
    const frames = Math.ceil(totalSec * sampleRate);
    const offline = new OCtx(2, frames, sampleRate);
    // Export should never go fully silent just because the live preview was
    // muted or its volume slider was dragged to zero.
    const offlineVolume = this.volume > 0.001 ? this.volume : 0.35;
    const { master } = this._buildMasterChain(offline, offlineVolume);
    const savedMelodyIndex = this._melodyIndex;
    const savedAssetBuffers = this._activeAssetBuffers;
    const savedAssetPlaybackWindows = this._assetPlaybackWindows;
    this.resetTimelineState();

    const assetIds = new Set();
    for (const entry of timedEvents) {
      for (const ev of entry.events || []) {
        if (ev && ev.gapSoundMode === 'upload' && ev.gapSoundAssetId) assetIds.add(ev.gapSoundAssetId);
        for (const key of ['bounceSound', 'escapeSound', 'destroySound', 'deathSound', 'heartSound']) {
          if (ev && typeof ev[key] === 'string' && ev[key].startsWith('asset:')) {
            assetIds.add(ev[key].slice(6));
          }
        }
      }
    }
    const offlineAssetBuffers = new Map();
    for (const assetId of assetIds) {
      const buffer = await this._decodeAssetForContext(offline, assetId);
      if (buffer) offlineAssetBuffers.set(assetId, buffer);
    }
    this._activeAssetBuffers = offlineAssetBuffers;

    const throttle = new Map();

    for (const entry of timedEvents) {
      const t = Math.max(0, entry.time || 0);
      this._dispatchEvents(offline, master, t, entry.events, W, H, throttle);
    }

    for (const entry of fanfareCalls) {
      const t = Math.max(0, entry.time || 0);
      const last = throttle.get('fanfare');
      if (last != null && t - last < 2.0) continue;
      throttle.set('fanfare', t);
      this._dispatchFanfare(offline, master, t, entry.pan || 0);
    }

    const rendered = await offline.startRendering();
    this._melodyIndex = savedMelodyIndex;
    this._activeAssetBuffers = savedAssetBuffers;
    this._assetPlaybackWindows = savedAssetPlaybackWindows;
    return rendered;
  }
}

window.AudioEngine = AudioEngine;
