// Seeded cross-domain pair sampler. Author-plane only. Draws candidate pairs
// deterministically from the sampling pool, enforcing the spec 2.3(c)
// constraints BEFORE the expensive distance check runs, so the only pairs that
// reach Wikipedia are ones that already look unrelated.
//
// 2026-07-08 SUPERSESSION (major-topics design): the calendar is now a SINGLE
// TIER drawn from the authored fun-register topics pool (data/topics.json →
// resolve → data/topics-annotated.json survivors), with the ≤2-click rejection
// as the ONLY distance check (guaranteed dist ≥3 / 4-card floor). The old
// two-tier machinery (quirky 4+ pools, narrowing) is QUIRKY_SHARE=0 /
// retired-in-place below, kept compiling for the audit trail. New in this
// design: arrangeCalendar(), a deterministic post-pass that orders the
// accepted pairs so adjacent days never share a start- or target-domain.
//
// DETERMINISM CONTRACT. The draw sequence is a pure function of the seed and
// the sequence of accept()/reject() calls fed back by the verifier. Therefore,
// for a FIXED seed and a FIXED distance cache (which fixes every accept/reject
// verdict), the sampler emits an identical final pair list on every run and
// every machine. A cold cache re-derives verdicts from the live graph, which
// can differ ONLY if Wikipedia's link graph changed between runs — the cache is
// the boundary between deterministic sampling and live-graph facts.
// arrangeCalendar() is seeded and pure, so the ARRANGED order inherits the
// same contract.
//
// BUCKET WEIGHTING — the simpler scheme, justified with math. Endpoints are
// drawn UNIFORMLY OVER TITLES (not over buckets), so a bucket of size N is
// touched in proportion N/|pool|. The topics pool is ~20 domains × ~15-21
// survivors; the 2·365 endpoint draws touch each domain ~N/|pool|·730 ≈ 30-40
// times, well under its 3·N ≥ 45 cap — domains are used proportionally and
// NEVER exhaust under the ≤3× frequency cap. Weighting by bucket (uniform over
// buckets) is what would exhaust them; uniform-over-titles is simpler and safe.

import { makeRng, type Rng } from './rng.js';
import type { Tier } from './distance.js';

/** RETIRED to 0 by the 2026-07-08 SUPERSESSION (major-topics design). The
 *  two-tier model is dead: live Phase-4 evidence measured the verified-4+
 *  quirky space at ~5% yield even after narrowing, and Gray pivoted to a single
 *  authored major-topics pool with the ≤2-click rejection as the ONLY distance
 *  check (guaranteed dist ≥3 / 4-card floor; the 5-card guarantee is formally
 *  retired). At share 0, tierForSlot never selects 'quirky', so the quirky draw
 *  path is unreachable — kept compiling for the audit trail (deletion deferred
 *  until Gray blesses the one-tier calendar).
 *  History: 0.25 (Phase 2) → 0.15 (2026-07-07 Gray gate) → 0 (supersession). */
export const QUIRKY_SHARE = 0;

// --- narrowed quirky draw space — RETIRED IN PLACE (2026-07-08 supersession) --
// Everything from here through narrowQuirky served the dead 4+ quirky tier
// (Task 25 decision 2, itself superseded hours later by the major-topics
// design). With QUIRKY_SHARE = 0 none of it is reachable from the live sampler
// flow; narrowQuirky stays exercised by fixtures (passing-but-inert) and by the
// retired quirky-links audit path. Do not extend; delete in the
// blessed-calendar follow-up. Original rationale kept below for the record.
// ------------------------------------------------------------------------------
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
 * Hand-tuned bucket-adjacency deny-list (unordered pairs) — domains close
 * enough that a cross-domain pair would still FEEL related, which the distance
 * check cannot catch (spec §2.3c). REKEYED 2026-07-08 to the authored
 * fun-domain names of the major-topics design (the old Vital-bucket keys —
 * Science↔Health etc. — matched nothing in the topics pool and would have been
 * silently inert). Rationale per pair:
 *   History & War ↔ Ancient World      (Gladiator vs Colosseum reads related)
 *   Myth & Legend ↔ Ancient World      (Trojan Horse vs Troy, Zeus vs Parthenon)
 *   Film, TV & Books ↔ Comics & Pop Culture  (same franchise register)
 *   Games & Toys ↔ Comics & Pop Culture      (Barbie vs Hello Kitty register)
 * Kept small and defensible; the PR-diff human gate is the real backstop.
 */
export const BUCKET_DENY_LIST: ReadonlyArray<readonly [string, string]> = [
  ['History & War', 'Ancient World'],
  ['Myth & Legend', 'Ancient World'],
  ['Film, TV & Books', 'Comics & Pop Culture'],
  ['Games & Toys', 'Comics & Pop Culture'],
];

/** RETIRED (2026-07-08 supersession): quirky tier bucket routing for the dead
 *  two-tier design. Unreachable at QUIRKY_SHARE = 0; referenced only by the
 *  retired quirky-links audit path and passing-but-inert fixtures. */
export const QUIRKY_START_BUCKETS = ['Science', 'Arts'] as const;
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

// --- arrangeCalendar (2026-07-08 major-topics design) --------------------------

/** The domain fields arrangeCalendar cares about; the element type is generic
 *  so validated entries ride through unchanged. */
export interface ArrangeItem {
  startBucket: string;
  targetBucket: string;
}

export interface ArrangeResult<T extends ArrangeItem> {
  calendar: T[];
  /** Indices i (>0) where calendar[i] still conflicts with calendar[i-1] after
   *  repair — the documented relaxation: leave in place and REPORT, never loop.
   *  Expected 0 for any realistic accept-set (~20 domains, 365 pairs). */
  violations: number[];
  /** Repair sweeps actually used (bounded by MAX_ARRANGE_PASSES). */
  passes: number;
}

/** Hard bound on repair sweeps — the never-an-infinite-loop guarantee. Each
 *  sweep is O(n²) worst case; 12 sweeps of 365 items is still trivial. */
export const MAX_ARRANGE_PASSES = 12;

/** Two adjacent days conflict when they share a start-domain OR a target-domain. */
function adjacentConflict(a: ArrangeItem, b: ArrangeItem): boolean {
  return a.startBucket === b.startBucket || a.targetBucket === b.targetBucket;
}

/**
 * Deterministic calendar arrangement: order the accepted pairs so no two
 * adjacent days share a start-domain or a target-domain. Pure post-processing —
 * zero API requests, same multiset out as in, seeded and stable (same input +
 * seed → same order on every machine).
 *
 * Method: seeded Fisher-Yates shuffle, then bounded greedy repair sweeps — for
 * each position i that conflicts with i-1, swap in the first later element
 * that resolves the conflict without creating one at any seam it touches
 * (i-1/i, i/i+1, j-1/j, j/j+1). If a sweep completes with zero conflicts, done.
 * RELAXATION RULE (documented, applied only if repair cannot converge within
 * MAX_ARRANGE_PASSES): leave the residual conflicts in place and report their
 * indices in `violations` — never an infinite loop, never a dropped pair.
 */
export function arrangeCalendar<T extends ArrangeItem>(
  pairs: readonly T[],
  seed: string,
): ArrangeResult<T> {
  const rng = makeRng(`${seed}:arrange`);
  const arr = [...pairs];

  // Seeded Fisher-Yates: uniform deterministic starting order.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  const conflictAt = (i: number): boolean =>
    i > 0 && i < arr.length && adjacentConflict(arr[i - 1], arr[i]);

  let passes = 0;
  for (; passes < MAX_ARRANGE_PASSES; passes++) {
    let conflicts = 0;
    for (let i = 1; i < arr.length; i++) {
      if (!conflictAt(i)) continue;
      let fixed = false;
      for (let j = i + 1; j < arr.length; j++) {
        [arr[i], arr[j]] = [arr[j], arr[i]];
        if (!conflictAt(i) && !conflictAt(i + 1) && !conflictAt(j) && !conflictAt(j + 1)) {
          fixed = true;
          break;
        }
        [arr[i], arr[j]] = [arr[j], arr[i]]; // undo and keep searching
      }
      if (!fixed) conflicts++;
    }
    if (conflicts === 0 && ![...arr.keys()].some((i) => conflictAt(i))) break;
  }

  const violations: number[] = [];
  for (let i = 1; i < arr.length; i++) if (conflictAt(i)) violations.push(i);
  return { calendar: arr, violations, passes: Math.min(passes + 1, MAX_ARRANGE_PASSES) };
}
