// Scenario I/O: save/load to JSON, duplicate, default scenes.

function arrayBufferToDataUrl(buffer, mime = 'application/octet-stream') {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function scenarioWithEmbeddedSoundAssets(scenario) {
  const copy = JSON.parse(JSON.stringify(scenario || {}));
  const assets = copy.soundAssets;
  if (!assets || typeof assets !== 'object') return copy;

  for (const [assetId, asset] of Object.entries(assets)) {
    if (!asset || typeof asset !== 'object') continue;
    if (typeof asset.dataUrl === 'string' && asset.dataUrl.startsWith('data:')) {
      asset.embedded = true;
      continue;
    }
    if (!asset.url || typeof fetch !== 'function') continue;

    try {
      const response = await fetch(asset.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mime = asset.mime || response.headers.get('content-type') || 'audio/*';
      asset.dataUrl = arrayBufferToDataUrl(await response.arrayBuffer(), mime);
      asset.mime = mime;
      asset.sourceUrl = asset.url;
      delete asset.url;
      asset.embedded = true;
    } catch (e) {
      console.warn('[scenario-save] Could not embed sound asset; keeping original reference', {
        assetId,
        url: asset.url,
        error: e && e.message ? e.message : String(e),
      });
    }
  }

  return copy;
}

async function saveScenarioToFile(scenario, filename) {
  const saveCopy = await scenarioWithEmbeddedSoundAssets(scenario);
  const blob = new Blob([JSON.stringify(saveCopy, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `scenario_${saveCopy.seed}.json`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Let the browser actually start the download before we tear the URL down.
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

function loadScenarioFromFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return reject(new Error('No file selected'));
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          resolve(data);
        } catch (e) { reject(e); }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}

function buildDemoScenario(seed = 12345) {
  // A fun "escape the rings" chaos scene (non-looping).
  const s = {
    seed,
    version: 2,
    name: 'Neon Escape',
    loopDuration: 20,
    duration: 20,
    satisfying: false,
    physics: { gravity: 900, friction: 0 },
    overlay: { title: 'Can it escape?', showTimer: true, showCounter: true },
    visuals: { glow: 1.0, pulse: false },
    randomMode: false,
    endCondition: { type: 'fixed', seconds: 20 },
    objects: [
      {
        id: 'circle_outer', type: 'circle',
        x: 540, y: 960, radius: 460, thickness: 14,
        rotation: 0, rotationSpeed: 0.6,
        color: '#f472b6',
        gapStart: 0, gapSize: 0.5, insideOnly: true,
      },
      {
        id: 'circle_mid', type: 'circle',
        x: 540, y: 960, radius: 360, thickness: 12,
        rotation: 0, rotationSpeed: -0.9,
        color: '#a78bfa',
        gapStart: Math.PI, gapSize: 0.6, insideOnly: true,
      },
      {
        id: 'circle_inner', type: 'circle',
        x: 540, y: 960, radius: 260, thickness: 10,
        rotation: 0, rotationSpeed: 1.2,
        color: '#38bdf8',
        gapStart: Math.PI / 2, gapSize: 0.75, insideOnly: true,
      },
      {
        id: 'ball_1', type: 'ball',
        x: 540, y: 960, vx: 220, vy: -260,
        radius: 22, color: '#fbbf24',
        trail: true, trailLength: 50,
        lifetime: 0, bounce: 1.0, destroyOnSpike: true,
      },
    ],
  };
  return s;
}

// A hypnotic, perfectly-looping default scene.
// All motion completes an integer number of cycles per loop, so the final
// frame is pixel-identical to the first frame.
function buildHarmonicScenario(seed = 7) {
  const L = 10; // loop duration seconds
  const cx = 540, cy = 960;
  const cyclesPerLoop = (n) => (Math.PI * 2) * n / L;
  const palette = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185'];
  const objects = [
    // Three concentric counter-rotating rings; each completes an integer
    // number of revolutions over the loop so their rotations are seamless.
    { id: 'circle_outer', type: 'circle',
      x: cx, y: cy, radius: 460, thickness: 6,
      rotation: 0, rotationSpeed: cyclesPerLoop(1),
      color: '#a78bfa', gapStart: 0, gapSize: 0, insideOnly: true },
    { id: 'circle_mid', type: 'circle',
      x: cx, y: cy, radius: 360, thickness: 5,
      rotation: 0, rotationSpeed: cyclesPerLoop(-1),
      color: '#38bdf8', gapStart: 0, gapSize: 0, insideOnly: true },
    { id: 'circle_inner', type: 'circle',
      x: cx, y: cy, radius: 260, thickness: 4,
      rotation: 0, rotationSpeed: cyclesPerLoop(2),
      color: '#f472b6', gapStart: 0, gapSize: 0, insideOnly: true },
  ];
  // Six orbiting balls evenly phase-offset around a middle circle.
  const N = 6;
  for (let i = 0; i < N; i++) {
    objects.push({
      id: `ball_${i}`,
      type: 'ball',
      x: cx, y: cy, vx: 0, vy: 0,
      radius: 20,
      color: palette[i % palette.length],
      trail: true,
      trailLength: Math.round(L * 60 * 0.55),
      lifetime: 0, bounce: 1.0, destroyOnSpike: false, alive: true, age: 0,
      motion: 'orbit',
      orbitCx: cx, orbitCy: cy,
      orbitRadius: 360,
      orbitHarmonic: 1,
      orbitPhase: i * (Math.PI * 2 / N),
      orbitDirection: 1,
      lissaRadiusY: 360, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
    });
  }
  // Two inner lissajous balls for visual variety.
  objects.push({
    id: 'lissa_1', type: 'ball',
    x: cx, y: cy, vx: 0, vy: 0, radius: 16,
    color: '#fbbf24', trail: true, trailLength: Math.round(L * 60 * 0.7),
    lifetime: 0, bounce: 1.0, destroyOnSpike: false, alive: true, age: 0,
    motion: 'lissajous',
    orbitCx: cx, orbitCy: cy,
    orbitRadius: 180, orbitHarmonic: 3, orbitPhase: 0, orbitDirection: 1,
    lissaRadiusY: 180, lissaHarmonicY: 2, lissaPhaseY: Math.PI / 2,
  });
  objects.push({
    id: 'lissa_2', type: 'ball',
    x: cx, y: cy, vx: 0, vy: 0, radius: 16,
    color: '#34d399', trail: true, trailLength: Math.round(L * 60 * 0.7),
    lifetime: 0, bounce: 1.0, destroyOnSpike: false, alive: true, age: 0,
    motion: 'lissajous',
    orbitCx: cx, orbitCy: cy,
    orbitRadius: 180, orbitHarmonic: 2, orbitPhase: 0, orbitDirection: -1,
    lissaRadiusY: 180, lissaHarmonicY: 3, lissaPhaseY: 0,
  });
  return {
    seed,
    version: 2,
    name: 'Harmonic Orbits',
    loopDuration: L,
    duration: L,
    satisfying: true,
    physics: { gravity: 0, friction: 0 },
    overlay: { title: '', showTimer: false, showCounter: false },
    visuals: { glow: 1.0, pulse: true },
    randomMode: false,
    // Satisfying loops export one perfect cycle (first frame == last frame).
    endCondition: { type: 'loopDuration' },
    objects,
  };
}

function buildBurningRingsScenario(seed = 73) {
  const cx = 540, cy = 960;
  const seedRng = new SeededRNG(seed).fork(881);
  const ringColors = ['#22d3ee', '#38bdf8', '#818cf8', '#a78bfa', '#d946ef', '#f472b6', '#fb7185', '#f97316'];
  const radii = [140, 186, 232, 278, 324, 370, 416, 462];
  const speeds = [-0.18, 0.27, -0.37, 0.49, -0.63, 0.79, -0.96, 1.15];
  const ballRadius = 28;
  const ringThickness = 10;
  // Keep the USABLE opening the same across all rings after the ball-size pad
  // is subtracted by `ballFitsCircleGap()`. Smaller rings therefore need a
  // larger raw gap than bigger rings.
  const targetUsableGap = 0.62;
  const launchAngle = -Math.PI / 2 + seedRng.range(-0.22, 0.22);
  const launchSpeed = 720;

  const objects = radii.map((radius, i) => {
    const clearanceRadius = Math.max(1, radius - ringThickness * 0.5);
    const ratio = Math.max(0, Math.min(0.999999, ballRadius / clearanceRadius));
    const angularPad = Math.asin(ratio);
    const gapSize = Math.min(Math.PI * 1.35, targetUsableGap + angularPad * 2);
    // Give each ring its own fully independent seeded opening. We do NOT anchor
    // these to the ball's launch lane, otherwise they still feel visually
    // aligned and the ball can burn through multiple rings instantly.
    const gapCenterAtT0 = seedRng.range(-Math.PI, Math.PI);
    const gapStart = gapCenterAtT0 - gapSize / 2;
    return {
      id: `burn_ring_${i + 1}`,
      type: 'circle',
      x: cx,
      y: cy,
      radius,
      thickness: ringThickness,
      rotation: 0,
      rotationSpeed: speeds[i], // odd rings CCW, even rings CW (visually)
      color: ringColors[i % ringColors.length],
      gapStart,
      gapSize,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'flyAway',
        particleStyle: 'burn',
        removeObjectOnPass: true,
        soundMode: 'preset',
        soundPreset: 'burn',
        soundAssetId: '',
        soundVolume: 0.9,
      },
    };
  });

  objects.push({
    id: 'ball_1',
    type: 'ball',
    x: cx,
    y: cy,
    spawnX: cx,
    spawnY: cy,
    vx: Math.cos(launchAngle) * launchSpeed,
    vy: Math.sin(launchAngle) * launchSpeed,
    radius: ballRadius,
    color: '#f8fafc',
    trail: true,
    trailLength: 88,
    clearTrailOnDeath: true,
    lifetime: 0,
    ballBehaviorPreset: 'mixedChaos',
    maxSpeed: 900,
    bounce: 1.03,
    bounceSound: 'piano',
    wallCurve: 0.62,
    wallDrift: 0.76,
    wallBounceAngleRange: 34,
    collisionSpread: 0.12,
    destroyOnSpike: false,
    freezeOnSpike: false,
    motion: 'physics',
    orbitCx: cx,
    orbitCy: cy,
    orbitRadius: 280,
    orbitHarmonic: 1,
    orbitPhase: 0,
    orbitDirection: 1,
    lissaRadiusY: 280,
    lissaHarmonicY: 1,
    lissaPhaseY: Math.PI / 2,
  });

  return {
    seed,
    version: 2,
    name: 'Burning Rings',
    loopDuration: 18,
    duration: 18,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: 'Burning Rings',
      showTimer: false,
      showCounter: true,
    },
    visuals: { glow: 1.2, pulse: false },
    randomMode: false,
    stopOnFirstEscape: false,
    endCondition: { type: 'fixed', seconds: 18 },
    objects,
    events: [],
  };
}

// "1 HP to escape" — the freeze-on-spike scenario.
//   * Ball drops from the top-center of the ring.
//   * Any spike touch freezes the ball in place (a pretty icy obstacle).
//   * Every freeze spawns a new ball, so the arena slowly fills up.
//   * Balls collide with each other AND with frozen balls (solid pinballs).
//   * A tiny rotating gap in the ring is the only real exit; the moment any
//     ball actually escapes through it, the entire scene shatters.
function buildOneHpScenario(seed = 42) {
  const cx = 540, cy = 960;
  const ringRadius = 430;
  const ringThickness = 14;
  const gapStart = -Math.PI / 2 - 0.12; // top of the ring, narrow opening
  const gapSize = 0.24;
  const seedRng = new SeededRNG(seed).fork(101);
  // Keep this preset deterministic, but let different seeds produce a
  // different opening launch. All respawns inherit these same values from the
  // template ball, so one seed => one consistent trajectory family.
  // Wider seeded launch spread so different seeds land on a visibly broader
  // range of first-bounce points instead of all clustering near bottom-center.
  const launchVx = seedRng.range(-320, 320);
  const launchVy = seedRng.range(190, 320);
  // Spawn the ball safely inside the spike tips (which sit at
  // ringRadius - thickness/2 - spikeLength). Too close to the rim and every
  // respawn would instantly hit a spike once the spike-gap has rotated away.
  const spawnY = cy - 240;

  const objects = [
    // Glowing cyan ring, stationary. The single exit sits at the top.
    { id: 'ring', type: 'circle',
      x: cx, y: cy, radius: ringRadius, thickness: ringThickness,
      rotation: 0, rotationSpeed: 0,
      color: '#22d3ee',
      gapStart, gapSize,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'none',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 1,
      } },
    // White spikes on the inside of the ring, also stationary, with the gap
    // aligned with the ring's gap so the exit stays clear.
    { id: 'spikes', type: 'spikes',
      x: cx, y: cy,
      radius: ringRadius - ringThickness / 2,
      count: 22, length: 44, width: 28,
      inward: true,
      rotation: 0, rotationSpeed: 0,
      color: '#f8fafc',
      destroys: false,
      freezes: true,
      gapStart: gapStart - 0.06,
      gapSize: gapSize + 0.12 },
    // The starting ball. Drops from just below the top of the ring with a
    // little sideways speed so the run isn't boring. The seed picks the
    // opening launch, and every later respawn copies it.
    { id: 'ball_1', type: 'ball',
      x: cx, y: spawnY,
      vx: launchVx, vy: launchVy,
      radius: 26, color: '#a78bfa',
      trail: true, trailLength: 70,
      lifetime: 0, bounce: 1.0, wallCurve: 0.7,
      destroyOnSpike: false, freezeOnSpike: true,
      motion: 'physics',
      orbitCx: cx, orbitCy: cy, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2 },
  ];

  const events = [
    // Each freeze drops a fresh ball from the exact same spawn point, with
    // the exact same velocity, as the starting ball (ball_1). The template
    // provides radius/color/trail/bounce/lifetime/vx/vy/freeze+destroy
    // flags, so every respawn traces the *same opening trajectory* until it
    // hits a previously-frozen ball. `jitter: 0` disables the deterministic
    // RNG wobble that used to spread the drops sideways.
    { id: 'respawn', once: false,
      trigger: { type: 'ballFrozen' },
      action: { type: 'spawnBall',
                templateId: 'ball_1',
                jitter: 0 } },
    // The moment one actually escapes through the gap: global shatter +
    // flash + a victory popup.
    { id: 'win_shatter', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'shatter' } },
    { id: 'win_flash', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'flash', color: '#fef3c7' } },
    { id: 'win_text', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'text', text: 'ESCAPED!', seconds: 2.5 } },
  ];

  return {
    seed,
    version: 2,
    name: '1 HP to Escape',
    loopDuration: 20,
    duration: 20,
    satisfying: false,
    physics: { gravity: 1100, friction: 0 },
    overlay: { title: 'Each ball has only\n1 hp to escape',
               showTimer: false, showCounter: true },
    visuals: { glow: 1.25, pulse: false },
    randomMode: false,
    stopOnFirstEscape: true,
    // Stop right when the "ESCAPED!" popup has finished fading (its lifetime
    // is 2.5s, matching the tail below). The shatter particles, flash, and
    // win-fanfare all fit comfortably inside that window, so the video cuts
    // cleanly the moment the climax wraps instead of lingering on an empty
    // scene. Hard-capped to 45s of gameplay before that.
    endCondition: { type: 'firstEscapeTail', tail: 2.5 },
    objects,
    events,
  };
}

function buildOneChanceCircleScenario(seed = 42, variant = '4p1') {
  const cx = 540;
  const cy = 960;
  const ringRadius = 430;
  const ringThickness = 14;
  const gapSize = 0.72;
  const gapStart = Math.PI - gapSize * 0.5;
  const deg = Math.PI / 180;
  const variantDefs = {
    '4p1': {
      name: 'One Chance Circle 4+1',
      spikeAngles: [-136, -34, 18, 146],
      salt: 411,
      speed: 700,
    },
    '6p1': {
      name: 'One Chance Circle 6+1',
      spikeAngles: [-146, -102, -36, 6, 48, 152],
      salt: 611,
      speed: 720,
    },
    '8p1': {
      name: 'One Chance Circle 8+1',
      spikeAngles: [-150, -118, -84, -42, -4, 34, 132, 156],
      salt: 811,
      speed: 740,
    },
  };
  const variantDef = variantDefs[variant] || variantDefs['4p1'];
  const seedRng = new SeededRNG(seed).fork(variantDef.salt);
  const launchAngle = seedRng.range(-1.22, -0.38);
  const launchSpeed = variantDef.speed;
  const launchVx = Math.cos(launchAngle) * launchSpeed;
  const launchVy = Math.sin(launchAngle) * launchSpeed;
  const ringGradient = ['#ff294d', '#ff2d74', '#e11dff', '#7c3aed', '#4338ca', '#1d4ed8'];
  const spikePalette = ['#7c3aed', '#a855f7', '#ec4899', '#ff3b30', '#38bdf8', '#6366f1', '#8b5cf6', '#d946ef'];

  const objects = [
    {
      id: 'ring',
      type: 'circle',
      x: cx,
      y: cy,
      radius: ringRadius,
      thickness: ringThickness,
      rotation: 0,
      rotationSpeed: 0,
      color: '#ff2d74',
      gradientColors: ringGradient,
      gapStart,
      gapSize,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'none',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 1,
      },
    },
    {
      id: 'ball_1',
      type: 'ball',
      x: cx,
      y: cy,
      spawnX: cx,
      spawnY: cy,
      vx: launchVx,
      vy: launchVy,
      radius: 22,
      color: '#a21caf',
      trail: true,
      trailLength: 64,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1,
      bounceSound: 'piano',
      wallCurve: 0.64,
      destroyOnSpike: false,
      freezeOnSpike: true,
      recolorOnFreeze: true,
      deadColor: '#4b5563',
      deathBurstOnFreeze: false,
      deathSound: 'hollowEcho',
      motion: 'physics',
      orbitCx: cx,
      orbitCy: cy,
      orbitRadius: 280,
      orbitHarmonic: 1,
      orbitPhase: 0,
      orbitDirection: 1,
      lissaRadiusY: 280,
      lissaHarmonicY: 1,
      lissaPhaseY: Math.PI / 2,
    },
  ];
  const addSingleSpike = (id, angleDeg, color, length = 42, width = 30) => {
    objects.push({
      id,
      type: 'spikes',
      x: cx,
      y: cy,
      radius: ringRadius - ringThickness / 2,
      count: 1,
      length,
      width,
      inward: true,
      rotation: angleDeg * deg,
      rotationSpeed: 0,
      color,
      destroys: false,
      freezes: true,
      gapStart: 0,
      gapSize: 0,
    });
  };
  variantDef.spikeAngles.forEach((angleDeg, i) => {
    addSingleSpike(`spike_${i + 1}`, angleDeg, spikePalette[i % spikePalette.length]);
  });
  addSingleSpike('spike_bonus', 90, '#38bdf8', 46, 32);

  const events = [
    {
      id: 'respawn',
      once: false,
      trigger: { type: 'ballFrozen' },
      action: {
        type: 'spawnBall',
        templateId: 'ball_1',
        jitter: 0,
      },
    },
    {
      id: 'win_confetti',
      once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'confetti', count: 120, spread: 0.9 },
    },
    {
      id: 'win_shatter',
      once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'shatter', pieces: 8000, burstScale: 1.05 },
    },
    {
      id: 'win_flash',
      once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'flash', color: '#fdf2f8' },
    },
    {
      id: 'win_text',
      once: true,
      trigger: { type: 'firstEscape' },
      action: {
        type: 'text',
        text: 'ESCAPED!',
        seconds: 2.4,
        size: 86,
        color: '#f9a8d4',
        shadowColor: '#7e22ce',
      },
    },
  ];

  return {
    seed,
    version: 2,
    name: variantDef.name,
    oneChanceCircleVariant: variant,
    loopDuration: 20,
    duration: 20,
    satisfying: false,
    physics: { gravity: 1020, friction: 0 },
    overlay: {
      title: 'Each ball has only\n1 chance to escape',
      showTimer: false,
      showCounter: false,
    },
    visuals: {
      glow: 1.2,
      pulse: false,
      freezeKeepAppearance: false,
      freezeGlowColor: '#000000',
      freezeRimColor: '#6b7280',
      freezeOpacity: 1,
      freezeSpeckColor: '#6b7280',
      freezeSpeckCount: 0,
    },
    randomMode: false,
    stopOnFirstEscape: true,
    endCondition: { type: 'firstEscapeTail', tail: 2.4 },
    objects,
    events,
  };
}

function buildChaosTheoryScenario(seed = 17) {
  const cx = 540, cy = 960;
  const ringRadius = 430;
  const ringThickness = 14;
  const gapStart = Math.PI * 0.93;
  const gapSize = 0.34;
  const seedRng = new SeededRNG(seed).fork(307);
  const launchAngle = seedRng.angle();
  const speed = seedRng.range(360, 470);
  const ringGradient = ['#ff3b30', '#ff4d4f', '#d946ef', '#7c3aed', '#1d4ed8', '#1d4ed8'];
  const ballPalette = ['#f43f5e', '#fb7185', '#f97316', '#84cc16', '#22c55e', '#38bdf8', '#8b5cf6', '#d946ef'];

  const objects = [
    { id: 'ring', type: 'circle',
      x: cx, y: cy, radius: ringRadius, thickness: ringThickness,
      rotation: 0, rotationSpeed: 0.42,
      color: '#f43f5e',
      gradientColors: ringGradient,
      gapStart, gapSize,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'none',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 1,
      } },
    { id: 'spikes', type: 'spikes',
      x: cx, y: cy,
      radius: ringRadius - ringThickness / 2,
      count: 22, length: 44, width: 28,
      inward: true,
      rotation: 0, rotationSpeed: 0.42,
      color: '#8b5cf6',
      gradientColors: ringGradient,
      destroys: false,
      freezes: true,
      gapStart: gapStart - 0.05,
      gapSize: gapSize + 0.10 },
    { id: 'ball_1', type: 'ball',
      x: cx, y: cy,
      spawnX: cx, spawnY: cy,
      vx: Math.cos(launchAngle) * speed,
      vy: Math.sin(launchAngle) * speed,
      radius: 20,
      color: '#d946ef',
      trail: true, trailLength: 28,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1.0,
      wallCurve: 0.45,
      collisionSpread: 0.45,
      deadColor: '#3f3f46',
      recolorOnFreeze: true,
      deathBurstOnFreeze: true,
      deathSound: 'hollowEcho',
      destroyOnSpike: false, freezeOnSpike: true,
      motion: 'physics',
      orbitCx: cx, orbitCy: cy, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2 },
  ];

  const events = [
    { id: 'chaos_respawn', once: false,
      trigger: { type: 'ballFrozen' },
      action: {
        type: 'spawnBall',
        templateId: 'ball_1',
        jitter: 0,
        randomColor: true,
        colorPalette: ballPalette,
      } },
    { id: 'chaos_confetti', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'confetti' } },
    { id: 'chaos_flash', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'flash', color: '#f8fafc' } },
  ];

  return {
    seed,
    version: 2,
    name: 'Chaos Theory',
    loopDuration: 18,
    duration: 18,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: { title: 'Chaos Theory', showTimer: false, showCounter: true },
    visuals: { glow: 1.18, pulse: false },
    randomMode: false,
    stopOnFirstEscape: true,
    endCondition: { type: 'firstEscapeTail', tail: 1.6 },
    objects,
    events,
  };
}

function buildTwinkleScenario(seed = 11) {
  const cx = 540, cy = 960;
  const ringRadius = 430;
  const ringThickness = 14;
  const gapSize = Math.PI * 0.4; // 20% open
  const gapStart = -Math.PI / 2 - gapSize / 2; // centered on the top
  const seedRng = new SeededRNG(seed).fork(419);
  // Break the perfect up/down symmetry: start from the lower-left quadrant and
  // always launch up-right with a seed-varying angle so the ball explores the
  // ring instead of getting trapped in one vertical lane forever.
  const launchAngle = -Math.PI / 2 + seedRng.range(0.18, 0.46);
  const speed = 1180;
  const twinkle = [
    60, 60, 67, 67, 69, 69, 67,
    65, 65, 64, 64, 62, 62, 60,
    67, 67, 65, 65, 64, 64, 62,
    67, 67, 65, 65, 64, 64, 62,
    60, 60, 67, 67, 69, 69, 67,
    65, 65, 64, 64, 62, 62, 60,
  ];

  const objects = [
    { id: 'ring', type: 'circle',
      x: cx, y: cy, radius: ringRadius, thickness: ringThickness,
      rotation: 0, rotationSpeed: 0,
      color: '#f472b6',
      gapStart, gapSize,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'none',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 1,
      } },
    { id: 'ball_1', type: 'ball',
      x: cx - 128, y: cy + 305,
      spawnX: cx - 128, spawnY: cy + 305,
      vx: Math.cos(launchAngle) * speed,
      vy: Math.sin(launchAngle) * speed,
      radius: 24,
      color: '#fbbf24',
      trail: true, trailLength: 42,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1.0,
      wallCurve: 0.38,
      wallDrift: 0.58,
      destroyOnSpike: false, freezeOnSpike: false,
      motion: 'physics',
      orbitCx: cx, orbitCy: cy, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2 },
  ];

  const events = [
    { id: 'twinkle_confetti', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'confetti' } },
    { id: 'twinkle_flash', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'flash', color: '#fef9c3' } },
  ];

  return {
    seed,
    version: 2,
    name: 'Twinkle Bounce',
    loopDuration: 18,
    duration: 18,
    satisfying: false,
    physics: { gravity: 700, friction: 0 },
    overlay: { title: 'Twinkle Twinkle', showTimer: false, showCounter: false },
    visuals: { glow: 1.1, pulse: false, freezeKeepAppearance: true },
    randomMode: false,
    stopOnFirstEscape: true,
    melody: {
      enabled: true,
      triggerSources: ['circle', 'fixedBall'],
      notes: twinkle,
      loop: true,
      wave: 'triangle',
      gain: 0.34,
      decay: 0.20,
    },
    endCondition: { type: 'firstEscapeTail', tail: 1.4 },
    objects,
    events,
  };
}

function buildWobbleShowcaseScenario(seed = 37) {
  const cx = 540, cy = 960;
  const ringRadius = 430;
  const ringThickness = 16;
  const seedRng = new SeededRNG(seed).fork(733);
  const launchAngle = -Math.PI / 2 + seedRng.range(-0.55, 0.55);
  const speed = seedRng.range(1120, 1360);

  const objects = [
    { id: 'ring', type: 'circle',
      x: cx, y: cy, radius: ringRadius, thickness: ringThickness,
      rotation: 0, rotationSpeed: 0,
      color: '#7dd3fc',
      gapStart: 0, gapSize: 0,
      insideOnly: true },
    { id: 'ball_1', type: 'ball',
      x: cx - 110, y: cy + 280,
      spawnX: cx - 110, spawnY: cy + 280,
      vx: Math.cos(launchAngle) * speed,
      vy: Math.sin(launchAngle) * speed,
      radius: 28,
      color: '#fbbf24',
      trail: false, trailLength: 0,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1.0,
      wallCurve: 0.08,
      wallDrift: 0,
      softBody: true,
      elasticity: 2.4,
      recoverySpeed: 1.35,
      wobbleIntensity: 2.1,
      wobbleDamping: 1.9,
      destroyOnSpike: false, freezeOnSpike: false,
      motion: 'physics',
      orbitCx: cx, orbitCy: cy, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2 },
  ];

  return {
    seed,
    version: 2,
    name: 'Liquid Wobble Demo',
    loopDuration: 18,
    duration: 18,
    satisfying: false,
    physics: { gravity: 880, friction: 0 },
    overlay: { title: 'Liquid Wobble Demo', showTimer: false, showCounter: false, showScore: false },
    visuals: { glow: 1.2, pulse: false },
    randomMode: false,
    stopOnFirstEscape: false,
    endCondition: { type: 'fixed', seconds: 18 },
    objects,
    events: [],
  };
}

function usableCircleGapHalfAngle(rawGap, radius, thickness, ballRadius) {
  if (!(rawGap > 0)) return 0;
  const clearanceRadius = Math.max(
    1e-6,
    radius - thickness * 0.5 - ballRadius,
  );
  const ratio = Math.max(0, Math.min(0.999999, ballRadius / clearanceRadius));
  const angularPad = Math.asin(ratio);
  const edgeSafety = Math.max(0.0025, Math.min(0.02, 0.8 / clearanceRadius));
  const usableGap = Math.max(0, rawGap - (angularPad + edgeSafety) * 2);
  return usableGap * 0.5;
}

function normalizeVector(x, y) {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function gapStaticSweepVelocity(startX, startY, cx, cy, radius, targetAngle, speed) {
  const hitX = cx + Math.cos(targetAngle) * radius;
  const hitY = cy + Math.sin(targetAngle) * radius;
  const dir = normalizeVector(hitX - startX, hitY - startY);
  return {
    vx: dir.x * speed,
    vy: dir.y * speed,
  };
}

function buildGapStaticSweepScenario(step = 1, seed = 101) {
  const cx = 540;
  const cy = 960;
  const ringRadius = 430;
  const ringThickness = 14;
  const ballRadius = 28;
  const startX = cx + 72;
  const startY = 1220;
  const launchSpeed = 860;
  const gapSize = 0.34;
  const innerLimit = ringRadius - ringThickness * 0.5 - ballRadius;
  const baseContactAngle = Math.atan2(
    cy - Math.sqrt(Math.max(1, innerLimit * innerLimit - (startX - cx) * (startX - cx))) - cy,
    startX - cx,
  );
  const usableHalf = usableCircleGapHalfAngle(gapSize, ringRadius, ringThickness, ballRadius);
  const gapCenter = baseContactAngle - usableHalf * 0.90;
  const ratios = [1.12, 1.04, 0.96, 0.88, 0.80, 0.72];
  const index = Math.max(0, Math.min(ratios.length - 1, (step | 0) - 1));
  const targetAngle = gapCenter + usableHalf * ratios[index];
  const velocity = gapStaticSweepVelocity(startX, startY, cx, cy, innerLimit, targetAngle, launchSpeed);

  return {
    seed,
    version: 2,
    name: `Gap Static ${index + 1}`,
    loopDuration: 6,
    duration: 6,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: `Static gap ${index + 1}/${ratios.length}\nmore toward gap each step\nescape disabled for debugging`,
      showTimer: true,
      showCounter: false,
      showScore: false,
    },
    visuals: { glow: 1.16, pulse: false },
    randomMode: false,
    stopOnFirstEscape: false,
    debug: {
      collision: {
        enabled: true,
        maxLogs: 1800,
        toConsole: true,
        verboseGap: true,
      },
    },
    endCondition: { type: 'fixed', seconds: 6 },
    objects: [
      {
        id: 'ring',
        type: 'circle',
        x: cx,
        y: cy,
        radius: ringRadius,
        thickness: ringThickness,
        rotation: 0,
        rotationSpeed: 0,
        color: '#67e8f9',
        gapStart: gapCenter - gapSize * 0.5,
        gapSize,
        insideOnly: true,
        onGapPass: {
          enabled: false,
          outcome: 'escape',
          particleStyle: 'auto',
          removeObjectOnPass: false,
          soundMode: 'none',
          soundPreset: 'glass',
          soundAssetId: '',
          soundVolume: 1,
        },
      },
      {
        id: 'ball_1',
        type: 'ball',
        x: startX,
        y: startY,
        spawnX: startX,
        spawnY: startY,
        vx: velocity.vx,
        vy: velocity.vy,
        radius: ballRadius,
        color: '#34d399',
        trail: false,
        trailLength: 0,
        clearTrailOnDeath: true,
        lifetime: 0,
        bounce: 1.0,
        wallCurve: 0,
        wallDrift: 0,
        wallBounceAngleRange: 0,
        collisionSpread: 0,
        destroyOnSpike: false,
        freezeOnSpike: false,
        motion: 'physics',
        orbitCx: cx,
        orbitCy: cy,
        orbitRadius: 280,
        orbitHarmonic: 1,
        orbitPhase: 0,
        orbitDirection: 1,
        lissaRadiusY: 280,
        lissaHarmonicY: 1,
        lissaPhaseY: Math.PI / 2,
      },
    ],
    events: [],
    soundAssets: {},
  };
}

function buildGapEdgeCaseScenario(variant = 'static-pass', seed = 101) {
  const cx = 540;
  const cy = 960;
  const ringRadius = 430;
  const ringThickness = 14;
  const ballRadius = 28;
  const ballXOffset = 72;
  const startY = 1220;
  const launchSpeed = 860;
  const baseInnerLimit = ringRadius - ringThickness * 0.5 - ballRadius;
  const clampedX = Math.max(-baseInnerLimit + 2, Math.min(baseInnerLimit - 2, ballXOffset));
  const contactY = cy - Math.sqrt(Math.max(1, baseInnerLimit * baseInnerLimit - clampedX * clampedX));
  const contactTime = Math.max(0.01, (startY - contactY) / launchSpeed);
  const contactAngle = Math.atan2(contactY - cy, clampedX);
  const variants = {
    'static-pass': {
      name: 'Gap Pass Static',
      title: 'Static gap\nshould pass',
      subtitle: 'near-edge pass case',
      gapSize: 0.34,
      rotationSpeed: 0,
      edgeRatio: 0.78,
      ringColor: '#67e8f9',
      ballColor: '#34d399',
    },
    'static-graze': {
      name: 'Gap Graze Static',
      title: 'Static gap\nshould bounce',
      subtitle: 'near-edge graze case',
      gapSize: 0.34,
      rotationSpeed: 0,
      edgeRatio: 1.05,
      ringColor: '#f472b6',
      ballColor: '#fbbf24',
    },
    'rotate-pass': {
      name: 'Gap Pass Rotate',
      title: 'Rotating gap\nshould pass',
      subtitle: 'moving-edge pass case',
      gapSize: 0.30,
      rotationSpeed: 1.15,
      edgeRatio: 0.72,
      ringColor: '#a78bfa',
      ballColor: '#22d3ee',
    },
    'rotate-graze': {
      name: 'Gap Graze Rotate',
      title: 'Rotating gap\nshould bounce',
      subtitle: 'moving-edge graze case',
      gapSize: 0.30,
      rotationSpeed: 1.15,
      edgeRatio: 1.05,
      ringColor: '#fb7185',
      ballColor: '#facc15',
    },
  };
  const cfg = variants[variant] || variants['static-pass'];
  const usableHalf = usableCircleGapHalfAngle(cfg.gapSize, ringRadius, ringThickness, ballRadius);
  const gapCenterAtContact = contactAngle - usableHalf * cfg.edgeRatio;
  const initialGapCenter = gapCenterAtContact - cfg.rotationSpeed * contactTime;
  const gapStart = initialGapCenter - cfg.gapSize * 0.5;

  return {
    seed,
    version: 2,
    name: cfg.name,
    loopDuration: 6,
    duration: 6,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: `${cfg.title}\n${cfg.subtitle}`,
      showTimer: true,
      showCounter: false,
      showScore: false,
    },
    visuals: { glow: 1.16, pulse: false },
    randomMode: false,
    stopOnFirstEscape: false,
    debug: {
      collision: {
        enabled: true,
        maxLogs: 1800,
        toConsole: true,
        verboseGap: true,
      },
    },
    endCondition: { type: 'fixed', seconds: 6 },
    objects: [
      {
        id: 'ring',
        type: 'circle',
        x: cx,
        y: cy,
        radius: ringRadius,
        thickness: ringThickness,
        rotation: 0,
        rotationSpeed: cfg.rotationSpeed,
        color: cfg.ringColor,
        gapStart,
        gapSize: cfg.gapSize,
        insideOnly: true,
        onGapPass: {
          enabled: true,
          outcome: 'escape',
          particleStyle: 'auto',
          removeObjectOnPass: false,
          soundMode: 'none',
          soundPreset: 'glass',
          soundAssetId: '',
          soundVolume: 1,
        },
      },
      {
        id: 'ball_1',
        type: 'ball',
        x: cx + clampedX,
        y: startY,
        spawnX: cx + clampedX,
        spawnY: startY,
        vx: 0,
        vy: -launchSpeed,
        radius: ballRadius,
        color: cfg.ballColor,
        trail: true,
        trailLength: 44,
        clearTrailOnDeath: true,
        lifetime: 0,
        bounce: 1.0,
        wallCurve: 0,
        wallDrift: 0,
        wallBounceAngleRange: 0,
        collisionSpread: 0,
        destroyOnSpike: false,
        freezeOnSpike: false,
        motion: 'physics',
        orbitCx: cx,
        orbitCy: cy,
        orbitRadius: 280,
        orbitHarmonic: 1,
        orbitPhase: 0,
        orbitDirection: 1,
        lissaRadiusY: 280,
        lissaHarmonicY: 1,
        lissaPhaseY: Math.PI / 2,
      },
    ],
    events: [],
    soundAssets: {},
  };
}

// "4 Seconds to Escape" -- one active ball at a time.
//   * A rotating circle with a pulsing gap that opens/closes repeatedly.
//   * Exactly one live ball is in play; when its timer runs out it freezes.
//   * The next ball then spawns from the same template and gets its own timer.
//   * If any ball escapes, the challenge is over.
function buildTimedEscapeScenario(seed = 3, seconds = 4) {
  const cx = 540, cy = 960;
  const T = Math.max(1, seconds | 0);
  const R = 460;
  const thickness = 14;
  const gapStart = Math.PI / 6;
  const gapSize = 0.55;
  const seedRng = new SeededRNG(seed).fork(211);
  const launchAngle = seedRng.angle();
  const speed = seedRng.range(400, 500);

  const objects = [
    { id: 'ring', type: 'circle',
      x: cx, y: cy, radius: R, thickness,
      rotation: 0, rotationSpeed: seedRng.sign() * seedRng.range(0.45, 0.9),
      color: '#a78bfa',
      gapStart, gapSize,
      gapPulse: true, gapMinSize: 0.08, gapPulseSpeed: 1.1,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'none',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 1,
      } },
    { id: 'ball_1',
      type: 'ball',
      x: cx, y: cy,
      spawnX: cx, spawnY: cy,
      vx: Math.cos(launchAngle) * speed,
      vy: Math.sin(launchAngle) * speed,
      radius: 14,
      color: '#a78bfa',
      trail: true, trailLength: 24,
      clearTrailOnDeath: true,
      bounce: 1.0,
      collisionSpread: 0.45,
      destroyOnSpike: false, freezeOnSpike: false,
      motion: 'physics',
      orbitCx: cx, orbitCy: cy, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
    },
  ];

  const events = [
    { id: 'timed_cycle', once: false,
      trigger: { type: 'everySeconds', seconds: T },
      actions: [
        { type: 'freezeBall' },
        { type: 'spawnBall', templateId: 'ball_1', jitter: 0 },
      ] },
    { id: 'timed_win_confetti', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'confetti' } },
  ];

  return {
    seed,
    version: 2,
    name: `${T} Seconds to Escape`,
    loopDuration: T + 1,
    duration: T + 1,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: `Each ball has only\n${T} second${T === 1 ? '' : 's'} to escape`,
      showTimer: false, showCounter: false,
      bigCountdown: true,
      countdownMax: T,
      countdownMode: 'repeatInterval',
      countdownInterval: T,
    },
    visuals: { glow: 1.1, pulse: false, freezeKeepAppearance: true },
    randomMode: false,
    stopOnFirstEscape: true,
    endCondition: { type: 'firstEscapeTail', tail: 0 },
    objects,
    events,
  };
}

function buildThreeSecEscapeScenario() {
  return {
    seed: 7,
    version: 2,
    name: '3 Seconds to Escape',
    loopDuration: 4,
    duration: 4,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: 'Each ball has only\n3 seconds to escape',
      showTimer: false,
      showCounter: false,
      bigCountdown: true,
      countdownMax: 3,
      countdownMode: 'activeBallLifetime',
    },
    visuals: { glow: 1.1, pulse: false, freezeKeepAppearance: true },
    randomMode: false,
    stopOnFirstEscape: true,
    // Give the shatter effect a brief moment (0.75s) to play after an escape.
    endCondition: { type: 'firstEscapeTail', tail: 0.75 },
    objects: [
      {
        id: 'ring',
        type: 'circle',
        x: 540, y: 960,
        radius: 460,
        thickness: 14,
        rotation: 0,
        rotationSpeed: 0.49103547823615373,
        color: '#14ff5b',
        gapStart: 0.5235987755982988,
        gapSize: 0.55,
        gapPulse: false,
        gapMinSize: 0.08,
        gapPulseSpeed: 1.1,
        insideOnly: true,
        onGapPass: {
          enabled: true,
          outcome: 'escape',
          particleStyle: 'auto',
          removeObjectOnPass: false,
          soundMode: 'none',
          soundPreset: 'glass',
          soundAssetId: '',
          soundVolume: 1,
        },
      },
      {
        id: 'ball_1',
        type: 'ball',
        x: 540, y: 960,
        spawnX: 540, spawnY: 960,
        // Smaller, faster main ball trying to escape.
        vx: 720,
        vy: -260,
        radius: 18,
        color: '#a78bfa',
        trail: true,
        trailLength: 24,
        clearTrailOnDeath: true,
        lifetime: 3,
        freezeOnTimeout: true,
        bounce: 1.0,
        collisionSpread: 0.45,
        destroyOnSpike: false,
        freezeOnSpike: false,
        motion: 'physics',
        orbitCx: 540, orbitCy: 960, orbitRadius: 280,
        orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
        lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
      },
      // Three harmonic orbit balls that keep moving on perfect loops.
      {
        id: 'orbit_1',
        type: 'ball',
        x: 540, y: 960, vx: 0, vy: 0,
        radius: 35,
        color: '#38bdf8',
        trail: true,
        trailLength: 60,
        lifetime: 0,
        bounce: 1.0,
        destroyOnSpike: false,
        motion: 'orbit',
        alive: true,
        age: 0,
        orbitCx: 540, orbitCy: 960,
        orbitRadius: 260,
        orbitHarmonic: 1,
        orbitPhase: 0,
        orbitDirection: 1,
        lissaRadiusY: 260,
        lissaHarmonicY: 1,
        lissaPhaseY: Math.PI / 2,
      },
      {
        id: 'orbit_2',
        type: 'ball',
        x: 540, y: 960, vx: 0, vy: 0,
        radius: 35,
        color: '#f472b6',
        trail: true,
        trailLength: 60,
        lifetime: 0,
        bounce: 1.0,
        destroyOnSpike: false,
        motion: 'orbit',
        alive: true,
        age: 0,
        orbitCx: 540, orbitCy: 960,
        orbitRadius: 330,
        orbitHarmonic: 1,
        orbitPhase: Math.PI / 3,
        orbitDirection: -1,
        lissaRadiusY: 330,
        lissaHarmonicY: 1,
        lissaPhaseY: Math.PI / 2,
      },
      {
        id: 'orbit_3',
        type: 'ball',
        x: 540, y: 960, vx: 0, vy: 0,
        radius: 35,
        color: '#34d399',
        trail: true,
        trailLength: 60,
        lifetime: 0,
        bounce: 1.0,
        destroyOnSpike: false,
        motion: 'orbit',
        alive: true,
        age: 0,
        orbitCx: 540, orbitCy: 960,
        orbitRadius: 400,
        orbitHarmonic: 2,
        orbitPhase: (2 * Math.PI) / 3,
        orbitDirection: 1,
        lissaRadiusY: 400,
        lissaHarmonicY: 1,
        lissaPhaseY: Math.PI / 2,
      },
    ],
    events: [
      {
        id: 'timed_cycle',
        once: false,
        trigger: { type: 'ballFrozen' },
        actions: [
          { type: 'spawnBall', templateId: 'ball_1', jitter: 0 },
        ],
      },
      {
        id: 'three_sec_shatter_finish',
        once: true,
        trigger: { type: 'firstEscape' },
        actions: [
          {
            type: 'shatter',
            pieces: 4000,
            burstScale: 1.1,
            downwardBias: 260,
            rain: true,
            baseSpeed: 180,
            speedRange: 420,
            sizeMin: 2,
            sizeMax: 4,
          },
        ],
      },
    ],
    soundAssets: {},
  };
}

function buildTwoSecEscapeScenario() {
  const cx = 540;
  const cy = 960;
  const spikeCount = 28;
  const gapSize = Math.PI * 2 / spikeCount;
  const gapStart = -gapSize * 0.5;
  const hitAssetId = 'legend_video_hit';

  return {
    seed: 2,
    version: 2,
    name: '2 Seconds to Escape',
    loopDuration: 3,
    duration: 3,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: 'WAIT...\n2 seconds to escape',
      showTimer: false,
      showCounter: false,
      bigCountdown: true,
      countdownMax: 2,
      countdownMode: 'repeatInterval',
      countdownInterval: 2,
      titleSize: 78,
      titleY: 280,
      titleShadowColor: '#22d3ee',
    },
    visuals: {
      glow: 1.45,
      pulse: false,
      freezeKeepAppearance: true,
      ambientParticles: {
        enabled: true,
        count: 46,
        colors: ['#22d3ee', '#67e8f9', '#ffffff'],
        speed: 7,
        size: 2.1,
        alpha: 0.34,
        blend: 'lighter',
      },
    },
    randomMode: false,
    stopOnFirstEscape: true,
    endCondition: { type: 'firstEscapeTail', tail: 0.35 },
    objects: [
      {
        id: 'spike_crown',
        type: 'spikes',
        x: cx, y: cy,
        radius: 406,
        count: spikeCount,
        length: 62,
        width: 58,
        inward: true,
        rotation: 0,
        rotationSpeed: 0,
        color: '#f8fafc',
        gradientColors: ['#ffffff', '#93c5fd', '#1d4ed8'],
        destroys: false,
        freezes: true,
        gapStart,
        gapSize,
        onGapPass: {
          enabled: true,
          outcome: 'escape',
          particleStyle: 'burst',
          removeObjectOnPass: false,
          soundMode: 'upload',
          soundPreset: 'glass',
          soundAssetId: hitAssetId,
          soundVolume: 1,
        },
      },
      {
        id: 'ball_1',
        type: 'ball',
        x: cx, y: cy,
        spawnX: cx, spawnY: cy,
        vx: 0,
        vy: 450,
        radius: 38,
        color: '#ff00b8',
        trail: true,
        trailLength: 64,
        clearTrailOnDeath: true,
        bounce: 1.0,
        wallCurve: 0.08,
        collisionSpread: 0.42,
        softBody: true,
        elasticity: 0.68,
        recoverySpeed: 7.5,
        wobbleIntensity: 0.58,
        wobbleDamping: 8,
        changeColorOnBallCollision: true,
        bounceSound: 'pianoRise',
        escapeSound: 'riser',
        destroyOnSpike: false,
        freezeOnSpike: true,
        deathSound: `asset:${hitAssetId}`,
        motion: 'physics',
        orbitCx: cx, orbitCy: cy, orbitRadius: 280,
        orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
        lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
      },
    ],
    events: [
      {
        id: 'timed_cycle',
        once: false,
        trigger: { type: 'everySeconds', seconds: 2 },
        actions: [
          { type: 'freezeBall' },
          { type: 'spawnBall', templateId: 'ball_1', jitter: 0 },
        ],
      },
      {
        id: 'timed_win_flash',
        once: true,
        trigger: { type: 'firstEscape' },
        action: { type: 'flash', color: '#ff00b8' },
        actions: [
          { type: 'flash', color: '#ff00b8' },
          { type: 'confetti' },
        ],
      },
    ],
    soundAssets: {
      [hitAssetId]: {
        name: 'legend-clean-pure-echo-hit.mp3',
        mime: 'audio/mpeg',
        dataUrl: 'data:audio/mpeg;base64,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UDYnJXqrVq2JclEkyeaeKo+ko/ASB4pk0rE67AhCM7i5clBqCIUkISXCUrj/+7TE9gIkXezsD2mJw+69HZnMsPiJSMcSaXQRHWB8kiSTeOlWNLrraLqztc+bLuyzNcaXWy36cnsH1ucnvWXLtrtWVufONVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUDjj5DHZTFTDTpzSBgEfCwwcPg1cYl0IHoUXGNNmQEAYuCgBcMRACqCQ/VUZ2/kFtiaO3B9I3SW8M7MPM5UxVWYS0RsbRlspvIcREDHQCBaii21ZknSqAKgUYClgEhzTkXezhpbMGFsZKAn50INGqJOp43jtPhTqxjbF9FG8bp3JFJHaURGR7DuKk2D5PYWUNoHaDgChCDjQKsqhdQ+gpwoAUwkY5CDmQeaacotd6nZUOL6SIdonouw0SgMMwCjJgTMzzsU7Y1qY7T0O9dtT1RGiPodo0B3mGfinbG9cLtSMb95HcTCkBgdA4HhsouWKjQHg4HhsojYbc0hFIiD5D/+7TEf4PlTeyCLT09AAAANIAAAAQjY2kIhGi6A+zLxVSnko16q4PJRUIQ8XXQNsPQoiERAMCoeGzgfDwPhQkfikxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=',
      },
    },
  };
}

function buildBattleOfTheColorsScenario(seed = 23) {
  const cx = 540, cy = 960;
  const seedRng = new SeededRNG(seed).fork(523);
  const colors = ['#ff4d6d', '#f59e0b', '#22c55e', '#38bdf8', '#a855f7', '#fb7185', '#22d3ee'];
  const radii = [470, 320, 178];
  const ringSpeeds = [0.46, -0.64, 0.46];
  const ringColors = ['#f472b6', '#60a5fa', '#7dd3fc'];
  const ringGaps = [
    { gapStart: -Math.PI / 2 - 0.23, gapSize: 0.46 },
    { gapStart: Math.PI * 0.78, gapSize: 0.42 },
    { gapStart: Math.PI * 0.08, gapSize: 1.20 },
  ];

  const objects = radii.map((radius, i) => ({
    id: i === 0 ? 'ring_outer' : (i === 1 ? 'ring_middle' : 'ring_inner'),
    type: 'circle',
    x: cx, y: cy,
    radius,
    thickness: i === 2 ? 10 : 12,
    rotation: 0,
    rotationSpeed: ringSpeeds[i],
    color: ringColors[i],
    ...ringGaps[i],
    onGapPass: i === 0 ? {
      enabled: true,
      outcome: 'escape',
      particleStyle: 'auto',
      removeObjectOnPass: false,
      soundMode: 'none',
      soundPreset: 'glass',
      soundAssetId: '',
      soundVolume: 1,
    } : undefined,
    insideOnly: true,
  }));

  const startRadius = 0;
  for (let i = 0; i < colors.length; i++) {
    const angle = -Math.PI / 2 + (i / colors.length) * Math.PI * 2;
    const speed = seedRng.range(500, 650);
    const launchAngle = angle + seedRng.range(-0.55, 0.55);
    objects.push({
      id: `ball_${i + 1}`,
      type: 'ball',
      x: cx + Math.cos(angle) * startRadius,
      y: cy + Math.sin(angle) * startRadius,
      spawnX: cx + Math.cos(angle) * startRadius,
      spawnY: cy + Math.sin(angle) * startRadius,
      vx: Math.cos(launchAngle) * speed,
      vy: Math.sin(launchAngle) * speed,
      radius: 20,
      color: colors[i],
      trail: true,
      trailLength: 34,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1.0,
      minSpeed: 260,
      wallCurve: 1,
      wallDrift: 1,
      wallBounceAngleRange: 120,
      collisionSpread: 1,
      destroyOnSpike: false,
      freezeOnSpike: false,
      motion: 'physics',
      orbitCx: cx, orbitCy: cy, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
    });
  }

  const events = [
    { id: 'battle_finish_shatter', once: true,
      trigger: { type: 'ballCount', count: 1 },
      action: {
        type: 'shatter',
        except: 'lastBall',
        pieces: 4000,
        burstScale: 1.1,
        downwardBias: 260,
        rain: true,
        baseSpeed: 180,
        speedRange: 420,
        sizeMin: 2,
        sizeMax: 4,
        winnerText: 'WINNER',
        winnerColorMap: {
          '#ff4d6d': 'PINK WINS',
          '#f59e0b': 'ORANGE WINS',
          '#22c55e': 'GREEN WINS',
          '#38bdf8': 'BLUE WINS',
          '#a855f7': 'PURPLE WINS',
          '#fb7185': 'SALMON WINS',
          '#22d3ee': 'CYAN WINS',
        },
        winnerSize: 72,
        seconds: 2.2,
      } },
    { id: 'battle_finish_pause', once: true,
      trigger: { type: 'ballCount', count: 1 },
      action: { type: 'pause' } },
  ];

  return {
    seed,
    version: 2,
    name: 'Battle of the Colors',
    loopDuration: 20,
    duration: 20,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: { title: 'Battle of the Colors', showTimer: false, showCounter: false },
    visuals: { glow: 1.16, pulse: false },
    randomMode: false,
    stopOnFirstEscape: false,
    endCondition: { type: 'ballCountTail', count: 1, tail: 2.2 },
    objects,
    events,
  };
}

function buildEasterScenario(seed = 58) {
  const seedRng = new SeededRNG(seed).fork(2026);
  const objects = [];
  const boardLeft = 100;
  const boardRight = 980;
  const boardWidth = boardRight - boardLeft;
  const boardCenter = (boardLeft + boardRight) * 0.5;
  const eggPalette = ['#f9a8d4', '#c4b5fd', '#93c5fd', '#86efac', '#fde68a', '#fbcfe8'];
  const chocolatePalette = ['#fff7ed', '#c08457', '#fbbf24', '#6f4e37', '#7c2d12'];
  const binDefs = [
    { id: 'bin_white', points: 20, label: 'WIT', color: '#fff7ed', textColor: '#7c2d12' },
    { id: 'bin_milk', points: 35, label: 'MELK', color: '#c08457', textColor: '#fff7ed' },
    { id: 'bin_gold', points: 120, label: 'GOUD', color: '#fbbf24', textColor: '#5b3414' },
    { id: 'bin_dark', points: 45, label: 'PUUR', color: '#6f4e37', textColor: '#fff7ed' },
    { id: 'bin_truffle', points: 60, label: 'TRUFFEL', color: '#7c2d12', textColor: '#fff7ed' },
  ];
  const addPeg = (id, x, y, radius, color) => {
    objects.push({
      id,
      type: 'ball',
      x, y,
      spawnX: x, spawnY: y,
      vx: 0, vy: 0,
      radius,
      color,
      trail: false,
      clearTrailOnDeath: true,
      lifetime: 0,
      fixed: true,
      bounce: 1.0,
      destroyOnSpike: false,
      freezeOnSpike: false,
      motion: 'physics',
      orbitCx: 540, orbitCy: 960, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
    });
  };

  const rows = 10;
  const rowSpacingY = 90;
  const rowSpacingX = 98;
  for (let row = 0; row < rows; row++) {
    const count = row + 4;
    const y = 360 + row * rowSpacingY;
    const startX = boardCenter - ((count - 1) * rowSpacingX) * 0.5;
    for (let i = 0; i < count; i++) {
      const color = eggPalette[(row + i) % eggPalette.length];
      addPeg(`easter_peg_${row}_${i}`, startX + i * rowSpacingX, y, 12, color);
    }
  }

  for (let row = 1; row < rows - 1; row++) {
    const count = row + 4;
    const y = 360 + row * rowSpacingY + rowSpacingY * 0.5;
    const edgeOffset = ((count - 1) * rowSpacingX) * 0.5;
    addPeg(`easter_guide_l_${row}`, boardCenter - edgeOffset - rowSpacingX * 0.42, y, 9, '#dcfce7');
    addPeg(`easter_guide_r_${row}`, boardCenter + edgeOffset + rowSpacingX * 0.42, y, 9, '#dcfce7');
  }

  const chocolateEggs = [
    { id: 'choco_1', x: boardCenter - 160, y: 1260, radius: 20, color: '#c08457' },
    { id: 'choco_2', x: boardCenter, y: 1325, radius: 22, color: '#fbbf24' },
    { id: 'choco_3', x: boardCenter + 160, y: 1260, radius: 20, color: '#6f4e37' },
    { id: 'choco_4', x: boardCenter - 280, y: 1385, radius: 18, color: '#7c2d12' },
    { id: 'choco_5', x: boardCenter + 280, y: 1385, radius: 18, color: '#fff7ed' },
  ];
  for (const egg of chocolateEggs) addPeg(egg.id, egg.x, egg.y, egg.radius, egg.color);

  const spawnX = boardCenter + seedRng.range(-110, 110);
  objects.push({
    id: 'easter_spawner',
    type: 'spawner',
    x: spawnX,
    y: 180,
    interval: 0.9,
    maxBalls: 14,
    ballColor: eggPalette[0],
    ballRadius: 17,
    ballVx: 0,
    ballVy: 120,
    ballSpawnJitterX: 18,
    ballSpawnJitterVx: 55,
    ballSpawnJitterVy: 18,
    ballBounce: 1.0,
    ballCollisionSpread: 0.08,
    ballSoftBody: false,
    ballElasticity: 0.12,
    ballRecoverySpeed: 6.5,
    ballWobbleIntensity: 0.04,
    ballWobbleDamping: 10.5,
    ballTrail: true,
    ballTrailLength: 24,
    ballClearTrailOnDeath: true,
    ballLifetime: 0,
    ballFreezeOnTimeout: false,
    ballFixed: false,
    ballWallCurve: 0,
    ballWallDrift: 0,
    ballChangeColorOnBallCollision: false,
    ballDestroyOnSpike: false,
    ballFreezeOnSpike: false,
    colorCycle: true,
  });

  for (let i = 0; i < 3; i++) {
    objects.push({
      id: `easter_start_ball_${i + 1}`,
      type: 'ball',
      x: spawnX + (i - 1) * 18,
      y: 130 - i * 42,
      spawnX: spawnX + (i - 1) * 18,
      spawnY: 130 - i * 42,
      vx: (i - 1) * 16,
      vy: 110,
      radius: 17,
      color: eggPalette[(i + 2) % eggPalette.length],
      trail: true,
      trailLength: 24,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1.0,
      wallCurve: 0,
      wallDrift: 0,
      collisionSpread: 0.08,
      changeColorOnBallCollision: false,
      destroyOnSpike: false,
      freezeOnSpike: false,
      alive: true,
      age: 0,
      motion: 'physics',
      orbitCx: 540, orbitCy: 960, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
      _trail: [],
    });
  }

  const binWidth = boardWidth / binDefs.length - 34;
  for (let i = 0; i < binDefs.length; i++) {
    const bin = binDefs[i];
    objects.push({
      id: bin.id,
      type: 'scoreBin',
      x: boardLeft + boardWidth * ((i + 0.5) / binDefs.length),
      y: 1600,
      width: binWidth,
      height: 410,
      points: bin.points,
      label: bin.label,
      color: bin.color,
      textColor: bin.textColor,
      captureMode: 'settle',
    });
  }

  const events = [
    {
      id: 'easter_gold_flash',
      once: false,
      trigger: { type: 'bucketHit', bucketId: 'bin_gold' },
      action: { type: 'flash', color: '#fde68a' },
    },
    {
      id: 'easter_gold_text',
      once: false,
      trigger: { type: 'bucketHit', bucketId: 'bin_gold' },
      action: { type: 'text', text: 'GOUDEN EI!', seconds: 1.0, color: '#fde68a' },
    },
    {
      id: 'easter_party',
      once: true,
      trigger: { type: 'scoreTotal', points: 260 },
      actions: [
        { type: 'confetti' },
        { type: 'flash', color: '#f9a8d4' },
        { type: 'text', text: 'PAASFEEST', seconds: 1.8, color: '#fff7ed' },
      ],
    },
  ];

  return {
    seed,
    version: 2,
    name: 'Paasei Plinko',
    loopDuration: 22,
    duration: 22,
    satisfying: false,
    physics: { gravity: 1500, friction: 0.12 },
    overlay: {
      title: 'Paasei regen\nvang de chocolade',
      showTimer: false,
      showCounter: false,
      showScore: true,
    },
    visuals: { glow: 1.1, pulse: false },
    randomMode: false,
    stopOnFirstEscape: false,
    endCondition: { type: 'fixed', seconds: 22 },
    objects,
    events,
  };
}

function buildEggHuntOrbitScenario(seed = 84) {
  const cx = 540;
  const cy = 960;
  const seedRng = new SeededRNG(seed).fork(4084);
  const ringDefs = [
    {
      id: 'egg_ring_outer',
      radius: 470,
      thickness: 16,
      rotationSpeed: 0.11,
      color: '#f472b6',
      gradientColors: ['#f472b6', '#fb7185', '#c084fc'],
      gapStart: -Math.PI / 2 - 0.26,
      gapSize: 0.54,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'preset',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 0.9,
      },
    },
    {
      id: 'egg_ring_mid',
      radius: 355,
      thickness: 14,
      rotationSpeed: -0.17,
      color: '#86efac',
      gradientColors: ['#86efac', '#67e8f9', '#c4b5fd'],
      gapStart: Math.PI * 0.08,
      gapSize: 0.66,
    },
    {
      id: 'egg_ring_inner',
      radius: 245,
      thickness: 12,
      rotationSpeed: 0.22,
      color: '#fde68a',
      gradientColors: ['#fde68a', '#f9a8d4', '#93c5fd'],
      gapStart: Math.PI * 0.82,
      gapSize: 0.9,
    },
  ];
  const eggStyles = [
    { base: '#f9a8d4', stripes: ['#ffffff', '#f472b6'], dots: '#fdf2f8' },
    { base: '#c4b5fd', stripes: ['#ffffff', '#8b5cf6'], dots: '#ede9fe' },
    { base: '#93c5fd', stripes: ['#ffffff', '#38bdf8'], dots: '#e0f2fe' },
    { base: '#86efac', stripes: ['#ffffff', '#22c55e'], dots: '#dcfce7' },
    { base: '#fde68a', stripes: ['#ffffff', '#f59e0b'], dots: '#fef3c7' },
    { base: '#fbcfe8', stripes: ['#ffffff', '#ec4899'], dots: '#fdf2f8' },
  ];

  const objects = ringDefs.map((ring) => ({
    id: ring.id,
    type: 'circle',
    x: cx,
    y: cy,
    radius: ring.radius,
    thickness: ring.thickness,
    rotation: 0,
    rotationSpeed: ring.rotationSpeed,
    color: ring.color,
    gradientColors: ring.gradientColors,
    gapStart: ring.gapStart,
    gapSize: ring.gapSize,
    insideOnly: true,
    onGapPass: ring.onGapPass,
  }));

  objects.push({
    id: 'egg_center',
    type: 'ball',
    x: cx,
    y: cy,
    spawnX: cx,
    spawnY: cy,
    vx: 0,
    vy: 0,
    radius: 11,
    color: '#d946ef',
    trail: false,
    clearTrailOnDeath: true,
    lifetime: 0,
    fixed: true,
    bounce: 1,
    destroyOnSpike: false,
    freezeOnSpike: false,
    motion: 'physics',
    orbitCx: cx,
    orbitCy: cy,
    orbitRadius: 280,
    orbitHarmonic: 1,
    orbitPhase: 0,
    orbitDirection: 1,
    lissaRadiusY: 280,
    lissaHarmonicY: 1,
    lissaPhaseY: Math.PI / 2,
  });

  const startRadius = 74;
  const eggCount = 5;
  for (let i = 0; i < eggCount; i++) {
    const baseAngle = -Math.PI / 2 + (i / eggCount) * Math.PI * 2;
    const launchAngle = baseAngle + seedRng.range(-0.34, 0.34);
    const speed = seedRng.range(440, 560);
    const style = eggStyles[i % eggStyles.length];
    const x = cx + Math.cos(baseAngle) * startRadius;
    const y = cy + Math.sin(baseAngle) * startRadius;
    objects.push({
      id: `egg_ball_${i + 1}`,
      type: 'ball',
      x,
      y,
      spawnX: x,
      spawnY: y,
      vx: Math.cos(launchAngle) * speed,
      vy: Math.sin(launchAngle) * speed,
      radius: 22,
      color: style.base,
      eggStyle: {
        stripeColors: style.stripes,
        dotColor: style.dots,
        rotation: baseAngle * 0.35,
      },
      trail: true,
      trailLength: 34,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1,
      wallCurve: 0.18,
      wallDrift: 0.05,
      collisionSpread: 0.3,
      destroyOnSpike: false,
      freezeOnSpike: false,
      motion: 'physics',
      orbitCx: cx,
      orbitCy: cy,
      orbitRadius: 280,
      orbitHarmonic: 1,
      orbitPhase: 0,
      orbitDirection: 1,
      lissaRadiusY: 280,
      lissaHarmonicY: 1,
      lissaPhaseY: Math.PI / 2,
    });
  }

  const events = [
    {
      id: 'egg_hunt_flash',
      once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'flash', color: '#fff7ed' },
    },
    {
      id: 'egg_hunt_confetti',
      once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'confetti' },
    },
    {
      id: 'egg_hunt_text',
      once: true,
      trigger: { type: 'firstEscape' },
      action: {
        type: 'text',
        text: 'GOLDEN EGG!',
        seconds: 2.2,
        size: 92,
        color: '#fff7ed',
        shadowColor: '#f59e0b',
      },
    },
    {
      id: 'egg_hunt_timeout_text',
      once: true,
      trigger: { type: 'time', seconds: 18 },
      action: {
        type: 'text',
        text: 'BASKET CLOSED',
        seconds: 1.3,
        size: 62,
        color: '#fbcfe8',
        shadowColor: '#7c3aed',
      },
    },
  ];

  return {
    seed,
    version: 2,
    name: 'Egg Hunt Orbit',
    easterOrbitVariant: 'egg-hunt-orbit',
    loopDuration: 18,
    duration: 18,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: 'Can an Easter egg escape\nbefore the basket closes?',
      showTimer: false,
      showCounter: false,
      bigCountdown: true,
      countdownMax: 18,
      countdownMode: 'repeatInterval',
      countdownInterval: 18,
      titleY: 92,
      titleSize: 38,
      countdownY: 1770,
      countdownSize: 180,
    },
    visuals: {
      glow: 1.18,
      pulse: false,
      freezeKeepAppearance: true,
    },
    randomMode: false,
    stopOnFirstEscape: true,
    endCondition: { type: 'firstEscapeTail', tail: 2.2 },
    objects,
    events,
  };
}

function buildMemoryMazeScenario(seed = 64) {
  const cx = 540, cy = 960;
  const seedRng = new SeededRNG(seed).fork(641);
  const launchAngle = -Math.PI / 2 + seedRng.range(-0.95, 0.95);
  const speed = 780;
  const objects = [
    {
      id: 'maze_outer',
      type: 'circle',
      x: cx, y: cy,
      radius: 470,
      thickness: 14,
      rotation: 0,
      rotationSpeed: 0.14,
      color: '#c4b5fd',
      gapStart: -0.18,
      gapSize: 0.46,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'preset',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 0.9,
      },
    },
    {
      id: 'maze_mid_1',
      type: 'circle',
      x: cx, y: cy,
      radius: 378,
      thickness: 12,
      rotation: 0,
      rotationSpeed: -0.27,
      color: '#7dd3fc',
      gapStart: Math.PI * 0.2,
      gapSize: 0.54,
      insideOnly: true,
    },
    {
      id: 'maze_mid_2',
      type: 'circle',
      x: cx, y: cy,
      radius: 290,
      thickness: 12,
      rotation: 0,
      rotationSpeed: 0.39,
      color: '#f9a8d4',
      gapStart: -Math.PI * 0.68,
      gapSize: 0.56,
      insideOnly: true,
    },
    {
      id: 'maze_mid_3',
      type: 'circle',
      x: cx, y: cy,
      radius: 206,
      thickness: 10,
      rotation: 0,
      rotationSpeed: -0.52,
      color: '#fde68a',
      gapStart: Math.PI * 0.44,
      gapSize: 0.72,
      insideOnly: true,
    },
    {
      id: 'maze_arc_a',
      type: 'arc',
      x: cx, y: cy,
      radius: 422,
      thickness: 18,
      startAngle: -2.62,
      endAngle: -1.15,
      rotation: 0,
      rotationSpeed: 0.18,
      insideOnly: false,
      color: '#ddd6fe',
    },
    {
      id: 'maze_arc_b',
      type: 'arc',
      x: cx, y: cy,
      radius: 332,
      thickness: 18,
      startAngle: 0.46,
      endAngle: 2.22,
      rotation: 0,
      rotationSpeed: -0.28,
      insideOnly: false,
      color: '#93c5fd',
    },
    {
      id: 'maze_arc_c',
      type: 'arc',
      x: cx, y: cy,
      radius: 246,
      thickness: 16,
      startAngle: -2.95,
      endAngle: -0.92,
      rotation: 0,
      rotationSpeed: 0.34,
      insideOnly: false,
      color: '#fbcfe8',
    },
    {
      id: 'ball_1',
      type: 'ball',
      x: cx,
      y: cy,
      spawnX: cx,
      spawnY: cy,
      vx: Math.cos(launchAngle) * speed,
      vy: Math.sin(launchAngle) * speed,
      radius: 21,
      color: '#f8fafc',
      trail: true,
      trailLength: 40,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1.0,
      wallCurve: 0.18,
      wallDrift: 0.08,
      collisionSpread: 0.1,
      destroyOnSpike: false,
      freezeOnSpike: false,
      motion: 'physics',
      orbitCx: cx, orbitCy: cy, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
    },
  ];
  const events = [
    {
      id: 'maze_finish_fx',
      once: true,
      trigger: { type: 'firstEscape' },
      actions: [
        { type: 'confetti' },
        { type: 'flash', color: '#ddd6fe' },
        { type: 'text', text: 'MEMORIZED', seconds: 1.4 },
      ],
    },
  ];
  return {
    seed,
    version: 2,
    name: 'Memory Maze',
    loopDuration: 18,
    duration: 18,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: 'Memory Maze\nlearn the route',
      showTimer: false,
      showCounter: false,
    },
    visuals: { glow: 1.12, pulse: false },
    randomMode: false,
    stopOnFirstEscape: true,
    endCondition: { type: 'firstEscapeTail', tail: 0.8 },
    objects,
    events,
  };
}

function buildRhythmDropScenario(seed = 75) {
  const seedRng = new SeededRNG(seed).fork(775);
  const objects = [];
  const boardLeft = 120;
  const boardRight = 960;
  const boardWidth = boardRight - boardLeft;
  const boardCenter = (boardLeft + boardRight) * 0.5;
  const pegColors = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24'];
  const notes = [
    60, 60, 67, 60,
    62, 62, 69, 62,
    64, 64, 71, 67,
    60, 67, 69, 72,
  ];
  const binDefs = [
    { id: 'rhythm_bin_kick', points: 20, label: 'KICK', color: '#38bdf8' },
    { id: 'rhythm_bin_snare', points: 30, label: 'SNARE', color: '#a78bfa' },
    { id: 'rhythm_bin_drop', points: 80, label: 'DROP', color: '#f472b6' },
    { id: 'rhythm_bin_clap', points: 30, label: 'CLAP', color: '#34d399' },
    { id: 'rhythm_bin_hat', points: 20, label: 'HAT', color: '#fbbf24' },
  ];
  const addPeg = (id, x, y, radius = 11, color = '#e2e8f0') => {
    objects.push({
      id,
      type: 'ball',
      x, y,
      spawnX: x, spawnY: y,
      vx: 0, vy: 0,
      radius,
      color,
      trail: false,
      clearTrailOnDeath: true,
      lifetime: 0,
      fixed: true,
      bounce: 1.0,
      destroyOnSpike: false,
      freezeOnSpike: false,
      motion: 'physics',
      orbitCx: 540, orbitCy: 960, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
    });
  };

  const rows = 11;
  const rowSpacingY = 84;
  const rowSpacingX = 94;
  for (let row = 0; row < rows; row++) {
    const count = row + 3;
    const y = 360 + row * rowSpacingY;
    const startX = boardCenter - ((count - 1) * rowSpacingX) * 0.5;
    for (let i = 0; i < count; i++) {
      addPeg(`rhythm_peg_${row}_${i}`, startX + i * rowSpacingX, y, 11, pegColors[(row + i) % pegColors.length]);
    }
  }

  const spawnX = boardCenter + seedRng.range(-80, 80);
  objects.push({
    id: 'rhythm_spawner',
    type: 'spawner',
    x: spawnX,
    y: 180,
    interval: 0.75,
    maxBalls: 16,
    ballColor: '#38bdf8',
    ballRadius: 16,
    ballVx: 0,
    ballVy: 105,
    ballSpawnJitterX: 14,
    ballSpawnJitterVx: 28,
    ballSpawnJitterVy: 12,
    ballBounce: 1.0,
    ballCollisionSpread: 0.08,
    ballSoftBody: false,
    ballElasticity: 0.12,
    ballRecoverySpeed: 6.5,
    ballWobbleIntensity: 0.04,
    ballWobbleDamping: 10.5,
    ballTrail: true,
    ballTrailLength: 20,
    ballClearTrailOnDeath: true,
    ballLifetime: 0,
    ballFreezeOnTimeout: false,
    ballFixed: false,
    ballWallCurve: 0,
    ballWallDrift: 0,
    ballChangeColorOnBallCollision: false,
    ballDestroyOnSpike: false,
    ballFreezeOnSpike: false,
    colorCycle: true,
  });

  for (let i = 0; i < 2; i++) {
    objects.push({
      id: `rhythm_start_ball_${i + 1}`,
      type: 'ball',
      x: spawnX + (i === 0 ? -14 : 14),
      y: 132 - i * 36,
      spawnX: spawnX + (i === 0 ? -14 : 14),
      spawnY: 132 - i * 36,
      vx: i === 0 ? -12 : 12,
      vy: 105,
      radius: 16,
      color: pegColors[(i + 1) % pegColors.length],
      trail: true,
      trailLength: 20,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1.0,
      wallCurve: 0,
      wallDrift: 0,
      collisionSpread: 0.08,
      changeColorOnBallCollision: false,
      destroyOnSpike: false,
      freezeOnSpike: false,
      alive: true,
      age: 0,
      motion: 'physics',
      orbitCx: 540, orbitCy: 960, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
      _trail: [],
    });
  }

  const binWidth = boardWidth / binDefs.length - 28;
  for (let i = 0; i < binDefs.length; i++) {
    const bin = binDefs[i];
    objects.push({
      id: bin.id,
      type: 'scoreBin',
      x: boardLeft + boardWidth * ((i + 0.5) / binDefs.length),
      y: 1600,
      width: binWidth,
      height: 390,
      points: bin.points,
      label: bin.label,
      color: bin.color,
      textColor: '#ffffff',
      captureMode: 'settle',
      scoreTrigger: 'bottom',
    });
  }

  const events = [
    {
      id: 'rhythm_beat_flash',
      once: false,
      trigger: { type: 'everySeconds', seconds: 0.75 },
      action: { type: 'flash', color: '#10172a' },
    },
    {
      id: 'rhythm_drop_flash',
      once: false,
      trigger: { type: 'bucketHit', bucketId: 'rhythm_bin_drop' },
      actions: [
        { type: 'flash', color: '#f472b6' },
        { type: 'text', text: 'DROP!', seconds: 0.8 },
      ],
    },
    {
      id: 'rhythm_big_finish',
      once: true,
      trigger: { type: 'scoreTotal', points: 260 },
      actions: [
        { type: 'confetti' },
        { type: 'flash', color: '#7dd3fc' },
        { type: 'text', text: 'ON BEAT', seconds: 1.6 },
      ],
    },
  ];

  return {
    seed,
    version: 2,
    name: 'Rhythm Drop',
    loopDuration: 18,
    duration: 18,
    satisfying: false,
    physics: { gravity: 1500, friction: 0.12 },
    overlay: {
      title: 'Rhythm Drop',
      showTimer: false,
      showCounter: false,
      showScore: true,
    },
    visuals: { glow: 1.14, pulse: false },
    randomMode: false,
    melody: {
      enabled: true,
      triggerSources: ['fixedBall', 'ballBall'],
      notes,
      loop: true,
      wave: 'triangle',
      gain: 0.3,
      decay: 0.14,
    },
    stopOnFirstEscape: false,
    endCondition: { type: 'fixed', seconds: 18 },
    objects,
    events,
  };
}

function buildPredictionGatesScenario(seed = 91) {
  const cx = 540, cy = 960;
  const seedRng = new SeededRNG(seed).fork(991);
  const launchAngle = -Math.PI / 2 + seedRng.range(-0.58, 0.58);
  const speed = 980;
  const objects = [
    {
      id: 'pred_outer',
      type: 'circle',
      x: cx, y: cy,
      radius: 470,
      thickness: 14,
      rotation: 0,
      rotationSpeed: 0.18,
      color: '#67e8f9',
      gapStart: -0.16,
      gapSize: 0.36,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'preset',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 0.9,
      },
    },
    {
      id: 'pred_gate_1',
      type: 'circle',
      x: cx, y: cy,
      radius: 372,
      thickness: 12,
      rotation: 0,
      rotationSpeed: -0.29,
      color: '#93c5fd',
      gapStart: Math.PI * 0.18,
      gapSize: 0.42,
      insideOnly: true,
    },
    {
      id: 'pred_gate_2',
      type: 'circle',
      x: cx, y: cy,
      radius: 278,
      thickness: 11,
      rotation: 0,
      rotationSpeed: 0.41,
      color: '#c4b5fd',
      gapStart: -Math.PI * 0.6,
      gapSize: 0.48,
      insideOnly: true,
    },
    {
      id: 'pred_gate_3',
      type: 'circle',
      x: cx, y: cy,
      radius: 188,
      thickness: 10,
      rotation: 0,
      rotationSpeed: -0.56,
      color: '#f9a8d4',
      gapStart: Math.PI * 0.42,
      gapSize: 0.58,
      insideOnly: true,
    },
    {
      id: 'ball_1',
      type: 'ball',
      x: cx,
      y: cy,
      spawnX: cx,
      spawnY: cy,
      vx: Math.cos(launchAngle) * speed,
      vy: Math.sin(launchAngle) * speed,
      radius: 19,
      color: '#f8fafc',
      trail: true,
      trailLength: 34,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1.0,
      wallCurve: 0.1,
      wallDrift: 0.04,
      collisionSpread: 0.08,
      destroyOnSpike: false,
      freezeOnSpike: false,
      motion: 'physics',
      orbitCx: cx, orbitCy: cy, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
    },
  ];
  const events = [
    {
      id: 'pred_finish_fx',
      once: true,
      trigger: { type: 'firstEscape' },
      actions: [
        { type: 'confetti' },
        { type: 'flash', color: '#7dd3fc' },
        { type: 'text', text: 'CALLED IT', seconds: 1.2 },
      ],
    },
  ];
  return {
    seed,
    version: 2,
    name: 'Prediction Gates',
    loopDuration: 16,
    duration: 16,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: 'Prediction Gates\nwait, then go',
      showTimer: false,
      showCounter: false,
    },
    visuals: { glow: 1.14, pulse: false },
    randomMode: false,
    stopOnFirstEscape: true,
    endCondition: { type: 'firstEscapeTail', tail: 0.7 },
    objects,
    events,
  };
}

function buildLegendSpikesScenario(seed = 404) {
  const cx = 540;
  const cy = 930;
  const ringRadius = 410;
  const ringThickness = 8;
  const gapSize = 0.42;
  const gapStart = Math.PI - gapSize * 0.45;
  const seedRng = new SeededRNG(seed).fork(10404);
  const palette = ['#178bff', '#15f53b', '#c026d3', '#f43f5e', '#facc15', '#22d3ee'];
  const launchAngle = seedRng.angle();
  const launchSpeed = 560;
  const legendHitAssetId = 'legend_video_hit';

  const objects = [
    {
      id: 'legend_title_1',
      type: 'text',
      x: cx,
      y: 300,
      text: 'LAST TO',
      size: 54,
      color: '#67f5f5',
      align: 'center',
      weight: '900',
    },
    {
      id: 'legend_title_2',
      type: 'text',
      x: cx,
      y: 376,
      text: 'SURVIVE',
      size: 54,
      color: '#ffffff',
      align: 'center',
      weight: '900',
    },
    {
      id: 'legend_title_3',
      type: 'text',
      x: cx,
      y: 452,
      text: 'VS 200 SPIKES',
      size: 54,
      color: '#ffffff',
      align: 'center',
      weight: '900',
    },
    {
      id: 'legend_ring',
      type: 'circle',
      x: cx,
      y: cy,
      radius: ringRadius,
      thickness: ringThickness,
      rotation: 0,
      rotationSpeed: 0,
      color: '#1d7cff',
      gradientColors: ['#ffffff', '#1d7cff', '#ffffff', '#1d7cff'],
      gapStart,
      gapSize,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'none',
        soundPreset: 'glass',
        soundAssetId: '',
        soundVolume: 1,
      },
    },
    {
      id: 'legend_spikes',
      type: 'spikes',
      x: cx,
      y: cy,
      radius: ringRadius - ringThickness * 0.5,
      count: 200,
      length: 48,
      width: 7,
      inward: true,
      rotation: 0,
      rotationSpeed: 0,
      color: '#f8fafc',
      destroys: false,
      freezes: true,
      gapStart: gapStart - 0.02,
      gapSize: gapSize + 0.04,
    },
    {
      id: 'ball_1',
      type: 'ball',
      x: cx + 70,
      y: cy - 30,
      spawnX: cx + 70,
      spawnY: cy - 30,
      vx: Math.cos(launchAngle) * launchSpeed,
      vy: Math.sin(launchAngle) * launchSpeed,
      radius: 30,
      color: '#178bff',
      trail: true,
      trailLength: 16,
      clearTrailOnDeath: true,
      lifetime: 0,
      randomInitDir: false,
      bounce: 1.0,
      wallCurve: 0.06,
      wallDrift: 0.02,
      collisionSpread: 0.18,
      changeColorOnBallCollision: false,
      destroyOnSpike: false,
      freezeOnSpike: true,
      recolorOnFreeze: true,
      deadColor: '#3f3f46',
      deathBurstOnFreeze: false,
      bounceSound: 'pianoRise',
      bounceSoundOn: 'ballBall',
      deathSound: `asset:${legendHitAssetId}`,
      motion: 'physics',
      orbitCx: cx,
      orbitCy: cy,
      orbitRadius: 280,
      orbitHarmonic: 1,
      orbitPhase: 0,
      orbitDirection: 1,
      lissaRadiusY: 280,
      lissaHarmonicY: 1,
      lissaPhaseY: Math.PI / 2,
    },
  ];

  const events = [
    {
      id: 'legend_next_contender',
      once: false,
      trigger: { type: 'ballFrozen' },
      action: {
        type: 'spawnBall',
        templateId: 'ball_1',
        jitter: 0,
        randomColor: true,
        colorPalette: palette,
      },
    },
    {
      id: 'legend_escape_finish',
      once: true,
      trigger: { type: 'firstEscape' },
      actions: [
        { type: 'confetti' },
        { type: 'text', text: 'ESCAPED', seconds: 1.8, color: '#67f5f5', shadowColor: '#1d7cff', size: 104 },
        { type: 'finish', seconds: 1.8 },
      ],
    },
  ];

  return {
    seed,
    version: 2,
    name: 'Last To Survive',
    loopDuration: 180,
    duration: 180,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: '',
      showTimer: false,
      showCounter: true,
      counterMode: 'ballsUsedPlain',
      counterX: cx,
      counterY: 1510,
      counterSize: 58,
      counterColor: '#fb7185',
      counterShadowColor: '#fb7185',
      showScore: false,
    },
    visuals: { glow: 0.45, pulse: false, freezeKeepAppearance: false },
    randomMode: false,
    stopOnFirstEscape: false,
    soundAssets: {
      [legendHitAssetId]: {
        name: 'legend-clean-pure-echo-hit.mp3',
        mime: 'audio/mpeg',
        dataUrl: 'data:audio/mpeg;base64,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UDYnJXqrVq2JclEkyeaeKo+ko/ASB4pk0rE67AhCM7i5clBqCIUkISXCUrj/+7TE9gIkXezsD2mJw+69HZnMsPiJSMcSaXQRHWB8kiSTeOlWNLrraLqztc+bLuyzNcaXWy36cnsH1ucnvWXLtrtWVufONVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUDjj5DHZTFTDTpzSBgEfCwwcPg1cYl0IHoUXGNNmQEAYuCgBcMRACqCQ/VUZ2/kFtiaO3B9I3SW8M7MPM5UxVWYS0RsbRlspvIcREDHQCBaii21ZknSqAKgUYClgEhzTkXezhpbMGFsZKAn50INGqJOp43jtPhTqxjbF9FG8bp3JFJHaURGR7DuKk2D5PYWUNoHaDgChCDjQKsqhdQ+gpwoAUwkY5CDmQeaacotd6nZUOL6SIdonouw0SgMMwCjJgTMzzsU7Y1qY7T0O9dtT1RGiPodo0B3mGfinbG9cLtSMb95HcTCkBgdA4HhsouWKjQHg4HhsojYbc0hFIiD5D/+7TEf4PlTeyCLT09AAAANIAAAAQjY2kIhGi6A+zLxVSnko16q4PJRUIQ8XXQNsPQoiERAMCoeGzgfDwPhQkfikxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=',
      },
    },
    melody: {
      enabled: false,
      triggerSources: ['ballBall', 'fixedBall'],
      notes: [70],
      loop: true,
      wave: 'sine',
      gain: 0,
      decay: 0.01,
    },
    endCondition: { type: 'finish' },
    objects,
    events,
  };
}

function buildGiantMarbleGauntletScenario(seed = 909) {
  const rng = new SeededRNG(seed).fork(1909);
  const cx = 540;
  const cy = 960;
  const ringRadius = 430;
  const gapSize = 0.58;
  const gapStart = -Math.PI / 4 - gapSize * 0.5;
  const palette = ['#38bdf8', '#f472b6', '#fbbf24', '#34d399', '#a78bfa', '#fb7185', '#22d3ee', '#f97316', '#e879f9', '#84cc16'];
  const objects = [
    {
      id: 'giant_title_1',
      type: 'text',
      x: cx,
      y: 250,
      text: '10 GIANT',
      size: 58,
      color: '#e0f2fe',
      align: 'center',
      weight: '900',
    },
    {
      id: 'giant_title_2',
      type: 'text',
      x: cx,
      y: 324,
      text: 'MARBLES',
      size: 58,
      color: '#ffffff',
      align: 'center',
      weight: '900',
    },
    {
      id: 'giant_title_3',
      type: 'text',
      x: cx,
      y: 394,
      text: 'ONE EXIT',
      size: 44,
      color: '#fbbf24',
      align: 'center',
      weight: '900',
    },
    {
      id: 'giant_ring',
      type: 'circle',
      x: cx,
      y: cy,
      radius: ringRadius,
      thickness: 14,
      rotation: 0,
      rotationSpeed: 0,
      color: '#38bdf8',
      gradientColors: ['#ffffff', '#38bdf8', '#a78bfa', '#38bdf8'],
      gapStart,
      gapSize,
      insideOnly: true,
      onGapPass: {
        enabled: true,
        outcome: 'escape',
        particleStyle: 'auto',
        removeObjectOnPass: false,
        soundMode: 'preset',
        soundPreset: 'chime',
        soundAssetId: '',
        soundVolume: 1,
      },
    },
    {
      id: 'giant_gate_top',
      type: 'spinner',
      x: cx,
      y: cy - 170,
      armLength: 250,
      thickness: 18,
      rotation: 0.35,
      rotationSpeed: 0.7,
      color: '#fbbf24',
      armCount: 2,
    },
    {
      id: 'giant_gate_mid',
      type: 'spinner',
      x: cx,
      y: cy + 20,
      armLength: 305,
      thickness: 20,
      rotation: -0.25,
      rotationSpeed: -0.52,
      color: '#f472b6',
      armCount: 2,
    },
    {
      id: 'giant_gate_low',
      type: 'spinner',
      x: cx,
      y: cy + 205,
      armLength: 230,
      thickness: 18,
      rotation: 0.8,
      rotationSpeed: 0.62,
      color: '#34d399',
      armCount: 2,
    },
  ];

  for (let i = 0; i < 10; i++) {
    const col = i % 5;
    const row = Math.floor(i / 5);
    const x = cx - 200 + col * 100 + rng.range(-12, 12);
    const y = cy - 330 + row * 76 + rng.range(-8, 8);
    const speed = rng.range(165, 245);
    const angle = Math.PI / 2 + rng.range(-0.55, 0.55);
    objects.push({
      id: `giant_marble_${i + 1}`,
      type: 'ball',
      x,
      y,
      spawnX: x,
      spawnY: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 34 + (i % 3) * 3,
      color: palette[i],
      trail: true,
      trailLength: 20,
      clearTrailOnDeath: true,
      lifetime: 0,
      randomInitDir: false,
      bounce: 0.98,
      wallCurve: 0.08,
      wallDrift: 0.02,
      collisionSpread: 0.24,
      softBody: true,
      elasticity: 0.28,
      recoverySpeed: 6.5,
      wobbleIntensity: 0.18,
      wobbleDamping: 8,
      changeColorOnBallCollision: false,
      bounceSound: 'soft',
      bounceSoundOn: 'ballBall',
      escapeSound: 'chime',
      destroyOnSpike: false,
      freezeOnSpike: false,
      alive: true,
      age: 0,
      motion: 'physics',
      orbitCx: cx,
      orbitCy: cy,
      orbitRadius: 280,
      orbitHarmonic: 1,
      orbitPhase: 0,
      orbitDirection: 1,
      lissaRadiusY: 280,
      lissaHarmonicY: 1,
      lissaPhaseY: Math.PI / 2,
      _trail: [],
    });
  }

  const events = [
    {
      id: 'giant_escape_finish',
      once: true,
      trigger: { type: 'firstEscape' },
      actions: [
        { type: 'confetti' },
        { type: 'text', text: 'GIANT\nESCAPED', seconds: 2.0, color: '#fbbf24', shadowColor: '#38bdf8', size: 104 },
        { type: 'finish', seconds: 2.0 },
      ],
    },
  ];

  return {
    seed,
    version: 2,
    name: 'Giant Marble Gauntlet',
    loopDuration: 70,
    duration: 70,
    satisfying: false,
    physics: { gravity: 260, friction: 0.045 },
    overlay: {
      title: '',
      showTimer: false,
      showCounter: true,
      counterMode: 'survivors',
      counterTotal: 10,
      counterX: cx,
      counterY: 1510,
      counterSize: 58,
      counterColor: '#fbbf24',
      counterShadowColor: '#38bdf8',
      showScore: false,
    },
    visuals: { glow: 0.75, pulse: false, freezeKeepAppearance: true },
    randomMode: false,
    stopOnFirstEscape: false,
    endCondition: { type: 'finish' },
    objects,
    events,
  };
}

function buildSpinnerStormScenario(seed = 126) {
  const seedRng = new SeededRNG(seed).fork(6126);
  const objects = [];
  const cx = 540;
  const palette = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#22d3ee'];
  const spinnerColors = ['#f8fafc', '#38bdf8', '#f472b6', '#fbbf24', '#a78bfa'];
  const binDefs = [
    { id: 'storm_bin_left', points: 10, label: '+10', color: '#38bdf8' },
    { id: 'storm_bin_green', points: 25, label: '+25', color: '#22c55e' },
    { id: 'storm_bin_jackpot', points: 150, label: 'JACKPOT', color: '#fbbf24' },
    { id: 'storm_bin_pink', points: 25, label: '+25', color: '#f472b6' },
    { id: 'storm_bin_right', points: 10, label: '+10', color: '#a78bfa' },
  ];
  const addWall = (id, x, y, length, rotation, opts = {}) => {
    objects.push({
      id,
      type: 'spinner',
      x,
      y,
      armLength: length,
      thickness: opts.thickness != null ? opts.thickness : 16,
      rotation,
      rotationSpeed: 0,
      color: opts.color || '#334155',
      armCount: 1,
      invisible: !!opts.invisible,
    });
  };
  const addSpinner = (id, x, y, armLength, thickness, rotationSpeed, armCount, color, rotation = 0) => {
    objects.push({
      id,
      type: 'spinner',
      x,
      y,
      armLength,
      thickness,
      rotation,
      rotationSpeed,
      color,
      armCount,
    });
  };

  // Static spinner segments make a narrow funnel without introducing a new wall type.
  addWall('storm_wall_left', 82, 965, 1370, Math.PI / 2);
  addWall('storm_wall_right', 998, 965, 1370, Math.PI / 2);
  addWall('storm_funnel_left', 258, 380, 340, 0.58);
  addWall('storm_funnel_right', 822, 380, 340, -0.58);

  const spinnerDefs = [
    { id: 'storm_spinner_top', x: cx, y: 555, armLength: 440, thickness: 22, speed: 1.45, arms: 3 },
    { id: 'storm_spinner_left', x: 305, y: 805, armLength: 340, thickness: 20, speed: -1.75, arms: 2 },
    { id: 'storm_spinner_right', x: 775, y: 805, armLength: 340, thickness: 20, speed: 1.75, arms: 2 },
    { id: 'storm_spinner_mid', x: cx, y: 1135, armLength: 470, thickness: 24, speed: -1.35, arms: 3 },
    { id: 'storm_spinner_side_l', x: 245, y: 1325, armLength: 190, thickness: 16, speed: 2.15, arms: 2 },
    { id: 'storm_spinner_side_r', x: 835, y: 1325, armLength: 190, thickness: 16, speed: -2.15, arms: 2 },
  ];
  spinnerDefs.forEach((def, i) => {
    addSpinner(
      def.id,
      def.x,
      def.y,
      def.armLength,
      def.thickness,
      def.speed,
      def.arms,
      spinnerColors[i % spinnerColors.length],
      seedRng.range(-Math.PI, Math.PI),
    );
  });

  const spawnInterval = 0.22 * 1.4 * 1.2;
  objects.push({
    id: 'storm_spawner',
    type: 'spawner',
    x: cx + seedRng.range(-35, 35),
    y: 170,
    interval: spawnInterval,
    maxBalls: 90,
    ballColor: '#38bdf8',
    ballRadius: 13,
    ballVx: 0,
    ballVy: 90,
    ballSpawnJitterX: 105,
    ballSpawnJitterVx: 60,
    ballSpawnJitterVy: 18,
    ballBehaviorPreset: 'custom',
    ballMaxSpeed: 620,
    ballBounce: 0.94,
    ballWallCurve: 0.06,
    ballWallDrift: 0.02,
    ballCollisionSpread: 0.1,
    ballSoftBody: false,
    ballElasticity: 0.2,
    ballRecoverySpeed: 7,
    ballWobbleIntensity: 0.08,
    ballWobbleDamping: 10,
    ballTrail: true,
    ballTrailLength: 12,
    ballClearTrailOnDeath: true,
    ballLifetime: 0,
    ballFreezeOnTimeout: false,
    ballFixed: false,
    ballChangeColorOnBallCollision: true,
    ballDestroyOnSpike: false,
    ballFreezeOnSpike: false,
    ballBounceSound: 'legendChime',
    colorCycle: true,
  });

  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + seedRng.range(-0.9, 0.9);
    const speed = seedRng.range(70, 140);
    const x = cx + seedRng.range(-120, 120);
    const y = 155 - i * 24;
    objects.push({
      id: `storm_start_ball_${i + 1}`,
      type: 'ball',
      x,
      y,
      spawnX: x,
      spawnY: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed + 170,
      radius: 13,
      color: palette[i % palette.length],
      trail: true,
      trailLength: 12,
      clearTrailOnDeath: true,
      lifetime: 0,
      ballBehaviorPreset: 'custom',
      maxSpeed: 620,
      bounce: 0.94,
      wallCurve: 0.06,
      wallDrift: 0.02,
      collisionSpread: 0.1,
      softBody: false,
      elasticity: 0.2,
      recoverySpeed: 7,
      wobbleIntensity: 0.08,
      wobbleDamping: 10,
      changeColorOnBallCollision: true,
      bounceSound: 'legendChime',
      destroyOnSpike: false,
      freezeOnSpike: false,
      alive: true,
      age: 0,
      motion: 'physics',
      orbitCx: cx,
      orbitCy: 960,
      orbitRadius: 280,
      orbitHarmonic: 1,
      orbitPhase: 0,
      orbitDirection: 1,
      lissaRadiusY: 280,
      lissaHarmonicY: 1,
      lissaPhaseY: Math.PI / 2,
      _trail: [],
    });
  }

  const binWidth = 116;
  const binHeight = 290;
  for (let i = 0; i < binDefs.length; i++) {
    const bin = binDefs[i];
    const binX = 140 + i * 200;
    const binY = 1665;
    objects.push({
      id: bin.id,
      type: 'scoreBin',
      x: binX,
      y: binY,
      width: binWidth,
      captureWidth: 62,
      height: binHeight,
      points: bin.points,
      label: bin.label,
      color: bin.color,
      textColor: '#ffffff',
      captureMode: 'settle',
      scoreTrigger: 'bottom',
    });
    const wallThickness = 12;
    const topOpen = 28;
    const wallLength = binHeight - topOpen;
    const wallCenterY = binY - binHeight * 0.5 + topOpen + wallLength * 0.5;
    addWall(`storm_${bin.id}_wall_l`, binX - binWidth * 0.5, wallCenterY, wallLength, Math.PI / 2, {
      thickness: wallThickness,
      invisible: true,
    });
    addWall(`storm_${bin.id}_wall_r`, binX + binWidth * 0.5, wallCenterY, wallLength, Math.PI / 2, {
      thickness: wallThickness,
      invisible: true,
    });
  }

  const totalBalls = 150;
  const starterBalls = 10;
  const finishAt = (totalBalls - starterBalls - 1) * spawnInterval;
  const events = [
    {
      id: 'storm_jackpot_flash',
      once: false,
      trigger: { type: 'bucketHit', bucketId: 'storm_bin_jackpot' },
      action: { type: 'text', text: 'JACKPOT!', seconds: 0.7, color: '#fef3c7', shadowColor: '#f59e0b', size: 86 },
    },
    {
      id: 'storm_finish_100',
      once: true,
      trigger: { type: 'time', seconds: finishAt },
      actions: [
        { type: 'shatter', pieces: 9000, burstScale: 0.42 },
        { type: 'text', text: 'SCORE\n{score}', seconds: 2.4, color: '#ffffff', shadowColor: '#38bdf8', size: 110 },
        { type: 'finish', seconds: 2.4 },
      ],
    },
  ];

  return {
    seed,
    version: 2,
    name: 'Spinner Storm',
    loopDuration: 56,
    duration: 56,
    satisfying: false,
    physics: { gravity: 760, friction: 0.16 },
    overlay: {
      title: '150 balls vs\n6 spinning blades',
      showTimer: false,
      showCounter: true,
      counterMode: 'ballsUsedPlain',
      counterX: 58,
      counterY: 110,
      counterSize: 54,
      counterAlign: 'left',
      showScore: true,
      titleY: 84,
      titleSize: 42,
    },
    visuals: { glow: 1.22, pulse: false, freezeKeepAppearance: true },
    randomMode: false,
    stopOnFirstEscape: false,
    melody: {
      enabled: true,
      triggerSources: ['spinner', 'ballBall', 'fixedBall'],
      notes: [60, 67, 72, 74, 72, 67, 64, 69],
      loop: true,
      wave: 'triangle',
      gain: 0.24,
      decay: 0.10,
    },
    endCondition: { type: 'finish' },
    objects,
    events,
  };
}

function buildBranchMazeScenario(seed = 112, variant = 'repo-a') {
  const cx = 540, cy = 960;
  const seedRng = new SeededRNG(seed).fork(1112);
  const palette = ['#a78bfa', '#7dd3fc', '#f9a8d4', '#fde68a'];
  const ballColor = palette[Math.floor(seedRng.range(0, palette.length))];
  const objects = [];
  const wallColor = '#c7d2fe';
  const trimColor = '#64748b';
  const wallThickness = 7;
  const trimThickness = 6;
  const variantDefs = {
    'repo-a': { name: 'Maze A', title: 'Branch Maze\nrepo A', cols: 14, rows: 8, cell: 56, salt: 1, ballSpeed: 82 },
    'repo-b': { name: 'Maze B', title: 'Branch Maze\nrepo B', cols: 16, rows: 8, cell: 52, salt: 2, ballSpeed: 82 },
    'repo-c': { name: 'Maze C', title: 'Branch Maze\nrepo C', cols: 13, rows: 9, cell: 54, salt: 3, ballSpeed: 82 },
    'repo-d': { name: 'Maze D', title: 'Branch Maze\nrepo D', cols: 15, rows: 9, cell: 50, salt: 4, ballSpeed: 82 },
    'tower-45': {
      name: 'The Long Way Out',
      title: 'The Long Way Out\nfind the exit in 45 seconds',
      cols: 10,
      rows: 20,
      cell: 50,
      salt: 45,
      mazeTop: 360,
      loopDuration: 45,
      duration: 45,
      countdownSeconds: 45,
      titleY: 92,
      titleSize: 40,
      ballSpeed: 78,
      textOnEscape: 'OUT IN TIME',
      countdownY: 1770,
      countdownSize: 220,
    },
    'tower-45-b': {
      name: 'The Long Way Out II',
      title: 'Can the ball find the exit\nin 30 seconds?',
      cols: 10,
      rows: 20,
      cell: 50,
      salt: 145,
      mazeTop: 360,
      loopDuration: 30,
      duration: 30,
      countdownSeconds: 30,
      titleY: 92,
      titleSize: 40,
      ballSpeed: 78,
      textOnEscape: 'OUT IN TIME',
      countdownY: 1770,
      countdownSize: 220,
    },
    'tower-45-c': {
      name: 'The Long Way Out III',
      title: 'Can the ball find the exit\nin 30 seconds?',
      cols: 10,
      rows: 20,
      cell: 50,
      salt: 245,
      mazeTop: 360,
      loopDuration: 30,
      duration: 30,
      countdownSeconds: 30,
      titleY: 92,
      titleSize: 40,
      ballSpeed: 78,
      textOnEscape: 'OUT IN TIME',
      countdownY: 1770,
      countdownSize: 220,
    },
    'tower-45-d': {
      name: 'The Long Way Out IV',
      title: 'Can the ball find the exit\nin 25 seconds?',
      cols: 10,
      rows: 20,
      cell: 50,
      salt: 345,
      mazeTop: 360,
      loopDuration: 25,
      duration: 25,
      countdownSeconds: 25,
      titleY: 92,
      titleSize: 40,
      ballSpeed: 78,
      textOnEscape: 'OUT IN TIME',
      countdownY: 1770,
      countdownSize: 220,
    },
    'tower-45-e': {
      name: 'The Long Way Out V',
      title: 'Can the ball find the exit\nin 40 seconds?',
      cols: 10,
      rows: 20,
      cell: 50,
      salt: 445,
      mazeTop: 360,
      loopDuration: 40,
      duration: 40,
      countdownSeconds: 40,
      titleY: 92,
      titleSize: 40,
      ballSpeed: 72,
      textOnEscape: 'OUT IN TIME',
      countdownY: 1770,
      countdownSize: 220,
      attempts: 260,
      depthWeight: 18,
      bottomWeight: 6,
      tWeight: 26,
      crossWeight: 12,
      deadEndWeight: 4,
      horizontalSpreadWeight: 0.12,
      targetSolutionDepth: 84,
      goalDepthPenaltyWeight: 85,
    },
    'tower-count': {
      name: 'Balls to Escape',
      title: 'How Many Balls\nUntil One Escapes?',
      cols: 11,
      rows: 23,
      cell: 44,
      salt: 46,
      mazeTop: 320,
      loopDuration: 36,
      duration: 36,
      titleY: 90,
      titleSize: 34,
      ballSpeed: 76,
      textOnEscape: 'FIRST ONE OUT',
      showCounter: true,
      counterMode: 'ballsUsed',
      counterLabel: 'BALLS',
    },
    'tower-count-b': {
      name: 'Balls to Escape II',
      title: 'How Many Balls\nUntil One Escapes? II',
      cols: 11,
      rows: 23,
      cell: 44,
      salt: 146,
      mazeTop: 320,
      loopDuration: 36,
      duration: 36,
      titleY: 90,
      titleSize: 34,
      ballSpeed: 76,
      textOnEscape: 'FIRST ONE OUT',
      showCounter: true,
      counterMode: 'ballsUsed',
      counterLabel: 'BALLS',
    },
    'tower-count-c': {
      name: 'Balls to Escape III',
      title: 'How Many Balls\nUntil One Escapes? III',
      cols: 11,
      rows: 23,
      cell: 44,
      salt: 246,
      mazeTop: 320,
      loopDuration: 36,
      duration: 36,
      titleY: 90,
      titleSize: 34,
      ballSpeed: 76,
      textOnEscape: 'FIRST ONE OUT',
      showCounter: true,
      counterMode: 'ballsUsed',
      counterLabel: 'BALLS',
    },
    'tower-count-d': {
      name: 'Balls to Escape IV',
      title: 'How Many Balls\nUntil One Escapes? IV',
      cols: 11,
      rows: 23,
      cell: 44,
      salt: 346,
      mazeTop: 320,
      loopDuration: 36,
      duration: 36,
      titleY: 90,
      titleSize: 34,
      ballSpeed: 76,
      textOnEscape: 'FIRST ONE OUT',
      showCounter: true,
      counterMode: 'ballsUsed',
      counterLabel: 'BALLS',
    },
    'tower-count-e': {
      name: 'Balls to Escape V',
      title: 'How Many Balls\nUntil One Escapes? V',
      cols: 11,
      rows: 23,
      cell: 44,
      salt: 446,
      mazeTop: 320,
      loopDuration: 36,
      duration: 36,
      titleY: 90,
      titleSize: 34,
      ballSpeed: 76,
      textOnEscape: 'FIRST ONE OUT',
      showCounter: true,
      counterMode: 'ballsUsed',
      counterLabel: 'BALLS',
    },
  };
  const variantDef = variantDefs[variant] || variantDefs['repo-a'];
  const cols = variantDef.cols;
  const rows = variantDef.rows;
  const cell = variantDef.cell;
  const ballRadius = Math.max(10, Math.round(cell * 0.22));
  const branchWallHalf = Math.max(6, Math.round(ballRadius * 0.75));
  const mazeTop = variantDef.mazeTop != null ? variantDef.mazeTop : 460;
  const rootCol = (cols / 2) | 0;
  const branchMazeRotationSpeed = 0;
  const N = 'n', S = 's', W = 'w', E = 'e';
  const dirVectors = {
    [N]: { x: 0, y: -1 },
    [S]: { x: 0, y: 1 },
    [W]: { x: -1, y: 0 },
    [E]: { x: 1, y: 0 },
  };
  const opposite = { [N]: S, [S]: N, [W]: E, [E]: W };
  const perpendicular = {
    [N]: [W, E],
    [S]: [E, W],
    [W]: [S, N],
    [E]: [N, S],
  };
  const createCells = () => {
    const cells = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        cells.push({
          id: `cell_${x}_${y}`,
          x,
          y,
          walls: new Set([N, S, E, W]),
          parent: null,
          incoming: null,
          children: [],
        });
      }
    }
    return cells;
  };
  const buildMazeAttempt = (rng) => {
    const cells = createCells();
    const getCell = (x, y) => (x >= 0 && x < cols && y >= 0 && y < rows ? cells[x + y * cols] : null);
    const neighbors = (cellObj) => {
      const result = [];
      for (const dir of [N, S, W, E]) {
        const vec = dirVectors[dir];
        const neighbor = getCell(cellObj.x + vec.x, cellObj.y + vec.y);
        if (neighbor) result.push({ dir, cell: neighbor });
      }
      return result;
    };
    const isFull = (cellObj) => cellObj.walls.size === 4;
    const connect = (a, b, dir) => {
      a.walls.delete(dir);
      b.walls.delete(opposite[dir]);
    };
    let current = cells[rng.int(0, cells.length - 1)];
    const stack = [];
    let visited = 1;
    while (visited < cells.length) {
      const unvisited = neighbors(current).filter(({ cell }) => isFull(cell));
      if (unvisited.length) {
        const pick = unvisited[rng.int(0, unvisited.length - 1)];
        connect(current, pick.cell, pick.dir);
        stack.push(current);
        current = pick.cell;
        visited++;
      } else {
        current = stack.pop();
      }
    }
    const degree = (cellObj) => 4 - cellObj.walls.size + (cellObj.x === rootCol && cellObj.y === 0 ? 1 : 0);
    const tCount = cells.filter((cellObj) => degree(cellObj) === 3).length;
    const crossCount = cells.filter((cellObj) => degree(cellObj) >= 4).length;
    const deadEnds = cells.filter((cellObj) => degree(cellObj) === 1).length;
    const horizontalSpread = cells.reduce((sum, cellObj) => sum + Math.abs(cellObj.x - rootCol), 0);
    const topEntryCandidates = cells.filter((cellObj) => cellObj.y === 0 && !cellObj.walls.has(S));
    const root = (topEntryCandidates.length ? topEntryCandidates : [getCell(rootCol, 0)]).reduce((best, cellObj) => {
      if (!best) return cellObj;
      return Math.abs(cellObj.x - rootCol) < Math.abs(best.x - rootCol) ? cellObj : best;
    }, null);
    let maxDepth = 0;
    let deepestY = 0;
    let goalDepth = 0;
    if (root) {
      for (const cellObj of cells) {
        cellObj.parent = null;
        cellObj.incoming = null;
        cellObj.children = [];
      }
      root.incoming = S;
      const traversal = [{ node: root, depth: 0 }];
      const seen = new Set([root.id]);
      while (traversal.length) {
        const { node, depth } = traversal.pop();
        if (depth > maxDepth) maxDepth = depth;
        if (node.y > deepestY) deepestY = node.y;
        for (const dir of [N, E, S, W]) {
          if (node.walls.has(dir)) continue;
          const vec = dirVectors[dir];
          const next = getCell(node.x + vec.x, node.y + vec.y);
          if (!next || seen.has(next.id)) continue;
          seen.add(next.id);
          next.parent = node;
          next.incoming = dir;
          node.children.push({ dir, node: next });
          traversal.push({ node: next, depth: depth + 1 });
        }
      }
      const previewCellDepth = (cellObj) => {
        let depth = 0;
        let cur = cellObj;
        while (cur && cur.parent) {
          depth++;
          cur = cur.parent;
        }
        return depth;
      };
      const previewLeaves = cells.filter((cellObj) => cellObj.children.length === 0);
      const previewExitCandidates = previewLeaves.filter((cellObj) => {
        if (!cellObj.incoming) return false;
        const vec = dirVectors[cellObj.incoming];
        return !getCell(cellObj.x + vec.x, cellObj.y + vec.y);
      });
      const previewScoredLeaf = (cellObj) => {
        const depth = previewCellDepth(cellObj);
        let score = depth * 5 + cellObj.y * 2 + Math.abs(cellObj.x - root.x) * 0.5;
        if (variantDef.targetSolutionDepth != null) {
          const penalty = variantDef.goalDepthPenaltyWeight != null ? variantDef.goalDepthPenaltyWeight : 20;
          score -= Math.abs(depth - variantDef.targetSolutionDepth) * penalty;
        }
        return score;
      };
      const previewGoalCell = (previewExitCandidates.length ? previewExitCandidates : previewLeaves).reduce((best, cellObj) => {
        if (!best) return cellObj;
        return previewScoredLeaf(cellObj) > previewScoredLeaf(best) ? cellObj : best;
      }, null);
      goalDepth = previewGoalCell ? previewCellDepth(previewGoalCell) : 0;
    }
    const score = tCount * (variantDef.tWeight != null ? variantDef.tWeight : 30)
      + crossCount * (variantDef.crossWeight != null ? variantDef.crossWeight : 10)
      + deadEnds * (variantDef.deadEndWeight != null ? variantDef.deadEndWeight : 2)
      + horizontalSpread * (variantDef.horizontalSpreadWeight != null ? variantDef.horizontalSpreadWeight : 0.2)
      + maxDepth * (variantDef.depthWeight != null ? variantDef.depthWeight : 0)
      + deepestY * (variantDef.bottomWeight != null ? variantDef.bottomWeight : 0)
      - (variantDef.targetSolutionDepth != null
        ? Math.abs(goalDepth - variantDef.targetSolutionDepth) * (variantDef.goalDepthPenaltyWeight != null ? variantDef.goalDepthPenaltyWeight : 20)
        : 0);
    return { cells, getCell, score };
  };
  let bestAttempt = null;
  const attemptCount = Math.max(1, variantDef.attempts != null ? (variantDef.attempts | 0) : 18);
  for (let i = 0; i < attemptCount; i++) {
    const attempt = buildMazeAttempt(seedRng.fork(variantDef.salt * 100 + i + 1));
    if (!bestAttempt || attempt.score > bestAttempt.score) bestAttempt = attempt;
  }
  const cells = bestAttempt.cells;
  const getCell = bestAttempt.getCell;
  const topEntryCandidates = cells.filter((cellObj) => cellObj.y === 0 && !cellObj.walls.has(S));
  const root = (topEntryCandidates.length ? topEntryCandidates : [getCell(rootCol, 0)]).reduce((best, cellObj) => {
    if (!best) return cellObj;
    return Math.abs(cellObj.x - rootCol) < Math.abs(best.x - rootCol) ? cellObj : best;
  }, null);
  for (const cellObj of cells) {
    cellObj.parent = null;
    cellObj.incoming = null;
    cellObj.children = [];
  }
  root.walls.delete(N);
  root.incoming = S;
  const neighbors = (cellObj) => {
    const result = [];
    for (const dir of [N, S, W, E]) {
      const vec = dirVectors[dir];
      const neighbor = getCell(cellObj.x + vec.x, cellObj.y + vec.y);
      if (neighbor) result.push({ dir, cell: neighbor });
    }
    return result;
  };
  const stack = [root];
  const seen = new Set([root.id]);
  while (stack.length) {
    const current = stack.pop();
    for (const dir of [N, E, S, W]) {
      if (current.walls.has(dir)) continue;
      const vec = dirVectors[dir];
      const next = getCell(current.x + vec.x, current.y + vec.y);
      if (!next || seen.has(next.id)) continue;
      seen.add(next.id);
      next.parent = current;
      next.incoming = dir;
      current.children.push({ dir, node: next });
      stack.push(next);
    }
  }
  const cellDepth = (cellObj) => {
    let depth = 0;
    let cur = cellObj;
    while (cur && cur.parent) {
      depth++;
      cur = cur.parent;
    }
    return depth;
  };
  const leaves = cells.filter((cellObj) => cellObj.children.length === 0);
  const exitCandidates = leaves.filter((cellObj) => {
    if (!cellObj.incoming) return false;
    const vec = dirVectors[cellObj.incoming];
    return !getCell(cellObj.x + vec.x, cellObj.y + vec.y);
  });
  const scoredLeaf = (cellObj) => {
    const depth = cellDepth(cellObj);
    let score = depth * 5 + cellObj.y * 2 + Math.abs(cellObj.x - root.x) * 0.5;
    if (variantDef.targetSolutionDepth != null) {
      const penalty = variantDef.goalDepthPenaltyWeight != null ? variantDef.goalDepthPenaltyWeight : 20;
      score -= Math.abs(depth - variantDef.targetSolutionDepth) * penalty;
    }
    return score;
  };
  const goalCell = (exitCandidates.length ? exitCandidates : leaves).reduce((best, cellObj) => {
    if (!best) return cellObj;
    return scoredLeaf(cellObj) > scoredLeaf(best) ? cellObj : best;
  }, null);
  const goalExitSide = goalCell && goalCell.incoming ? goalCell.incoming : S;
  const toPixel = (cellObj) => ({
    x: cx + (cellObj.x - (cols - 1) * 0.5) * cell,
    y: mazeTop + cellObj.y * cell,
  });
  const mazeOrbitCx = cx;
  const mazeOrbitCy = mazeTop + (rows - 1) * cell * 0.5;
  const addWallSegment = (id, ax, ay, bx, by, opts = {}) => {
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= 1e-6) return;
    const centerX = (ax + bx) * 0.5;
    const centerY = (ay + by) * 0.5;
    const rotation = Math.atan2(by - ay, bx - ax);
    const branchOrigin = opts.branchOrigin || null;
    objects.push({
      id,
      type: 'spinner',
      x: centerX,
      y: centerY,
      armLength: len,
      thickness: opts.thickness != null ? opts.thickness : wallThickness,
      rotation,
      rotationSpeed: 0,
      color: opts.color || wallColor,
      armCount: 1,
      mazeWall: !!opts.mazeWall,
      mazeBranchTrigger: !!opts.mazeBranchTrigger,
      mazeBranchDirs: Array.isArray(opts.branchDirs)
        ? opts.branchDirs.map((dir) => ({ x: Math.sign(dir.x || 0), y: Math.sign(dir.y || 0) }))
        : undefined,
      mazeBranchOriginX: branchOrigin ? branchOrigin.x : undefined,
      mazeBranchOriginY: branchOrigin ? branchOrigin.y : undefined,
      mazeBranchBaseOriginX: branchOrigin ? branchOrigin.x : undefined,
      mazeBranchBaseOriginY: branchOrigin ? branchOrigin.y : undefined,
      branchMazeWall: true,
      invisible: !!opts.invisible,
      mazeSpinSpeed: branchMazeRotationSpeed,
      mazeOrbitCx,
      mazeOrbitCy,
      mazeBaseX: centerX,
      mazeBaseY: centerY,
      mazeBaseRotation: rotation,
    });
  };
  for (const cellObj of cells) {
    const p = toPixel(cellObj);
    const left = p.x - cell * 0.5;
    const right = p.x + cell * 0.5;
    const top = p.y - cell * 0.5;
    const bottom = p.y + cell * 0.5;
    if (cellObj.walls.has(N) && !(cellObj === root) && !(cellObj === goalCell && goalExitSide === N)) {
      addWallSegment(`wall_n_${cellObj.id}`, left, top, right, top);
    }
    if (cellObj.walls.has(W) && !(cellObj === goalCell && goalExitSide === W)) {
      addWallSegment(`wall_w_${cellObj.id}`, left, top, left, bottom);
    }
    if (cellObj.y === rows - 1 && cellObj.walls.has(S) && !(cellObj === goalCell && goalExitSide === S)) {
      addWallSegment(`wall_s_${cellObj.id}`, left, bottom, right, bottom);
    }
    if (cellObj.x === cols - 1 && cellObj.walls.has(E) && !(cellObj === goalCell && goalExitSide === E)) {
      addWallSegment(`wall_e_${cellObj.id}`, right, top, right, bottom);
    }
  }
  for (const cellObj of cells) {
    const childDirs = cellObj.children.map((child) => child.dir);
    // Any cell that is a junction (more than one outgoing corridor) must get a
    // splitter wall, including the root. Without this, the ball just sails
    // straight through the first intersection and side corridors are never
    // explored — which is exactly what the user reported.
    if (childDirs.length <= 1) continue;
    const triggerForward = cellObj.incoming ? dirVectors[cellObj.incoming] : { x: 0, y: 1 };
    const triggerPerp = Math.abs(triggerForward.x) > 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const triggerCenter = toPixel(cellObj);
    addWallSegment(
      `trigger_${cellObj.id}`,
      triggerCenter.x + triggerPerp.x * branchWallHalf,
      triggerCenter.y + triggerPerp.y * branchWallHalf,
      triggerCenter.x - triggerPerp.x * branchWallHalf,
      triggerCenter.y - triggerPerp.y * branchWallHalf,
      {
        mazeBranchTrigger: true,
        branchDirs: childDirs.map((dir) => dirVectors[dir]),
        branchOrigin: triggerCenter,
        thickness: Math.max(4, Math.round(ballRadius * 0.85)),
        // Keep the trigger physics, but draw it like the rest of the maze so
        // branch points do not get an extra "this is where split happens"
        // indicator line.
        color: wallColor,
        invisible: true,
      },
    );
  }
  for (const cellObj of cells) {
    if (cellObj === root) continue;
    if (!cellObj.incoming) continue;
    const forward = cellObj.incoming;
    if (!cellObj.walls.has(forward)) continue;
    if (cellObj === goalCell && goalExitSide === forward) continue;
    const sideDirs = perpendicular[forward].filter((dir) => !cellObj.walls.has(dir));
    const p = toPixel(cellObj);
    const forwardVec = dirVectors[forward];
    const perp = Math.abs(forwardVec.x) > 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const branchCenter = {
      x: p.x + forwardVec.x * (cell * 0.5 - branchWallHalf * 0.6),
      y: p.y + forwardVec.y * (cell * 0.5 - branchWallHalf * 0.6),
    };
    addWallSegment(
      `branch_${cellObj.id}`,
      branchCenter.x + perp.x * branchWallHalf,
      branchCenter.y + perp.y * branchWallHalf,
      branchCenter.x - perp.x * branchWallHalf,
      branchCenter.y - perp.y * branchWallHalf,
      {
        mazeWall: true,
        branchDirs: sideDirs.map((dir) => dirVectors[dir]),
        branchOrigin: branchCenter,
        invisible: true,
      },
    );
  }
  const frameLeft = cx - (cols * cell) * 0.5 - 18;
  const frameRight = cx + (cols * cell) * 0.5 + 18;
  const frameTop = mazeTop - cell * 0.95;
  const frameBottom = mazeTop + (rows - 1) * cell + cell * 0.62;
  addWallSegment('maze_trim_top', frameLeft + 38, frameTop - 18, frameRight - 38, frameTop - 18, {
    color: trimColor,
    thickness: trimThickness,
  });

  const rootPixel = toPixel(root);
  const mazeGridOriginX = cx - (cols - 1) * cell * 0.5;
  const mazeGridOriginY = mazeTop;
  const entryStart = {
    x: rootPixel.x,
    y: rootPixel.y - cell * 0.5 - ballRadius - 6,
  };
  const goalPixel = toPixel(goalCell);
  const goalForwardVec = dirVectors[goalExitSide];
  const mazeExitThreshold = Math.max(12, Math.round(cell * 0.24));
  const mazeExitSpan = Math.max(10, Math.round(cell * 0.34));
  const exitLabelPos = {
    x: goalPixel.x + goalForwardVec.x * (cell * 0.88),
    y: goalPixel.y + goalForwardVec.y * (cell * 0.88),
  };
  objects.push({
    id: 'maze_start_text',
    type: 'text',
    x: rootPixel.x,
    y: frameTop - 44,
    text: 'START',
    size: 22,
    color: '#7dd3fc',
    align: 'center',
    weight: '800',
  });
  objects.push({
    id: 'maze_end_text',
    type: 'text',
    x: exitLabelPos.x,
    y: exitLabelPos.y,
    text: 'EXIT',
    size: 20,
    color: '#fbbf24',
    align: 'center',
    weight: '800',
  });
  objects.push({
    id: 'ball_1',
    type: 'ball',
    x: entryStart.x,
    y: entryStart.y,
    spawnX: entryStart.x,
    spawnY: entryStart.y,
    vx: 0,
    vy: variantDef.ballSpeed != null ? variantDef.ballSpeed : 170,
    radius: ballRadius,
    color: ballColor,
    trail: true,
    trailLength: 24,
    clearTrailOnDeath: true,
    lifetime: 50,
    freezeOnTimeout: true,
    bounce: 1.0,
    wallCurve: 0,
    wallDrift: 0,
    collisionSpread: 0,
    destroyOnSpike: false,
    freezeOnSpike: false,
    mazeBranchOnFixedBounce: true,
    mazeBranchSpeed: variantDef.ballSpeed != null ? variantDef.ballSpeed : 165,
    mazeBranchGraceFrames: 6,
    mazeBranchGeneration: 0,
    mazeBranchMaxGeneration: cols * rows,
    mazeGridCell: cell,
    mazeGridOriginX,
    mazeGridOriginY,
    mazeExitSide: goalExitSide,
    mazeExitX: goalPixel.x,
    mazeExitY: goalPixel.y,
    mazeExitThreshold,
    mazeExitSpan,
    _mazeAxis: 'v',
    _mazeDirX: 0,
    _mazeDirY: 1,
    motion: 'physics',
    orbitCx: cx, orbitCy: cy, orbitRadius: 280,
    orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
    lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
  });

  const events = [
    {
      id: 'maze_goal_text',
      once: true,
      trigger: { type: 'firstEscape' },
      actions: [
        { type: 'flash', color: '#fde68a' },
        { type: 'text', text: variantDef.textOnEscape || 'FOUND THE EXIT', seconds: 1.2, color: '#fde68a' },
      ],
    },
    {
      id: 'maze_done',
      once: true,
      trigger: { type: 'firstEscape' },
      actions: [
        { type: 'confetti' },
        { type: 'shatter', pieces: 10000, burstScale: 1.2 },
        { type: 'flash', color: '#ddd6fe' },
        { type: 'text', text: 'Path found', seconds: 1.4, color: '#93c5fd', shadowColor: '#60a5fa', size: 82 },
      ],
    },
  ];

  return {
    seed,
    version: 2,
    name: variantDef.name,
    branchMazeVariant: variant,
    loopDuration: variantDef.loopDuration != null ? variantDef.loopDuration : 20,
    duration: variantDef.duration != null ? variantDef.duration : 20,
    satisfying: false,
    physics: { gravity: 0, friction: 0 },
    overlay: {
      title: variantDef.title,
      titleY: variantDef.titleY != null ? variantDef.titleY : 86,
      titleSize: variantDef.titleSize != null ? variantDef.titleSize : 38,
      showTimer: false,
      showCounter: !!variantDef.showCounter,
      counterMode: variantDef.counterMode || 'aliveTotal',
      counterLabel: variantDef.counterLabel || '',
      bigCountdown: !!variantDef.countdownSeconds,
      countdownMax: variantDef.countdownSeconds || 0,
      countdownMode: variantDef.countdownSeconds ? 'repeatInterval' : 'loopTime',
      countdownInterval: variantDef.countdownSeconds || 0,
      countdownY: variantDef.countdownY,
      countdownSize: variantDef.countdownSize,
    },
    visuals: { glow: 1.02, pulse: false, freezeKeepAppearance: true },
    randomMode: false,
    stopOnFirstEscape: true,
    branchMazeRotationSpeed: 0,
    endCondition: { type: 'firstEscapeTail', tail: 2.6 },
    objects,
    events,
  };
}

function buildPlinkoScenario(seed = 31) {
  const seedRng = new SeededRNG(seed).fork(911);
  const objects = [];
  const boardLeft = 40;
  const boardRight = 1040;
  const boardWidth = boardRight - boardLeft;
  const boardCenter = (boardLeft + boardRight) * 0.5;
  const pegColors = ['#f8fafc'];
  const binDefs = [
    { id: 'bin_10_l', points: 10, label: '+10', color: '#38bdf8' },
    { id: 'bin_25_l', points: 25, label: '+25', color: '#34d399' },
    { id: 'bin_50_l', points: 50, label: '+50', color: '#f59e0b' },
    { id: 'bin_100', points: 100, label: 'JACKPOT', color: '#fbbf24' },
    { id: 'bin_50_r', points: 50, label: '+50', color: '#f97316' },
    { id: 'bin_25_r', points: 25, label: '+25', color: '#a78bfa' },
  ];

  const addPeg = (id, x, y, radius = 16, color = '#7dd3fc') => {
    objects.push({
      id,
      type: 'ball',
      x, y,
      spawnX: x, spawnY: y,
      vx: 0, vy: 0,
      radius,
      color,
      trail: false,
      clearTrailOnDeath: true,
      lifetime: 0,
      fixed: true,
      bounce: 1.0,
      destroyOnSpike: false,
      freezeOnSpike: false,
      motion: 'physics',
      orbitCx: 540, orbitCy: 960, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
    });
  };

  // Dense, classic plinko triangle: many small pegs and a broad base so balls
  // cascade through the middle instead of taking only a few giant hops.
  const rows = 15;
  const rowSpacingY = 72;
  const rowSpacingX = 90;
  for (let row = 0; row < rows; row++) {
    const count = row + 3;
    const y = 330 + row * rowSpacingY;
    const startX = boardCenter - ((count - 1) * rowSpacingX) * 0.5;
    for (let i = 0; i < count; i++) {
      addPeg(`peg_${row}_${i}`, startX + i * rowSpacingX, y, 10, pegColors[(row + i) % pegColors.length]);
    }
  }

  // Side guide pegs act like a soft funnel: they still read as part of the
  // plinko board, but they push edge-bound balls back inward so escaping out
  // of the sides becomes rare without needing visible walls.
  for (let row = 1; row < rows - 1; row++) {
    const count = row + 3;
    const y = 330 + row * rowSpacingY + rowSpacingY * 0.48;
    const edgeOffset = ((count - 1) * rowSpacingX) * 0.5;
    addPeg(`guide_l_${row}`, boardCenter - edgeOffset - rowSpacingX * 0.42, y, 9, '#e5e7eb');
    addPeg(`guide_r_${row}`, boardCenter + edgeOffset + rowSpacingX * 0.42, y, 9, '#e5e7eb');
  }

  objects.push({
    id: 'plinko_spawner',
    type: 'spawner',
    x: boardCenter,
    y: 190,
    interval: 1.8,
    maxBalls: 12,
    ballColor: '#f59e0b',
    ballRadius: 18,
    ballVx: 0,
    ballVy: 95,
    ballSpawnJitterX: 14,
    ballSpawnJitterVx: 42,
    ballSpawnJitterVy: 16,
    ballBounce: 1.0,
    ballCollisionSpread: 0.08,
    ballSoftBody: false,
    ballElasticity: 0.12,
    ballRecoverySpeed: 6.5,
    ballWobbleIntensity: 0.04,
    ballWobbleDamping: 10.5,
    ballTrail: true,
    ballTrailLength: 22,
    ballClearTrailOnDeath: true,
    ballLifetime: 0,
    ballFreezeOnTimeout: false,
    ballFixed: false,
    ballWallCurve: 0,
    ballWallDrift: 0,
    ballChangeColorOnBallCollision: false,
    ballDestroyOnSpike: false,
    ballFreezeOnSpike: false,
    colorCycle: false,
  });

  for (let i = 0; i < 3; i++) {
    objects.push({
      id: `plinko_start_ball_${i + 1}`,
      type: 'ball',
      x: boardCenter + (i - 1) * 18,
      y: 150 - i * 42,
      spawnX: boardCenter + (i - 1) * 18,
      spawnY: 150 - i * 42,
      vx: i === 0 ? 14 : (i === 2 ? -14 : 0),
      vy: 95,
      radius: 18,
      color: '#f59e0b',
      trail: true,
      trailLength: 22,
      clearTrailOnDeath: true,
      lifetime: 0,
      bounce: 1.0,
      wallCurve: 0,
      wallDrift: 0,
      collisionSpread: 0.08,
      changeColorOnBallCollision: false,
      destroyOnSpike: false,
      freezeOnSpike: false,
      alive: true,
      age: 0,
      motion: 'physics',
      orbitCx: 540, orbitCy: 960, orbitRadius: 280,
      orbitHarmonic: 1, orbitPhase: 0, orbitDirection: 1,
      lissaRadiusY: 280, lissaHarmonicY: 1, lissaPhaseY: Math.PI / 2,
      _trail: [],
    });
  }

  const binWidth = boardWidth / 6 - 44;
  for (let i = 0; i < binDefs.length; i++) {
    const bin = binDefs[i];
    objects.push({
      id: bin.id,
      type: 'scoreBin',
      x: boardLeft + boardWidth * ((i + 0.5) / 6),
      y: 1595,
      width: binWidth,
      height: 420,
      points: bin.points,
      label: bin.label,
      color: bin.color,
      textColor: '#ffffff',
      captureMode: 'settle',
    });
  }

  const events = [
    { id: 'plinko_jackpot_flash', once: false,
      trigger: { type: 'bucketHit', bucketId: 'bin_100' },
      action: { type: 'flash', color: '#fde68a' } },
    { id: 'plinko_big_score', once: true,
      trigger: { type: 'scoreTotal', points: 300 },
      action: { type: 'confetti' } },
    { id: 'plinko_big_score_text', once: true,
      trigger: { type: 'scoreTotal', points: 300 },
      action: { type: 'text', text: 'HIGH SCORE', seconds: 1.8 } },
  ];

  return {
    seed,
    version: 2,
    name: 'Pyramid Plinko',
    loopDuration: 20,
    duration: 20,
    satisfying: false,
    physics: { gravity: 1500, friction: 0.12 },
    overlay: {
      title: 'Pyramid Plinko',
      showTimer: false,
      showCounter: false,
      showScore: true,
    },
    visuals: { glow: 1.15, pulse: false },
    randomMode: false,
    stopOnFirstEscape: false,
    endCondition: { type: 'bucketHitTail', bucketId: 'bin_100', tail: 0 },
    objects,
    events,
  };
}

function buildPinballScenario(seed = 88, themeName = 'neon') {
  const neon = themeName !== 'classic';
  const boosterStrengthScale = 0.8;
  const theme = neon
    ? {
        name: 'Neon Pinball',
        title: 'NEON\nPINBALL',
        backgroundGlow: 1.45,
        pulse: true,
        titleColor: '#f0abfc',
        titleShadow: '#22d3ee',
        rail: '#22d3ee',
        railAlt: '#a78bfa',
        wall: '#38bdf8',
        pegA: '#7dd3fc',
        pegB: '#f472b6',
        bumperA: '#22d3ee',
        bumperB: '#34d399',
        bumperC: '#f472b6',
        jackpot: '#fbbf24',
        accentA: '#f0abfc',
        accentB: '#bbf7d0',
        accentC: '#fbcfe8',
        ball: '#fbbf24',
        leftFlip: '#f472b6',
        rightFlip: '#22d3ee',
        textColor: '#ffffff',
      }
    : {
        name: 'Classic Pinball',
        title: 'CLASSIC\nPINBALL',
        backgroundGlow: 0.7,
        pulse: false,
        titleColor: '#fef3c7',
        titleShadow: '#92400e',
        rail: '#d97706',
        railAlt: '#7c2d12',
        wall: '#92400e',
        pegA: '#f59e0b',
        pegB: '#ef4444',
        bumperA: '#dc2626',
        bumperB: '#2563eb',
        bumperC: '#16a34a',
        jackpot: '#eab308',
        accentA: '#fde68a',
        accentB: '#bfdbfe',
        accentC: '#bbf7d0',
        ball: '#f8fafc',
        leftFlip: '#dc2626',
        rightFlip: '#2563eb',
        textColor: '#fff7ed',
      };
  const objects = [];
  const wall = (id, x, y, armLength, rotation, color = '#38bdf8', thickness = 18, extra = null) => {
    objects.push({
      id,
      type: 'spinner',
      x,
      y,
      armLength,
      thickness,
      rotation,
      rotationSpeed: 0,
      color,
      armCount: 1,
      ...(extra || {}),
    });
  };
  const peg = (id, x, y, radius = 15, color = theme.pegA, points = 0) => {
    objects.push({
      id,
      type: 'ball',
      x, y,
      spawnX: x, spawnY: y,
      vx: 0, vy: 0,
      radius,
      color,
      trail: false,
      fixed: true,
      points,
      label: points ? `+${points}` : '',
      textColor: theme.textColor,
      cooldown: 0.18,
      bounce: 1.12,
      collisionSpread: 0.18,
      destroyOnSpike: false,
      freezeOnSpike: false,
      motion: 'physics',
    });
  };
  const booster = (id, x, y, radius, color, accentColor, points, strength = 760, label = null) => {
    objects.push({
      id,
      type: 'booster',
      x, y,
      radius,
      color,
      accentColor,
      points,
      label: label || `+${points}`,
      strength: id === 'launch_lane_exit_kicker' ? strength : strength * boosterStrengthScale,
      cooldown: 0.12,
    });
  };
  const laneTarget = (id, x, y, points, color) => {
    booster(id, x, y, 32, color, theme.accentA, points, 560);
  };

  objects.push({
    id: 'pinball_plunger',
    type: 'spawner',
    x: 950,
    y: 1740,
    interval: 0.75,
    maxBalls: 3,
    maxActiveBalls: 3,
    maxTotalBalls: 20,
    finishTailSeconds: 1.8,
    ballColor: theme.ball,
    ballRadius: 16,
    ballVx: 0,
    ballVy: -2380,
    ballSpawnJitterX: 0,
    ballSpawnJitterVx: 0,
    ballSpawnJitterVy: 70,
    ballBounce: 1.06,
    ballCollisionSpread: 0.18,
    ballSoftBody: true,
    ballElasticity: 0.42,
    ballRecoverySpeed: 8.8,
    ballWobbleIntensity: 0.18,
    ballWobbleDamping: 9.0,
    ballTrail: true,
    ballTrailLength: neon ? 70 : 34,
    ballClearTrailOnDeath: true,
    ballLifetime: 0,
    ballWallCurve: 0,
    ballWallDrift: 0,
    ballMaxSpeed: 2700,
    colorCycle: neon,
  });

  wall('rail_left_outer', 132, 930, 1420, Math.PI / 2 - 0.11, theme.rail, 22);
  wall('rail_right_playfield', 806, 982, 1130, Math.PI / 2 + 0.08, theme.rail, 20);
  wall('launch_lane_left', 912, 1040, 1360, Math.PI / 2, theme.wall, 18);
  wall('launch_lane_right', 990, 1040, 1360, Math.PI / 2, theme.rail, 22);
  wall('top_safety_cap', 500, 115, 760, 0, theme.railAlt, 18);
  wall('left_return_lane', 286, 1338, 420, 0.95, theme.wall, 17);
  wall('right_return_lane', 790, 1338, 420, Math.PI - 0.95, theme.wall, 17);
  wall('left_outlane', 206, 1430, 445, Math.PI / 2 - 0.28, theme.railAlt, 16);
  wall('right_outlane', 780, 1430, 350, Math.PI / 2 + 0.18, theme.railAlt, 16);
  wall('launch_lane_one_way_gate', 890, 1510, 300, Math.PI / 2, theme.wall, 16, { oneWayNormal: { x: -1, y: 0 } });
  wall('left_drain_post', 252, 1668, 210, 0.62, theme.leftFlip, 23);
  wall('right_drain_post', 828, 1668, 210, Math.PI - 0.62, theme.rightFlip, 23);

  booster('bumper_top', 540, 500, 56, theme.bumperA, theme.accentA, 50, 820);
  booster('bumper_left', 352, 740, 50, theme.bumperB, theme.accentB, 35, 780);
  booster('bumper_right', 724, 740, 50, theme.bumperC, theme.accentC, 35, 780);
  booster('bumper_jackpot', 540, 980, 66, theme.jackpot, theme.accentA, 100, 980, '100');
  booster('launch_lane_exit_kicker', 1010, 188, 58, theme.railAlt, theme.accentA, 0, 1080, '');

  const topLaneY = 355;
  const laneXs = [276, 408, 540, 672, 768];
  const lanePoints = [20, 40, 75, 40, 20];
  laneXs.forEach((x, i) => {
    laneTarget(`top_lane_${i + 1}`, x, topLaneY, lanePoints[i], i === 2 ? theme.jackpot : theme.rail);
  });

  for (let row = 0; row < 5; row++) {
    const count = row % 2 === 0 ? 5 : 4;
    const startX = 540 - (count - 1) * 82 * 0.5;
    for (let i = 0; i < count; i++) {
      peg(
        `pinball_peg_${row}_${i}`,
        startX + i * 82,
        610 + row * 132,
        row === 4 ? 10 : 12,
        row % 2 ? theme.pegB : theme.pegA,
        10 + row * 5,
      );
    }
  }
  peg('left_slingshot_post', 260, 1254, 18, theme.leftFlip, 10);
  peg('right_slingshot_post', 820, 1254, 18, theme.rightFlip, 10);
  peg('center_save_post', 540, 1472, 16, theme.jackpot, 25);

  objects.push({
    id: 'left_auto_flipper',
    type: 'flipper',
    x: 325,
    y: 1532,
    length: 158,
    thickness: 36,
    rotation: 0.24,
    baseRotation: 0.24,
    swing: -0.95,
    frequency: 1.35,
    phase: 0,
    side: 'left',
    color: theme.leftFlip,
    strength: 900,
    points: 5,
    label: '+5',
  });
  objects.push({
    id: 'right_auto_flipper',
    type: 'flipper',
    x: 755,
    y: 1532,
    length: 158,
    thickness: 36,
    rotation: Math.PI - 0.24,
    baseRotation: Math.PI - 0.24,
    swing: 0.95,
    frequency: 1.35,
    phase: 0.5,
    side: 'right',
    color: theme.rightFlip,
    strength: 900,
    points: 5,
    label: '+5',
  });

  const binDefs = [
    { id: 'pinball_bin_25_l', x: 226, label: '+25', points: 25, color: theme.rail },
    { id: 'pinball_bin_75_l', x: 394, label: '+75', points: 75, color: theme.railAlt },
    { id: 'pinball_bin_150', x: 540, label: 'JACKPOT', points: 150, color: theme.jackpot },
    { id: 'pinball_bin_75_r', x: 686, label: '+75', points: 75, color: theme.leftFlip },
    { id: 'pinball_bin_25_r', x: 854, label: '+25', points: 25, color: theme.rightFlip },
  ];
  for (const bin of binDefs) {
    objects.push({
      id: bin.id,
      type: 'scoreBin',
      x: bin.x,
      y: 1810,
      width: bin.id === 'pinball_bin_150' ? 126 : 150,
      height: 190,
      points: bin.points,
      label: bin.label,
      color: bin.color,
      textColor: theme.textColor,
      captureMode: 'consume',
    });
  }

  const events = [
    { id: 'pinball_500_flash', once: false,
      trigger: { type: 'scoreTotal', points: 500 },
      actions: [
        { type: 'flash', color: theme.accentA },
        { type: 'text', text: neon ? 'MULTIBALL ENERGY' : 'EXTRA BALL ENERGY', seconds: 1.4, color: theme.titleColor, size: 64 },
      ] },
    { id: 'pinball_1000_win', once: true,
      trigger: { type: 'scoreTotal', points: 1000 },
      actions: [
        { type: 'confetti' },
        { type: 'text', text: `${neon ? 'NEON' : 'CLASSIC'} JACKPOT {score}`, seconds: 2.2, color: theme.accentA, size: 72 },
      ] },
    { id: 'pinball_time_limit', once: true,
      trigger: { type: 'time', seconds: 60 },
      action: { type: 'finish', seconds: 1.0 } },
    { id: 'pinball_credit_over', once: true,
      trigger: { type: 'finish' },
      actions: [
        { type: 'shatter', pieces: 1000, burstScale: 0.18, downwardBias: 720, lifeBase: 3.0, lifeRange: 1.0 },
        { type: 'text', text: 'GAME OVER\nSCORE {score}', seconds: 2.3, delay: 1.45, color: theme.titleColor, size: 74 },
      ] },
  ];

  return {
    seed,
    version: 2,
    name: theme.name,
    loopDuration: 28,
    duration: 28,
    satisfying: false,
    physics: { gravity: 1360, friction: neon ? 0.04 : 0.065 },
    overlay: {
      title: theme.name,
      titleX: 540,
      titleY: 34,
      titleSize: 24,
      titleColor: theme.titleColor,
      titleShadowColor: theme.titleShadow,
      showTimer: false,
      showCounter: true,
      counterMode: 'ballsUsedFraction',
      counterTotal: 20,
      counterX: 70,
      counterY: 74,
      counterAlign: 'left',
      counterSize: 34,
      counterColor: theme.textColor,
      counterShadowColor: theme.titleShadow,
      scoreX: 1010,
      scoreY: 74,
      scoreSize: 36,
      scoreColor: theme.textColor,
      scoreShadowColor: theme.titleShadow,
      showScore: true,
    },
    visuals: { glow: theme.backgroundGlow, pulse: theme.pulse, freezeKeepAppearance: true },
    randomMode: false,
    stopOnFirstEscape: false,
    objects,
    events,
  };
}

function buildNeonPinballScenario(seed = 88) {
  return buildPinballScenario(seed, 'neon');
}

function buildClassicPinballScenario(seed = 88) {
  return buildPinballScenario(seed, 'classic');
}

function buildDeterminationSpiralScenario(seed = 100, variant = 'determination') {
  const cx = 540;
  const cy = 1040;
  const duration = 38.6;
  const variants = {
    determination: {
      name: '100% Determination',
      title: 'DETERMINATION',
      completeText: '100% DETERMINATION',
      percentColor: '#ff2d1f',
      titleColor: '#ffffff',
      text25Shadow: '#ff2d1f',
      text50Shadow: '#22d3ee',
      text80Shadow: '#f97316',
      finalShadow: '#ff24d7',
      ballColor: '#18f3ff',
      freezeGlowColor: '#18f3ff',
      freezeSpeckColor: '#16e0ff',
      palette: ['#ff2d1f', '#ff8a00', '#ffd21f', '#78f33d', '#16e0ff', '#1d63ff', '#9b2cff', '#ff24d7'],
      tailPalette: ['#ff9f0a', '#ff1f3d', '#ff24d7'],
      itemShape: 'heart',
      itemSize: 24,
      itemSound: 'pianoRise',
      centerText: '♥',
      centerSize: 104,
      centerColor: '#ff2448',
      ambientColors: ['#ffffff', '#ff6b7d', '#18f3ff', '#ffd21f'],
    },
    crystal: {
      name: 'Crystal Spiral',
      title: 'CRYSTAL FLOW',
      completeText: '100% CRYSTAL FLOW',
      percentColor: '#67e8f9',
      titleColor: '#f0fdff',
      text25Shadow: '#22d3ee',
      text50Shadow: '#a78bfa',
      text80Shadow: '#38bdf8',
      finalShadow: '#67e8f9',
      ballColor: '#e0f2fe',
      freezeGlowColor: '#67e8f9',
      freezeSpeckColor: '#cffafe',
      palette: ['#e0f2fe', '#67e8f9', '#22d3ee', '#38bdf8', '#818cf8', '#c084fc'],
      tailPalette: ['#67e8f9', '#38bdf8', '#c084fc'],
      itemShape: 'diamond',
      itemSize: 25,
      itemSound: 'bell',
      centerText: '◆',
      centerSize: 116,
      centerColor: '#67e8f9',
      ambientColors: ['#ffffff', '#cffafe', '#67e8f9', '#c084fc'],
    },
    starlight: {
      name: 'Starlight Spiral',
      title: 'STARLIGHT RUSH',
      completeText: '100% STARLIGHT RUSH',
      percentColor: '#fde047',
      titleColor: '#fff7ed',
      text25Shadow: '#facc15',
      text50Shadow: '#fb923c',
      text80Shadow: '#f472b6',
      finalShadow: '#fde047',
      ballColor: '#fef3c7',
      freezeGlowColor: '#fde047',
      freezeSpeckColor: '#facc15',
      palette: ['#fff7ad', '#fde047', '#facc15', '#fb923c', '#f472b6', '#c084fc'],
      tailPalette: ['#fde047', '#fb923c', '#f472b6'],
      itemShape: 'star',
      itemSize: 26,
      itemSound: 'legendChime',
      centerText: '✦',
      centerSize: 128,
      centerColor: '#fde047',
      ambientColors: ['#ffffff', '#fde047', '#fb923c', '#f472b6'],
    },
    bubble: {
      name: 'Bubble Spiral',
      title: 'BUBBLE BLOOM',
      completeText: '100% BUBBLE BLOOM',
      percentColor: '#5eead4',
      titleColor: '#ecfeff',
      text25Shadow: '#2dd4bf',
      text50Shadow: '#38bdf8',
      text80Shadow: '#a7f3d0',
      finalShadow: '#5eead4',
      ballColor: '#ccfbf1',
      freezeGlowColor: '#5eead4',
      freezeSpeckColor: '#99f6e4',
      palette: ['#ecfeff', '#99f6e4', '#5eead4', '#2dd4bf', '#38bdf8', '#0ea5e9'],
      tailPalette: ['#5eead4', '#38bdf8', '#0ea5e9'],
      itemShape: 'orb',
      itemSize: 25,
      itemSound: 'soft',
      centerText: '●',
      centerSize: 120,
      centerColor: '#5eead4',
      ambientColors: ['#ffffff', '#ccfbf1', '#5eead4', '#38bdf8'],
    },
    bolt: {
      name: 'Neon Bolt Spiral',
      title: 'NEON CHARGE',
      completeText: '100% NEON CHARGE',
      percentColor: '#a3e635',
      titleColor: '#f7fee7',
      text25Shadow: '#84cc16',
      text50Shadow: '#22c55e',
      text80Shadow: '#06b6d4',
      finalShadow: '#a3e635',
      ballColor: '#ecfccb',
      freezeGlowColor: '#a3e635',
      freezeSpeckColor: '#bef264',
      palette: ['#ecfccb', '#a3e635', '#84cc16', '#22c55e', '#06b6d4', '#14b8a6'],
      tailPalette: ['#a3e635', '#22c55e', '#06b6d4'],
      itemShape: 'bolt',
      itemSize: 27,
      itemSound: 'laser',
      centerText: '⚡',
      centerSize: 126,
      centerColor: '#a3e635',
      ambientColors: ['#ffffff', '#ecfccb', '#a3e635', '#06b6d4'],
    },
    candy: {
      name: 'Candy Drop Spiral',
      title: 'CANDY RUSH',
      completeText: '100% CANDY RUSH',
      percentColor: '#fb7185',
      titleColor: '#fff1f2',
      text25Shadow: '#fb7185',
      text50Shadow: '#f9a8d4',
      text80Shadow: '#fdba74',
      finalShadow: '#fb7185',
      ballColor: '#ffe4e6',
      freezeGlowColor: '#fb7185',
      freezeSpeckColor: '#fecdd3',
      palette: ['#fff1f2', '#fb7185', '#f472b6', '#c084fc', '#fdba74', '#fde68a'],
      tailPalette: ['#fb7185', '#f472b6', '#fdba74'],
      itemShape: 'drop',
      itemSize: 26,
      itemSound: 'pop',
      centerText: '♦',
      centerSize: 118,
      centerColor: '#fb7185',
      ambientColors: ['#ffffff', '#ffe4e6', '#fb7185', '#fdba74'],
    },
    moon: {
      name: 'Moonlit Spiral',
      title: 'MOONLIGHT',
      completeText: '100% MOONLIGHT',
      percentColor: '#c4b5fd',
      titleColor: '#f5f3ff',
      text25Shadow: '#a78bfa',
      text50Shadow: '#818cf8',
      text80Shadow: '#60a5fa',
      finalShadow: '#c4b5fd',
      ballColor: '#ede9fe',
      freezeGlowColor: '#c4b5fd',
      freezeSpeckColor: '#ddd6fe',
      palette: ['#f5f3ff', '#ddd6fe', '#c4b5fd', '#a78bfa', '#818cf8', '#60a5fa'],
      tailPalette: ['#c4b5fd', '#818cf8', '#60a5fa'],
      itemShape: 'crescent',
      itemSize: 27,
      itemSound: 'bell',
      centerText: '☾',
      centerSize: 132,
      centerColor: '#c4b5fd',
      ambientColors: ['#ffffff', '#ede9fe', '#c4b5fd', '#60a5fa'],
    },
    blossom: {
      name: 'Blossom Spiral',
      title: 'BLOSSOM POP',
      completeText: '100% BLOSSOM POP',
      percentColor: '#f9a8d4',
      titleColor: '#fdf2f8',
      text25Shadow: '#f9a8d4',
      text50Shadow: '#fb7185',
      text80Shadow: '#f0abfc',
      finalShadow: '#f9a8d4',
      ballColor: '#fce7f3',
      freezeGlowColor: '#f9a8d4',
      freezeSpeckColor: '#fbcfe8',
      palette: ['#fdf2f8', '#fbcfe8', '#f9a8d4', '#fb7185', '#f0abfc', '#c084fc'],
      tailPalette: ['#f9a8d4', '#fb7185', '#c084fc'],
      itemShape: 'flower',
      itemSize: 27,
      itemSound: 'piano',
      centerText: '✿',
      centerSize: 124,
      centerColor: '#f9a8d4',
      ambientColors: ['#ffffff', '#fce7f3', '#f9a8d4', '#c084fc'],
    },
    ember: {
      name: 'Ember Spiral',
      title: 'EMBER RUSH',
      completeText: '100% EMBER RUSH',
      percentColor: '#fb923c',
      titleColor: '#fff7ed',
      text25Shadow: '#f97316',
      text50Shadow: '#ef4444',
      text80Shadow: '#facc15',
      finalShadow: '#fb923c',
      ballColor: '#ffedd5',
      freezeGlowColor: '#fb923c',
      freezeSpeckColor: '#fed7aa',
      palette: ['#fff7ed', '#fed7aa', '#fb923c', '#f97316', '#ef4444', '#facc15'],
      tailPalette: ['#fb923c', '#ef4444', '#facc15'],
      itemShape: 'flame',
      itemSize: 27,
      itemSound: 'chirp',
      centerText: '▲',
      centerSize: 124,
      centerColor: '#fb923c',
      ambientColors: ['#ffffff', '#ffedd5', '#fb923c', '#ef4444'],
    },
    frost: {
      name: 'Frost Rune Spiral',
      title: 'FROST RUNES',
      completeText: '100% FROST RUNES',
      percentColor: '#93c5fd',
      titleColor: '#eff6ff',
      text25Shadow: '#bfdbfe',
      text50Shadow: '#60a5fa',
      text80Shadow: '#38bdf8',
      finalShadow: '#93c5fd',
      ballColor: '#dbeafe',
      freezeGlowColor: '#93c5fd',
      freezeSpeckColor: '#bfdbfe',
      palette: ['#eff6ff', '#dbeafe', '#93c5fd', '#60a5fa', '#38bdf8', '#0f172a'],
      tailPalette: ['#93c5fd', '#60a5fa', '#38bdf8'],
      itemShape: 'rune',
      itemSize: 27,
      itemSound: 'blip',
      centerText: '✣',
      centerSize: 124,
      centerColor: '#93c5fd',
      ambientColors: ['#ffffff', '#dbeafe', '#93c5fd', '#38bdf8'],
    },
  };
  const cfg = variants[variant] || variants.determination;
  const palette = cfg.palette;
  const spiralOuterRadius = 432;
  const spiralStartAngle = 0.08;
  const spiralStartX = cx + Math.cos(spiralStartAngle) * spiralOuterRadius;
  const spiralStartY = cy + Math.sin(spiralStartAngle) * spiralOuterRadius;
  const entryX = spiralStartX - 34;
  const entryY = spiralStartY - 255;
  const smallHeartCount = 148;
  const spiralHeartCount = smallHeartCount + 1;
  const finalHeartIndex = smallHeartCount - 1;
  const attemptSpeeds = [
    { id: 'determination_ball_01', vy: 0, maxSpeed: 0, from: 0, cap: 200 },
    { id: 'determination_ball_03', vy: 980, maxSpeed: 0, from: 0, cap: 200 },
    { id: 'determination_ball_04', vy: 1100, maxSpeed: 0, from: 0, cap: 200 },
    { id: 'determination_ball_09', vy: 1240, maxSpeed: 0, from: 0, cap: 200, consumeRadius: 54, gravityScaleDelay: 8, lateGravityScale: 2, lateUpwardGravityScale: 2, removeWhenStalledAfter: 2.4, removeWhenStalledSpeed: 22 },
    { id: 'determination_ball_06', vy: 1240, maxSpeed: 0, from: 0, cap: 200, consumeRadius: 52, gravityScaleDelay: 7, lateGravityScale: 2.46, lateUpwardGravityScale: 2.46, removeWhenStalledAfter: 2.4, removeWhenStalledSpeed: 22 },
    { id: 'determination_ball_07', vy: 1320, maxSpeed: 0, from: 0, cap: 200, consumeRadius: 54 },
  ];
  const objects = [
    {
      id: 'determination_percent',
      type: 'text',
      x: 272,
      y: 390,
      text: '{progressPercent}%',
      size: 58,
      color: cfg.percentColor,
      shadowColor: cfg.percentColor,
      align: 'left',
      weight: '900',
      progressMode: 'consumedHearts',
      progressTarget: spiralHeartCount,
    },
    {
      id: 'determination_title',
      type: 'text',
      x: 428,
      y: 390,
      text: cfg.title,
      size: 58,
      color: cfg.titleColor,
      shadowColor: cfg.titleColor,
      align: 'left',
      weight: '900',
    },
  ];

  objects.push({
    id: 'det_real_spiral_wall',
    type: 'spiral',
    x: cx,
    y: cy,
    innerRadius: 64,
    outerRadius: spiralOuterRadius,
    turns: 4.65,
    startAngle: spiralStartAngle,
    direction: 1,
    thickness: 4,
    color: palette[1] || cfg.percentColor,
    gradientColors: palette,
    continuous: true,
    samples: 520,
  });
  objects.push({
    id: 'det_inner_spiral_tail',
    type: 'spiral',
    x: cx,
    y: cy,
    innerRadius: 16,
    outerRadius: 64,
    turns: 0.85,
    startAngle: spiralStartAngle + (Math.PI * 2) * 4.65,
    direction: 1,
    thickness: 4,
    color: cfg.tailPalette[1] || cfg.percentColor,
    gradientColors: cfg.tailPalette,
    continuous: true,
    samples: 120,
    visualOnly: true,
  });
  objects.push({
    id: 'det_spiral_hearts',
    type: 'spikes',
    x: cx,
    y: cy,
    innerRadius: 64,
    outerRadius: spiralOuterRadius,
    turns: 4.65,
    startAngle: spiralStartAngle,
    direction: 1,
    count: smallHeartCount,
    length: 20,
    width: 22,
    color: palette[1] || cfg.percentColor,
    gradientColors: palette,
    destroys: false,
    freezes: false,
    consumable: true,
    markerPath: 'spiral',
    markerShape: cfg.itemShape,
    heartSize: cfg.itemSize,
    fixedHeartSize: true,
    markerEndT: 1,
    radialOffset: -36,
  });

  for (let i = 0; i < attemptSpeeds.length; i++) {
    const attempt = attemptSpeeds[i];
    objects.push({
      id: attempt.id,
      type: 'ball',
      x: entryX,
      y: entryY,
      spawnX: entryX,
      spawnY: entryY,
      vx: 0,
      vy: attempt.vy,
      radius: 37,
      color: cfg.ballColor,
      trail: true,
      trailLength: 64,
      clearTrailOnDeath: true,
      randomInitDir: false,
      gravityScale: attempt.gravityScale,
      upwardGravityScale: attempt.upwardGravityScale,
      gravityScaleDelay: attempt.gravityScaleDelay,
      lateGravityScale: attempt.lateGravityScale,
      lateUpwardGravityScale: attempt.lateUpwardGravityScale,
      linearDamping: attempt.linearDamping,
      linearDampingDelay: attempt.linearDampingDelay,
      lifetime: 0,
      templateOnly: i > 0,
      bounce: 0.42,
      wallCurve: 0,
      wallDrift: 0,
      wallBounceAngleRange: 0,
      collisionSpread: 0.16,
      softBody: true,
      elasticity: 0.18,
      recoverySpeed: 8.5,
      wobbleIntensity: 0.12,
      wobbleDamping: 8.0,
      maxSpeed: attempt.maxSpeed,
      destroyOnSpike: false,
      freezeOnSpike: false,
      bounceSound: 'silent',
      escapeSound: 'silent',
      destroySound: 'silent',
      deathSound: 'silent',
      motion: 'physics',
      orbitCx: cx,
      orbitCy: cy,
      orbitRadius: 432,
      orbitHarmonic: 1,
      orbitPhase: 0,
      orbitDirection: 1,
      consumeSpikesOnTouch: true,
      consumeRadius: attempt.consumeRadius || 52,
      consumeMaxPerTick: 8,
      consumeFromHeartIndex: attempt.from,
      consumeUntilHeartIndex: attempt.cap,
      removeAfterHeartCap: !!attempt.removeAfterHeartCap,
      eatSound: cfg.itemSound,
      removeOnUpturnAfterDrop: true,
      removeAfterDropMinDy: 130,
      removeOnUpturnVy: -35,
      removeOnUpturnMinAge: 0.35,
      removeOnUpturnStaleAfter: 0.95,
      removeOnUpturnNoProgressDy: 72,
      removeOnUpturnMinHearts: 1,
      removeWhenStalledAfter: attempt.removeWhenStalledAfter,
      removeWhenStalledSpeed: attempt.removeWhenStalledSpeed,
      lissaRadiusY: 432,
      lissaHarmonicY: 1,
      lissaPhaseY: Math.PI / 2,
    });
  }

  objects.push({
    id: 'center_heart',
    type: 'text',
    x: cx,
    y: cy + 4,
    text: cfg.centerText,
    size: cfg.centerSize,
    color: cfg.centerColor,
    shadowColor: cfg.centerColor,
    align: 'center',
    weight: '900',
    consumableCenterHeart: true,
    unlockAfterHearts: smallHeartCount,
    hitRadius: 50,
  });

  const events = [
    { id: 'det_retry_spawn', once: false,
      trigger: { type: 'allGone' },
      action: {
        type: 'spawnBall',
        templateIds: attemptSpeeds.slice(1).map((attempt) => attempt.id),
        jitter: 0,
        resetConsumablesOnSpawn: true,
        maxSpawns: attemptSpeeds.length - 1,
      } },
    { id: 'det_25_text', once: true, trigger: { type: 'consumedHearts', count: Math.round(spiralHeartCount * 0.25) }, actions: [
      { type: 'text', text: `25% ${cfg.title}`, seconds: 0.8, color: '#ffffff', shadowColor: cfg.text25Shadow, size: 70 },
    ] },
    { id: 'det_50_text', once: true, trigger: { type: 'consumedHearts', count: Math.round(spiralHeartCount * 0.5) }, actions: [
      { type: 'text', text: `50% ${cfg.title}`, seconds: 0.9, color: '#ffffff', shadowColor: cfg.text50Shadow, size: 72 },
    ] },
    { id: 'det_80_text', once: true, trigger: { type: 'consumedHearts', count: Math.round(spiralHeartCount * 0.8) }, actions: [
      { type: 'text', text: `80% ${cfg.title}`, seconds: 0.9, color: '#ffffff', shadowColor: cfg.text80Shadow, size: 72 },
    ] },
    { id: 'det_finish', once: true, trigger: { type: 'consumedHearts', count: spiralHeartCount }, action: { type: 'finish', seconds: 0.25 } },
    { id: 'det_final_bloom', once: true, trigger: { type: 'finish' }, actions: [
      { type: 'shatter' },
      { type: 'confetti' },
      { type: 'text', text: cfg.completeText, seconds: 2.0, color: '#ffffff', shadowColor: cfg.finalShadow, size: 72 },
    ] },
  ];

  return {
    seed,
    version: 2,
    name: cfg.name,
    loopDuration: duration,
    duration,
    satisfying: false,
    endCondition: { type: 'finish' },
    physics: { gravity: 980, friction: 0.035 },
    overlay: { title: '', showTimer: false, showCounter: false, showScore: false },
    visuals: {
      glow: 1.15,
      pulse: false,
      freezeKeepAppearance: true,
      freezeGlowColor: cfg.freezeGlowColor,
      freezeRimColor: '#ffffff',
      freezeOpacity: 0.85,
      freezeSpeckColor: cfg.freezeSpeckColor,
      freezeSpeckCount: 6,
      ambientParticles: {
        enabled: true,
        count: 180,
        size: 1.25,
        alpha: 0.22,
        speed: 8,
        colors: cfg.ambientColors,
      },
    },
    randomMode: false,
    stopOnFirstEscape: false,
    melody: {
      enabled: false,
      triggerSources: [],
      notes: [72, 76, 79, 83, 86, 91, 95, 98],
      loop: true,
      wave: 'triangle',
      gain: 0,
      decay: 0.22,
    },
    objects,
    events,
  };
}

function buildCrystalSpiralScenario(seed = 100) {
  return buildDeterminationSpiralScenario(seed, 'crystal');
}

function buildStarlightSpiralScenario(seed = 100) {
  return buildDeterminationSpiralScenario(seed, 'starlight');
}

function buildBubbleSpiralScenario(seed = 100) {
  return buildDeterminationSpiralScenario(seed, 'bubble');
}

function buildNeonBoltSpiralScenario(seed = 100) {
  return buildDeterminationSpiralScenario(seed, 'bolt');
}

function buildCandyDropSpiralScenario(seed = 100) {
  return buildDeterminationSpiralScenario(seed, 'candy');
}

function buildMoonlitSpiralScenario(seed = 100) {
  return buildDeterminationSpiralScenario(seed, 'moon');
}

function buildBlossomSpiralScenario(seed = 100) {
  return buildDeterminationSpiralScenario(seed, 'blossom');
}

function buildEmberSpiralScenario(seed = 100) {
  return buildDeterminationSpiralScenario(seed, 'ember');
}

function buildFrostRuneSpiralScenario(seed = 100) {
  return buildDeterminationSpiralScenario(seed, 'frost');
}

window.saveScenarioToFile = saveScenarioToFile;
window.loadScenarioFromFile = loadScenarioFromFile;
window.buildDemoScenario = buildDemoScenario;
window.buildHarmonicScenario = buildHarmonicScenario;
window.buildBurningRingsScenario = buildBurningRingsScenario;
window.buildOneHpScenario = buildOneHpScenario;
window.buildOneChanceCircleScenario = buildOneChanceCircleScenario;
window.buildChaosTheoryScenario = buildChaosTheoryScenario;
window.buildTwinkleScenario = buildTwinkleScenario;
window.buildWobbleShowcaseScenario = buildWobbleShowcaseScenario;
window.buildGapStaticSweepScenario = buildGapStaticSweepScenario;
window.buildGapEdgeCaseScenario = buildGapEdgeCaseScenario;
window.buildTimedEscapeScenario = buildTimedEscapeScenario;
window.buildBattleOfTheColorsScenario = buildBattleOfTheColorsScenario;
window.buildEasterScenario = buildEasterScenario;
window.buildEggHuntOrbitScenario = buildEggHuntOrbitScenario;
window.buildMemoryMazeScenario = buildMemoryMazeScenario;
window.buildRhythmDropScenario = buildRhythmDropScenario;
window.buildPredictionGatesScenario = buildPredictionGatesScenario;
window.buildLegendSpikesScenario = buildLegendSpikesScenario;
window.buildGiantMarbleGauntletScenario = buildGiantMarbleGauntletScenario;
window.buildSpinnerStormScenario = buildSpinnerStormScenario;
window.buildBranchMazeScenario = buildBranchMazeScenario;
window.buildPlinkoScenario = buildPlinkoScenario;
window.buildPinballScenario = buildPinballScenario;
window.buildNeonPinballScenario = buildNeonPinballScenario;
window.buildClassicPinballScenario = buildClassicPinballScenario;
window.buildDeterminationSpiralScenario = buildDeterminationSpiralScenario;
window.buildCrystalSpiralScenario = buildCrystalSpiralScenario;
window.buildStarlightSpiralScenario = buildStarlightSpiralScenario;
window.buildBubbleSpiralScenario = buildBubbleSpiralScenario;
window.buildNeonBoltSpiralScenario = buildNeonBoltSpiralScenario;
window.buildCandyDropSpiralScenario = buildCandyDropSpiralScenario;
window.buildMoonlitSpiralScenario = buildMoonlitSpiralScenario;
window.buildBlossomSpiralScenario = buildBlossomSpiralScenario;
window.buildEmberSpiralScenario = buildEmberSpiralScenario;
window.buildFrostRuneSpiralScenario = buildFrostRuneSpiralScenario;
