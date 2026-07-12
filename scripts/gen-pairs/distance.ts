// Link-distance verification for a candidate pair (A → B). Author-plane only.
//
// 2026-07-08 SUPERSESSION (major-topics design): the ≤2 REJECTION is now the
// ONLY distance check — Gray locked the guaranteed dist ≥3 / 4-card floor and
// formally retired the 5-card (4+) guarantee. Every pair classifies as tier
// 'backbone': surviving the ≤2 rejection IS the ≥3 proof. The old depth-3
// classification (isExactlyDist3, expandOutlinks, MAX_HOP1_FRONTIER, the quirky
// branch of classifyPair) served the dead 4+ tier and was DELETED in Task 27
// (the blessed-calendar follow-up). The committed distance cache retains
// historical quirky verdicts ('accept'/'reject-not4plus'/…); they stay valid
// audit evidence and the Verdict union still names them so a resumed run can
// read them.
//
// The single check, per spec 2.3 / race-research-wiki.md §1.3-1.4:
//
//   ≤2 REJECTION (cheap, sound, redirect-hardened). Reject any pair with a
//   direct link (dist 1) or a 2-hop path (dist 2). This is the exhaustive,
//   load-bearing kill of the reported "one/two-click" defect. It is bounded by
//   A's OUTLINK count only (the `pltitles` forward trick makes it independent of
//   B's inlink count, so hub targets stay cheap), and it can never MISS a ≤2
//   path — the dangerous direction — because both endpoints are redirect-
//   hardened: targets = {B} ∪ redirects(B), and the forward link queries use
//   redirects=1 to resolve A→redirect→X before reading X's links.
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
}

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
 * Classify a pair. Pure over `graph`, so fixtures drive every branch with
 * canned data. The caller (verifyPair in index.ts) snapshots wiki.requestCount
 * around this call for per-pair request accounting. Single-tier since the
 * 2026-07-08 supersession: surviving the ≤2 rejection IS the ≥3 verdict.
 */
export async function classifyPair(
  a: string,
  b: string,
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

  // Survived ≤2 ⇒ dist ≥3. The single-tier flow (2026-07-08 supersession) always
  // lands here: surviving the ≤2 rejection IS the guaranteed dist ≥3 / 4-card
  // floor. Record ">=3" and stop (the depth-3 refinement for the dead quirky 4+
  // tier was deleted in Task 27).
  return { verdict: 'accept-min3', distance: '>=3', detail: 'survived ≤2 (dist ≥3)', hop1 };
}

// --- live LinkGraph backed by wiki.ts ----------------------------------------

import {
  queryRedirects,
  queryAllLinks,
  queryInlinks,
  queryLinksFiltered,
} from './wiki.js';

/** The production LinkGraph — every method hits the live Wikipedia API. */
export const liveGraph: LinkGraph = {
  redirectsOf: (title) => queryRedirects(title),
  outlinks: async (title) => (await queryAllLinks(title)).titles,
  inlinks: async (title) => (await queryInlinks(title)).titles,
  linksAnyTo: (sources, targets) => queryLinksFiltered(sources, targets),
};
