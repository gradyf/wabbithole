// Harvest: Wikipedia:Vital articles/Level 3 → titles attributed to the
// ~11 top-level domain sections (People, History, Geography, Arts, ...).
// Author-plane only — never imported by the app.
//
// Why parse-by-section instead of prop=links: the flat query returns 999
// mainspace links (measured, race-research-wiki.md §2) but LOSES which
// section each link sits under. action=parse with section=N keeps the
// attribution because a MediaWiki section slice spans until the next
// same-or-higher-level heading (nested subsections included). We still run
// the flat query afterwards and reconcile the two counts.

import {
  parseSections,
  parseSectionLinks,
  queryAllLinks,
  type ParseSection,
  type ParseLink,
} from './wiki.js';

export const VITAL_L3_PAGE = 'Wikipedia:Vital articles/Level 3';
/** The 11 domain sections measured on revid 1362666469 (2026-07-07). */
export const EXPECTED_BUCKET_COUNT = 11;

export interface HarvestEntry {
  title: string;
  bucket: string;
}

export interface HarvestResult {
  entries: HarvestEntry[];
  revid: number;
  buckets: string[];
  perBucket: Record<string, number>;
  /** Titles that appeared under more than one bucket (first bucket kept). */
  duplicates: Array<{ title: string; buckets: string[] }>;
  flat: {
    count: number;
    requests: number;
    /** In the flat link list but not attributed to any bucket. */
    inFlatOnly: string[];
    /** Attributed to a bucket but absent from the flat link list. */
    inBucketsOnly: string[];
  };
}

// --- pure pieces (verifiable against fixed fixtures) --------------------------

/**
 * The bucket sections: the toclevel-2 children of the toclevel-1 section whose
 * heading names the vital-article list ("Level 3 vital articles" as of revid
 * 1362666469). Anchored to the parent's section number so unrelated page
 * sections with subsections can never leak in.
 */
export function pickBucketSections(sections: ParseSection[]): ParseSection[] {
  const root = sections.find((s) => s.toclevel === 1 && /vital articles/i.test(s.line));
  if (!root) {
    throw new Error(
      `Could not find the top-level "... vital articles" section on ${VITAL_L3_PAGE} — page structure changed?`,
    );
  }
  const prefix = `${root.number}.`;
  return sections.filter((s) => s.toclevel === 2 && s.number.startsWith(prefix));
}

/** Mainspace, existing (non-red-link) titles from one section's parse links. */
export function mainspaceTitles(links: ParseLink[]): string[] {
  return links.filter((l) => l.ns === 0 && l.exists).map((l) => l.title);
}

/**
 * Merge per-bucket title lists into one attributed list. First bucket wins on
 * a cross-bucket duplicate (the L3 list is disjoint by design, so any
 * duplicate is worth surfacing); duplicates are reported, not dropped silently.
 */
export function attributeTitles(perBucket: Array<{ bucket: string; titles: string[] }>): {
  entries: HarvestEntry[];
  duplicates: Array<{ title: string; buckets: string[] }>;
} {
  const seen = new Map<string, string[]>(); // title -> buckets it appeared in
  const entries: HarvestEntry[] = [];
  for (const { bucket, titles } of perBucket) {
    for (const title of titles) {
      const buckets = seen.get(title);
      if (buckets) {
        if (!buckets.includes(bucket)) buckets.push(bucket);
        continue; // first attribution kept; repeat within a bucket collapsed
      }
      seen.set(title, [bucket]);
      entries.push({ title, bucket });
    }
  }
  const duplicates = [...seen.entries()]
    .filter(([, buckets]) => buckets.length > 1)
    .map(([title, buckets]) => ({ title, buckets }));
  return { entries, duplicates };
}

/** Set difference both ways between the bucketed harvest and the flat link list. */
export function reconcile(
  bucketedTitles: string[],
  flatTitles: string[],
): { inFlatOnly: string[]; inBucketsOnly: string[] } {
  const bucketed = new Set(bucketedTitles);
  const flat = new Set(flatTitles);
  return {
    inFlatOnly: [...flat].filter((t) => !bucketed.has(t)),
    inBucketsOnly: [...bucketed].filter((t) => !flat.has(t)),
  };
}

// --- IO orchestration ----------------------------------------------------------

export async function harvest(): Promise<HarvestResult> {
  const { revid, sections } = await parseSections(VITAL_L3_PAGE);
  const bucketSections = pickBucketSections(sections);
  if (bucketSections.length !== EXPECTED_BUCKET_COUNT) {
    // Not fatal — the taxonomy may legitimately gain/lose a section — but loud.
    console.warn(
      `WARNING: expected ${EXPECTED_BUCKET_COUNT} bucket sections, found ${bucketSections.length}: ` +
        bucketSections.map((s) => s.line).join(', '),
    );
  }

  // Per-section link parses run concurrently (bounded by wiki.ts's gate).
  const perBucket = await Promise.all(
    bucketSections.map(async (s) => {
      const { revid: sectionRevid, links } = await parseSectionLinks(VITAL_L3_PAGE, s.index);
      if (sectionRevid !== revid) {
        throw new Error(
          `Page revision changed mid-harvest (${revid} -> ${sectionRevid}); rerun for a consistent snapshot.`,
        );
      }
      return { bucket: s.line, titles: mainspaceTitles(links) };
    }),
  );

  const { entries, duplicates } = attributeTitles(perBucket);

  const flatResult = await queryAllLinks(VITAL_L3_PAGE);
  const { inFlatOnly, inBucketsOnly } = reconcile(
    entries.map((e) => e.title),
    flatResult.titles,
  );

  const perBucketCounts: Record<string, number> = {};
  for (const e of entries) {
    perBucketCounts[e.bucket] = (perBucketCounts[e.bucket] ?? 0) + 1;
  }

  return {
    entries,
    revid,
    buckets: bucketSections.map((s) => s.line),
    perBucket: perBucketCounts,
    duplicates,
    flat: {
      count: flatResult.titles.length,
      requests: flatResult.requests,
      inFlatOnly,
      inBucketsOnly,
    },
  };
}
