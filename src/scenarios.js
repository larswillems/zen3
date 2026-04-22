// Scenario I/O: save/load to JSON, duplicate, default scenes.

function saveScenarioToFile(scenario, filename) {
  const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `scenario_${scenario.seed}.json`;
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
      insideOnly: true },
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
      lifetime: 0, bounce: 0.95, wallCurve: 0.7,
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
    maxExportSeconds: 45,
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
      insideOnly: true },
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
      bounce: 0.98,
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
    maxExportSeconds: 45,
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
      insideOnly: true },
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
      bounce: 0.995,
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
    visuals: { glow: 1.1, pulse: false },
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
    maxExportSeconds: 30,
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
      bounce: 0.992,
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
    maxExportSeconds: 18,
    objects,
    events: [],
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
      insideOnly: true },
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
      lifetime: T,
      freezeOnTimeout: true,
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
    { id: 'respawn_timed', once: false,
      trigger: { type: 'ballFrozen' },
      action: { type: 'spawnBall', templateId: 'ball_1', jitter: 0 } },
    { id: 'timed_win_text', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'text', text: 'ESCAPED!', seconds: 1.8 } },
    { id: 'timed_win_flash', once: true,
      trigger: { type: 'firstEscape' },
      action: { type: 'flash', color: '#ede9fe' } },
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
      showTimer: false, showCounter: true,
      bigCountdown: true,
      countdownMax: T,
      countdownMode: 'activeBallLifetime',
    },
    visuals: { glow: 1.1, pulse: false },
    randomMode: false,
    stopOnFirstEscape: true,
    endCondition: { type: 'firstEscapeTail', tail: 1.8 },
    maxExportSeconds: 45,
    objects,
    events,
  };
}

function buildBattleOfTheColorsScenario(seed = 23) {
  const cx = 540, cy = 960;
  const seedRng = new SeededRNG(seed).fork(523);
  const colors = ['#ff4d6d', '#f59e0b', '#22c55e', '#38bdf8', '#a855f7'];
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
    insideOnly: true,
  }));

  const startRadius = 62;
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
      bounce: 0.985,
      wallCurve: 0.34,
      wallDrift: 0.18,
      collisionSpread: 0.52,
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
        pieces: 1000,
        burstScale: 1.35,
        winnerText: 'WINNER',
        seconds: 2.2,
      } },
    { id: 'battle_finish_flash', once: true,
      trigger: { type: 'ballCount', count: 1 },
      action: { type: 'flash', colorFrom: 'lastBall' } },
    { id: 'battle_finish_confetti', once: true,
      trigger: { type: 'ballCount', count: 1 },
      action: { type: 'confetti' } },
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
    overlay: { title: 'Battle of the Colors', showTimer: false, showCounter: true },
    visuals: { glow: 1.16, pulse: false },
    randomMode: false,
    stopOnFirstEscape: false,
    endCondition: { type: 'ballCountTail', count: 1, tail: 2.2 },
    maxExportSeconds: 35,
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
      bounce: 0.98,
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
    ballBounce: 0.18,
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
      bounce: 0.18,
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
    maxExportSeconds: 20,
    objects,
    events,
  };
}

window.saveScenarioToFile = saveScenarioToFile;
window.loadScenarioFromFile = loadScenarioFromFile;
window.buildDemoScenario = buildDemoScenario;
window.buildHarmonicScenario = buildHarmonicScenario;
window.buildOneHpScenario = buildOneHpScenario;
window.buildChaosTheoryScenario = buildChaosTheoryScenario;
window.buildTwinkleScenario = buildTwinkleScenario;
window.buildWobbleShowcaseScenario = buildWobbleShowcaseScenario;
window.buildTimedEscapeScenario = buildTimedEscapeScenario;
window.buildBattleOfTheColorsScenario = buildBattleOfTheColorsScenario;
window.buildPlinkoScenario = buildPlinkoScenario;
