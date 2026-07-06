# Wabbit Hole Daily Race — Pair Source: Final Recommendation & Build Spec

**Author:** Synthesis of 2 research reports, 3 designs, 2 judge verdicts
**Date:** 2026-07-06 · **Branch:** trivia-layer · **Status:** ready to implement

---

## 1. Recommendation (for Gray)

Ship **Approach A: a build-time validated pair pool.** Instead of hand-picking pairs, we write a small offline script that pulls a list of well-known articles, and — before any pair is ever shown to a player — actually walks Wikipedia's links to *prove* the two articles are at least a few clicks apart and from unrelated subjects. The script runs on a laptop (or a manual button in GitHub), pays the "is this too easy?" cost once, and commits a vetted file. Players still get their daily pair the exact same way they do today: a plain lookup in a shipped file, with zero server calls, so the game keeps working offline, for signed-out players, and at essentially no ongoing cost. This fixes the reported bug (Solar_System→Saturn and every other one- and two-click pair are mathematically excluded), closes two latent bugs we found along the way, and changes only one function plus one data file. Both an independent product reviewer and an engineering reviewer ranked this first over the two alternatives (a live server-assigned pair, and a clever client-side random draw) — and, tellingly, **both of those alternatives' own authors concluded in their write-ups that this static-validated approach is the stronger answer for a hobby project.** We fold in the single best idea from each losing design: the server design's affordable "prove it's ≥5 cards" check (run offline, not on a server), and the random-draw design's surgical per-day override map (used for today's emergency fix).

---

## 2. The Design, Consolidated

### 2.1 Two planes, meeting only through a committed file

**Authoring plane (offline, never runs in `vercel build`):** a `npm run gen:pairs` script harvests candidate articles, canonicalizes them, gates them for recognizability, samples cross-domain pairs, verifies link-distance against the *live* Wikipedia graph, and emits a validated static calendar. The Wikipedia-API cost is paid here, once per generation, on a laptop or a manual GitHub Action.

**Runtime plane (unchanged in spirit):** `dayKey() → dayIndex() → CALENDAR[index] → pair`. Pure, synchronous, offline, anonymous-safe. No network, no auth, no server call to select a pair — identical machinery to today, just fed a vetted file.

The two planes touch **only** through the committed JSON. This is the property that preserves every invariant: the runtime is byte-for-byte the same O(1) array lookup it is today.

### 2.2 Files

**New (shipped to client):**
- `src/race/pairs.json` — **replaced** with the validated flat calendar (see §2.4 for the critical ordering rule).
- `src/race/overrides.json` — date-keyed `{ "YYYY-MM-DD": {start,target} }`, checked first in `pairForKey`. Used for the interim hotfix and any future owner veto. Tiny.

**New (author-only, never imported by the app):**
- `scripts/gen-pairs/index.ts` — orchestrator (`npm run gen:pairs`).
- `scripts/gen-pairs/harvest.ts` — fetch **Wikipedia:Vital articles/Level 3** (999 titles, ~2 requests, confirmed clean/single-page) and attribute each title to the **section it lives under** (~11 domain buckets: People, History, Geography, Arts, Sciences, Technology…). The bucket label is derived *for free* from Wikipedia's own taxonomy — no per-article category fetch.
- `scripts/gen-pairs/resolve.ts` — batched (50/request) canonical-title resolution via `&redirects`, 404 drop, per-article monthly-pageviews recognizability gate (drop < ~20k views/month; Vital L3 clears this trivially).
- `scripts/gen-pairs/distance.ts` — direct-link check + meet-in-the-middle `outlinks(A) ∩ inlinks(B)` ≤2 rejection, plus the flagged depth-3 (≥4) upgrade.
- `scripts/gen-pairs/wiki.ts` — polite API client: descriptive User-Agent (reuse `APP_AGENT`), `maxlag`, 500-item pagination, 50-title batching, 8–10 bounded-concurrency workers, retry/backoff.
- `scripts/gen-pairs/rng.ts` — **xmur3** seed hash (strong avalanche) + **sfc32** draw, committed seed for reproducibility.
- `scripts/revalidate.ts` — periodic canonical/existence re-check for renames and deletions.
- `src/race/pairs.meta.json` — provenance sidecar (seed, generation date, API-snapshot date, per-pair verified distance + buckets). **Not imported by the app.**

**Changed:**
- `src/race.ts` — `pairForKey` body only (§2.4). Signature `(key: string) => Pair` preserved; everything downstream untouched.
- `package.json` — add `"gen:pairs"` and `"revalidate"` scripts (dev-only `tsx`). **The `build` script is NOT touched** — generation stays out of the deploy path so deploys never depend on Wikipedia being up.

**Explicitly unchanged:** `api/race.ts`, `api/_lib/schema.ts` (server stays a content-agnostic ledger — verified), all snapshot/resume/streak logic, OG/share routes.

### 2.3 Difficulty guarantee mechanism — verified vs. assumed

Card math: start = card 1; each click = +1 card; an optimal player on graph-distance-D spends D clicks → **D+1 cards minimum**. Solar_System→Saturn is distance 1 → 2 cards → the "one click" complaint.

Three properties, three different strengths of guarantee — stated honestly:

**(a) Not-too-close — VERIFIED, exhaustive.** Every shipped pair is proven distance ≥ target at generation time. The cheap check (measured: ~7.1 requests, ~1.27s/pair) rejects any pair with a direct or 2-hop path via `outlinks(A) ∩ inlinks(B) ≠ ∅`. This categorically kills all 3 audited one-click pairs *and* the 3 unaudited two-click pairs research found (Wine→Solar_System, Chocolate→Jupiter, Great_Barrier_Reef→Roman_Empire) *and* the "unrelated-looking but actually 2-click" class (Kayak→Thermodynamics via Electric battery). This is the direct, measured answer to the reported defect.

**(b) The card-count floor — SET BY GRAY (Decision 1).** Distance ≥3 → verified 4-card floor (cheap: ~2 min for the whole pool). Distance ≥4 → verified 5-card floor (the owner's literal "~5 cards"), via the depth-3 forward-frontier check (measured ~112 req/29s per pair). **We fold in the server design's key insight — this expensive proof is entirely affordable when amortized offline** — and run it only on the ~730–850 candidates we actually commit (~40 min one-off at 10 workers). No server needed to afford it.

**(c) Feels-unrelated — PROXY + human review.** Cross-bucket disjointness (Physical sciences vs Everyday life) is a strong, cheap, deterministic proxy, plus a small hand-tuned adjacency deny-list (Biology↔Health) and a frequency cap (no title appears > ~3×). **The final gate is the PR diff itself** — a human skims every shipped pair before merge. This is the review backstop the random-draw design structurally cannot offer (it can't eyeball an infinite schedule) and the server design omits entirely (its cron auto-commits unvetted). This catches "technically ≥3 hops but still feels thematically linked" (Galileo↔Jupiter) that the distance check cannot.

Net: (a) is airtight and exhaustive; (b) is a verified floor Gray chooses; (c) is a good proxy plus mandatory human review.

### 2.4 Determinism & cutover — the flat calendar, with the history-preservation rule

We change `pairForKey` from a wrapping modulo into a **flat, calendar-pinned index with a deterministic fallback**, which designs *out* both determinism hazards research found (reorder-corrupts-history; mid-day cohort split) rather than merely surviving them:

```ts
export function pairForKey(key: string): Pair {
  const o = (overrides as Record<string, Pair>)[key];
  if (o) return o;                                    // surgical veto / interim hotfix
  const i = dayIndex(key);
  if (i >= 0 && i < CALENDAR.length) return CALENDAR[i];         // pinned calendar slot
  return CALENDAR[((xmur3(key) % CALENDAR.length) + CALENDAR.length) % CALENDAR.length]; // safety net
}
```

**CRITICAL history-preservation rule (do not skip — this is the one subtle correctness trap).** Today's scheme is `PAIRS_old[dayIndex mod 120]`. Switching to a flat index `CALENDAR[dayIndex]` *changes the pair for every already-elapsed date* where `dayIndex ≥ 120` (today, day 186, currently maps to slot 66; a naive flat index would map it to slot 186). That would corrupt `syncAccount`'s historical title reconstruction (`race.ts:311`, which calls `pairForKey(date)` for title-less local results). **Therefore the generator MUST materialize the legacy schedule into the historical prefix:** for every slot `i` from 0 up to the cutover index, `CALENDAR[i] = PAIRS_old[i mod 120]` — i.e. reproduce exactly what the old mod-120 scheme returned for that date. Only from the cutover index (today or a chosen near-future date) forward does the calendar carry freshly-validated pairs.

Consequences, all verified against the repo:
- **History is byte-identical.** Past dates resolve to the same pairs they always did → `syncAccount` reconstruction stays correct forever → the reorder-corrupts-history hazard is designed out, not merely bounded by `onConflictDoNothing`.
- **Mid-day cutover is a non-event for the historical/present prefix.** Because we only append future slots (and use the override map for any present-day fix), today's pinned slot is identical before and after a deploy for anyone who hasn't already snapshotted a run.
- **In-progress runs:** untouched. `persistRun` writes literal title strings; `onBoot` rebuilds from them, never re-deriving (`race.ts:391-404, 720-726`).
- **Streaks:** fully immune — pure `won`-boolean date arithmetic (`race.ts:148-160`, `api/race.ts:106-121`).
- **Existing results:** immune — `RaceRecord` stores no titles.
- Use **xmur3** for the fallback hash, not djb2 (research measured djb2 mapping adjacent dates to adjacent indices). The fallback fires only if the horizon lapses; a CI/generator assertion keeps ≥12 months of calendar ahead so it's a genuine last resort (degrade to deterministic repeat, never a crash).

### 2.5 Failure modes

- **Offline / API outage / anonymous:** selection is static JSON with zero runtime Wikipedia dependency. Identical online/offline, signed-in/anon. The entire "anon + offline must keep working" invariant is preserved by construction. No divergence window (the server design's fatal flaw), no cross-engine PRNG gamble as a *load-bearing* runtime dependency (the raw-seeded-draw design's residual risk — we use the PRNG only offline at generation time and only for the far-horizon fallback).
- **Stale-redirect silent-unwinnable day (latent bug found in research):** *fixed.* The generator stores the live **canonical** target title, so every reachable link across Wikipedia matches the `titleEquals` win-check. The current hand-written pool can hit this; Approach A closes it. `revalidate.ts` keeps it closed as pages get renamed.
- **Dead title (404) after generation:** generation guarantees no shipped title 404s at generation time; monthly near-horizon revalidation catches later deletions (rare at Vital tier). Runtime behavior if one slips through is unchanged (error card + retry, one day affected).
- **Server sync:** unchanged, content-agnostic, and historical re-sync correctness is *improved*.

### 2.6 The one real weakness, stated plainly

Build-time verification is a point-in-time snapshot of a graph Wikipedia edits constantly. A pair proven distance-4 today can silently become one-click the moment an editor adds a direct link, and the runtime never re-checks. This is the *exact* class of failure the owner reported, and it can recur between regenerations. **Mitigation (Phase 5): a short — monthly — re-validation pass over the next 30–60 days of the calendar,** which is where drift actually bites, plus a quarterly horizon top-up. This shrinks the window cheaply; it does not close it. The alternative (verifying at serve time) would be drift-proof but sacrifices the offline/anon/zero-infra purity that is this design's entire reason to exist — a worse trade for a hobby daily game.

---

## 3. Interim Fix (ship within the hour, before the generator lands)

Today (2026-07-06) is `dayIndex 186`, `186 mod 120 = 66` → `pairs.json[66]` = **Solar_System→Saturn** (verified by direct computation).

**Use the override map — do NOT reorder or edit the array in place.** An in-place index edit remaps every past date that used that index; a reorder/resize reshuffles the entire schedule and corrupts historical re-sync. The override map is surgical and touches nothing else.

1. Add `src/race/overrides.json` and the two-line guard at the top of `pairForKey` (shown in §2.4).
2. Ship `{ "2026-07-06": { "start": "...", "target": "..." } }` with a **hand-verified far pair** (run the cheap ≤2 check on it first — one candidate, seconds).
3. **In the same PR, cover the other known-bad upcoming dates.** For each bad index — 19 (Statue_of_Liberty→Samurai), 66 (Solar_System→Saturn), 76 (Shark→Iceland), plus the measured two-click indices and the "suspiciously-related" set from the eyeball audit — compute which upcoming dates hit that index (`dayIndex ≡ idx mod 120`) between now and the generator launch, and add a verified override for each. This buys clean days until the full calendar lands.
4. **Cutover caveat for *today*:** a mid-day deploy changes today's pair only for players who reload and haven't already started a run (started runs keep their snapshot). Swapping a *broken* pair for a good one mid-day is the desired behavior; the game is young and this one-time blemish is well worth killing the embarrassment now.

The interim fix is also the first real invocation of the generator's distance-check code — nothing here is throwaway.

---

## 4. Decisions for Gray

Only choices that change what gets built. Each has a recommendation.

**Decision 1 — Difficulty floor: verified 4-card (distance ≥3) or verified 5-card (distance ≥4)?**
→ **Recommend ≥4 (5-card floor).** It's your literal "~5 cards" ask, and folding in the amortized depth-3 proof makes it a ~40-minute one-off per generation batch instead of ~2 minutes — trivial for an offline script. *Tradeoff:* ≥4 costs ~40 min of generation time (vs ~2 min for ≥3) and slightly shrinks the usable pool; ≥3 ships faster but only guarantees "never fewer than 4 cards," leaning on an untested assumption that real wandering makes it feel like 5.

**Decision 2 — Pool size / bundle weight: 365, 730, or 1000+ pairs?**
→ **Recommend 730 (two years of daily uniqueness), shipped inline.** Adds ~16 KB gzip to the current 34 KB entry chunk and keeps the selection synchronous and offline-safe. *Tradeoff:* a larger pool buys more years before any repeat but adds first-paint weight; above ~1000 you'd need to code-split the array (with a tiny inlined "hot window" for instant cold-load), which is more machinery than the repeat cadence justifies. Your problem is pair *quality*, not repeat *cadence*.

**Decision 3 — Where the validated result lives: static file (Approach A) or live server endpoint (Approach B)?**
→ **Recommend static.** Zero recurring infra, zero LLM cost, offline/anon-safe by construction, and no "two players on the same day silently race different pairs" risk. *Tradeoff:* static validation is a point-in-time snapshot needing a cheap periodic re-audit (Phase 5); a server would resist graph-drift continuously but breaks the offline/anonymous fairness that is the product's whole premise, and adds a cron, a table, a monitor, and a divergence window — the wrong amount of machinery for a hobby daily game.

**Decision 4 — Today's pair: fix now via override (accepting a one-time mid-day change for reloaders) or wait for the full calendar?**
→ **Recommend fix now** via the override map (§3). *Tradeoff:* players who already started keep the old pair; players who reload get the corrected one — a one-time, single-day cosmetic split, vastly outweighed by removing the one-click embarrassment today.

---

## 5. Phasing (task-sized chunks for Opus implementers)

**Phase 0 — Interim hotfix (ship today, orthogonal to everything else).**
Add `src/race/overrides.json` + the override guard in `pairForKey`. Populate today + all known-bad upcoming dates with cheap-check-verified pairs. Unit-test that `pairForKey` returns the override when present and is unchanged otherwise. One PR, one file of data + two lines of code.

**Phase 1 — Generator scaffolding + harvest.**
Build `scripts/gen-pairs/wiki.ts` (polite paginating client) and `harvest.ts` (Vital L3 fetch + section→bucket attribution). Build `resolve.ts` (canonicalize, 404-drop, pageview gate). Output a clean, bucketed, canonicalized ~800-title set + `pairs.meta.json` provenance. No selection logic yet. Verify counts against research (999 L3 links, ~2 requests).

**Phase 2 — Sampling + distance verification.**
Build `rng.ts` (xmur3+sfc32, committed seed), the cross-bucket + frequency-cap + adjacency-deny-list sampler, and `distance.ts` (direct-link + meet-in-the-middle ≤2 rejection; flagged depth-3 ≥4 upgrade per Decision 1). Oversample ~15–20% to net the target pool. Assert every survivor's verified distance meets the bar.

**Phase 3 — Flat-calendar emitter + `pairForKey` swap.**
Emitter writes the calendar with the **history-preservation prefix** (§2.4: `CALENDAR[i] = PAIRS_old[i mod 120]` for elapsed slots, validated pairs from the cutover forward). Change `pairForKey` to flat index + xmur3 fallback (keep the override guard). **Regression test the load-bearing invariant:** for every date with `dayIndex 0..185`, new `pairForKey` returns *exactly* the legacy `PAIRS_old[dayIndex mod 120]` output. Add tests for determinism (same date → same pair across runs), offline behavior, and the horizon fallback.

**Phase 4 — Wire-up, verification, ship.**
Add `gen:pairs`/`revalidate` to `package.json` (not `build`). Run the generator, review the full pair diff by hand (the human unrelatedness gate), merge. Verify: `npm run build` succeeds, bundle delta ≈ expected (~16 KB gzip at 730), anon + offline play works, streaks/results/in-progress runs survive the swap. Empty (or retain as veto) `overrides.json`.

**Phase 5 — Maintenance automation.**
`revalidate.ts` as a quarterly (or monthly for the near-horizon 30–60 days) scheduled GitHub Action that re-resolves canonical titles, re-runs the ≤2 (and ≥4) checks on upcoming slots, appends fresh validated slots to keep ≥12 months of horizon, and opens a PR for human merge. Add a generator/CI assertion that fails if the calendar horizon drops below ~6 months (so the fallback is never silently reached).

---

*Interim (Phase 0) is independent of the winner and should ship immediately. Phases 1–4 deliver the permanent fix; Phase 5 addresses the one real weakness (graph drift) at hobby-appropriate cost.*
---

## Decision 1 AMENDED by Gray (2026-07-06, post-Task-17 evidence)

Task 17's implementation proved verified dist>=4 is structurally
incompatible with famous hub starts (all 10 research "unrelated" famous
pairs measured dist 2-3). Gray's call: **MIXED CALENDAR** — one pipeline,
verified >=3 minimum for EVERY pair (no one/two-clickers ever), actual
verified distance recorded in pairs.meta.json provenance; famous-feeling
>=3 pairs form the backbone with quirky >=4 pairs mixed in for variety.
The human review gate (PR diff eyeball) remains the unrelatedness
backstop. Decisions 2-4 unchanged (365 pairs / static / hotfix shipped
as 964c111).
