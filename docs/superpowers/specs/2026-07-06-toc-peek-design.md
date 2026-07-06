# UX Spec — Mid-Read Contents Peek (Wabbit Hole)

## Why this shape (60-second read, Gray)

The problem is narrow: the synthesized Contents (`details.wh-toc`) is glued to the very top of the card body (`stack.ts:294`). The instant you read on, it scrolls away, and there's no way back to it short of scrolling to the top. Reading state has *also* just collapsed the topbar to reclaim space, so we can't just "put Contents in the chrome" without undoing the whole reading-space feature.

The winning shape (judges unanimous, both scored it 8) is a **Contents peek**: a single 16px `list` glyph that lives *inside the card's own tab* — the one surface that never scrolls away and is already exempt from every reading-exit trigger. Tap it and a small popover drops under the slim tab, floating over the prose. It re-presents the article's sections, marks "you are here," and jumps via the *exact* existing fragment-scroll code. It is **not** a sidebar: it never joins the `[Trail | stage | Bank]` flex row, so it can't compress the stage and the sidebar-close observer can't see it. It lives and dies with the reading moment and adds **zero persistent reading-time chrome** — which is the entire point of the reading-space spec it has to coexist with.

I've folded in four keeper ideas the judges pulled from the losing proposals:
1. **Codified the "docks vs. card-chrome" rule** (from P2) as a stated architecture invariant, so the *next* surface someone wants to add doesn't reflexively become sidebar #3.
2. **Covered the "scrolled deep but not reading" gap** (from P3) — the winner's pure-`[data-reading]` scoping left a hole; I close it with one tab attribute at near-zero cost.
3. **Pre-resolved the `list` icon collision** (from P2).
4. Left the **ambient progress underline** (from P3) speced but *off by default* — it's the one graft that adds standing chrome, and the two judges disagreed on it, so it's yours to call.

## Decisions that genuinely need your taste

- **D1 — Ambient reading-progress underline (2px fill on the tab's bottom fold).** Judge A wanted it grafted; Judge B flagged it as standing chrome that fights the minimize-chrome ethos. It's cheap and always-on wayfinding the peek otherwise lacks. **My lean: ship it, it's 2px on a border that already exists.** But it's the one piece here that is visible even when you're not consulting Contents, so it's a taste call. Speced in §7 as opt-in.
- **D2 — Trigger visibility: reading-only vs. "deep-scrolled."** Pure winner = trigger only while `html[data-reading]`. I widened it to appear whenever you're scrolled past the fold (`data-deep`), which also serves the "nudged up 20px, exited reading, still deep" reader. This is a superset that costs one attribute. **My lean: keep the wider version.** Reverting to reading-only is a one-selector change if you dislike a control appearing in full chrome. Flagged inline in §3/§9.
- **D3 — Trigger glyph.** `list` is the semantic Contents mark and ties the peek to the inline block, but `list` is *also* Trail's cluster glyph (`main.ts:209`) and the inline TOC summary glyph (`stack.ts:482`). Because the peek trigger sits **left of the title** and Trail's `list` sits in the **right cluster**, they're never adjacent. **My lean: use `list`** (identity beats the far-apart collision). If you'd rather zero ambiguity, `align-left` or `list-tree` reads as "outline." Flagged in §3.

---

## 1. Architecture invariant (write this into the spec + a code comment)

Wabbit Hole has exactly **two navigation-surface classes**. Encode this so future surfaces get classified, not defaulted into a sidebar:

- **DOCKS** — cross-article collections you *dwell in*. Max **two**, one per side of the stage: Trail (`#sidebar`, left) and Bank (`#bank-sidebar`, right). They are `aside.wh-sidebar`, carry `data-collapsed`, sit in the `.wh-main` flex row, **compress the stage**, and **force-exit reading** (the `readingExitObserver`, `main.ts:220-229`). *We do not add a third dock.*
- **TRANSIENT CARD CHROME** — intra-article navigation and per-card actions. Zero persistent footprint, card-scoped, absolutely-positioned overlay or in-tab control, **dies with reading state**. The slim action cluster is one; the Contents peek is the second.

**Rule:** *If it navigates within the current article, it rides the card (tab / popover). If it's a cross-article collection you dwell in, it's a dock — and there are only ever two.* The Contents peek is card chrome, so it does **not** count against the two-dock budget. Reserve `onToc?(node, toc)` on `StackEvents` as the sanctioned evolution path *if* a second, non-cloning consumer of TOC data ever appears — but v1 does **not** add it (see §10).

---

## 2. Affordance summary

| | |
|---|---|
| **Trigger** | `.wh-iconbtn.wh-toc-trigger`, 16px `list` glyph (D3), inserted into the active card's `.wh-tab` **immediately after `.wh-tab-title`, before `.wh-tab-sub`**. `flex: none`. |
| **When visible** | Active card **and** the card has a synthesized TOC (`toc.length >= 3`) **and** the reader is scrolled past the fold (`data-deep`). Invisible at the top of the article, where the inline `.wh-toc` block already serves. (D2) |
| **Popover** | `div.wh-toc-pop`, `role="dialog"`, `aria-label="Contents"`, mounted on the card's `.wh-cardpos` wrapper (position:absolute, escapes `.wh-card`'s `overflow:hidden`), `top:36px; left:var(--space-4)`, `z-index:20`. Built by cloning the live `.wh-toc-nav` from the same card's body. |
| **What it is not** | Not an `aside.wh-sidebar`, no `data-collapsed`, never in `.wh-main`. So the sidebar observer is blind to it and it never compresses the stage. |

---

## 3. Trigger placement & gating (exact)

**Placement.** In `buildTabCluster`'s caller path (`onTabExtras`, `main.ts:122-124`), build the trigger alongside the cluster and insert it *before* the subtitle span:

```
tab.insertBefore(tocTrigger, tab.querySelector('.wh-tab-sub'));
```

Resulting tab order: `num, title, [toc-trigger], sub, …cluster`. In reading state `.wh-tab-sub` is `display:none` (`app.css:95`) so the trigger hugs the title; the cluster stays right-aligned via its `margin-left:auto`. **The trigger sits LEFT, deliberately not in the right cluster** — this sidesteps both the crowded 5-icon budget at 375px (the title's `min-width:0` ellipsis absorbs the ~28px) and the `list`-glyph adjacency with Trail (D3).

**Gating (two conditions, both CSS-driven, no JS `hidden` toggling):**

- `data-has-toc` — set by **stack.ts** at the existing gate, `stack.ts:294`, inside `if (processed.toc.length >= 3)`: `view.tabEl.dataset.hasToc = ''`. Single-sources the "has Contents" decision with the inline block; short articles never sprout a dead trigger.
- `data-deep` — set by **stack.ts** `handleScroll`, toggled `st > 96` (the same fold constant reading uses). Because reading only ever engages when `st > 96`, `data-deep` is a strict superset of reading — so revealing on `data-deep` alone covers **both** reading and the "deep-but-not-reading" reader (D2), with no dependence on `[data-reading]`.

**Reveal selector (app.css):**
```
.wh-card[data-state="active"] > .wh-tab[data-has-toc][data-deep] .wh-toc-trigger { /* shown */ }
/* default: display:none */
```

**Restore/layout correctness:** `handleScroll` early-returns on `delta === 0`, and `restoreTopScroll` (`stack.ts:450`) pre-syncs `lastScrollTop` so the programmatic scroll reads as delta 0 — meaning a resurfaced deep card would never get `data-deep` from the scroll path. So also set it explicitly wherever scrollTop is restored or the active body switches:
- in `restoreTopScroll` (`stack.ts:450-453`): `view.tabEl.toggleAttribute('data-deep', view.bodyEl.scrollTop > 96)`
- in `layout()`'s active-body switch block (`stack.ts:402-408`): same toggle for the new top view.

Compute `st` / toggle `data-deep` (and, if D1 ships, set `--wh-read`) at the **top** of `handleScroll`, *before* the `delta === 0` early return.

---

## 4. Open behavior

Trigger is a real `<button>` with `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls="wh-toc-pop"`. Its click handler uses the same `e.stopPropagation()` guard as the cluster buttons (`main.ts:164-167`) so the click fires despite living inside the disabled top-card tab `<button>` (proven pattern, spec criterion 7). Click / Enter / Space:

1. Clone the active body's `nav.wh-toc-nav` (guarantees byte-identical markup + inherited `.wh-toc-list` styling; no new StackEvents hook — honors "operate on the rendered block").
2. Prepend a light, non-interactive header row (`.wh-toc-pop-head`): `list` icon + "Contents" + the section count string reused from `tocBlock` (`toc.length === 1 ? '1 section' : '${n} sections'`).
3. **Scroll-spy at open (no live observer):** for each cloned entry `id`, read the real heading's `getBoundingClientRect().top` against `body.getBoundingClientRect().top + 56` (the same 56px reference the jump uses, `stack.ts:333`). Mark the **last heading at/above the fold** with `aria-current="location"` and `[data-current]` (a link-tinted row, reusing the trail's current-item idiom). Because the peek closes on any scroll, this marker is always fresh at open — no `IntersectionObserver` lifecycle to manage across hibernation/resurface.
4. Mount on `trigger.closest('.wh-cardpos')`, set `aria-expanded="true"`, fade-scale in with `--dur-med`/`--ease-settle`.
5. Move focus to the `[data-current]` link (or the first link if none marked).

---

## 5. Jump behavior

Delegated click inside the popover intercepts anchor clicks: `e.preventDefault()`, read `href.slice(1)`, call the **new public `stack.jumpToActiveFragment(id)`**. Sequence in the row handler:

1. `closeTocPeek()` — idempotent; detaches the one-shot scroll-close listener *first* so the upcoming smooth scroll can't re-fire it.
2. `stack.jumpToActiveFragment(id)` — resolves the top view, runs `scrollToHeading` (see §10), and focuses the target heading last (`tabindex=-1`, `focus({preventScroll:true})`, mirroring `focusTop`).

The programmatic `scrollTo` re-fires `handleScroll` exactly as an inline Contents-link jump does today, so a **downward** jump keeps reading engaged (spec acceptance criterion 4). An **upward** jump (deep → earlier section) accumulates upward delta and may exit reading mid-jump, restoring chrome — this is behaviorally identical to a manual scroll-up and is **accepted as correct**; call it out in review, don't special-case it.

---

## 6. Close behavior & state

`closeTocPeek()` is idempotent: removes the popover, detaches all listeners, resets `trigger.aria-expanded="false"`, and (except on jump, where focus goes to the heading) restores focus to the trigger. Because the trigger lives in a condensing tab, losing focus there would strand keyboard users — close **must** always land focus somewhere deliberate.

| Close trigger | Wiring | Focus lands |
|---|---|---|
| Select a section | delegated row click → jump then close | target heading |
| Escape | new branch **prepended** to the keydown handler (`main.ts:494-498`), ahead of about-overlay/back fallthrough | trigger |
| Outside click | extend the document-click pattern (`main.ts:335-337`): close if click is outside `.wh-toc-pop` and the trigger | trigger |
| Next body scroll | one-shot `{once:true, passive:true}` scroll listener on the active body, attached at open | trigger |
| Any reading exit | `onReadingChange(false)` calls `closeTocPeek()` — one line covers scroll-up, reach-top, sidebar-open, topbar-focus, and card-switch, since all funnel through `setReading(false)` | trigger |

---

## 7. (D1, opt-in) Ambient reading-progress underline

If shipped: in `handleScroll` (top, before the delta return) set `view.tabEl.style.setProperty('--wh-read', String((st + body.clientHeight) / body.scrollHeight))`. Render as a 2px `var(--link)` fill on the tab's existing bottom fold:

```
.wh-card[data-state="active"] > .wh-tab::after {
  /* on the existing carrot/fold border */
  transform: scaleX(var(--wh-read, 0));
  transform-origin: left;
  transition: transform var(--dur-fast) linear;
}
```
Null the transition under the reduced-motion block. Always visible in every state incl. mobile; zero tap budget. **Default: not shipped pending your D1 call.**

---

## 8. Coexistence — sidebars & reading state

The systemic guarantee is *mutual exclusion in time, by construction* — no z-index war, no arbitration code:

- Opening Trail or Bank fires `readingExitObserver` → `stack.exitReading()` → `setReading(false)` → `onReadingChange(false)` → `closeTocPeek()`. So **a dock and the peek can never be open at once.**
- The peek carries no `data-collapsed` and is not in `.wh-main`, so opening it is **invisible** to the observer — consulting Contents mid-read does **not** re-expand chrome (the whole point). The coupling runs one direction only.
- The peek is not inside `#topbar`, so the topbar `focusin` exit (`main.ts:231-238`) never fires when focus enters the popover — it inherits the same exemption the tab cluster has (criterion 8), for free, by living in the card zone.

**Reading-state × Contents matrix:**

| Reader state | `[data-reading]` | Trigger shown? | Peek can open? | On sidebar open |
|---|---|---|---|---|
| At top (`st<96`) | off | no (`data-deep` off) | n/a — inline `.wh-toc` serves | — |
| Scrolling down, `st>96` | **on** | yes | yes, chrome stays condensed | reading exits → peek closes |
| Nudged up ~20px, still deep | off | **yes** (`data-deep` on) | yes, in full chrome | reading already off; peek closes |
| Card switch | reset off | rebuilt per new card | — | — |

**z-index safety net:** peek at 20, below both sidebars (30, incl. mobile floating variant) and toast (50). An impossible transient overlap resolves in the sidebar's favor.

---

## 9. Mobile (≤719px)

- Trigger rides the slim-tab mechanism, which is **not** breakpoint-gated (criterion 9), so behavior at 390×844 matches desktop. It sits LEFT of the title, *before* the cluster's `margin-left:auto` gap — it does **not** compete for the crowded right-hand 5-icon budget (Home/Extract/Trail/Bank/Share ship unchanged). The ellipsizing title (`min-width:0`) absorbs the ~28px.
- Popover: `left:var(--space-4)`, `max-width:min(360px, calc(100% - 32px))`, `max-height:min(60vh, …)`, `overflow-y:auto`, `overscroll-behavior:contain`. **Force single column** — `.wh-toc-pop .wh-toc-list{ columns:1 }` — overriding the cloned list's desktop 2-column rule (`app.css:531-533`), which would otherwise cram two columns into a ~340px popover.
- No horizontal body overflow (criterion 9 bar). On mobile the docks are floating `position:absolute` panels at z-index 30; since opening either exits reading and closes the peek, they're never co-visible, and z-index 20 keeps ordering safe regardless.

---

## 10. Accessibility

- Trigger: `<button>`, `aria-haspopup="dialog"`, `aria-expanded` (toggled), `aria-controls="wh-toc-pop"`, `aria-label="Contents"`, `title="Contents"`.
- Popover: `id="wh-toc-pop"`, `role="dialog"`, `aria-label="Contents"`. Focus moves in on open (current-section link), returns to trigger on every non-jump close.
- Current section: `aria-current="location"` + `[data-current]` on the matching row.
- Cloned `nav` keeps `aria-label="Contents"`; header row `list` icon is `aria-hidden`.
- Escape closes before falling through to about/back; outside-click and reading-exit closes preserve focus.
- Motion: fade-scale via `--dur-med`/`--ease-settle`, nulled under `@media (prefers-reduced-motion: reduce)` (extend the existing block, `app.css:129-135`). Jump uses `behavior: prefersReducedMotion() ? 'auto' : 'smooth'` (already handled inside the reused scroll code).

---

## 11. DS-voice copy strings

Sentence case, calm, no exclamation. Reuse existing strings where they exist.

| Where | String |
|---|---|
| Trigger `aria-label` / `title` | `Contents` |
| Popover `aria-label` / header label | `Contents` |
| Header count | `1 section` / `${n} sections` (reuse `tocBlock`'s exact expression, `stack.ts:488`) |
| SR current marker | conveyed via `aria-current="location"` (no visible label) |

No toast is introduced.

---

## 12. Implementation sketch by file

All three touched files are inside the `app.css + main.ts + stack.ts` territory the reading-space spec carved out. **`src/ds/` stays verbatim; sidebars and overlay dialogs are untouched.**

### `src/stack.ts`
- **Refactor** the `'fragment'` case body (`stack.ts:331-338` — the rect-offset `scrollTo(-56)` + `.wh-flash` remove/reflow/add) into `private scrollToHeading(body: HTMLElement, frag: string)`. The fragment case calls it (reuse, constraint 5).
- **Add** `public jumpToActiveFragment(frag: string): void`: resolve `this.views[this.views.length-1]`, guard `hydrated`, `scrollToHeading(view.bodyEl, frag)` (using `CSS.escape(frag)`, mirroring `stack.ts:330`), then focus the target heading (`tabindex=-1`, `focus({preventScroll:true})`).
- **`stack.ts:294`**, inside `if (processed.toc.length >= 3)`: `view.tabEl.dataset.hasToc = ''`.
- **`handleScroll` (`stack.ts:415`)**, at the very top after the `body !== activeBody` guard and computing `st`: `view.tabEl.toggleAttribute('data-deep', st > 96)` (and, D1, set `--wh-read`) — *before* the `delta === 0` early return.
- **`restoreTopScroll` (`stack.ts:450`)** and **`layout()`'s active-body switch (`stack.ts:402-408`)**: `view.tabEl.toggleAttribute('data-deep', view.bodyEl.scrollTop > 96)`.
- **No** new `StackEvents` hook and **no** new data field. (`onToc` stays reserved for a future non-cloning consumer only, per §1.)

### `src/main.ts`
- In the `onTabExtras` path (build the trigger alongside `buildTabCluster`, `main.ts:171-214`): create `.wh-toc-trigger` (`list` icon, `aria-haspopup="dialog"`, `aria-expanded="false"`, `aria-controls="wh-toc-pop"`, `stopPropagation` click → `openTocPeek(trigger)`), and `tab.insertBefore(trigger, tab.querySelector('.wh-tab-sub'))`.
- Add module fns `openTocPeek(trigger)` / `closeTocPeek()`: clone `.wh-toc-nav` from the trigger's card body; prepend `.wh-toc-pop-head`; compute + mark current section; mount on `trigger.closest('.wh-cardpos')`; wire delegated row-click → `closeTocPeek()` then `stack.jumpToActiveFragment(id)`; attach one-shot body-scroll close; respect `prefersReducedMotion`. Track a single open peek.
- **`onReadingChange` (`main.ts:111-121`)**: on `false`, call `closeTocPeek()` (covers scroll-up, sidebar-open, topbar-focus, card-switch).
- Extend outside-click (`main.ts:335-337`) to close the peek; **prepend** an Escape branch to the keydown handler (`main.ts:494-498`) so Escape closes the peek ahead of about/back.

### `src/app.css`
- `.wh-toc-trigger`: reuse `.wh-iconbtn` metrics, `flex:none`; default `display:none`; reveal via `.wh-card[data-state="active"] > .wh-tab[data-has-toc][data-deep] .wh-toc-trigger`; active tint on `[aria-expanded="true"]`.
- `.wh-toc-pop`: `position:absolute; top:36px; left:var(--space-4); max-width:min(360px, calc(100% - 32px)); max-height:min(60vh, …); overflow-y:auto; overscroll-behavior:contain; z-index:20;` surface-card + border-hairline + radius-md + shadow-float; `--dur-med`/`--ease-settle` fade-scale. `.wh-toc-pop .wh-toc-list{ columns:1 }`. `[data-current]` row = `var(--link-tint)`.
- (D1) `.wh-tab::after` progress fill (§7).
- Extend the `prefers-reduced-motion` block (`app.css:129-135`) to null the popover (and, D1, underline) transitions.

---

## 13. Review / risk notes

1. **Nested `<button>`** (trigger inside the disabled top-card tab `<button>`): technically invalid HTML but identical to the shipped cluster buttons; clicks demonstrably fire via `stopPropagation`. Consistency choice, not a new regression — note in review.
2. **Upward-jump reading exit** (§5): accepted as correct (mirrors manual scroll-up); confirm in review.
3. **Clone coupling:** the popover and the `data-has-toc` gate both depend on `tocBlock`'s classnames/structure (`stack.ts:476-523`). A future `tocBlock` refactor must update the clone selectors + `.wh-toc-pop` CSS together. If a non-cloning consumer ever appears, add the reserved `onToc` hook rather than deepen the DOM coupling.
4. **Close/jump ordering:** the one-shot scroll-close listener must be detached *before* the jump's smooth scroll; `closeTocPeek()` must be idempotent.
5. **Mount point:** must be `.wh-cardpos` (position:absolute, establishes containing block via its `transform`, escapes `.wh-card`'s `overflow:hidden`). A reviewer moving the mount to `.wh-card` reintroduces clipping — leave a comment.
6. **`data-deep` on restore:** verify the explicit toggles in `restoreTopScroll`/`layout` fire, since the scroll path early-returns on delta 0 for restored cards (§3).
