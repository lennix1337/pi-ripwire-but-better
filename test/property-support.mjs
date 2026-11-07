// Seeded generators for property tests. Failing assertions name their seed, so a failing case reproduces from it.
export const CASES = 200;

export function rng(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (next, items) => items[Math.floor(next() * items.length)];
export const int = (next, min, max) => min + Math.floor(next() * (max - min + 1));
