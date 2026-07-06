# Trivia portal: Bank becomes a tabbed trivia sidebar

Approved by Gray 2026-07-06 (AskUserQuestion): tabbed right sidebar
(not an overlay); v1 scope = Bank + Stats + History including the new
quiz_sessions table. Motivation: "Bank" in the topbar becomes a general
"Trivia" entry point; future premium surfaces (Settings with the flags
toggle, Upgrade) slot in as additional tabs per the premium plan
(2026-07-06-premium-plan.md).

## Shape

- The topbar button (and its counterparts in the condensed reading
  tab cluster and the entry-screen topbar) renames Bank → **Trivia**
  (keep one consistent icon; aria labels updated). It opens the same
  right-docked sidebar (#bank-sidebar), which becomes the **trivia
  sidebar** with a tab row at its head: **Bank | Stats | History**.
- The two-dock rule holds (Trail left, Trivia right). No new surfaces.
- Deep-linking between tabs is NOT required; the sidebar opens on
  Bank (or the last-used tab within the session — implementer's
  choice, note it).
- All three tabs are signed-in surfaces (same gating as today's bank;
  signed-out click prompts sign-in via the existing pending-action
  pattern).

## Tab 1: Bank

Today's bank view unchanged (grouped questions, expandable answers,
remove, quiz-me, foot count). Only its container/head changes.

## Tab 2: Stats (no schema change — derived client-side)

From the existing GET /api/bank payload (timesAnswered, timesCorrect,
addedAt, per-article grouping):
- Headline row: total questions · answered at least once · overall
  accuracy (correct/answered).
- Per-article list: article title, question count, accuracy; sorted
  worst-accuracy first (that is the useful study order); articles with
  nothing answered sink to the bottom as "not quizzed yet".
- "Toughest questions": bottom 5 by accuracy (min 2 attempts), each
  expandable with the same reveal pattern as the bank rows.
- Empty state: friendly nudge to extract + quiz first. DS voice,
  sentence case, no em dashes.

## Tab 3: History (new data)

- Schema: `quiz_sessions` — id uuid pk defaultRandom, clerkUserId
  text notNull (indexed), playedAt timestamptz notNull default now,
  questionCount int notNull, correctCount int notNull. Generate the
  drizzle migration; DO NOT apply it (orchestrator applies at deploy).
- API: the existing quiz-results endpoint additionally inserts one
  quiz_sessions row per completed round (same request — no extra
  round-trip; validate counts: 1..100, correct ≤ count). New GET
  (extend the same endpoint or api/quiz-history.ts, implementer's
  choice) returning the user's last 50 sessions desc.
- UI: list of rounds — "8/10 · {relative time}" rows; a small
  aggregate line up top (rounds played, average score). Rounds played
  before this ships simply don't exist — no backfill, acceptable.
- Ownership scoping in WHERE clauses per api/bank.ts patterns; caps
  and response shapes consistent with house style.

## Constraints

- Tabs are a DS-consistent segmented control in the sidebar head;
  keyboard accessible (arrow keys or plain buttons with aria-selected).
- The sidebar foot stays contextual to the active tab (bank foot count
  on Bank; nothing forced on the others).
- No regression to: reading-state exit-on-sidebar-open behavior, the
  MutationObserver wiring on data-collapsed, trails sidebar, the tab
  cluster.
- api/ ESM .js imports; migration NOT applied by the implementer.
- DS voice everywhere; sentence case; no em dashes.
