# Tables breakout, owner-unlimited caps, trail persistence

Approved by Gray 2026-07-06 (AskUserQuestion picks: auto-save + resume;
trails UI on entry screen + Trail sidebar; table breakout + visible
scrollbar). Implementation delegated to subagents; this spec must be
sufficient without the approving conversation.

## Workstream A: wide tables break out of the reading column

### Problem
Article tables are wrapped in `.wh-tablewrap` (src/content.ts ~94-96;
styles src/ds/css/article.css:257) capped by `.wh-card-inner`'s 960px
column. Many-column tables get crushed (every cell wraps); on macOS the
overflow scrollbar is invisible until scrolled, so wide tables read as
cut off.

### Requirements
- Tables whose natural width ≤ the 960px column render exactly as today.
- Wider tables expand symmetrically past the column, up to the card
  body's inner width (its padding respected), like Wikipedia full-width
  tables. Prose measure is unchanged.
- Beyond that, the wrap scrolls horizontally with an ALWAYS-VISIBLE
  styled scrollbar (match the DS scrollbar idiom used on `.wh-card-body`,
  article.css/components.css) — never an invisible overflow.
- Mobile (<720px): column is already full width; behavior unchanged, no
  horizontal page overflow (spec criterion: body never scrolls
  horizontally).
- CSS lives in src/app.css (never edit src/ds/css/). A
  container-query/negative-margin approach is suggested (e.g.
  `container-type: inline-size` on `.wh-card-body` + cqw-based negative
  margins on `.wh-tablewrap`), but the implementer may choose any robust
  CSS-first mechanism; a tiny JS assist in content.ts is acceptable only
  if CSS alone proves insufficient — justify in the report.
- CAUTION: do not put layout containment on elements BETWEEN a floated
  infobox and following sections (that reintroduces the dead-band bug
  fixed in 24100e3 — see src/content.ts comment). `container-type` on the
  scroll container `.wh-card-body` itself is fine (it is already a BFC).

### Acceptance (real browser, vercel dev :3000, anonymous)
1. `#/en/List_of_football_clubs_by_competitive_honours_won` at 1850px
   viewport: the Men's honours table is wider than 960px, centered,
   inside the card body's padding, columns readable (fewer wrapped
   cells than before).
2. Same article at 1280px: table uses available width; if it overflows
   its wrap, a visible scrollbar shows without hovering.
3. `#/en/Ada_Lovelace` (narrow tables + infobox): unchanged layout, no
   dead band beside the infobox (regression guard for 24100e3).
4. 390x844: no horizontal page overflow anywhere on the three articles.
5. `npm run build` passes.

## Workstream B: unlimited trivia for owner accounts

### Problem
WEEKLY_ADD_CAP=10/week (api/_lib/limits.ts) and the 25/day fresh
extraction guard (api/extract.ts enforceDailyCap) apply to everyone. The
owner wants no limits on their own account. Must survive the dev→prod
Clerk instance switch, so key on EMAIL, not user id.

### Requirements
- New env var `WH_UNLIMITED_EMAILS`: comma-separated, case-insensitive
  emails. (The orchestrator sets the value in Vercel + .env.local — code
  just reads `process.env.WH_UNLIMITED_EMAILS ?? ''`.)
- api/_lib/limits.ts gains `isUnlimited(userId): Promise<boolean>`:
  module-level Map<userId, boolean> cache; on miss, fetch the user via
  the existing Clerk client (see api/_lib/auth.ts) and match any of the
  user's email addresses against the env list. Errors → false (fail
  closed to limited).
- `weeklyRemaining(userId)` returns `null` for unlimited users (type
  becomes `number | null`); weeklyAddsUsed unchanged.
- api/bank.ts add(): unlimited users skip the cap entirely (insert all
  requested, `remaining: null` in responses). The withUserLock
  transaction stays (it also guards duplicate handling).
- api/extract.ts: skip enforceDailyCap for unlimited users; respond()
  returns `weeklyRemaining: null` for them.
- Frontend (src/trivia.ts): treat `remaining === null` as unlimited —
  extract panel pre-checks all questions, never disables rows, the
  "N left this week" foot shows nothing (or "unlimited"), bank foot
  shows just the count. Type updates where BankItem/extract responses
  are declared.
- API response SHAPE stays otherwise identical (anonymous and limited
  users see no change).

### Acceptance
- With WH_UNLIMITED_EMAILS containing the test user's email
  (gray+clerk_test@example.com — set it in .env.local for local dev
  verification), the test user can add >10 questions in a week: verify
  via API calls (mint a session token: POST https://api.clerk.com/v1/sessions
  {user_id} with the dev CLERK_SECRET_KEY from .env.local, then POST
  /v1/sessions/{id}/tokens {"expires_in_seconds":300} → Bearer jwt) —
  bank add returns `remaining: null` and does not 429 at 0 slots.
- With the env var unset for a user, behavior is exactly as before
  (429 at cap). `npm run build` passes.

## Workstream C: trail persistence (auto-resume + saved trails)

### Problem
Trails exist only in the URL hash (`#/{lang}/A/B/C`) and are lost between
sessions. Signed-in users should auto-resume their last trail and keep a
library of saved trails. Anonymous wandering stays untracked (no
persistence for signed-out users — this is a privacy promise in the
About copy).

### Data model (api/_lib/schema.ts + drizzle migration)
`trails` table: `id` uuid pk default random, `clerkUserId` text not null
(indexed), `title` text not null, `nodes` jsonb not null (array of
`{lang, title}` in stack order — same data the hash path encodes),
`isAuto` boolean not null default false, `createdAt`/`updatedAt`
timestamps. Partial unique index: one auto trail per user
(`(clerk_user_id) where is_auto`). Generate the migration with
drizzle-kit (see drizzle.config.ts; pattern: drizzle/0000_*.sql exists).
DO NOT run the migration against the database — the orchestrator applies
it at deploy time.

### API (api/trails.ts, Web-standard fetch handler like api/bank.ts;
requireUser from _lib/auth.js; .js extensions on relative imports — this
repo compiles api/ as native Node ESM)
- GET → `{ trails: [...] }` auto trail first, then named by updatedAt
  desc. Each: id, title, nodes, isAuto, updatedAt.
- POST `{action:'autosave', nodes}` → upsert the user's auto trail
  (title auto-derived: "FirstTitle → LastTitle" with underscores
  replaced by spaces; ≤ 120 chars). Empty nodes deletes the auto trail.
- POST `{action:'save', title?, nodes}` → insert named trail (title
  defaults to the derived one). Cap: 50 named trails (409
  `trail_limit`); nodes length 1..100, each `{lang: validLang, title:
  string ≤ 300}` — validate, else 400.
- POST `{action:'rename', id, title}` / `{action:'delete', id}` —
  ownership in the WHERE clause like api/bank.ts remove().

### Frontend
- src/trivia.ts already owns Clerk + `apiFetch` (Bearer token). Export
  what's needed (e.g. `apiFetch`, an `isSignedIn()` accessor, and an
  auth-change subscription) OR add a small trails module that trivia.ts
  initializes — keep Clerk lazy-loading intact: trails code must not
  force the Clerk bundle for anonymous visitors (follow the existing
  `clerkLoad` guard pattern).
- Auto-save: on stack path changes (main.ts already handles
  onPathChange), debounce ~2s, then POST autosave with the current
  linear path while signed in. No-op signed out. Also autosave the empty
  path when the user goes Home (clears the auto trail).
- Entry screen (index.html + src/app.css + main.ts): a "Your trails"
  section under the search box, visible only signed-in AND non-empty:
  first row "Pick up where you left off — {title} · {n} cards" (the auto
  trail, if any), then named trails (title · n cards · relative time),
  each with open + delete controls; opening applies the trail (reuse the
  same mechanism as deep links / applyTrail in main.ts) and sets the
  landing-skip flag behavior consistently.
- Trail sidebar: a "Save trail" control in its foot while a trail is
  active and the user is signed in (signed out: clicking prompts
  sign-in via the existing pending-action pattern in trivia.ts if cheap
  to reuse; otherwise hide when signed out and note it). Saving names it
  via a small inline input (default = derived title) and toasts
  confirmation.
- Landing hero caption: change "Your trivia bank, saved on every
  device." to "Your trivia bank and trails, saved on every device."
  About panel: update the bank sentence to mention saved trails, keeping
  the promise that anonymous wandering is untracked. DS voice: sentence
  case, no em dashes.

### Acceptance (vercel dev :3000; test user auth via the token-mint
recipe in Workstream B; Playwright MCP)
1. Signed in: open A, click into B and C; within ~3s the auto trail
   upserts (verify via GET). Reload to entry → "Pick up where you left
   off" shows; clicking it restores the 3-card trail (hash + Trail
   sidebar match).
2. Save the current trail with a custom name; it appears on the entry
   screen; delete removes it.
3. Signed out: no trails UI anywhere, no /api/trails requests fired, and
   the Clerk bundle still lazy-loads only when auth UI is invoked.
4. Ownership: a request with user A's token cannot rename/delete user
   B's trail id (404/no-op).
5. `npm run build` passes; no console errors through the flows.

## Delegation plan (sequential; each task commits on trivia-layer; no
deploys from agents; never commit .playwright-mcp/, dist/, .superpowers/)
1. **Task 4 — tables breakout** (Workstream A; src/app.css, possibly a
   tiny content.ts assist).
2. **Task 5 — owner-unlimited caps** (Workstream B; api/_lib/limits.ts,
   api/bank.ts, api/extract.ts, src/trivia.ts).
3. **Task 6 — trails backend** (Workstream C data model + api/trails.ts
   + migration file; verify handlers with curl + minted tokens; no UI).
4. **Task 7 — trails frontend** (Workstream C frontend; consumes Task
   6's API).
5. **Final whole-feature review**, then the orchestrator applies the
   migration and deploys.
