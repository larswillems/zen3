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
// There's always a hard safety cap (30 s by default) so a broken rule can
// never produce an infinite render.

class ExportManager {
  constructor(simulator, audioEngine = null) {
    this.simulator = simulator;
    this.audioEngine = audioEngine;
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

    const speedState = { override: null };
    const fakeApp = {
      renderer,
      simulator: this.simulator,
      pause: () => { /* noop during export */ },
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
    return { canvas, renderer, events, speedState };
  }

  // Builds a predicate that, given (frameIndex, events, aliveCount), returns
  // 'stop' when we should stop encoding. Bounded by a hard cap so nothing
  // can ever run forever.
  _makeStopper(fps) {
    const sc = this.simulator.scenario;
    const ec = sc.endCondition || null;
    const hardCapSeconds = sc.disableExportHardCap
      ? 120
      : Math.min(120, Math.max(2, Number(sc.maxExportSeconds) || 30));
    const hardCap = Math.ceil(hardCapSeconds * fps);

    // Fallback seconds if we've no structured endCondition.
    const fallback = sc.satisfying ? (sc.loopDuration || 10) : (sc.duration || 12);

    if (!ec || ec.type === 'loopDuration') {
      const frames = Math.ceil((sc.loopDuration || fallback) * fps);
      return { describe: `loop (${(sc.loopDuration || fallback).toFixed(1)}s)`,
               fn: (i) => i + 1 >= frames ? 'stop' : null };
    }
    if (ec.type === 'fixed') {
      const seconds = Math.min(hardCapSeconds, Math.max(0.5, ec.seconds || fallback));
      const frames = Math.ceil(seconds * fps);
      return { describe: `fixed (${seconds.toFixed(1)}s)`,
               fn: (i) => i + 1 >= frames ? 'stop' : null };
    }
    if (ec.type === 'firstEscapeTail') {
      const tailFrames = Math.ceil((ec.tail != null ? ec.tail : 2.5) * fps);
      let firstAt = -1;
      return { describe: `after-first-escape (+${(tailFrames / fps).toFixed(1)}s)`,
               fn: (i, events) => {
                 if (firstAt < 0 && events.some((e) => e.type === 'escape')) firstAt = i;
                 if (firstAt >= 0 && (i - firstAt) >= tailFrames) return 'stop';
                 if (i + 1 >= hardCap) return 'stop';
                 return null;
               } };
    }
    if (ec.type === 'allBallsGone') {
      const tailFrames = Math.ceil((ec.tail != null ? ec.tail : 1.0) * fps);
      let goneAt = -1;
      let seenAlive = false;
      return { describe: `after-all-gone (+${(tailFrames / fps).toFixed(1)}s)`,
               fn: (i, events, alive) => {
                 if (alive > 0) seenAlive = true;
                 if (seenAlive && alive === 0 && goneAt < 0) goneAt = i;
                 if (goneAt >= 0 && (i - goneAt) >= tailFrames) return 'stop';
                 if (i + 1 >= hardCap) return 'stop';
                 return null;
               } };
    }
    if (ec.type === 'ballCountTail') {
      const tailFrames = Math.ceil((ec.tail != null ? ec.tail : 1.0) * fps);
      const targetCount = Math.max(0, ec.count | 0);
      let hitAt = -1;
      return { describe: `after-ball-count<=${targetCount} (+${(tailFrames / fps).toFixed(1)}s)`,
               fn: (i, _events, alive) => {
                 if (alive <= targetCount && hitAt < 0) hitAt = i;
                 if (hitAt >= 0 && (i - hitAt) >= tailFrames) return 'stop';
                 if (i + 1 >= hardCap) return 'stop';
                 return null;
               } };
    }
    if (ec.type === 'bucketHitTail') {
      const tailFrames = Math.ceil((ec.tail != null ? ec.tail : 0) * fps);
      const bucketId = String(ec.bucketId || '');
      let hitAt = -1;
      return { describe: `after-bucket-hit:${bucketId} (+${(tailFrames / fps).toFixed(1)}s)`,
               fn: (i, events) => {
                 if (hitAt < 0 && events.some((e) => e.type === 'score' && String(e.bucketId || '') === bucketId)) {
                   hitAt = i;
                 }
                 if (hitAt >= 0 && (i - hitAt) >= tailFrames) return 'stop';
                 if (i + 1 >= hardCap) return 'stop';
                 return null;
               } };
    }
    // Unknown condition: fall back to fixed.
    const frames = Math.ceil(fallback * fps);
    return { describe: `fallback (${fallback.toFixed(1)}s)`,
             fn: (i) => i + 1 >= frames ? 'stop' : null };
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
    renderer, events, stopper, speedState,
    frameIdx, fps, dt, stepsPerFrame, accRef, audioSink = null,
  ) {
    const sim = this.simulator;
    const frameStartVideoTime = frameIdx / fps;
    if (audioSink) audioSink.currentTime = frameStartVideoTime;

    let frameSpeed = 1.0;
    if (speedState.override) {
      frameSpeed = speedState.override.factor;
      speedState.override.life -= 1 / fps;
      if (speedState.override.life <= 0) speedState.override = null;
    }
    accRef.value += frameSpeed * stepsPerFrame;
    let lastEvents = [];
    let subStep = 0;
    while (accRef.value >= 1) {
      sim.step(dt);
      const evs = sim.lastEvents();
      renderer.handleEvents(evs);
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
      events.update(sim.state, evs);
      lastEvents = lastEvents.concat(evs);
      accRef.value -= 1;
      subStep++;
    }

    // Particles and flash/popup animate in video-time.
    renderer.stepParticles(1 / fps);
    renderer.render(sim.state, {
      overlay: sim.scenario.overlay,
      visuals: sim.scenario.visuals,
      softMode: !!sim.scenario.satisfying,
    });
    const alive = sim.state.objects.filter((o) => o.type === 'ball' && o.alive && !o._escaped).length;
    return stopper.fn(frameIdx, lastEvents, alive) === 'stop';
  }

  // -------------------------
  // MP4 via WebCodecs + mp4-muxer
  // -------------------------
  async exportMP4({ fps = 60, onProgress, onStatus } = {}) {
    if (typeof window.VideoEncoder === 'undefined') {
      throw new Error('This browser lacks WebCodecs (VideoEncoder). Try Chrome/Edge or PNG frames.');
    }
    if (typeof window.Mp4Muxer === 'undefined') {
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
        const sup = await window.VideoEncoder.isConfigSupported({
          codec: c, width: 1080, height: 1920, bitrate: 12_000_000, framerate: fps,
        });
        if (sup && sup.supported) { codec = c; break; }
      } catch (_) { /* try next */ }
    }
    if (!codec) throw new Error('No H.264 config is supported by this browser.');

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
          console.warn('[export] audio isConfigSupported failed for', encCodec, e);
        }
      }
      if (!audioEncCodec) audioReason.push('no supported audio codec (tried AAC-LC, HE-AAC, Opus)');
    }
    const canDoAudio = audioReason.length === 0 && !!audioEncCodec;
    console.info('[export] audio:',
      canDoAudio ? `enabled (${audioEncCodec} -> mp4/${audioMuxCodec})` : `disabled (${audioReason.join(', ')})`);

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

    // --- Video encoder ----------------------------------------------------
    let encoderError = null;
    const encoder = new window.VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encoderError = e; console.error('VideoEncoder error:', e); },
    });
    encoder.configure({
      codec, width: 1080, height: 1920, bitrate: 12_000_000, framerate: fps,
      avc: { format: 'avc' },
    });

    // --- Audio collector sink (fed by the isolated EventEngine + sim) -----
    const audioSink = canDoAudio
      ? { timedEvents: [], fanfareCalls: [], currentTime: 0 }
      : null;

    const { canvas, renderer, events, speedState } = this._makePipeline({ audioSink });

    sim.rebuild();
    const stopper = this._makeStopper(fps);
    if (onStatus) onStatus('Rendering frames · ' + stopper.describe);

    const acc = { value: 0 };
    let frameIdx = 0;
    const keyEvery = fps * 2;
    while (true) {
      if (encoderError) throw encoderError;
      const shouldStop = this._stepOneFrame(
        renderer, events, stopper, speedState,
        frameIdx, fps, dt, stepsPerFrame, acc, audioSink,
      );
      const frameTs = Math.round(frameIdx * 1_000_000 / fps);
      const nextFrameTs = Math.round((frameIdx + 1) * 1_000_000 / fps);
      const frame = new window.VideoFrame(canvas, {
        // Use adjacent rounded timestamps so the encoded frame durations sum
        // exactly to the target timeline. A fixed rounded `duration` can make
        // some players interpret 60fps as tiny variable pacing.
        timestamp: frameTs,
        duration: nextFrameTs - frameTs,
      });
      try {
        encoder.encode(frame, { keyFrame: frameIdx % keyEvery === 0 });
      } finally {
        frame.close();
      }
      frameIdx++;

      if (onProgress) onProgress(frameIdx);
      if (frameIdx % 8 === 0) await new Promise((r) => setTimeout(r, 0));

      if (shouldStop) break;
    }

    await encoder.flush();
    encoder.close();

    // --- Render and encode the audio track --------------------------------
    let audioCodecUsed = null;
    let audioChunkCount = 0;
    let audioFailReason = canDoAudio ? null : audioReason.join(', ');
    let audioWavBlob = null;
    let audioPeak = 0;
    if (audioSink) {
      try {
        if (onStatus) onStatus('Rendering audio…');
        const durationSec = frameIdx / fps;
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

        // Always produce a WAV sidecar so the user can verify the rendered
        // audio INDEPENDENTLY of mp4-muxer. If the sidecar plays fine but
        // the MP4 is silent, the bug is in mux/player. If the sidecar is
        // silent, the bug is in the audio engine/events.
        try {
          audioWavBlob = this._audioBufferToWavBlob(audioBuffer, durationSec);
          console.info('[export] wav sidecar bytes:', audioWavBlob.size);
        } catch (e) {
          console.warn('[export] wav sidecar failed:', e);
        }

        if (audioPeak < 1e-4) {
          // Skip muxing a silent track — it would only confuse players.
          throw new Error(
            `offline render was silent (peak=${audioPeak.toFixed(6)}), `
            + `events=${audioSink.timedEvents.length}, `
            + `fanfare=${audioSink.fanfareCalls.length}`,
          );
        }

        if (onStatus) onStatus('Encoding audio (' + audioEncCodec + ')…');
        audioChunkCount = await this._encodeAudioBufferToMuxer(
          audioBuffer, muxer,
          audioEncCodec, AUDIO_CHANNELS, AUDIO_SR, AUDIO_BITRATE,
          durationSec,
        );
        audioCodecUsed = audioEncCodec;
        console.info('[export] audio muxed:', audioChunkCount, 'AAC/Opus chunks');
        if (audioChunkCount === 0) {
          throw new Error('AudioEncoder produced 0 chunks');
        }
      } catch (e) {
        // Loud failure: surface to the UI + console so the user can see WHY
        // the MP4 is silent and report back if needed.
        audioCodecUsed = null;
        audioFailReason = e && e.message ? e.message : String(e);
        console.error('[export] Audio export failed:', e);
        if (onStatus) onStatus('⚠ audio skipped: ' + audioFailReason);
      }
    }

    muxer.finalize();
    sim.rebuild();

    return {
      blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
      frames: frameIdx,
      seconds: frameIdx / fps,
      mimeType: 'video/mp4',
      extension: 'mp4',
      codec,
      audioCodec: audioCodecUsed,
      audioFailReason,
      audioWav: audioWavBlob,
      audioPeak,
    };
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
    audioBuffer, muxer, codec, numCh, sampleRate, bitrate, durationSec,
  ) {
    let err = null;
    let chunkCount = 0;
    let firstMetaLogged = false;
    const enc = new window.AudioEncoder({
      output: (chunk, meta) => {
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
          console.error('[export] muxer.addAudioChunk failed:', e);
        }
      },
      error: (e) => { err = e; console.error('[export] AudioEncoder error:', e); },
    });
    // Explicitly request raw AAC frames (not ADTS) — mp4-muxer expects the
    // raw elementary stream plus AudioSpecificConfig in meta.decoderConfig.
    const cfg = { codec, sampleRate, numberOfChannels: numCh, bitrate };
    if (codec && codec.startsWith('mp4a.')) cfg.aac = { format: 'aac' };
    enc.configure(cfg);

    const totalFrames = Math.min(
      audioBuffer.length,
      Math.ceil(durationSec * sampleRate),
    );
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels >= 2
      ? audioBuffer.getChannelData(1) : ch0;

    const chunkFrames = 1024; // AAC works with 1024-sample frames
    for (let start = 0; start < totalFrames; start += chunkFrames) {
      if (err) throw err;
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
      }
    }

    await enc.flush();
    enc.close();
    if (err) throw err;
    return chunkCount;
  }

  // -------------------------
  // PNG frame sequence (ZIP)
  // -------------------------
  async exportFrames({ fps = 60, onProgress, onStatus } = {}) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded; PNG export unavailable.');
    const { canvas, renderer, events, speedState } = this._makePipeline();
    const sim = this.simulator;
    const dt = window.PHYSICS_CONST.FIXED_DT;
    const stepsPerFrame = (1 / dt) / fps;

    const zip = new JSZip();
    sim.rebuild();
    const stopper = this._makeStopper(fps);
    if (onStatus) onStatus('Rendering PNG frames · ' + stopper.describe);

    const acc = { value: 0 };
    let frameIdx = 0;
    while (true) {
      const shouldStop = this._stepOneFrame(
        renderer, events, stopper, speedState, frameIdx, fps, dt, stepsPerFrame, acc,
      );
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      zip.file(`frame_${String(frameIdx).padStart(6, '0')}.png`, await blob.arrayBuffer());
      frameIdx++;
      if (onProgress) onProgress(frameIdx);
      if (frameIdx % 4 === 0) await new Promise((r) => setTimeout(r, 0));
      if (shouldStop) break;
    }
    zip.file('scenario.json', JSON.stringify(sim.getScenario(), null, 2));
    zip.file('manifest.json', JSON.stringify({
      fps, frames: frameIdx, width: 1080, height: 1920,
      stop: stopper.describe,
      ffmpeg_hint: `ffmpeg -framerate ${fps} -i frame_%06d.png -c:v libx264 -pix_fmt yuv420p -crf 18 output.mp4`,
    }, null, 2));
    sim.rebuild();
    return {
      blob: await zip.generateAsync({ type: 'blob' }),
      frames: frameIdx,
      seconds: frameIdx / fps,
      mimeType: 'application/zip',
      extension: 'zip',
    };
  }
}

window.ExportManager = ExportManager;
