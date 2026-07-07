// Seeded PRNG for the offline pair sampler. Author-plane only — never imported
// by the app (the runtime uses a pinned calendar, not a live draw; spec 2.1).
//
// xmur3 (seed hash) + sfc32 (draw), per spec 2.2/2.4. The spec chose xmur3
// over a djb2-family hash because research (race-research-wiki.md §3) MEASURED
// djb2 producing seeds that differ by exactly 1 for adjacent date strings —
// weak avalanche that risks adjacent inputs landing on nearby pool indices.
// xmur3 has strong avalanche (a one-character input change scrambles the whole
// 32-bit seed), verified in fixtures.ts.
//
// Determinism is the whole point: the same seed string yields byte-identical
// draw sequences across process invocations and machines, so the sampler is
// reproducible and its output is reviewable/re-derivable.

/**
 * Committed sampler seed. Changing this reshuffles every drawn pair, so it is a
 * deliberate, reviewable constant (Gray may retune at the Phase 4 human-review
 * gate). Namespaced + versioned so a future re-seed is explicit in the diff.
 */
export const SAMPLER_SEED = 'wabbit-hole-race-pairs-2026-v1';

/**
 * xmur3 string-hash: returns a generator of 32-bit seed words with strong
 * avalanche. Call it repeatedly to fill sfc32's four state words.
 */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function next(): number {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/**
 * sfc32 (Small Fast Counter, 32-bit): fast, statistically solid PRNG with a
 * 128-bit state. Returns a function producing floats in [0, 1).
 */
export function sfc32(a: number, b: number, c: number, d: number): () => number {
  return function next(): number {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(arr: readonly T[]): T;
}

/** Build a deterministic Rng from a seed string (xmur3 → sfc32). */
export function makeRng(seed: string): Rng {
  const seeder = xmur3(seed);
  const draw = sfc32(seeder(), seeder(), seeder(), seeder());
  const next = (): number => draw();
  const int = (n: number): number => {
    if (n <= 0) throw new Error(`Rng.int requires n > 0, got ${n}`);
    return Math.floor(next() * n);
  };
  const pick = <T>(arr: readonly T[]): T => {
    if (arr.length === 0) throw new Error('Rng.pick requires a non-empty array');
    return arr[int(arr.length)];
  };
  return { next, int, pick };
}
