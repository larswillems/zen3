// Deterministic seedable PRNG (Mulberry32).
// Same seed always produces the exact same stream of numbers.
// All randomness in the simulator MUST go through an instance of this class
// so scenarios are perfectly reproducible.

class SeededRNG {
  constructor(seed) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    // Accept either a number or a string (hashed to a 32-bit int).
    if (typeof seed === 'string') {
      seed = SeededRNG.hashString(seed);
    }
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  static hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  static randomSeed() {
    // 32-bit unsigned int, easy for users to copy/share.
    return (Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }

  // Core advance step -> float in [0, 1).
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Helpers.
  range(min, max) { return min + (max - min) * this.next(); }
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  angle() { return this.next() * Math.PI * 2; }

  // Fork a child RNG that is deterministic but independent of the parent
  // after forking. Useful when we want to isolate streams (e.g. ball spawn
  // vs obstacle placement) without them stomping each other.
  fork(salt = 0) {
    const mixed = (this.state ^ (salt * 0x9e3779b9)) >>> 0;
    return new SeededRNG(mixed);
  }

  clone() {
    const r = new SeededRNG(this.seed);
    r.state = this.state;
    return r;
  }
}

window.SeededRNG = SeededRNG;
