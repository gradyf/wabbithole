// Orchestrator: harvest -> resolve -> write the committed pool snapshot.
// Author-plane only (spec 2.1): runs on a laptop, never in `vercel build`.
//
//   npx tsx scripts/gen-pairs/index.ts
//
// Outputs (committed, deterministic input for Phase 2's sampler):
//   scripts/gen-pairs/data/annotated.json  — every harvested title, annotated
//   scripts/gen-pairs/data/pool.json       — the famous-tier gated subset
//
// Phase 1 scope only: no sampling, no distance checks, no calendar emission.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { harvest } from './harvest.js';
import { resolve, FAMOUS_MIN_MONTHLY_VIEWS, type AnnotatedEntry } from './resolve.js';
import { requestCount, GEN_AGENT } from './wiki.js';

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

async function main(): Promise<void> {
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

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
