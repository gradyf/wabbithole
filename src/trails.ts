// Trail persistence: a signed-in user's auto-resume trail plus their saved
// trails. Wandering signed out never touches this module — no /api/trails
// request fires and the Clerk bundle stays lazy, because every path here is
// gated on `signedIn`. The trivia layer owns Clerk and the authenticated
// `api()`; trails only calls it while signed in.

export interface TrailNode {
  lang: string;
  title: string;
  /** The card was opened via the Random button (plum trail marker). Omitted
   *  when false; older saved trails have no flag at all. */
  random?: boolean;
}

interface Trail {
  id: string;
  title: string;
  nodes: TrailNode[];
  isAuto: boolean;
  updatedAt: string;
}

interface TrailsDeps {
  /** Authenticated JSON fetch from the trivia layer (Bearer token). */
  api<T>(path: string, init?: RequestInit): Promise<T>;
  onToast(msg: string): void;
  announce(msg: string): void;
  /** Restore a saved trail onto the stack (main.ts owns applyTrail). Full
   *  nodes, not bare titles, so per-node flags (random) survive the restore. */
  openTrail(lang: string, nodes: TrailNode[]): void;
  /** The current linear path, for autosave and Save trail. */
  currentPath(): TrailNode[];
}

export interface TrailsUI {
  /** main.ts calls this whenever the signed-in state is (re)determined. */
  setSignedIn(signedIn: boolean): void;
  /** Debounced autosave of the current path; empty path clears the auto trail. */
  autosave(nodes: TrailNode[]): void;
  /** Refresh the entry list when the entry screen becomes visible. */
  onEntryShown(): void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const AUTOSAVE_MS = 2000;
const MAX_TITLE = 120;

export function initTrails(deps: TrailsDeps): TrailsUI {
  const section = $('entry-trails');
  const list = $('entry-trails-list');
  const saveBtn = $<HTMLButtonElement>('btn-save-trail');
  const saveForm = $<HTMLFormElement>('save-trail-form');
  const saveInput = $<HTMLInputElement>('save-trail-input');
  const saveConfirm = $<HTMLButtonElement>('btn-save-trail-confirm');
  const saveCancel = $<HTMLButtonElement>('btn-save-trail-cancel');

  let signedIn = false;
  let trails: Trail[] = [];
  let refreshSeq = 0;
  let saveTimer: number | undefined;

  // ---- "Your trails" list on the entry screen --------------------------------

  function render(): void {
    const show = signedIn && trails.length > 0;
    section.hidden = !show;
    if (!show) {
      list.replaceChildren();
      return;
    }
    const auto = trails.find((t) => t.isAuto);
    const named = trails.filter((t) => !t.isAuto);
    const frag = document.createDocumentFragment();
    if (auto) frag.appendChild(autoRow(auto));
    for (const t of named) frag.appendChild(namedRow(t));
    list.replaceChildren(frag);
  }

  function cardsLabel(n: number): string {
    return n === 1 ? '1 card' : `${n} cards`;
  }

  function openButton(trail: Trail): HTMLButtonElement {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'wh-trailcard-open';
    open.setAttribute('aria-label', `Open trail ${trail.title}`);
    open.addEventListener('click', () => {
      deps.openTrail(trail.nodes[0]?.lang ?? 'en', trail.nodes);
    });
    return open;
  }

  function autoRow(trail: Trail): HTMLElement {
    const row = document.createElement('div');
    row.className = 'wh-trailcard wh-trailcard-auto';
    const open = openButton(trail);
    const kicker = document.createElement('span');
    kicker.className = 'wh-trailcard-kicker';
    kicker.textContent = 'Pick up where you left off';
    const title = document.createElement('span');
    title.className = 'wh-trailcard-title';
    title.textContent = trail.title;
    const meta = document.createElement('span');
    meta.className = 'wh-trailcard-meta';
    meta.textContent = cardsLabel(trail.nodes.length);
    open.append(kicker, title, meta);
    row.appendChild(open);
    return row;
  }

  function namedRow(trail: Trail): HTMLElement {
    const row = document.createElement('div');
    row.className = 'wh-trailcard';
    const open = openButton(trail);
    const title = document.createElement('span');
    title.className = 'wh-trailcard-title';
    title.textContent = trail.title;
    const meta = document.createElement('span');
    meta.className = 'wh-trailcard-meta';
    meta.textContent = `${cardsLabel(trail.nodes.length)} · ${relTime(trail.updatedAt)}`;
    open.append(title, meta);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'wh-iconbtn';
    del.dataset.size = 'sm';
    del.setAttribute('aria-label', `Delete trail ${trail.title}`);
    del.title = 'Delete trail';
    const x = document.createElement('span');
    x.className = 'wh-icon';
    x.dataset.name = 'x';
    x.setAttribute('aria-hidden', 'true');
    del.appendChild(x);
    del.addEventListener('click', () => remove(trail, del));

    row.append(open, del);
    return row;
  }

  function remove(trail: Trail, btn: HTMLButtonElement): void {
    btn.disabled = true;
    void (async () => {
      try {
        await deps.api('/api/trails', {
          method: 'POST',
          body: JSON.stringify({ action: 'delete', id: trail.id }),
        });
        trails = trails.filter((t) => t.id !== trail.id);
        render();
        deps.announce('Trail removed.');
      } catch {
        deps.onToast("That didn't remove. Try again.");
        btn.disabled = false;
      }
    })();
  }

  // ---- refresh (GET) ---------------------------------------------------------

  function refresh(): void {
    if (!signedIn) return;
    const seq = ++refreshSeq;
    void (async () => {
      try {
        const data = await deps.api<{ trails: Trail[] }>('/api/trails');
        if (seq !== refreshSeq) return;
        trails = data.trails;
        render();
      } catch {
        // The entry list is a convenience; a failed load just leaves it as-is.
      }
    })();
  }

  // ---- autosave --------------------------------------------------------------

  function postAutosave(nodes: TrailNode[]): Promise<unknown> {
    return deps.api('/api/trails', {
      method: 'POST',
      body: JSON.stringify({ action: 'autosave', nodes }),
    });
  }

  function autosave(nodes: TrailNode[]): void {
    if (!signedIn) return;
    window.clearTimeout(saveTimer);
    if (nodes.length === 0) {
      // Home / empty path: clear the auto trail now (not after the debounce) so
      // the entry list drops "Pick up where you left off" immediately.
      void postAutosave([])
        .then(() => refresh())
        .catch(() => {});
      return;
    }
    saveTimer = window.setTimeout(() => {
      void postAutosave(nodes).catch(() => {});
    }, AUTOSAVE_MS);
  }

  // ---- Save trail control (trail sidebar foot) -------------------------------

  function derivedTitle(nodes: TrailNode[]): string {
    if (nodes.length === 0) return '';
    const first = nodes[0].title;
    const last = nodes[nodes.length - 1].title;
    const title = nodes.length === 1 ? first : `${first} → ${last}`;
    return title.slice(0, MAX_TITLE);
  }

  function syncSaveBtn(): void {
    // The Save control lives in the trail foot, only reachable in a session.
    // Show it while signed in and the inline name form is closed.
    saveBtn.hidden = !signedIn || !saveForm.hidden;
  }

  function openSaveForm(): void {
    const nodes = deps.currentPath();
    if (nodes.length === 0) return;
    saveInput.value = derivedTitle(nodes);
    saveForm.hidden = false;
    syncSaveBtn();
    saveInput.focus();
    saveInput.select();
  }

  function closeSaveForm(): void {
    saveForm.hidden = true;
    syncSaveBtn();
  }

  function submitSave(): void {
    const nodes = deps.currentPath();
    if (nodes.length === 0) return;
    const title = saveInput.value.trim().slice(0, MAX_TITLE);
    saveConfirm.disabled = true;
    void (async () => {
      try {
        await deps.api('/api/trails', {
          method: 'POST',
          body: JSON.stringify({ action: 'save', nodes, ...(title ? { title } : {}) }),
        });
        closeSaveForm();
        deps.onToast('Saved to your trails.');
        deps.announce('Trail saved to your trails.');
        refresh();
      } catch (err) {
        // A 409 trail_limit arrives with the server's friendly message.
        deps.onToast(err instanceof Error && err.message ? err.message : "That didn't save. Try again.");
      } finally {
        saveConfirm.disabled = false;
      }
    })();
  }

  saveBtn.addEventListener('click', openSaveForm);
  saveCancel.addEventListener('click', closeSaveForm);
  saveForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitSave();
  });
  saveInput.addEventListener('keydown', (e) => {
    // Keep Escape from bubbling to main.ts (which would resurface a card).
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeSaveForm();
    }
  });

  // ---- auth state ------------------------------------------------------------

  function setSignedIn(next: boolean): void {
    const was = signedIn;
    signedIn = next;
    if (next && !was) {
      refresh();
    } else if (!next) {
      window.clearTimeout(saveTimer);
      trails = [];
      saveForm.hidden = true;
      render();
    }
    syncSaveBtn();
  }

  return {
    setSignedIn,
    autosave,
    onEntryShown: refresh,
  };
}

// Compact relative time for the saved-trail list ("just now", "5m", "2h",
// "3d", then a short date). Sentence-case, no punctuation flourishes.
function relTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
