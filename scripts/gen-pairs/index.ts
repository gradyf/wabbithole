// Orchestrator. Author-plane only (spec 2.1): runs on a laptop, never in
// `vercel build`. Subcommands (2026-07-08 major-topics design):
//
//   npx tsx scripts/gen-pairs/index.ts                 # Phase 1: harvest+resolve (default)
//   npx tsx scripts/gen-pairs/index.ts topics          # resolve the authored topics pool
//   npx tsx scripts/gen-pairs/index.ts sample --count 365 [--seed S]  # draw+verify pairs (≤2 check only)
//   npx tsx scripts/gen-pairs/index.ts emit [--cutover N]             # flat calendar
//
//   The dead two-tier `quirky` / `quirky-links` subcommands (2026-07-08
//   supersession) were DELETED in Task 27; unknown subcommands still fail loudly.
//
// Outputs (committed; deterministic inputs downstream):
//   data/annotated.json     — every Vital-L3 title, annotated  (Phase 1, historical)
//   data/pool.json          — the famous-tier gated subset      (Phase 1, historical)
//   data/topics.json        — the AUTHORED major-topics list ({title, bucket} × ~420)
//   data/topics-annotated.json — the resolve pass over topics.json; in-pool
//                             survivors are THE sampling pool (all of them —
//                             deliberate deviation from the synthesis's "first
//                             365": a larger pool gives more variety under the
//                             ≤3 frequency cap)
//   data/distance-cache.json— per-pair distance verdicts (resumable checkpoint)
//   data/validated.json     — the arranged, verified 365-pair list (emit input)
//   data/legacy-pairs.json  — frozen copy of the pre-flat 120-pair rotation (emit input)
//   ../../src/race/pairs.json      — the flat, calendar-pinned schedule
//   ../../src/race/pairs.meta.json — provenance sidecar, NOT imported by the app

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { harvest, type HarvestEntry } from './harvest.js';
import { resolve, FAMOUS_MIN_MONTHLY_VIEWS, inPool, type AnnotatedEntry } from './resolve.js';
import { requestCount, GEN_AGENT } from './wiki.js';
import {
  PairSampler,
  OVERSAMPLE,
  MAX_TITLE_APPEARANCES,
  arrangeCalendar,
  type PoolTitle,
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

// --- Phase 2: sampler + distance verification ---------------------------------

// --- 2026-07-08 major-topics design: authored topics + resolve pass -----------

/** The AUTHORED major-topics list (data/topics.json), loaded into the
 *  harvest-output shape so resolve.ts consumes it unchanged. */
function loadTopics(): HarvestEntry[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'topics.json'), 'utf8')) as {
    entries?: Array<{ title?: unknown; bucket?: unknown }>;
  };
  const entries = raw.entries ?? [];
  if (entries.length === 0) throw new Error('topics.json has no entries');
  return entries.map((e, i) => {
    if (typeof e.title !== 'string' || typeof e.bucket !== 'string') {
      throw new Error(`topics.json entry ${i} is malformed (need {title, bucket} strings)`);
    }
    return { title: e.title, bucket: e.bucket };
  });
}

/** The sampling pool = ALL in-pool survivors of the topics resolve pass.
 *  Deliberate deviation from the synthesis's "first 365" (documented in the
 *  Task 25 report): a larger pool gives more variety under the ≤3 cap. */
function loadTopicsPool(): PoolTitle[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'topics-annotated.json'), 'utf8')) as {
    entries: AnnotatedEntry[];
  };
  return raw.entries
    .filter((e) => inPool(e.status))
    .map((e) => ({ title: e.title, bucket: e.bucket }));
}

/** Resolve pass over the authored topics: canonicalize via &redirects, drop
 *  404s, apply the 20k views/month recognizability gate, dedupe
 *  post-canonicalization. Writes data/topics-annotated.json (every authored
 *  title annotated — the audit evidence for what flunked and why). */
async function runTopics(): Promise<void> {
  const t0 = Date.now();
  console.log(`gen-pairs topics resolve (major-topics design) — agent: ${GEN_AGENT}`);
  const authored = loadTopics();
  const domains = [...new Set(authored.map((e) => e.bucket))];
  console.log(`authored topics: ${authored.length} across ${domains.length} domains`);

  const r = await resolve(authored);
  const wallTimeMs = Date.now() - t0;

  const missing = r.annotated.filter((e) => e.status === 'missing');
  const below = r.annotated.filter((e) => e.status === 'below-threshold');
  const redirected = r.annotated.filter((e) => e.redirectedFrom !== undefined);

  const provenance = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-pairs (2026-07-08 major-topics design: topics resolve)',
    source: {
      authored: 'scripts/gen-pairs/data/topics.json (hand-authored fun-register list, see its provenance)',
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
      authored: authored.length,
      annotated: r.annotated.length,
      pool: r.pool.length,
      missing: missing.length,
      belowThreshold: below.length,
      resolvedFromRedirect: redirected.length,
      mergedCanonicalDuplicates: r.merged.length,
      annotatedPerBucket: perBucketCounts(r.annotated),
      poolPerBucket: perBucketCounts(r.pool),
    },
    reconciliation: { merged: r.merged },
    run: { httpRequests: requestCount(), wallTimeMs },
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'topics-annotated.json'), serialize(provenance, r.annotated));

  console.log(`\nannotated ${r.annotated.length}; pool (>=${FAMOUS_MIN_MONTHLY_VIEWS} views/mo): ${r.pool.length}`);
  console.log(`per-domain pool: ${JSON.stringify(perBucketCounts(r.pool))}`);
  if (missing.length > 0) {
    console.log(`MISSING (${missing.length}): ${missing.map((e) => e.title).join(' | ')}`);
  }
  if (below.length > 0) {
    console.log(
      `below-threshold (${below.length}): ` +
        below
          .sort((a, b) => a.monthlyViews - b.monthlyViews)
          .map((e) => `${e.title} ${e.monthlyViews}`)
          .join(' | '),
    );
  }
  if (redirected.length > 0) {
    console.log(`redirects: ${redirected.map((e) => `${e.redirectedFrom} -> ${e.title}`).join(' | ')}`);
  }
  if (r.merged.length > 0) {
    console.log(`merged: ${r.merged.map((m) => `${m.dropped} == ${m.canonical}`).join(' | ')}`);
  }
  if (r.pool.length < 300) {
    console.log(`\n*** POOL TOO SMALL: ${r.pool.length} survivors < 300 — author replacements and re-run ***`);
    process.exitCode = 2;
  }
  console.log(`\nHTTP requests: ${requestCount()}; wall time: ${(wallTimeMs / 1000).toFixed(1)}s`);
  console.log(`wrote ${join(DATA_DIR, 'topics-annotated.json')}`);
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

/** The emitter handoff shape (emit.ts `ValidatedPair`): canonical SPACE-form
 *  titles + the verified distance and domains the emitter carries into
 *  pairs.meta.json. NO tier field (2026-07-08 supersession: single tier). The
 *  emitter converts space→underscore. Entry order in validated.json IS the
 *  calendar order: emit splices validated[i - cutover] sequentially, so the
 *  arrangeCalendar() ordering must be applied before writing. */
interface ValidatedEntry {
  start: string;
  target: string;
  distance: string;
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

/** Arrange the accepted pairs (adjacent days never share a start- or
 *  target-domain) and write data/validated.json — the emitter input. Written
 *  once at the end; the per-pair distance cache is the resumable checkpoint, so
 *  a killed run re-derives the same list on replay (all cached → zero re-fetch)
 *  before this file is (re)written. Returns the arrangement evidence. */
function writeValidated(
  rows: SampleRow[],
  seed: string,
  count: number,
  terminated: string,
  wallMs: number,
): { violations: number[]; passes: number } {
  const accepted: ValidatedEntry[] = rows.map((r) => ({
    start: r.start,
    target: r.target,
    distance: r.distance,
    startBucket: r.startBucket,
    targetBucket: r.targetBucket,
  }));
  const arranged = arrangeCalendar(accepted, seed);
  const provenance = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-pairs (2026-07-08 major-topics design: validated pair run)',
    seed,
    requested: count,
    accepted: accepted.length,
    terminated,
    pool: 'data/topics-annotated.json in-pool survivors (authored major topics)',
    distanceCheck: '≤2-click rejection only (guaranteed dist ≥3 / 4-card floor; depth-3 retired)',
    arrangement: {
      method: 'arrangeCalendar: seeded shuffle + bounded greedy repair (sample.ts)',
      adjacencyViolations: arranged.violations,
      passes: arranged.passes,
    },
    distanceCache: 'data/distance-cache.json (per-pair verified verdicts, audit evidence)',
    run: { httpRequests: requestCount(), wallTimeMs: wallMs },
  };
  const path = join(DATA_DIR, 'validated.json');
  writeFileSync(path, serializeValidated(provenance, arranged.calendar));
  console.log(
    `wrote ${path} (${arranged.calendar.length} validated pairs, arranged; ` +
      `adjacency violations ${arranged.violations.length}, passes ${arranged.passes})`,
  );
  return { violations: arranged.violations, passes: arranged.passes };
}

/** Generous per-run attempt ceiling — a bad-seed / graph-anomaly tripwire, NOT
 *  the expected budget. Even at the Vital pool's worst measured ~9% ≥3 yield a
 *  365-pair run needs ~4k checks; count·(1+OVERSAMPLE)·25 ≈ 11k sits well above
 *  that so a healthy run always completes, while a pathological all-reject seed
 *  still halts politely instead of hammering Wikipedia unbounded. */
const MAX_CHECKS_PER_TARGET = 25;

/** The 2026-07-08 major-topics run: single tier, authored topics pool, the
 *  ≤2-click rejection as the ONLY distance check (every accept is verified
 *  dist ≥3 — the 4-card floor Gray locked). Ends with the deterministic
 *  arrangeCalendar() pass and writes data/validated.json in calendar order. */
async function runSample(): Promise<void> {
  const t0 = Date.now();
  const count = Number(parseArg('--count') ?? 365);
  const seed = parseArg('--seed') ?? SAMPLER_SEED;
  console.log(
    `gen-pairs sample+verify (major-topics, single tier) — count ${count}, seed "${seed}", agent ${GEN_AGENT}`,
  );

  const pool = loadTopicsPool();
  const domains = perBucketCounts(pool.map((p) => ({ ...p, monthlyViews: 0, status: 'ok' as const })));
  console.log(`topics pool: ${pool.length} titles across ${Object.keys(domains).length} domains`);
  console.log(`per-domain: ${JSON.stringify(domains)}`);

  // Feasibility: each accepted pair consumes 2 endpoint slots; the pool offers
  // pool×cap slots. Necessary condition only — the ≤2 yield is the real gate.
  const pairCeiling = Math.floor((pool.length * MAX_TITLE_APPEARANCES) / 2);
  if (count > pairCeiling) {
    throw new Error(
      `BLOCKED: pool ceiling ${pairCeiling} pairs (${pool.length} titles × cap ${MAX_TITLE_APPEARANCES} / 2) ` +
        `< ${count} requested. Do NOT relax constraints silently — report BLOCKED-PARTIAL.`,
    );
  }

  const cachePath = join(DATA_DIR, 'distance-cache.json');
  const cache = loadCache(cachePath);
  const cacheHitsAtStart = Object.keys(cache).length;
  console.log(`distance cache: ${cacheHitsAtStart} verdicts already on disk (skip-on-rerun / resume)`);

  // Single tier: quirky pools empty, QUIRKY_SHARE=0 → tierForSlot never picks
  // 'quirky', every candidate goes through the ≤2-only backbone verdict path.
  const sampler = new PairSampler(seed, pool, [], []);
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
        `  [${row.idx}/${count}] ACCEPT ${c.start.title} → ${c.target.title} ` +
          `(${entry.distance}) ${computed ? entry.requests + ' req' : 'cached'}`,
      );
    } else {
      sampler.reject(c);
      distanceRejects.push(row);
      console.log(
        `        reject ${c.start.title} → ${c.target.title} ` +
          `[${entry.verdict}] ${computed ? entry.requests + ' req' : 'cached'}`,
      );
    }
  }

  const arrangement = writeValidated(rows, seed, count, terminated, Date.now() - t0);
  reportRun(rows, distanceRejects, sampler, count, cache, Date.now() - t0, cacheHitsAtStart, arrangement);

  if (sampler.accepted < count) {
    console.log(
      `\n*** BLOCKED-PARTIAL: reached ${sampler.accepted}/${count} accepted; ` +
        `terminated=${terminated}. data/validated.json holds the partial evidence; NOT ready to emit. ***`,
    );
    process.exitCode = 2;
  } else {
    console.log(`\nRUN COMPLETE: ${sampler.accepted}/${count} accepted, arranged; ready to emit.`);
  }
}

function reportRun(
  rows: SampleRow[],
  distanceRejects: SampleRow[],
  sampler: PairSampler,
  count: number,
  cache: Record<string, CacheEntry>,
  wallMs: number,
  cacheHitsAtStart: number,
  arrangement: { violations: number[]; passes: number },
): void {
  const line = (r: SampleRow): string =>
    [
      String(r.idx).padStart(3),
      `${r.start} [${r.startBucket}]`.padEnd(46),
      `${r.target} [${r.targetBucket}]`.padEnd(46),
      r.distance.padEnd(4),
      r.verdict.padEnd(14),
      `h1=${r.hop1}`.padEnd(9),
      r.cached ? 'cached' : `${r.requests}req`,
    ].join(' ');

  console.log('\n=== ACCEPTED PAIRS (accept order; validated.json holds the ARRANGED order) ===');
  for (const r of rows) console.log(line(r));

  console.log('\n=== DISTANCE REJECTIONS (≤2-click: the defect this pipeline exists to kill) ===');
  for (const r of distanceRejects) console.log(line(r));

  const byReason: Record<string, number> = {};
  for (const rej of sampler.rejects) byReason[rej.reason] = (byReason[rej.reason] ?? 0) + 1;

  const freshRows = [...rows, ...distanceRejects].filter((r) => !r.cached);
  const freshReq = freshRows.reduce((s, r) => s + r.requests, 0);
  const avg = (rs: SampleRow[]): number =>
    rs.length ? Math.round(rs.reduce((s, r) => s + r.requests, 0) / rs.length) : 0;
  const tried = rows.length + distanceRejects.length;
  const acceptRate = tried ? rows.length / tried : 1;

  console.log('\n=== STATS (single tier, ≤2-only) ===');
  console.log(`accepted: ${rows.length}/${count}`);
  console.log(
    `distance-checked pairs: ${tried} (${freshRows.length} fresh, ${tried - freshRows.length} from cache); ` +
      `accept rate ${(acceptRate * 100).toFixed(0)}%`,
  );
  console.log(`avg fresh req/check: ${avg(freshRows)}; fresh HTTP requests this run: ${freshReq}`);
  console.log(`sampler-level rejections (pre-distance, free): ${JSON.stringify(byReason)}`);
  console.log(`cache size: ${Object.keys(cache).length} verdicts (was ${cacheHitsAtStart})`);

  // domain mix over accepted pairs (both endpoints)
  const domainUse: Record<string, number> = {};
  for (const r of rows) {
    domainUse[r.startBucket] = (domainUse[r.startBucket] ?? 0) + 1;
    domainUse[r.targetBucket] = (domainUse[r.targetBucket] ?? 0) + 1;
  }
  console.log(`domain endpoint usage: ${JSON.stringify(domainUse)}`);

  const overCap = [...sampler.frequencies().entries()].filter(([, n]) => n > MAX_TITLE_APPEARANCES);
  console.log(
    `frequency-cap audit: ${overCap.length === 0 ? `OK (no title > ${MAX_TITLE_APPEARANCES}×)` : JSON.stringify(overCap)}`,
  );
  console.log(
    `arrangement: ${arrangement.violations.length === 0 ? 'OK (0 adjacency violations)' : `VIOLATIONS at days ${arrangement.violations.join(', ')}`} ` +
      `in ${arrangement.passes} pass(es)`,
  );
  console.log(`wall time: ${(wallMs / 1000 / 60).toFixed(1)} min (${(wallMs / 1000).toFixed(0)}s)`);
}

// --- dispatch -----------------------------------------------------------------

const SUBCOMMAND = process.argv[2];

/** Unknown / retired subcommands fail LOUDLY (they must not fall through to the
 *  default harvest, which would fire ~1.3k live requests by accident). The dead
 *  two-tier `quirky` / `quirky-links` passes were deleted in Task 27, so they now
 *  land here alongside any unrecognized subcommand. */
function retired(name: string): () => Promise<void> {
  return async () => {
    throw new Error(
      `gen-pairs: subcommand "${name}" was RETIRED by the 2026-07-08 major-topics ` +
        `supersession (the two-tier quirky design is dead). Use: topics | sample | emit | harvest.`,
    );
  };
}

const dispatch: () => Promise<void> =
  SUBCOMMAND === 'topics'
    ? runTopics // 2026-07-08: resolve the authored major-topics pool
    : SUBCOMMAND === 'sample'
      ? runSample // single-tier draw + ≤2-only verify + arrangeCalendar
      : SUBCOMMAND === 'emit'
        ? runEmit // flat-calendar emitter → src/race/pairs.json + pairs.meta.json
        : SUBCOMMAND === undefined || SUBCOMMAND === 'harvest'
          ? runHarvest // default + explicit "harvest" (Phase 1, unchanged)
          : retired(SUBCOMMAND); // unknown (incl. retired quirky/quirky-links): fail loudly

dispatch().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
