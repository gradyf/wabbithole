// Deterministic fixture suite for the generator machinery. Author-plane only,
// NOT wired into any npm script (run manually):
//
//   npx tsx scripts/gen-pairs/fixtures.test.ts
//
// Follows the house pattern (Tasks 9/10/17/22): import the REAL exports and
// drive them against fixed fixtures / injected mocks — zero network. Covers:
// rng determinism + avalanche, sampler constraint enforcement (single-tier +
// rekeyed deny-list per the 2026-07-08 supersession), arrangeCalendar
// (adjacency + determinism + bounded relaxation), the authored topics.json
// integrity, the redirect-hardened ≤2 distance verdict logic, the NOTE-2 gate,
// and checkpoint skip-on-rerun.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRng, xmur3, SAMPLER_SEED } from './rng.js';
import {
  PairSampler,
  tierForSlot,
  QUIRKY_SHARE,
  MAX_TITLE_APPEARANCES,
  BUCKET_DENY_LIST,
  arrangeCalendar,
  MAX_ARRANGE_PASSES,
  type PoolTitle,
  type ArrangeItem,
} from './sample.js';
import { classifyPair, type LinkGraph, type Tier } from './distance.js';
import { getOrClassify, type DistanceCache } from './cache.js';
import { withGate, activeWorkers, MAX_WORKERS, sleep } from './wiki.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// =========================== rng.ts ==========================================

function rngTests(): void {
  // determinism: same seed → byte-identical sequence across independent builds
  const a = makeRng('2026-07-07');
  const b = makeRng('2026-07-07');
  const seqA = Array.from({ length: 8 }, () => a.next());
  const seqB = Array.from({ length: 8 }, () => b.next());
  check('rng: same seed → identical sequence', JSON.stringify(seqA) === JSON.stringify(seqB));

  // different seeds → different sequence
  const c = makeRng('2026-07-08');
  check('rng: different seed → different sequence', a.next() !== c.next() || seqA[0] !== makeRng('2026-07-08').next());

  // int() bounds
  const r = makeRng(SAMPLER_SEED);
  let inBounds = true;
  for (let i = 0; i < 1000; i++) {
    const n = r.int(11);
    if (n < 0 || n >= 11 || !Number.isInteger(n)) inBounds = false;
  }
  check('rng: int(n) stays in [0, n)', inBounds);

  // xmur3 avalanche: adjacent date strings must NOT produce near-equal seeds
  // (the djb2 flaw research measured: consecutive dates differed by exactly 1).
  const s1 = xmur3('2026-07-06')();
  const s2 = xmur3('2026-07-07')();
  const bitDiff = popcount(s1 ^ s2);
  check(
    'rng: xmur3 avalanche — adjacent inputs differ in many bits',
    Math.abs(s1 - s2) > 1000 && bitDiff >= 8,
    `seeds ${s1} vs ${s2}, ${bitDiff} bits differ`,
  );

  // rough uniformity: 11 buckets over 11000 draws, each within ±25% of 1000
  const counts = new Array(11).fill(0);
  const u = makeRng('uniformity');
  for (let i = 0; i < 11000; i++) counts[u.int(11)]++;
  const uniform = counts.every((n) => n > 750 && n < 1250);
  check('rng: int() roughly uniform across buckets', uniform, JSON.stringify(counts));
}

function popcount(x: number): number {
  let n = x >>> 0;
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}

// =========================== sample.ts =======================================

function mockPool(): { backbone: PoolTitle[]; qStart: PoolTitle[]; qTarget: PoolTitle[] } {
  const backbone: PoolTitle[] = [];
  // 5 fun domains (2026-07-08 rekey), 8 titles each = 40 topics. Includes the
  // denied adjacency 'History & War' ↔ 'Ancient World' so the deny-list check
  // exercises the REAL rekeyed constant, not a stale bucket name.
  for (const bucket of ['Music', 'Sport', 'History & War', 'Ancient World', 'Space']) {
    for (let i = 0; i < 8; i++) backbone.push({ title: `${bucket}-${i}`, bucket });
  }
  const qStart: PoolTitle[] = [];
  for (let i = 0; i < 8; i++) qStart.push({ title: `Sci-${i}`, bucket: 'Science' });
  for (let i = 0; i < 4; i++) qStart.push({ title: `Art-${i}`, bucket: 'Arts' });
  const qTarget: PoolTitle[] = [];
  for (let i = 0; i < 12; i++) qTarget.push({ title: `Ev-${i}`, bucket: 'Everyday life' });
  for (let i = 0; i < 4; i++) qTarget.push({ title: `Tech-${i}`, bucket: 'Technology' });
  return { backbone, qStart, qTarget };
}

function samplerTests(): void {
  // tier composition: at the retired QUIRKY_SHARE=0 this telescopes to ZERO
  // quirky slots — the single-tier invariant of the 2026-07-08 supersession.
  let quirky = 0;
  for (let i = 0; i < 100; i++) if (tierForSlot(i) === 'quirky') quirky++;
  check('sampler: tier composition ≈ QUIRKY_SHARE', quirky === Math.round(100 * QUIRKY_SHARE), `${quirky}/100`);
  check('sampler: single tier — QUIRKY_SHARE is 0, no slot is ever quirky', QUIRKY_SHARE === 0 && quirky === 0);

  // drive 40 accepts (accept everything, as if all passed distance) and audit
  const { backbone, qStart, qTarget } = mockPool();
  const s = new PairSampler(SAMPLER_SEED, backbone, qStart, qTarget);
  const accepted: Array<{ start: PoolTitle; target: PoolTitle; tier: Tier }> = [];
  for (let i = 0; i < 40; i++) {
    const c = s.next();
    if (!c) break;
    s.accept(c);
    accepted.push(c);
  }
  check('sampler: reached target count', accepted.length === 40, `${accepted.length}`);
  check(
    'sampler: single tier — every candidate is tier backbone (no quirky draws possible)',
    accepted.every((c) => c.tier === 'backbone'),
  );
  check(
    'sampler: every accepted pair is cross-bucket',
    accepted.every((c) => c.start.bucket !== c.target.bucket),
  );
  check(
    'sampler: rekeyed deny-list enforced (History & War ↔ Ancient World never pairs)',
    !accepted.some(
      (c) =>
        (c.start.bucket === 'History & War' && c.target.bucket === 'Ancient World') ||
        (c.start.bucket === 'Ancient World' && c.target.bucket === 'History & War'),
    ),
  );
  // the deny-check must be doing real work: the two domains DO appear separately
  check(
    'sampler: denied domains still used against other domains (check not vacuous)',
    accepted.some((c) => c.start.bucket === 'History & War' || c.target.bucket === 'History & War') &&
      accepted.some((c) => c.start.bucket === 'Ancient World' || c.target.bucket === 'Ancient World'),
  );
  const freq = new Map<string, number>();
  for (const c of accepted) {
    freq.set(c.start.title, (freq.get(c.start.title) ?? 0) + 1);
    freq.set(c.target.title, (freq.get(c.target.title) ?? 0) + 1);
  }
  check(
    'sampler: frequency cap ≤ MAX_TITLE_APPEARANCES',
    [...freq.values()].every((n) => n <= MAX_TITLE_APPEARANCES),
    JSON.stringify([...freq.entries()].filter(([, n]) => n > MAX_TITLE_APPEARANCES)),
  );
  const dupes = new Set(accepted.map((c) => [c.start.title, c.target.title].sort().join('|')));
  check('sampler: no duplicate pair', dupes.size === accepted.length);

  // determinism: two samplers, same seed, same accept pattern → same draws
  const s1 = new PairSampler('det-seed', backbone, qStart, qTarget);
  const s2 = new PairSampler('det-seed', backbone, qStart, qTarget);
  let identical = true;
  for (let i = 0; i < 30; i++) {
    const c1 = s1.next();
    const c2 = s2.next();
    if (!c1 || !c2 || c1.start.title !== c2.start.title || c1.target.title !== c2.target.title) {
      identical = false;
      break;
    }
    s1.accept(c1);
    s2.accept(c2);
  }
  check('sampler: deterministic (same seed → same pair sequence)', identical);

  // reject() must NOT bump frequency (distance-rejected titles stay reusable)
  const s3 = new PairSampler('rej-seed', backbone, qStart, qTarget);
  const first = s3.next();
  if (first) s3.reject(first);
  check(
    'sampler: reject() does not consume frequency budget',
    s3.frequencies().size === 0,
  );
}

// ============== arrangeCalendar (2026-07-08 major-topics design) ==============

function arrangeTests(): void {
  // A feasible accept-set: 12 domains × ~30 pairs, plenty of adjacent-diverse
  // orderings. Deterministically generated (no rng) so the fixture is stable.
  const domains = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  const feasible: Array<ArrangeItem & { id: number }> = [];
  for (let i = 0; i < 360; i++) {
    feasible.push({
      id: i,
      startBucket: domains[i % 12],
      targetBucket: domains[(i + 5) % 12],
    });
  }

  const r1 = arrangeCalendar(feasible, SAMPLER_SEED);
  check('arrange: zero adjacency violations on a feasible set', r1.violations.length === 0, `${r1.violations.length}`);
  check(
    'arrange: adjacency property holds (no adjacent start- or target-domain repeat)',
    r1.calendar.every(
      (p, i) =>
        i === 0 ||
        (p.startBucket !== r1.calendar[i - 1].startBucket &&
          p.targetBucket !== r1.calendar[i - 1].targetBucket),
    ),
  );
  check(
    'arrange: same multiset out as in (no pair dropped or duplicated)',
    r1.calendar.length === feasible.length &&
      [...r1.calendar.map((p) => p.id)].sort((a, b) => a - b).every((id, i) => id === i),
  );

  // determinism: same input + seed → identical order; different seed → different
  const r2 = arrangeCalendar(feasible, SAMPLER_SEED);
  check(
    'arrange: deterministic (same input + seed → identical order)',
    JSON.stringify(r1.calendar.map((p) => p.id)) === JSON.stringify(r2.calendar.map((p) => p.id)),
  );
  const r3 = arrangeCalendar(feasible, 'a-different-seed');
  check(
    'arrange: seed actually drives the order (different seed → different order)',
    JSON.stringify(r1.calendar.map((p) => p.id)) !== JSON.stringify(r3.calendar.map((p) => p.id)),
  );

  // INFEASIBLE set (documented relaxation rule): every pair shares one start
  // domain, so every adjacency is a violation. Must terminate within the pass
  // bound and REPORT the violations rather than loop or drop pairs.
  const infeasible: Array<ArrangeItem & { id: number }> = [];
  for (let i = 0; i < 40; i++) infeasible.push({ id: i, startBucket: 'SAME', targetBucket: `T${i}` });
  const r4 = arrangeCalendar(infeasible, SAMPLER_SEED);
  check(
    'arrange: infeasible set terminates, keeps all pairs, and reports violations',
    r4.calendar.length === 40 && r4.violations.length === 39 && r4.passes <= MAX_ARRANGE_PASSES,
    `violations ${r4.violations.length}, passes ${r4.passes}`,
  );

  // empty and single-element inputs are valid no-ops
  const r5 = arrangeCalendar([], SAMPLER_SEED);
  const r6 = arrangeCalendar([{ startBucket: 'A', targetBucket: 'B' }], SAMPLER_SEED);
  check(
    'arrange: empty and singleton inputs are no-op safe',
    r5.calendar.length === 0 && r5.violations.length === 0 && r6.calendar.length === 1 && r6.violations.length === 0,
  );
}

// ============== authored topics.json integrity + deny-list coherence ==========

function topicsTests(): void {
  const raw = JSON.parse(readFileSync(join(DATA, 'topics.json'), 'utf8')) as {
    entries: Array<{ title: string; bucket: string }>;
  };
  const entries = raw.entries;
  const domains = new Set(entries.map((e) => e.bucket));

  check('topics: authored size ≈ 420 across ≈ 20 domains', entries.length >= 400 && domains.size >= 18, `${entries.length} titles, ${domains.size} domains`);
  const perDomain = new Map<string, number>();
  for (const e of entries) perDomain.set(e.bucket, (perDomain.get(e.bucket) ?? 0) + 1);
  check(
    'topics: domains reasonably balanced (15-30 authored per domain)',
    [...perDomain.values()].every((n) => n >= 15 && n <= 30),
    JSON.stringify([...perDomain.entries()].filter(([, n]) => n < 15 || n > 30)),
  );
  const titles = entries.map((e) => e.title);
  check('topics: no duplicate titles', new Set(titles).size === titles.length);
  check(
    'topics: every entry has non-empty string title + bucket',
    entries.every((e) => typeof e.title === 'string' && e.title.length > 0 && typeof e.bucket === 'string' && e.bucket.length > 0),
  );

  // THE deny-list coherence check (the "silently inert" trap the addendum
  // flags): every domain named in BUCKET_DENY_LIST must exist in the authored
  // topics domains, or the deny-list is dead letter against stale bucket names.
  check(
    'topics: every BUCKET_DENY_LIST domain exists in the authored topics domains',
    BUCKET_DENY_LIST.every(([a, b]) => domains.has(a) && domains.has(b)),
    JSON.stringify(BUCKET_DENY_LIST.filter(([a, b]) => !domains.has(a) || !domains.has(b))),
  );
}

// =========================== distance.ts =====================================

/** Canned link graph emulating live semantics (redirects=1 on the forward side). */
function mockGraph(spec: {
  outlinks: Record<string, string[]>;
  redirectsOf?: Record<string, string[]>;
  inlinks?: Record<string, string[]>;
  redirectTo?: Record<string, string>; // a redirect title → its canonical target
}): LinkGraph {
  const canon = (t: string): string => spec.redirectTo?.[t] ?? t;
  return {
    redirectsOf: async (t) => spec.redirectsOf?.[t] ?? [],
    outlinks: async (t) => spec.outlinks[t] ?? [],
    inlinks: async (t) => spec.inlinks?.[t] ?? [],
    linksAnyTo: async (sources, targets) =>
      sources.some((s) => (spec.outlinks[canon(s)] ?? []).some((l) => targets.includes(l))),
  };
}

async function distanceTests(): Promise<void> {
  // dist 1 (direct link) → reject-close
  let v = await classifyPair('A', 'B', mockGraph({ outlinks: { A: ['B', 'X'] } }));
  check('distance: dist1 direct → reject-close', v.verdict === 'reject-close' && v.distance === '<=2');

  // dist 1 via a redirect of B → reject-close (backward redirect hardening)
  v = await classifyPair(
    'A',
    'B',
    mockGraph({ outlinks: { A: ['Bee'] }, redirectsOf: { B: ['Bee'] } }),
  );
  check('distance: dist1 via redirect-of-B → reject-close', v.verdict === 'reject-close');

  // dist 2 meet-in-the-middle → reject-close
  v = await classifyPair('A', 'B', mockGraph({ outlinks: { A: ['X'], X: ['B'] } }));
  check('distance: dist2 → reject-close', v.verdict === 'reject-close' && v.distance === '<=2');

  // dist 2 through a forward redirect (A→Rx→X→B) → reject-close (forward hardening)
  v = await classifyPair(
    'A',
    'B',
    mockGraph({ outlinks: { A: ['Rx'], X: ['B'] }, redirectTo: { Rx: 'X' } }),
  );
  check('distance: dist2 via forward redirect → reject-close', v.verdict === 'reject-close');

  // survives ≤2 → accept-min3 (the single-tier verdict since the 2026-07-08
  // supersession: the ≤2 rejection IS the only distance check)
  v = await classifyPair(
    'A',
    'B',
    mockGraph({ outlinks: { A: ['X'], X: ['Y'], Y: ['B'] } }),
  );
  check('distance: survives ≤2 → accept-min3', v.verdict === 'accept-min3' && v.distance === '>=3');
}

// =========================== cache.ts (checkpoint) ===========================

async function cacheTests(): Promise<void> {
  let graphCalls = 0;
  const counting: LinkGraph = {
    redirectsOf: async () => {
      graphCalls++;
      return [];
    },
    outlinks: async (t) => {
      graphCalls++;
      return t === 'A' ? ['X'] : t === 'X' ? ['Y'] : t === 'Y' ? ['Z'] : ['B'];
    },
    inlinks: async () => {
      graphCalls++;
      return ['Z'];
    },
    linksAnyTo: async () => {
      graphCalls++;
      return false;
    },
  };
  const cache: DistanceCache = {};
  const r1 = await getOrClassify('A', 'B', 'quirky', counting, cache);
  const callsAfterFirst = graphCalls;
  check('cache: first classify computes (graph touched)', r1.computed && callsAfterFirst > 0);

  const r2 = await getOrClassify('A', 'B', 'quirky', counting, cache);
  check('cache: skip-on-rerun — cached pair makes ZERO new graph calls', !r2.computed && graphCalls === callsAfterFirst);
  check('cache: cached verdict identical to computed', JSON.stringify(r1.entry.verdict) === JSON.stringify(r2.entry.verdict));

  // a different directional pair is NOT a cache hit
  const r3 = await getOrClassify('B', 'A', 'quirky', counting, cache);
  check('cache: directional key — B→A is a distinct entry', r3.computed && graphCalls > callsAfterFirst);
}

// =========================== NOTE-2 gate =====================================

async function gateTests(): Promise<void> {
  let concurrent = 0;
  let peak = 0;
  const task = async (): Promise<void> => {
    await withGate(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      // yield several times so waking-a-waiter interleaves with fresh callers
      for (let i = 0; i < 4; i++) await sleep(0);
      concurrent--;
    });
  };
  // Two staggered waves so fresh callers arrive WHILE waiters are being woken —
  // exactly the interleaving NOTE-2 flagged (the old `if` could over-admit here).
  const wave1 = Array.from({ length: 20 }, () => task());
  await sleep(0);
  const wave2 = Array.from({ length: 20 }, () => task());
  await Promise.all([...wave1, ...wave2]);

  check('gate: peak concurrency never exceeded MAX_WORKERS', peak <= MAX_WORKERS, `peak=${peak}`);
  check('gate: gate actually saturated (exercised the wait path)', peak === MAX_WORKERS, `peak=${peak}`);
  check('gate: all slots released (active back to 0)', activeWorkers() === 0, `active=${activeWorkers()}`);
}

// =========================== run =============================================

async function main(): Promise<void> {
  rngTests();
  samplerTests();
  arrangeTests();
  topicsTests();
  await distanceTests();
  await cacheTests();
  await gateTests();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
