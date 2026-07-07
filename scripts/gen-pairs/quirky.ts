// Quirky pool: the "everyday-novelty" tier that supplies the mixed calendar's
// verified-≥4 pairs (spec Decision 1 AMENDED). Author-plane only.
//
// WHY A SEPARATE POOL. Task 22 proved the Vital-L3 harvest contains ZERO of the
// recognizable-novelty titles that reach distance ≥4 — its low-traffic tail is
// "broad-encyclopedic but dry" (Inorganic chemistry, History of Asia), and
// Task 17 showed verified-≥4 structurally needs a topically-insular START and a
// low-inlink TARGET, which famous hubs never are. So the quirky ≥4 tier is
// sourced here, in the Marshmallow/Whoopee-cushion register, and run through
// the SAME resolve.ts annotation path (canonicalize → pageviews → status) as
// the famous pool.
//
// SOURCE DECISIONS (reported in task-23-report.md):
//   (a) The 20 proven titles from src/race/overrides.json (Task 17's shipped
//       ≥4 overrides) — the calibration class, READ-ONLY input.
//   (b) A hand-curated novelty list (below). Wikipedia:Unusual_articles was
//       PROBED and REJECTED as a harvest source: its first page alone is 500+
//       ns0 links dominated by album titles, TLDs (.bv/.io/.su), and
//       punctuation/meme titles — the same fragmentation that made Vital L4
//       unusable. Hand curation gives control over the recognizability register
//       and the insular-start / low-inlink-target shape that ≥4 demands.
//
// Buckets are HAND-ATTRIBUTED (there is no section taxonomy to derive them
// from, unlike Vital L3). Method: the article's real-world domain — earth /
// physical phenomena → Science (these are the insular STARTS), toys / treats /
// household objects → Everyday life (the low-inlink TARGETS), musical &
// craft novelties → Arts, built gadgets → Technology. The 11 bucket labels
// match pool.json exactly so the cross-bucket sampler treats both pools
// uniformly.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolve, type AnnotatedEntry, type EntryStatus } from './resolve.js';
import type { HarvestEntry } from './harvest.js';

/**
 * Quirky recognizability floor, in user pageviews/month. Lower than the famous
 * gate (20k) by design: Continental_drift measures 8,772/mo and is a
 * Gray-approved live quirky pair member (Task 17), so 8k is the calibrated
 * floor for "quirky but recognizable". Named for retuning at the Phase 4 gate.
 */
export const QUIRKY_MIN_MONTHLY_VIEWS = 8_000;

/** API-form (space) title → hand-attributed bucket. */
export const CURATED_QUIRKY: HarvestEntry[] = [
  // --- Science: insular earth / physical phenomena (the ≥4 STARTS) ----------
  { title: 'Continental drift', bucket: 'Science' },
  { title: 'Osmosis', bucket: 'Science' },
  { title: 'Quicksand', bucket: 'Science' },
  { title: 'Static electricity', bucket: 'Science' },
  { title: 'Buoyancy', bucket: 'Science' },
  { title: 'Condensation', bucket: 'Science' },
  { title: 'Evaporation', bucket: 'Science' },
  { title: 'Capillary action', bucket: 'Science' },
  { title: 'Surface tension', bucket: 'Science' },
  { title: 'Friction', bucket: 'Science' },
  { title: 'Sinkhole', bucket: 'Science' },
  { title: 'Geyser', bucket: 'Science' },
  { title: 'Whirlpool', bucket: 'Science' },
  { title: 'Echo', bucket: 'Science' },
  { title: 'Mirage', bucket: 'Science' },
  { title: 'Erosion', bucket: 'Science' },
  { title: 'Sublimation (phase transition)', bucket: 'Science' },
  { title: 'Bioluminescence', bucket: 'Science' },
  { title: 'Petrifaction', bucket: 'Science' },
  { title: 'Ripple marks', bucket: 'Science' },
  { title: 'Dew', bucket: 'Science' },
  { title: 'Frost', bucket: 'Science' },
  { title: 'Quicklime', bucket: 'Science' },
  // --- Everyday life: toys, treats, household novelties (the low-inlink ≥4 TARGETS)
  { title: 'Marshmallow', bucket: 'Everyday life' },
  { title: 'Cotton candy', bucket: 'Everyday life' },
  { title: 'Ice pop', bucket: 'Everyday life' },
  { title: 'Whoopee cushion', bucket: 'Everyday life' },
  { title: 'Etch A Sketch', bucket: 'Everyday life' },
  { title: 'Slinky', bucket: 'Everyday life' },
  { title: 'Fidget spinner', bucket: 'Everyday life' },
  { title: 'Troll doll', bucket: 'Everyday life' },
  { title: 'Snow globe', bucket: 'Everyday life' },
  { title: 'Silly String', bucket: 'Everyday life' },
  { title: 'Sparkler', bucket: 'Everyday life' },
  { title: 'Pool noodle', bucket: 'Everyday life' },
  { title: 'Kaleidoscope', bucket: 'Everyday life' },
  { title: 'Tiddlywinks', bucket: 'Everyday life' },
  { title: 'Mood ring', bucket: 'Everyday life' },
  { title: 'Pinwheel (toy)', bucket: 'Everyday life' },
  { title: 'Yo-yo', bucket: 'Everyday life' },
  { title: "Rubik's Cube", bucket: 'Everyday life' },
  { title: 'Frisbee', bucket: 'Everyday life' },
  { title: 'Hula hoop', bucket: 'Everyday life' },
  { title: 'Teddy bear', bucket: 'Everyday life' },
  { title: 'Rubber duck', bucket: 'Everyday life' },
  { title: 'Bubble wrap', bucket: 'Everyday life' },
  { title: 'Play-Doh', bucket: 'Everyday life' },
  { title: 'Kite', bucket: 'Everyday life' },
  { title: 'Boomerang', bucket: 'Everyday life' },
  { title: 'Piñata', bucket: 'Everyday life' },
  { title: 'Popcorn', bucket: 'Everyday life' },
  { title: 'Pretzel', bucket: 'Everyday life' },
  { title: 'Doughnut', bucket: 'Everyday life' },
  { title: 'Waffle', bucket: 'Everyday life' },
  { title: 'Jelly bean', bucket: 'Everyday life' },
  { title: 'Lollipop', bucket: 'Everyday life' },
  { title: 'Candy cane', bucket: 'Everyday life' },
  { title: 'Chewing gum', bucket: 'Everyday life' },
  { title: 'Umbrella', bucket: 'Everyday life' },
  { title: 'Toothbrush', bucket: 'Everyday life' },
  { title: 'Toothpaste', bucket: 'Everyday life' },
  { title: 'Sponge (tool)', bucket: 'Everyday life' },
  { title: 'Broom', bucket: 'Everyday life' },
  { title: 'Zipper', bucket: 'Everyday life' },
  { title: 'Velcro', bucket: 'Everyday life' },
  { title: 'Paper clip', bucket: 'Everyday life' },
  { title: 'Post-it note', bucket: 'Everyday life' },
  { title: 'Stapler', bucket: 'Everyday life' },
  { title: 'Hourglass', bucket: 'Everyday life' },
  { title: 'Piggy bank', bucket: 'Everyday life' },
  { title: 'Flashlight', bucket: 'Everyday life' },
  { title: 'Candle', bucket: 'Everyday life' },
  { title: 'Lava lamp', bucket: 'Everyday life' },
  { title: 'Disco ball', bucket: 'Everyday life' },
  { title: 'Garden gnome', bucket: 'Everyday life' },
  { title: 'Scarecrow', bucket: 'Everyday life' },
  { title: 'Hammock', bucket: 'Everyday life' },
  { title: 'Trampoline', bucket: 'Everyday life' },
  { title: 'Pogo stick', bucket: 'Everyday life' },
  { title: 'Jigsaw puzzle', bucket: 'Everyday life' },
  { title: 'Bean bag', bucket: 'Everyday life' },
  // --- Arts: musical & craft novelties --------------------------------------
  { title: 'Bagpipes', bucket: 'Arts' },
  { title: 'Accordion', bucket: 'Arts' },
  { title: 'Kazoo', bucket: 'Arts' },
  { title: 'Harmonica', bucket: 'Arts' },
  { title: 'Ukulele', bucket: 'Arts' },
  { title: 'Cowbell', bucket: 'Arts' },
  { title: 'Tambourine', bucket: 'Arts' },
  { title: 'Origami', bucket: 'Arts' },
  { title: 'Juggling', bucket: 'Arts' },
  { title: 'Kalimba', bucket: 'Arts' },
  // --- Technology: small built gadgets --------------------------------------
  { title: 'Lighthouse', bucket: 'Technology' },
  { title: 'Metal detector', bucket: 'Technology' },
  { title: 'Walkie-talkie', bucket: 'Technology' },
  { title: 'View-Master', bucket: 'Technology' },
  { title: 'Segway', bucket: 'Technology' },
  { title: 'Periscope', bucket: 'Technology' },
];

/**
 * The 20 titles Task 17 shipped as verified-≥4 overrides, read live from the
 * READ-ONLY src/race/overrides.json (underscore form → API space form). Bucket
 * comes from CURATED_QUIRKY (they are all also curated); any not found would
 * throw so a future override title can't silently miss a bucket.
 */
export function overrideQuirkyTitles(): HarvestEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const overridesPath = join(here, '..', '..', 'src', 'race', 'overrides.json');
  const overrides = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<
    string,
    { start: string; target: string }
  >;
  const bucketOf = new Map(CURATED_QUIRKY.map((e) => [e.title, e.bucket]));
  const titles = new Set<string>();
  for (const { start, target } of Object.values(overrides)) {
    titles.add(start.replace(/_/g, ' '));
    titles.add(target.replace(/_/g, ' '));
  }
  return [...titles].map((title) => {
    const bucket = bucketOf.get(title);
    if (!bucket) {
      throw new Error(
        `Override title "${title}" has no bucket in CURATED_QUIRKY — add it so the sampler can place it.`,
      );
    }
    return { title, bucket };
  });
}

/** The full deduplicated candidate list (curated ∪ overrides), first wins. */
export function quirkyCandidates(): HarvestEntry[] {
  const seen = new Set<string>();
  const out: HarvestEntry[] = [];
  for (const e of [...CURATED_QUIRKY, ...overrideQuirkyTitles()]) {
    if (seen.has(e.title)) continue;
    seen.add(e.title);
    out.push(e);
  }
  return out;
}

export interface QuirkyResult {
  /** Every candidate, annotated with measured pageviews (superset). */
  annotated: AnnotatedEntry[];
  /** Quirky pool: exists and >= QUIRKY_MIN_MONTHLY_VIEWS. */
  pool: AnnotatedEntry[];
  merged: Array<{ canonical: string; kept: string; dropped: string }>;
  pageviewWindow: { start: string; end: string; label: string };
  candidateCount: number;
}

/** Quirky-relative status (the 8k floor), keeping resolve's missing verdict. */
function quirkyStatus(e: AnnotatedEntry): EntryStatus {
  if (e.status === 'missing') return 'missing';
  if (e.monthlyViews < QUIRKY_MIN_MONTHLY_VIEWS) return 'below-threshold';
  return e.redirectedFrom !== undefined ? 'resolved-from-redirect' : 'ok';
}

/**
 * Assemble + annotate the quirky pool through resolve.ts, then apply the quirky
 * floor. resolve() annotates against the 20k famous gate; we recompute status
 * against QUIRKY_MIN_MONTHLY_VIEWS but reuse its measured monthlyViews.
 */
export async function buildQuirkyPool(): Promise<QuirkyResult> {
  const candidates = quirkyCandidates();
  const r = await resolve(candidates);
  const annotated = r.annotated.map((e) => ({ ...e, status: quirkyStatus(e) }));
  return {
    annotated,
    pool: annotated.filter(
      (e) => e.status === 'ok' || e.status === 'resolved-from-redirect',
    ),
    merged: r.merged,
    pageviewWindow: r.pageviewWindow,
    candidateCount: candidates.length,
  };
}
