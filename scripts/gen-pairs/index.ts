// Orchestrator. Author-plane only (spec 2.1): runs on a laptop, never in
// `vercel build`. Subcommands:
//
//   npx tsx scripts/gen-pairs/index.ts                 # Phase 1: harvest+resolve (default)
//   npx tsx scripts/gen-pairs/index.ts quirky          # Phase 2: build data/quirky.json
//   npx tsx scripts/gen-pairs/index.ts sample --count 30 [--seed S]   # Phase 2: draw+verify pairs
//   npx tsx scripts/gen-pairs/index.ts emit [--cutover N]             # Phase 3: flat calendar
//
// Outputs (committed; deterministic inputs downstream):
//   data/annotated.json     — every Vital-L3 title, annotated  (Phase 1)
//   data/pool.json          — the famous-tier gated subset      (Phase 1)
//   data/quirky.json        — the quirky (≥4) tier pool          (Phase 2)
//   data/distance-cache.json— per-pair distance verdicts (resumable checkpoint)
//   data/legacy-pairs.json  — frozen copy of the pre-flat 120-pair rotation (Phase 3 input)
//   ../../src/race/pairs.json      — the flat, calendar-pinned schedule       (Phase 3)
//   ../../src/race/pairs.meta.json — provenance sidecar, NOT imported by the app (Phase 3)
//
// Phase 3 scope: flat-calendar emitter + pairForKey swap. In this phase the
// validated list is empty, so the emitted calendar is the full legacy
// materialization (zero player-visible change; proven by emit.test.ts's sweep).
// Phase 4 re-runs `emit` with real validated pairs + a real cutover (data only).

import { writeFileSync, mkdirSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { harvest } from './harvest.js';
import { resolve, FAMOUS_MIN_MONTHLY_VIEWS, type AnnotatedEntry } from './resolve.js';
import { requestCount, GEN_AGENT, queryAllLinks, queryInlinksCount } from './wiki.js';
import { buildQuirkyPool, QUIRKY_MIN_MONTHLY_VIEWS } from './quirky.js';
import {
  PairSampler,
  QUIRKY_SHARE,
  OVERSAMPLE,
  MAX_TITLE_APPEARANCES,
  QUIRKY_START_BUCKETS,
  QUIRKY_TARGET_BUCKETS,
  QUIRKY_START_MAX_OUTLINKS,
  QUIRKY_TARGET_MAX_INLINKS,
  narrowQuirky,
  type PoolTitle,
  type QuirkyLinkCounts,
} from './sample.js';
import { SAMPLER_SEED } from './rng.js';
import { liveGraph, accepted } from './distance.js';
import { loadCache, saveCache, getOrClassify, type CacheEntry } from './cache.js';
import { runEmit } from './emit.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

/** Provenance pretty-printed, entries one per line: reviewable diffs, small file. */
function serialize(provenance: object, entries: AnnotatedEntry[]): string {
  const head = JSON.stringify(provenance, null, 2);
  const lines = entries.map((e) => `    ${JSON.stringify(e)}`);
  return `{\n  "provenance": ${head.replace(/\n/g, '\n  ')},\n  "entries": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

function perBucketCounts(entries: AnnotatedEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.bucket] = (counts[e.bucket] ?? 0) + 1;
  return counts;
}

async function runHarvest(): Promise<void> {
  const t0 = Date.now();
  console.log(`gen-pairs Phase 1 harvest+resolve — agent: ${GEN_AGENT}`);

  const h = await harvest();
  console.log(
    `harvested ${h.entries.length} titles from ${h.buckets.length} buckets ` +
      `(revid ${h.revid}); flat prop=links count ${h.flat.count} in ${h.flat.requests} requests`,
  );
  if (h.duplicates.length > 0) {
    console.log(`cross-bucket duplicates (first bucket kept):`);
    for (const d of h.duplicates) console.log(`  ${d.title}: ${d.buckets.join(', ')}`);
  }
  if (h.flat.inFlatOnly.length > 0 || h.flat.inBucketsOnly.length > 0) {
    console.log(`reconciliation delta vs flat link list:`);
    console.log(`  in flat only (${h.flat.inFlatOnly.length}): ${h.flat.inFlatOnly.join(' | ')}`);
    console.log(
      `  in buckets only (${h.flat.inBucketsOnly.length}): ${h.flat.inBucketsOnly.join(' | ')}`,
    );
  } else {
    console.log(`reconciliation: bucketed set == flat link set, no delta`);
  }

  const r = await resolve(h.entries);
  const wallTimeMs = Date.now() - t0;

  const missing = r.annotated.filter((e) => e.status === 'missing');
  const belowThreshold = r.annotated.filter((e) => e.status === 'below-threshold');
  const redirected = r.annotated.filter((e) => e.redirectedFrom !== undefined);
  const noPageviewData = r.annotated.filter((e) => e.pageviewData === false);

  const provenance = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-pairs (Phase 1: harvest + resolve)',
    source: {
      page: 'Wikipedia:Vital articles/Level 3',
      revid: h.revid,
    },
    pageviews: {
      project: 'en.wikipedia',
      access: 'all-access',
      agent: 'user',
      granularity: 'monthly',
      window: r.pageviewWindow,
    },
    gate: { minMonthlyViews: FAMOUS_MIN_MONTHLY_VIEWS },
    counts: {
      harvested: h.entries.length,
      flatLinks: h.flat.count,
      annotated: r.annotated.length,
      pool: r.pool.length,
      missing: missing.length,
      belowThreshold: belowThreshold.length,
      resolvedFromRedirect: redirected.length,
      mergedCanonicalDuplicates: r.merged.length,
      annotatedPerBucket: perBucketCounts(r.annotated),
      poolPerBucket: perBucketCounts(r.pool),
    },
    reconciliation: {
      inFlatOnly: h.flat.inFlatOnly,
      inBucketsOnly: h.flat.inBucketsOnly,
      crossBucketDuplicates: h.duplicates,
      merged: r.merged,
    },
    run: { httpRequests: requestCount(), wallTimeMs },
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'annotated.json'), serialize(provenance, r.annotated));
  writeFileSync(join(DATA_DIR, 'pool.json'), serialize(provenance, r.pool));

  // --- run summary ------------------------------------------------------------
  console.log(`\nannotated ${r.annotated.length} titles; pool (>=${FAMOUS_MIN_MONTHLY_VIEWS} views/mo): ${r.pool.length}`);
  console.log(
    `drops/flags: missing=${missing.length} below-threshold=${belowThreshold.length} ` +
      `redirected=${redirected.length} merged=${r.merged.length} no-pageview-data=${noPageviewData.length}`,
  );
  if (missing.length > 0) console.log(`  missing: ${missing.map((e) => e.title).join(' | ')}`);
  if (redirected.length > 0) {
    console.log(`  redirects: ${redirected.map((e) => `${e.redirectedFrom} -> ${e.title}`).join(' | ')}`);
  }
  if (r.merged.length > 0) {
    console.log(`  merged: ${r.merged.map((m) => `${m.dropped} == ${m.canonical}`).join(' | ')}`);
  }

  console.log(`\nper-bucket (annotated -> pool), with view-range samples:`);
  for (const bucket of Object.keys(perBucketCounts(r.annotated))) {
    const inBucket = r.annotated
      .filter((e) => e.bucket === bucket)
      .sort((a, b) => b.monthlyViews - a.monthlyViews);
    const poolCount = r.pool.filter((e) => e.bucket === bucket).length;
    console.log(`  ${bucket}: ${inBucket.length} -> ${poolCount}`);
    // 5 samples spanning the view range: max, 25th pct, median, 75th pct, min.
    const picks = [0, 0.25, 0.5, 0.75, 1].map(
      (q) => inBucket[Math.min(inBucket.length - 1, Math.round(q * (inBucket.length - 1)))],
    );
    for (const e of picks) {
      console.log(`      ${e.title} — ${e.monthlyViews}/mo [${e.status}]`);
    }
  }

  console.log(`\nHTTP requests: ${requestCount()}; wall time: ${(wallTimeMs / 1000).toFixed(1)}s`);
  console.log(`wrote ${join(DATA_DIR, 'annotated.json')}`);
  console.log(`wrote ${join(DATA_DIR, 'pool.json')}`);
}

// --- Phase 2: quirky pool -----------------------------------------------------

async function runQuirky(): Promise<void> {
  const t0 = Date.now();
  console.log(`gen-pairs Phase 2 quirky pool — agent: ${GEN_AGENT}`);
  const q = await buildQuirkyPool();
  const wallTimeMs = Date.now() - t0;

  const below = q.annotated.filter((e) => e.status === 'below-threshold');
  const missing = q.annotated.filter((e) => e.status === 'missing');
  const provenance = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-pairs (Phase 2: quirky pool)',
    source: {
      curated: 'scripts/gen-pairs/quirky.ts CURATED_QUIRKY (hand-curated novelty list)',
      overrides: 'src/race/overrides.json (Task 17 proven ≥4 titles, read-only)',
      unusualArticlesRejected:
        'Wikipedia:Unusual_articles probed and rejected: 500+ ns0 links/page dominated by album titles, TLDs, punctuation/meme titles',
    },
    pageviews: {
      project: 'en.wikipedia',
      access: 'all-access',
      agent: 'user',
      granularity: 'monthly',
      window: q.pageviewWindow,
    },
    gate: {
      minMonthlyViews: QUIRKY_MIN_MONTHLY_VIEWS,
      note: 'floor gates the curated list; Task 17 proven titles admitted below it (provenExempt)',
    },
    counts: {
      candidates: q.candidateCount,
      annotated: q.annotated.length,
      pool: q.pool.length,
      floorCleared: q.floorCleared,
      provenExempted: q.provenExempted,
      belowThreshold: below.length,
      missing: missing.length,
      mergedCanonicalDuplicates: q.merged.length,
      annotatedPerBucket: perBucketCounts(q.annotated),
      poolPerBucket: perBucketCounts(q.pool),
    },
    reconciliation: { merged: q.merged },
    run: { httpRequests: requestCount(), wallTimeMs },
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'quirky.json'), serialize(provenance, q.pool));

  console.log(
    `\ncandidates ${q.candidateCount}; annotated ${q.annotated.length}; ` +
      `quirky pool: ${q.pool.length} (${q.floorCleared} cleared >=${QUIRKY_MIN_MONTHLY_VIEWS} views/mo, ` +
      `${q.provenExempted} proven Task 17 titles admitted below floor)`,
  );
  console.log(`per-bucket pool: ${JSON.stringify(perBucketCounts(q.pool))}`);
  if (below.length > 0) {
    console.log(
      `below-threshold (dropped from pool): ` +
        below.map((e) => `${e.title} ${e.monthlyViews}`).join(' | '),
    );
  }
  if (missing.length > 0) console.log(`missing: ${missing.map((e) => e.title).join(' | ')}`);
  console.log(`\nHTTP requests: ${requestCount()}; wall time: ${(wallTimeMs / 1000).toFixed(1)}s`);
  console.log(`wrote ${join(DATA_DIR, 'quirky.json')}`);
}

// --- Phase 2: sampler + distance verification ---------------------------------

interface PoolFile {
  entries: Array<{ title: string; bucket: string }>;
}

function loadPool(name: string): PoolTitle[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as PoolFile;
  return raw.entries.map((e) => ({ title: e.title, bucket: e.bucket }));
}

// --- Task 25: quirky link-count measurement (narrowed draw space) -------------
// Offline pre-pass that measures each quirky START's outlink count and each
// quirky TARGET's inlink count, so the sampler can narrow the quirky tier to
// {insular starts} × {low-inlink targets} (Gray decision 2). The result is a
// committed, resumable cache — a re-run skips already-measured titles, and it
// is the audit evidence for the two narrowing thresholds. Cap inlink counting
// at INLINK_MEASURE_CAP so a hub target costs a bounded few requests (we only
// need to know it exceeds the threshold, not its exact hub figure).

const QUIRKY_LINKCOUNTS_FILE = 'quirky-linkcounts.json';
const INLINK_MEASURE_CAP = 2_000;

interface QuirkyLinkCountsFile extends QuirkyLinkCounts {
  provenance: {
    generatedAt: string;
    generator: string;
    measureCap: number;
    thresholds: { startMaxOutlinks: number; targetMaxInlinks: number };
    run: { httpRequests: number; wallTimeMs: number };
  };
}

function saveLinkCounts(path: string, data: QuirkyLinkCountsFile): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

function loadLinkCounts(path: string): QuirkyLinkCountsFile {
  if (!existsSync(path)) {
    return {
      startOutlinks: {},
      targetInlinks: {},
      provenance: {
        generatedAt: '',
        generator: 'scripts/gen-pairs (Task 25: quirky link-count measurement)',
        measureCap: INLINK_MEASURE_CAP,
        thresholds: {
          startMaxOutlinks: QUIRKY_START_MAX_OUTLINKS,
          targetMaxInlinks: QUIRKY_TARGET_MAX_INLINKS,
        },
        run: { httpRequests: 0, wallTimeMs: 0 },
      },
    };
  }
  return JSON.parse(readFileSync(path, 'utf8')) as QuirkyLinkCountsFile;
}

async function runQuirkyLinks(): Promise<void> {
  const t0 = Date.now();
  console.log(`gen-pairs Task 25 quirky link-count measurement — agent: ${GEN_AGENT}`);
  const quirky = loadPool('quirky.json');
  const starts = quirky.filter((q) => (QUIRKY_START_BUCKETS as readonly string[]).includes(q.bucket));
  const targets = quirky.filter((q) => (QUIRKY_TARGET_BUCKETS as readonly string[]).includes(q.bucket));

  const path = join(DATA_DIR, QUIRKY_LINKCOUNTS_FILE);
  const store = loadLinkCounts(path);
  const persist = (): void => {
    store.provenance.generatedAt = new Date().toISOString();
    store.provenance.measureCap = INLINK_MEASURE_CAP;
    store.provenance.thresholds = {
      startMaxOutlinks: QUIRKY_START_MAX_OUTLINKS,
      targetMaxInlinks: QUIRKY_TARGET_MAX_INLINKS,
    };
    store.provenance.run = { httpRequests: requestCount(), wallTimeMs: Date.now() - t0 };
    saveLinkCounts(path, store);
  };

  // STARTS: outlink (hop-1) count. queryAllLinks fully paginates (~1 req each
  // for these insular pages). Skip titles already measured (resume).
  await Promise.all(
    starts.map(async (s) => {
      if (store.startOutlinks[s.title] !== undefined) return;
      const { titles } = await queryAllLinks(s.title);
      store.startOutlinks[s.title] = titles.length;
      persist();
    }),
  );

  // TARGETS: inlink count, capped. Skip already-measured (resume).
  await Promise.all(
    targets.map(async (t) => {
      if (store.targetInlinks[t.title] !== undefined) return;
      const { count, capped } = await queryInlinksCount(t.title, INLINK_MEASURE_CAP);
      store.targetInlinks[t.title] = { count, capped };
      persist();
    }),
  );
  persist();

  // --- report the distribution so the thresholds are set from evidence --------
  const startRows = starts
    .map((s) => ({ title: s.title, bucket: s.bucket, n: store.startOutlinks[s.title] }))
    .sort((a, b) => a.n - b.n);
  const targetRows = targets
    .map((t) => ({ title: t.title, bucket: t.bucket, ...store.targetInlinks[t.title] }))
    .sort((a, b) => a.count - b.count);

  console.log(`\n=== quirky START outlink counts (insular = low) ===`);
  for (const r of startRows) {
    const keep = r.n <= QUIRKY_START_MAX_OUTLINKS ? 'KEEP' : 'drop';
    console.log(`  ${keep}  ${String(r.n).padStart(5)}  ${r.title} [${r.bucket}]`);
  }
  console.log(`\n=== quirky TARGET inlink counts (low-inlink = far) ===`);
  for (const r of targetRows) {
    const val = r.capped ? `>${INLINK_MEASURE_CAP}` : String(r.count);
    const keep = !r.capped && r.count <= QUIRKY_TARGET_MAX_INLINKS ? 'KEEP' : 'drop';
    console.log(`  ${keep}  ${val.padStart(6)}  ${r.title} [${r.bucket}]`);
  }

  const narrowed = narrowQuirky(starts, targets, store);
  console.log(
    `\nthresholds: start outlinks ≤ ${QUIRKY_START_MAX_OUTLINKS}, target inlinks ≤ ${QUIRKY_TARGET_MAX_INLINKS}`,
  );
  console.log(
    `narrowed pool: ${narrowed.starts.length}/${starts.length} starts (ceiling ${narrowed.starts.length * 3}), ` +
      `${narrowed.targets.length}/${targets.length} targets (ceiling ${narrowed.targets.length * 3})`,
  );
  console.log(`dropped starts: ${narrowed.droppedStarts.map((d) => `${d.title}(${d.outlinks})`).join(', ') || 'none'}`);
  console.log(
    `dropped targets: ${narrowed.droppedTargets.map((d) => `${d.title}(${d.capped ? '>' : ''}${d.inlinks})`).join(', ') || 'none'}`,
  );
  console.log(`\nHTTP requests: ${requestCount()}; wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`wrote ${path}`);
}

function parseArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface SampleRow {
  idx: number;
  tier: string;
  start: string;
  startBucket: string;
  target: string;
  targetBucket: string;
  verdict: string;
  distance: string;
  hop1: number;
  requests: number;
  cached: boolean;
}

/** The Phase 3 handoff shape (emit.ts `ValidatedPair`): canonical SPACE-form
 *  titles + the verified distance, tier, and buckets the emitter carries into
 *  pairs.meta.json. The emitter converts space→underscore. */
interface ValidatedEntry {
  start: string;
  target: string;
  distance: string;
  tier: string;
  startBucket: string;
  targetBucket: string;
}

/** Pretty-print data/validated.json: provenance header + one entry per line so
 *  the pair diff Gray hand-reviews stays small and readable. */
function serializeValidated(provenance: object, entries: ValidatedEntry[]): string {
  const head = JSON.stringify(provenance, null, 2);
  const lines = entries.map((e) => `    ${JSON.stringify(e)}`);
  return `{\n  "provenance": ${head.replace(/\n/g, '\n  ')},\n  "entries": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

/** Write the accepted pairs (in accepted order) to data/validated.json — the
 *  Phase 3 emitter input. Written once at the end; the per-pair distance cache
 *  is the resumable checkpoint, so a killed run re-derives the same list on
 *  replay (all cached → zero re-fetch) before this file is (re)written. */
function writeValidated(
  rows: SampleRow[],
  seed: string,
  count: number,
  terminated: string,
  wallMs: number,
): void {
  const entries: ValidatedEntry[] = rows.map((r) => ({
    start: r.start,
    target: r.target,
    distance: r.distance,
    tier: r.tier,
    startBucket: r.startBucket,
    targetBucket: r.targetBucket,
  }));
  const provenance = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-pairs (Phase 4: validated pair run)',
    seed,
    requested: count,
    accepted: entries.length,
    terminated,
    tierMix: {
      backbone: rows.filter((r) => r.tier === 'backbone').length,
      quirky: rows.filter((r) => r.tier === 'quirky').length,
    },
    narrowing: {
      startMaxOutlinks: QUIRKY_START_MAX_OUTLINKS,
      targetMaxInlinks: QUIRKY_TARGET_MAX_INLINKS,
      linkcounts: QUIRKY_LINKCOUNTS_FILE,
    },
    distanceCache: 'data/distance-cache.json (per-pair verified verdicts, audit evidence)',
    run: { httpRequests: requestCount(), wallTimeMs: wallMs },
  };
  const path = join(DATA_DIR, 'validated.json');
  writeFileSync(path, serializeValidated(provenance, entries));
  console.log(`wrote ${path} (${entries.length} validated pairs)`);
}

/** Generous per-run attempt ceiling — a bad-seed / graph-anomaly tripwire, NOT
 *  the expected budget. At the measured ~9% backbone yield a 365-pair run needs
 *  ~3.5k checks; count·(1+OVERSAMPLE)·25 ≈ 11k sits well above that so a healthy
 *  run always completes, while a pathological all-reject seed still halts
 *  politely instead of hammering Wikipedia unbounded. */
const MAX_CHECKS_PER_TARGET = 25;

async function runSample(): Promise<void> {
  const t0 = Date.now();
  const count = Number(parseArg('--count') ?? 30);
  const seed = parseArg('--seed') ?? SAMPLER_SEED;
  console.log(`gen-pairs Phase 4 sample+verify — count ${count}, seed "${seed}", agent ${GEN_AGENT}`);

  const backbone = loadPool('pool.json');
  const quirky = loadPool('quirky.json');
  const allStarts = quirky.filter((q) => (QUIRKY_START_BUCKETS as readonly string[]).includes(q.bucket));
  const allTargets = quirky.filter((q) => (QUIRKY_TARGET_BUCKETS as readonly string[]).includes(q.bucket));

  // Narrow the quirky draw space to {insular starts} × {low-inlink targets}
  // (Task 25 decision 2) BEFORE any distance check runs. The link counts are the
  // committed offline measurement; an UNMEASURED candidate is a hard error —
  // an incomplete measurement must never silently shrink the draw space.
  const counts = loadLinkCounts(join(DATA_DIR, QUIRKY_LINKCOUNTS_FILE));
  const narrowed = narrowQuirky(allStarts, allTargets, counts);
  if (narrowed.unmeasuredStarts.length > 0 || narrowed.unmeasuredTargets.length > 0) {
    throw new Error(
      `quirky narrowing aborted — unmeasured candidates (run \`quirky-links\` first): ` +
        `starts=[${narrowed.unmeasuredStarts.join(', ')}] targets=[${narrowed.unmeasuredTargets.join(', ')}]`,
    );
  }
  const quirkyStarts = narrowed.starts;
  const quirkyTargets = narrowed.targets;
  const quirkyCeiling = Math.min(quirkyStarts.length, quirkyTargets.length) * MAX_TITLE_APPEARANCES;
  const quirkyNeeded = Math.floor(count * QUIRKY_SHARE); // Bresenham telescopes to floor(count·share)

  console.log(
    `pools: backbone ${backbone.length}; quirky starts ${quirkyStarts.length}/${allStarts.length} ` +
      `(${QUIRKY_START_BUCKETS.join('/')}); quirky targets ${quirkyTargets.length}/${allTargets.length} ` +
      `(${QUIRKY_TARGET_BUCKETS.join('/')})`,
  );
  console.log(
    `narrowing (start outlinks ≤ ${QUIRKY_START_MAX_OUTLINKS}, target inlinks ≤ ${QUIRKY_TARGET_MAX_INLINKS}): ` +
      `dropped ${narrowed.droppedStarts.length} starts, ${narrowed.droppedTargets.length} targets; ` +
      `quirky ceiling ${quirkyCeiling} vs ${quirkyNeeded} needed`,
  );
  if (narrowed.droppedTargets.length > 0) {
    console.log(
      `  dropped targets: ` +
        narrowed.droppedTargets
          .map((d) => `${d.title}(${d.capped ? '>' : ''}${d.inlinks})`)
          .join(', '),
    );
  }
  // Cheap upfront feasibility guard (necessary condition). The 4+ yield
  // distribution can still fall short — the real BLOCKED-PARTIAL detection is at
  // the end of the run — but if even the ceiling can't hold the demand, stop now
  // rather than burn tens of thousands of requests on a doomed run.
  if (quirkyNeeded > quirkyCeiling) {
    throw new Error(
      `BLOCKED: narrowed quirky ceiling ${quirkyCeiling} < ${quirkyNeeded} quirky pairs needed ` +
        `(share ${QUIRKY_SHARE} × ${count}). Do NOT relax constraints silently — report BLOCKED-PARTIAL.`,
    );
  }

  const cachePath = join(DATA_DIR, 'distance-cache.json');
  const cache = loadCache(cachePath);
  const cacheHitsAtStart = Object.keys(cache).length;
  console.log(`distance cache: ${cacheHitsAtStart} verdicts already on disk (skip-on-rerun / resume)`);

  const sampler = new PairSampler(seed, backbone, quirkyStarts, quirkyTargets);
  const rows: SampleRow[] = [];
  const distanceRejects: SampleRow[] = [];
  const maxChecks = Math.ceil(count * (1 + OVERSAMPLE) * MAX_CHECKS_PER_TARGET) + 50;
  let checks = 0;
  let terminated: 'reached-count' | 'exhausted-space' | 'safety-bound' = 'reached-count';

  while (sampler.accepted < count) {
    if (checks >= maxChecks) {
      terminated = 'safety-bound';
      console.log(`hit the ${maxChecks}-check safety bound before reaching count — halting`);
      break;
    }
    const c = sampler.next();
    if (!c) {
      terminated = 'exhausted-space';
      console.log('sampler exhausted the valid pair space before reaching count');
      break;
    }
    checks++;
    const before = requestCount();
    const { entry, computed } = await getOrClassify(
      c.start.title,
      c.target.title,
      c.tier,
      liveGraph,
      cache,
    );
    if (computed) {
      entry.requests = requestCount() - before;
      saveCache(cachePath, cache); // checkpoint after EVERY freshly computed pair
    }
    const row: SampleRow = {
      idx: 0,
      tier: c.tier,
      start: c.start.title,
      startBucket: c.start.bucket,
      target: c.target.title,
      targetBucket: c.target.bucket,
      verdict: entry.verdict,
      distance: entry.distance,
      hop1: entry.hop1,
      requests: entry.requests,
      cached: !computed,
    };
    if (accepted(entry.verdict)) {
      sampler.accept(c);
      row.idx = sampler.accepted;
      rows.push(row);
      console.log(
        `  [${row.idx}/${count}] ${c.tier} ACCEPT ${c.start.title} → ${c.target.title} ` +
          `(${entry.distance}) ${computed ? entry.requests + ' req' : 'cached'}`,
      );
    } else {
      sampler.reject(c);
      distanceRejects.push(row);
      console.log(
        `        ${c.tier} reject ${c.start.title} → ${c.target.title} ` +
          `[${entry.verdict}] ${computed ? entry.requests + ' req' : 'cached'}`,
      );
    }
  }

  writeValidated(rows, seed, count, terminated, Date.now() - t0);
  reportSample(rows, distanceRejects, sampler, count, cache, Date.now() - t0, cacheHitsAtStart);

  const acceptedQuirky = rows.filter((r) => r.tier === 'quirky').length;
  if (sampler.accepted < count || acceptedQuirky < quirkyNeeded) {
    console.log(
      `\n*** BLOCKED-PARTIAL: reached ${sampler.accepted}/${count} accepted ` +
        `(quirky ${acceptedQuirky}/${quirkyNeeded}); terminated=${terminated}. ` +
        `data/validated.json holds the partial evidence; NOT ready to emit. ***`,
    );
    process.exitCode = 2;
  } else {
    console.log(
      `\nRUN COMPLETE: ${sampler.accepted}/${count} accepted ` +
        `(backbone ${sampler.accepted - acceptedQuirky}, quirky ${acceptedQuirky}); ready to emit.`,
    );
  }
}

function reportSample(
  rows: SampleRow[],
  distanceRejects: SampleRow[],
  sampler: PairSampler,
  count: number,
  cache: Record<string, CacheEntry>,
  wallMs: number,
  cacheHitsAtStart: number,
): void {
  const line = (r: SampleRow): string =>
    [
      String(r.idx).padStart(2),
      r.tier.padEnd(8),
      `${r.start} [${r.startBucket}]`.padEnd(42),
      `${r.target} [${r.targetBucket}]`.padEnd(42),
      r.distance.padEnd(4),
      r.verdict.padEnd(18),
      `h1=${r.hop1}`.padEnd(9),
      r.cached ? 'cached' : `${r.requests}req`,
    ].join(' ');

  console.log('\n=== ACCEPTED PAIRS (evidence table) ===');
  for (const r of rows) console.log(line(r));

  console.log('\n=== DISTANCE REJECTIONS ===');
  for (const r of distanceRejects) console.log(line(r));

  // sampler-level rejections by reason
  const byReason: Record<string, number> = {};
  for (const rej of sampler.rejects) byReason[rej.reason] = (byReason[rej.reason] ?? 0) + 1;

  const freshRows = [...rows, ...distanceRejects].filter((r) => !r.cached);
  const freshReq = freshRows.reduce((s, r) => s + r.requests, 0);
  const backboneFresh = freshRows.filter((r) => r.tier === 'backbone');
  const quirkyFresh = freshRows.filter((r) => r.tier === 'quirky');
  const avg = (rs: SampleRow[]): number =>
    rs.length ? Math.round(rs.reduce((s, r) => s + r.requests, 0) / rs.length) : 0;

  const acceptedBackbone = rows.filter((r) => r.tier === 'backbone').length;
  const acceptedQuirky = rows.filter((r) => r.tier === 'quirky').length;
  const rejClose = distanceRejects.filter((r) => r.verdict === 'reject-close').length;
  const rejNot4 = distanceRejects.filter((r) => r.verdict === 'reject-not4plus').length;
  const distChecks = freshRows.length; // distinct pairs distance-checked this run
  const totalDistanceTried = rows.length + distanceRejects.length;

  console.log('\n=== STATS ===');
  console.log(`accepted: ${rows.length}/${count}  (backbone ${acceptedBackbone}, quirky ${acceptedQuirky})`);
  console.log(
    `distance-checked pairs: ${totalDistanceTried} (${distChecks} fresh, ${totalDistanceTried - distChecks} from cache)`,
  );
  console.log(
    `distance rejections: ${distanceRejects.length} ` +
      `(≤2 too-close ${rejClose}, quirky-only-3 ${rejNot4})`,
  );
  const backboneTried = rows.filter((r) => r.tier === 'backbone').length +
    distanceRejects.filter((r) => r.tier === 'backbone').length;
  const quirkyTried = rows.filter((r) => r.tier === 'quirky').length +
    distanceRejects.filter((r) => r.tier === 'quirky').length;
  console.log(
    `backbone: ${acceptedBackbone}/${backboneTried} accepted ` +
      `(rejection ${backboneTried ? Math.round((100 * (backboneTried - acceptedBackbone)) / backboneTried) : 0}%), ` +
      `avg ${avg(backboneFresh)} req/pair fresh`,
  );
  console.log(
    `quirky: ${acceptedQuirky}/${quirkyTried} accepted ` +
      `(rejection ${quirkyTried ? Math.round((100 * (quirkyTried - acceptedQuirky)) / quirkyTried) : 0}%), ` +
      `avg ${avg(quirkyFresh)} req/pair fresh`,
  );
  console.log(`sampler-level rejections (pre-distance): ${JSON.stringify(byReason)}`);
  console.log(`fresh HTTP requests this run: ${freshReq} (total incl. cache: ${requestCount()})`);
  console.log(`cache size: ${Object.keys(cache).length} verdicts (was ${cacheHitsAtStart})`);

  // frequency cap audit
  const overCap = [...sampler.frequencies().entries()].filter(([, n]) => n > 3);
  console.log(`frequency-cap audit: ${overCap.length === 0 ? 'OK (no title > 3×)' : JSON.stringify(overCap)}`);

  // --- full-run projection (Phase 4 planning input) ---------------------------
  const backboneShare = 1 - QUIRKY_SHARE;
  const full = 365;
  const bbAcceptRate = backboneTried ? acceptedBackbone / backboneTried : 1;
  const qkAcceptRate = quirkyTried ? acceptedQuirky / quirkyTried : 1;
  const bbAvgReq = avg(backboneFresh) || 20;
  const qkAvgReq = avg(quirkyFresh) || 120;
  const bbTargets = Math.round(full * backboneShare);
  const qkTargets = full - bbTargets;
  const bbAttempts = bbAcceptRate ? bbTargets / bbAcceptRate : bbTargets;
  const qkAttempts = qkAcceptRate ? qkTargets / qkAcceptRate : qkTargets;
  const projReq = Math.round(bbAttempts * bbAvgReq + qkAttempts * qkAvgReq);
  const wallPerReq = freshReq > 0 ? wallMs / freshReq : 200; // ms/req observed
  const projWallMin = Math.round((projReq * wallPerReq) / 1000 / 60);

  console.log('\n=== FULL-RUN PROJECTION (365 pairs, Phase 4) ===');
  console.log(
    `backbone: ~${bbTargets} pairs / accept-rate ${(bbAcceptRate * 100).toFixed(0)}% ` +
      `→ ~${Math.round(bbAttempts)} attempts × ~${bbAvgReq} req`,
  );
  console.log(
    `quirky: ~${qkTargets} pairs / accept-rate ${(qkAcceptRate * 100).toFixed(0)}% ` +
      `→ ~${Math.round(qkAttempts)} attempts × ~${qkAvgReq} req`,
  );
  console.log(
    `projected requests: ~${projReq}; wall @ observed ${Math.round(wallPerReq)}ms/req: ~${projWallMin} min`,
  );
  console.log(`(observed this run: ${(wallMs / 1000).toFixed(0)}s wall, ${freshReq} fresh req)`);
}

// --- dispatch -----------------------------------------------------------------

const SUBCOMMAND = process.argv[2];
const dispatch: () => Promise<void> =
  SUBCOMMAND === 'quirky'
    ? runQuirky
    : SUBCOMMAND === 'quirky-links'
      ? runQuirkyLinks // Task 25: measure quirky link counts for the narrowed draw space
      : SUBCOMMAND === 'sample'
        ? runSample
        : SUBCOMMAND === 'emit'
          ? runEmit // Phase 3: flat-calendar emitter → src/race/pairs.json + pairs.meta.json
          : runHarvest; // default + explicit "harvest" (Phase 1, unchanged)

dispatch().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
