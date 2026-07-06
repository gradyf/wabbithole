# Daily Wabbit Race + shareable trail cards

Approved by Gray 2026-07-06. Decisions locked via AskUserQuestion: build
queued AFTER the trails/tables/unlimited deploy; daily reset at LOCAL
midnight; rules = links only with EVERY spawned card counting; NO timer
(elapsed time shown quietly on the win screen only); streaks SYNC to the
account when signed in, localStorage keeps the race fully playable
anonymously. Zero LLM cost; the race must never require an account.

## Product shape

- Landing + entry screens show a race card: "Today's race — {Start} →
  {Target}" with a Start button and current streak.
- Starting opens the start article in race mode. A slim race banner
  (compatible with the reading state's condensed chrome) shows the
  target and live card count.
- The player wanders by clicking links only: during a race the app's
  search/random/URL-entry affordances are disabled or exit the race
  with a confirm ("Leaving ends today's run"). Back/Trail jumps to
  EXISTING cards are free; every NEW card spawned counts.
- Win: the active card's canonical title equals the target (normalize
  underscores/case; compare post-hydration canonical titles so
  redirects count as arrival). Win overlay: "{Start} → {Target} in N
  cards", quiet elapsed time, streak, share button.
- One scored attempt per local date; after winning (or abandoning),
  the race card shows the result and the share CTA until midnight.
  Replays after a win are unscored freeplay (banner says so).

## Daily pair selection

- Curated pair list checked into the repo (target ~120 pairs to start;
  interesting, broadly-known endpoints, verified reachable by links,
  varied domains). Format: src/race/pairs.json
  `[{ "start": "Harry_Kane", "target": "Photosynthesis" }, ...]` (en
  only for v1).
- Day key = the player's LOCAL date as YYYY-MM-DD (Wordle-style). Pair
  index = a stable hash of the day key modulo list length (documented,
  so the same date always maps to the same pair; a plain
  days-since-2026-01-01 counter is also acceptable). No cron, no DB.

## Scoring, streaks, sync

- Score = number of cards spawned during the race, start card included
  as card 1. Trail-jump revisits don't add; a re-spawn of a previously
  visited title DOES count (it's a new card).
- localStorage record: `wh-race` JSON { byDate: { "2026-07-06": {
  cards, won, elapsedMs } }, streak computed from consecutive won local
  dates }.
- Account sync (signed-in): `race_results` table — id uuid pk,
  clerk_user_id (indexed), race_date text (the player's local date
  string), start_title, target_title, cards int, elapsed_ms int,
  created_at; UNIQUE (clerk_user_id, race_date). API api/race.ts:
  GET → recent results + computed streak; POST {action:'result',
  raceDate, startTitle, targetTitle, cards, elapsedMs} (upsert-ignore:
  first win of a date sticks). On sign-in, the client best-effort
  uploads local results the server lacks, then trusts the server.
  Signed-out players never hit the API.

## Shareable trail cards (works for ANY trail, not just races)

- Problem: trails live in the URL hash, which crawlers never see. New
  share route `/t/{lang}/{A}/{B}/.../{Z}` (optionally
  `?race=YYYY-MM-DD&cards=N`) served by a Vercel function:
  returns HTML with og:title/og:description/og:image meta + an
  immediate client redirect to `/#/{lang}/A/.../Z`.
- og:image: a second endpoint renders a 1200x630 index-card-styled
  graphic (the DS look: paper cards, carrot rule, trail titles with
  arrows, "N cards"; race variant adds "Daily race · {date}") using
  @vercel/og (satori). Fonts: bundle the woff2 subset already in
  src/ds/assets. Keep both endpoints GET-only, cacheable
  (s-maxage=86400, immutable per URL), input-validated (lang regex,
  ≤12 titles, each ≤300 chars) — they are unauthenticated by design.
- The Share button gains "Copy link" behavior emitting /t/ URLs when
  the trail has ≥1 card (hash URLs remain valid; /t/ is the shareable
  skin). Race win screen's share copies:
  "Daily wabbit race {date}: {Start} → {Target} in {N} cards" + /t/
  URL (plain text, no emoji in v1 copy).
- vercel.json (or vercel.ts) route mapping for /t/* if the filesystem
  api/ convention doesn't already cover it — keep the SPA's zero-config
  behavior for everything else.

## UI notes

- Race banner: sits under the tab (or inside the condensed tab row on
  reading state) — target title + "N cards" chip; must not fight the
  reading-state chrome or mobile widths.
- DS voice: sentence case, no em dashes. The race is playful; copy can
  be warm ("You fell from Harry Kane to Photosynthesis in 5 cards").
- Race mode must not break: trivia extraction (allowed during a race),
  trail auto-save (races are trails too — auto-save proceeds normally),
  deep links (a /t/ visit mid-race does not clobber race state:
  entering the app through any deep link ends/ignores race mode).

## Delegation plan (SDD; queued AFTER the trails deploy; sequential)

1. **Task 8 — share route + OG images** (api/t or api/share fn, og
   image fn, Share button /t/ emission). Independent of race logic;
   verify by fetching /t/... locally and checking meta + image bytes +
   redirect, plus one real-browser pass.
2. **Task 9 — race engine + UI + localStorage streaks** (pairs.json +
   curation, race mode state in a new src/race.ts, banner, win overlay,
   search lockout, landing/entry race cards). Verify by playing a race
   in the browser: win by reaching the target, cards count matches
   spawns, abandon path, next-day rollover by faking Date? (no — Date
   mocking is banned in this stack; verify day-key function with a unit
   in-browser eval instead).
3. **Task 10 — account streak sync** (race_results migration +
   api/race.ts + client sync). Migration applied by the orchestrator at
   deploy.
4. Final whole-feature review, then deploy.

Each task: commit on trivia-layer, no deploys from agents, never commit
.playwright-mcp/, dist/, .superpowers/.
