// Link-distance verification for a candidate pair (A → B). Author-plane only.
//
// Two stages, per spec 2.3 / race-research-wiki.md §1.3-1.4:
//
//   1. ≤2 REJECTION (cheap, sound, redirect-hardened). Reject any pair with a
//      direct link (dist 1) or a 2-hop path (dist 2). This is the exhaustive,
//      load-bearing kill of the reported "one/two-click" defect. It is bounded
//      by A's OUTLINK count only (the `pltitles` forward trick makes it
//      independent of B's inlink count, so hub targets stay cheap), and it can
//      never MISS a ≤2 path — the dangerous direction — because both endpoints
//      are redirect-hardened: targets = {B} ∪ redirects(B), and the forward
//      link queries use redirects=1 to resolve A→redirect→X before reading X's
//      links.
//
//   2. DEPTH-3 CLASSIFICATION (expensive, ~112 req/pair). Expand A's 2-hop
//      forward frontier and intersect with the hardened inlink set of B: a hit
//      means exact distance 3, a miss means verified 4+. Only the QUIRKY tier
//      needs this (it must prove ≥4; Task 17 showed hub starts structurally
//      cannot reach 4+, so quirky uses insular starts where the expansion is
//      affordable). The BACKBONE tier only needs ≥3, which surviving stage 1
//      already proves — so backbone records "≥3" and skips the expensive
//      expansion (the amendment's affordability win; documented in the report).
//
// The verdict logic is a pure function over an injectable LinkGraph, so
// fixtures.ts can drive every branch against canned link sets with no network.

export type Tier = 'backbone' | 'quirky';

/** Injectable link-graph so the classifier is unit-testable without network. */
export interface LinkGraph {
  /** Redirect titles resolving TO `title` (ns0). */
  redirectsOf(title: string): Promise<string[]>;
  /** Raw mainspace outlinks of `title` (ns0). */
  outlinks(title: string): Promise<string[]>;
  /** Raw mainspace non-redirect inlinks of `title` (ns0). */
  inlinks(title: string): Promise<string[]>;
  /** True iff any of `sources` (≤50) links to any of `targets` (≤50). */
  linksAnyTo(sources: string[], targets: string[]): Promise<boolean>;
  /** Union of the outlinks of every title in `sources` (the 2-hop frontier). */
  expandOutlinks(sources: string[]): Promise<Set<string>>;
}

/**
 * Cap on A's hop-1 frontier for the depth-3 expansion. Above this a quirky
 * start is a hub whose 2-hop frontier is prohibitively large to expand (and,
 * per Task 17, cannot be 4+ anyway), so we decline to prove ≥4 rather than burn
 * thousands of requests. Named so Gray can retune at the Phase 4 gate.
 */
export const MAX_HOP1_FRONTIER = 1_500;

/** pltitles / titles multivalue hard cap for normal callers (measured). */
const BATCH = 50;

export type Verdict =
  | 'accept' // dist verified to the tier's requirement (exact distance in `distance`)
  | 'accept-min3' // backbone: dist ≥3 proven, exact 3-vs-4+ not refined
  | 'reject-close' // dist ≤2 (the reported defect) — never ship
  | 'reject-not4plus' // quirky: dist is exactly 3, quirky requires ≥4
  | 'reject-unverifiable'; // quirky start too hub-like to prove ≥4

export interface PairVerdict {
  verdict: Verdict;
  /** Recorded verified distance for Phase 3 provenance. */
  distance: '<=2' | '3' | '4+' | '>=3';
  detail: string;
  /** Hop-1 frontier size (A's outlink count) — informs cost/cap reporting. */
  hop1: number;
}

export function accepted(v: Verdict): boolean {
  return v === 'accept' || v === 'accept-min3';
}

/** Chunk a list into groups of ≤BATCH for multivalue API params. */
function chunk<T>(items: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Does A reach B in ≤2 clicks? Redirect-hardened, forward-only, bounded by A's
 * outlink count. `targets` = {B} ∪ redirects(B).
 */
async function reachableLeq2(
  targets: string[],
  f1: string[],
  graph: LinkGraph,
): Promise<{ close: boolean; dist?: 1 | 2 }> {
  // dist 1: A links directly to B (or a redirect of B). f1 is A's raw outlinks;
  // a link to a redirect-of-B appears as that redirect title, which is in
  // `targets`, so the raw set-intersection catches it.
  const targetSet = new Set(targets);
  if (f1.some((t) => targetSet.has(t))) return { close: true, dist: 1 };

  // dist 2: some hop-1 node X links to B (or a redirect of B). One filtered
  // query per 50-node batch; redirects=1 resolves X if A linked to it via a
  // redirect. Batches over BOTH sources and targets (targets rarely >50).
  for (const src of chunk(f1)) {
    for (const tgt of chunk(targets)) {
      if (await graph.linksAnyTo(src, tgt)) return { close: true, dist: 2 };
    }
  }
  return { close: false };
}

/**
 * Given a pair that survived the ≤2 check (so dist ≥3), is it EXACTLY 3?
 * dist 3 ⟺ some node in A's 2-hop forward frontier links to B ⟺
 * expandOutlinks(F1) ∩ [inlinks(B) ∪ inlinks(redirects(B))] ≠ ∅.
 */
async function isExactlyDist3(
  b: string,
  redirectsOfB: string[],
  f1: string[],
  graph: LinkGraph,
): Promise<boolean> {
  const f2 = await graph.expandOutlinks(f1);
  const reachB1 = new Set<string>();
  for (const t of await graph.inlinks(b)) reachB1.add(t);
  for (const r of redirectsOfB) {
    for (const t of await graph.inlinks(r)) reachB1.add(t);
  }
  for (const y of f2) if (reachB1.has(y)) return true;
  return false;
}

/**
 * Classify a pair. Pure over `graph`, so fixtures drive every branch with
 * canned data. The caller (verifyPair in index.ts) snapshots wiki.requestCount
 * around this call for per-pair request accounting.
 */
export async function classifyPair(
  a: string,
  b: string,
  tier: Tier,
  graph: LinkGraph,
): Promise<PairVerdict> {
  const redirectsOfB = await graph.redirectsOf(b);
  const targets = [b, ...redirectsOfB];
  const f1 = await graph.outlinks(a);
  const hop1 = f1.length;

  const leq2 = await reachableLeq2(targets, f1, graph);
  if (leq2.close) {
    return {
      verdict: 'reject-close',
      distance: '<=2',
      detail: `dist ${leq2.dist} (${leq2.dist === 1 ? 'direct link' : 'meet-in-the-middle'})`,
      hop1,
    };
  }

  // Survived ≤2 ⇒ dist ≥3.
  if (tier === 'backbone') {
    // Backbone only requires ≥3 (4-card floor). Both dist-3 and dist-4+ satisfy
    // it, so we record "≥3" and skip the expensive depth-3 refinement (which,
    // for hub starts, would be thousands of requests).
    return { verdict: 'accept-min3', distance: '>=3', detail: 'survived ≤2 (dist ≥3)', hop1 };
  }

  // Quirky tier must prove ≥4 (5-card floor). Run the depth-3 check.
  if (hop1 > MAX_HOP1_FRONTIER) {
    return {
      verdict: 'reject-unverifiable',
      distance: '>=3',
      detail: `quirky start too hub-like to prove ≥4 (|F1|=${hop1} > ${MAX_HOP1_FRONTIER})`,
      hop1,
    };
  }
  const dist3 = await isExactlyDist3(b, redirectsOfB, f1, graph);
  if (dist3) {
    return {
      verdict: 'reject-not4plus',
      distance: '3',
      detail: 'depth-3 hit: exact dist 3, quirky requires ≥4',
      hop1,
    };
  }
  return { verdict: 'accept', distance: '4+', detail: 'depth-3 miss: dist ≥4', hop1 };
}

// --- live LinkGraph backed by wiki.ts ----------------------------------------

import {
  queryRedirects,
  queryAllLinks,
  queryInlinks,
  queryLinksFiltered,
  queryOutlinksUnion,
} from './wiki.js';

/** The production LinkGraph — every method hits the live Wikipedia API. */
export const liveGraph: LinkGraph = {
  redirectsOf: (title) => queryRedirects(title),
  outlinks: async (title) => (await queryAllLinks(title)).titles,
  inlinks: async (title) => (await queryInlinks(title)).titles,
  linksAnyTo: (sources, targets) => queryLinksFiltered(sources, targets),
  expandOutlinks: async (sources) => (await queryOutlinksUnion(sources)).titles,
};
