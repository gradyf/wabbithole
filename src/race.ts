// Daily Wabbit Race: a Wordle-style once-a-day link race from a curated start
// article to a target, links only. Score = cards spawned (start = 1). Win =
// the active card's canonical title equals the target. State lives in memory
// for the run; results + streaks persist to localStorage `wh-race`. No account,
// no API — signed-out players get the whole game (account sync is a later task).

import { normTitle } from './api';
import pairs from './race/pairs.json';

export interface Pair {
  start: string; // canonical en title, underscore form
  target: string;
}

const PAIRS = pairs as Pair[];
const EPOCH_UTC = Date.UTC(2026, 0, 1); // day 0 of the rotation
const STORE_KEY = 'wh-race';

// ---- pure day-key + pair selection (verifiable in isolation) ---------------

/** The player's LOCAL date as YYYY-MM-DD (Wordle-style day key). */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Whole days between 2026-01-01 and the given day key. Computed via Date.UTC
 *  on the key's own Y-M-D so it is immune to timezones and DST. */
export function dayIndex(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - EPOCH_UTC) / 86_400_000);
}

/** Pair for a day key: a plain days-since-2026-01-01 counter modulo the list
 *  length. The same date always maps to the same pair; consecutive days walk
 *  the list, so every pair is used once per full rotation. */
export function pairForKey(key: string): Pair {
  const i = ((dayIndex(key) % PAIRS.length) + PAIRS.length) % PAIRS.length;
  return PAIRS[i];
}

/** Convenience for verification: key + index + pair for a Date. */
export function pairForDate(d: Date = new Date()): { key: string; index: number; pair: Pair } {
  const key = dayKey(d);
  const idx = ((dayIndex(key) % PAIRS.length) + PAIRS.length) % PAIRS.length;
  return { key, index: idx, pair: PAIRS[idx] };
}

// ---- localStorage: results + streaks ---------------------------------------

export interface RaceRecord {
  cards: number;
  won: boolean;
  elapsedMs: number;
}
export interface RaceStore {
  byDate: Record<string, RaceRecord>;
}

function load(): RaceStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as RaceStore;
      if (o && typeof o === 'object' && o.byDate && typeof o.byDate === 'object') return o;
    }
  } catch {
    /* storage unavailable / malformed — start fresh */
  }
  return { byDate: {} };
}

function save(store: RaceStore): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* best-effort */
  }
}

/** First scored attempt of a date sticks (upsert-ignore), matching the eventual
 *  account-sync semantics. */
function recordResult(key: string, rec: RaceRecord): void {
  const store = load();
  if (store.byDate[key]) return;
  store.byDate[key] = rec;
  save(store);
}

function prevKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  // Step back one calendar day in pure UTC math so a local-tz offset (or DST)
  // can never skip or repeat a day. The key stays a plain YYYY-MM-DD string.
  const dt = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Consecutive won local dates. Winning today extends the streak; a recorded
 *  loss today breaks it (0); a not-yet-played today keeps yesterday's streak
 *  alive. A skipped day breaks the chain. */
export function computeStreak(byDate: Record<string, RaceRecord>, todayKey: string): number {
  const today = byDate[todayKey];
  let cursor: string;
  if (today?.won) cursor = todayKey;
  else if (today) return 0; // played and lost today
  else cursor = prevKey(todayKey); // not played yet — count from yesterday
  let streak = 0;
  while (byDate[cursor]?.won) {
    streak++;
    cursor = prevKey(cursor);
  }
  return streak;
}

// ---- small formatters ------------------------------------------------------

const disp = (t: string): string => t.replace(/_/g, ' ');
const cardsLabel = (n: number): string => (n === 1 ? '1 card' : `${n} cards`);
const streakLabel = (n: number): string => (n === 0 ? 'no streak yet' : n === 1 ? '1 day streak' : `${n} day streak`);
const titleEquals = (a: string, b: string): boolean => normTitle(a).toLowerCase() === normTitle(b).toLowerCase();

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

// ---- the race UI + state machine -------------------------------------------

export interface RaceDeps {
  lang(): string;
  /** Open an article as the top of a fresh stack (wraps Stack.startWith). */
  startArticle(lang: string, title: string): void;
  /** Return to the entry screen (empty stack). */
  goHome(): void;
  /** The current linear path, for the win-screen share. */
  currentPath(): Array<{ lang: string; title: string }>;
  /** Build a /t/ share URL (optionally with race params). Shared with main.ts. */
  buildShareUrl(lang: string, titles: string[], race?: { date: string; cards: number }): string;
  onToast(msg: string): void;
  announce(msg: string): void;
}

export interface RaceUI {
  /** (Re)render the landing + entry race cards for today's state. */
  renderCards(): void;
  /** Stack path changed — drives win detection + banner card count. */
  onPathChange(path: Array<{ title: string }>): void;
  /** A new card was spawned — the unit of score. */
  onSpawn(): void;
  /** Guarded navigation away from a race (Home, banner leave). Runs `proceed`
   *  once it is safe (immediately, or after the abandon confirm). */
  attemptLeave(proceed: () => void): void;
  /** A deep link / manual URL edit is taking over the stack. Ends race mode
   *  immediately — URL entry is not a link, so a scored run records a miss
   *  (otherwise editing the hash to the target would be a 1-card "win", and
   *  backing out would grant a free retry). Freeplay just ends. */
  onDeepLink(): void;
  /** True while a race or freeplay run is on the desk. */
  isActive(): boolean;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function initRace(deps: RaceDeps): RaceUI {
  type Mode = 'off' | 'racing' | 'freeplay';
  let mode: Mode = 'off';
  let run: { startedAt: number; cards: number; won: boolean } | null = null;

  const bar = $('racebar');
  const barTarget = $('racebar-target');
  const barCards = $('racebar-cards');
  const barMode = $('racebar-mode');
  const barLeave = $('racebar-leave');

  const winOverlay = $('race-win-overlay');
  const winBody = $('race-win-body');
  const winShare = $<HTMLButtonElement>('btn-race-win-share');
  const winClose = $<HTMLButtonElement>('btn-race-win-close');
  const winKeep = $<HTMLButtonElement>('btn-race-win-keep');

  const abandonOverlay = $('race-abandon-overlay');
  const abandonLeave = $<HTMLButtonElement>('btn-race-abandon-leave');
  const abandonKeep = $<HTMLButtonElement>('btn-race-abandon-keep');

  // ---- today's pair (recomputed lazily so a midnight rollover is picked up) --
  function today(): { key: string; pair: Pair } {
    const key = dayKey();
    return { key, pair: pairForKey(key) };
  }

  // ---- banner ---------------------------------------------------------------
  function showBanner(): void {
    const { pair } = today();
    barTarget.textContent = disp(pair.target);
    barMode.hidden = mode !== 'freeplay';
    barLeave.hidden = mode === 'freeplay'; // freeplay just ends when you go home
    updateBanner();
    bar.hidden = false;
  }
  function updateBanner(): void {
    barCards.textContent = cardsLabel(run?.cards ?? 0);
  }
  function hideBanner(): void {
    bar.hidden = true;
  }

  // ---- run lifecycle --------------------------------------------------------
  function start(): void {
    const { key, pair } = today();
    const scored = !load().byDate[key]; // first scored attempt of the day, else freeplay
    mode = scored ? 'racing' : 'freeplay';
    run = { startedAt: Date.now(), cards: 0, won: false };
    showBanner();
    deps.startArticle(deps.lang(), pair.start); // spawns the start card -> onSpawn -> cards = 1
    deps.announce(
      `${scored ? 'Race started' : 'Freeplay started'}: reach ${disp(pair.target)} from ${disp(pair.start)}.`,
    );
  }

  function endRun(): void {
    mode = 'off';
    run = null;
    hideBanner();
  }

  /** Non-win exit of the current run outside the confirm flow (popstate to
   *  root, manual URL edit). One scored attempt per day: a scored run records
   *  a miss; freeplay just ends. */
  function endAsMiss(msg: string): void {
    if (mode === 'racing' && run) {
      recordResult(today().key, {
        cards: run.cards,
        won: false,
        elapsedMs: Date.now() - run.startedAt,
      });
      deps.onToast(msg);
    }
    endRun();
    renderCards();
  }

  function handleWin(): void {
    if (!run) return;
    const { key, pair } = today();
    const elapsedMs = Date.now() - run.startedAt;
    const cards = run.cards;
    const scored = mode === 'racing';
    run.won = true;
    if (scored) recordResult(key, { cards, won: true, elapsedMs });
    mode = 'off';
    hideBanner();
    openWin(pair, cards, elapsedMs, scored);
    renderCards();
    deps.announce(`You reached ${disp(pair.target)} in ${cardsLabel(cards)}.`);
    run = null;
  }

  // ---- win overlay ----------------------------------------------------------
  function openWin(pair: Pair, cards: number, elapsedMs: number, scored: boolean): void {
    const streak = scored ? computeStreak(load().byDate, today().key) : 0;
    winBody.replaceChildren();

    const kicker = document.createElement('p');
    kicker.className = 'wh-race-win-kicker';
    kicker.textContent = scored ? 'today’s race' : 'freeplay';
    const route = document.createElement('p');
    route.className = 'wh-race-win-route';
    route.textContent = `${disp(pair.start)} → ${disp(pair.target)}`;
    const line = document.createElement('p');
    line.className = 'wh-race-win-line';
    line.textContent = `You fell from ${disp(pair.start)} to ${disp(pair.target)} in ${cardsLabel(cards)}.`;

    const stats = document.createElement('div');
    stats.className = 'wh-race-win-stats';
    stats.append(stat(cardsLabel(cards), 'score'), stat(fmtElapsed(elapsedMs), 'time'));
    if (scored) stats.append(stat(String(streak), 'day streak'));

    winBody.append(kicker, route, line, stats);
    if (!scored) {
      const note = document.createElement('p');
      note.className = 'wh-race-win-note';
      note.textContent = 'freeplay isn’t scored — today’s result already counted.';
      winBody.append(note);
    }

    // Win-screen share uses the real path just walked + the race badge params.
    winShare.onclick = () => {
      const path = deps.currentPath();
      const titles = path.map((n) => n.title);
      const lang = path[0]?.lang ?? deps.lang();
      const url = deps.buildShareUrl(lang, titles, { date: today().key, cards });
      const text = `Daily wabbit race ${today().key}: ${disp(pair.start)} → ${disp(pair.target)} in ${cardsLabel(cards)}\n${url}`;
      void copy(text, 'Race result copied.');
    };
    winOverlay.hidden = false;
  }
  function stat(value: string, label: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wh-race-stat';
    const v = document.createElement('span');
    v.className = 'wh-race-stat-value';
    v.textContent = value;
    const l = document.createElement('span');
    l.className = 'wh-race-stat-label';
    l.textContent = label;
    wrap.append(v, l);
    return wrap;
  }
  function closeWin(): void {
    winOverlay.hidden = true;
  }

  // ---- abandon confirm ------------------------------------------------------
  let pendingLeave: (() => void) | null = null;
  function openAbandon(proceed: () => void): void {
    pendingLeave = proceed;
    abandonOverlay.hidden = false;
  }
  function resolveAbandon(leave: boolean): void {
    abandonOverlay.hidden = true;
    const proceed = pendingLeave;
    pendingLeave = null;
    if (!leave || !proceed) return;
    if (mode === 'racing' && run) {
      recordResult(today().key, {
        cards: run.cards,
        won: false,
        elapsedMs: Date.now() - run.startedAt,
      });
    }
    endRun();
    renderCards();
    proceed();
  }

  winClose.addEventListener('click', closeWin);
  winKeep.addEventListener('click', closeWin);
  abandonLeave.addEventListener('click', () => resolveAbandon(true));
  abandonKeep.addEventListener('click', () => resolveAbandon(false));
  abandonOverlay.addEventListener('click', (e) => {
    if (e.target === abandonOverlay) resolveAbandon(false);
  });
  winOverlay.addEventListener('click', (e) => {
    if (e.target === winOverlay) closeWin();
  });
  // Own the Escape key while a race overlay is up (capture beats main.ts's
  // document handler, so it never resurfaces a card behind the scrim).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (!winOverlay.hidden) {
        e.stopPropagation();
        closeWin();
      } else if (!abandonOverlay.hidden) {
        e.stopPropagation();
        resolveAbandon(false);
      }
    },
    true,
  );

  barLeave.addEventListener('click', () => attemptLeave(deps.goHome));

  // ---- clipboard ------------------------------------------------------------
  async function copy(text: string, ok: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      deps.onToast(ok);
    } catch {
      deps.onToast(text);
    }
  }

  // ---- landing + entry race cards -------------------------------------------
  function renderCards(): void {
    renderCardInto($('landing-race'));
    renderCardInto($('entry-race'));
  }

  function renderCardInto(container: HTMLElement): void {
    const { key, pair } = today();
    const store = load();
    const rec = store.byDate[key];
    const streak = computeStreak(store.byDate, key);
    container.replaceChildren();

    const card = document.createElement('div');
    card.className = 'wh-racecard';

    const head = document.createElement('div');
    head.className = 'wh-racecard-head';
    const kicker = document.createElement('span');
    kicker.className = 'wh-racecard-kicker';
    kicker.textContent = rec ? 'today’s race · done' : 'today’s race';
    const streakChip = document.createElement('span');
    streakChip.className = 'wh-racecard-streak';
    streakChip.textContent = streakLabel(streak);
    head.append(kicker, streakChip);

    const route = document.createElement('div');
    route.className = 'wh-racecard-route';
    const s = document.createElement('span');
    s.className = 'wh-racecard-node';
    s.textContent = disp(pair.start);
    const arrow = document.createElement('span');
    arrow.className = 'wh-racecard-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    const t = document.createElement('span');
    t.className = 'wh-racecard-node wh-racecard-target';
    t.textContent = disp(pair.target);
    route.append(s, arrow, t);

    const meta = document.createElement('p');
    meta.className = 'wh-racecard-meta';
    const actions = document.createElement('div');
    actions.className = 'wh-racecard-actions';

    if (!rec) {
      meta.textContent = 'links only. every card you open counts.';
      actions.append(primaryBtn('Start race', () => start()));
    } else if (rec.won) {
      meta.textContent = `you won in ${cardsLabel(rec.cards)} · ${fmtElapsed(rec.elapsedMs)}`;
      actions.append(
        softBtn('Share', 'link', () => {
          const url = deps.buildShareUrl(deps.lang(), [pair.start, pair.target], {
            date: key,
            cards: rec.cards,
          });
          const text = `Daily wabbit race ${key}: ${disp(pair.start)} → ${disp(pair.target)} in ${cardsLabel(rec.cards)}\n${url}`;
          void copy(text, 'Race result copied.');
        }),
        ghostBtn('Play again', () => start()),
      );
    } else {
      meta.textContent = 'not this time. come back tomorrow for a new pair.';
      actions.append(ghostBtn('Play again', () => start()));
    }

    card.append(head, route, meta, actions);
    container.append(card);
  }

  function primaryBtn(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wh-btn';
    b.dataset.variant = 'solid';
    b.dataset.size = 'sm';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
  function softBtn(label: string, icon: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wh-btn';
    b.dataset.variant = 'soft';
    b.dataset.size = 'sm';
    const i = document.createElement('span');
    i.className = 'wh-icon';
    i.dataset.name = icon;
    i.setAttribute('aria-hidden', 'true');
    b.append(i, label);
    b.addEventListener('click', onClick);
    return b;
  }
  function ghostBtn(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wh-btn';
    b.dataset.variant = 'ghost';
    b.dataset.size = 'sm';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- public surface -------------------------------------------------------
  function onPathChange(path: Array<{ title: string }>): void {
    if (mode === 'off') {
      if (!bar.hidden) hideBanner();
      return;
    }
    if (path.length === 0) {
      // Stack emptied out from under a run (browser back past the start card).
      // Leaving a scored race is an abandon, however you leave.
      endAsMiss('Leaving ended today’s run.');
      return;
    }
    updateBanner();
    const tip = path[path.length - 1];
    if (run && !run.won && titleEquals(tip.title, today().pair.target)) handleWin();
  }

  function onSpawn(): void {
    if (mode === 'off' || !run) return;
    run.cards++;
    updateBanner();
  }

  function attemptLeave(proceed: () => void): void {
    if (mode === 'racing') {
      openAbandon(proceed);
    } else if (mode === 'freeplay') {
      endRun();
      renderCards();
      proceed();
    } else {
      proceed();
    }
  }

  function onDeepLink(): void {
    if (mode === 'off') return;
    endAsMiss('Entering a link ended today’s run.');
  }

  const isActive = (): boolean => mode !== 'off';

  // Debug handle for in-browser verification of the pure day-key/pair math.
  (window as unknown as { __whRace?: unknown }).__whRace = {
    dayKey,
    dayIndex,
    pairForKey,
    pairForDate,
    computeStreak,
    load,
  };

  return { renderCards, onPathChange, onSpawn, attemptLeave, onDeepLink, isActive };
}
