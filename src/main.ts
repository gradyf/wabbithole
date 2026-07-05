import './ds/styles.css';
import './app.css';

import { articleUrl, getRandomTitle, normTitle, searchTitles } from './api';
import { Stack, type CardNode } from './stack';
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

const trivia = initTrivia({
  onToast: showToast,
  announce(msg) {
    announcer.textContent = msg;
  },
});

const stack = new Stack(stage, {
  onPathChange(path: CardNode[]) {
    const n = path.length;
    entry.hidden = n > 0;
    topbar.hidden = n === 0;
    mainRow.hidden = n === 0;
    depthText.textContent = n === 1 ? '1 card' : `${n} deep`;
    $('btn-back').hidden = n < 2;
    document.title = n > 0 ? `${path[n - 1].title} · wabbit hole` : 'Wabbit Hole · a Wikipedia wander';
    renderTrail(path);
  },
  onAnnounce(msg) {
    announcer.textContent = msg;
  },
  onToast: showToast,
  onExtract(node) {
    trivia.openExtract(node);
  },
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
  const suffix = n === 1 ? '1 card.' : `${n} cards.`;
  try {
    await navigator.clipboard.writeText(location.href);
    showToast(`Trail link copied. ${suffix}`);
  } catch {
    showToast(location.href);
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
const initial = parseHash();
if (initial) {
  void stack.applyTrail(initial.lang, initial.titles, false);
} else {
  searchInput.focus();
}
