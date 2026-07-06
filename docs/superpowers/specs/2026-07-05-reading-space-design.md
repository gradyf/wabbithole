# Condensing chrome: maximize reading space while scrolling

Approved by Gray 2026-07-05. Implementation is delegated to subagents; this
spec is written to be sufficient without the approving conversation.

## Problem

While reading a card, ~106px of app chrome sits permanently above the prose:
the 56px topbar (`header.wh-topbar`, `index.html:13`), a 6px desk gap
(`wrapEl.style.top = '6px'` in `src/stack.ts`), and the ~44px card tab strip
(`.wh-tab`, built in `src/stack.ts` around line 184, styled in
`src/ds/css/components.css:335` area; height `var(--tab-height)`). The tab
sits outside the card's internal scroller (`.wh-card-body`, the per-card
scroll container `view.bodyEl`), so none of this scrolls away. Wikipedia's
Vector 2022 hides its header on scroll; we should do better, not worse.

## Approved design (direction A: condense on scroll)

A per-card **reading state**. While the user scrolls down inside a card, the
topbar collapses away entirely and the card tab condenses into a single slim
bar (~36px) that keeps orientation and gains icon-only actions. Any upward
scroll restores full chrome.

### State machine

- Owner: `CardStack` in `src/stack.ts` watches the ACTIVE card's `bodyEl`
  scroll events. State is a boolean `reading`.
- Enter `reading` when `scrollTop > 96` AND accumulated downward delta since
  the last direction change exceeds 24px.
- Exit `reading` when any of:
  - accumulated upward delta exceeds 16px, or
  - `scrollTop < 96`, or
  - the active card changes (new card always starts with full chrome —
    EXCEPT when restoring a saved scrollTop > 96, which may enter reading
    immediately; either behavior is acceptable, pick the simpler), or
  - focus lands inside the topbar or tab via keyboard (`focusin`), or
  - a sidebar (Trail `#sidebar`, Bank `#bank-sidebar`; open = no
    `data-collapsed` attribute) is opened.
- Propagation: new optional hook in `StackEvents` (`src/stack.ts:33`):
  `onReadingChange?(reading: boolean): void`. `src/main.ts` receives it and
  sets `data-reading` on `document.documentElement`. All visuals are CSS
  driven off `html[data-reading]`.

### Visuals (all in `src/app.css`; `src/ds/` stays verbatim)

- Topbar: `html[data-reading] .wh-topbar { height: 0; opacity: 0; }` with
  `transition: height 180ms var(--ease-settle), opacity 120ms ease;`
  `overflow: hidden` on the topbar during transition. When collapsed the
  topbar must also get `inert` and `aria-hidden="true"` (set in main.ts
  alongside the attribute — CSS cannot do this).
- Tab condenses: `html[data-reading] .wh-tab` shrinks to 36px height,
  slightly smaller title type, keeps `.wh-tab-num`, `.wh-tab-title`, the
  subtitle (`.wh-tab-sub`) hides, and the carrot rule (border-bottom on
  `.wh-card[data-state="active"] > .wh-tab`) stays.
- Slim action cluster: a right-aligned group INSIDE the active card's tab,
  visible only in reading state (`opacity` fade, `visibility: hidden`
  otherwise). Contents, left to right:
  - wabbit mark (18px, `src/ds/assets/logo/mark.png`) acting as Home —
    same behavior as `#btn-home` (clicking = topbar logo click),
  - sparkles icon = Extract trivia for the CURRENT card (reuses the same
    handler as the in-article extract button; must reflect the same status
    decoration — `decorateExtractButton` in `src/trivia.ts` keys off the
    button element, so register this button through the same
    `onExtractButton` path or call `trivia.decorateExtractButton`),
  - Trail icon (toggles trail sidebar = `#btn-trail` click),
  - Bank icon (= `#btn-bank` click),
  - Share icon (= `#btn-share` click).
  - No avatar/user button in the cluster (Clerk mounts one #user-button
    node; scroll-up brings the real one back).
- Ownership boundary: `stack.ts` stays app-agnostic. It exposes the tab
  element via a new optional hook `onTabExtras?(node: CardNode, tab:
  HTMLElement): void` called when a card's tab renders; `main.ts` builds the
  cluster element and appends it there, wiring clicks to the existing
  buttons by id. Icon-only buttons use existing `.wh-iconbtn` + `.wh-icon`
  patterns; register any missing icon masks in app.css (icons available:
  layers, list, link, book-marked, sparkles, external-link...; check
  registered names in app.css before adding).
- Motion: 180ms, `var(--ease-settle)`. Under
  `@media (prefers-reduced-motion: reduce)` all these transitions are
  `none` (instant swap).

### Bundled quick wins

1. `.wh-card-body` top padding: override in app.css from `var(--space-6)`
   to `var(--space-4)` (keep side/bottom as is).
2. Dead vertical band beside tall infoboxes (see Xanthi FC Arena): section
   content sometimes starts BELOW the infobox instead of flowing beside it.
   No `clear` rule exists on `.wh-prose h2` (checked), so diagnose the real
   cause on that article (candidates: `<br clear>`/`clear` styles surviving
   sanitization in article HTML, or stripped-element placeholders).
   Acceptance: on `#/en/Xanthi_FC_Arena`, the Capacity heading and its text
   flow beside the infobox like Wikipedia does. This is a separate commit.

### Acceptance criteria (verify in a real browser via Playwright,
`vercel dev` on :3000; no auth needed for anonymous reading behavior)

1. Open a long article (e.g. `#/en/Ada_Lovelace`), scroll the card down
   300px: topbar hidden (height 0, `inert`, aria-hidden), tab is ~36px,
   cluster visible. Prose area gained ≥60px vertical space (measure
   `.wh-card-body` top relative to viewport).
2. Scroll up ~40px: full chrome returns (topbar 56px, tab full height,
   cluster hidden).
3. Scroll back to top (< 96px): full chrome.
4. Click a Contents link jumping deep into the article: reading state
   engages.
5. Open a link into a second card: full chrome on the new card (or
   condensed if restored deep — whichever was implemented; assert the
   implemented choice).
6. With `prefers-reduced-motion: reduce` emulated: states swap with no
   transition errors.
7. Cluster actions: Trail icon opens the trail sidebar AND exits reading
   state; sparkles opens the extract panel (signed-out: opens sign-in —
   just assert the panel/modal attempt, don't complete auth).
8. Keyboard: after condensing, pressing Shift+Tab / Tab never focuses
   invisible topbar controls; focusing the tab cluster keeps it visible.
9. Mobile viewport (390x844): same enter/exit behavior; no horizontal
   overflow.
10. `npm run build` passes; no console errors during the above.

### Non-goals

- No changes to entry/landing screens, quiz overlay, sidebars' own layout,
  or the DS files under `src/ds/`.
- No reader-mode toggle (may come later).

## Delegation plan (Opus subagents, sequential — same files)

1. **Agent 1 — state + collapse:** StackEvents hook, scroll state machine,
   `data-reading` plumbing with inert/aria in main.ts, topbar + tab CSS,
   padding trim. Verifies criteria 1-6, 10.
2. **Agent 2 — slim cluster:** `onTabExtras` hook, cluster build in
   main.ts, icon wiring incl. sparkles status decoration. Verifies 7-10.
3. **Agent 3 — infobox band fix:** diagnose + fix, separate commit.
4. **Agent 4 — review:** code-review pass over the combined diff against
   this spec; report findings, fix only clear-cut defects.

Each agent commits its own work on `trivia-layer` with a descriptive
message. No deploys from agents; the orchestrating session deploys.
