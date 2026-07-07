// Seeded cross-domain pair sampler. Author-plane only. Draws candidate pairs
// deterministically from the famous pool (backbone) and quirky pool, enforcing
// the spec 2.3(c) constraints BEFORE the expensive distance check runs, so the
// only pairs that reach Wikipedia are ones that already look unrelated.
//
// DETERMINISM CONTRACT. The draw sequence is a pure function of the seed and
// the sequence of accept()/reject() calls fed back by the verifier. Therefore,
// for a FIXED seed and a FIXED distance cache (which fixes every accept/reject
// verdict), the sampler emits an identical final pair list on every run and
// every machine. A cold cache re-derives verdicts from the live graph, which
// can differ ONLY if Wikipedia's link graph changed between runs — the cache is
// the boundary between deterministic sampling and live-graph facts.
//
// TWO TIERS (spec §2.3 + Decision 1 AMENDED):
//   backbone — famous × famous from pool.json; distance ≥3 (4-card floor).
//   quirky   — an insular START (Science/Arts phenomenon) → a low-inlink
//              novelty TARGET (Everyday life/Technology) from quirky.json;
//              distance ≥4 (5-card floor). The directional shape is Task 17's
//              measured recipe for reaching ≥4 (hub×hub can't, so quirky never
//              draws two hubs); the START/TARGET bucket sets are disjoint, which
//              also satisfies cross-bucket disjointness by construction.
//
// BUCKET WEIGHTING — the simpler scheme, justified with math. Endpoints are
// drawn UNIFORMLY OVER TITLES (not over buckets), so a bucket of size N is
// touched in proportion N/|pool|. Task 22's smallest pool buckets (Arts 12,
// Math 16, Health 17) therefore appear ~N/579 of the ~2·count endpoint draws —
// e.g. Arts ≈ 12/579·(2·365) ≈ 15 appearances, far under its 3·12 = 36 cap — so
// small buckets are used proportionally and NEVER exhaust under the ≤3×
// frequency cap. Weighting by bucket (uniform over buckets) is what would
// exhaust them; uniform-over-titles is both simpler and safe.

import { makeRng, type Rng } from './rng.js';
import type { Tier } from './distance.js';

/** Share of the calendar that is quirky (≥4). Gray LOCKED this to 0.15 at the
 *  Phase 4 gate (was 0.25). Rationale (task-23-review MINOR-1): the quirky START
 *  pool is Science∪Arts = 20 titles, so under MAX_TITLE_APPEARANCES=3 the hard
 *  ceiling is 20×3 = 60 accepted quirky pairs. 0.25×365 ≈ 91 quirky is
 *  structurally unreachable (the run halts at 243). 0.15×365 ≈ 54 quirky fits
 *  under the 60 ceiling. No pool expansion, no cap raise (Gray decision). */
export const QUIRKY_SHARE = 0.15;

// --- narrowed quirky draw space (Task 25, Gray decision 2) -------------------
// BEFORE the real run we restrict the quirky tier to {insular STARTS} ×
// {low-inlink TARGETS} — the measured lever from task-23-report.md. Task 17's
// ~100%-4+ override space was exactly insular-phenomenon → low-inlink-novelty;
// the Phase-2 sample showed the failures were the opposite shape (Geyser, a
// broad start with hop1=472, cost 400+ req and mostly returned dist-3;
// Quicksand→Flashlight came out dist-3 only because Flashlight is MID-inlink —
// "the target is the bigger lever than the start"). So we drop broad starts and
// mid/high-inlink targets, lifting the 4+ yield and cutting the per-check cost.
//
// The two thresholds are named constants set from the measured link-count
// distribution (scripts/gen-pairs/data/quirky-linkcounts.json; see the Task 25
// report for the supporting data). They deliberately narrow the TARGET axis
// hard (35 → the low-inlink subset) and the START axis only lightly: the start
// ceiling (starts × 3) must stay comfortably above the ~54 quirky pairs
// QUIRKY_SHARE demands, so starts are near-fully retained (task-23-review
// MINOR-1: narrowing starts below ~19 makes 54 quirky infeasible).

/** Insular quirky START guard: keep starts whose live outlink (hop-1) count is
 *  ≤ this. The measured start band is 84–621 outlinks (data/quirky-linkcounts.json)
 *  — all 20 starts are insular by construction (Science/Arts phenomena; famous
 *  hubs run to thousands of outlinks and MAX_HOP1_FRONTIER=1500 already declines
 *  them). 650 admits the full measured band and excludes anything broader. It is
 *  intentionally NON-BINDING on the current pool: the START axis CANNOT be
 *  narrowed under the locked constraints — 20 starts × cap 3 = ceiling 60 is the
 *  minimum to place the ~54 quirky pairs QUIRKY_SHARE demands with headroom, and
 *  narrowing below ~19 starts makes 54 quirky infeasible (task-23-review MINOR-1).
 *  So insularity is enforced by the pool source, and this guard would only fire
 *  on a future non-insular addition. The TARGET threshold below is the operative
 *  narrowing lever ("the target is the bigger lever than the start"). */
export const QUIRKY_START_MAX_OUTLINKS = 650;

/** Low-inlink quirky TARGET: keep targets whose live inlink count is ≤ this. THE
 *  operative narrowing lever. The measured target band is 22–>2000 inlinks; 450
 *  sits just below the mid-inlink watershed at Flashlight (500) — the exact target
 *  that made Quicksand→Flashlight collapse to dist-3 in the Phase-2 sample. It
 *  retains the 24 low-inlink novelties (22–413), inside which every Task-17
 *  proven-4+ target sits (all ≤102 inlinks), and drops the 11 mid/high-inlink
 *  ones (Flashlight 500, Rubik's Cube/Popcorn 521, … Lighthouse >2000). This
 *  reconstructs Task 17's ~100%-4+ target space, lifting the quirky 4+ yield. */
export const QUIRKY_TARGET_MAX_INLINKS = 450;

/** Measured link counts for the quirky candidates (the offline pre-pass output).
 *  A target's inlink count may be `capped` (measured only up to a ceiling) — a
 *  capped target is over any threshold ≤ that ceiling, so it is dropped. */
export interface QuirkyLinkCounts {
  /** start title (space form) → outlink count */
  startOutlinks: Record<string, number>;
  /** target title (space form) → inlink count (possibly capped) */
  targetInlinks: Record<string, { count: number; capped: boolean }>;
}

export interface NarrowResult {
  starts: PoolTitle[];
  targets: PoolTitle[];
  /** Starts excluded for exceeding the outlink threshold (too broad). */
  droppedStarts: Array<{ title: string; outlinks: number }>;
  /** Targets excluded for exceeding the inlink threshold (too well-connected). */
  droppedTargets: Array<{ title: string; inlinks: number; capped: boolean }>;
  /** Candidates with no measured count — a complete run must have none. */
  unmeasuredStarts: string[];
  unmeasuredTargets: string[];
}

/**
 * Pure narrowing: keep only insular starts and low-inlink targets, per the
 * measured link counts. A candidate missing from `counts` is NOT silently kept
 * — it lands in the `unmeasured*` lists so the caller can fail loudly (an
 * incomplete measurement must never quietly shrink the draw space).
 */
export function narrowQuirky(
  starts: readonly PoolTitle[],
  targets: readonly PoolTitle[],
  counts: QuirkyLinkCounts,
  maxStartOutlinks = QUIRKY_START_MAX_OUTLINKS,
  maxTargetInlinks = QUIRKY_TARGET_MAX_INLINKS,
): NarrowResult {
  const keptStarts: PoolTitle[] = [];
  const droppedStarts: Array<{ title: string; outlinks: number }> = [];
  const unmeasuredStarts: string[] = [];
  for (const s of starts) {
    const n = counts.startOutlinks[s.title];
    if (n === undefined) unmeasuredStarts.push(s.title);
    else if (n <= maxStartOutlinks) keptStarts.push(s);
    else droppedStarts.push({ title: s.title, outlinks: n });
  }

  const keptTargets: PoolTitle[] = [];
  const droppedTargets: Array<{ title: string; inlinks: number; capped: boolean }> = [];
  const unmeasuredTargets: string[] = [];
  for (const t of targets) {
    const m = counts.targetInlinks[t.title];
    if (m === undefined) unmeasuredTargets.push(t.title);
    else if (!m.capped && m.count <= maxTargetInlinks) keptTargets.push(t);
    else droppedTargets.push({ title: t.title, inlinks: m.count, capped: m.capped });
  }

  return {
    starts: keptStarts,
    targets: keptTargets,
    droppedStarts,
    droppedTargets,
    unmeasuredStarts,
    unmeasuredTargets,
  };
}

/** Planning oversample: candidates drawn ahead of distance rejection. The
 *  streaming replacement loop subsumes a fixed batch, but this is the expected
 *  draw:accept headroom used for Phase 4 request projections. */
export const OVERSAMPLE = 0.2;

/** No title appears in more than this many shipped pairs (spec §2.3c). */
export const MAX_TITLE_APPEARANCES = 3;

/**
 * Hand-tuned bucket-adjacency deny-list (unordered pairs) — buckets close
 * enough that a cross-bucket pair would still FEEL related, which the distance
 * check cannot catch (spec §2.3c, the Biology↔Health example). Kept small and
 * defensible; the PR-diff human gate is the real unrelatedness backstop.
 */
export const BUCKET_DENY_LIST: ReadonlyArray<readonly [string, string]> = [
  ['Science', 'Health, medicine and disease'],
  ['Science', 'Mathematics'],
  ['Philosophy and religion', 'Society and social sciences'],
];

/** Quirky START buckets: topically-insular phenomena that can reach ≥4. */
export const QUIRKY_START_BUCKETS = ['Science', 'Arts'] as const;
/** Quirky TARGET buckets: low-inlink everyday novelties. */
export const QUIRKY_TARGET_BUCKETS = ['Everyday life', 'Technology'] as const;

export interface PoolTitle {
  title: string;
  bucket: string;
}

export interface Candidate {
  start: PoolTitle;
  target: PoolTitle;
  tier: Tier;
}

export type SamplerRejectReason =
  | 'same-bucket'
  | 'deny-list'
  | 'freq-cap'
  | 'duplicate-pair';

export interface SamplerReject {
  start: string;
  target: string;
  tier: Tier;
  reason: SamplerRejectReason;
}

function denied(a: string, b: string): boolean {
  return BUCKET_DENY_LIST.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Even quirky distribution over ACCEPTED slots (Bresenham-style): slot i is
 * quirky when the running quota ⌊(i+1)·share⌋ crosses an integer. Deterministic
 * and spreads quirky pairs through the calendar rather than clustering them.
 */
export function tierForSlot(i: number, share = QUIRKY_SHARE): Tier {
  return Math.floor((i + 1) * share) > Math.floor(i * share) ? 'quirky' : 'backbone';
}

export class PairSampler {
  private readonly rng: Rng;
  private acceptedCount = 0;
  private readonly freq = new Map<string, number>();
  private readonly usedPairs = new Set<string>();
  /** Every sampler-level rejection (pre-distance), with its reason. */
  readonly rejects: SamplerReject[] = [];

  constructor(
    seed: string,
    private readonly backbone: readonly PoolTitle[],
    private readonly quirkyStarts: readonly PoolTitle[],
    private readonly quirkyTargets: readonly PoolTitle[],
    private readonly share = QUIRKY_SHARE,
    private readonly maxRedrawsPerSlot = 20_000,
  ) {
    this.rng = makeRng(seed);
    if (backbone.length < 2) throw new Error('backbone pool needs ≥2 titles');
  }

  private freqOf(t: string): number {
    return this.freq.get(t) ?? 0;
  }

  private log(start: PoolTitle, target: PoolTitle, tier: Tier, reason: SamplerRejectReason): void {
    this.rejects.push({ start: start.title, target: target.title, tier, reason });
  }

  /**
   * The next sampler-valid candidate for the current accepted-count slot, or
   * null if the valid space is exhausted (all combinations used/capped).
   */
  next(): Candidate | null {
    const tier = tierForSlot(this.acceptedCount, this.share);
    const starts = tier === 'quirky' ? this.quirkyStarts : this.backbone;
    const targets = tier === 'quirky' ? this.quirkyTargets : this.backbone;
    if (starts.length === 0 || targets.length === 0) return null;

    for (let attempt = 0; attempt < this.maxRedrawsPerSlot; attempt++) {
      const start = this.rng.pick(starts);
      const target = this.rng.pick(targets);
      if (start.title === target.title || start.bucket === target.bucket) {
        this.log(start, target, tier, 'same-bucket');
        continue;
      }
      if (denied(start.bucket, target.bucket)) {
        this.log(start, target, tier, 'deny-list');
        continue;
      }
      if (
        this.freqOf(start.title) >= MAX_TITLE_APPEARANCES ||
        this.freqOf(target.title) >= MAX_TITLE_APPEARANCES
      ) {
        this.log(start, target, tier, 'freq-cap');
        continue;
      }
      if (this.usedPairs.has(pairKey(start.title, target.title))) {
        this.log(start, target, tier, 'duplicate-pair');
        continue;
      }
      return { start, target, tier };
    }
    return null;
  }

  /** Record a distance-verified pair: bump per-title frequency, retire the pair. */
  accept(c: Candidate): void {
    this.acceptedCount++;
    this.freq.set(c.start.title, this.freqOf(c.start.title) + 1);
    this.freq.set(c.target.title, this.freqOf(c.target.title) + 1);
    this.usedPairs.add(pairKey(c.start.title, c.target.title));
  }

  /** Retire a distance-rejected pair (do NOT bump frequency) so it is not redrawn. */
  reject(c: Candidate): void {
    this.usedPairs.add(pairKey(c.start.title, c.target.title));
  }

  get accepted(): number {
    return this.acceptedCount;
  }

  /** Per-title appearance counts among accepted pairs (for cap verification). */
  frequencies(): Map<string, number> {
    return new Map(this.freq);
  }
}
