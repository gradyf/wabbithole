// Card stack: tree data model, linear-path render (REVIEW.md Domains E/F/G).
// Store a tree, render the active path. Rendering follows the Wabbit Hole
// design system: centered cards cascade vertically (40px tab peek, 14px
// width inset per buried level, 5 sheets visible); older cards live in the
// Trail sidebar.

import { ApiError, articleUrl, getArticle, normTitle } from './api';
import { processArticle, type TocEntry } from './content';
import { classifyLink } from './links';

export interface CardNode {
  id: number;
  lang: string;
  title: string;
  subtitle?: string;
  parentId: number | null;
  childIds: number[];
  /** Opened via the topbar Random button — a JUMP, not a link from the card
   *  below it. Rendered with a plum marker in the tab, cascade strip and Trail
   *  dock; the flag is re-derived from sessionStorage so it survives reload. */
  random?: boolean;
}

interface CardView {
  node: CardNode;
  wrapEl: HTMLElement; // .wh-cardpos — geometry
  cardEl: HTMLElement; // .wh-card — state
  tabEl: HTMLButtonElement;
  tabTitleEl: HTMLElement;
  tabSubEl: HTMLElement;
  bodyEl: HTMLElement; // .wh-card-body — scroll container, gets inert
  hydrated: boolean;
  loading: boolean;
  savedScrollTop: number;
}

export interface StackEvents {
  onPathChange(path: CardNode[]): void;
  onAnnounce(msg: string): void;
  onToast(msg: string): void;
  /** When set, cards offer an "Extract trivia" action (the trivia layer). */
  onExtract?(node: CardNode): void;
  /** Called after the extract button renders, so the trivia layer can decorate it. */
  onExtractButton?(node: CardNode, btn: HTMLButtonElement): void;
  /** Reading state: true while scrolling down the active card, false on restore. */
  onReadingChange?(reading: boolean): void;
  /** Called after a card's tab renders, so the app can add tab-level controls. */
  onTabExtras?(node: CardNode, tab: HTMLElement): void;
  /** A genuinely NEW card was appended to the tip (start or link spawn), not a
   *  trail-jump revisit or a deep-link reconcile. The race layer counts these. */
  onSpawn?(node: CardNode): void;
}

const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => window.matchMedia('(max-width: 719px)').matches;

// Trail cascade (Task 21). Near the top of the active card the ancestor tabs
// "unstack" into a visible cascade so the trail reads at a glance; scrolling in
// collapses them behind the active tab (today's space-saver). The flip is
// hysteretic around the ~96px Contents-peek fold so it never jitters at the
// boundary, and the number of peek strips is capped so a deep trail can't eat
// the screen — older cards stay in the Trail dock, with a "+N earlier" marker.
const CASCADE_CAP_DESKTOP = 4;
const CASCADE_CAP_MOBILE = 1;
const CASCADE_UNSTACK_BELOW = 64; // scrolled back up past this -> unstack
const CASCADE_COLLAPSE_ABOVE = 112; // scrolled down past this -> collapse
const CASCADE_INSET_STEP = 8; // px of width inset per buried level (the nesting)
const CASCADE_INSET_MAX = 28;

// Reading-state chrome (topbar collapse + active-tab condense + racebar). The
// topbar hides on sustained scroll-down and reveals on sustained scroll-up. The
// flip is hysteretic so hunting up and down a card never flutters it (Task 26,
// Gray: "the menu bar keeps popping up and down in time with the scroll"). A
// direction reversal zeroes accumDelta (handleScroll), so only committed travel
// in ONE direction past CHROME_TRAVEL toggles — a small re-read jiggle leaves the
// bar where it is. Near the top (< CHROME_TOP_FOLD) the chrome is always shown.
// Tuned by feel in-browser; 120px reads as a deliberate flick, not a jitter
// (was 24px down / 16px up, which flipped on nearly every direction change).
const CHROME_TOP_FOLD = 96; // within this many px of the card top, chrome always shows
const CHROME_TRAVEL = 120; // sustained one-direction travel (px) before the topbar toggles

// Oversized template taming (Task 26 Item A, the Charles River repro). Two
// layers, applied at render time (content.ts owns sanitize-time stripping;
// these need the rendered card, so they live here):
// 1. Navigation chrome that survives the sanitizer is dropped outright:
//    .navbar is the v-t-e template link cluster (pure inter-article chrome,
//    rendered as a giant blue block without TemplateStyles) and .selfreference
//    marks Wikipedia self-links like a route diagram's "Legend" pointer at
//    Template:Waterways_legend. Informative blocks are never deleted.
// 2. Any remaining in-flow block (route diagram table, packed gallery, long
//    reference list) taller than OVERSIZE_FRACTION of the window is clamped
//    to 48vh (CSS .wh-clamp: bottom fade + a "Show full table" style toggle).
//    A ResizeObserver sizes each candidate, so late-loading images still trip
//    the clamp. Floated elements (desktop infobox, thumbs) are exempt — they
//    sit beside the text, not on top of it; the mobile infobox is in-flow and
//    does get clamped. The 48vh clamp vs 60% threshold leaves a dead band so
//    borderline blocks never flicker between states.
const OVERSIZE_FRACTION = 0.6; // of window.innerHeight; clamp target is 48vh in CSS
const NAV_CHROME_SELECTOR = '.navbar, .selfreference';
const CLAMP_CANDIDATES = 'table, div, figure, ul, ol, dl, blockquote';
let clampSeq = 0;

export class Stack {
  lang = 'en';
  private nodes = new Map<number, CardNode>();
  private nextId = 1;
  private views: CardView[] = [];
  private stage: HTMLElement;
  private events: StackEvents;

  // Reading state: watch the ACTIVE card's scroll. Scrolling down collapses
  // the chrome; scrolling up (or reaching the top, or a new active card)
  // restores it. Deltas accumulate per direction so small jitters don't flip.
  private reading = false;
  private activeBody: HTMLElement | null = null;
  private lastScrollTop = 0;
  private accumDelta = 0;
  private lastDir = 0; // -1 up, 1 down, 0 none

  // Cascade state: true when the trail is unstacked (near the card top). The DOM
  // flip is the stage's data-unstacked attribute; the count of ancestor strips
  // lives in the --peek-count CSS var, which pushes the active card down.
  private unstacked = true;

  // Titles opened via the Random button, keyed `lang:title`. Persisted to
  // sessionStorage so the plum trail marker survives a reload — the URL hash and
  // the signed-in autosave both carry titles only, no per-card flags. Session-
  // scoped on purpose: a shared /t/ trail is curated, not "your" random jumps.
  private randomKeys = new Set<string>();

  constructor(stage: HTMLElement, events: StackEvents) {
    this.stage = stage;
    this.events = events;
    this.stage.toggleAttribute('data-unstacked', true);
    try {
      const raw = sessionStorage.getItem('wh-random');
      if (raw) for (const k of JSON.parse(raw) as string[]) this.randomKeys.add(k);
    } catch {
      /* sessionStorage unavailable (private mode etc.) — markers just won't persist */
    }
    window.addEventListener('resize', () => this.layout());
  }

  private randomKey(lang: string, title: string): string {
    return `${lang}:${normTitle(title).toLowerCase()}`;
  }

  /** Flag a node as a random jump and remember it for this session, so the
   *  marker returns after a reload rebuilds the trail from titles alone. */
  private rememberRandom(node: CardNode): void {
    node.random = true;
    const key = this.randomKey(node.lang, node.title);
    if (!this.randomKeys.has(key)) {
      this.randomKeys.add(key);
      try {
        sessionStorage.setItem('wh-random', JSON.stringify([...this.randomKeys]));
      } catch {
        /* ignore */
      }
    }
  }

  get path(): CardNode[] {
    return this.views.map((v) => v.node);
  }

  private maxLive(): number {
    return isMobile() ? 2 : 5;
  }

  titles(): string[] {
    return this.views.map((v) => v.node.title);
  }

  // ---- public operations ----------------------------------------------------

  async startWith(lang: string, title: string, opts: { random?: boolean } = {}): Promise<void> {
    this.lang = lang;
    this.clearViews();
    this.nodes.clear();
    this.nextId = 1;
    // A deliberate fresh start resets the random-jump memory, so a later trail
    // that happens to reach an old random title isn't mis-marked.
    this.randomKeys.clear();
    try {
      sessionStorage.removeItem('wh-random');
    } catch {
      /* ignore */
    }
    const node = this.makeNode(title, null);
    if (opts.random) this.rememberRandom(node);
    // Count the spawn BEFORE appendView, whose layout() fires onPathChange —
    // win detection there must already see this card in the score.
    this.events.onSpawn?.(node);
    const view = this.appendView(node);
    this.commit(true);
    await this.hydrate(view);
  }

  async spawn(title: string, opts: { random?: boolean } = {}): Promise<void> {
    const t = normTitle(title);
    const dup = this.views.findIndex((v) => v.node.title.toLowerCase() === t.toLowerCase());
    if (dup >= 0) {
      this.resurface(dup, true);
      this.events.onToast('Already in your trail. Jumped back to it.');
      return;
    }
    const parent = this.views[this.views.length - 1]?.node ?? null;
    let node = parent
      ? parent.childIds.map((id) => this.nodes.get(id)!).find((n) => n.title.toLowerCase() === t.toLowerCase())
      : undefined;
    if (!node) node = this.makeNode(t, parent?.id ?? null);
    if (opts.random) this.rememberRandom(node);
    // Count the spawn BEFORE appendView, whose layout() fires onPathChange —
    // win detection there must already see this card in the score.
    this.events.onSpawn?.(node);
    const view = this.appendView(node);
    this.commit(true);
    await this.hydrate(view);
  }

  resurface(idx: number, push: boolean): void {
    if (idx < 0 || idx >= this.views.length - 1) return;
    const leaving = this.views.slice(idx + 1);
    this.views = this.views.slice(0, idx + 1);
    for (const v of leaving) this.animateOut(v.wrapEl);
    const top = this.views[idx];
    if (!top.hydrated && !top.loading) void this.hydrate(top);
    this.layout();
    this.restoreTopScroll(top);
    this.commit(push);
    this.events.onAnnounce(`Returned to ${top.node.title} — card ${idx + 1} of ${this.views.length}.`);
    this.focusTop();
  }

  /** Reconcile against a trail of titles (popstate / deep link). */
  async applyTrail(lang: string, titles: string[], push: boolean): Promise<void> {
    this.lang = lang;
    if (titles.length === 0) {
      this.clearViews();
      this.layout();
      this.commit(push);
      return;
    }
    let common = 0;
    while (
      common < this.views.length &&
      common < titles.length &&
      this.views[common].node.title.toLowerCase() === normTitle(titles[common]).toLowerCase()
    ) {
      common++;
    }
    for (const v of this.views.slice(common)) v.wrapEl.remove();
    this.views = this.views.slice(0, common);
    for (let i = common; i < titles.length; i++) {
      let parent = this.views[this.views.length - 1]?.node ?? null;
      const t = normTitle(titles[i]);
      let node = parent
        ? parent.childIds.map((id) => this.nodes.get(id)!).find((n) => n.title.toLowerCase() === t.toLowerCase())
        : undefined;
      if (!node) node = this.makeNode(t, parent?.id ?? null);
      this.appendView(node, { animate: false });
    }
    this.layout();
    this.commit(push);
    const top = this.views[this.views.length - 1];
    if (top) {
      this.restoreTopScroll(top);
      if (!top.hydrated && !top.loading) await this.hydrate(top);
    }
  }

  relayout(): void {
    this.layout();
  }

  // ---- internals --------------------------------------------------------------

  private makeNode(title: string, parentId: number | null): CardNode {
    const node: CardNode = { id: this.nextId++, lang: this.lang, title: normTitle(title), parentId, childIds: [] };
    // Re-derive the random-jump flag when a trail is rebuilt from titles alone
    // (reload, popstate): the session remembers which titles were jumps.
    if (this.randomKeys.has(this.randomKey(node.lang, node.title))) node.random = true;
    this.nodes.set(node.id, node);
    if (parentId !== null) this.nodes.get(parentId)?.childIds.push(node.id);
    return node;
  }

  private clearViews(): void {
    for (const v of this.views) v.wrapEl.remove();
    this.views = [];
  }

  private appendView(node: CardNode, opts: { animate?: boolean } = {}): CardView {
    const wrap = document.createElement('div');
    wrap.className = 'wh-cardpos';

    const card = document.createElement('section');
    card.className = 'wh-card';
    card.dataset.state = 'loading';

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'wh-tab';
    const num = document.createElement('span');
    num.className = 'wh-tab-num';
    const tabTitle = document.createElement('span');
    tabTitle.className = 'wh-tab-title';
    tabTitle.textContent = node.title;
    const tabSub = document.createElement('span');
    tabSub.className = 'wh-tab-sub';
    tabSub.textContent = node.subtitle ?? '';
    tab.append(num, tabTitle, tabSub);

    // Random-jump marker: plum-tinted tab (data-random, styled in app.css) plus
    // the shuffle glyph beside the ordinal. The tab doubles as the cascade
    // strip, so the marker reads in both places for free.
    if (node.random) {
      card.toggleAttribute('data-random', true);
      const flag = document.createElement('span');
      flag.className = 'wh-icon wh-tab-flag';
      flag.dataset.name = 'shuffle';
      flag.setAttribute('aria-hidden', 'true');
      flag.title = 'Random jump';
      tab.insertBefore(flag, tabTitle);
    }

    const body = document.createElement('div');
    body.className = 'wh-card-body';
    body.appendChild(this.loadingSkeleton());

    card.append(tab, body);
    wrap.appendChild(card);
    this.stage.appendChild(wrap);

    const view: CardView = {
      node,
      wrapEl: wrap,
      cardEl: card,
      tabEl: tab,
      tabTitleEl: tabTitle,
      tabSubEl: tabSub,
      bodyEl: body,
      hydrated: false,
      loading: false,
      savedScrollTop: 0,
    };
    this.views.push(view);

    tab.addEventListener('click', () => {
      const idx = this.views.indexOf(view);
      if (idx >= 0 && idx < this.views.length - 1) this.resurface(idx, true);
    });
    body.addEventListener('click', (e) => this.handleContentClick(e, view));
    body.addEventListener('scroll', () => this.handleScroll(body), { passive: true });
    this.events.onTabExtras?.(node, tab);

    if (opts.animate !== false && !prefersReducedMotion()) {
      card.classList.add('wh-card-enter');
      card.addEventListener('animationend', () => card.classList.remove('wh-card-enter'), { once: true });
    }
    this.layout();
    return view;
  }

  private animateOut(wrapEl: HTMLElement): void {
    const card = wrapEl.querySelector('.wh-card') as HTMLElement | null;
    if (card && !prefersReducedMotion()) {
      card.style.transition = `transform var(--dur-med) var(--ease-drop), opacity var(--dur-med) var(--ease-drop)`;
      card.style.transform = 'translateY(48px)';
      card.style.opacity = '0';
    }
    let removed = false;
    const remove = () => {
      if (!removed) {
        removed = true;
        wrapEl.remove();
      }
    };
    card?.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 400);
  }

  private async hydrate(view: CardView): Promise<void> {
    view.loading = true;
    view.bodyEl.replaceChildren(this.loadingSkeleton());
    this.layout();
    try {
      const { html, canonicalTitle } = await getArticle(this.lang, view.node.title);
      if (!this.views.includes(view)) return; // card was popped while loading

      if (canonicalTitle.toLowerCase() !== view.node.title.toLowerCase()) {
        const dup = this.views.findIndex(
          (v) => v !== view && v.node.title.toLowerCase() === canonicalTitle.toLowerCase(),
        );
        if (dup >= 0) {
          // Redirect resolved to an article already in the trail.
          this.views = this.views.filter((v) => v !== view);
          view.wrapEl.remove();
          this.resurface(Math.min(dup, this.views.length - 1), true);
          this.events.onToast('Already in your trail. Jumped back to it.');
          return;
        }
        view.node.title = canonicalTitle;
        // Keep the random marker anchored to the canonical title, which is what
        // the URL hash carries — otherwise a reload would drop the flag.
        if (view.node.random) this.rememberRandom(view.node);
        view.tabTitleEl.textContent = canonicalTitle;
      }

      const processed = processArticle(html);
      if (!this.views.includes(view)) return;
      // Render-layer strip: template navigation chrome (see NAV_CHROME_SELECTOR
      // note above). Done on the detached body, before anything hits the DOM.
      for (const chrome of processed.body.querySelectorAll(NAV_CHROME_SELECTOR)) chrome.remove();
      view.node.subtitle = processed.subtitle;
      view.tabSubEl.textContent = processed.subtitle ?? '';

      const inner = this.titleBlock(view.node);
      if (processed.toc.length >= 3) {
        inner.appendChild(this.tocBlock(processed.toc));
        // Single-sources the "has Contents" decision with the inline block: the
        // peek trigger (main.ts) reveals only on this attribute, so short
        // articles never sprout a dead control.
        view.tabEl.dataset.hasToc = '';
      }
      inner.appendChild(processed.body);
      view.bodyEl.replaceChildren(inner, this.attribution(view.node), this.supportLine());
      view.hydrated = true;
      view.loading = false;
      this.commit(false); // canonical title may have changed the hash
      this.events.onAnnounce(
        `Opened ${view.node.title} — card ${this.views.indexOf(view) + 1} of ${this.views.length}.`,
      );
      this.layout();
      // Real content now has its true scrollHeight — reseed the fold state, so
      // the progress underline reads correctly instead of the skeleton's ~1.
      this.markDeep(view, view.bodyEl.scrollTop);
      // Oversized-block backstop: start observing candidates now that the
      // content is connected and has real layout.
      this.scanOversized(view);
      this.focusTop();
    } catch (err) {
      view.loading = false;
      if (!this.views.includes(view)) return;
      const msg = err instanceof ApiError ? err.message : 'Something went wrong on the way down. Wikipedia may be busy.';
      view.bodyEl.replaceChildren(this.errorNote(msg, view));
      view.cardEl.dataset.state = 'error';
    }
  }

  private handleContentClick(e: MouseEvent, view: CardView): void {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || !view.bodyEl.contains(a)) return;
    const kind = classifyLink(a as HTMLAnchorElement, { lang: this.lang, title: view.node.title });
    switch (kind.kind) {
      case 'article':
        e.preventDefault();
        void this.spawn(kind.title);
        break;
      case 'redlink':
        e.preventDefault();
        this.events.onToast(`"${a.textContent?.trim() || 'That article'}" hasn't been written yet.`);
        break;
      case 'fragment': {
        e.preventDefault();
        this.scrollToHeading(view.bodyEl, kind.frag);
        break;
      }
      case 'external':
      case 'wikipedia-page':
        e.preventDefault();
        window.open(kind.href, '_blank', 'noopener');
        break;
      case 'none':
        e.preventDefault();
        break;
    }
  }

  /** Smooth-scroll a card body to a section heading and flash it. Shared by the
   *  inline Contents links (handleContentClick) and the Contents peek popover
   *  (via jumpToActiveFragment). Returns the heading, or null if not found. */
  private scrollToHeading(body: HTMLElement, frag: string): HTMLElement | null {
    const target = body.querySelector(`[id="${CSS.escape(frag)}"]`) as HTMLElement | null;
    if (!target) return null;
    const top = target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 56;
    body.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    target.classList.remove('wh-flash');
    void target.offsetWidth;
    target.classList.add('wh-flash');
    return target;
  }

  /** Jump the active card to a section, for the Contents peek (card chrome that
   *  lives in main.ts, outside the stack). Focuses the heading last, mirroring
   *  focusTop, so keyboard users land at the section they picked. */
  jumpToActiveFragment(frag: string): void {
    const view = this.views[this.views.length - 1];
    if (!view || !view.hydrated) return;
    const target = this.scrollToHeading(view.bodyEl, frag);
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }

  private layout(): void {
    const n = this.views.length;
    // The active card is on the desk; its ancestors ride above it as tab strips,
    // cascaded when the reader is at the top and collapsed behind it otherwise
    // (positionCards owns that geometry). Spawning animates the new card in.

    this.views.forEach((view, i) => {
      const isTop = i === n - 1;
      const { cardEl, tabEl, bodyEl } = view;

      // state + interactivity
      if (isTop) {
        if (cardEl.dataset.state !== 'error') {
          cardEl.dataset.state = view.loading ? 'loading' : 'active';
        }
        bodyEl.removeAttribute('inert');
        tabEl.removeAttribute('data-buried');
        tabEl.disabled = true;
        tabEl.removeAttribute('aria-label');
      } else {
        cardEl.dataset.state = 'buried';
        bodyEl.setAttribute('inert', '');
        tabEl.setAttribute('data-buried', '');
        tabEl.disabled = false;
        tabEl.setAttribute(
          'aria-label',
          `Return to ${view.node.title}${view.node.random ? ' (random jump)' : ''} — card ${i + 1} of ${n}`,
        );
      }
      const num = tabEl.querySelector('.wh-tab-num');
      if (num) num.textContent = String(i + 1);
    });

    // Hibernation: drop live article DOM beyond the last N cards (Domain G).
    const liveFrom = n - this.maxLive();
    this.views.forEach((view, i) => {
      if (i < liveFrom && view.hydrated) {
        view.savedScrollTop = view.bodyEl.scrollTop;
        view.bodyEl.replaceChildren(this.titleBlock(view.node));
        view.hydrated = false;
      }
    });

    // A new active card always starts with full chrome and a fresh scroll
    // baseline. (Simpler branch: even a deep-restored scrollTop starts unread.)
    const topBody = this.views[n - 1]?.bodyEl ?? null;
    if (topBody !== this.activeBody) {
      this.activeBody = topBody;
      this.lastScrollTop = topBody ? topBody.scrollTop : 0;
      this.accumDelta = 0;
      this.lastDir = 0;
      this.setReading(false);
      // Same reason as restoreTopScroll: the scroll path won't fire for the
      // freshly-switched body, so seed its fold state now.
      const top = this.views[n - 1];
      if (top) this.markDeep(top, top.bodyEl.scrollTop);
    }

    // Assign cascade geometry last, so it reads the settled unstacked state.
    this.positionCards();
    this.events.onPathChange(this.path);
  }

  // ---- trail cascade ----------------------------------------------------------

  /** Place the active card and its ancestor peek strips for the current path.
   *  Runs on every layout (path change); the cheap unstacked/collapsed flip that
   *  happens on scroll is setUnstacked, which only toggles the stage attribute
   *  and the strips' inertness — the strips are already positioned here. */
  private positionCards(): void {
    const n = this.views.length;
    const cap = isMobile() ? CASCADE_CAP_MOBILE : CASCADE_CAP_DESKTOP;
    const ancestors = Math.max(0, n - 1);
    const visCount = Math.min(cap, ancestors);
    const visibleStart = ancestors - visCount; // first ancestor shown as a strip
    this.stage.style.setProperty('--peek-count', String(visCount));
    this.stage.toggleAttribute('data-unstacked', this.unstacked);

    this.views.forEach((view, i) => {
      const w = view.wrapEl;
      if (i === n - 1) {
        // active card: CSS owns its width + resting/pushed-down top via
        // [data-active]; z-index keeps it above the piled strips.
        w.hidden = false;
        w.toggleAttribute('data-active', true);
        w.removeAttribute('data-peek');
        w.removeAttribute('data-more');
        w.removeAttribute('inert');
        w.style.zIndex = String(visCount + 1);
        w.style.removeProperty('--peek-y');
        w.style.removeProperty('--peek-inset');
        w.style.removeProperty('--peek-more');
        return;
      }
      w.removeAttribute('data-active');
      if (i >= visibleStart) {
        const pos = i - visibleStart; // 0 = oldest visible (top of the cascade)
        w.hidden = false;
        w.toggleAttribute('data-peek', true);
        w.toggleAttribute('inert', !this.unstacked);
        w.style.setProperty('--peek-y', String(pos));
        w.style.setProperty(
          '--peek-inset',
          `${Math.min((visCount - 1 - pos) * CASCADE_INSET_STEP, CASCADE_INSET_MAX)}px`,
        );
        w.style.zIndex = String(pos + 1);
        if (pos === 0 && visibleStart > 0) {
          // deeper trail than the cap: mark the top strip "+N earlier".
          w.toggleAttribute('data-more', true);
          w.style.setProperty('--peek-more', `"${visibleStart}"`);
        } else {
          w.removeAttribute('data-more');
          w.style.removeProperty('--peek-more');
        }
      } else {
        // older than the cap: fully hidden; the Trail dock holds these.
        w.hidden = true;
        w.removeAttribute('data-peek');
        w.removeAttribute('data-more');
        w.removeAttribute('inert');
        w.style.removeProperty('--peek-y');
        w.style.removeProperty('--peek-inset');
        w.style.removeProperty('--peek-more');
      }
    });
  }

  /** Flip the trail between unstacked (cascade) and collapsed. Cheap enough to
   *  run from the scroll path: it only toggles the stage attribute (CSS animates
   *  the strips) and the strips' inertness, so a collapsed strip leaves the tab
   *  order. positionCards has already placed each strip. */
  private setUnstacked(x: boolean): void {
    if (this.unstacked === x) return;
    this.unstacked = x;
    this.stage.toggleAttribute('data-unstacked', x);
    for (const v of this.views) {
      if (v.wrapEl.hasAttribute('data-peek')) v.wrapEl.toggleAttribute('inert', !x);
    }
  }

  // ---- reading state ----------------------------------------------------------

  private handleScroll(body: HTMLElement): void {
    if (body !== this.activeBody) return;
    const st = body.scrollTop;
    // Fold state + reading-progress: the Contents peek trigger (main.ts) reveals
    // on data-deep, and the tab's progress underline reads --wh-read. Both must
    // update on every scroll tick, so set them BEFORE the delta===0 early return
    // (a programmatic restore can re-fire this with delta 0).
    const active = this.views[this.views.length - 1];
    if (active) this.markDeep(active, st);
    const delta = st - this.lastScrollTop;
    this.lastScrollTop = st;
    if (delta === 0) return;
    const dir = delta > 0 ? 1 : -1;
    if (dir !== this.lastDir) {
      this.lastDir = dir;
      this.accumDelta = 0;
    }
    this.accumDelta += Math.abs(delta);
    if (!this.reading) {
      if (dir === 1 && st > CHROME_TOP_FOLD && this.accumDelta > CHROME_TRAVEL) this.setReading(true);
    } else if (st < CHROME_TOP_FOLD || (dir === -1 && this.accumDelta > CHROME_TRAVEL)) {
      this.setReading(false);
    }
  }

  private setReading(reading: boolean): void {
    if (this.reading === reading) return;
    this.reading = reading;
    this.events.onReadingChange?.(reading);
  }

  /** Sync a tab's fold + reading-progress affordances for a given scrollTop.
   *  data-deep gates the Contents peek trigger (>96px, the same fold reading
   *  uses); --wh-read (0..1) drives the tab's progress underline. */
  private markDeep(view: CardView, st: number): void {
    view.tabEl.toggleAttribute('data-deep', st > 96);
    const sh = view.bodyEl.scrollHeight;
    const frac = sh > 0 ? Math.min(1, (st + view.bodyEl.clientHeight) / sh) : 0;
    view.tabEl.style.setProperty('--wh-read', String(frac));
    // Trail cascade rides the same fold as the Contents peek, with a hysteresis
    // dead-band (64..112) so hovering the boundary never flickers the strips.
    // Only the active card's scroll drives it.
    if (view === this.views[this.views.length - 1]) {
      if (this.unstacked && st > CASCADE_COLLAPSE_ABOVE) this.setUnstacked(false);
      else if (!this.unstacked && st < CASCADE_UNSTACK_BELOW) this.setUnstacked(true);
    }
  }

  /** Force full chrome back — main.ts calls this when a sidebar opens or
   *  keyboard focus lands in the chrome. */
  exitReading(): void {
    this.accumDelta = 0;
    this.lastDir = 0;
    this.setReading(false);
  }

  /** Restore a card's saved scroll position without tripping the reading
   *  state: the programmatic scroll would otherwise read as a big jump. */
  private restoreTopScroll(view: CardView): void {
    view.bodyEl.scrollTop = view.savedScrollTop;
    if (view.bodyEl === this.activeBody) this.lastScrollTop = view.bodyEl.scrollTop;
    // handleScroll early-returns on delta 0, so a programmatic restore never
    // trips the scroll path — set the fold state here explicitly.
    this.markDeep(view, view.bodyEl.scrollTop);
  }

  private focusTop(): void {
    const top = this.views[this.views.length - 1];
    if (!top) return;
    const h1 = top.bodyEl.querySelector('.wh-card-title') as HTMLElement | null;
    (h1 ?? top.tabTitleEl).focus({ preventScroll: true });
  }

  private commit(push: boolean): void {
    const titles = this.titles();
    const hash =
      titles.length === 0
        ? ' '
        : '#/' + this.lang + '/' + titles.map((t) => encodeURIComponent(t.replace(/ /g, '_'))).join('/');
    const state = { lang: this.lang, trail: titles };
    const url = hash === ' ' ? location.pathname : hash;
    if (push) history.pushState(state, '', url);
    else history.replaceState(state, '', url);
  }

  // ---- oversized template clamp -------------------------------------------------

  // One observer for every candidate across all cards; targets that leave the
  // DOM (hibernation, card removal) are unobserved on their next delivery.
  private clampRO = new ResizeObserver((entries) => {
    for (const e of entries) this.evaluateClamp(e.target as HTMLElement);
  });

  /** Register every top-level prose block as a clamp candidate. observe() fires
   *  an initial delivery, so evaluateClamp sizes everything once up front and
   *  again whenever images/late content resize a block. */
  private scanOversized(view: CardView): void {
    const prose = view.bodyEl.querySelector('.wh-prose');
    if (!prose) return;
    const sel = `:scope > :is(${CLAMP_CANDIDATES}), :scope > section > :is(${CLAMP_CANDIDATES})`;
    for (let el of prose.querySelectorAll(sel) as NodeListOf<HTMLElement>) {
      const cs = getComputedStyle(el);
      // Floats (desktop infobox, thumb figures) ride beside the text and are
      // capped in width by the DS — clamping them mid-column would look broken.
      if (cs.float !== 'none') continue;
      // Multi-column blocks (the reference list) don't shrink under a height
      // cap — they reflow into more columns sideways, so a clamp hides nothing
      // and the box height stops tracking the content. Leave them full height.
      if (cs.columnCount !== 'auto' || cs.columnWidth !== 'auto') continue;
      // max-height does not apply to table boxes (CSS 2.1 §17.5.2), so a bare
      // table — in practice the mobile in-flow infobox; every other table is
      // already inside a .wh-tablewrap div — gets a neutral wrapper, and the
      // wrapper is what clamps.
      if (el.tagName === 'TABLE') {
        const wrap = document.createElement('div');
        wrap.className = 'wh-tableclamp';
        el.replaceWith(wrap);
        wrap.appendChild(el);
        el = wrap;
      }
      this.clampRO.observe(el);
    }
  }

  private evaluateClamp(el: HTMLElement): void {
    if (!el.isConnected) {
      this.clampRO.unobserve(el);
      return;
    }
    if (el.hasAttribute('data-clamp-open')) return; // reader expanded it — theirs now
    // A viewport crossing the 720px breakpoint can float the table inside a
    // mobile-era wrapper; a clamp on a float wrapper is meaningless — release it.
    if (el.classList.contains('wh-tableclamp')) {
      const t = el.firstElementChild;
      if (t && getComputedStyle(t).float !== 'none') {
        this.removeClamp(el);
        return;
      }
    }
    const clamped = el.classList.contains('wh-clamp');
    // A clamped element reports the clamp height; its natural height is scrollHeight.
    const natural = clamped ? el.scrollHeight : el.offsetHeight;
    const limit = window.innerHeight * OVERSIZE_FRACTION;
    // Hysteretic unclamp (70% of the clamp threshold): only genuinely shrunken
    // content (failed images) releases; a block hovering near the boundary, or
    // one whose clamped box under-reports (48vh < 0.6 window), never oscillates.
    if (!clamped && natural > limit) this.applyClamp(el);
    else if (clamped && natural < limit * 0.7) this.removeClamp(el);
  }

  private clampLabel(el: HTMLElement): string {
    if (el.matches('.wh-refs, .mw-references-wrap')) return 'Show all references';
    if (el.matches('ul.gallery') || el.querySelector(':scope > ul.gallery')) return 'Show full gallery';
    if (el.matches('.wh-tablewrap, .wh-tableclamp, table')) return 'Show full table';
    return 'Show more';
  }

  private applyClamp(el: HTMLElement): void {
    el.classList.add('wh-clamp');
    if (!el.id) el.id = `wh-clamp-${++clampSeq}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wh-clamp-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', el.id);
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = 'arrow-down';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = this.clampLabel(el);
    btn.append(icon, label);
    btn.addEventListener('click', () => {
      const open = el.toggleAttribute('data-clamp-open');
      btn.setAttribute('aria-expanded', String(open));
      label.textContent = open ? 'Collapse' : this.clampLabel(el);
      // Collapsing from the far end of a huge block would leave the reader
      // stranded below it; keep the control in view.
      if (!open) btn.scrollIntoView({ block: 'nearest' });
    });
    el.insertAdjacentElement('afterend', btn);
  }

  private removeClamp(el: HTMLElement): void {
    el.classList.remove('wh-clamp');
    const btn = el.nextElementSibling;
    if (btn?.classList.contains('wh-clamp-btn')) btn.remove();
  }

  // ---- little DOM factories -----------------------------------------------------

  private tocBlock(toc: TocEntry[]): HTMLElement {
    const details = document.createElement('details');
    details.className = 'wh-toc';
    const summary = document.createElement('summary');
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = 'list';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = 'Contents';
    const count = document.createElement('span');
    count.className = 'wh-toc-count';
    count.textContent = toc.length === 1 ? '1 section' : `${toc.length} sections`;
    const chev = document.createElement('span');
    chev.className = 'wh-icon wh-toc-chev';
    chev.dataset.name = 'chevron-right';
    chev.setAttribute('aria-hidden', 'true');
    summary.append(icon, label, count, chev);

    const nav = document.createElement('nav');
    nav.className = 'wh-toc-nav';
    nav.setAttribute('aria-label', 'Contents');
    const ol = document.createElement('ol');
    ol.className = 'wh-toc-list';
    for (const entry of toc) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#${entry.id}`;
      a.textContent = entry.text;
      li.appendChild(a);
      if (entry.children.length > 0) {
        const sub = document.createElement('ol');
        for (const child of entry.children) {
          const sli = document.createElement('li');
          const sa = document.createElement('a');
          sa.href = `#${child.id}`;
          sa.textContent = child.text;
          sli.appendChild(sa);
          sub.appendChild(sli);
        }
        li.appendChild(sub);
      }
      ol.appendChild(li);
    }
    nav.appendChild(ol);
    details.append(summary, nav);
    return details;
  }

  private titleBlock(node: CardNode): HTMLElement {
    const inner = document.createElement('div');
    inner.className = 'wh-card-inner';
    const h1 = document.createElement('h1');
    h1.className = 'wh-card-title';
    h1.tabIndex = -1;
    h1.style.outline = 'none';
    h1.textContent = node.title;
    inner.appendChild(h1);
    if (node.subtitle) {
      const sub = document.createElement('p');
      sub.className = 'wh-card-title-sub';
      sub.textContent = node.subtitle;
      inner.appendChild(sub);
    }
    if (this.events.onExtract) {
      const actions = document.createElement('div');
      actions.className = 'wh-card-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wh-btn';
      btn.dataset.variant = 'soft';
      btn.dataset.size = 'sm';
      const icon = document.createElement('span');
      icon.className = 'wh-icon';
      icon.dataset.name = 'sparkles';
      icon.setAttribute('aria-hidden', 'true');
      btn.append(icon, 'Extract trivia');
      btn.addEventListener('click', () => this.events.onExtract!(node));
      actions.appendChild(btn);
      inner.appendChild(actions);
      this.events.onExtractButton?.(node, btn);
    }
    return inner;
  }

  private loadingSkeleton(): HTMLElement {
    const inner = document.createElement('div');
    inner.className = 'wh-card-inner';
    inner.setAttribute('aria-hidden', 'true');
    const bar = (w: string, h = 14, mb = 12) => {
      const d = document.createElement('div');
      d.className = 'wh-skel';
      d.style.width = w;
      d.style.height = `${h}px`;
      d.style.marginBottom = `${mb}px`;
      return d;
    };
    inner.append(
      bar('46%', 30, 22),
      bar('30%', 12, 28),
      bar('100%'),
      bar('97%'),
      bar('99%'),
      bar('62%', 14, 28),
      bar('100%'),
      bar('94%'),
      bar('42%'),
    );
    return inner;
  }

  private errorNote(msg: string, view: CardView): HTMLElement {
    const d = document.createElement('div');
    d.className = 'wh-note';
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = 'rotate-ccw';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('p');
    title.className = 'wh-note-title';
    title.textContent = "That didn't load";
    const body = document.createElement('p');
    body.className = 'wh-note-body';
    body.textContent = msg;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'wh-btn';
    retry.dataset.size = 'sm';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => {
      view.cardEl.dataset.state = 'loading';
      void this.hydrate(view);
    });
    d.append(icon, title, body, retry);
    return d;
  }

  private supportLine(): HTMLElement {
    const p = document.createElement('p');
    p.className = 'wh-support';
    const a = document.createElement('a');
    a.href = 'https://buymeacoffee.com/grayforrester';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'buy me a coffee ↗';
    p.append('Enjoying the wander? ', a);
    return p;
  }

  private attribution(node: CardNode): HTMLElement {
    const f = document.createElement('footer');
    f.className = 'wh-attrib';
    const src = document.createElement('a');
    src.href = articleUrl(node.lang, node.title);
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    src.textContent = node.title;
    const lic = document.createElement('a');
    lic.href = LICENSE_URL;
    lic.target = '_blank';
    lic.rel = 'noopener noreferrer';
    lic.textContent = 'CC BY-SA 4.0';
    f.append(
      'Content from the Wikipedia article ',
      src,
      ', reformatted for this reader with some elements omitted. Text is available under ',
      lic,
      '; images are licensed individually.',
    );
    return f;
  }
}
