// GET /t/{lang}/{A}/{B}/.../{Z}  (optionally ?race=YYYY-MM-DD&cards=N)
// The crawlable share page for a trail: Open Graph / Twitter meta so link
// unfurls show an index-card image, plus an immediate client-side redirect into
// the SPA's hash route. Unauthenticated by design, GET-only, pure function of
// the URL -> hard cacheable.
//
// Wired up by vercel.json: `/t/:path*` rewrites to `/api/t` (the filesystem
// api/ routes and the SPA still win for everything else). The rewrite is
// transparent, so request.url still carries the original /t/... path.

import { handle } from './_lib/http.js';
import {
  escapeHtml,
  hashPath,
  ogImageUrl,
  parseRaceParams,
  parseTrailSegments,
  requestOrigin,
  trailDisplay,
  cardsLabel,
  cardCount,
  type RaceMeta,
  type Trail,
} from './_lib/share.js';

const CACHE = 'public, max-age=86400, s-maxage=86400, immutable';

// Invalid input on the HTML route sends humans (and crawlers) to the app home
// rather than a raw 400 — friendlier than a JSON error for a link someone
// clicked. (The image route, api/og, 400s instead.)
function redirectHome(): Response {
  return new Response(null, { status: 302, headers: { location: '/', 'cache-control': CACHE } });
}

function ogTitle(trail: Trail): string {
  return trailDisplay(trail.titles);
}

function ogDescription(trail: Trail, race: RaceMeta | null): string {
  const first = trail.titles[0];
  const last = trail.titles[trail.titles.length - 1];
  const n = cardCount(trail, race);
  if (race) {
    return `Daily wabbit race ${race.date}: ${first} → ${last} in ${cardsLabel(n)}.`;
  }
  if (trail.titles.length === 1) {
    return `A Wikipedia trail starting at ${first}. Follow it on Wabbit Hole.`;
  }
  return `A Wikipedia trail from ${first} to ${last} — ${cardsLabel(n)}. Follow it on Wabbit Hole.`;
}

function page(trail: Trail, race: RaceMeta | null, request: Request): Response {
  const origin = requestOrigin(request);
  const url = new URL(request.url);
  // Canonical is the /t/ path plus only the meaningful query (race/cards) —
  // never the `path` wildcard Vercel injects when it rewrites /t/* to /api/t.
  const query = race
    ? `?race=${race.date}${race.cards !== undefined ? `&cards=${race.cards}` : ''}`
    : '';
  const canonical = origin + url.pathname + query;
  const image = ogImageUrl(origin, trail, race);
  const hash = hashPath(trail);

  const title = ogTitle(trail);
  const description = ogDescription(trail, race);

  // Everything interpolated below is HTML-escaped. The redirect script does NOT
  // interpolate any title: it derives the hash target from location.pathname at
  // runtime ('/t/…' -> '/#/…'), which makes script injection impossible.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Wabbit Hole</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Wabbit Hole">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<meta http-equiv="refresh" content="0; url=${escapeHtml(hash)}">
<script>
// Derive the SPA hash target from the path we were served on — no title is ever
// interpolated into this script, so a hostile title cannot inject code.
location.replace('/#/' + location.pathname.replace(/^\\/t\\//, ''));
</script>
</head>
<body style="font-family:system-ui,sans-serif;margin:0;padding:48px;color:#21242b;background:#eef0f3">
<p>Opening this trail on <strong>Wabbit Hole</strong>…</p>
<p><a href="${escapeHtml(hash)}">Continue to ${escapeHtml(title)}</a></p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': CACHE },
  });
}

export default handle(async (request) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return redirectHome();

  const url = new URL(request.url);
  // Strip the /t/ prefix; the rest is {lang}/{A}/{B}/...
  const rest = url.pathname.replace(/^\/t\/?/, '');
  const trail = parseTrailSegments(rest.split('/'));
  if (!trail) return redirectHome();

  const race = parseRaceParams(url.searchParams.get('race'), url.searchParams.get('cards'));
  if (!race.ok) return redirectHome();

  return page(trail, race.race, request);
});
