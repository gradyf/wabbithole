import './ds/styles.css';
import './app.css';

import { articleUrl, getRandomTitle, normTitle, searchTitles } from './api';
import { Stack, type CardNode } from './stack';
import { initTrails, type TrailNode } from './trails';
import { initTrivia } from './trivia';
import { initRace, type RaceUI } from './race';

// Trail persistence node: title plus the random-jump flag, so a restored trail
// keeps its plum markers. The flag is omitted when false to keep payloads lean
// (and older trails without it read the same as false).
function trailNode(node: CardNode): TrailNode {
  return { lang: node.lang, title: node.title, ...(node.random ? { random: true } : {}) };
}

// A trail's crawlable /t/ share URL. Caps at 12 titles (the share route's
// limit); race params add the daily-race badge to the unfurl + og image.
const SHARE_MAX = 12;
function buildShareUrl(lang: string, titles: string[], race?: { date: string; cards: number }): string {
  const segs = titles.slice(0, SHARE_MAX).map((t) => encodeURIComponent(t.replace(/ /g, '_')));
  let url = `${location.origin}/t/${lang}/${segs.join('/')}`;
  if (race) url += `?race=${race.date}&cards=${race.cards}`;
  return url;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const entry = $('entry');
const topbar = $('topbar');
const mainRow = $('main-row');
const stage = $('stage');
const depthText = $('depth-text');
const toast = $('toast');
const announcer = $('announcer');
const sidebar = $('sidebar');
const trailList = $('trail-list');
const trailCount = $('trail-count');
const aboutOverlay = $('about-overlay');
const searchInput = $<HTMLInputElement>('search-input');
const searchPop = $('search-results');

let toastTimer: number | undefined;
function showToast(msg: string): void {
  toast.textContent = msg;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 3500);
}

// ---- landing vs entry: the landing greets every fresh page load at the
// root; once you've entered the app this session (wander, sign in, or open
// a card), root shows the search entry instead. Signed-in visitors see
// "Start wandering" CTAs in place of the account ones.
const landing = $('landing');
let knownSignedIn = /(?:^|;\s*)__client_uat=(?!0(?:;|$))\d/.test(document.cookie);
const skipLanding = () => sessionStorage.getItem('wh-skip-landing') === '1';

// Assigned once the stack exists (the race reads/drives it). Referenced from
// the stack events + home-screen updates via `race?.`, all of which run after
// this is set.
let race: RaceUI | undefined;

function updateHomeScreens(): void {
  const inSession = stack.path.length > 0;
  const showLanding = !inSession && !skipLanding();
  landing.hidden = !showLanding;
  entry.hidden = inSession || showLanding;
  // Topbar greets the entry screen too (logo + Bank/Sign in/avatar); only the
  // landing keeps it hidden, since it has its own header. The session-only
  // controls (Back, depth, Trail, Share) stay gated behind data-idle until a
  // card is open — CSS in app.css hides them while idle.
  topbar.hidden = showLanding;
  topbar.toggleAttribute('data-idle', !inSession);
  // Returning to the entry screen: refresh "Your trails" so a just-saved trail
  // (or a cleared auto trail) shows. No-op signed out.
  if (!entry.hidden) trailsUI?.onEntryShown();
  // Keep today's race cards on the landing + entry current with local date and
  // any recorded result. Cheap; a no-op-ish DOM rebuild.
  race?.renderCards();
}

function updateLandingAuth(): void {
  $('landing-actions-out').hidden = knownSignedIn;
  $('landing-actions-in').hidden = !knownSignedIn;
  $('landing-cta-out').hidden = knownSignedIn;
  $('landing-cta-in').hidden = !knownSignedIn;
  $('btn-landing-wander').hidden = knownSignedIn;
  $('btn-landing-create2').hidden = knownSignedIn;
  $('btn-landing-start2').hidden = !knownSignedIn;
}

function enterApp(): void {
  sessionStorage.setItem('wh-skip-landing', '1');
  updateHomeScreens();
  if (!entry.hidden) searchInput.focus();
}

const trivia = initTrivia({
  onToast: showToast,
  announce(msg) {
    announcer.textContent = msg;
  },
  onAuthState(signedIn) {
    knownSignedIn = signedIn;
    updateLandingAuth();
    updateHomeScreens();
    trailsUI.setSignedIn(signedIn);
    // Race account sync (Task 10): signing in uploads local results and
    // fetches the server streak. Clerk loads lazily, so this always fires
    // after `race` is assigned below; anonymous visitors never get here.
    race?.setSignedIn(signedIn);
  },
});

const stack = new Stack(stage, {
  onPathChange(path: CardNode[]) {
    const n = path.length;
    // Opening a card counts as entering the app: back at root later, show
    // the search entry rather than the landing again this session.
    if (n > 0) sessionStorage.setItem('wh-skip-landing', '1');
    updateHomeScreens();
    mainRow.hidden = n === 0;
    depthText.textContent = n === 1 ? '1 card' : `${n} deep`;
    $('btn-back').hidden = n < 2;
    document.title = n > 0 ? `${path[n - 1].title} · wabbit hole` : 'Wabbit Hole · a Wikipedia wander';
    renderTrail(path);
    // Persist the current path for signed-in users (debounced; empty clears it).
    trailsUI.autosave(path.map(trailNode));
    // Race layer: win detection + live card count (races are trails too, so the
    // autosave above still runs during a race).
    race?.onPathChange(path);
  },
  onSpawn() {
    // Every genuinely new card is one point of race score.
    race?.onSpawn();
  },
  onAnnounce(msg) {
    announcer.textContent = msg;
  },
  onToast: showToast,
  onExtract(node) {
    trivia.openExtract(node);
  },
  onExtractButton(node, btn) {
    trivia.decorateExtractButton(node, btn);
  },
  onReadingChange(reading) {
    document.documentElement.toggleAttribute('data-reading', reading);
    // CSS collapses the topbar; JS pulls it out of the a11y + tab order too.
    if (reading) {
      topbar.setAttribute('inert', '');
      topbar.setAttribute('aria-hidden', 'true');
    } else {
      topbar.removeAttribute('inert');
      topbar.removeAttribute('aria-hidden');
      // One line covers every reading exit — scroll-up, reach-top, sidebar-open,
      // topbar-focus, card-switch — since all funnel through setReading(false).
      closeTocPeek();
    }
  },
  onTabExtras(node, tab) {
    // Contents peek trigger sits LEFT of the title (before the subtitle), out of
    // the crowded right-hand cluster; the ellipsizing title absorbs its width.
    tab.insertBefore(buildTocTrigger(), tab.querySelector('.wh-tab-sub'));
    tab.appendChild(buildTabCluster(node));
  },
});

// ---- trails: auto-resume + saved trails (signed-in only) -------------------
// trivia.ts owns Clerk and the authenticated api(); trails only ever calls it
// while signed in, so anonymous wandering fires no /api/trails request and
// never loads the Clerk bundle on this account.
const trailsUI = initTrails({
  api: trivia.api,
  onToast: showToast,
  announce(msg) {
    announcer.textContent = msg;
  },
  openTrail(lang, nodes) {
    sessionStorage.setItem('wh-skip-landing', '1');
    setSidebar(false);
    // Saved trails carry the random-jump flag per node; seed the stack's
    // marker memory first so applyTrail's rebuilt cards re-derive it.
    stack.markRandomTitles(
      lang,
      nodes.filter((n) => n.random).map((n) => n.title),
    );
    void stack.applyTrail(
      lang,
      nodes.map((n) => n.title),
      true,
    );
  },
  currentPath() {
    return stack.path.map(trailNode);
  },
});

// ---- daily race: engine, banner, win overlay, streaks (localStorage) --------
// The race drives the stack (starting a run opens the start article) and
// observes it (spawns count; a canonical-title arrival at the target wins).
race = initRace({
  lang: () => stack.lang,
  // Same discipline as trails: trivia.ts owns Clerk and the authenticated
  // api(); race.ts only calls it while signed in, so anonymous racing fires
  // no /api/race request and never loads the Clerk bundle.
  api: trivia.api,
  startArticle(lang, title) {
    setSidebar(false);
    void stack.startWith(lang, title);
  },
  goHome() {
    setSidebar(false);
    void stack.applyTrail(stack.lang, [], true);
  },
  currentPath() {
    return stack.path.map((node) => ({ lang: node.lang, title: node.title }));
  },
  buildShareUrl,
  onToast: showToast,
  announce(msg) {
    announcer.textContent = msg;
  },
});

// ---- slim action cluster: the reading-state controls inside the tab --------
// A right-aligned icon group appended to each card's tab, shown only while
// reading the active card. Clicks delegate to the real topbar buttons so aria
// and behavior live in one place; the topbar is inert while reading, but a
// programmatic .click() still fires those handlers.

function clusterBtn(iconName: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wh-iconbtn';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  const icon = document.createElement('span');
  icon.className = 'wh-icon';
  icon.dataset.name = iconName;
  icon.setAttribute('aria-hidden', 'true');
  btn.appendChild(icon);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function buildTabCluster(node: CardNode): HTMLElement {
  const cluster = document.createElement('div');
  cluster.className = 'wh-tab-cluster';

  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'wh-iconbtn wh-tab-home';
  home.setAttribute('aria-label', 'Home');
  home.title = 'Home';
  const mark = document.createElement('span');
  mark.className = 'wh-logo-mark';
  mark.setAttribute('aria-hidden', 'true');
  home.appendChild(mark);
  home.addEventListener('click', (e) => {
    e.stopPropagation();
    $('btn-home').click();
  });

  // Same extract path and status decoration as the in-article button.
  const extract = document.createElement('button');
  extract.type = 'button';
  extract.className = 'wh-iconbtn wh-tab-extract';
  extract.setAttribute('aria-label', 'Extract trivia');
  extract.title = 'Extract trivia';
  const spark = document.createElement('span');
  spark.className = 'wh-icon';
  spark.dataset.name = 'sparkles';
  spark.setAttribute('aria-hidden', 'true');
  extract.appendChild(spark);
  extract.addEventListener('click', (e) => {
    e.stopPropagation();
    trivia.openExtract({ lang: node.lang, title: node.title });
  });
  trivia.decorateExtractButton({ lang: node.lang, title: node.title }, extract);

  cluster.append(
    home,
    extract,
    clusterBtn('list', 'Trail', () => $('btn-trail').click()),
    clusterBtn('book-marked', 'Trivia', () => $('btn-bank').click()),
    clusterBtn('link', 'Share', () => $('btn-share').click()),
  );
  return cluster;
}

// ---- mid-read Contents peek: transient card chrome, NOT a third dock --------
// A small outline-glyph trigger inside the active card's tab opens a popover
// listing the article's sections with you-are-here highlighting and section
// jumping. It rides the card (tab + absolutely-positioned popover on .wh-cardpos),
// carries no data-collapsed, and never joins the .wh-main flex row — so the
// sidebar-close observer is blind to it and it never compresses the stage.
// Architecture invariant: DOCKS (Trail, Bank) are the only two dwell surfaces;
// intra-article navigation like this is card chrome and dies with reading state.

function buildTocTrigger(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wh-iconbtn wh-toc-trigger';
  btn.setAttribute('aria-label', 'Contents');
  btn.title = 'Contents';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'wh-toc-pop');
  const icon = document.createElement('span');
  icon.className = 'wh-icon';
  icon.dataset.name = 'list-tree';
  icon.setAttribute('aria-hidden', 'true');
  btn.appendChild(icon);
  btn.addEventListener('click', (e) => {
    // Same guard the cluster buttons use: the trigger lives inside the disabled
    // top-card tab <button>, so stop the click reaching the tab's resurface.
    e.stopPropagation();
    if (btn.getAttribute('aria-expanded') === 'true') closeTocPeek();
    else openTocPeek(btn);
  });
  return btn;
}

// A single peek is open at a time. Track its parts so close is idempotent and
// can detach the one-shot scroll listener before a jump's smooth scroll.
let tocPeek: { pop: HTMLElement; trigger: HTMLButtonElement; body: HTMLElement; onScroll: () => void } | null = null;

function openTocPeek(trigger: HTMLButtonElement): void {
  closeTocPeek(); // never stack two
  const card = trigger.closest('.wh-card');
  // Mount on .wh-cardpos (position:absolute + transform => containing block),
  // which escapes .wh-card's overflow:hidden. Moving this to .wh-card reclips.
  const mount = trigger.closest('.wh-cardpos');
  const body = card?.querySelector('.wh-card-body') as HTMLElement | null;
  const nav = body?.querySelector('.wh-toc-nav') as HTMLElement | null;
  if (!card || !mount || !body || !nav) return;

  const pop = document.createElement('div');
  pop.className = 'wh-toc-pop';
  pop.id = 'wh-toc-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Contents');

  // Light, non-interactive header: outline glyph + "Contents" + the exact
  // section-count string the inline block already rendered.
  const head = document.createElement('div');
  head.className = 'wh-toc-pop-head';
  const hIcon = document.createElement('span');
  hIcon.className = 'wh-icon';
  hIcon.dataset.name = 'list-tree';
  hIcon.setAttribute('aria-hidden', 'true');
  const hLabel = document.createElement('span');
  hLabel.className = 'wh-toc-pop-title';
  hLabel.textContent = 'Contents';
  const hCount = document.createElement('span');
  hCount.className = 'wh-toc-pop-count';
  hCount.textContent = body.querySelector('.wh-toc-count')?.textContent ?? '';
  head.append(hIcon, hLabel, hCount);

  // Clone the live nav: byte-identical markup + inherited .wh-toc-list styling,
  // no new StackEvents hook (operate on the rendered block).
  const clone = nav.cloneNode(true) as HTMLElement;

  // Scroll-spy at open (no live observer): mark the last heading at/above the
  // 56px fold reference the jump uses. Fresh every open, since the peek closes
  // on any scroll — no IntersectionObserver lifecycle to manage.
  const fold = body.getBoundingClientRect().top + 56;
  let current: HTMLAnchorElement | null = null;
  for (const a of Array.from(clone.querySelectorAll('a')) as HTMLAnchorElement[]) {
    const id = a.getAttribute('href')?.slice(1);
    if (!id) continue;
    const heading = body.querySelector(`[id="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (heading && heading.getBoundingClientRect().top <= fold) current = a;
  }
  if (current) {
    current.setAttribute('aria-current', 'location');
    current.setAttribute('data-current', '');
  }

  // Delegated jump: close first (detaches the scroll listener so the smooth
  // scroll can't re-fire it), then hand off to the shared fragment-scroll code.
  clone.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || !clone.contains(a)) return;
    e.preventDefault();
    const id = a.getAttribute('href')?.slice(1);
    closeTocPeek(true); // skip focus restore: the jump focuses the heading
    if (id) stack.jumpToActiveFragment(id);
  });

  pop.append(head, clone);
  mount.appendChild(pop);
  trigger.setAttribute('aria-expanded', 'true');

  const onScroll = () => closeTocPeek();
  body.addEventListener('scroll', onScroll, { once: true, passive: true });
  tocPeek = { pop, trigger, body, onScroll };

  // Focus the current section (or the first link), so keyboard users land at
  // "you are here". preventScroll keeps the card body still.
  const focusTarget = (clone.querySelector('[data-current]') ?? clone.querySelector('a')) as HTMLElement | null;
  focusTarget?.focus({ preventScroll: true });
}

function closeTocPeek(skipFocusRestore = false): void {
  const peek = tocPeek;
  if (!peek) return;
  tocPeek = null; // clear first so re-entrant close calls no-op
  peek.body.removeEventListener('scroll', peek.onScroll);
  // Only pull focus back to the trigger if it was inside the popover — if some
  // other control (a sidebar toggle) just took focus and drove this close, don't
  // fight it. The trigger lives in a condensing tab, so a stranded focus there
  // must land somewhere deliberate.
  const hadFocus = peek.pop.contains(document.activeElement);
  peek.pop.remove();
  peek.trigger.setAttribute('aria-expanded', 'false');
  if (!skipFocusRestore && hadFocus) peek.trigger.focus({ preventScroll: true });
}

// ---- reading state: exits owned by main.ts -----------------------------------
// Opening either sidebar, or moving keyboard focus into the topbar, restores
// full chrome. Focus inside the tab cluster deliberately does not exit.
const bankSidebar = $('bank-sidebar');
const readingExitObserver = new MutationObserver((records) => {
  for (const r of records) {
    if (!(r.target as HTMLElement).hasAttribute('data-collapsed')) {
      stack.exitReading();
      return;
    }
  }
});
readingExitObserver.observe(sidebar, { attributes: true, attributeFilter: ['data-collapsed'] });
readingExitObserver.observe(bankSidebar, { attributes: true, attributeFilter: ['data-collapsed'] });

document.addEventListener('focusin', (e) => {
  const t = e.target as HTMLElement | null;
  // Topbar only: focus inside the tab cluster must keep reading state, so the
  // slim actions stay usable by keyboard (see reading-space spec, criterion 8).
  if (t && t.closest('#topbar')) {
    stack.exitReading();
  }
});

// ---- entry: search + random ------------------------------------------------

let searchSeq = 0;
let searchTimer: number | undefined;
let resultItems: Array<{ title: string; description?: string }> = [];
let activeResult = -1;

function closeResults(): void {
  searchPop.hidden = true;
  searchPop.replaceChildren();
  searchInput.setAttribute('aria-expanded', 'false');
  resultItems = [];
  activeResult = -1;
}

function paintActive(): void {
  const options = Array.from(searchPop.querySelectorAll<HTMLElement>('.wh-result'));
  options.forEach((o, i) => {
    if (i === activeResult) o.setAttribute('data-active', '');
    else o.removeAttribute('data-active');
    o.setAttribute('aria-selected', String(i === activeResult));
    const kbd = o.querySelector('.wh-kbd');
    if (i === activeResult && !kbd) {
      const k = document.createElement('span');
      k.className = 'wh-kbd';
      k.textContent = '↵';
      o.appendChild(k);
    } else if (i !== activeResult && kbd) {
      kbd.remove();
    }
  });
}

function renderResults(items: Array<{ title: string; description?: string }>): void {
  searchPop.replaceChildren();
  resultItems = items;
  activeResult = -1;
  items.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'wh-result';
    div.setAttribute('role', 'option');
    div.setAttribute('aria-selected', 'false');
    const t = document.createElement('span');
    t.className = 'wh-result-title';
    t.textContent = item.title;
    div.appendChild(t);
    const d = document.createElement('span');
    d.className = 'wh-result-desc';
    d.textContent = item.description ?? '';
    div.appendChild(d);
    div.addEventListener('mouseenter', () => {
      activeResult = i;
      paintActive();
    });
    div.addEventListener('mousedown', (e) => e.preventDefault());
    div.addEventListener('click', () => start(item.title));
    searchPop.appendChild(div);
  });
  searchPop.hidden = items.length === 0;
  searchInput.setAttribute('aria-expanded', String(items.length > 0));
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  window.clearTimeout(searchTimer);
  if (q.length < 2) {
    closeResults();
    return;
  }
  searchTimer = window.setTimeout(async () => {
    const seq = ++searchSeq;
    const items = await searchTitles(stack.lang, q).catch(() => []);
    if (seq === searchSeq) renderResults(items);
  }, 220);
});

searchInput.addEventListener('keydown', (e) => {
  const open = !searchPop.hidden && resultItems.length > 0;
  if (e.key === 'ArrowDown' && open) {
    e.preventDefault();
    activeResult = (activeResult + 1) % resultItems.length;
    paintActive();
  } else if (e.key === 'ArrowUp' && open) {
    e.preventDefault();
    activeResult = activeResult <= 0 ? resultItems.length - 1 : activeResult - 1;
    paintActive();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open) start(resultItems[activeResult === -1 ? 0 : activeResult].title);
    else if (searchInput.value.trim()) start(searchInput.value.trim());
  } else if (e.key === 'Escape') {
    closeResults();
  }
});

document.addEventListener('click', (e) => {
  if (!searchPop.hidden && !(e.target as HTMLElement).closest('.wh-search')) closeResults();
  // Outside-click closes the Contents peek (the trigger's own click stops
  // propagation, so its toggle handler owns clicks on the trigger itself).
  if (tocPeek) {
    const t = e.target as HTMLElement;
    if (!t.closest('.wh-toc-pop') && !t.closest('.wh-toc-trigger')) closeTocPeek();
  }
});

function start(title: string, opts: { random?: boolean } = {}): void {
  closeResults();
  searchInput.value = '';
  void stack.startWith(stack.lang, normTitle(title), opts);
}

$('btn-random').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-random');
  btn.disabled = true;
  try {
    start(await getRandomTitle(stack.lang), { random: true });
  } catch {
    showToast("Couldn't find a random article. Try again.");
  } finally {
    btn.disabled = false;
  }
});

// ---- random jump: the topbar button ----------------------------------------
// Mid-session Random spawns a random article as a new card on the tip. It is a
// JUMP, not a link-click, so the stack flags the node (plum marker + shuffle
// glyph in the tab, cascade strip and Trail dock). With an empty stack the
// topbar is idle and CSS hides this button — the entry screen's own random
// button ("or fall in somewhere random") covers that case via the same flag.
$('btn-random-top').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-random-top');
  btn.disabled = true;
  try {
    const title = await getRandomTitle(stack.lang);
    if (stack.path.length === 0) start(title, { random: true });
    else await stack.spawn(title, { random: true });
  } catch {
    showToast("Couldn't find a random article. Try again.");
  } finally {
    btn.disabled = false;
  }
});

// Race gating: a random jump would corrupt a race run's click-path premise, so
// the button hides whenever the race banner is up (scored runs AND freeplay —
// both are "reach the target by links" surfaces). UI-level only: the racebar's
// hidden attribute is the signal, race.ts stays untouched.
const racebarEl = $('racebar');
const syncRandomGate = () => {
  $('btn-random-top').hidden = !racebarEl.hidden;
};
new MutationObserver(syncRandomGate).observe(racebarEl, { attributes: true, attributeFilter: ['hidden'] });
syncRandomGate();

// ---- topbar ------------------------------------------------------------------

$('btn-home').addEventListener('click', () => {
  // Home leaves the race surface (it exposes search/random), so a race exits
  // here after a confirm; freeplay and normal sessions go straight home.
  race?.attemptLeave(() => {
    setSidebar(false);
    void stack.applyTrail(stack.lang, [], true);
  });
});

$('btn-back').addEventListener('click', () => {
  if (stack.path.length > 1) stack.resurface(stack.path.length - 2, true);
});

$('btn-share').addEventListener('click', async () => {
  const n = stack.path.length;
  // A trail with >=1 card gets the crawlable /t/ share URL (the hash URL still
  // works; /t/ is the unfurlable skin). The route caps at 12 titles, so a longer
  // trail shares its first 12 — and the toast says so.
  let link = location.href;
  let suffix = n === 1 ? '1 card.' : `${n} cards.`;
  if (n >= 1) {
    link = buildShareUrl(
      stack.lang,
      stack.path.map((node) => node.title),
    );
    if (n > SHARE_MAX) suffix += ' (first 12)';
  }
  try {
    await navigator.clipboard.writeText(link);
    showToast(`Trail link copied. ${suffix}`);
  } catch {
    showToast(link);
  }
});

// ---- trail sidebar ---------------------------------------------------------------

function sidebarOpen(): boolean {
  return !sidebar.hasAttribute('data-collapsed');
}

function setSidebar(open: boolean): void {
  if (open) sidebar.removeAttribute('data-collapsed');
  else sidebar.setAttribute('data-collapsed', '');
  sidebar.setAttribute('aria-hidden', String(!open));
  $('btn-trail').setAttribute('aria-expanded', String(open));
}

function renderTrail(path: CardNode[]): void {
  trailList.replaceChildren();
  const current = path.length - 1;
  path.forEach((node, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wh-trail-item';
    btn.setAttribute('role', 'listitem');
    if (i === current) btn.setAttribute('data-current', '');
    const num = document.createElement('span');
    num.className = 'wh-trail-num';
    num.textContent = String(i + 1);
    const text = document.createElement('span');
    text.className = 'wh-trail-text';
    const t = document.createElement('span');
    t.className = 'wh-trail-title';
    t.textContent = node.title;
    text.appendChild(t);
    // Random jumps carry their marker into the dock: plum row accent + shuffle
    // glyph after the title, with sr text since the glyph alone is decorative.
    if (node.random) {
      btn.setAttribute('data-random', '');
      const flag = document.createElement('span');
      flag.className = 'wh-icon wh-trail-flag';
      flag.dataset.name = 'shuffle';
      flag.setAttribute('aria-hidden', 'true');
      flag.title = 'Random jump';
      t.appendChild(flag);
      const sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = ' (random jump)';
      t.appendChild(sr);
    }
    if (node.subtitle) {
      const s = document.createElement('span');
      s.className = 'wh-trail-sub';
      s.textContent = node.subtitle;
      text.appendChild(s);
    }
    btn.append(num, text);
    if (i !== current) {
      const chev = document.createElement('span');
      chev.className = 'wh-icon';
      chev.dataset.name = 'chevron-right';
      chev.setAttribute('aria-hidden', 'true');
      chev.style.alignSelf = 'center';
      chev.style.color = 'var(--text-faint)';
      chev.style.width = '14px';
      chev.style.height = '14px';
      btn.appendChild(chev);
    }
    btn.addEventListener('click', () => {
      if (i < current) stack.resurface(i, true);
      if (window.matchMedia('(max-width: 719px)').matches) setSidebar(false);
    });
    trailList.appendChild(btn);
  });
  trailCount.textContent = path.length === 1 ? '1 card' : `${path.length} cards`;
}

$('btn-trail').addEventListener('click', () => setSidebar(!sidebarOpen()));
$('btn-collapse-trail').addEventListener('click', () => setSidebar(false));

$('btn-export').addEventListener('click', () => {
  const path = stack.path;
  const lines = path.map((n, i) => `${i + 1}. [${n.title}](${articleUrl(n.lang, n.title)})`);
  const blob = new Blob([`# Wabbit hole trail\n\n${lines.join('\n')}\n\n> Text from Wikipedia, CC BY-SA 4.0.\n`], {
    type: 'text/markdown',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wabbit-hole-trail.md';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---- trivia entry points -----------------------------------------------------

$('btn-bank').addEventListener('click', () => trivia.openBank());
$('btn-entry-bank').addEventListener('click', () => trivia.openBank());
$('btn-settings').addEventListener('click', () => trivia.openSettings());
$('btn-signin').addEventListener('click', () => trivia.signIn());

// ---- landing page --------------------------------------------------------

$('btn-landing-login').addEventListener('click', () => trivia.signIn());
$('btn-landing-login2').addEventListener('click', () => trivia.signIn());
$('btn-landing-signup').addEventListener('click', () => trivia.signUp());
$('btn-landing-create').addEventListener('click', () => trivia.signUp());
$('btn-landing-create2').addEventListener('click', () => trivia.signUp());
$('btn-landing-wander').addEventListener('click', enterApp);
$('btn-landing-open').addEventListener('click', enterApp);
$('btn-landing-start').addEventListener('click', enterApp);
$('btn-landing-start2').addEventListener('click', enterApp);
$('btn-landing-quiz').addEventListener('click', () => trivia.openBank());

// ---- about panel ------------------------------------------------------------------

$('btn-about').addEventListener('click', () => (aboutOverlay.hidden = false));
$('btn-close-about').addEventListener('click', () => (aboutOverlay.hidden = true));
aboutOverlay.addEventListener('click', (e) => {
  if (e.target === aboutOverlay) aboutOverlay.hidden = true;
});

// ---- keyboard + history ---------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Peek closes first, ahead of the about-overlay / back fallthrough.
  if (tocPeek) closeTocPeek();
  else if (!aboutOverlay.hidden) aboutOverlay.hidden = true;
  else if (stack.path.length > 1) stack.resurface(stack.path.length - 2, true);
});

interface TrailState {
  lang?: string;
  trail?: string[];
}

function parseHash(): { lang: string; titles: string[] } | null {
  const h = location.hash.replace(/^#\/?/, '');
  if (!h) return null;
  const parts = h.split('/').filter(Boolean);
  if (parts.length < 2 || !/^[a-z][a-z0-9-]{1,11}$/.test(parts[0])) return null;
  try {
    return { lang: parts[0], titles: parts.slice(1).map((p) => normTitle(decodeURIComponent(p))) };
  } catch {
    return null;
  }
}

// `#settings` is a deep-link that opens the Settings overlay (Task 30 adds
// `#upgrade` -> Membership). It is not a trail hash, so it must never reach the
// trail parser (which would empty the stack). Handled on hashchange and, when
// arrived at via history forward, ahead of the popstate trail logic.
function maybeOpenSettingsHash(): boolean {
  if (location.hash !== '#settings') return false;
  trivia.openSettings();
  return true;
}
window.addEventListener('hashchange', () => {
  maybeOpenSettingsHash();
});

window.addEventListener('popstate', (e) => {
  if (maybeOpenSettingsHash()) return;
  const state = e.state as TrailState | null;
  if (state?.trail) {
    // In-session back/forward (states we pushed) — the race rides along:
    // trail jumps are free, and emptying the path ends the run in race.ts.
    void stack.applyTrail(state.lang ?? 'en', state.trail, false);
  } else {
    const parsed = parseHash();
    // A state-less entry carrying a trail hash is URL entry (a manual hash
    // edit, or backing into an original deep-link entry) — that is not link
    // wandering, so race mode ends here (scored runs record a miss). A hash
    // identical to the current path is a no-op navigation, not an entry:
    // forgive it (some browsers/automation fire popstate for these).
    if (parsed && parsed.titles.length > 0) {
      const current = stack.titles();
      const same =
        parsed.lang === stack.lang &&
        parsed.titles.length === current.length &&
        parsed.titles.every((t, i) => t.toLowerCase() === normTitle(current[i]).toLowerCase());
      if (!same) race?.onDeepLink();
    }
    void stack.applyTrail(parsed?.lang ?? stack.lang, parsed?.titles ?? [], false);
  }
});

// ---- boot ------------------------------------------------------------------------

setSidebar(false);
updateLandingAuth();
// Anonymous visitors get Sign in on the idle topbar without paying for the
// Clerk bundle: its click handler above lazy-loads Clerk via trivia.signIn().
// Returning signed-in users (knownSignedIn cookie heuristic) skip this so
// Sign in never flashes while Clerk boots; once Clerk loads, trivia.ts's
// onAuthChange owns the toggle and wins from then on.
if (!knownSignedIn) $('btn-signin').hidden = false;
const initial = parseHash();
// A persisted scored race resumes across reloads/crashes: race.onBoot restores
// race mode and hands back the trail to reopen. Any stale or forfeited run has
// already been recorded inside onBoot by the time it returns null.
const resumed = race?.onBoot(initial) ?? null;
if (resumed) {
  void stack.applyTrail(resumed.lang, resumed.titles, false);
} else if (initial) {
  void stack.applyTrail(initial.lang, initial.titles, false);
} else {
  // Every fresh page load at the root starts on the landing.
  sessionStorage.removeItem('wh-skip-landing');
  updateHomeScreens();
  if (!entry.hidden) searchInput.focus();
}
// A `#settings` deep-link opens the overlay on top of whatever booted above.
maybeOpenSettingsHash();
