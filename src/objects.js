// Object model for the simulator.
// Every object has a unique id, a type, and a plain-data property bag so the
// entire scene can be serialized to JSON and restored exactly.

const ObjectTypes = Object.freeze({
  BALL: 'ball',
  TEXT: 'text',
  TIMER: 'timer',
  SCORE_BIN: 'scoreBin',
  CIRCLE: 'circle',       // Full ring (may have a rotating gap)
  ARC: 'arc',             // Partial ring
  SPIRAL: 'spiral',       // Nested rings forming a spiral
  SPIKES: 'spikes',       // Ring of triangular spikes
  SPINNER: 'spinner',     // Rotating cross / pinwheel obstacle
  BOOSTER: 'booster',     // Pinball bumper that launches + scores
  FLIPPER: 'flipper',     // Automatic pinball flipper paddle
  SPAWNER: 'spawner',     // Emits balls every `interval` seconds
});

let _idCounter = 1;
function nextId(prefix = 'obj') {
  return `${prefix}_${_idCounter++}`;
}

function resetIdCounter(value = 1) { _idCounter = value; }

// --- Factories produce plain objects (POJOs) that we can JSON round-trip ---

function defaultGapPassConfig(overrides = {}) {
  return {
    enabled: false,
    outcome: 'escape',      // escape | destroy | shatter | burn | flyAway | launchUp | launchDown
    particleStyle: 'auto',  // auto | burst | shatter | burn | trail
    removeObjectOnPass: false,
    soundMode: 'none',      // none | preset | upload
    soundPreset: 'glass',
    soundAssetId: '',
    soundVolume: 1.0,
    ...overrides,
  };
}

function defaultCollisionHoleConfig(overrides = {}) {
  return {
    collisionHoleEnabled: false,
    collisionHoleSize: 0.42,
    collisionHoleTarget: 'auto',      // auto | hitCircle | nearestCircle | innermostContainingCircle | outermostContainingCircle
    collisionHolePlacement: 'impact', // impact | oppositeImpact | againstIncoming | withIncoming
    collisionHoleOnCircle: true,
    collisionHoleOnArc: false,
    collisionHoleOnSpikes: false,
    collisionHoleOnSpinner: false,
    collisionHoleOnBall: false,
    collisionHoleOnFixedBall: false,
    ...overrides,
  };
}

function makeBall(overrides = {}) {
  return {
    id: overrides.id || nextId('ball'),
    type: ObjectTypes.BALL,
    x: 540, y: 960,
    vx: 0, vy: 260,
    radius: 18,
    color: '#38bdf8',
    spawnX: 540,
    spawnY: 960,
    trail: true,
    trailLength: 40,
    // When true, the ball's trail is wiped the instant the ball dies
    // (escape / destroy / lifetime expiry). Set to false to keep the ghost
    // trail frozen in place after death.
    clearTrailOnDeath: true,
    randomInitDir: false,
    lifetime: 0,           // 0 = infinite
    freezeOnTimeout: false, // if true, lifetime expiry freezes instead of destroys
    fixed: false,          // if true, ball acts as an immovable obstacle
    ballBehaviorPreset: 'custom',
    maxSpeed: 0,           // 0 = unlimited; otherwise clamp velocity magnitude
    bounce: 1.0,           // restitution on walls
    wallCurve: 0,          // small tangential twist on wall bounces
    wallDrift: 0,          // occasional downward/tangential slip on wall bounces
    wallBounceAngleRange: 0, // degrees of deterministic post-bounce angle spread
    collisionSpread: 0.35, // widen rebounds after hitting other balls
    softBody: false,       // if true, collisions temporarily deform the ball
    elasticity: 0.55,      // how far the blob stretches on impact
    recoverySpeed: 6.0,    // how quickly the ball returns to a circle
    wobbleIntensity: 0.45, // edge ripple strength after impacts
    wobbleDamping: 7.0,    // how quickly the ripple fades out
    changeColorOnBallCollision: false,
    // Optional decorative render pack for non-circular looks such as
    // pastel Easter eggs. Physics still uses the regular ball radius.
    eggStyle: null,
    deadColor: '#3a3a3a',
    recolorOnFreeze: false,
    deathBurstOnFreeze: false,
    // Per-ball sound overrides. Empty string = use the scenario default
    // (melody on bounce, chime on freeze, etc.). See SOUND_PRESETS in
    // `src/audio.js` for available voice names per kind.
    bounceSound: '',     // played every time this ball bounces off anything
    escapeSound: '',     // played when this ball exits the stage
    destroySound: '',    // played when this ball is destroyed (spike / lifetime)
    deathSound: '',      // played when this ball is frozen (spike / scoreBin)
    ...defaultCollisionHoleConfig(),
    destroyOnSpike: true,
    // If true (and the spike has `freezes`) a touching ball stops dead in
    // place and becomes a solid obstacle for other balls.
    freezeOnSpike: false,
    alive: true,
    age: 0,

    // --- Motion model ---
    //   'physics'   : classic gravity + collisions (chaotic, good for escapes)
    //   'orbit'     : ball follows a parametric circle, perfectly loopable
    //   'lissajous' : ball follows 2D harmonic path, perfectly loopable
    motion: 'physics',

    // Orbit / lissajous params. These are always expressed relative to the
    // scene's loopDuration so motion closes its cycle at the end of the loop.
    orbitCx: 540, orbitCy: 960,
    orbitRadius: 280,
    orbitHarmonic: 1,       // # full revolutions per loop (integer!)
    orbitPhase: 0,          // radians offset; used for symmetry groups
    orbitDirection: 1,      // +1 clockwise*, -1 counter-clockwise

    // Lissajous-only extras (ignored for plain orbit):
    lissaRadiusY: 280,
    lissaHarmonicY: 1,
    lissaPhaseY: Math.PI / 2,

    // Runtime-only data (not serialized):
    _trail: [],
    ...overrides,
  };
}

function makeCircle(overrides = {}) {
  return {
    id: overrides.id || nextId('circle'),
    type: ObjectTypes.CIRCLE,
    x: 540, y: 960,
    radius: 420,
    thickness: 10,
    rotation: 0,
    rotationSpeed: 0,      // radians per second
    color: '#f472b6',
    gradientColors: null,
    gapStart: 0,           // radians; 0 and gapSize=0 means no gap
    gapSize: 0,            // radians of the opening
    gapPulse: false,       // if true, gap opens/closes over time
    gapMinSize: 0,         // minimum size during pulse
    gapPulseSpeed: 1.0,    // open/close cycles per second
    insideOnly: true,      // balls bounce on inside of the ring
    onGapPass: defaultGapPassConfig(),
    ...overrides,
  };
}

function makeText(overrides = {}) {
  return {
    id: overrides.id || nextId('text'),
    type: ObjectTypes.TEXT,
    x: 540,
    y: 220,
    text: 'Text',
    size: 72,
    color: '#ffffff',
    align: 'center',
    weight: '700',
    font: 'system-ui, sans-serif',
    ...overrides,
  };
}

function makeTimer(overrides = {}) {
  return {
    id: overrides.id || nextId('timer'),
    type: ObjectTypes.TIMER,
    x: 540,
    y: 260,
    size: 60,
    color: '#ffffff',
    align: 'center',
    weight: '700',
    font: 'system-ui, sans-serif',
    decimals: 2,
    prefix: '',
    suffix: 's',
    resetOn: 'never',
    ...overrides,
  };
}

function makeScoreBin(overrides = {}) {
  return {
    id: overrides.id || nextId('scoreBin'),
    type: ObjectTypes.SCORE_BIN,
    x: 540,
    y: 1680,
    width: 150,
    height: 180,
    points: 10,
    label: '+10',
    color: '#38bdf8',
    textColor: '#ffffff',
    captureMode: 'consume', // 'consume' | 'freeze' | 'keep' | 'settle'
    scoreTrigger: 'top',    // for settle bins: 'top' (entry) | 'bottom' (settled)
    ...overrides,
  };
}

function makeArc(overrides = {}) {
  return {
    id: overrides.id || nextId('arc'),
    type: ObjectTypes.ARC,
    x: 540, y: 960,
    radius: 320,
    thickness: 8,
    startAngle: -Math.PI * 0.75,
    endAngle: Math.PI * 0.75,
    rotation: 0,
    rotationSpeed: 0,
    insideOnly: false,
    color: '#a78bfa',
    onGapPass: defaultGapPassConfig(),
    ...overrides,
  };
}

function makeSpiral(overrides = {}) {
  return {
    id: overrides.id || nextId('spiral'),
    type: ObjectTypes.SPIRAL,
    x: 540, y: 960,
    innerRadius: 120,
    outerRadius: 480,
    layers: 5,
    gapSize: 0.6,
    thickness: 6,
    rotation: 0,
    rotationSpeed: 0.3,
    color: '#34d399',
    onGapPass: defaultGapPassConfig(),
    ...overrides,
  };
}

function makeSpikes(overrides = {}) {
  return {
    id: overrides.id || nextId('spikes'),
    type: ObjectTypes.SPIKES,
    x: 540, y: 960,
    radius: 380,
    count: 24,
    length: 30,
    width: 24,
    inward: true,
    rotation: 0,
    rotationSpeed: 0,
    color: '#f87171',
    gradientColors: null,
    destroys: true,
    // If true, touching balls with `freezeOnSpike` become immovable obstacles
    // instead of being destroyed or bouncing. Takes priority over `destroys`.
    freezes: false,
    // Gap: individual spikes whose center angle falls inside the gap are
    // omitted from both rendering and collision. Use this to line up a
    // spike ring with a circle's escape gap.
    gapStart: 0,
    gapSize: 0,
    onGapPass: defaultGapPassConfig(),
    ...overrides,
  };
}

function makeSpinner(overrides = {}) {
  return {
    id: overrides.id || nextId('spinner'),
    type: ObjectTypes.SPINNER,
    x: 540, y: 960,
    armLength: 220,
    thickness: 24,
    rotation: 0,
    rotationSpeed: 0.9,
    color: '#f8fafc',
    armCount: 2, // 2 = X / cross shape (two perpendicular bars)
    ...overrides,
  };
}

function makeBooster(overrides = {}) {
  return {
    id: overrides.id || nextId('booster'),
    type: ObjectTypes.BOOSTER,
    x: 540, y: 760,
    radius: 42,
    color: '#22d3ee',
    accentColor: '#f0abfc',
    strength: 720,
    points: 25,
    label: '+25',
    cooldown: 0.12,
    ...overrides,
  };
}

function makeFlipper(overrides = {}) {
  return {
    id: overrides.id || nextId('flipper'),
    type: ObjectTypes.FLIPPER,
    x: 420, y: 1580,
    length: 250,
    thickness: 34,
    rotation: -0.28,
    baseRotation: -0.28,
    swing: 0.82,
    frequency: 1.35,
    phase: 0,
    side: 'left',
    color: '#f472b6',
    strength: 760,
    points: 5,
    label: '+5',
    cooldown: 0.08,
    ...overrides,
  };
}

function makeSpawner(overrides = {}) {
  return {
    id: overrides.id || nextId('spawner'),
    type: ObjectTypes.SPAWNER,
    x: 540, y: 480,
    interval: 1.0,           // seconds between ball emissions
    maxBalls: 20,            // oldest spawned ball is removed beyond this
    // Initial kinematics for spawned balls.
    ballColor: '#38bdf8',
    ballRadius: 18,
    ballVx: 0,
    ballVy: 400,
    ballBehaviorPreset: 'custom',
    ballMaxSpeed: 0,
    ballBounce: 1.0,
    ballWallBounceAngleRange: 0,
    ballCollisionSpread: 0.35,
    ballSoftBody: false,
    ballElasticity: 0.55,
    ballRecoverySpeed: 6.0,
    ballWobbleIntensity: 0.45,
    ballWobbleDamping: 7.0,
    ballTrail: true,
    ballTrailLength: 40,
    ballClearTrailOnDeath: true,
    ballRandomInitDir: false,
    ballLifetime: 0,         // 0 = infinite (constrained by maxBalls)
    ballFreezeOnTimeout: false,
    ballFixed: false,
    ballWallCurve: 0,
    ballWallDrift: 0,
    ballChangeColorOnBallCollision: false,
    ballDestroyOnSpike: true,
    ballFreezeOnSpike: false,
    ballDeadColor: '#3a3a3a',
    ballRecolorOnFreeze: false,
    ballDeathBurstOnFreeze: false,
    // Mirror of per-ball sound overrides; applied to every spawned ball.
    ballBounceSound: '',
    ballEscapeSound: '',
    ballDestroySound: '',
    ballDeathSound: '',
    ballCollisionHoleEnabled: false,
    ballCollisionHoleSize: 0.42,
    ballCollisionHoleTarget: 'auto',
    ballCollisionHolePlacement: 'impact',
    ballCollisionHoleOnCircle: true,
    ballCollisionHoleOnArc: false,
    ballCollisionHoleOnSpikes: false,
    ballCollisionHoleOnSpinner: false,
    ballCollisionHoleOnBall: false,
    ballCollisionHoleOnFixedBall: false,
    colorCycle: true,        // if true, cycle through a pleasing palette
    // Runtime-only state (not serialized):
    _lastSpawn: -Infinity,
    _spawnCount: 0,
    _spawnedIds: [],
    ...overrides,
  };
}

function createObject(type, overrides) {
  switch (type) {
    case ObjectTypes.BALL: return makeBall(overrides);
    case ObjectTypes.TEXT: return makeText(overrides);
    case ObjectTypes.TIMER: return makeTimer(overrides);
    case ObjectTypes.SCORE_BIN:
    case 'score-bin':
      return makeScoreBin(overrides);
    case 'static-ball':
      return makeBall({
        x: 540, y: 960,
        spawnX: 540, spawnY: 960,
        vx: 0, vy: 0,
        radius: 28,
        color: '#6b7280',
        trail: false,
        fixed: true,
        destroyOnSpike: false,
        freezeOnSpike: false,
        ...overrides,
      });
    case ObjectTypes.CIRCLE: return makeCircle(overrides);
    case ObjectTypes.ARC: return makeArc(overrides);
    case ObjectTypes.SPIRAL: return makeSpiral(overrides);
    case ObjectTypes.SPIKES: return makeSpikes(overrides);
    case ObjectTypes.SPINNER: return makeSpinner(overrides);
    case 'spinner': return makeSpinner(overrides);
    case ObjectTypes.BOOSTER: return makeBooster(overrides);
    case ObjectTypes.FLIPPER: return makeFlipper(overrides);
    case ObjectTypes.SPAWNER: return makeSpawner(overrides);
    default: throw new Error(`Unknown object type: ${type}`);
  }
}

// Strip runtime-only fields before serializing. Convention: any key starting
// with '_' is runtime state (trails, spawn counters, frozen flag, etc.), and
// `alive` / `age` are per-instance lifecycle fields that are reset on rebuild.
function serializeObject(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k.startsWith('_')) continue;
    if (k === 'alive' || k === 'age') continue;
    out[k] = obj[k];
  }
  return out;
}

window.ObjectTypes = ObjectTypes;
window.createObject = createObject;
window.serializeObject = serializeObject;
window.makeBooster = makeBooster;
window.makeFlipper = makeFlipper;
window.makeTimer = makeTimer;
window.makeScoreBin = makeScoreBin;
window.resetIdCounter = resetIdCounter;
window.nextId = nextId;
window.defaultGapPassConfig = defaultGapPassConfig;
window.defaultCollisionHoleConfig = defaultCollisionHoleConfig;
