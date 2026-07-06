# Wabbit Hole — SEO Recommendation Set (synthesized)

## 1. The 60-second summary

**Honest ceiling.** This is a single-page app where the article views are, by design and by privacy promise, uncrawlable. That is not a bug to fix — it's the product. So the entire indexable footprint is effectively **one page** (`/`), plus, if you choose, a share route (`/t/*`) whose real job is social unfurls, not ranking. No amount of SEO turns a hobbyist Wikipedia-wander toy into an organic-traffic engine, and you should not spend money or build a blog to chase that. The realistic wins are: (a) making the one page you *do* have describe the product in words people actually search, (b) making shared links unfurl with a real card so the share-driven growth loop works, and (c) basic hygiene so Google can find and correctly represent the site.

**Where the real leverage is — and it's mostly one action.** The single highest-value move touches SEO, social, *and* a straight-up broken feature at once: **the live production deployment is stale.** The updated landing copy (the H1 "Fall down the Wikipedia rabbit hole," which is the best keyword match the product will ever have), the `/t/` share route, and the `/api/og` card image all exist in the repo but return old copy / 404 in production. Shipping the branch that contains them is the whole ballgame. Everything else in this document is small polish on top of that one deploy.

**What's already good — leave it alone.** Clerk (1.5 MB) is genuinely lazy-loaded and not in the initial bundle. `font-display: swap` is set everywhere. Logo elements reserve space with `aspect-ratio` so there's no layout shift. The `/t/` and `/api/og` code itself is well-authored (correct absolute OG URLs, 1200×630, canonical, text fallback). The www→apex redirect works. The footer already carries CC BY-SA attribution and the "not affiliated with Wikimedia" line in crawlable markup. Don't churn any of these.

---

## 2. MINOR recommendations (mechanical — will be implemented without further approval)

These are safe, uncontroversial additions with no copy or strategy judgment calls.

| # | What | Where | Effort |
|---|------|-------|--------|
| M1 | Add `public/robots.txt` — permissive (`Allow: /`), with a `Sitemap:` line pointing at `/sitemap.xml`. Do **not** `Disallow: /api/` (social scrapers need `/api/og`). | new file `public/robots.txt` | trivial |
| M2 | Add `public/sitemap.xml` listing only `https://wabbithole.io/`. No enumeration of `/t/` permutations. | new file `public/sitemap.xml` | trivial |
| M3 | Add the missing landing meta on `/`: `<link rel="canonical">`, `og:type`, `og:url`, `og:site_name`, `og:image` (+`:width`/`:height`), and the `twitter:*` set. Absolute apex URLs. | `index.html` `<head>` | trivial |
| M4 | Sync `og:title` / `og:description` to the live `<title>` / meta-description strings (they currently disagree with each other on the same page). | `index.html:9-10` | trivial |
| M5 | Add `WebSite` + `WebApplication` JSON-LD (free=true, requires JS). No fake ratings or unsubstantiated Organization. | `index.html`, inline `<script type="application/ld+json">` | trivial |
| M6 | Add `X-Robots-Tag: noindex` on `/api/*` via a `headers` block in `vercel.json`, excluding `og` so the card image stays indexable-if-ever-wanted (`source: /api/((?!og).*)`). | `vercel.json` | trivial |
| M7 | Long-cache hashed assets: `Cache-Control: public, max-age=31536000, immutable` on `/assets/(.*)` only (never on `/` or `index.html`). | `vercel.json` headers | trivial |
| M8 | Link the existing 432-byte `public/favicon.svg` ahead of the PNG fallback. (`/favicon.ico` 404 is harmless; optional tiny `.ico` to silence legacy fetches.) | `index.html:8` | trivial |

Note on M6/M7: both require creating the `headers` block that `vercel.json` currently lacks — do them in one edit. The `/api/*` noindex rule will **not** match `/t/*` requests (Vercel matches request path, not rewrite destination), so `/t/` indexing is controlled separately in `api/t.ts` — good.

Two of these (M3, M4) reference an `og:image`; the actual card PNG is a MAJOR item (X1) because it needs art. Ship the tags now pointing at `/og-card.png`; the file lands with X1.

---

## 3. MAJOR recommendations (owner approval — each has a tradeoff)

**X0 — Deploy the current branch to production. (The one that matters.)**
The live site still serves the old H1 ("Follow one link. Then another."), old meta description, and 404s on every `/t/` share link and the `/api/og` card. The repo already contains the fixed copy, the share route, and the card endpoint — none of it is live. *Tradeoff:* upside is enormous and multi-front (better keyword match, working shares, working unfurls) with zero SEO downside; the only risk is the ordinary "does the rest of the branch deploy cleanly," so it needs a real deploy-and-verify, not just a merge. **This blocks the value of almost everything else — approve first.**

**X1 — Front-load the title tag and ship a social card image.**
Change the title from `Wabbit Hole · a Wikipedia wander` (a made-up, deliberately-misspelled brand nobody searches, spending its first pixels on nothing) to lead with the phrase people type, e.g. `Fall down the Wikipedia rabbit hole · Wabbit Hole`, and create one static 1200×630 `public/og-card.png` reusing the existing card visual. *Tradeoff:* this is the highest-leverage single on-page change and is fully honest (it *is* a Wikipedia rabbit-hole explorer); the only cost is 30 minutes making the card art, and it's a copy decision so you should sign off on the exact wording.

**X2 — Decide `/t/` is share-only: `noindex` the long tail, do not mass-index.**
The `/t/` code currently sends two contradictory signals — a self-referential canonical ("index me") *and* an instant meta-refresh redirect ("go away to the app") — and Google will obey the redirect, so today they'd rank for nothing anyway. The clean resolution is to make the intent explicit: keep the rich OG tags and redirect (that's their real purpose — unfurls), drop the self-canonical, and set `noindex` inside `api/t.ts`. *Tradeoff:* mass-indexing every trail permutation would be thin, duplicate (CC BY-SA Wikipedia text), combinatorial doorway content that helps a hobby site not at all and risks a quality penalty — so we deliberately give up "millions of indexed trail pages" (a mirage) in exchange for clean signals and working share cards (the actual value).

**X3 — Add two crawlable feature blocks (Race, Trivia) to "How it works."**
The Daily Race and the trivia/quiz features are real query magnets ("wikipedia game," "daily wikipedia game," "wikipedia trivia") but the words *race / daily / game / trivia / quiz* appear **zero times** in crawlable markup — those UIs are empty JS-filled containers or hidden behind sign-in. Add two short honest prose blocks to the existing logged-out "How it works" grid. *Tradeoff:* this is the biggest content-coverage gain available and stays truthful to shipped features (keep the LLM-trivia caveat that already lives in About); the only cost is a little grid CSS if a five-across row needs to wrap, and it's user-visible copy so you should approve the wording.

**X4 — (Optional, only if you want organic inroads later) Curate a handful of indexable featured trails.**
Instead of the infinite long tail, hand-pick 5–20 editorially chosen trails, serve *those specific paths* without the instant redirect and without `noindex`, give each a genuine one-sentence human description, and list only those in the sitemap. *Tradeoff:* this is the *only* way `/t/` becomes a legitimate ranking surface without doorway risk, but it's ongoing editorial work for uncertain payoff — reasonable to defer indefinitely and revisit only if you ever care about organic acquisition.

**X5 — (Perf, optional) Re-cut the entry-page logo lockup as SVG/WebP and convert Literata to WOFF2.**
The first-paint LCP element is a 152 KB PNG of what is essentially vector art (`logo/lockup.png`), and the Literata family ships as ~2.3 MB of uncompressed TTF to browsers. Re-export the lockup as SVG (favicon.svg proves the art exists as vector) and `woff2_compress` the *browser-facing* Literata copies. *Tradeoff:* meaningfully faster load / better Core Web Vitals with no visual change, but it's offline asset work and you **must not** touch the two TTFs in `api/_assets/` (satori/`@vercel/og` rejects WOFF2 — the OG card renderer depends on them). Genuinely optional for a hobby project; skip if the deploy + card image is all the time you have.

---

## 4. Explicitly rejected (do not relitigate)

- **Prerendering / SSR / SSG the `#/lang/Title` article views.** Off the table by design and by the no-tracking privacy promise; also duplicate CC BY-SA content that shouldn't rank anyway.
- **Trying to rank article text.** It's verbatim Wikipedia — inherently duplicate; ranking it is impossible and undesirable.
- **Mass-indexing the combinatorial `/t/` space** (auto-generated sitemap of all trails). Thin/doorway content; a net-negative quality signal. (See X2.)
- **`Disallow: /api/` in robots.txt.** Would block social scrapers from `/api/og`; use `X-Robots-Tag` on non-og endpoints instead (M6).
- **A blog / content-marketing program.** Disproportionate for a hobbyist; no honest topical authority to build.
- **Enterprise SEO tooling (Ahrefs/Semrush/etc.).** Google Search Console is the entire toolkit this site needs.
- **Fighting Clerk's 1.5 MB bundle (and its transitive 388 KB Web3 chunk).** Already correctly lazy-loaded; not in initial paint. Leave it.
- **`<noscript>` fallback content — not preemptively.** Google's renderer executes JS and should see the `hidden`-gated H1 post-render; only add a `<noscript>` if Search Console's live URL inspection (S3 below) proves the H1 isn't surfacing.
- **Chasing a 308 vs the current 307 on www→apex.** Signals consolidate either way; not worth it if it's baked into platform behavior.

---

## 5. Owner-only setup steps

1. **Confirm the production deploy (prerequisite for everything).** In Vercel → Project → Settings → Git, verify which branch Production builds, then merge/push the branch carrying the updated `index.html`, `api/t.ts`, `api/og.ts`, and `vercel.json` so it actually goes live. After deploy, verify:
   - `curl -sS -o /dev/null -w "%{http_code}" https://wabbithole.io/t/en/Ada_Lovelace/Analytical_Engine` → expect `200`
   - open `https://wabbithole.io/api/og?lang=en&t=Ada_Lovelace&t=Analytical_Engine` → expect a 1200×630 PNG
   - confirm `curl https://wabbithole.io/` shows the new H1/description.
2. **Google Search Console — add a *Domain* property** for `wabbithole.io` (covers apex + www + http/https in one, which fits the www→apex setup). Verify via the **DNS TXT record** GSC provides (add at your registrar / Vercel DNS).
3. **Submit the sitemap** (Search Console → Sitemaps → `sitemap.xml`) and run **URL Inspection → Test Live URL** on `https://wabbithole.io/` to confirm Google's renderer sees the `hidden`-gated H1 and landing copy post-render. If it does not, *that's* the trigger to add a `<noscript>` entry-copy fallback (and only then).
4. **After the deploy, inspect one `/t/` URL** in GSC — it should report "Page with redirect," empirically confirming the X2 share-only behavior before you rely on it.
5. **Run the live domain through the X / Facebook / Slack unfurl validators** once the card image (X1) ships, to confirm the social card renders.
6. Ignore all paid/enterprise tooling — GSC plus the free URL inspector is the complete kit for this site.

---

## Decisions locked by Gray (2026-07-06, via AskUserQuestion)

- X0 deploy: in motion (deploy #2, whole-batch review READY).
- X1 APPROVED both: title becomes "Fall down the Wikipedia rabbit hole
  · Wabbit Hole"; static og-card.png for the bare-domain share card.
- X2 APPROVED: /t/ is share-only — keep OG cards + redirect, drop
  self-canonical, add noindex in api/t.ts.
- X3 APPROVED: two crawlable "How it works" blocks (Daily Race,
  trivia bank); exact wording shown to Gray at review.
- Extras: FEATURED TRAILS approved (curated 5-20 indexable trail pages
  with human descriptions, listed in sitemap; implementer proposes the
  trail list + descriptions, Gray signs off). Asset re-cut (woff2 /
  SVG logo) DEFERRED.
- Minors M1-M8: approved by standing agreement, implemented with this
  task set.
