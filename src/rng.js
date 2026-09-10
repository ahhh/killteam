/**
 * Deterministic RNG service.
 *
 * Project invariant #4: all randomness in the engine goes through here.
 * `Math.random()` must never appear in engine, AI, or map-generation code.
 */

/** FNV-1a style string hash -> uint32 seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Avalanche so short seeds ("1", "2") don't produce correlated streams.
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  return (h ^= h >>> 16) >>> 0;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  /**
   * @param {string|number} seed stable seed string
   * @param {number} index how many values to burn first (for resuming a stream)
   */
  constructor(seed, index = 0) {
    this.seed = String(seed);
    this.index = 0;
    this._next = mulberry32(hashSeed(this.seed));
    for (let i = 0; i < index; i++) this.next();
  }

  /** Raw float in [0, 1). Advances the stream. */
  next() {
    this.index++;
    return this._next();
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  d6() {
    return this.int(1, 6);
  }

  /** Roll `n` d6, returned in rolled order (not sorted — order is part of the replay). */
  rollDice(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.d6());
    return out;
  }

  pick(array) {
    if (!array.length) return undefined;
    return array[this.int(0, array.length - 1)];
  }

  /** Fisher-Yates on a copy. */
  shuffle(array) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  chance(p) {
    return this.next() < p;
  }

  /** Serializable position in the stream. */
  getState() {
    return { seed: this.seed, index: this.index };
  }

  static fromState(s) {
    return new Rng(s.seed, s.index);
  }

  /**
   * A derived, independent stream. Used so map generation and battle
   * resolution don't consume each other's dice.
   */
  fork(label) {
    return new Rng(`${this.seed}:${label}`);
  }
}
