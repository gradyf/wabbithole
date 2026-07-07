// Polite Wikipedia/Wikimedia API client for the offline pair generator.
// Author-plane only — NEVER imported by the app (spec 2.2). Mirrors the
// single-endpoint-module discipline of src/api.ts: every URL for a Wikimedia
// host is constructed in this file and nowhere else (H2-2026 URL-change risk
// makes this file the designated blast radius for the generator).
//
// Endpoints verified live 2026-07-07; measurements in
// .superpowers/sdd/race-research-wiki.md ("Endpoints used").

// Same name/repo/contact pattern as APP_AGENT in src/api.ts:5, suffixed so
// Wikimedia ops can tell generator traffic from app traffic.
export const GEN_AGENT =
  'WabbitHole-gen-pairs/0.1 (https://wabbit-hole.vercel.app; gradyforrester3@gmail.com)';

// --- single base-endpoint constants (one per host) ---------------------------
const ACTION_API = 'https://en.wikipedia.org/w/api.php';
const PAGEVIEWS_API =
  'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';

export const MAX_WORKERS = 8; // bounded concurrency, spec 2.2 says 8-10
export const QUERY_TITLE_BATCH = 50; // hard API cap for normal callers (measured: toomanyvalues at 60)
const MAX_ATTEMPTS = 5;
const MAX_MAXLAG_WAITS = 8; // maxlag waits are server-requested, not failures
const FETCH_TIMEOUT_MS = 30_000;

// --- instrumentation ---------------------------------------------------------

let httpRequests = 0;

/** Total HTTP requests issued (includes retries), for run reporting. */
export function requestCount(): number {
  return httpRequests;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- concurrency gate (same shape as src/api.ts withGate) --------------------

let active = 0;
const waiters: Array<() => void> = [];

/** Current in-flight count — exported for the NOTE-2 gate fixture only. */
export function activeWorkers(): number {
  return active;
}

/**
 * Bounded-concurrency gate. Exported so distance.ts (Phase 2, interleaved
 * callers) shares the SAME single gate as harvest/resolve — one global
 * politeness budget of MAX_WORKERS in-flight requests.
 *
 * NOTE-2 fix (task-22-review): a woken waiter must RE-CHECK the bound before
 * taking a slot. Phase 1 used `if`, which was safe only because every caller
 * arrived in a synchronous Promise.all burst (no fresh caller could interleave
 * between a release's `waiters.shift()` and the woken waiter's `active++`).
 * distance.ts introduces interleaved (non-burst) callers, where the old `if`
 * could over-admit: release wakes waiter W (active=7); a fresh caller sees 7<8
 * and takes the slot (active=8); W then blindly did active++ → 9. The `while`
 * re-checks after waking, and because there is no `await` between the check
 * failing and `active++`, the increment is atomic w.r.t. the check on JS's
 * single thread — `active` can never exceed MAX_WORKERS. Every release shifts
 * exactly one waiter, and every acquired slot is always released, so a waiter
 * that re-queues is guaranteed a later wake (no starvation).
 */
export async function withGate<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= MAX_WORKERS) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

// --- polite fetch: UA, timeout, backoff on 429/5xx/network -------------------

async function politeFetch(url: string): Promise<Response> {
  return withGate(async () => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        httpRequests++;
        res = await fetch(url, {
          headers: { 'Api-User-Agent': GEN_AGENT, 'User-Agent': GEN_AGENT },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (e) {
        if (attempt + 1 >= MAX_ATTEMPTS) {
          throw new Error(`Network failure after ${MAX_ATTEMPTS} attempts: ${url}: ${e}`);
        }
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt + 1 >= MAX_ATTEMPTS) {
          throw new Error(`HTTP ${res.status} after ${MAX_ATTEMPTS} attempts: ${url}`);
        }
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        await sleep(Math.max(retryAfter * 1000, 1000 * 2 ** attempt));
        continue;
      }
      return res;
    }
  });
}

// --- action API (en.wikipedia.org/w/api.php) ---------------------------------

interface ActionApiError {
  code: string;
  info?: string;
}

/**
 * One action-API call with maxlag=5. When the servers are lagged the API
 * answers HTTP 200 with `error.code === "maxlag"` plus a Retry-After header —
 * we honour it and retry (bounded), per the API etiquette guidelines.
 */
async function actionApi(params: Record<string, string>): Promise<any> {
  const search = new URLSearchParams({
    format: 'json',
    formatversion: '2',
    maxlag: '5',
    ...params,
  });
  const url = `${ACTION_API}?${search}`;
  for (let lagWaits = 0; ; ) {
    const res = await politeFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} from action API: ${url}`);
    const data = (await res.json()) as { error?: ActionApiError } & Record<string, unknown>;
    if (data.error?.code === 'maxlag') {
      if (++lagWaits > MAX_MAXLAG_WAITS) {
        throw new Error(`Server lagged for ${MAX_MAXLAG_WAITS} consecutive waits: ${url}`);
      }
      const retryAfter = Number(res.headers.get('retry-after')) || 5;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (data.error) {
      throw new Error(`Action API error ${data.error.code}: ${data.error.info ?? ''} (${url})`);
    }
    return data;
  }
}

// --- parse: sections + per-section links (keeps section attribution) ---------

export interface ParseSection {
  toclevel: number;
  level: string;
  line: string;
  number: string;
  index: string;
  anchor: string;
}

export interface ParseLink {
  ns: number;
  title: string;
  exists: boolean;
}

/** Section tree + current revision id of a page. */
export async function parseSections(
  page: string,
): Promise<{ revid: number; sections: ParseSection[] }> {
  // prop=sections is soft-deprecated in favour of prop=tocdata (2026 warning)
  // but still served; revisit here if it is ever removed.
  const data = await actionApi({ action: 'parse', page, prop: 'sections|revid' });
  return { revid: data.parse.revid, sections: data.parse.sections };
}

/**
 * Links appearing inside one section of a page (nested subsections included —
 * MediaWiki's section slice runs until the next same-or-higher-level heading).
 * This is what preserves section→bucket attribution; a flat prop=links query
 * loses it.
 */
export async function parseSectionLinks(
  page: string,
  section: string,
): Promise<{ revid: number; links: ParseLink[] }> {
  const data = await actionApi({ action: 'parse', page, section, prop: 'links|revid' });
  return { revid: data.parse.revid, links: data.parse.links };
}

// --- query: flat links (reconciliation) + canonical resolution ---------------

/**
 * Every mainspace link on a page, fully paginated via plcontinue
 * (pllimit=max = 500/request for normal callers). Used to reconcile the
 * bucketed harvest against the flat count (999 measured for Vital L3).
 */
export async function queryAllLinks(title: string): Promise<{ titles: string[]; requests: number }> {
  const titles: string[] = [];
  let requests = 0;
  let plcontinue: string | undefined;
  do {
    const params: Record<string, string> = {
      action: 'query',
      prop: 'links',
      titles: title,
      pllimit: 'max',
      plnamespace: '0',
    };
    if (plcontinue) params.plcontinue = plcontinue;
    const data = await actionApi(params);
    requests++;
    const page = data.query.pages[0];
    for (const l of page.links ?? []) titles.push(l.title);
    plcontinue = data.continue?.plcontinue;
  } while (plcontinue);
  return { titles, requests };
}

export interface ResolvedBatch {
  normalized: Array<{ from: string; to: string }>;
  redirects: Array<{ from: string; to: string }>;
  pages: Array<{ title: string; missing?: boolean }>;
}

/**
 * Canonical-title resolution for arbitrarily many titles, batched 50/request
 * (the measured hard cap) with `&redirects` so redirect chains are followed
 * server-side. Batches run through the shared concurrency gate.
 */
export async function resolveTitles(allTitles: string[]): Promise<ResolvedBatch> {
  const batches: string[][] = [];
  for (let i = 0; i < allTitles.length; i += QUERY_TITLE_BATCH) {
    batches.push(allTitles.slice(i, i + QUERY_TITLE_BATCH));
  }
  const results = await Promise.all(
    batches.map((batch) =>
      actionApi({ action: 'query', titles: batch.join('|'), redirects: '1' }),
    ),
  );
  const merged: ResolvedBatch = { normalized: [], redirects: [], pages: [] };
  for (const data of results) {
    merged.normalized.push(...(data.query.normalized ?? []));
    merged.redirects.push(...(data.query.redirects ?? []));
    merged.pages.push(...(data.query.pages ?? []));
  }
  return merged;
}

// --- pageviews REST (wikimedia.org) ------------------------------------------

/**
 * Monthly user pageviews for one article over [startDay, endDay]
 * (YYYYMMDD stamps). Returns the summed views, or null when the API has no
 * data for the title (HTTP 404 — treat as "no measurable traffic", do not
 * conflate with a missing article).
 */
export async function monthlyViews(
  title: string,
  startDay: string,
  endDay: string,
): Promise<number | null> {
  const slug = encodeURIComponent(title.replace(/ /g, '_'));
  const url = `${PAGEVIEWS_API}/${slug}/monthly/${startDay}/${endDay}`;
  const res = await politeFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from pageviews API: ${url}`);
  const data = (await res.json()) as { items?: Array<{ views: number }> };
  let sum = 0;
  for (const item of data.items ?? []) sum += item.views;
  return sum;
}

/**
 * The most recent complete UTC calendar month before `now`, as pageview-API
 * day stamps. Recorded in provenance so a rerun in a different month is
 * explainable.
 */
export function previousFullMonthWindow(now: Date = new Date()): {
  start: string;
  end: string;
  label: string;
} {
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 24 * 60 * 60 * 1000);
  const y = lastOfPrevMonth.getUTCFullYear();
  const m = lastOfPrevMonth.getUTCMonth() + 1;
  const mm = String(m).padStart(2, '0');
  const lastDay = String(lastOfPrevMonth.getUTCDate()).padStart(2, '0');
  return { start: `${y}${mm}01`, end: `${y}${mm}${lastDay}`, label: `${y}-${mm}` };
}

// --- distance-check link primitives (Phase 2 distance.ts) --------------------
// All redirect-hardened per race-research-wiki.md §1.3-1.4 and Task 17's v2
// checker: the dangerous error is UNDER-counting paths (labelling a real
// short pair as far), so every primitive closes a redirect gap in that
// direction. The `pltitles` filter + `redirects=1` combination lets us test
// "does any of these ≤50 source pages link to the target (or a redirect of
// it)?" in ONE request, independent of the target's inlink count (hubs).

/** Redirect titles that resolve TO `title` (ns0), fully paginated. */
export async function queryRedirects(title: string): Promise<string[]> {
  const out: string[] = [];
  let rdcontinue: string | undefined;
  do {
    const params: Record<string, string> = {
      action: 'query',
      prop: 'redirects',
      titles: title,
      rdlimit: 'max',
      rdnamespace: '0',
    };
    if (rdcontinue) params.rdcontinue = rdcontinue;
    const data = await actionApi(params);
    const page = data.query.pages[0];
    for (const r of page.redirects ?? []) out.push(r.title);
    rdcontinue = data.continue?.rdcontinue;
  } while (rdcontinue);
  return out;
}

/**
 * Every mainspace, non-redirect page that links to `title` (its inlinks),
 * fully paginated via lhcontinue. Cost scales with the target's inlink count —
 * cheap for the low-inlink novelty targets the quirky tier uses, expensive for
 * hubs (so the depth-3 backward frontier is only taken on cheap targets).
 */
export async function queryInlinks(title: string): Promise<{ titles: string[]; requests: number }> {
  const titles: string[] = [];
  let requests = 0;
  let lhcontinue: string | undefined;
  do {
    const params: Record<string, string> = {
      action: 'query',
      prop: 'linkshere',
      titles: title,
      lhlimit: 'max',
      lhnamespace: '0',
      lhshow: '!redirect',
    };
    if (lhcontinue) params.lhcontinue = lhcontinue;
    const data = await actionApi(params);
    requests++;
    const page = data.query.pages[0];
    for (const l of page.linkshere ?? []) titles.push(l.title);
    lhcontinue = data.continue?.lhcontinue;
  } while (lhcontinue);
  return { titles, requests };
}

/**
 * True iff ANY of `sources` (≤50 page titles) links to ANY of `targets`
 * (≤50 titles). `redirects=1` resolves a source that is itself a redirect to
 * its real page before reading its links (closes the A→redirect→X→B gap on the
 * forward side); `pltitles` filters server-side so one request answers the
 * whole batch regardless of how many links each source has.
 */
export async function queryLinksFiltered(
  sources: string[],
  targets: string[],
): Promise<boolean> {
  if (sources.length === 0 || targets.length === 0) return false;
  const data = await actionApi({
    action: 'query',
    prop: 'links',
    titles: sources.join('|'),
    pltitles: targets.join('|'),
    pllimit: 'max',
    plnamespace: '0',
    redirects: '1',
  });
  for (const page of data.query.pages ?? []) {
    if ((page.links ?? []).length > 0) return true;
  }
  return false;
}

/**
 * Union of the mainspace outlinks of every title in `sources`, batched
 * 50/request and fully paginated. `redirects=1` canonicalises source pages
 * that are redirects before reading their links. This is the expensive 2-hop
 * forward-frontier expansion (race-research-wiki.md §1.4: ~110 requests for a
 * 500-node hop-1 frontier) — reserved for pairs that already survived the
 * cheap ≤2 check.
 */
export async function queryOutlinksUnion(
  sources: string[],
): Promise<{ titles: Set<string>; requests: number }> {
  const union = new Set<string>();
  let requests = 0;
  const batches: string[][] = [];
  for (let i = 0; i < sources.length; i += QUERY_TITLE_BATCH) {
    batches.push(sources.slice(i, i + QUERY_TITLE_BATCH));
  }
  await Promise.all(
    batches.map(async (batch) => {
      let plcontinue: string | undefined;
      do {
        const params: Record<string, string> = {
          action: 'query',
          prop: 'links',
          titles: batch.join('|'),
          pllimit: 'max',
          plnamespace: '0',
          redirects: '1',
        };
        if (plcontinue) params.plcontinue = plcontinue;
        const data = await actionApi(params);
        requests++;
        for (const page of data.query.pages ?? []) {
          for (const l of page.links ?? []) union.add(l.title);
        }
        plcontinue = data.continue?.plcontinue;
      } while (plcontinue);
    }),
  );
  return { titles: union, requests };
}
