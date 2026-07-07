// Resolve: canonicalize harvested titles (&redirects, batched 50/request),
// annotate every title with measured monthly pageviews and a status, and
// derive the famous-tier gated pool. Author-plane only — never imported by
// the app.
//
// GATE DESIGN (mixed-calendar amendment, spec Decision 1 AMENDED): the
// famous-tier threshold is a named constant, and below-threshold titles are
// NEVER silently discarded — every title is annotated and kept in the full
// list, because Phase 2's sampler needs the raw pageview numbers to build the
// famous backbone AND may source its "quirky" >=4 tier from below-threshold
// entries (research: Continental_drift, a Gray-approved quirky pair member,
// measures 8,772 views/month — under the famous gate).

import {
  resolveTitles,
  monthlyViews,
  previousFullMonthWindow,
  type ResolvedBatch,
} from './wiki.js';
import type { HarvestEntry } from './harvest.js';

/**
 * Famous-tier recognizability gate, in user pageviews per month
 * (race-research-wiki.md §2: Solar_System 104,771/mo vs an obscure Good
 * Article at 44/mo; spec 2.2 names "~20k views/month").
 */
export const FAMOUS_MIN_MONTHLY_VIEWS = 20_000;

export type EntryStatus = 'ok' | 'below-threshold' | 'missing' | 'resolved-from-redirect';

export interface AnnotatedEntry {
  /** Canonical article title, API form (spaces, exact case). */
  title: string;
  bucket: string;
  /** Measured user pageviews over the provenance month window (0 if missing/no data). */
  monthlyViews: number;
  status: EntryStatus;
  /** Present when the harvested title reached this entry through a redirect. */
  redirectedFrom?: string;
  /** Present (false) when the pageviews API had no data series for the title. */
  pageviewData?: false;
}

export interface CanonicalEntry {
  /** Canonical title (== original when no normalization/redirect applied). */
  title: string;
  bucket: string;
  missing: boolean;
  redirectedFrom?: string;
}

export interface ResolveResult {
  /** Every harvested title, annotated — the superset Phase 2 samples from. */
  annotated: AnnotatedEntry[];
  /** The famous-tier gated pool: exists and >= FAMOUS_MIN_MONTHLY_VIEWS. */
  pool: AnnotatedEntry[];
  /** Two harvest titles collapsing onto one canonical page (first kept). */
  merged: Array<{ canonical: string; kept: string; dropped: string }>;
  pageviewWindow: { start: string; end: string; label: string };
}

// --- pure pieces (verifiable against fixed fixtures) --------------------------

/**
 * Apply a resolution batch to the harvest list: follow normalization then
 * redirect maps to the canonical title, mark pages the API reported missing,
 * and collapse canonical collisions (first harvest entry wins; the collision
 * is reported, never silent).
 */
export function canonicalize(
  entries: HarvestEntry[],
  batch: ResolvedBatch,
): { resolved: CanonicalEntry[]; merged: Array<{ canonical: string; kept: string; dropped: string }> } {
  const normalized = new Map(batch.normalized.map((n) => [n.from, n.to]));
  const redirects = new Map(batch.redirects.map((r) => [r.from, r.to]));
  const missing = new Set(batch.pages.filter((p) => p.missing).map((p) => p.title));

  const byCanonical = new Map<string, CanonicalEntry>();
  const resolved: CanonicalEntry[] = [];
  const merged: Array<{ canonical: string; kept: string; dropped: string }> = [];

  for (const { title, bucket } of entries) {
    const normed = normalized.get(title) ?? title;
    // &redirects resolves chains server-side; one map hop suffices, but walk
    // defensively (bounded) in case a batch ever reports an intermediate hop.
    let canonical = normed;
    for (let hops = 0; hops < 5; hops++) {
      const next = redirects.get(canonical);
      if (next === undefined) break;
      canonical = next;
    }
    const wasRedirected = canonical !== normed;

    const existing = byCanonical.get(canonical);
    if (existing) {
      merged.push({ canonical, kept: existing.redirectedFrom ?? existing.title, dropped: title });
      continue;
    }
    const entry: CanonicalEntry = {
      title: canonical,
      bucket,
      missing: missing.has(canonical),
      ...(wasRedirected ? { redirectedFrom: title } : {}),
    };
    byCanonical.set(canonical, entry);
    resolved.push(entry);
  }
  return { resolved, merged };
}

/**
 * Status precedence: missing beats everything (no article, no pool);
 * below-threshold beats resolved-from-redirect (the gate outcome is what
 * Phase 2 keys on — redirect provenance survives in `redirectedFrom` either
 * way); otherwise redirect provenance is surfaced in the status.
 */
export function statusFor(views: number, missing: boolean, redirected: boolean): EntryStatus {
  if (missing) return 'missing';
  if (views < FAMOUS_MIN_MONTHLY_VIEWS) return 'below-threshold';
  return redirected ? 'resolved-from-redirect' : 'ok';
}

/** Pool membership: the article exists and clears the famous-tier gate. */
export function inPool(status: EntryStatus): boolean {
  return status === 'ok' || status === 'resolved-from-redirect';
}

// --- IO orchestration ----------------------------------------------------------

export async function resolve(entries: HarvestEntry[]): Promise<ResolveResult> {
  const batch = await resolveTitles(entries.map((e) => e.title));
  const { resolved, merged } = canonicalize(entries, batch);

  const window = previousFullMonthWindow();

  // One pageviews request per existing title (~1 req/title, bounded by the
  // shared 8-worker gate in wiki.ts). Missing titles get views 0 without a call.
  const annotated: AnnotatedEntry[] = await Promise.all(
    resolved.map(async (e): Promise<AnnotatedEntry> => {
      let views = 0;
      let noData = false;
      if (!e.missing) {
        const measured = await monthlyViews(e.title, window.start, window.end);
        if (measured === null) noData = true;
        else views = measured;
      }
      return {
        title: e.title,
        bucket: e.bucket,
        monthlyViews: views,
        status: statusFor(views, e.missing, e.redirectedFrom !== undefined),
        ...(e.redirectedFrom !== undefined ? { redirectedFrom: e.redirectedFrom } : {}),
        ...(noData ? { pageviewData: false as const } : {}),
      };
    }),
  );

  return {
    annotated,
    pool: annotated.filter((e) => inPool(e.status)),
    merged,
    pageviewWindow: window,
  };
}
