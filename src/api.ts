// All Wikimedia endpoint construction lives in this module (see REVIEW.md:
// the H2-2026 API URL restructuring makes this file the designated blast radius).
// Endpoints verified 2026-07-03 against live responses; Parsoid HTML 2.8.0.

const APP_AGENT = 'WabbitHole/0.1 (https://wabbit-hole.vercel.app; gradyforrester3@gmail.com)';
const CACHE_NAME = 'rh-articles-v1';
const CACHE_MAX_ENTRIES = 60;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT = 2; // Robot policy allows 3 for REST; leave headroom for previews
const FETCH_TIMEOUT_MS = 25_000;

export type ApiErrorKind = 'missing' | 'ratelimited' | 'network' | 'http';

export class ApiError extends Error {
  kind: ApiErrorKind;
  constructor(kind: ApiErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function normTitle(t: string): string {
  return t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export function articleUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

function articleHtmlEndpoint(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/w/rest.php/v1/page/${encodeURIComponent(title.replace(/ /g, '_'))}/html`;
}

function canonicalTitleFromUrl(finalUrl: string): string | null {
  const m = finalUrl.match(/\/w\/rest\.php\/v1\/page\/([^/?]+)\/html/);
  return m ? normTitle(decodeURIComponent(m[1])) : null;
}

// --- concurrency gate ------------------------------------------------------

let active = 0;
const waiters: Array<() => void> = [];

async function withGate<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
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

async function politeFetch(url: string): Promise<Response> {
  return withGate(async () => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { 'Api-User-Agent': APP_AGENT },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (e) {
        if (attempt === 0) {
          await sleep(2000);
          continue;
        }
        throw new ApiError('network', `Network error fetching ${url}: ${e}`);
      }
      if (res.status === 429 && attempt === 0) {
        const retryAfter = Number(res.headers.get('retry-after')) || 5;
        await sleep(Math.max(retryAfter, 5) * 1000);
        continue;
      }
      return res;
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Cache API layer (available without a service worker) ------------------

async function cacheGet(url: string): Promise<{ html: string; canonicalTitle: string } | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (!hit) return null;
    const storedAt = Number(hit.headers.get('x-rh-stored-at')) || 0;
    if (Date.now() - storedAt > CACHE_MAX_AGE_MS) {
      await cache.delete(url);
      return null;
    }
    const canonical = decodeURIComponent(hit.headers.get('x-rh-canonical') ?? '');
    const html = await hit.text();
    return canonical && html ? { html, canonicalTitle: canonical } : null;
  } catch {
    return null; // Cache API unavailable (private mode etc.) — degrade silently
  }
}

async function cachePut(url: string, html: string, canonicalTitle: string): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      url,
      new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-rh-canonical': encodeURIComponent(canonicalTitle),
          'x-rh-stored-at': String(Date.now()),
        },
      }),
    );
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - CACHE_MAX_ENTRIES; i++) {
      await cache.delete(keys[i]);
    }
  } catch {
    /* best-effort */
  }
}

// --- public API -------------------------------------------------------------

export interface ArticlePayload {
  html: string;
  canonicalTitle: string;
}

const inflight = new Map<string, Promise<ArticlePayload>>();

export function getArticle(lang: string, title: string): Promise<ArticlePayload> {
  const key = `${lang}:${normTitle(title).toLowerCase()}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const url = articleHtmlEndpoint(lang, title);
    const cached = await cacheGet(url);
    if (cached) return cached;

    const res = await politeFetch(url);
    if (res.status === 404) {
      throw new ApiError('missing', `No article called “${normTitle(title)}” exists.`);
    }
    if (res.status === 429) {
      throw new ApiError('ratelimited', 'Wikipedia asked us to slow down. Try again in a few seconds.');
    }
    if (!res.ok) {
      throw new ApiError('http', `Wikipedia returned ${res.status} for “${normTitle(title)}”.`);
    }
    // Redirect titles 307 to the canonical article; fetch follows silently and
    // response.url carries the target (verified 2026-07-03).
    const canonicalTitle = canonicalTitleFromUrl(res.url) ?? normTitle(title);
    const html = await res.text();
    void cachePut(url, html, canonicalTitle);
    if (canonicalTitle !== normTitle(title)) void cachePut(articleHtmlEndpoint(lang, canonicalTitle), html, canonicalTitle);
    return { html, canonicalTitle };
  })();

  inflight.set(key, p);
  p.finally(() => inflight.delete(key)).catch(() => {});
  return p;
}

export interface SearchResult {
  title: string;
  description?: string;
}

export async function searchTitles(lang: string, q: string): Promise<SearchResult[]> {
  const url = `https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(q)}&limit=6`;
  const res = await politeFetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { pages?: Array<{ title: string; description?: string }> };
  return (data.pages ?? []).map((p) => ({ title: p.title, description: p.description ?? undefined }));
}

export async function getRandomTitle(lang: string): Promise<string> {
  // rest_v1 random 303-redirects to a concrete summary (verified 2026-07-03).
  const res = await politeFetch(`https://${lang}.wikipedia.org/api/rest_v1/page/random/summary`);
  if (res.ok) {
    const data = (await res.json()) as { titles?: { canonical?: string }; title?: string };
    const t = data.titles?.canonical ?? data.title;
    if (t) return normTitle(t);
  }
  // Fallback: Action API with origin=* (also verified).
  const res2 = await politeFetch(
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json&origin=*`,
  );
  if (!res2.ok) throw new ApiError('http', 'Could not fetch a random article.');
  const data2 = (await res2.json()) as { query?: { random?: Array<{ title: string }> } };
  const t2 = data2.query?.random?.[0]?.title;
  if (!t2) throw new ApiError('http', 'Could not fetch a random article.');
  return normTitle(t2);
}
