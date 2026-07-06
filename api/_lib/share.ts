// Shared parsing/validation/formatting for the two public share endpoints
// (api/t.ts — the HTML share page, api/og.ts — the 1200x630 card image).
// Both are UNAUTHENTICATED, GET-only, and a pure function of their URL, so
// everything here is deterministic and side-effect free.

import { validLang } from './wikipedia.js';

export const MAX_TITLES = 12;
export const MAX_TITLE_LEN = 300; // after decodeURIComponent

export interface Trail {
  lang: string;
  titles: string[]; // decoded, display form (underscores -> spaces)
}

export interface RaceMeta {
  date: string; // YYYY-MM-DD
  cards?: number; // 1..999; the race's spawned-card count (may exceed titles.length)
}

// Validate a language + a list of already-decoded titles into a Trail.
// Returns null on ANY failure; callers decide how to present that (the HTML
// route redirects home, the image route 400s).
export function buildTrail(lang: string | null, decodedTitles: string[]): Trail | null {
  if (!validLang(lang)) return null;
  if (decodedTitles.length === 0 || decodedTitles.length > MAX_TITLES) return null;

  const titles: string[] = [];
  for (const decoded of decodedTitles) {
    if (decoded.length === 0 || decoded.length > MAX_TITLE_LEN) return null;
    const display = decoded.replace(/_/g, ' ').trim();
    if (display.length === 0) return null;
    titles.push(display);
  }
  return { lang, titles };
}

// Decode + validate the /t/{lang}/{A}/{B}/... path segments (lang first, then
// >=1 title). Used by the HTML route, which sees percent-encoded segments.
export function parseTrailSegments(segments: string[]): Trail | null {
  const parts = segments.filter(Boolean);
  if (parts.length < 2) return null; // need lang + at least one title
  const [lang, ...rawTitles] = parts;
  const decoded: string[] = [];
  for (const raw of rawTitles) {
    try {
      decoded.push(decodeURIComponent(raw));
    } catch {
      return null; // malformed percent-encoding
    }
  }
  return buildTrail(lang, decoded);
}

export type RaceResult = { ok: true; race: RaceMeta | null } | { ok: false };

// Race params are optional; if present they must both validate. `cards` without
// `race` is malformed. Returns { ok:true, race:null } when neither is present.
export function parseRaceParams(race: string | null, cards: string | null): RaceResult {
  if (race === null && cards === null) return { ok: true, race: null };
  if (race === null) return { ok: false }; // cards alone is meaningless
  if (!/^\d{4}-\d{2}-\d{2}$/.test(race)) return { ok: false };

  let cardCount: number | undefined;
  if (cards !== null) {
    if (!/^\d{1,3}$/.test(cards)) return { ok: false };
    const n = Number(cards);
    if (n < 1 || n > 999) return { ok: false };
    cardCount = n;
  }
  return { ok: true, race: { date: race, cards: cardCount } };
}

// The trail as "A → B → C". More than four cards collapses the middle:
// "A → B → … → Z" (matches the app's derived-title voice; arrow is U+2192,
// present in Literata).
export function trailDisplay(titles: string[]): string {
  if (titles.length <= 4) return titles.join(' → ');
  return [titles[0], titles[1], '…', titles[titles.length - 1]].join(' → ');
}

export function cardCount(trail: Trail, race: RaceMeta | null): number {
  return race?.cards ?? trail.titles.length;
}

export function cardsLabel(n: number): string {
  return `${n} ${n === 1 ? 'card' : 'cards'}`;
}

// HTML-escape every user-controlled value before it lands in markup. Covers
// both element-text and double/single-quoted attribute contexts.
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// The canonical SPA hash URL for this trail (underscore title form, each
// segment percent-encoded) — used for the <noscript> fallback link.
export function hashPath(trail: Trail): string {
  const segs = trail.titles.map((t) => encodeURIComponent(t.replace(/ /g, '_')));
  return `/#/${trail.lang}/${segs.join('/')}`;
}

// Absolute origin of the current request (crawlers don't resolve relative
// og:image URLs reliably, so these must be absolute).
export function requestOrigin(request: Request): string {
  const host = request.headers.get('host') ?? 'wabbithole.io';
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

// The absolute /api/og image URL mirroring this trail + race params.
export function ogImageUrl(origin: string, trail: Trail, race: RaceMeta | null): string {
  const u = new URL(`${origin}/api/og`);
  u.searchParams.set('lang', trail.lang);
  for (const t of trail.titles) u.searchParams.append('t', t.replace(/ /g, '_'));
  if (race) {
    u.searchParams.set('race', race.date);
    if (race.cards !== undefined) u.searchParams.set('cards', String(race.cards));
  }
  return u.toString();
}
