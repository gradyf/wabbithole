I have the grounding I need. All critique claims verified against the code: `DAILY_CAP=25` with cache hits free (`extract.ts:23`), failed rows excluded from the cap via `ne(extractions.status, 'failed')` (`extract.ts:117`), `max_tokens: 2500` (`extract.ts:159`), `QUESTIONS_PER_ARTICLE=5` in `prompt.ts:9` plus a separate `.slice(0, 5)` in `generateQuestions`, `withUserLock` salt `42` (`db.ts:22`), no `maxDuration`/global ceiling anywhere (`vercel.json` has only a rewrite). Here is the synthesized plan.

---

# Wabbit Hole — Final Implementation Plan: Premium, Settings, Ad-Hoc & Flag Study Mode

Branch: `trivia-layer`. Repo: `/Users/grayforrester/PersonalProjects/WikipediaRabbitHole`. This plan supersedes the three design docs where they conflicted, and resolves all 15 critique items inline (each marked `[Cx]`).

---

## 1. Sixty-second summary for Gray

You want three things: a **$3/mo Premium tier** (25 questions/article instead of 5, highlight-to-generate, a real upgrade/downgrade flow), a **Settings page** with a free **flag/vexillology study mode**, and a guarantee that **every generated question joins the communal cache so nothing is generated twice**. All three are buildable on your existing stack (Clerk + Neon + Haiku) with no new vendor beyond turning on Clerk Billing.

The critique found that the designs were solid on the communal-cache mechanics but had **one dangerous blind spot: nothing protects your wallet against abuse.** Every cap today is per-user, signup is free/frictionless, and moving free extractions from 5→25 questions raises the per-account damage ceiling ~2.8×. Worse, a timed-out generation currently costs a full Haiku call *and* doesn't count against the cap, so it can be retried forever. **The single most important change in this plan is a global daily generation budget + kill switch + a `generation_log` that counts every paid call before it happens (Phase 1) — and it should ship first, before any premium work, because it protects you today.**

The other big fixes: one shared entitlements module (the three designs each invented a different, incompatible one), and reconciling the "rank-slice free to 5" logic with the "flag question is a separate row" logic so flag questions don't accidentally get hidden from free users. Flag study mode is **free** (it maps to zero per-user cost); Premium is reserved for things that actually cost money per user (generation volume).

---

## 2. Decisions that need Gray

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **Billing provider** | **Clerk Billing** (Stripe underneath) | No new SDK/webhook for gating; `@clerk/clerk-js` already a dep. `has({plan})` is read from the session token, networkless. Direct Stripe = 2× the code + a second source of truth. **Caveat `[C11]`:** requires a real activated Stripe account connected to your *prod* Clerk instance (business/bank/tax details, review time) — start this **weeks before launch**. Dev works with test card `4242…` out of the box. |
| D2 | **Price + billing period** | **$3/mo, monthly only** at launch | Matches your ask. Note: Stripe's fixed $0.30/txn is the real drag on a $3 price (~13%), not the LLM. An annual option later reduces fee drag; not needed v1. |
| D3 | **What is Premium vs Free** | See list below | Paywall only tracks real per-user cost. |
| D4 | **Flag/vexillology mode: free or premium?** | **Free** | It's client-side quiz reordering + one communal flag row per article (paid once, shared). Zero per-user cost. Paywalling it is off-brand and it's a great top-of-funnel wedge for flag/geo communities. |
| D5 | **Downgrade/refund policy `[C10]`** | Keep-everything, no proration | On downgrade: user keeps every banked question (including premium-generated ones) and keeps Premium until the paid period ends (Stripe handles period-end). New bank adds revert to the free 10/week cap. If they banked >10 that week, they simply add nothing new until the rolling window clears — fail-safe, must be stated in copy. |
| D6 | **Upgrade page copy + "supporting a hobbyist" line** | Sign off on the copy in §4 (Phase 4) | The warm "you're keeping the lights on" line is the emotional core of the pitch — your call on tone. |
| D7 | **Global daily generation budget number `[C1]`** | Start at **500 fresh generations/day** globally (~$10/day worst case), env-overridable, with a kill switch | Steady-state you're nowhere near this; it's a ceiling against a viral moment or an abuser, not a normal-use limit. Tune once you see real traffic. |
| D8 | **Per-account daily generation cap `[C2]`** | Lower from **25 → 12** fresh generations/user/day, and count *attempts* (incl. failures) | At 25 questions/call, 25/day/account = ~$0.50/day/account of denial-of-wallet. 12 is plenty for genuine use and halves the ceiling. |

### Premium vs Free (D3)

| Capability | Free | Premium ($3/mo) | Owner (you) |
|---|---|---|---|
| MC questions per article | 5 | 25 | 25 |
| Flag / vexillology study mode | ✅ | ✅ | ✅ |
| Settings page | ✅ | ✅ | ✅ |
| Highlight → generate question (ad-hoc) | ❌ | ✅ | ✅ |
| Weekly bank-add cap | 10 | 50 | unlimited |
| Ad-hoc generations/day | — | 10 | unlimited |

### Operator setup checklist (D1, you must do these)

1. Enable Billing in the Clerk dashboard.
2. Create one Plan **"Premium" @ $3/month**; attach a Feature keyed `premium`; mark Plan + Feature **publicly available**. (Free = "no premium plan"; needs no config.)
3. Record the plan slug → `WH_PREMIUM_PLAN` env, and the checkout `planId`.
4. Connect + **activate a real Stripe account** to the **prod** Clerk instance (the long-lead item).
5. No new webhooks needed for v1 (gating reads the token). No new secrets beyond `WH_PREMIUM_PLAN` (the cancel endpoint reuses `CLERK_SECRET_KEY`).

---

## 3. Architecture (the reconciled design)

### 3.1 Entitlements — ONE module `[C5]`

The three designs each invented a different premium helper with incompatible signatures (`resolveEntitlements(userId, has)` vs `requirePremium(userId)`) and contradictory storage (token-only vs webhook+Neon mirror). **Resolved: a single module, token-only, no Neon mirror, no webhook at v1.**

- **Refactor `api/_lib/auth.ts`:** add `authenticate(request) → { userId, has }` (exposes the `has` from `state.toAuth()`, which is already computed and networkless). Keep `requireUser(request) → string` as a thin wrapper so `bank.ts`, `me.ts`, `article-status.ts` are untouched.
- **New `api/_lib/entitlements.ts`:** the *only* entitlement authority. Signature takes `(userId, has)` — every consumer passes both.
  ```
  resolveEntitlements(userId, has) → {
    tier: 'free'|'premium'|'owner',
    questionCeiling,      // free 5 / premium+owner 25
    adHoc,                // false / true
    weeklyAddCap,         // 10 / 50 / null(unlimited)
    adhocDailyCap,        // 0 / 10 / null
  }
  ```
  Layering: `isUnlimited(userId)` (owner email allowlist, already exists) ⊃ `has({plan: WH_PREMIUM_PLAN})` (premium) ⊃ free. Fails closed to free on any error (mirrors `isUnlimited`).
- **No process-lifetime cache** on the premium check (unlike `isUnlimited`'s owner cache) — subscriptions are revocable; `has()` is read fresh per request from the token, so it's always current.
- The highlight design's `requirePremium(userId)`-only helper is **dropped**; it can't read the token claim. The settings design's per-Focus `premium:boolean` hook stays (flags = `false`).
- **`[C14]` spike gate:** Phase 0 confirms clerk-js 6.23 actually exposes `has({plan})` and `billing.startCheckout`. Fail-closed means an unpopulated claim gates a paying user as free — correct security-wise, but a "I paid and it's not working" support path, so Phase 4 always calls `session.reload()` right after checkout, and Settings shows plan status read from `clerk.billing.getSubscription()`.

### 3.2 The `generation_log` table — the wallet guard `[C1][C2][C3][C4]`

This single new table resolves four critique items at once and is the backbone of abuse protection. **One append-only row is written *before* every paid Haiku call, regardless of outcome.**

```
generation_log (
  id          uuid pk default random,
  clerk_user_id text not null,
  kind        text not null,        -- 'extract' | 'adhoc'
  article_id  integer,             -- nullable, for audit
  created_at  timestamptz not null default now()
)
index on (created_at)                  -- global daily count
index on (clerk_user_id, created_at)   -- per-user daily count
```

Why this shape:
- **`[C3][C4]` closes the "failed generations are free retries" hole.** Today `enforceDailyCap` excludes `status='failed'` rows (`extract.ts:117`), so a timeout costs a full call and doesn't count → infinite paid retries. And the ad-hoc design admitted failed generations aren't counted either. Logging *before* the call means a timeout, a `502`, or an empty-result refusal all still consume budget. Cap counts read `generation_log`, not `extractions.status`.
- **`[C1]` gives a global ceiling.** `globalGenerationsToday()` = `count(*) where created_at > now()-24h`. Checked in both `extract` and `ask` before any spend; over `WH_GLOBAL_DAILY_CAP` (D7) → `503 generation_paused` "Wabbit Hole is resting — come back tomorrow."
- **Kill switch:** env `WH_GENERATION_PAUSED=1` short-circuits all generation to the same friendly `503`. Zero-deploy panic button (Vercel env change).
- **`[C2]` per-user cap** = `count where clerk_user_id=? and created_at>now()-24h` vs `entitlements`-derived per-tier daily generation cap (free/premium 12 from D8; owner bypass). Replaces `enforceDailyCap`'s reliance on `extractions`.
- `extractions` table stays exactly as-is — it remains the **concurrency lock** (the pending partial-unique index), not the accounting source.

### 3.3 `article_questions` schema changes (one migration)

Add to the existing table (`schema.ts:31-50`):

| Column | Type | Purpose |
|---|---|---|
| `rank` | `smallint` (nullable) | MC ordering so the free top-5 are the *best* 5 `[C6]`. |
| `origin` | `text not null default 'extract'` | `'extract'` \| `'adhoc'`. Backfills cleanly. |
| `selection_hash` | `text` (nullable) | Ad-hoc exact-dedup key (SHA-256 of normalized selection). |
| `created_by` | `text` (nullable) | Clerk user id of ad-hoc author; NULL for extract rows. |
| `hidden` | `boolean not null default false` | Soft-moderation `[C12]`. |

Indexes: `create unique index aq_adhoc_selection_idx on article_questions(article_id, selection_hash) where origin='adhoc';` and `create index aq_created_by_idx on article_questions(created_by, created_at) where origin='adhoc';`

### 3.4 The reconciled slice/partition logic `[C6][C8]`

The critique's sharpest finding: monetization wanted free = "rank 0–4 rows, everything else `rank=NULL` sorts last" — which would push the **flag question (a separate `type='flag'` row) out of the free slice**, breaking flag mode's acceptance criterion. **Resolved with a single serve-time helper that all readers use:**

```
serveQuestions(rows, tier):
  visible = rows.filter(r => !r.hidden && r.origin === 'extract')
  flags   = visible.filter(r => r.type === 'flag')          // always included, all tiers
  mc      = visible.filter(r => r.type === 'mc')
             .sort(byRankThenCreatedAt)
             .slice(0, tier.questionCeiling)                // free 5 / premium 25
  return [...flags, ...mc]
```

- Flag rows are **tier-independent and never rank-sliced** — one cheap typed row, part of free study mode.
- Ad-hoc rows (`origin='adhoc'`) are **excluded from the extract panel** (Model B) — they live in the communal pool for dedup + banking, but don't pollute the curated panel.
- **`[C8]` sequencing:** exactly one foundational task (Phase 3) lands *all* of `extract.ts`'s contested edits — the shared `FREE_CEILING=5`/`EXTRACTION_CEILING=25` constants replacing both `prompt.ts:9` and the `.slice(0,5)`, the `rank` ordering in `loadQuestions`, the `serveQuestions` helper, and the flag partition. Every downstream feature consumes it; no other task touches those lines.

### 3.5 Settings storage — `user_settings` in Neon

Per house rule ("Clerk owns identity, Postgres owns product state"; `schema.ts:1-3`), **not** Clerk metadata.

```
user_settings (
  clerk_user_id text primary key,
  preferences   jsonb not null default '{}',   -- { "quizFocuses": ["flags"] }
  created_at / updated_at timestamptz
)
```
`api/settings.ts`: `GET → {preferences}`; `PUT {preferences}` validates a whitelist (`quizFocuses` = array of known focus keys), upserts `on conflict do update`. No `withUserLock` (no cap race). Client caches it (`settingsCache` beside `statusCache`, `trivia.ts:765`); quiz weighting reads it synchronously.

### 3.6 Ad-hoc `POST /api/ask` (highlight → question)

- **Pipeline:** `authenticate` → `resolveEntitlements` (gate `adHoc`; free → `402 premium_required`) → validate (normalized `selectedText` length 12–400 chars & ≥3 words) → `fetchArticleSource` → get/create article → normalize+hash → **containment gate `[C9]`** → `loadAdhoc(articleId, hash)` (cache hit → return, zero cost, zero budget) → global + per-user generation-log check → write `generation_log` row → `withKeyLock(articleId+':'+hash)` generate one question → insert `origin='adhoc', selection_hash, created_by, rank=NULL` with `onConflictDoNothing().returning()`, re-select winner on conflict → return `questionId`.
- **Bank add** reuses the existing `POST /api/bank {action:'add'}` unchanged — generation and banking stay separate axes. A capped-out user's highlight still enriches the communal pool (nice property).
- **Containment `[C9]` (honest version):** the 12k `MAX_TEXT_CHARS` cap means a strict substring check silently fails for highlights past the lead. **Resolved:** for the containment check only, fetch the article's **full uncapped plaintext** (action API `explaintext`, separate from the 12k generation text) and require the normalized selection to be a substring (≥90% contiguous token overlap). Costs one extra fetch on ad-hoc miss; makes the feature work on the whole article, not just the lead, while still rejecting attacker-authored injection text that isn't in Wikipedia at all. Infobox/caption highlights remain unsupported v1 (documented limitation; that's the flag-image workstream's territory).
- **`[C13]` lock keyspace:** `withKeyLock` uses a distinct salt from `withUserLock`'s `42` and namespaces the key string (`'adhoc:'+articleId+':'+hash`). Cross-namespace advisory-lock collision is astronomically unlikely and at worst causes one benign extra serialization; accepted.

### 3.7 Flag study mode (free)

Generalized as a **Focus** (registry entry: `key`, `questionType`, `detect`, `promptFragment`, `premium:false`) so later lenses (maps, dates) are additive.

- **Detection (preference-independent — the pool is communal):** client scans the active card's infobox for `a.mw-file-description[title^="Flag of" i]` / `img[resource*="File:Flag_of" i]`, sends a `flag:{imageUrl, sourceUrl}` hint on `POST /api/extract`. Server validates **only on cache-miss**: host must be `upload.wikimedia.org`, filename `/Flag[_ ]of/i`, and a cheap action-API `prop=images` membership check confirms the file is on the page. Never trust a model-authored or unvalidated client URL into the global pool.
- **Generation:** folded into the *same single Haiku call* — `QuestionsSchema` gains optional `imageUrl`; `buildExtractionPrompt` gains an optional `flag` arg appending "include exactly one flag-identification question; set imageUrl to exactly this URL." Post-parse, drop any `imageUrl` that doesn't exactly equal the provided flag URL. Insert as `type='flag', imageUrl, imageSourceUrl`. Wire format already carries these fields (`respond()`, `bank.ts` list).
- **Quiz weighting (client-only, zero cost):** `startQuiz` reads `quizFocuses`, front-loads `type==='flag'` rows: `[...shuffle(prioritized), ...shuffle(rest)].slice(0, QUIZ_SIZE)`. Empty focuses = today's uniform shuffle (no behavior change). Rendering: add `<img>` to `renderQuizQuestion`, extract panel, bank rows (wire format ready; only rendering missing today).
- **P41/Wikidata is fallback-only** (returns historical variants → wrong "which flag" answers). "Skip beats wrong" on ambiguity (former/disputed states, sports crests, person infoboxes).

### 3.8 Upgrade/manage surface — ONE place `[C7]`

The two designs specified both a standalone `#upgrade` overlay and a Settings "Membership" section. **Resolved: the Settings overlay's Membership section is canonical** — it holds upgrade CTA (`clerk.billing.startCheckout`), current status (`getSubscription`), and cancel (→ `api/billing.ts` → `cancelSubscriptionItem(id,{endNow:false})`). `#upgrade` becomes a **deep-link hash** that opens the same Settings overlay scrolled to Membership (so nudges/links are shareable). One implementation, one DOM.

### 3.9 `article-status.ts` honesty `[C15]`

Update its question query to filter `origin='extract' AND hidden=false`, and count only `type='mc'` for any "N questions" label (or return a boolean `hasQuestions`), so the card decoration matches what a tier actually sees once ad-hoc/flag rows exist.

### 3.10 Vercel timeout `[C3]`

`vercel.json` has no `maxDuration`; the 25-question call at higher `max_tokens` risks the default timeout → dead paid call. **Resolved:** set `max_tokens` to ~6000 (not 9000 — 25×~130 tok ≈ 3.3k typical), and set function `maxDuration` to 60s (via `vercel.json` `functions` config or per-function export). The `generation_log`-before-call ordering means even a timeout that slips through still consumes budget, so no infinite retry.

---

## 4. Phased task breakdown (single-agent SDD tasks)

Ordered by dependency. **Phases 0 and 1 ship independently and should ship first.** Flag mode (Phase 5) ships without Premium (Phase 4). Ad-hoc (Phase 6) can ship owner-only before Premium exists.

### Phase 0 — De-risk spikes (no production code) `[C11][C14]`
**Scope:** In a dev Clerk instance with Billing enabled + a subscribed test user: (a) confirm `@clerk/clerk-js@6.23` exposes `billing.startCheckout`, `billing.getSubscription`, and `has({plan})` on the session (check TS exports); (b) confirm `@clerk/backend@3.10` exposes `billing.cancelSubscriptionItem`/`getUserBillingSubscription`; (c) confirm whether `mountUserButton` renders a self-serve Billing tab (may make the custom cancel endpoint optional); (d) confirm Vercel plan allows `maxDuration: 60`.
**Acceptance:** A one-paragraph findings note per item; if any API is missing, the dep-bump or fallback (direct Stripe for that piece) is named. No merge to main.

### Phase 1 — Wallet guardrails (ship first, independent) `[C1][C2][C3][C4]`
**Scope:** New `generation_log` table + migration (generate, don't apply). New `api/_lib/budget.ts`: `logGeneration(userId, kind, articleId)`, `globalGenerationsToday()`, `userGenerationsToday(userId)`, `WH_GLOBAL_DAILY_CAP` (env, default 500), `WH_GENERATION_PAUSED` kill switch. Wire into `extract.ts`: replace `enforceDailyCap`'s `extractions`-based count with a `generation_log` count that includes failures; lower per-user cap 25→12; add global-cap + kill-switch check before the paid call; write the log row *before* `generateQuestions`. Set `vercel.json` `maxDuration: 60` and `max_tokens` headroom.
**Acceptance:** A simulated timeout/`502` still increments the per-user and global counts (unit-level: log row exists before the call). Global cap breach returns `503 generation_paused`. `WH_GENERATION_PAUSED=1` blocks all generation. `npm run build` passes. Ships value even with zero premium work.

### Phase 2 — Entitlements foundation `[C5][C14]`
**Scope:** Refactor `auth.ts` (`authenticate` + unchanged `requireUser`). New `api/_lib/entitlements.ts` (`resolveEntitlements(userId, has)`, owner⊃premium⊃free, fail-closed, no cache). `WH_PREMIUM_PLAN` env. No behavior change yet (nothing consumes it besides a smoke test).
**Acceptance:** Owner email → owner tier; a token with the premium plan claim → premium; anon/error → free. Existing callers of `requireUser` unaffected; `npm run build` passes.

### Phase 3 — Extraction refactor (the shared `extract.ts` change) `[C6][C8][C15]`
**Scope:** Shared `FREE_CEILING=5`/`EXTRACTION_CEILING=25` in `prompt.ts` replacing both `QUESTIONS_PER_ARTICLE` and the `.slice(0,5)`. Add `rank`/`origin`/`selection_hash`/`created_by`/`hidden` columns + indexes (one migration). `loadQuestions` gains `ORDER BY rank NULLS LAST, created_at` and returns all rows (unfiltered) for the serve helper. New `serveQuestions(rows, tier)` (§3.4) used by `respond()`. Prompt asks for `EXTRACTION_CEILING` and to emit questions **most-memorable-first** (so free's top-5 are the best). Wire `resolveEntitlements` into `extract.ts` for the tier. Update `article-status.ts` query for origin/hidden/type honesty.
**Acceptance:** Free extract of a fresh article generates 25, stores all, serves top-5 MC; premium/owner of the same cached article gets 25 — one generation event, no regeneration. A `type='flag'` row (when present) appears for **all** tiers including free. `npm run build` passes. This is the only task touching the contested `extract.ts` slice/`loadQuestions` lines.

### Phase 4 — Premium billing + upgrade/manage UI `[C7][C10][C11][C14]`
**Depends on:** Phase 2, 3. **Scope:** `api/billing.ts` (cancel → `cancelSubscriptionItem(id,{endNow:false})`). Settings overlay Membership section: upgrade CTA (`startCheckout` → `await session.reload()` → re-render), status (`getSubscription`), cancel button, downgrade copy (D5). `#upgrade` deep-link opens Settings→Membership. Upgrade copy (§4 of monetization design; Gray signs off D6). Free-tier nudges: one quiet line at panel bottom ("20 more questions in this article for premium ↗"), intent-triggered ad-hoc nudge, soft weekly-cap line — no badges/interstitials/counters. Wire `weeklyAddCap` from entitlements into `bank.ts add()` and `weeklyRemaining` (free 10 / premium 50 / owner null), cap-check inside the existing `withUserLock`.
**Acceptance:** Test user checks out → `has({plan})` flips after `session.reload()` → extract serves 25, weekly cap 50. Cancel → status shows "Premium until <date>"; after period end, reverts to free 5/10 without punishing already-banked content (D5). `npm run build` passes.

### Phase 5 — Settings page + flag study mode (free; ships without Phase 4) `[C6]`
**Depends on:** Phase 3 (partition helper, flag row plumbing). **Scope:** `user_settings` table + `api/settings.ts` (GET/PUT). `#settings-overlay` + `#btn-settings` gear (signed-in only, mirrors `#btn-bank`), Escape/scrim close. Study section with the Flags/Focus toggle; Account section (read-only email); Membership slot (filled by Phase 4, empty placeholder otherwise). Focus registry + flag `detect`/`promptFragment`. Extract-side: accept+validate client flag hint (host allowlist + `prop=images` membership check on miss), fold flag question into the single Haiku call, insert `type='flag'`. Client: `settingsCache`, `startQuiz` weighting, image rendering in quiz/panel/bank.
**Acceptance:** Flag mode's 7 acceptance criteria hold — notably: fresh flag-bearing article seeds one validated `type='flag'` row into the communal pool; a *different* user's extract hits cache incl. the flag row; free user can toggle flags and bank/quiz them with **no `premium_required` in the flag path**; forged flag hint (bad host / file-not-on-page) is rejected. `npm run build` passes.

### Phase 6 — Ad-hoc highlight → question `[C4][C9][C13]`
**Depends on:** Phase 1 (log), 2 (entitlements/gating), 3 (origin filter). **Scope:** `withKeyLock` in `db.ts`. `buildAdhocPrompt` + optional `validQuestions` content checks (length/URL/markup bounds, refusal sentinel `[C12]`). `api/ask.ts` (§3.6) with full-plaintext containment gate `[C9]`, `generation_log` accounting, `withKeyLock` + on-conflict dedup. Client: `onActiveBody` hook in `stack.ts`; selection listeners scoped to `.wh-prose`; floating "✨ Make a question" pill (desktop + mobile capture-at-pointerdown); `PendingAction` `'ask'` variant (serializable text only); result surface reusing the extract overlay; new error codes (`premium_required`, `adhoc_cap`, `not_in_article`, `no_question`) in `renderExtractError`. Can ship **owner-only** first (gate on `isUnlimited`) before Premium exists.
**Acceptance:** Re-highlighting the same passage (any user) hits `aq_adhoc_selection_idx` → cached row, zero LLM, zero budget. A selection that isn't in the article's full plaintext → `not_in_article`, no spend. Failed/empty generations still consume a `generation_log` slot (no free-retry loop). Free user calling `/api/ask` → `402 premium_required`. `npm run build` passes.

### Phase 7 — Moderation floor (light) `[C12]`
**Depends on:** Phase 3 (`hidden` column). **Scope:** Minimal `api/report.ts` that increments a report count on an `article_questions` row and auto-sets `hidden=true` at a small threshold; `serveQuestions`/`loadQuestions`/quiz already exclude `hidden`. A tiny "report question" affordance in the quiz reveal. Owner can also hide via SQL.
**Acceptance:** A reported-past-threshold question disappears from all future reads without breaking existing `bank_items` FKs. `npm run build` passes.

**Independent-ship map:** Phase 1 (protection) → ship immediately, standalone. Phase 5 (flag mode, free) → ship after Phase 3, no dependency on Premium. Phase 6 → ship owner-only after Phases 1–3, upgrade to premium-gated when Phase 4 lands. Phases 4 and 5 can proceed in parallel once 2 + 3 are merged.

---

## 5. Cost + abuse guardrails table

| Guard | Mechanism | Scope | Resolves | Value |
|---|---|---|---|---|
| **Global daily budget** | `globalGenerationsToday()` vs `WH_GLOBAL_DAILY_CAP` (500/day, env) → `503` | All generation | `[C1]` | Hard ceiling on total daily spend (~$10 worst case) against virality/abuse. The one guard that actually caps Gray's bill. |
| **Kill switch** | `WH_GENERATION_PAUSED` env → `503` | All generation | `[C1]` | Zero-deploy panic button. |
| **Per-user daily gen cap** | `userGenerationsToday()` vs tier cap (12 free/premium; owner bypass) | Per user | `[C2]` | Halves per-account denial-of-wallet vs the old 25 after the 5→25 change. |
| **Count-before-call log** | `generation_log` row written *before* every paid Haiku call | Both endpoints | `[C3][C4]` | Timeouts, 502s, and empty refusals all consume budget — kills the infinite-free-retry hole in both extract and ad-hoc. |
| **Function timeout** | `maxDuration: 60`, `max_tokens ~6000` | extract | `[C3]` | 25-question call completes inside the window; no dead paid calls. |
| **Communal cache** | `article_questions` global pool; cache hit = zero cost/budget | Both | — | Steady-state cost → ~0; each article paid once ever. |
| **Ad-hoc containment** | Selection must be substring of article's full plaintext (uncapped) | ad-hoc, pre-LLM | `[C9]` | Blocks arbitrary attacker text / prompt injection before spend; works on whole article, not just lead. |
| **Ad-hoc exact dedup** | `aq_adhoc_selection_idx` unique + `withKeyLock` | ad-hoc | — | Same passage never generated twice; concurrent highlights → one call. |
| **Flag-hint validation** | host allowlist + `prop=images` membership check, model-URL exact-match | extract flag row | — | No forged/model-authored image URL enters the global pool. |
| **Weekly bank cap** | `weeklyAddsUsed` vs tier cap (10/50/∞) under `withUserLock` | Per user | — | Product cap on bank growth; premium raises, doesn't remove. |
| **Structured output + `textContent`** | Zod-schema'd generation; all render via `.textContent` | Both | — | No stored-XSS; abuse is quality-only. |
| **Moderation floor** | `hidden` column + report→auto-hide + owner SQL | Both | `[C12]` | Removes bad communal rows without breaking `bank_items` FKs. |
| **Fail-closed entitlements** | `has({plan})` read fresh per request; errors → free | Gating | `[C5][C14]` | No stale-premium bug; a broken claim under-grants (safe), never over-grants. |

**Deferred, with reason:** semantic (fuzzy) ad-hoc dedup — no embedding infra in the repo; exact-selection dedup is the honest guarantee, near-duplicate facts accepted. Infobox/caption ad-hoc highlights — unsupported v1 (belongs to the flag-image workstream). Refund proration — none; Stripe period-end handles it (D5). Admin moderation UI — SQL + auto-hide threshold suffice for a solo hobbyist.

---

## Decisions locked by Gray (2026-07-06, via AskUserQuestion)

- **D1 billing: Clerk Billing.** Approved.
- **D5 downgrade: keep-everything, no proration.** Approved.
- **D4 REFRAMED by Gray: flags are NOT a "mode".** It is a settings
  toggle that ALLOWS trivia questions to use flags (image questions
  from flag images). Free. ROADMAP item (not v1): let users filter a
  quiz down to flag questions only — a self-created pseudo flag mode.
  Plan language "flag/vexillology study mode" should be read as this
  toggle + roadmap filter.
- **D3 tier split: no objection raised** to the premium column
  (25 q/article, highlight-to-question, 50/week bank, 10 ad hoc/day).
- **D7/D8 wallet guard: pending** — Gray asked for a clearer
  explanation before deciding.
