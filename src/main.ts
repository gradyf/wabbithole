import './ds/styles.css';
import './app.css';

import { articleUrl, getRandomTitle, normTitle, searchTitles } from './api';
import { Stack, type CardNode } from './stack';
import { initTrails } from './trails';
import { initTrivia } from './trivia';

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
    trailsUI.autosave(path.map((node) => ({ lang: node.lang, title: node.title })));
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
    }
  },
  onTabExtras(node, tab) {
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
  openTrail(lang, titles) {
    sessionStorage.setItem('wh-skip-landing', '1');
    setSidebar(false);
    void stack.applyTrail(lang, titles, true);
  },
  currentPath() {
    return stack.path.map((node) => ({ lang: node.lang, title: node.title }));
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
    clusterBtn('book-marked', 'Bank', () => $('btn-bank').click()),
    clusterBtn('link', 'Share', () => $('btn-share').click()),
  );
  return cluster;
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
});

function start(title: string): void {
  closeResults();
  searchInput.value = '';
  void stack.startWith(stack.lang, normTitle(title));
}

$('btn-random').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-random');
  btn.disabled = true;
  try {
    start(await getRandomTitle(stack.lang));
  } catch {
    showToast("Couldn't find a random article. Try again.");
  } finally {
    btn.disabled = false;
  }
});

// ---- topbar ------------------------------------------------------------------

$('btn-home').addEventListener('click', () => {
  setSidebar(false);
  void stack.applyTrail(stack.lang, [], true);
});

$('btn-back').addEventListener('click', () => {
  if (stack.path.length > 1) stack.resurface(stack.path.length - 2, true);
});

$('btn-share').addEventListener('click', async () => {
  const n = stack.path.length;
  // A trail with >=1 card gets the crawlable /t/ share URL (the hash URL still
  // works; /t/ is the unfurlable skin). The route caps at 12 titles, so a longer
  // trail shares its first 12 — and the toast says so.
  const SHARE_MAX = 12;
  let link = location.href;
  let suffix = n === 1 ? '1 card.' : `${n} cards.`;
  if (n >= 1) {
    const titles = stack.path
      .slice(0, SHARE_MAX)
      .map((node) => encodeURIComponent(node.title.replace(/ /g, '_')));
    link = `${location.origin}/t/${stack.lang}/${titles.join('/')}`;
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
  if (!aboutOverlay.hidden) aboutOverlay.hidden = true;
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

window.addEventListener('popstate', (e) => {
  const state = e.state as TrailState | null;
  if (state?.trail) {
    void stack.applyTrail(state.lang ?? 'en', state.trail, false);
  } else {
    const parsed = parseHash();
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
if (initial) {
  void stack.applyTrail(initial.lang, initial.titles, false);
} else {
  // Every fresh page load at the root starts on the landing.
  sessionStorage.removeItem('wh-skip-landing');
  updateHomeScreens();
  if (!entry.hidden) searchInput.focus();
}
