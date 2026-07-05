# Rabbit Hole — Technical Due-Diligence Review

**Review date: 2026-07-03.** All live checks performed this day from a US residential IP, via curl and an in-browser `fetch()` from a foreign origin (`https://example.com`). Labels: **[V-P]** Verified-primary, **[V-E]** Verified-empirical, **[Inf]** Inference, **[Unres]** Unresolved.

---

## 1. Executive summary

**The adopted architecture is sound as of 2026-07-03, with one endpoint correction and one timing hazard.** Fetch Parsoid HTML → sanitize → render in app-owned cards → delegated link interception works today, end-to-end, verified empirically from a real browser on a foreign origin. Nothing forces a backend. No API keys, no accounts, no server.

**Corrections to the Established Findings** (details in §2):

1. **The reference sketch's endpoint is the wrong one to build on.** `en.wikipedia.org/api/rest_v1/page/html/` still works, but only as a compatibility alias served by MediaWiki core (`vary: x-restbase-compat`). The canonical endpoint is the **MediaWiki REST API: `https://{lang}.wikipedia.org/w/rest.php/v1/page/{title}/html`** — same bytes, same Parsoid 2.8.0 profile, and it is the documented reroute target. [V-E][V-P]
2. **Do not touch `api.wikimedia.org/core/v1/...`.** The API Portal wiki shut down June 2026; its endpoints enter "gradual deprecation" July 2026 – June 2027, with replacement URLs to be announced H2 2026. [V-P]
3. **Redirect semantics drifted:** redirect titles now return **HTTP 307** to `/w/rest.php/v1/page/{target}/html?redirect=no` (even on rest_v1, even with `?redirect=false`). Browsers follow it silently; read `response.url`/`response.redirected` for the canonical title. [V-E]
4. **Rate limits were rewritten in 2026:** the old "200 req/s" rest_v1 text is stale boilerplate. Governing policy is now **200 requests/minute per unauthenticated browser user**, plus the Robot policy's ≤5 req/s / concurrency ≤3 for REST. A 15-request burst during this review drew a real 429. [V-P][V-E]
5. **"Strip edit-section links" is moot** — Parsoid HTML contains none (0 occurrences across 4 test articles). [V-E]
6. **License is CC BY-SA 4.0** (June 2023 ToU; dual GFDL for most native text), not 3.0. A hyperlink to the article satisfies author attribution, but you must **also** name/link the license and indicate modifications. [V-P]

**Top 5 risks** (full register §5): (1) H2-2026 Wikimedia API URL restructuring — endpoints may move again within a year; (2) Parsoid markup drift during the Foundation's 2025–26 API overhaul; (3) mega-article DOM/memory on mid-range phones (United States ≈ 19,500 elements, 2.6 MB — ten such cards is untenable without hibernation); (4) per-user rate limiting under fast click-storms; (5) accidental Wikimedia trademark/trade-dress proximity in naming and styling.

**Backend-forcing findings: none.** CORS is `Access-Control-Allow-Origin: *` on the project domains, anonymous access is explicitly budgeted in policy, and attribution is satisfiable client-side.

---

## 2. Priority items report

### P1 — Canonical HTML endpoint

**Decision: `https://{lang}.wikipedia.org/w/rest.php/v1/page/{title}/html` (MediaWiki REST API).**

- All three candidates return **byte-identical Parsoid HTML** (same ETag `W/"1360597789/4b4728a7..."`, same `profile="https://www.mediawiki.org/wiki/Specs/HTML/2.8.0"`, same 60,423 gzipped bytes for Okapi), all served by `server: mw-api-ext...` — MediaWiki core, not RESTBase. [V-E 2026-07-03]
- RESTBase is deprecated policy-wide (mediawiki.org/wiki/RESTBase, mod. 2026-02-05: "RESTBase is currently being deprecated"). The `rest_v1` page-content routes were rerouted to MediaWiki core the week of 2025-01-13 (wikitech-l announcement, H. Coplin, 2025-01-08). Removed rest_v1 routes now 403: `/page/related` (2025-02-06, T376297), `/page/data-parsoid` (2025-06-11, T393557), `/page/mobile-sections*` (2023-07). The rest_v1 docs URL now redirects to Special:RestSandbox. **No sunset date announced for the remaining rest_v1 aliases** [Unres], but building on an alias when the target is public is strictly worse. [V-P]
- `api.wikimedia.org/core/v1/wikipedia/{lang}/page/{title}/html`: functional today (200, Parsoid 2.8.0) [V-E], but wikitech's API_Portal/Deprecation (mod. 2026-06-23) states: portal URLs redirected to mediawiki.org 2026-06-22; "July 2026 through June 2027: New API URLs created; gradual deprecation of api.wikimedia.org endpoints"; and explicitly, Core API users "should wait to migrate to new endpoints until the new endpoints are announced in the second half of 2026." **Do not adopt for new work.** [V-P]
- **Formats: identical across all three** — Parsoid, `rel="mw:WikiLink"`, `./Title` hrefs, sections wrapped in `<section data-mw-section-id>`. [V-E]
- **Redirects:** `GET .../page/Obama/html` → **307** `Location: /w/rest.php/v1/page/Barack_Obama/html?redirect=no` on *both* rest_v1 and rest.php; rest_v1's `?redirect=false` no longer suppresses this (drift from old RESTBase docs). `?redirect=no` on rest.php returns 200 with the redirect page itself (`<link rel="mw:PageProp/redirect" href="./United_States">`). In-browser fetch follows automatically: `response.redirected === true`, `response.url` ends `/page/Barack_Obama/html?redirect=no` → canonical title extraction is one regex. [V-E]
- **404:** JSON, CORS-readable: `{"errorKey":"rest-nonexistent-title","httpCode":404,...}`. [V-E]
- **Fallback:** Action API `action=parse&origin=*` works (ACAO `*`) but returns **legacy-parser HTML**: `/wiki/Title` hrefs, `mw:WikiLink` count = 0 — link classification would need a second code path. Keep as documented fallback only. [V-E]
- Working example: `curl 'https://en.wikipedia.org/w/rest.php/v1/page/Okapi/html'` → 200, Parsoid 2.8.0.
- Sibling endpoints verified: `/page/{title}/bare` (JSON metadata incl. `license` object and `html_url`) and `/page/{title}/with_html` (metadata + HTML in one JSON). [V-E]

### P2 — CORS, empirically

- **en.wikipedia.org (both rest_v1 and rest.php): `access-control-allow-origin: *`.** Preflight OPTIONS → 204 with `access-control-allow-headers` including `Api-User-Agent` (both routes). `api.wikimedia.org` echoes the specific Origin and allows `Api-User-Agent, Authorization, Content-type`. [V-E]
- **Real-browser confirmation from `https://example.com`:** all endpoints fetchable; full 357 KB body readable; custom `Api-User-Agent` header survives preflight; 404 bodies readable. [V-E]
- **ETag is JS-readable only on rest_v1** (`access-control-expose-headers: etag`); rest.php and api.wikimedia.org don't expose it — so client-side conditional revalidation via `If-None-Match` is only ergonomic on rest_v1. Not needed given our own cache layer. [V-E]
- **HTTP caching:** rest.php HTML: `cache-control: max-age=5` (effectively uncacheable — our own cache layer is mandatory); summary: `s-maxage=1209600, max-age=300` (edge-cached 14 days — previews are cheap); search/title: `public, max-age=10800`. [V-E]

### P3 — Rate limits and client etiquette

- **Governing document (new in 2026): mediawiki.org/wiki/Wikimedia_APIs/Rate_limits** (mod. 2026-06-03): limits "apply across all sites and platforms, including requests to the Action API and REST APIs." Tiers per minute: IP-only clients **10**; **"Requests made from a web browser by an unauthenticated user — 200"**; UA-compliant bots 200; established editors 2000. 429/503 responses carry `Retry-After`; wait ≥5 s if absent. This **supersedes** the rest_v1 spec's "200 requests/s" (stale RESTBase boilerplate) and the old api.wikimedia.org 500/h anonymous tier (its Rate_limits page now 301s to mediawiki.org). [V-P]
- **Robot policy** (wikitech, mod. 2026-03-16, incorporated into the ToU §12 by reference): unauthenticated REST — "concurrency of your requests to 3 at a time, and below 5 requests per second"; Action API — concurrency 1. [V-P]
- **Empirical:** a ~15-request burst from one IP produced a 429 on ja.wikipedia.org (cache-miss path); retry succeeded seconds later. The throttle is real and burst-sensitive. [V-E]
- **User-Agent:** Foundation User-Agent policy (mod. 2026-03-27): browser JS sending the browser's UA "is not a violation of policy," but apps "are encouraged to include the `Api-User-Agent` header." It's CORS-permitted on every endpoint tested. **Set `Api-User-Agent: <AppName>/x.y (https://<site>; <email>)` on all fetches.** No key or registration required for project-domain anonymous reads (Access policy, mod. 2026-04-24; API Usage Guidelines, mod. 2026-02-21 — note: as the site's deployer, *you* are the "operator" accountable under those guidelines even though requests come from users' browsers). [V-P]
- **Courtesy layer (spec):** (1) in-memory `Map<title, Promise<Doc>>` — deduplicates in-flight and repeat requests by canonical title; (2) window.`caches` (Cache API — available without a service worker) storing raw HTML responses, keyed by endpoint URL, ~7-day TTL + LRU cap (~50 entries); (3) global concurrency gate of **2** article fetches (policy allows 3; previews share the budget); (4) 429 handler: honor `Retry-After` (min 5 s), exponential backoff, queue clicks rather than drop them; (5) never prefetch more than the hovered/likely-next article. [Inf from V-P constraints]

### P4 — Companion endpoints

- **Summary — ACTIVE, stable.** `GET en.wikipedia.org/api/rest_v1/page/summary/{title}` → 200, `profile=".../Specs/Summary/1.5.0"`, CORS `*`, thumbnail + extract, edge-cached 14 days. Page Content Service docs (mod. 2025-10-02) list `/page/summary` as "stable" post-RESTBase-sunset. Use for previews, card headers, and hibernation snapshots. [V-E][V-P]
- **Search — use MediaWiki REST:** `GET en.wikipedia.org/w/rest.php/v1/search/title?q=okap&limit=5` → 200, CORS `*`, `max-age=10800`. Perfect for the entry screen autocomplete. [V-E]
- **Random — ACTIVE:** `GET en.wikipedia.org/api/rest_v1/page/random/summary` → 303 to a concrete `/page/summary/{title}` (browser follows; you get a summary + title). No deprecation notice found [V-P]. Robust alternative (also verified): Action API `?action=query&list=random&rnnamespace=0&rnlimit=1&format=json&origin=*`. [V-E]

---

## 3. Findings by domain

### Domain A — API layer

- **Endpoint:** `https://{lang}.wikipedia.org/w/rest.php/v1/page/{title}/html` (P1). Isolate all URL construction in one `api.ts` module with the spec profile pinned — the H2-2026 URL restructuring makes this module the designated blast radius. Subscribe to mediawiki-api-announce.
- **Language support: free.** Same route verified on de.wikipedia.org and ja.wikipedia.org (identical profile). CORS `*` everywhere. A `lang` parameter in app state + URL scheme covers it; the only scoped work is UI (RTL: Parsoid emits `dir`/`lang` attrs — set `dir` on the card from the root `<html>` attrs). [V-E]
- **Failure taxonomy → app behavior:**

| Failure | Signal (verified) | App behavior |
|---|---|---|
| Network error | fetch rejects | Placeholder card with retry button; one silent auto-retry with 2 s backoff |
| Nonexistent page | 404 + `errorKey:"rest-nonexistent-title"` | Should be rare (red links are pre-classified inert); on deep-link: error card with search box |
| Rate limited | 429 (+ `Retry-After` per policy) | Global gate pauses; queue the click; subtle "catching up…" indicator; retry after max(Retry-After, 5 s) |
| Redirect | 307 followed silently; `response.redirected`, `response.url` | Extract canonical title; if canonical already in trail → resurface that card instead of spawning |
| 5xx / 503 | JSON or HTML error | Same as network error; honor `Retry-After` if present |

### Domain B — Content processing & sanitization

- **Sanitize: yes — DOMPurify, as defense-in-depth.** Wikimedia sanitizes server-side, but you are injecting third-party HTML into your origin at scale, and the Parsoid spec explicitly warns extension content "may be completely arbitrary HTML." DOMPurify is ~9 KB gz and one call. [V-P + Inf]
- **Pipeline:** fetch text → `DOMPurify.sanitize(html, config)` → parse into a detached template → transform (classify links, strip list, add `loading="lazy"`) → adopt into card. Config: default allow-list **plus** `<style>` retained (see TemplateStyles below), `<section>`, `<figure>`/`<figcaption>`; FORBID `script, iframe, object, embed, form, meta, link, base`; keep attrs `class, id, href, src, srcset, width, height, rel, title, lang, dir, style, typeof, role, colspan, rowspan, alt, aria-*`; **strip `data-mw`, `about`, `data-parsoid`, `data-mw-i18n`** in the transform pass — `data-mw` alone is **14–22% of payload bytes** (measured: toast 15.0%, okapi 15.1%, United States 21.7%, euler 13.8%). `data-parsoid` is already absent from default output (0 occurrences). [V-E]
- **Strip list** (selectors verified live; note the spec has *no* native hatnote/navbox/infobox markers — these are wiki-convention classes [V-P]):
  - `.navbox, .navbox-styles` (US: 267 matches) — remove; irrelevant in card format.
  - `.hatnote` / `[role="note"].hatnote` (US: 54) — remove for MVP (they're meta-navigation; `role="note"` is the most wiki-independent hook).
  - `.side-box, .sistersitebox` (sister-project boxes) — remove.
  - `.shortdescription` (1/article, `display:none` anyway) — **harvest as the card's subtitle**, then remove.
  - `link[rel="mw:PageProp/Category"]`, `<link>`/`<meta>` in body — remove.
  - `#coordinates` — not present in current markup (0 in US) [V-E]; geo appears inside the infobox — no action.
  - Edit-section links: **none exist in Parsoid output** (0 across corpus) — drop from plan. [V-E]
  - `sup.mw-ref` stays (citations); `.mw-references-wrap` stays.
- **Infoboxes: keep, restyled** (`table.infobox`, US has 91 class hits but 1 real infobox; selector `table.infobox` first-of-type). Collapse to `<details>` on narrow viewports. Tables generally: wrap any `table` wider than the card in a `div.table-scroll { overflow-x: auto }` during transform — never let the card body scroll horizontally.
- **Media:** images ship `src` + `srcset` on `//upload.wikimedia.org/...` (protocol-relative; fine over https). Add `loading="lazy" decoding="async"` in transform; `width`/`height` attrs are present → no CLS. Note the spec does **not** guarantee `srcset` (implementation detail) [V-P]. **Math:** Parsoid ships hidden MathML + visible SVG fallback `<img class="mwe-math-fallback-image-* mw-invert skin-invert">` — keep as-is, zero work, dark-mode-ready via the invert classes. [V-E] **Audio/video:** rare (≤2 per test article) — MVP: replace with a link-out chip "Listen on Wikipedia ↗". Maps/graphs (Kartographer/imagemap): strip with a link-out placeholder.
- **References: in-card smooth scroll for MVP.** Citation anchors are **not** bare `#fragment` — they're `./Article_Title#cite_note-N` [V-P spec + V-E]. Intercept, `card.querySelector('[id="cite_note-N"]')`, smooth-scroll, flash-highlight. **Never** use `location.hash` or `getElementById`: every card has duplicate `cite_note-1` ids — all lookups must be scoped to the card root. Popover-on-tap is the v1 upgrade (the reference `<li>` content is right there to clone).

### Domain C — Rendering & CSS strategy

- **Recommendation: (b) custom minimal stylesheet, ~250–350 lines** — body text, headings, `figure/figcaption` thumbs, `table.infobox`, generic tables, `.mw-references-wrap` (2-column on wide cards), blockquotes, `.table-scroll`. This serves the "distinct from Wikipedia" tenet and avoids coupling to skin modules.
- **Critical empirical fact the plan missed: TemplateStyles ride along in the payload.** Parsoid HTML embeds `<style data-mw-deduplicate="TemplateStyles:..." typeof="mw:Extension/templatestyles">` elements (toast 9, okapi 11, US 24, euler 14) covering infobox/hatnote/sidebar internals. **Keep them** (they're server-sanitized scoped CSS and make infoboxes render sanely for free); your stylesheet layers typography and card chrome on top. This is why option (a) — loading `load.php` skin modules — is unnecessary: the template-level CSS already arrives inline; option (a) would add ~30–50 KB of skin CSS, Wikipedia's look, and a second origin dependency. [V-E]
- **Scoping:** prefix your content styles under `.card-body` and rely on TemplateStyles' own class scoping; no Shadow DOM needed for MVP (Shadow DOM would also break your single-stylesheet theming; revisit only if TemplateStyles bleed).
- **Dark mode (if pursued, v1):** Parsoid marks invertible images (`mw-invert`, `skin-invert`) — apply `filter: invert(1) hue-rotate(180deg)` to those classes only; photos untouched; TemplateStyles assume light backgrounds, so dark mode needs a small override sheet for `.infobox` backgrounds. [V-E + Inf]

### Domain D — Link-handling matrix (verified against live Parsoid 2.8.0 output, 4 articles)

| Link type | Detection (verified) | MVP behavior |
|---|---|---|
| Internal article | `a[rel~="mw:WikiLink"]`, href `./Title` | intercept → spawn card |
| Red link | same + `class="new"` / href contains `?action=edit&redlink=1` (+ `typeof~="mw:LocalizedAttrs"`) | inert; styled dashed-underline muted; tooltip "no article yet" |
| Same-page section/citation | href is `./{currentTitle}#frag` or bare `#frag`; citations: `sup.mw-ref` ancestors, ids `cite_ref-*`/`cite_note-*` | scoped in-card smooth scroll + highlight |
| External | `a[rel~="mw:ExtLink"]` (live output: `mw:ExtLink nofollow`, classes `external text/free/autonumber`) | `target="_blank" rel="noopener noreferrer"`, ↗ affordance |
| File/media page | href `./File:*` (figure wrapper links: `a.mw-file-description`); `rel="mw:MediaLink"` for `Media:` | MVP: open `https://{lang}.wikipedia.org/wiki/File:...` in new tab; v1: lightbox from `srcset` |
| Other namespaces (Category/Help/Wikipedia/Talk/Special/Portal/Template/Draft) | decoded href title prefix before `:` against namespace list | open on wikipedia.org in new tab (don't spawn, don't dead-end) |
| Interwiki | `a[rel="mw:WikiLink/Interwiki"]` (17 in corpus) | treat as external |
| Interlanguage | `<link rel="mw:PageProp/Language">` (head/body `link`, not anchors) | strip; no UI in MVP |
| Category props | `<link rel="mw:PageProp/Category">` (89 in corpus) | strip |
| Redirect marker | `<link rel="mw:PageProp/redirect" href="./Target">` (only with `?redirect=no`) | n/a — redirects handled at fetch layer via `response.url` |

- **Duplicate policy: resurface, don't duplicate.** The stack *is* the history; a duplicate card breaks the "trail" metaphor, double-counts memory, and makes Back ambiguous. Resurface with a distinct "snap back" FLIP animation so the user understands they've been here — that moment ("wait, I've circled back!") is a delight feature, not a compromise. Product option: a "spawn anyway" long-press for power users, post-MVP. [Inf — product recommendation]

### Domain E — Stacking mechanics & motion

- **Geometry (desktop):** card ≈ min(720px, 62vw) wide; offset per level **16px right, 12px down**; optional scale falloff `0.995^depth` (subtle; skippable in MVP); max **7** fully-offset cards, older cards compress into a left "deck edge" of 4px slivers with the oldest showing a 24px grab-tab; at depth 20+ the slivers collapse into a counter chip ("+13") opening the trail list. Numbers are a starting spec — tune by feel.
- **Stack vs tree: linear stack for MVP; tree is the v2 flagship.** Keep the door open by **storing a tree from day one**: `nodes: {id, title, lang, parentId, children[], createdAt}` + `activePath: id[]`. Render = walk `activePath`. MVP "truncate forward history" is then just: spawning from a mid-stack card appends a child and switches `activePath` — the old branch objects persist invisibly, so v2's minimap needs zero migration. This costs ~20 lines now.
- **Animation:** `transform`/`opacity` only (compositor-only, no layout/paint) — spawn = translate from click origin + fade; resurface = FLIP (measure first/last rects, invert, play). `will-change: transform` applied only for the animation's duration then removed (permanent `will-change` on N cards defeats itself by pinning layers). `prefers-reduced-motion: reduce` → no movement: instant position, 120 ms opacity crossfade only.
- **Scroll:** each card is its own scroll container (`overflow-y: auto; overscroll-behavior: contain`) so rubber-banding never chains to the stack or the page. Lower cards do **nothing** while an upper card scrolls — scroll-linked parallax on partially-visible transformed layers is jank bait on mid-range phones and violates reduced-motion expectations. Skip it permanently, not just for MVP.
- **Z-index plan:** all cards are **siblings** of one `.stack` container, DOM order = stack order; each transformed card creates its own stacking context, so sibling paint order alone stacks them correctly — no z-index values at all, no collapse risk. Never nest a card inside another card's subtree; never use `position: fixed` inside a card (broken containing block under transformed ancestors, notably iOS).

### Domain F — State, URLs, history, persistence

- **Shareable URLs — recommend (a) plain hash trail for MVP:** `#/en/Okapi/Giraffe/Congo_River` (titles percent-encoded; `/` in titles → `%2F`). Human-readable, zero deps, copy-paste shareable. Practical URL budget ≈ 2,000 chars ⇒ ~60–80 average titles — beyond any plausible session; if exceeded, keep the most recent 40 in the hash and the full trail in localStorage. lz-string (option b) is a v2 optimization only if tree-shaped shares arrive; option (c) alone isn't shareable. Note: the hash encodes the **active path**, not the whole tree — acceptable for MVP sharing semantics.
- **History API:** `history.pushState({index}, '', newHash)` per spawned card **and** per resurface; `popstate` → animate resurface to `state.index` (never leaves the site until the stack is exhausted). Edge cases: **refresh mid-stack** → parse hash, rebuild trail as hibernated stubs (title-only cards via cached summaries), hydrate only the top card (1 article fetch); **deep-link entry** → same path, and lazily fetch lower cards only on resurface; **back past card 1** → browser leaves normally (correct behavior).
- **Persistence:** localStorage `rh.session.v1` = `{v:1, lang, tree, activePath, savedAt}`; on load, if `savedAt` < 7 days and no deep-link hash → toast "Continue your rabbit hole? (12 cards)". Version key in the name; unknown `v` → discard silently.
- **Trail export: confirmed low-cost/high-delight.** JSON (the tree verbatim) + Markdown: `- [Okapi](https://en.wikipedia.org/wiki/Okapi)` nested list mirroring the tree — pastes perfectly into Obsidian. ~40 lines of code. Ship in v1.

### Domain G — Performance & memory (measured 2026-07-03, en.wikipedia, rest.php HTML)

| Article | Uncompressed | Wire (gzip) | Elements | data-mw share |
|---|---|---|---|---|
| Toast sandwich (small) | 96 KB | ~18 KB | 964 | 15.0% |
| Okapi (median) | 358 KB | 60 KB | 4,040 | 15.1% |
| Euler's identity (math) | 156 KB | ~30 KB | 1,572 | 13.8% |
| United States (mega) | 2.59 MB | 416 KB | 19,452 | 21.7% |

In-browser fetch+read: Okapi ~1.2 s cold, summary 39 ms, search 70 ms, United States ~4.1 s (incl. redirect hop). [V-E]

- **The problem, quantified:** ten mega-cards ≈ 200k live elements — will kill a mid-range Android (and desktop Safari won't enjoy it either). Mitigation is not optional.
- **Recommended combination (all four):** (1) strip `data-mw` etc. (−15–22% bytes before parse); (2) `content-visibility: auto; contain-intrinsic-size: auto 600px` on every `<section>` (Parsoid's section wrappers are perfect boundaries — the browser skips layout/paint of off-screen sections) + `contain: layout paint` on cards; (3) `loading="lazy"` images (transform pass); (4) **card hibernation**: only the top **N live** cards keep article DOM (N=5 desktop / 3 mobile); deeper cards swap to a snapshot stub (title + thumbnail + extract from the already-cached summary endpoint + scroll offset); resurface rehydrates from the Cache API (no network, ~50–150 ms re-parse for a median article). Section-level lazy *rendering* beyond `content-visibility` is not needed for MVP.
- **Budgets:** initial load ≤ 60 KB gz JS+CSS total (app is ~30 KB of logic + DOMPurify 9 KB — no framework needed to hit this); spawn interaction: input→animation start < 100 ms, content painted < 300 ms warm-cache / < 1.5 s cold on 4G for a median article; resurface (FLIP) < 150 ms; heap ceiling ≈ 250 MB on a 4 GB Android phone (hibernation keeps live DOM ≈ 3 cards ≈ worst case ~60k elements ≈ well under); long-task budget: HTML parse of a mega article (~100–200 ms) must run through `requestIdleCallback`-chunked injection or accept one long task at spawn (MVP: accept it, measure, revisit).

### Domain H — Licensing, trademark, etiquette

- **License: CC BY-SA 4.0 + GFDL dual** (ToU eff. 2023-06-07 §7; "Reusers may comply with either license or both"; some imported text is CC-only). The REST API even returns it per-page (`/bare` → `license: {url: ...by-sa/4.0..., title}`). [V-P][V-E]
- **Attribution spec (per ToU §7 + CC 4.0 §3(a)):** per-card footer: **"From Wikipedia — [Article title] · CC BY-SA 4.0"** where the title links to `https://{lang}.wikipedia.org/wiki/{title}` (satisfies author attribution via history page) and "CC BY-SA 4.0" links to the license deed. Site-level About: license statement, **modification notice** ("articles are reformatted; navigation elements omitted" — required because stripping/restyling must be indicated "in a reasonable manner"), GFDL mention. **ShareAlike does not infect the site**: reformatting is a §2(a)(4) technical modification ("never produces Adapted Material"), and your own code/design is separate work under any license you like; SA binds only adapted *content* if you ever remix article text (you don't). [V-P]
- **Images:** article HTML inlines some **non-free** files (en.wp local fair-use) whose rationale doesn't transfer to you; industry-standard mirror practice is to display-as-served with attribution pass-through. Risk: low; mitigation: link every figure to its File page (already the default markup), add per-image credits (Action API `imageinfo&iiprop=extmetadata`, verified live) as a v2 feature. [V-P]
- **Trademark:** protected — "Wikipedia", "Wikimedia", project names, puzzle globe, W icon, and site trade dress ("Please do not create a website that mimics the 'look and feel' of a Wikimedia site" §5.1 — your "deliberately distinct" tenet is also a compliance requirement). Nominative use is fine: you **may** say "content from Wikipedia" in text (§3.6). Don't register look-alike/sound-alike domains (§4.2). "-pedia" suffix and bare "wiki" are not explicitly claimed [Unres at the margin] — avoid anyway; **"Rabbit Hole" has zero Wikimedia trademark exposure.** No affiliation disclaimer is *required* if you use no marks; adding "Not affiliated with the Wikimedia Foundation" to About is prudent and costless. [V-P]
- **Etiquette compliance summary:** ToU §12 binds you (as operator) to the User-Agent policy, Robot policy, API:Etiquette. Concretely: `Api-User-Agent` on every request, concurrency ≤ 2–3, no request spraying, honor 429/Retry-After, cache aggressively. All already in the P3 courtesy layer.

### Domain I — Accessibility

- **Focus:** on spawn, `focus()` the new card's `<h1>` (`tabindex="-1"`); on resurface, restore focus to the link that spawned the now-resurfaced card's successor or the card heading. **Esc = pop/resurface previous.** Keyboard map: `Alt+←/→` (or `[`/`]`) walk the stack; `Enter`/`Space` on a deck sliver resurfaces; `/` focuses search. Roving tabindex across deck slivers.
- **Screen-reader model:** exactly one card is "the page": all non-top cards get `inert` (which implies aria-hidden and unfocusability; supported in all evergreen browsers) — the deck slivers live *outside* the inert subtrees as a `<nav aria-label="Trail">` list. Announce transitions via a polite `aria-live` region: "Opened Giraffe — card 4 of 4" / "Returned to Okapi — card 2 of 4".
- **Reduced motion:** per Domain E — crossfade only.
- **Contrast:** dimming lower cards is decorative (they're inert), but their *sliver tabs* are interactive: ≥ 3:1 non-text contrast against the backdrop, and the top card's text stays AA (4.5:1) — don't dim the top card, ever.

### Domain J — Mobile & touch

- **Down-right fanning does not survive 390 px** — 7 × 16 px of x-offset eats 30% of the viewport. **Mobile variant: vertical spine.** Top card is full-bleed minus a 44 px top strip showing the previous card's title bar (one tab); deeper history collapses into that strip as a breadcrumb ("‹ Okapi · 3 more"). Tap strip = resurface; tap "3 more" = trail sheet (bottom sheet listing the stack). This keeps the "cards behind cards" feel without x-offsets.
- **Gestures:** no horizontal swipe-to-pop — it collides with iOS/Android edge-back and with horizontally scrollable tables inside cards. Back = browser back (already wired via History API), the top strip, or Esc on keyboard. Vertical in-card scrolling stays untouched. A long-press on a link for "peek" (summary popover) is the only added gesture, v1.
- **iOS Safari specifics:** use `100dvh`/`svh` (not `100vh`) for the stack viewport; no `position: fixed` inside transformed cards (containing-block break); `overscroll-behavior: contain` on card scrollers prevents pull-to-refresh hijack; test `-webkit-tap-highlight-color` on the delegated links; Safari still limits concurrent layers — another reason hibernation caps live cards at 3 on mobile.

### Domain K — Stack & deployment

- **Recommendation: vanilla TypeScript + Vite. No framework.** The app's essential operations — injecting large foreign DOM blobs, delegated interception, FLIP transforms — are exactly the things frameworks don't own well: React's `dangerouslySetInnerHTML` works but you'd fight reconciliation to keep 300 KB subtrees out of the vdom and get zero value from it (card content is static once injected); the app chrome is ~5 components' worth of UI. State is one small tree + an active path — a 100-line store. Preact or Svelte are acceptable if the owner wants component ergonomics for chrome; if so, **Svelte** (compiles away, no vdom claiming the injected DOM). React is the worst fit here. Dependencies: DOMPurify only.
- **Build/deploy:** static output → GitHub Pages, Netlify, or Vercel (owner already has a Vercel setup); no secrets, no functions. Add `Api-User-Agent` app version from the build.
- **Service worker:** skip in MVP — the Cache API layer already works from the window context. Add a SW in v1 only for offline resume (precache shell + serve cached articles offline); cost ~1 day, benefit moderate. Assessment: v1, not v0/MVP.

### Domain L — Stretch features (feasibility/cost only)

- **Tree/minimap:** data model already a tree (Domain E) → rendering a minimap is pure UI (SVG/canvas, ~2–4 days). Feasible; the flagship v2.
- **Hover/tap previews:** trivial — summary endpoint is 39 ms warm and edge-cached 14 days; debounced hover fetch + popover, ~1 day. Strong candidate to pull *into* v1.
- **Random entry / surprise link:** random endpoint verified; "surprise link" = pick a random `mw:WikiLink` in the top card and spawn it — hours, not days.
- **Trail stats + share images:** stats trivial from the tree; share *images* need canvas rendering of the trail (~2–3 days) — nice-to-have, keep last.

---

## 4. Decision log

| Decision | Options considered | Choice | Rationale | Confidence |
|---|---|---|---|---|
| HTML endpoint | rest_v1 · **rest.php v1** · api.wikimedia.org · Action API | `/w/rest.php/v1/page/{t}/html` | Canonical reroute target; identical Parsoid bytes; api.wikimedia.org deprecating now; Action API = different HTML | High |
| Sanitization | none · **DOMPurify** · server proxy | DOMPurify, style-preserving config | Defense-in-depth at 9 KB; spec warns extension HTML arbitrary | High |
| CSS strategy | load.php modules · **custom sheet + keep TemplateStyles** | custom ~300 lines; keep inline TemplateStyles | TemplateStyles arrive free in payload; distinct-look tenet; no skin coupling | High |
| Framework | React · Preact · Svelte · **vanilla TS** | Vanilla TS + Vite (+DOMPurify) | Foreign-DOM injection is the core op; nothing for a vdom to own; 60 KB budget | Medium-high |
| Stack model | linear · tree | **Store tree, render linear path** | v2 minimap needs no migration; ~20 extra lines now | High |
| Duplicate link | spawn dup · **resurface** | Resurface with FLIP "snap back" | Trail metaphor integrity; memory; Back-button sanity | Medium (product) |
| URL scheme | full hash trail · lz-string · localStorage-only | **`#/lang/A/B/C` hash trail** | Readable, shareable, zero deps; 60+ titles fit | High |
| References UX | scroll · popover | **In-card scoped scroll (MVP)**, popover v1 | Zero extra UI; duplicate-id trap handled by scoping | High |
| Infobox | strip · collapse · **keep restyled** | Keep; `<details>` collapse on mobile | Info density is part of the fun; TemplateStyles make it cheap | Medium |
| Hibernation | none · aggressive · **cap N live + summary stubs** | N=5 desktop / 3 mobile | 19.5k-element mega articles measured; rehydrate from Cache API | High |
| Random entry | rest_v1 random · Action API | rest_v1 `/page/random/summary` (Action API fallback) | Verified working; single hop to summary | Medium |
| Deployment | GH Pages · Netlify · Vercel | Any static host (Vercel given owner's existing account) | No backend needed — confirmed | High |

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation | Revisit trigger |
|---|---|---|---|---|
| H2-2026 API URL restructuring (new canonical URLs; api.wikimedia.org sunset wave may eventually touch rest_v1 aliases) | Medium-high | Medium | Single `api.ts` endpoint module; subscribe mediawiki-api-announce; pin + assert profile header | Announcement on mediawiki-api-announce / changelog |
| Parsoid HTML spec drift (2.8.0 → next) during 2025–26 API overhaul | Medium | Medium | Tolerant selectors (rel/typeof over classes where possible); CI canary: fetch Okapi weekly, assert invariants (mw:WikiLink present, profile version) | Profile header changes |
| 429s under click-storms / shared-IP users (NAT, campus) | Medium | Low-med | Concurrency 2, dedupe, Cache API, Retry-After honor, queue-don't-drop | 429s observed in telemetry-free testing |
| Mega-article memory on mid-range phones | High (if unmitigated) | Medium | Hibernation cap, content-visibility, data-mw strip, lazy images | Jank/OOM in device testing |
| Non-free images displayed off-wiki | Low | Low-med | Figure→File-page links preserved; per-image credits v2; respond to takedowns | Complaint received |
| Trademark/trade-dress proximity | Low (name "Rabbit Hole" clean) | High if violated | No marks/globe; distinct visual identity; nominative "content from Wikipedia" only; About disclaimer | Any rename/rebrand |
| TemplateStyles bleed into app chrome | Low-med | Low | Card-scoped container class; audit; fallback = strip style tags and restyle infobox manually | Visual regressions |
| iOS Safari layer/gesture quirks | Medium | Low | dvh units, no fixed-in-transform, no horizontal gestures, early device pass | First mobile test round |

## 6. Endpoint cheat sheet (all verified 2026-07-03)

| Purpose | Request | Notes |
|---|---|---|
| Article HTML (primary) | `GET https://{lang}.wikipedia.org/w/rest.php/v1/page/{title}/html` | Parsoid 2.8.0; ACAO `*`; 307 on redirects (follow; read `response.url`); `?redirect=no` to inspect redirect pages; 404 JSON `errorKey: rest-nonexistent-title`; `cache-control: max-age=5` ⇒ cache it yourself |
| Article HTML + metadata | `GET .../w/rest.php/v1/page/{title}/with_html` | JSON incl. `license`, `latest.id/timestamp`, `html` |
| Page metadata only | `GET .../w/rest.php/v1/page/{title}/bare` | `license` + `html_url`; cheap existence probe |
| Summary/preview | `GET https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}` | Stable (PCS); thumbnail+extract; `s-maxage` 14 d; ETag exposed |
| Title autocomplete | `GET .../w/rest.php/v1/search/title?q={q}&limit=5` | ACAO `*`; `max-age=10800` |
| Random article | `GET .../api/rest_v1/page/random/summary` | 303 → summary; fallback: `GET /w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json&origin=*` |
| Legacy-HTML fallback | `GET /w/api.php?action=parse&page={t}&prop=text&formatversion=2&format=json&origin=*` | Different HTML (`/wiki/` hrefs, no `mw:WikiLink`) — separate classifier required |
| Image licenses (v2) | `GET /w/api.php?action=query&prop=imageinfo&iiprop=extmetadata&titles=File:{f}&format=json&origin=*` | `LicenseShortName`, `Artist`, `AttributionRequired`; "expensive" — cache hard |

Headers on every call: `Api-User-Agent: <AppName>/x.y (https://<site>; <email>)`. Limits: ≤200 req/min per user, concurrency ≤3, honor `Retry-After`.

## 7. Phased implementation plan

**Phase 0 — spike (~1 evening):** Vite + TS scaffold; fetch Okapi from rest.php endpoint; DOMPurify → transform (strip list, lazy imgs) → inject into a card with the ~100 first lines of content CSS; one delegated listener; click a `mw:WikiLink` → second card offset down-right. *Exit criteria:* two stacked cards from a deployed static host (validates CORS + Api-User-Agent in production), redirect click resolves canonical title via `response.url`.

**MVP:** tree data model + linear stack render; full link matrix (incl. red links inert, externals new-tab, namespace routing, scoped citation scroll); strip list + TemplateStyles retention + infobox restyle; card geometry + FLIP resurface + reduced-motion; hash trail URLs + pushState/popstate; entry screen (search/title autocomplete + random); failure taxonomy UI; courtesy layer (Map dedupe, Cache API, concurrency 2, 429 backoff); per-card attribution footer + About page; mobile vertical-spine variant; deploy.

**v1:** localStorage resume; hibernation + content-visibility + perf pass against budgets (device-test on a mid-range Android); accessibility pass (inert, live region, keyboard map, focus discipline); trail export (JSON + Markdown); footnote popovers; image lightbox; dark mode; service worker for offline resume; hover previews (cheap — consider pulling into v1 scope).

**Stretch:** tree minimap; surprise-link mode; trail stats + share images; per-image credits.

## 8. Open product decisions (owner's call)

1. **Final name/branding** — constraint set (Domain H): no marks, no globe, no look-alike; "Rabbit Hole" itself is Wikimedia-clean (generic-trademark clearance is a separate, non-Wikimedia question). *Recommendation: keep "Rabbit Hole" working title, run a general TM search before launch.*
2. **Duplicate-link behavior** — resurface (recommended) vs. always-spawn vs. long-press override.
3. **File-link behavior in MVP** — new-tab to wikipedia.org (recommended for MVP) vs. building the lightbox immediately.
4. **Footnotes** — scoped scroll MVP (recommended) → popover v1, or popover from day one (+2–3 days).
5. **Infobox default on mobile** — collapsed `<details>` (recommended) vs. always expanded.
6. **Dark mode timing** — v1 (recommended) vs. MVP.
7. **Hover previews** — pull into v1 (cheap, recommended) vs. stretch.
8. **Parallax on lower cards** — recommendation: never (perf + motion); overrule only with device data.
