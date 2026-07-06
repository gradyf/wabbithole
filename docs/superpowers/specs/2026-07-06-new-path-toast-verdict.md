# Decision record: new-path toast (debate verdict)

I have everything I need to rule on this. The debate is thorough and all three agents converged on the load-bearing facts; no further tool use is needed.

# Ruling: BUILD-LATER (narrow variant now, global version gated on scale)

**On the feature as Gray described it — a global "new path" toast firing on anonymous wandering: REJECT.** But there's a real, cheap, honest version worth shipping, so the full verdict is: **build the race-route variant when the trivia/premium queue clears; shelve the global-wander toast until traffic density exists (if ever).**

---

## The 60-second version for Gray

**The ruling.** The idea you described — a toast on ordinary wandering that says "nobody has ever walked this path" — should not be built. Not because it's hard (it isn't; the pieces all exist), but because it's upside-down at every scale you can afford. However, there's a genuinely good version hiding inside it, so this is a "not this shape, and not yet" rather than a flat no.

**The two strongest points *against* (Skeptic + Pragmatist agree here):**
1. **The base-rate inversion is fatal.** "New path" only feels special if *most* paths aren't new. With your current traffic and a combinatorially unbounded path space, virtually every 2+ card wander is globally novel — so an honest toast fires on ~100% of clicks and becomes wallpaper within three links. You'd spend your entire novelty budget teaching users to ignore it. Any fix for the noise (throttling, "only long paths") is a *fabricated* rarity meter dressed as a fact — dishonest in a way Wordle's real, shared-daily scarcity never is.
2. **It breaks your one code-verified privacy promise and your just-approved design direction.** `index.html:252` says wandering is "not tracked," and that's *currently true* — anonymous wandering fires zero API calls. To know a path is globally novel, you must record every route everyone walks to a shared server table. That is tracking wandering, whatever name is on the row. It also introduces the app's first per-navigation server round-trip (unbounded, non-converging cost, a brand-new global-lock discipline you've never needed) — and pops the app's first *ambient* toast at the exact moment you just approved "condensing chrome to maximize reading space." Single-slot, last-wins toasts mean it would also clobber the "Trail link copied" confirmations users actually rely on.

**The two strongest points *for* (Advocate's real ground, conceded by all):**
1. **The ingredients are all here and it's cheap to build.** Canonicalization (`normTitle` + `canonicalTitleFromUrl`) gives reliable per-title identity; `onSpawn` already fires *only* on genuine new-card appends (not revisits/reconciles), a clean "an edge was actually walked just now" signal; toast plumbing is threaded. Buildability is not the obstacle.
2. **The underlying itch is legitimate.** "Make wandering feel rewarding / a little magical" is a good instinct worth serving — just not through a global claim the user can't verify and will stop believing after the third firing.

**Where I come down:** the Skeptic is right that the *described* feature is a reject. The Pragmatist found the one place the exact thrill you're chasing is both honest and cheap — and that's the version to build.

---

## The concrete shape to build (when the queue clears)

**Variant: race-route novelty, surfaced in the win overlay — not a toast.**

The Daily Race is the only context that fixes the base-rate problem structurally: every racer runs the **same start→target on the same day**, so the route space is *bounded*, novelty is genuinely rare, and "you found a route nobody else took today" actually means something. And signed-in racers **already POST to `/api/race` on completion** — so this rides an existing, consented, signed-in call and adds **zero** new hot-path round-trips.

- **Path definition:** ordered `{lang,title}` sequence for the run, normalized via `normTitle`, hashed into a `route_hash`. Fingerprint computed **once per race submit**, never per navigation.
- **Storage:** new table `race_routes { race_date, pair_key, route_hash, first_seen_at }`, unique index on `(race_date, pair_key, route_hash)`, `onConflictDoNothing` insert (the existing `extract.ts`/`schema.ts` pattern). Bounded by racers-per-day, so it *converges* — unlike the global edge table the Skeptic rightly warns against.
- **Surface:** extend the existing `/api/race` response, render in the **win overlay** (already shows stats + a note line). Rare, deliberate, celebratory — no ambient toast, no slot contention with the chrome you just worked to quiet.
- **Copy:** "First to find this route today" / "1 of 4 routes found today." Include the count so the claim is *self-verifying* — it answers the Skeptic's "says who?" by showing the denominator.
- **Privacy stance:** untouched. Signed-in racers already sync and consent; the "not tracked" promise is about *anonymous wandering*, which stays localStorage-only and simply doesn't participate. No copy changes required.
- **Required guard:** only celebrate when `distinctRoutesToday ≥ N` (i.e., when being first is actually notable). With few daily racers, everyone's route is novel again and you're back to base-rate noise. Without this guard, don't ship it.

**Timing relative to roadmap:** race just shipped, so the plumbing is warm — but trivia portal + TOC peek + premium batch are queued and are higher-value. Slot this **after** that batch. It's a flavor enhancement to an existing surface, not a headliner.

**What would flip the global-wander version from BUILD-LATER to BUILD:** traffic density high enough over a maturing corpus that novelty becomes *rare* (most wanders are *not* new) — at which point you'd still owe (a) a rewrite of the "not tracked" copy with an explicit aggregate-tracking disclosure, (b) a global daily cap + dedup/lock discipline, and (c) a non-toast surface or a queued toast system. That's a lot of "and then," which is why it's shelved, not scheduled.

**One free bonus worth a thought (zero infra, no global claim):** if the real goal is "make wandering feel a little wondrous," a *path-improbability* heuristic — hop count + category divergence between start and current, all derivable from `stack.path` client-side — delivers a cousin of the feeling ("you've drifted far from where you started") honestly, for free, without ever asserting "nobody's been here." Different feature, cheapest route to the emotion you're actually chasing.

**Bottom line:** Reject the global wander toast. Build the race-route version (win overlay, with the rarity guard) after the trivia/premium batch. Keep the "not tracked" promise intact.

## Orchestrator addendum

Gray asked whether premium-gating rescues the global variant: it does not.
Gating shrinks the participant pool, making novelty even more universal and
the signal weaker; and the approved race-route variant is one insert per
race submit, too cheap to paywall. Race-route novelty queued AFTER the
trivia portal / TOC peek / premium batch.
