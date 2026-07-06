// GET /t/{lang}/{A}/{B}/.../{Z}  (optionally ?race=YYYY-MM-DD&cards=N)
//
// Two shapes of page share this route:
//
//  1. Share-only (the default): rich Open Graph / Twitter meta so link unfurls
//     show an index-card image, plus an immediate client-side redirect into the
//     SPA's hash route. These are NOT a ranking surface — every trail
//     permutation is thin, duplicate Wikipedia text — so they carry an explicit
//     noindex (meta + X-Robots-Tag) and drop the self-canonical. Their whole job
//     is the unfurl, not the search result.
//
//  2. Featured (api/_lib/featured.ts): a short, curated shelf of genuinely
//     interesting trails that ARE meant to be indexed. Self-canonical, no
//     redirect, real crawlable content. This is the deliberate exception to (1).
//
// Unauthenticated by design, GET-only, pure function of the URL -> hard
// cacheable. Wired up by vercel.json: `/t/:path*` rewrites to `/api/t` (the
// filesystem api/ routes and the SPA still win for everything else). The
// rewrite is transparent, so request.url still carries the original /t/... path.

import { handle } from './_lib/http.js';
import { featuredPath, findFeatured, type FeaturedTrail } from './_lib/featured.js';
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

// The share-only page: unfurl meta + instant redirect + noindex. No
// self-canonical (these are not meant to rank).
function sharePage(trail: Trail, race: RaceMeta | null, request: Request): Response {
  const origin = requestOrigin(request);
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
<meta name="robots" content="noindex, follow">
<title>${escapeHtml(title)} · Wabbit Hole</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Wabbit Hole">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(origin + new URL(request.url).pathname)}">
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
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': CACHE,
      'x-robots-tag': 'noindex, follow',
    },
  });
}

// A featured trail's indexable landing page: self-canonical, no redirect, real
// crawlable content (h1 = the trail, the human description, the titles as a
// visible ordered list, one prominent "Follow this trail" link to the app).
function featuredPageResponse(feat: FeaturedTrail, trail: Trail, request: Request): Response {
  const origin = requestOrigin(request);
  const canonical = origin + featuredPath(feat);
  const image = ogImageUrl(origin, trail, null);
  const hash = hashPath(trail);

  const trailStr = trailDisplay(trail.titles);
  const first = trail.titles[0];
  const last = trail.titles[trail.titles.length - 1];
  const title = trailStr;
  const description = feat.description;

  const items = trail.titles
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join('\n');

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
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{font-family:Georgia,'Times New Roman',serif;margin:0;padding:56px 24px;color:#21242b;background:#eef0f3;line-height:1.55}
main{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e3e6eb;border-radius:22px;overflow:hidden;box-shadow:0 12px 34px rgba(30,33,40,0.10)}
.bar{height:12px;background:#d9772e}
.pad{padding:40px 44px 48px}
.brand{font-family:system-ui,sans-serif;font-size:13px;font-weight:600;letter-spacing:.3px;color:#99a0ac;text-transform:uppercase}
h1{font-size:30px;line-height:1.2;margin:14px 0 0}
.lead{font-size:18px;color:#4a505b;margin:16px 0 28px}
ol{font-family:system-ui,sans-serif;font-size:16px;padding-left:22px;margin:0 0 32px}
ol li{margin:6px 0}
.cta{display:inline-block;font-family:system-ui,sans-serif;font-size:16px;font-weight:600;text-decoration:none;color:#fff;background:#d9772e;padding:13px 26px;border-radius:999px}
.cta:hover{background:#a75718}
.foot{font-family:system-ui,sans-serif;font-size:13px;color:#99a0ac;margin:34px 0 0;line-height:1.5}
.foot a{color:#99a0ac}
</style>
</head>
<body>
<main>
<div class="bar"></div>
<div class="pad">
<div class="brand">Wabbit Hole · a Wikipedia trail</div>
<h1>${escapeHtml(trailStr)}</h1>
<p class="lead">${escapeHtml(description)}</p>
<ol>
${items}
</ol>
<a class="cta" href="${escapeHtml(hash)}">Follow this trail →</a>
<p class="foot">A curated trail through Wikipedia, from ${escapeHtml(first)} to ${escapeHtml(last)}. Follow the link to open every step as a stack of index cards on <strong>Wabbit Hole</strong>, no account needed.<br><br>
Article text from <a href="https://en.wikipedia.org" rel="noopener noreferrer">Wikipedia</a>, reformatted, under <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noopener noreferrer">CC BY-SA 4.0</a>. Not affiliated with the Wikimedia Foundation.</p>
</div>
</main>
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

  // A raceless request that matches the curated shelf gets the indexable page;
  // everything else (including any race variant of a featured trail) stays
  // share-only. Exactly one canonical URL per featured trail can be indexed.
  if (race.race === null) {
    const feat = findFeatured(trail.lang, trail.titles);
    if (feat) return featuredPageResponse(feat, trail, request);
  }

  return sharePage(trail, race.race, request);
});
