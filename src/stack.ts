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
}

const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => window.matchMedia('(max-width: 719px)').matches;

export class Stack {
  lang = 'en';
  private nodes = new Map<number, CardNode>();
  private nextId = 1;
  private views: CardView[] = [];
  private stage: HTMLElement;
  private events: StackEvents;

  constructor(stage: HTMLElement, events: StackEvents) {
    this.stage = stage;
    this.events = events;
    window.addEventListener('resize', () => this.layout());
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

  async startWith(lang: string, title: string): Promise<void> {
    this.lang = lang;
    this.clearViews();
    this.nodes.clear();
    this.nextId = 1;
    const node = this.makeNode(title, null);
    const view = this.appendView(node);
    this.commit(true);
    await this.hydrate(view);
  }

  async spawn(title: string): Promise<void> {
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
    top.bodyEl.scrollTop = top.savedScrollTop;
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
      top.bodyEl.scrollTop = top.savedScrollTop;
      if (!top.hydrated && !top.loading) await this.hydrate(top);
    }
  }

  relayout(): void {
    this.layout();
  }

  // ---- internals --------------------------------------------------------------

  private makeNode(title: string, parentId: number | null): CardNode {
    const node: CardNode = { id: this.nextId++, lang: this.lang, title: normTitle(title), parentId, childIds: [] };
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
        view.tabTitleEl.textContent = canonicalTitle;
      }

      const processed = processArticle(html);
      if (!this.views.includes(view)) return;
      view.node.subtitle = processed.subtitle;
      view.tabSubEl.textContent = processed.subtitle ?? '';

      const inner = this.titleBlock(view.node);
      if (processed.toc.length >= 3) inner.appendChild(this.tocBlock(processed.toc));
      inner.appendChild(processed.body);
      view.bodyEl.replaceChildren(inner, this.attribution(view.node), this.supportLine());
      view.hydrated = true;
      view.loading = false;
      this.commit(false); // canonical title may have changed the hash
      this.events.onAnnounce(
        `Opened ${view.node.title} — card ${this.views.indexOf(view) + 1} of ${this.views.length}.`,
      );
      this.layout();
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
        const body = view.bodyEl;
        const target = body.querySelector(`[id="${CSS.escape(kind.frag)}"]`) as HTMLElement | null;
        if (target) {
          const top =
            target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 56;
          body.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
          target.classList.remove('wh-flash');
          void target.offsetWidth;
          target.classList.add('wh-flash');
        }
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

  private layout(): void {
    const n = this.views.length;
    const mobile = isMobile();
    // Focus mode: only the current card is on the desk. The trail lives in
    // the Trail panel; spawning animates the new card in over the old one.

    this.views.forEach((view, i) => {
      const isTop = i === n - 1;
      const { wrapEl, cardEl, tabEl, bodyEl } = view;

      wrapEl.hidden = !isTop;
      if (isTop) {
        wrapEl.style.top = '6px';
        wrapEl.style.width = mobile ? 'calc(100% - 16px)' : 'min(var(--card-width), calc(100% - 48px))';
        wrapEl.style.zIndex = '1';
      }

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
        tabEl.setAttribute('aria-label', `Return to ${view.node.title} — card ${i + 1} of ${n}`);
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

    this.events.onPathChange(this.path);
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
