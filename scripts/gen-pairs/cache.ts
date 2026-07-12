// Distance-verdict checkpoint. Author-plane only.
//
// The depth-3 check costs ~112 requests / ~29s per pair (race-research-wiki.md
// §1.4). Phase 4's full run (365 pairs + oversample) takes 40-60 min, and
// agents in this project keep getting killed mid-run by infra errors. So every
// pair's verdict is persisted to disk the instant it is computed, keyed by the
// directional pair, and a re-run (or a successor agent) skips any pair already
// in the cache — NOTHING already verified is re-fetched. The worst an
// interruption costs is the single in-flight pair (its ~112 requests restart),
// never the whole run.
//
// The write is atomic (temp file + rename) so a kill mid-write cannot corrupt
// the cache. The file stays tiny: it stores VERDICTS (a handful of fields per
// pair), never the link dumps behind them.

import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';

import { classifyPair, type LinkGraph, type Tier, type PairVerdict } from './distance.js';

export interface CacheEntry extends PairVerdict {
  tier: Tier;
  /** HTTP requests this verdict cost when first computed (0 for cache hits). */
  requests: number;
  at: string;
}

export type DistanceCache = Record<string, CacheEntry>;

/** Directional key — distance A→B is not symmetric. */
export function cacheKey(start: string, target: string): string {
  return `${start}=>${target}`;
}

export function loadCache(path: string): DistanceCache {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as DistanceCache;
}

/** Atomic persist: write a temp sibling then rename over the target. */
export function saveCache(path: string, cache: DistanceCache): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, path);
}

/**
 * Return the cached verdict without touching the graph if present; otherwise
 * classify against the graph and store it in the (in-memory) cache. Does NOT
 * persist or count requests — the caller wraps it with request accounting and
 * saveCache so the checkpoint semantics live in one place. `computed` tells the
 * caller whether a graph round-trip happened (drives per-pair request timing
 * and the persist).
 */
export async function getOrClassify(
  start: string,
  target: string,
  tier: Tier,
  graph: LinkGraph,
  cache: DistanceCache,
): Promise<{ entry: CacheEntry; computed: boolean }> {
  const key = cacheKey(start, target);
  const hit = cache[key];
  if (hit) return { entry: hit, computed: false };
  const verdict = await classifyPair(start, target, graph);
  const entry: CacheEntry = { ...verdict, tier, requests: 0, at: new Date().toISOString() };
  cache[key] = entry;
  return { entry, computed: true };
}
