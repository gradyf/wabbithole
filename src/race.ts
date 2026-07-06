// Daily Wabbit Race: a Wordle-style once-a-day link race from a curated start
// article to a target, links only. Score = cards spawned (start = 1). Win =
// the active card's canonical title equals the target. Results + streaks AND
// the in-progress scored run persist to localStorage `wh-race` (a reload
// resumes the same attempt; only deliberate exits forfeit). Signed-out players
// get the whole game with zero API calls; signed in, results best-effort sync
// to the account (/api/race) so streaks follow the player across devices —
// every sync failure is silent and the local game never depends on it.

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
/** A scored run in progress, persisted so a reload or crash RESUMES the same
 *  attempt instead of dropping it (which would be a free retry) or punishing
 *  it. Day key and pair are SNAPSHOTS taken at start — a run is atomic to the
 *  day it began, even if play crosses local midnight. `trail` is the walked
 *  path (display titles), used at boot to tell a genuine reload of the race
 *  trail from deep-link URL entry. */
export interface PersistedRun {
  key: string;
  start: string;
  target: string;
  lang: string;
  cards: number;
  startedAt: number;
  trail: string[];
}
export interface RaceStore {
  byDate: Record<string, RaceRecord>;
  run?: PersistedRun;
}

function validRun(r: unknown): r is PersistedRun {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.key === 'string' &&
    typeof o.start === 'string' &&
    typeof o.target === 'string' &&
    typeof o.lang === 'string' &&
    typeof o.cards === 'number' &&
    typeof o.startedAt === 'number' &&
    Array.isArray(o.trail) &&
    o.trail.every((t) => typeof t === 'string')
  );
}

function load(): RaceStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as RaceStore;
      if (o && typeof o === 'object' && o.byDate && typeof o.byDate === 'object') {
        if (o.run !== undefined && !validRun(o.run)) delete o.run;
        return o;
      }
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

/** First scored attempt of a date sticks (upsert-ignore), matching the server's
 *  account-sync semantics. Recording a result also finishes any persisted
 *  in-progress run — every scored finish (win or miss) routes through here.
 *  Returns whether THIS record was stored (false = the date already had one),
 *  so callers only sync outcomes that actually count. */
function recordResult(key: string, rec: RaceRecord): boolean {
  const store = load();
  delete store.run;
  const fresh = !store.byDate[key];
  if (fresh) store.byDate[key] = rec;
  save(store);
  return fresh;
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
  /** Authenticated JSON fetch from the trivia layer (Bearer token). Only ever
   *  called while signed in — invoking it forces the Clerk bundle to load, so
   *  every call site gates on the signedIn flag (the trails.ts discipline). */
  api<T>(path: string, init?: RequestInit): Promise<T>;
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
  /** Boot-time run recovery, called with the parsed initial hash BEFORE the
   *  stack opens anything. If a persisted run for today exists and the load is
   *  a genuine reload of the race trail (or a fresh root visit), race mode is
   *  restored and the trail to open is returned; main.ts applies it. Returns
   *  null when there is nothing to resume (any stale or forfeited run has
   *  been recorded internally). */
  onBoot(initial: { lang: string; titles: string[] } | null): { lang: string; titles: string[] } | null;
  /** (Re)render the landing + entry race cards for today's state. */
  renderCards(): void;
  /** Stack path changed — drives win detection + banner card count. */
  onPathChange(path: Array<{ title: string }>): void;
  /** A new card was spawned — the unit of score. */
  onSpawn(): void;
  /** Guarded navigation away from a race (Home, banner leave). Runs `proceed`
   *  once it is safe (immediately, or after the abandon confirm). */
  attemptLeave(proceed: () => void): void;
  /** In-session URL entry (a state-less popstate carrying a trail hash) is
   *  taking over the stack. Ends race mode immediately — URL entry is not a
   *  link, so a scored run records a miss (otherwise navigating the hash to
   *  the target would be a cheap "win"). Freeplay just ends. */
  onDeepLink(): void;
  /** main.ts calls this whenever the signed-in state is (re)determined.
   *  Turning signed-in kicks off the best-effort account sync. */
  setSignedIn(signedIn: boolean): void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function initRace(deps: RaceDeps): RaceUI {
  type Mode = 'off' | 'racing' | 'freeplay';
  let mode: Mode = 'off';
  // key + pair are snapshots taken when the run starts: the run stays atomic
  // to its own day (win check, banner, and the recorded date all use the
  // snapshot), even when play crosses local midnight.
  let run: { key: string; pair: Pair; startedAt: number; cards: number; won: boolean } | null = null;

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

  // ---- account sync (signed-in only) ----------------------------------------
  // Anonymous play never touches /api/race and never loads Clerk: every call
  // below is gated on `signedIn`, mirroring trails.ts. All sync is best-effort
  // fire-and-forget — a failure leaves the localStorage game untouched.

  let signedIn = false;
  /** The server-computed streak from the last GET, or null when signed out /
   *  not yet fetched. Server results also fold into byDate (see syncAccount). */
  let serverStreak: number | null = null;
  let syncSeq = 0;

  interface ServerResult {
    raceDate: string;
    cards: number;
    elapsedMs: number;
    won: boolean;
  }

  function postResult(key: string, pair: Pair, rec: RaceRecord): void {
    if (!signedIn) return;
    void deps
      .api('/api/race', {
        method: 'POST',
        body: JSON.stringify({
          action: 'result',
          raceDate: key,
          startTitle: pair.start,
          targetTitle: pair.target,
          cards: rec.cards,
          elapsedMs: rec.elapsedMs,
          won: rec.won,
        }),
      })
      .catch(() => {
        /* best-effort: the local record stands; sign-in sync retries later */
      });
  }

  /** Every scored finish routes through here: persist locally, and — only when
   *  the record actually stored (first of its date) — best-effort upload it.
   *  The win/miss UX never waits on, or hears about, the network. */
  function recordAndSync(key: string, pair: Pair, rec: RaceRecord): void {
    if (recordResult(key, rec)) postResult(key, pair, rec);
  }

  /** Sign-in / boot-with-session: upload any local results the server may lack
   *  (its first-of-date upsert-ignore makes blind re-sends idempotent — no
   *  reconciliation reads), then GET and trust the server: its results fold
   *  into byDate and its streak is preferred for display. A local byDate entry
   *  stores no titles, but the pair for a date is deterministic (pairForKey),
   *  so uploads reconstruct them. */
  function syncAccount(): void {
    const seq = ++syncSeq;
    void (async () => {
      for (const [date, rec] of Object.entries(load().byDate)) {
        if (!signedIn || seq !== syncSeq) return;
        const pair = pairForKey(date);
        try {
          await deps.api('/api/race', {
            method: 'POST',
            body: JSON.stringify({
              action: 'result',
              raceDate: date,
              startTitle: pair.start,
              targetTitle: pair.target,
              cards: rec.cards,
              elapsedMs: rec.elapsedMs,
              won: rec.won,
            }),
          });
        } catch {
          /* best-effort; move on */
        }
      }
      try {
        const data = await deps.api<{ results: ServerResult[]; streak: number }>('/api/race');
        if (!signedIn || seq !== syncSeq) return;
        const store = load();
        for (const r of data.results) {
          store.byDate[r.raceDate] = { cards: r.cards, won: r.won, elapsedMs: r.elapsedMs };
        }
        save(store);
        serverStreak = data.streak;
        renderCards();
      } catch {
        /* the local view stands until the next sign-in sync */
      }
    })();
  }

  function setSignedIn(next: boolean): void {
    const was = signedIn;
    signedIn = next;
    if (next && !was) syncAccount();
    if (!next && was) {
      serverStreak = null;
      syncSeq++; // cancel any in-flight sync's writes
      renderCards();
    }
  }

  /** The streak shown on race cards + the win overlay. Signed in, the server
   *  streak is preferred (it remembers other devices and more history than the
   *  merged window) — but the server anchors at the most recent WON date
   *  because it can't know the player's local today, so its number alone can
   *  be stale. Local liveness gates it: when the locally-computed chain is
   *  broken (a lost or skipped day), the streak really is 0/dead no matter
   *  what the server remembers. */
  function displayStreak(byDate: Record<string, RaceRecord>, key: string): number {
    const local = computeStreak(byDate, key);
    if (serverStreak === null || local === 0) return local;
    return Math.max(local, serverStreak);
  }

  // ---- banner ---------------------------------------------------------------
  function showBanner(): void {
    // The banner belongs to the run, so the target comes from its snapshot.
    barTarget.textContent = disp(run?.pair.target ?? today().pair.target);
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

  /** Persist the in-progress scored run (freeplay is never persisted — it has
   *  no scoring stakes to protect across a reload). Called from start() and on
   *  every race path change; the persisted trail is what onBoot compares the
   *  initial hash against to tell a reload from URL entry. */
  function persistRun(trail?: string[]): void {
    if (mode !== 'racing' || !run) return;
    const store = load();
    store.run = {
      key: run.key,
      start: run.pair.start,
      target: run.pair.target,
      lang: deps.lang(),
      cards: run.cards,
      startedAt: run.startedAt,
      trail: trail ?? store.run?.trail ?? [],
    };
    save(store);
  }

  function start(): void {
    const { key, pair } = today();
    const scored = !load().byDate[key]; // first scored attempt of the day, else freeplay
    mode = scored ? 'racing' : 'freeplay';
    run = { key, pair, startedAt: Date.now(), cards: 0, won: false };
    persistRun([]);
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

  /** Non-win exit of the current run outside the confirm flow (browser back
   *  past the start card, in-session URL entry). One scored attempt per day:
   *  a scored run records a miss under ITS OWN day; freeplay just ends. */
  function endAsMiss(msg: string): void {
    if (mode === 'racing' && run) {
      recordAndSync(run.key, run.pair, {
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
    const { key, pair } = run; // the run's own day + pair, not today()'s
    const elapsedMs = Date.now() - run.startedAt;
    const cards = run.cards;
    const scored = mode === 'racing';
    run.won = true;
    if (scored) recordAndSync(key, pair, { cards, won: true, elapsedMs });
    mode = 'off';
    hideBanner();
    openWin(key, pair, cards, elapsedMs, scored);
    renderCards();
    deps.announce(`You reached ${disp(pair.target)} in ${cardsLabel(cards)}.`);
    run = null;
  }

  // ---- win overlay ----------------------------------------------------------
  function openWin(key: string, pair: Pair, cards: number, elapsedMs: number, scored: boolean): void {
    const streak = scored ? displayStreak(load().byDate, key) : 0;
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

    // Win-screen share uses the real path just walked + the race badge params
    // (dated with the run's own day key, not the calendar's).
    winShare.onclick = () => {
      const path = deps.currentPath();
      const titles = path.map((n) => n.title);
      const lang = path[0]?.lang ?? deps.lang();
      const url = deps.buildShareUrl(lang, titles, { date: key, cards });
      const text = `Daily wabbit race ${key}: ${disp(pair.start)} → ${disp(pair.target)} in ${cardsLabel(cards)}\n${url}`;
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
      recordAndSync(run.key, run.pair, {
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
    const streak = displayStreak(store.byDate, key);
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
  function onBoot(initial: { lang: string; titles: string[] } | null): { lang: string; titles: string[] } | null {
    const saved = load().run;
    if (!saved) return null;
    // onBoot runs before Clerk loads, so this records locally only; the
    // sign-in sync that follows a session boot uploads it.
    const finish = (): void => {
      recordAndSync(
        saved.key,
        { start: saved.start, target: saved.target },
        {
          cards: saved.cards,
          won: false,
          elapsedMs: Date.now() - saved.startedAt,
        },
      );
    };
    if (saved.key !== dayKey()) {
      // The run's day ended without a win; it consumed that day's attempt.
      // Today is untouched — a fresh race card awaits.
      finish();
      return null;
    }
    // A live run for today. A genuine reload carries exactly the trail the
    // race last committed to the hash; any other hash is deep-link URL entry,
    // which forfeits the run (same rule as in-session URL entry). A hashless
    // root visit resumes too — reopening the site mid-run returns you to your
    // race rather than quietly burning or resetting it.
    const sameTrail =
      initial !== null &&
      initial.lang === saved.lang &&
      initial.titles.length === saved.trail.length &&
      initial.titles.every((t, i) => titleEquals(t, saved.trail[i]));
    if (initial !== null && !sameTrail) {
      finish();
      deps.onToast('Entering a link ended today’s run.');
      renderCards();
      return null;
    }
    mode = 'racing';
    run = {
      key: saved.key,
      pair: { start: saved.start, target: saved.target },
      startedAt: saved.startedAt,
      cards: saved.cards,
      won: false,
    };
    showBanner();
    deps.announce(`Race resumed: reach ${disp(saved.target)}. ${cardsLabel(saved.cards)} so far.`);
    return { lang: saved.lang, titles: saved.trail.length > 0 ? saved.trail : [saved.start] };
  }

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
    persistRun(path.map((n) => n.title)); // count + walked trail survive a reload
    const tip = path[path.length - 1];
    if (run && !run.won && titleEquals(tip.title, run.pair.target)) handleWin();
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

  // Debug handle for in-browser verification of the pure day-key/pair math.
  (window as unknown as { __whRace?: unknown }).__whRace = {
    dayKey,
    dayIndex,
    pairForKey,
    pairForDate,
    computeStreak,
    load,
  };

  return { onBoot, renderCards, onPathChange, onSpawn, attemptLeave, onDeepLink, setSignedIn };
}
