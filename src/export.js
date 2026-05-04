// Background (headless) video export.
//
// Design principle: **never use wall-clock capture**. We step the simulation
// forward one physics tick at a time, render each tick into an *offscreen*
// canvas, and feed those frames directly into a WebCodecs `VideoEncoder`.
// The encoded MP4 ends up frame-accurate at whatever fps we pick, regardless
// of how slow a single frame is to compute. A 5-second heavy explosion that
// would stutter a live MediaRecorder capture encodes into a buttery 5s of
// 60fps MP4 because the timestamps are based on frame index, not wall time.
//
// The exporter uses:
//   - its own *offscreen* <canvas> (never shown on screen),
//   - its own fresh `Renderer` (separate particle pool + flash/popup state),
//   - its own fresh `EventEngine` bound to that renderer (so shatter/flash/
//     slowmo happen inside the export, not against the live UI renderer).
//
// Per-scenario `endCondition` governs when to stop recording:
//   - { type: 'loopDuration' }         one full loop (Satisfying mode)
//   - { type: 'fixed',  seconds: N }   fixed number of seconds
//   - { type: 'firstEscapeTail', tail } stop `tail` s after the first escape
//                                       event (use for "1 HP to Escape" so
//                                       the shatter+flash finish on-screen)
//   - { type: 'allBallsGone', tail }   stop `tail` s after every ball is gone
//   - { type: 'ballCountTail', count, tail }
//                                      stop `tail` s after alive balls drop to
//                                      `count` or lower
//
// Export runs until the scenario's end condition is met, or until the user
// explicitly stops the render from the UI.

function makeExportCancelledError() {
  const err = new Error('Render stopped');
  err.name = 'ExportCancelledError';
  return err;
}

function throwIfExportCancelled(shouldCancel) {
  if (shouldCancel && shouldCancel()) throw makeExportCancelledError();
}

class ExportManager {
  constructor(simulator, audioEngine = null, options = {}) {
    const simSnapshot = simulator && typeof simulator.createSnapshot === 'function'
      ? simulator.createSnapshot()
      : null;
    this.simulator = simSnapshot ? Simulator.fromSnapshot(simSnapshot) : simulator;
    this.audioEngine = audioEngine && typeof audioEngine.createExportClone === 'function'
      ? audioEngine.createExportClone()
      : audioEngine;
    this._eventsSnapshot = options.eventsSnapshot
      ? JSON.parse(JSON.stringify(options.eventsSnapshot))
      : null;
    this._rendererSnapshot = options.rendererSnapshot
      ? JSON.parse(JSON.stringify(options.rendererSnapshot))
      : null;
  }

  _logExport(stage, details = null, level = 'log') {
    const ts = new Date().toISOString();
    const prefix = `[export ${ts}] ${stage}`;
    const fn = console[level] || console.log;
    if (details == null) fn(prefix);
    else fn(prefix, details);
  }

  _exportDiagnostics(extra = {}) {
    const memory = performance && performance.memory ? {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
    } : null;
    return {
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      online: navigator.onLine,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      memory,
      ...extra,
    };
  }

  _summarizeEvents(events) {
    const counts = {};
    for (const ev of events || []) {
      const key = ev && ev.type ? ev.type : 'unknown';
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  _summarizeObjects(state) {
    const objects = state && Array.isArray(state.objects) ? state.objects : [];
    const counts = {};
    let aliveBalls = 0;
    for (const o of objects) {
      const type = o && o.type ? o.type : 'unknown';
      counts[type] = (counts[type] || 0) + 1;
      if (type === 'ball' && o.alive && !o._escaped && !o._frozen && !o.fixed) aliveBalls++;
    }
    return {
      total: objects.length,
      counts,
      aliveBalls,
      finished: !!(state && state._finished),
      finishTail: state && state._finishTail,
    };
  }

  // ---------------------------------------------------------------
  // Shared setup: create an isolated render pipeline for the export
  // ---------------------------------------------------------------
  // `audioSink` (optional) lets the caller collect audio triggers fired by
  // the EventEngine (e.g. the "shatter" action's win fanfare) so they can be
  // re-scheduled later into an OfflineAudioContext. The sink exposes a
  // `videoTime` setter used to timestamp each recorded call.
  _makePipeline({ audioSink = null } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1920;
    const renderer = new Renderer(canvas);

    const speedState = { override: null, paused: false };
    const fakeApp = {
      renderer,
      simulator: this.simulator,
      // Match live behavior: freeze simulation immediately, but keep rendering
      // subsequent frames so finish particles / popup / flash can play out.
      pause: () => { speedState.paused = true; },
      triggerSlowmo: (factor, seconds) => {
        speedState.override = { factor, life: seconds };
      },
      // Stub audio interface. During export we never want to touch the live
      // AudioContext (that would mix export audio into the user's speakers
      // while the progress bar is showing), but we do want to capture WHAT
      // would have played so we can bake it into the MP4 later.
      audio: audioSink ? {
        playWinFanfare: (pan = 0) => {
          audioSink.fanfareCalls.push({ time: audioSink.currentTime, pan });
        },
      } : null,
    };
    const events = new EventEngine(fakeApp);
    events.setRules(this.simulator.scenario.events || []);
    if (this._eventsSnapshot && typeof events.applySnapshot === 'function') {
      events.applySnapshot(this._eventsSnapshot);
    }
    if (this._rendererSnapshot && typeof renderer.applySnapshot === 'function') {
      renderer.applySnapshot(this._rendererSnapshot);
    }
    return { canvas, renderer, events, speedState };
  }

  // Builds a predicate that, given (frameIndex, events, aliveCount), returns
  // 'stop' when we should stop encoding.
  _makeStopper(fps) {
    const sc = this.simulator.scenario;
    const ec = sc.endCondition || null;

    // Fallback seconds if we've no structured endCondition.
    const fallback = sc.satisfying ? (sc.loopDuration || 10) : (sc.duration || 12);
    const withFinishStop = (base) => {
      let finishAt = -1;
      let finishTailFrames = 0;
      return {
        describe: base.describe,
        fn: (i, events, alive) => {
          if (finishAt < 0) {
            const finishEvent = Array.isArray(events) ? events.find((e) => e && e.type === 'finish') : null;
            const finishedState = !!(this.simulator && this.simulator.state && this.simulator.state._finished);
            if (finishEvent || finishedState) {
              finishAt = i;
              const tail = finishEvent
                ? finishEvent.tail
                : (this.simulator.state && this.simulator.state._finishTail);
              finishTailFrames = Math.max(0, Math.ceil(Math.max(0, Number(tail) || 0) * fps));
            }
          }
          if (finishAt >= 0 && (i - finishAt) >= finishTailFrames) return 'stop';
          return base.fn(i, events, alive);
        },
      };
    };

    if (!ec || ec.type === 'loopDuration') {
      const frames = Math.ceil((sc.loopDuration || fallback) * fps);
      return withFinishStop({ describe: `loop (${(sc.loopDuration || fallback).toFixed(1)}s)`,
               fn: (i) => i + 1 >= frames ? 'stop' : null });
    }
    if (ec.type === 'fixed') {
      const seconds = Math.max(0.5, ec.seconds || fallback);
      const frames = Math.ceil(seconds * fps);
      return withFinishStop({ describe: `fixed (${seconds.toFixed(1)}s)`,
               fn: (i) => i + 1 >= frames ? 'stop' : null });
    }
    if (ec.type === 'finish') {
      return withFinishStop({
        describe: 'after-finish (wait until finish or stop manually)',
        // For explicit finish-driven presets, never hard-stop on duration/export
        // caps. The user asked for render control without hard caps; the Stop
        // Render button is the safety valve if a broken scenario never reaches
        // its finish trigger.
        fn: () => null,
      });
    }
    if (ec.type === 'firstEscapeTail') {
      const tailFrames = Math.ceil((ec.tail != null ? ec.tail : 2.5) * fps);
      let firstAt = -1;
      return withFinishStop({ describe: `after-first-escape (+${(tailFrames / fps).toFixed(1)}s)`,
               fn: (i, events) => {
                 if (firstAt < 0 && events.some((e) => e.type === 'escape')) firstAt = i;
                 if (firstAt >= 0 && (i - firstAt) >= tailFrames) return 'stop';
                 return null;
               } });
    }
    if (ec.type === 'allBallsGone') {
      const tailFrames = Math.ceil((ec.tail != null ? ec.tail : 1.0) * fps);
      let goneAt = -1;
      let seenAlive = false;
      return withFinishStop({ describe: `after-all-gone (+${(tailFrames / fps).toFixed(1)}s)`,
               fn: (i, events, alive) => {
                 if (alive > 0) seenAlive = true;
                 if (seenAlive && alive === 0 && goneAt < 0) goneAt = i;
                 if (goneAt >= 0 && (i - goneAt) >= tailFrames) return 'stop';
                 return null;
               } });
    }
    if (ec.type === 'ballCountTail') {
      const tailFrames = Math.ceil((ec.tail != null ? ec.tail : 1.0) * fps);
      const targetCount = Math.max(0, ec.count | 0);
      let hitAt = -1;
      return withFinishStop({ describe: `after-ball-count<=${targetCount} (+${(tailFrames / fps).toFixed(1)}s)`,
               fn: (i, _events, alive) => {
                 if (alive <= targetCount && hitAt < 0) hitAt = i;
                 if (hitAt >= 0 && (i - hitAt) >= tailFrames) return 'stop';
                 return null;
               } });
    }
    if (ec.type === 'bucketHitTail') {
      const tailFrames = Math.ceil((ec.tail != null ? ec.tail : 0) * fps);
      const bucketId = String(ec.bucketId || '');
      let hitAt = -1;
      return withFinishStop({ describe: `after-bucket-hit:${bucketId} (+${(tailFrames / fps).toFixed(1)}s)`,
               fn: (i, events) => {
                 if (hitAt < 0 && events.some((e) => e.type === 'score' && String(e.bucketId || '') === bucketId)) {
                   hitAt = i;
                 }
                 if (hitAt >= 0 && (i - hitAt) >= tailFrames) return 'stop';
                 return null;
               } });
    }
    // Unknown condition: fall back to fixed.
    const frames = Math.ceil(fallback * fps);
    return withFinishStop({ describe: `fallback (${fallback.toFixed(1)}s)`,
             fn: (i) => i + 1 >= frames ? 'stop' : null });
  }

  // Shared per-frame stepping logic used by every output format.
  // Returns true if we should stop AFTER rendering this frame.
  //
  // If `audioSink` is provided, every batch of sim events produced during
  // this frame is pushed to `audioSink.timedEvents` with a video-time
  // timestamp. The sink's `currentTime` field is also updated so anything
  // the EventEngine triggers (shatter -> fanfare, etc.) gets the right
  // timestamp when it calls into `fakeApp.audio`.
  _stepOneFrame(
    renderer, events, stopper, speedState, stopState,
    frameIdx, fps, dt, stepsPerFrame, accRef, audioSink = null,
  ) {
    const sim = this.simulator;
    const frameStartVideoTime = frameIdx / fps;
    if (audioSink) audioSink.currentTime = frameStartVideoTime;
    const shouldTraceFrame = frameIdx < 5 || frameIdx % 30 === 0;
    const frameStepStartedAt = performance.now();
    if (shouldTraceFrame) {
      this._logExport('stepOneFrame begin', this._exportDiagnostics({
        frameIdx,
        frameStartVideoTime: Number(frameStartVideoTime.toFixed(4)),
        fps,
        dt,
        stepsPerFrame,
        accBefore: accRef.value,
        speedPaused: speedState.paused,
        speedOverride: speedState.override,
        stopReached: stopState.reached,
        objects: this._summarizeObjects(sim.state),
        rendererTransientFx: renderer.hasActiveTransientFx(),
        particleCount: renderer.particles ? renderer.particles.length : null,
      }), 'debug');
    }

    let lastEvents = [];
    if (!stopState.reached && !speedState.paused) {
      let frameSpeed = 1.0;
      if (speedState.override) {
        frameSpeed = speedState.override.factor;
        speedState.override.life -= 1 / fps;
        if (speedState.override.life <= 0) speedState.override = null;
      }
      accRef.value += frameSpeed * stepsPerFrame;
      let subStep = 0;
      while (accRef.value >= 1) {
        const simStepStartedAt = performance.now();
        sim.step(dt);
        const simStepMs = performance.now() - simStepStartedAt;
        const evs = sim.lastEvents();
        const eventSummary = this._summarizeEvents(evs);
        const rendererEventsStartedAt = performance.now();
        renderer.handleEvents(evs);
        const rendererEventsMs = performance.now() - rendererEventsStartedAt;
        // Each sim tick within this frame gets a tiny sub-frame time offset so
        // rapid bursts (e.g. multiple spike touches in one frame) don't all
        // collapse onto the same millisecond - this keeps the offline audio
        // throttle behaving the same as it would live.
        const subTime = frameStartVideoTime + subStep * (frameSpeed / fps);
        if (audioSink) {
          audioSink.currentTime = subTime;
          if (evs.length > 0) {
            // Physics reuses a single mutable `events` array and clears it at the
            // start of every tick. Snapshot the event payload NOW, otherwise the
            // offline audio pass later sees a bunch of empty batches.
            audioSink.timedEvents.push({
              time: subTime,
              events: evs.map((ev) => ({ ...ev })),
            });
          }
        }
        const eventEngineStartedAt = performance.now();
        events.update(sim.state, evs);
        const eventEngineMs = performance.now() - eventEngineStartedAt;
        lastEvents = lastEvents.concat(evs);
        if (shouldTraceFrame || evs.length > 0 || simStepMs > 20 || eventEngineMs > 20) {
          this._logExport('physics substep complete', this._exportDiagnostics({
            frameIdx,
            subStep,
            subTime: Number(subTime.toFixed(4)),
            accBeforeDecrement: accRef.value,
            frameSpeed,
            simStepMs: Number(simStepMs.toFixed(2)),
            rendererEventsMs: Number(rendererEventsMs.toFixed(2)),
            eventEngineMs: Number(eventEngineMs.toFixed(2)),
            eventCount: evs.length,
            eventSummary,
            objects: this._summarizeObjects(sim.state),
            speedPaused: speedState.paused,
            speedOverride: speedState.override,
          }), evs.length > 0 ? 'log' : 'debug');
        }
        if (speedState.paused || (sim.state && sim.state._finished)) {
          accRef.value = 0;
          this._logExport('physics stepping stopped early', {
            frameIdx,
            subStep,
            speedPaused: speedState.paused,
            simFinished: !!(sim.state && sim.state._finished),
            events: eventSummary,
          }, 'warn');
          break;
        }
        accRef.value -= 1;
        subStep++;
      }
    }

    // Particles and flash/popup animate in video-time.
    const particlesStartedAt = performance.now();
    renderer.stepParticles(1 / fps);
    const particlesMs = performance.now() - particlesStartedAt;
    const renderStartedAt = performance.now();
    renderer.render(sim.state, {
      overlay: sim.scenario.overlay,
      visuals: sim.scenario.visuals,
      softMode: !!sim.scenario.satisfying,
    });
    const renderMs = performance.now() - renderStartedAt;
    const alive = sim.state.objects.filter((o) =>
      o.type === 'ball' && o.alive && !o._escaped && !o._frozen && !o.fixed
    ).length;
    if (!stopState.reached && stopper.fn(frameIdx, lastEvents, alive) === 'stop') {
      stopState.reached = true;
      this._logExport('stopper returned stop', {
        frameIdx,
        stopper: stopper.describe,
        alive,
        lastEventSummary: this._summarizeEvents(lastEvents),
        activeTransientFx: renderer.hasActiveTransientFx(),
      }, 'warn');
    }
    if (shouldTraceFrame || renderMs > 25 || particlesMs > 10 || lastEvents.length > 0) {
      this._logExport('stepOneFrame render complete', this._exportDiagnostics({
        frameIdx,
        particlesMs: Number(particlesMs.toFixed(2)),
        renderMs: Number(renderMs.toFixed(2)),
        totalStepOneFrameMs: Number((performance.now() - frameStepStartedAt).toFixed(2)),
        alive,
        accAfter: accRef.value,
        lastEventSummary: this._summarizeEvents(lastEvents),
        stopReached: stopState.reached,
        activeTransientFx: renderer.hasActiveTransientFx(),
        particleCount: renderer.particles ? renderer.particles.length : null,
      }), renderMs > 25 ? 'warn' : 'debug');
    }
    if (!stopState.reached) return false;
    return !renderer.hasActiveTransientFx();
  }

  _waitForEncoderDequeue(encoder, timeoutMs = 50) {
    this._logExport('waiting for encoder dequeue event', {
      timeoutMs,
      encodeQueueSize: encoder && encoder.encodeQueueSize,
    }, 'debug');
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer != null) clearTimeout(timer);
        if (encoder && typeof encoder.removeEventListener === 'function') {
          try { encoder.removeEventListener('dequeue', finish); } catch (_) { /* ignore */ }
        }
        resolve();
      };
      timer = setTimeout(finish, timeoutMs);
      if (encoder && typeof encoder.addEventListener === 'function') {
        try { encoder.addEventListener('dequeue', finish, { once: true }); } catch (_) { /* timeout fallback */ }
      }
    });
  }

  async _waitForVideoEncoderBackpressure(
    encoder,
    maxQueueSize,
    { shouldCancel, getError, onStatus } = {},
  ) {
    if (!encoder || typeof encoder.encodeQueueSize !== 'number') return;

    let lastQueueSize = encoder.encodeQueueSize;
    let lastQueueChangeAt = performance.now();
    let lastStatusAt = 0;
    this._logExport('video encoder backpressure started', {
      queueSize: encoder.encodeQueueSize,
      targetQueueSize: maxQueueSize,
    }, 'warn');
    while (typeof encoder.encodeQueueSize === 'number'
           && encoder.encodeQueueSize > maxQueueSize) {
      throwIfExportCancelled(shouldCancel);
      const err = getError && getError();
      if (err) throw err;

      const now = performance.now();
      const queueSize = encoder.encodeQueueSize;
      if (queueSize !== lastQueueSize) {
        this._logExport('video encoder queue changed', {
          from: lastQueueSize,
          to: queueSize,
          targetQueueSize: maxQueueSize,
        }, 'debug');
        lastQueueSize = queueSize;
        lastQueueChangeAt = now;
      } else if (now - lastQueueChangeAt > 30000) {
        this._logExport('video encoder queue stalled', {
          queueSize,
          targetQueueSize: maxQueueSize,
          stalledMs: Math.round(now - lastQueueChangeAt),
        }, 'error');
        throw new Error(
          `Video encoder stalled with ${queueSize} frames queued. `
          + 'Try Chrome/Edge updated, keep the tab active, or use PNG frames on this PC.',
        );
      }

      if (onStatus && now - lastStatusAt > 1000) {
        onStatus(`Waiting for video encoder (${queueSize} queued)…`);
        lastStatusAt = now;
      }
      await this._waitForEncoderDequeue(encoder);
    }
    this._logExport('video encoder backpressure cleared', {
      queueSize: encoder.encodeQueueSize,
      targetQueueSize: maxQueueSize,
    }, 'warn');
  }

  // -------------------------
  // MP4 via WebCodecs + mp4-muxer
  // -------------------------
  async exportMP4({ fps = 60, onProgress, onStatus, shouldCancel } = {}) {
    this._logExport('MP4 export requested', this._exportDiagnostics({
      fps,
      userAgent: navigator.userAgent,
    }));
    const logVisibilityChange = () => {
      this._logExport('document visibility changed during MP4 export', this._exportDiagnostics(), 'warn');
    };
    const logPageHide = (event) => {
      this._logExport('pagehide during MP4 export', this._exportDiagnostics({
        persisted: event && event.persisted,
      }), 'warn');
    };
    const logPageShow = (event) => {
      this._logExport('pageshow during MP4 export', this._exportDiagnostics({
        persisted: event && event.persisted,
      }), 'warn');
    };
    const logFreeze = () => {
      this._logExport('page freeze during MP4 export', this._exportDiagnostics(), 'warn');
    };
    const logResume = () => {
      this._logExport('page resume during MP4 export', this._exportDiagnostics(), 'warn');
    };
    document.addEventListener('visibilitychange', logVisibilityChange);
    window.addEventListener('pagehide', logPageHide);
    window.addEventListener('pageshow', logPageShow);
    document.addEventListener('freeze', logFreeze);
    document.addEventListener('resume', logResume);
    if (typeof window.VideoEncoder === 'undefined') {
      this._logExport('VideoEncoder missing', null, 'error');
      throw new Error('This browser lacks WebCodecs (VideoEncoder). Try Chrome/Edge or PNG frames.');
    }
    if (typeof window.Mp4Muxer === 'undefined') {
      this._logExport('mp4-muxer missing', null, 'error');
      throw new Error('mp4-muxer failed to load. Check network, then retry.');
    }

    const sim = this.simulator;
    const dt = window.PHYSICS_CONST.FIXED_DT;
    const stepsPerFrame = (1 / dt) / fps;

    // --- Detect codec availability ---------------------------------------
    const candidateCodecs = [
      'avc1.640032', 'avc1.4D0032', 'avc1.42E032', 'avc1.640028',
    ];
    let codec = null;
    for (const c of candidateCodecs) {
      try {
        this._logExport('checking video codec support', { codec: c }, 'debug');
        const sup = await window.VideoEncoder.isConfigSupported({
          codec: c, width: 1080, height: 1920, bitrate: 12_000_000, framerate: fps,
        });
        this._logExport('video codec support result', { codec: c, supported: !!(sup && sup.supported), config: sup && sup.config }, 'debug');
        if (sup && sup.supported) { codec = c; break; }
      } catch (e) {
        this._logExport('video codec support check failed', { codec: c, error: e && e.message ? e.message : String(e) }, 'warn');
      }
    }
    if (!codec) {
      this._logExport('no supported H.264 codec found', { candidateCodecs }, 'error');
      throw new Error('No H.264 config is supported by this browser.');
    }
    this._logExport('selected video codec', { codec, width: 1080, height: 1920, bitrate: 12_000_000, fps });

    // Probe audio support. We try AAC first (most compatible), falling back
    // to Opus. If neither works, we produce a silent MP4 and log WHY. All of
    // `AudioEncoder`, `AudioData` and `OfflineAudioContext` must be present
    // for any audio path to work.
    const AUDIO_SR = 48000;
    const AUDIO_CHANNELS = 2;
    const AUDIO_BITRATE = 128_000;
    const audioReason = [];
    if (!this.audioEngine) audioReason.push('no audio engine');
    if (typeof window.AudioEncoder === 'undefined') audioReason.push('no AudioEncoder');
    if (typeof window.AudioData === 'undefined') audioReason.push('no AudioData');
    if (typeof window.OfflineAudioContext === 'undefined'
        && typeof window.webkitOfflineAudioContext === 'undefined') {
      audioReason.push('no OfflineAudioContext');
    }

    // [ webcodecs codec string, mp4-muxer codec tag ]
    const audioCandidates = [
      ['mp4a.40.2', 'aac'],   // AAC-LC
      ['mp4a.40.5', 'aac'],   // HE-AAC
      ['opus',      'opus'],  // Opus (in MP4; playback varies by player)
    ];
    let audioEncCodec = null;
    let audioMuxCodec = null;
    if (audioReason.length === 0) {
      for (const [encCodec, muxCodec] of audioCandidates) {
        try {
          this._logExport('checking audio codec support', { encCodec, muxCodec }, 'debug');
          const sup = await window.AudioEncoder.isConfigSupported({
            codec: encCodec,
            sampleRate: AUDIO_SR,
            numberOfChannels: AUDIO_CHANNELS,
            bitrate: AUDIO_BITRATE,
          });
          if (sup && sup.supported) {
            audioEncCodec = encCodec;
            audioMuxCodec = muxCodec;
            break;
          }
        } catch (e) {
          this._logExport('audio codec support check failed', { encCodec, error: e && e.message ? e.message : String(e) }, 'warn');
          console.warn('[export] audio isConfigSupported failed for', encCodec, e);
        }
      }
      if (!audioEncCodec) audioReason.push('no supported audio codec (tried AAC-LC, HE-AAC, Opus)');
    }
    const canDoAudio = audioReason.length === 0 && !!audioEncCodec;
    console.info('[export] audio:',
      canDoAudio ? `enabled (${audioEncCodec} -> mp4/${audioMuxCodec})` : `disabled (${audioReason.join(', ')})`);
    this._logExport('audio export decision', {
      canDoAudio,
      audioEncCodec,
      audioMuxCodec,
      audioReason,
    });

    // --- Build muxer (with optional audio track) --------------------------
    const muxerOpts = {
      target: new window.Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: 1080, height: 1920, frameRate: fps },
      fastStart: 'in-memory',
    };
    if (canDoAudio) {
      muxerOpts.audio = {
        codec: audioMuxCodec,
        numberOfChannels: AUDIO_CHANNELS,
        sampleRate: AUDIO_SR,
      };
    }
    const muxer = new window.Mp4Muxer.Muxer(muxerOpts);
    this._logExport('mp4 muxer created', muxerOpts);

    // --- Video encoder ----------------------------------------------------
    let encoderError = null;
    const encoder = new window.VideoEncoder({
      output: (chunk, meta) => {
        this._logExport('video chunk output', {
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          byteLength: chunk.byteLength,
          queueSize: encoder.encodeQueueSize,
        }, 'debug');
        muxer.addVideoChunk(chunk, meta);
      },
      error: (e) => {
        encoderError = e;
        this._logExport('VideoEncoder error callback', {
          name: e && e.name,
          message: e && e.message,
          stack: e && e.stack,
        }, 'error');
        console.error('VideoEncoder error:', e);
      },
    });
    let encoderClosed = false;
    const closeEncoder = () => {
      if (encoderClosed) return;
      try { encoder.close(); } catch (_) { /* already closed */ }
      encoderClosed = true;
    };
    encoder.configure({
      codec, width: 1080, height: 1920, bitrate: 12_000_000, framerate: fps,
      avc: { format: 'avc' },
    });
    this._logExport('video encoder configured', {
      codec,
      width: 1080,
      height: 1920,
      bitrate: 12_000_000,
      fps,
      state: encoder.state,
    });

    // --- Audio collector sink (fed by the isolated EventEngine + sim) -----
    const audioSink = canDoAudio
      ? { timedEvents: [], fanfareCalls: [], currentTime: 0 }
      : null;

    const { canvas, renderer, events, speedState } = this._makePipeline({ audioSink });
    this._logExport('isolated export pipeline created', {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      eventRuleCount: this.simulator.scenario && this.simulator.scenario.events
        ? this.simulator.scenario.events.length
        : 0,
      seed: this.simulator.scenario && this.simulator.scenario.seed,
      scenarioName: this.simulator.scenario && this.simulator.scenario.name,
    });

    const stopper = this._makeStopper(fps);
    if (onStatus) onStatus('Rendering frames · ' + stopper.describe);
    this._logExport('frame rendering started', { stopper: stopper.describe });
    let result = null;
    let heartbeatTimer = null;
    let heartbeatFrameIdx = 0;
    let heartbeatLastTick = performance.now();
    try {
      const acc = { value: 0 };
      const stopState = { reached: false };
      let frameIdx = 0;
      const keyEvery = fps * 2;
      const maxEncoderQueueSize = 24;
      heartbeatTimer = setInterval(() => {
        const now = performance.now();
        this._logExport('MP4 export heartbeat', this._exportDiagnostics({
          frameIdx: heartbeatFrameIdx,
          seconds: Number((heartbeatFrameIdx / fps).toFixed(3)),
          msSincePreviousHeartbeat: Number((now - heartbeatLastTick).toFixed(2)),
          encoderState: encoder.state,
          encodeQueueSize: encoder.encodeQueueSize,
          encoderClosed,
          audioEventBatches: audioSink ? audioSink.timedEvents.length : null,
          fanfareCalls: audioSink ? audioSink.fanfareCalls.length : null,
          stopReached: stopState.reached,
        }), 'warn');
        heartbeatLastTick = now;
      }, 2000);
      while (true) {
        heartbeatFrameIdx = frameIdx;
        const loopStartedAt = performance.now();
        throwIfExportCancelled(shouldCancel);
        if (encoderError) throw encoderError;
        if (frameIdx === 0 || frameIdx % 10 === 0) {
          this._logExport('frame loop begin', this._exportDiagnostics({
            frameIdx,
            seconds: Number((frameIdx / fps).toFixed(3)),
            encodeQueueSize: encoder.encodeQueueSize,
            encoderState: encoder.state,
            simFinished: !!(sim.state && sim.state._finished),
            objectCount: sim.state && sim.state.objects ? sim.state.objects.length : null,
            particleCount: renderer.particles ? renderer.particles.length : null,
            acc: acc.value,
            stopReached: stopState.reached,
          }), 'debug');
        }
        const stepStartedAt = performance.now();
        const shouldStop = this._stepOneFrame(
          renderer, events, stopper, speedState, stopState,
          frameIdx, fps, dt, stepsPerFrame, acc, audioSink,
        );
        const stepMs = performance.now() - stepStartedAt;
        const frameTs = Math.round(frameIdx * 1_000_000 / fps);
        const nextFrameTs = Math.round((frameIdx + 1) * 1_000_000 / fps);
        const videoFrameStartedAt = performance.now();
        const frame = new window.VideoFrame(canvas, {
          // Use adjacent rounded timestamps so the encoded frame durations sum
          // exactly to the target timeline. A fixed rounded `duration` can make
          // some players interpret 60fps as tiny variable pacing.
          timestamp: frameTs,
          duration: nextFrameTs - frameTs,
        });
        const videoFrameMs = performance.now() - videoFrameStartedAt;
        const encodeStartedAt = performance.now();
        try {
          encoder.encode(frame, { keyFrame: frameIdx % keyEvery === 0 });
        } finally {
          frame.close();
        }
        const encodeCallMs = performance.now() - encodeStartedAt;
        frameIdx++;
        heartbeatFrameIdx = frameIdx;

        if (frameIdx === 1 || frameIdx % 10 === 0) {
          const objects = sim.state && sim.state.objects ? sim.state.objects : [];
          const aliveBalls = objects.filter((o) =>
            o.type === 'ball' && o.alive && !o._escaped && !o._frozen && !o.fixed
          ).length;
          this._logExport('frame encoded', this._exportDiagnostics({
            frameIdx,
            seconds: Number((frameIdx / fps).toFixed(3)),
            encodeQueueSize: encoder.encodeQueueSize,
            encoderState: encoder.state,
            shouldStop,
            stepMs: Number(stepMs.toFixed(2)),
            videoFrameMs: Number(videoFrameMs.toFixed(2)),
            encodeCallMs: Number(encodeCallMs.toFixed(2)),
            loopMs: Number((performance.now() - loopStartedAt).toFixed(2)),
            aliveBalls,
            objectCount: objects.length,
            particleCount: renderer.particles ? renderer.particles.length : null,
            audioEventBatches: audioSink ? audioSink.timedEvents.length : null,
            fanfareCalls: audioSink ? audioSink.fanfareCalls.length : null,
            stopReached: stopState.reached,
            speedPaused: speedState.paused,
            speedOverride: speedState.override,
          }));
        }
        if (shouldStop) {
          this._logExport('stop condition reached after frame encode', {
            frameIdx,
            seconds: Number((frameIdx / fps).toFixed(3)),
            stopper: stopper.describe,
            stopReached: stopState.reached,
            activeTransientFx: renderer.hasActiveTransientFx(),
            encodeQueueSize: encoder.encodeQueueSize,
          }, 'warn');
        }
        if (onProgress) onProgress(frameIdx);
        if (encoder.encodeQueueSize > maxEncoderQueueSize) {
          this._logExport('video encoder queue above threshold', {
            frameIdx,
            encodeQueueSize: encoder.encodeQueueSize,
            maxEncoderQueueSize,
          }, 'warn');
          await this._waitForVideoEncoderBackpressure(
            encoder,
            Math.floor(maxEncoderQueueSize / 2),
            {
              shouldCancel,
              getError: () => encoderError,
              onStatus: (s) => onStatus && onStatus(`${s} ${frameIdx} frames rendered`),
            },
          );
        } else if (frameIdx % 8 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
        throwIfExportCancelled(shouldCancel);

        if (shouldStop) break;
      }

      throwIfExportCancelled(shouldCancel);
      if (onStatus) onStatus(`Finalizing video (${frameIdx} frames)…`);
      this._logExport('frame rendering finished; draining encoder before flush', {
        frameIdx,
        seconds: Number((frameIdx / fps).toFixed(3)),
        encodeQueueSize: encoder.encodeQueueSize,
        encoderState: encoder.state,
      });
      await this._waitForVideoEncoderBackpressure(
        encoder,
        0,
        {
          shouldCancel,
          getError: () => encoderError,
          onStatus: (s) => onStatus && onStatus(`${s} finalizing`),
        },
      );
      this._logExport('calling video encoder flush', {
        encodeQueueSize: encoder.encodeQueueSize,
        encoderState: encoder.state,
      });
      const flushStartedAt = performance.now();
      await encoder.flush();
      this._logExport('video encoder flush resolved', {
        encodeQueueSize: encoder.encodeQueueSize,
        encoderState: encoder.state,
        flushMs: Number((performance.now() - flushStartedAt).toFixed(2)),
      });
      closeEncoder();
      this._logExport('video encoder closed');

      // --- Render and encode the audio track --------------------------------
      let audioCodecUsed = null;
      let audioChunkCount = 0;
      let audioFailReason = canDoAudio ? null : audioReason.join(', ');
      let audioPeak = 0;
      if (audioSink) {
        try {
          throwIfExportCancelled(shouldCancel);
          if (onStatus) onStatus('Rendering audio…');
          const durationSec = frameIdx / fps;
          this._logExport('audio offline render started', {
            durationSec,
            timedEventBatches: audioSink.timedEvents.length,
            fanfareCalls: audioSink.fanfareCalls.length,
          });
          console.info('[export] collected audio events:',
            audioSink.timedEvents.length, 'batches,',
            audioSink.fanfareCalls.length, 'fanfare call(s)');
          // Count individual events by type so we know bounces/escapes landed.
          const typeCounts = {};
          for (const b of audioSink.timedEvents) {
            for (const ev of (b.events || [])) {
              typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;
            }
          }
          console.info('[export] event type counts:', typeCounts);

          const audioBuffer = await this.audioEngine.renderOffline({
            timedEvents:  audioSink.timedEvents,
            fanfareCalls: audioSink.fanfareCalls,
            durationSec,
            sampleRate:   AUDIO_SR,
            W: 1080, H: 1920,
          });
          if (!audioBuffer) {
            this._logExport('audio offline render returned null', null, 'error');
            throw new Error('OfflineAudioContext render returned null');
          }

          // Compute peak amplitude across all channels. If this is ~0 the
          // OfflineAudioContext produced silence (audio engine bug) and the
          // MP4 was always going to be silent even if muxing worked.
          for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
            const d = audioBuffer.getChannelData(c);
            for (let i = 0; i < d.length; i += 256) {
              const a = Math.abs(d[i]);
              if (a > audioPeak) audioPeak = a;
            }
          }
          console.info('[export] audio rendered:',
            audioBuffer.length, 'samples @',
            audioBuffer.sampleRate, 'Hz,',
            audioBuffer.numberOfChannels, 'ch  · peak=',
            audioPeak.toFixed(4));
          this._logExport('audio offline render finished', {
            samples: audioBuffer.length,
            sampleRate: audioBuffer.sampleRate,
            channels: audioBuffer.numberOfChannels,
            peak: audioPeak,
          });

          if (audioPeak < 1e-4) {
            // Skip muxing a silent track — it would only confuse players.
            throw new Error(
              `offline render was silent (peak=${audioPeak.toFixed(6)}), `
              + `events=${audioSink.timedEvents.length}, `
              + `fanfare=${audioSink.fanfareCalls.length}`,
            );
          }

          throwIfExportCancelled(shouldCancel);
          if (onStatus) onStatus('Encoding audio (' + audioEncCodec + ')…');
          this._logExport('audio encoding started', {
            audioEncCodec,
            sampleRate: AUDIO_SR,
            channels: AUDIO_CHANNELS,
            bitrate: AUDIO_BITRATE,
          });
          audioChunkCount = await this._encodeAudioBufferToMuxer(
            audioBuffer, muxer,
            audioEncCodec, AUDIO_CHANNELS, AUDIO_SR, AUDIO_BITRATE,
            durationSec,
            shouldCancel,
          );
          audioCodecUsed = audioEncCodec;
          console.info('[export] audio muxed:', audioChunkCount, 'AAC/Opus chunks');
          this._logExport('audio encoding finished', {
            audioCodecUsed,
            audioChunkCount,
          });
          if (audioChunkCount === 0) {
            throw new Error('AudioEncoder produced 0 chunks');
          }
        } catch (e) {
          if (e && e.name === 'ExportCancelledError') throw e;
          // Loud failure: surface to the UI + console so the user can see WHY
          // the MP4 is silent and report back if needed.
          audioCodecUsed = null;
          audioFailReason = e && e.message ? e.message : String(e);
          this._logExport('audio export failed; continuing silent MP4', {
            error: audioFailReason,
            stack: e && e.stack,
          }, 'error');
          console.error('[export] Audio export failed:', e);
          if (onStatus) onStatus('⚠ audio skipped: ' + audioFailReason);
        }
      }

      this._logExport('finalizing mp4 muxer');
      muxer.finalize();
      this._logExport('mp4 muxer finalized', {
        byteLength: muxer.target.buffer && muxer.target.buffer.byteLength,
      });
      result = {
        blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
        frames: frameIdx,
        seconds: frameIdx / fps,
        mimeType: 'video/mp4',
        extension: 'mp4',
        codec,
        audioCodec: audioCodecUsed,
        audioFailReason,
        audioPeak,
      };
      this._logExport('MP4 export result ready', {
        frames: result.frames,
        seconds: result.seconds,
        blobSize: result.blob.size,
        codec: result.codec,
        audioCodec: result.audioCodec,
        audioFailReason: result.audioFailReason,
      });
    } finally {
      this._logExport('exportMP4 cleanup', {
        encoderClosed,
        encoderState: encoder && encoder.state,
      }, 'debug');
      if (heartbeatTimer != null) {
        clearInterval(heartbeatTimer);
        this._logExport('MP4 export heartbeat stopped', { heartbeatFrameIdx }, 'debug');
      }
      document.removeEventListener('visibilitychange', logVisibilityChange);
      window.removeEventListener('pagehide', logPageHide);
      window.removeEventListener('pageshow', logPageShow);
      document.removeEventListener('freeze', logFreeze);
      document.removeEventListener('resume', logResume);
      closeEncoder();
    }

    return result;
  }

  // Encode a Web Audio AudioBuffer (interleaved, 2ch) into a standard 16-bit
  // PCM WAV blob. Used as a diagnostic sidecar so the user can verify the
  // rendered audio independently of the MP4 muxer.
  _audioBufferToWavBlob(audioBuffer, durationSec) {
    const sampleRate = audioBuffer.sampleRate;
    const numCh = Math.min(2, audioBuffer.numberOfChannels);
    const totalFrames = Math.min(
      audioBuffer.length,
      Math.ceil(durationSec * sampleRate),
    );
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = numCh >= 2 ? audioBuffer.getChannelData(1) : ch0;

    const bytesPerSample = 2;
    const dataBytes = totalFrames * numCh * bytesPerSample;
    const buf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM subchunk size
    view.setUint16(20, 1, true);           // PCM format
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numCh * bytesPerSample, true);
    view.setUint16(32, numCh * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);

    let off = 44;
    for (let i = 0; i < totalFrames; i++) {
      for (let c = 0; c < numCh; c++) {
        const src = c === 0 ? ch0 : ch1;
        let s = src[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // Encode an already-rendered AudioBuffer into AAC frames and push them
  // into the mp4-muxer. We clip to the exact video duration so the audio
  // track doesn't run past the last visible frame (the AudioBuffer itself
  // has a small tail so the final fanfare can decay naturally, but we don't
  // want that tail in the final MP4).
  async _encodeAudioBufferToMuxer(
    audioBuffer, muxer, codec, numCh, sampleRate, bitrate, durationSec, shouldCancel = null,
  ) {
    this._logExport('AudioEncoder setup started', {
      codec,
      numCh,
      sampleRate,
      bitrate,
      durationSec,
      audioBufferLength: audioBuffer && audioBuffer.length,
      audioBufferChannels: audioBuffer && audioBuffer.numberOfChannels,
      audioBufferSampleRate: audioBuffer && audioBuffer.sampleRate,
    });
    let err = null;
    let chunkCount = 0;
    let firstMetaLogged = false;
    const enc = new window.AudioEncoder({
      output: (chunk, meta) => {
        if (chunkCount === 0 || chunkCount % 50 === 0) {
          this._logExport('audio chunk output', {
            nextChunkCount: chunkCount + 1,
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            byteLength: chunk.byteLength,
            encodeQueueSize: enc.encodeQueueSize,
          }, 'debug');
        }
        if (!firstMetaLogged) {
          firstMetaLogged = true;
          const dc = meta && meta.decoderConfig;
          console.info('[export] first audio chunk:',
            'byteLength=', chunk.byteLength,
            'type=', chunk.type,
            'timestamp=', chunk.timestamp,
            'decoderConfig=', dc ? {
              codec: dc.codec,
              sampleRate: dc.sampleRate,
              numberOfChannels: dc.numberOfChannels,
              descriptionBytes: dc.description
                ? (dc.description.byteLength ?? dc.description.length) : 0,
            } : '(none)');
        }
        try {
          muxer.addAudioChunk(chunk, meta);
          chunkCount++;
        } catch (e) {
          err = e;
          this._logExport('muxer.addAudioChunk failed', {
            message: e && e.message ? e.message : String(e),
            stack: e && e.stack,
            chunkCount,
          }, 'error');
          console.error('[export] muxer.addAudioChunk failed:', e);
        }
      },
      error: (e) => {
        err = e;
        this._logExport('AudioEncoder error callback', {
          name: e && e.name,
          message: e && e.message,
          stack: e && e.stack,
        }, 'error');
        console.error('[export] AudioEncoder error:', e);
      },
    });
    // Explicitly request raw AAC frames (not ADTS) — mp4-muxer expects the
    // raw elementary stream plus AudioSpecificConfig in meta.decoderConfig.
    const cfg = { codec, sampleRate, numberOfChannels: numCh, bitrate };
    if (codec && codec.startsWith('mp4a.')) cfg.aac = { format: 'aac' };
    enc.configure(cfg);
    this._logExport('AudioEncoder configured', {
      cfg,
      state: enc.state,
      encodeQueueSize: enc.encodeQueueSize,
    });

    const totalFrames = Math.min(
      audioBuffer.length,
      Math.ceil(durationSec * sampleRate),
    );
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels >= 2
      ? audioBuffer.getChannelData(1) : ch0;

    const chunkFrames = 1024; // AAC works with 1024-sample frames
    for (let start = 0; start < totalFrames; start += chunkFrames) {
      throwIfExportCancelled(shouldCancel);
      if (err) throw err;
      if (start === 0 || start % (chunkFrames * 64) === 0) {
        this._logExport('audio encode loop progress', {
          start,
          totalFrames,
          percent: Number(((start / Math.max(1, totalFrames)) * 100).toFixed(1)),
          encodeQueueSize: enc.encodeQueueSize,
          state: enc.state,
        }, 'debug');
      }
      const frames = Math.min(chunkFrames, totalFrames - start);
      // f32-planar layout: [L0..L(frames-1), R0..R(frames-1)]
      const planar = new Float32Array(frames * numCh);
      planar.set(ch0.subarray(start, start + frames), 0);
      if (numCh >= 2) planar.set(ch1.subarray(start, start + frames), frames);

      const ad = new window.AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: numCh,
        timestamp: Math.round(start * 1_000_000 / sampleRate),
        data: planar,
      });
      try {
        enc.encode(ad);
      } finally {
        ad.close();
      }
      if ((start / chunkFrames) % 32 === 0) {
        await new Promise((r) => setTimeout(r, 0));
        throwIfExportCancelled(shouldCancel);
      }
    }

    throwIfExportCancelled(shouldCancel);
    this._logExport('AudioEncoder flushing', {
      encodeQueueSize: enc.encodeQueueSize,
      state: enc.state,
      chunkCount,
    });
    const audioFlushStartedAt = performance.now();
    await enc.flush();
    this._logExport('AudioEncoder flush resolved', {
      encodeQueueSize: enc.encodeQueueSize,
      state: enc.state,
      chunkCount,
      flushMs: Number((performance.now() - audioFlushStartedAt).toFixed(2)),
    });
    enc.close();
    this._logExport('AudioEncoder closed', { chunkCount });
    if (err) throw err;
    return chunkCount;
  }

  // -------------------------
  // PNG frame sequence (ZIP)
  // -------------------------
  async exportFrames({ fps = 60, onProgress, onStatus, shouldCancel } = {}) {
    this._logExport('PNG frame export requested', this._exportDiagnostics({
      fps,
      userAgent: navigator.userAgent,
    }));
    if (typeof JSZip === 'undefined') {
      this._logExport('JSZip missing; PNG export unavailable', null, 'error');
      throw new Error('JSZip not loaded; PNG export unavailable.');
    }
    const { canvas, renderer, events, speedState } = this._makePipeline();
    const sim = this.simulator;
    const dt = window.PHYSICS_CONST.FIXED_DT;
    const stepsPerFrame = (1 / dt) / fps;

    const zip = new JSZip();
    const stopper = this._makeStopper(fps);
    if (onStatus) onStatus('Rendering PNG frames · ' + stopper.describe);
    this._logExport('PNG frame rendering started', {
      stopper: stopper.describe,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      seed: sim.scenario && sim.scenario.seed,
      scenarioName: sim.scenario && sim.scenario.name,
    });
    let result = null;
    const acc = { value: 0 };
    const stopState = { reached: false };
    let frameIdx = 0;
    while (true) {
      const loopStartedAt = performance.now();
      throwIfExportCancelled(shouldCancel);
      if (frameIdx === 0 || frameIdx % 10 === 0) {
        this._logExport('PNG frame loop begin', this._exportDiagnostics({
          frameIdx,
          seconds: Number((frameIdx / fps).toFixed(3)),
          objectCount: sim.state && sim.state.objects ? sim.state.objects.length : null,
          particleCount: renderer.particles ? renderer.particles.length : null,
          stopReached: stopState.reached,
        }), 'debug');
      }
      const stepStartedAt = performance.now();
      const shouldStop = this._stepOneFrame(
        renderer, events, stopper, speedState, stopState, frameIdx, fps, dt, stepsPerFrame, acc,
      );
      const stepMs = performance.now() - stepStartedAt;
      const toBlobStartedAt = performance.now();
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      const toBlobMs = performance.now() - toBlobStartedAt;
      if (!blob) {
        this._logExport('canvas.toBlob returned null during PNG export', { frameIdx }, 'error');
        throw new Error('canvas.toBlob returned null during PNG export.');
      }
      throwIfExportCancelled(shouldCancel);
      const arrayBufferStartedAt = performance.now();
      zip.file(`frame_${String(frameIdx).padStart(6, '0')}.png`, await blob.arrayBuffer());
      const arrayBufferMs = performance.now() - arrayBufferStartedAt;
      frameIdx++;
      if (frameIdx === 1 || frameIdx % 10 === 0) {
        this._logExport('PNG frame added to zip', this._exportDiagnostics({
          frameIdx,
          seconds: Number((frameIdx / fps).toFixed(3)),
          blobSize: blob.size,
          shouldStop,
          stepMs: Number(stepMs.toFixed(2)),
          toBlobMs: Number(toBlobMs.toFixed(2)),
          arrayBufferMs: Number(arrayBufferMs.toFixed(2)),
          loopMs: Number((performance.now() - loopStartedAt).toFixed(2)),
          stopReached: stopState.reached,
          activeTransientFx: renderer.hasActiveTransientFx(),
        }));
      }
      if (onProgress) onProgress(frameIdx);
      if (frameIdx % 4 === 0) await new Promise((r) => setTimeout(r, 0));
      throwIfExportCancelled(shouldCancel);
      if (shouldStop) break;
    }
    this._logExport('PNG frame rendering finished; writing metadata', {
      frameIdx,
      seconds: Number((frameIdx / fps).toFixed(3)),
    });
    zip.file('scenario.json', JSON.stringify(sim.getScenario(), null, 2));
    zip.file('manifest.json', JSON.stringify({
      fps, frames: frameIdx, width: 1080, height: 1920,
      stop: stopper.describe,
      ffmpeg_hint: `ffmpeg -framerate ${fps} -i frame_%06d.png -c:v libx264 -pix_fmt yuv420p -crf 18 output.mp4`,
    }, null, 2));
    this._logExport('PNG zip generation started', { frameIdx });
    const zipStartedAt = performance.now();
    const zipBlob = await zip.generateAsync(
      { type: 'blob' },
      (metadata) => {
        if (metadata.percent === 100 || Math.floor(metadata.percent) % 10 === 0) {
          this._logExport('PNG zip generation progress', {
            percent: Number(metadata.percent.toFixed(1)),
            currentFile: metadata.currentFile,
          }, 'debug');
        }
      },
    );
    this._logExport('PNG zip generation finished', {
      frameIdx,
      blobSize: zipBlob.size,
      zipMs: Number((performance.now() - zipStartedAt).toFixed(2)),
    });
    result = {
      blob: zipBlob,
      frames: frameIdx,
      seconds: frameIdx / fps,
      mimeType: 'application/zip',
      extension: 'zip',
    };
    return result;
  }
}

window.ExportManager = ExportManager;
