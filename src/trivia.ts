// Trivia layer: Clerk accounts, per-card extraction, the bank, and quiz
// rounds. Wandering never touches this module's network calls; everything
// here is behind sign-in. Clerk loads lazily so the reading path stays light.

import type { Clerk } from '@clerk/clerk-js';

interface TriviaOpts {
  onToast(msg: string): void;
  announce(msg: string): void;
}

export interface TriviaUI {
  openExtract(node: { lang: string; title: string }): void;
  openBank(): void;
  signIn(): void;
}

interface ApiQuestion {
  id: string;
  prompt: string;
  choices: string[];
  answerIndex: number;
  explanation: string;
  imageUrl: string | null;
  imageSourceUrl: string | null;
}

interface ExtractResponse {
  article: { title: string; displayTitle: string; description?: string };
  cached: boolean;
  questions: ApiQuestion[];
}

interface BankItem {
  bankItemId: string;
  addedAt: string;
  timesAnswered: number;
  timesCorrect: number;
  questionId: string;
  prompt: string;
  choices: string[];
  answerIndex: number;
  explanation: string;
  imageUrl: string | null;
  imageSourceUrl: string | null;
  articleLang: string;
  articleTitle: string;
}

class TriviaError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function initTrivia(opts: TriviaOpts): TriviaUI {
  // ---- Clerk (lazy) --------------------------------------------------------

  let clerk: Clerk | null = null;
  let clerkLoad: Promise<Clerk | null> | null = null;
  let userButtonMounted = false;

  // The action interrupted by sign-in, persisted so it survives both the
  // modal flow and any full-page navigation Clerk performs on completion.
  type PendingAction = { type: 'bank' } | { type: 'extract'; lang: string; title: string };
  const PENDING_KEY = 'wh-after-auth';

  function queuePending(action: PendingAction): void {
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(action));
    } catch {
      // storage unavailable: sign-in still works, continuation is lost
    }
  }

  function runPending(): void {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(PENDING_KEY);
      if (raw) sessionStorage.removeItem(PENDING_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const action = JSON.parse(raw) as PendingAction;
      if (action.type === 'bank') openBank();
      else if (action.type === 'extract') openExtract({ lang: action.lang, title: action.title });
    } catch {
      // malformed leftover; drop it
    }
  }

  function loadClerk(): Promise<Clerk | null> {
    clerkLoad ??= (async () => {
      const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
      if (!key) {
        console.warn('[trivia] VITE_CLERK_PUBLISHABLE_KEY missing; accounts disabled');
        return null;
      }
      try {
        // clerk-js v6 ships its prebuilt components (sign-in modal, user
        // button) in the separate @clerk/ui bundle; load them together.
        const [mod, uiMod] = await Promise.all([
          import('@clerk/clerk-js'),
          import('@clerk/ui/entry'),
        ]);
        const c = new mod.Clerk(key);
        await c.load({ ui: { ClerkUI: uiMod.ClerkUI } });
        clerk = c;
        c.addListener(() => onAuthChange());
        onAuthChange();
        return c;
      } catch (err) {
        console.error('[trivia] Clerk failed to load', err);
        return null;
      }
    })();
    return clerkLoad;
  }

  function onAuthChange(): void {
    const signedIn = !!clerk?.user;
    console.debug('[trivia] auth change', { signedIn, status: clerk?.status, hasSession: !!clerk?.session });
    $('btn-signin').hidden = signedIn || !clerk;
    $('btn-bank').hidden = !signedIn;
    const userBtn = $('user-button');
    userBtn.hidden = !signedIn;
    if (signedIn && clerk && !userButtonMounted) {
      try {
        clerk.mountUserButton(userBtn as HTMLDivElement, {});
        userButtonMounted = true;
      } catch (err) {
        console.error('[trivia] user button failed to mount', err);
      }
    }
    if (signedIn) runPending();
  }

  /** True if signed in; otherwise opens the sign-in modal and queues `after`. */
  async function requireAuth(after?: PendingAction): Promise<boolean> {
    const c = await loadClerk();
    if (!c) {
      opts.onToast('Accounts are unavailable right now. Wandering still works.');
      return false;
    }
    if (c.user) return true;
    if (after) queuePending(after);
    void c.openSignIn({});
    watchForSession();
    return false;
  }

  // clerk-js 6.23 + @clerk/ui 1.24: the modal completes sign-in and sets the
  // session cookies but does not sync the host Clerk instance, so no listener
  // emission carries the new user. Watch the __client_uat cookie; if it flips
  // while the instance is still stale, reload — boot picks up the session and
  // the persisted pending action resumes the interrupted flow.
  let sessionWatch: number | undefined;
  function uatValue(): string {
    return document.cookie.match(/(?:^|;\s*)__client_uat=(\d+)/)?.[1] ?? '0';
  }
  function watchForSession(): void {
    if (sessionWatch !== undefined) return;
    const initial = uatValue();
    const startedAt = Date.now();
    sessionWatch = window.setInterval(() => {
      const now = uatValue();
      if (now !== '0' && now !== initial) {
        window.clearInterval(sessionWatch);
        sessionWatch = undefined;
        if (!clerk?.user) location.reload();
      } else if (Date.now() - startedAt > 5 * 60_000) {
        window.clearInterval(sessionWatch);
        sessionWatch = undefined;
      }
    }, 800);
  }

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const c = await loadClerk();
    const token = await c?.session?.getToken();
    if (!token) throw new TriviaError('signed_out', 'Sign in to use trivia.');
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) {
      throw new TriviaError(data.error ?? 'http', data.message ?? `That didn't work (${res.status}).`);
    }
    return data as T;
  }

  // ---- overlays (shared plumbing) -------------------------------------------

  const extractOverlay = $('extract-overlay');
  const bankOverlay = $('bank-overlay');
  const quizOverlay = $('quiz-overlay');

  function openOverlay(el: HTMLElement): void {
    el.hidden = false;
  }
  function closeOverlay(el: HTMLElement): void {
    el.hidden = true;
    if (el === quizOverlay) flushQuizResults();
  }

  for (const el of [extractOverlay, bankOverlay, quizOverlay]) {
    el.addEventListener('click', (e) => {
      if (e.target === el) closeOverlay(el);
    });
  }
  $('btn-close-extract').addEventListener('click', () => closeOverlay(extractOverlay));
  $('btn-close-bank').addEventListener('click', () => closeOverlay(bankOverlay));
  $('btn-close-quiz').addEventListener('click', () => closeOverlay(quizOverlay));

  // Close the topmost trivia overlay on Escape before main.ts's handler can
  // resurface a card (capture phase runs first; stopPropagation ends it).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      const open = [quizOverlay, extractOverlay, bankOverlay].find((el) => !el.hidden);
      if (open) {
        e.stopPropagation();
        closeOverlay(open);
      }
    },
    true,
  );

  // ---- extract panel ---------------------------------------------------------

  const extractBody = $('extract-body');
  const extractFoot = $('extract-foot');
  const extractTitle = $('extract-title');
  const addBtn = $<HTMLButtonElement>('btn-add-bank');

  function openExtract(node: { lang: string; title: string }): void {
    void (async () => {
      if (!(await requireAuth({ type: 'extract', lang: node.lang, title: node.title }))) return;
      extractTitle.textContent = 'Extract trivia';
      extractFoot.hidden = true;
      extractBody.replaceChildren(skeleton());
      openOverlay(extractOverlay);
      try {
        const data = await apiFetch<ExtractResponse>('/api/extract', {
          method: 'POST',
          body: JSON.stringify({ lang: node.lang, title: node.title }),
        });
        renderExtract(data);
      } catch (err) {
        renderExtractError(err, node);
      }
    })();
  }

  function renderExtract(data: ExtractResponse): void {
    extractTitle.textContent = data.article.displayTitle;

    const intro = document.createElement('p');
    intro.className = 'wh-trivia-intro';
    intro.textContent =
      data.questions.length === 1
        ? '1 question from this article. Keep the ones worth remembering.'
        : `${data.questions.length} questions from this article. Keep the ones worth remembering.`;

    const list = document.createElement('div');
    list.className = 'wh-picks';
    for (const q of data.questions) {
      const label = document.createElement('label');
      label.className = 'wh-pick';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = true;
      input.value = q.id;
      input.addEventListener('change', updateAddButton);
      const box = document.createElement('span');
      box.className = 'wh-pick-box';
      const check = document.createElement('span');
      check.className = 'wh-icon';
      check.dataset.name = 'circle-check';
      check.setAttribute('aria-hidden', 'true');
      box.appendChild(check);
      const text = document.createElement('span');
      text.className = 'wh-pick-text';
      const prompt = document.createElement('span');
      prompt.className = 'wh-pick-q';
      prompt.textContent = q.prompt;
      const answer = document.createElement('span');
      answer.className = 'wh-pick-a';
      answer.textContent = q.choices[q.answerIndex];
      text.append(prompt, answer);
      label.append(input, box, text);
      list.appendChild(label);
    }

    extractBody.replaceChildren(intro, list);
    extractFoot.hidden = false;
    updateAddButton();
  }

  function selectedIds(): string[] {
    return Array.from(
      extractBody.querySelectorAll<HTMLInputElement>('.wh-pick input:checked'),
      (i) => i.value,
    );
  }

  function updateAddButton(): void {
    const n = selectedIds().length;
    addBtn.disabled = n === 0;
    addBtn.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = 'sparkles';
    icon.setAttribute('aria-hidden', 'true');
    addBtn.append(icon, n === 0 ? 'Add to bank' : n === 1 ? 'Add 1 to bank' : `Add ${n} to bank`);
  }

  addBtn.addEventListener('click', () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    addBtn.disabled = true;
    void (async () => {
      try {
        const res = await apiFetch<{ added: number }>('/api/bank', {
          method: 'POST',
          body: JSON.stringify({ action: 'add', questionIds: ids }),
        });
        const kept = res.added;
        const msg =
          kept === 0
            ? 'Already in your bank.'
            : kept === 1
              ? 'Added 1 question to your bank.'
              : `Added ${kept} questions to your bank.`;
        opts.onToast(msg);
        opts.announce(msg);
        closeOverlay(extractOverlay);
      } catch (err) {
        opts.onToast(err instanceof TriviaError ? err.message : "That didn't save. Try again.");
        addBtn.disabled = false;
      }
    })();
  });

  function renderExtractError(err: unknown, node: { lang: string; title: string }): void {
    const e = err instanceof TriviaError ? err : new TriviaError('unknown', 'Something went wrong.');
    const note = document.createElement('div');
    note.className = 'wh-note';
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = e.code === 'extraction_in_progress' ? 'sparkles' : 'rotate-ccw';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('p');
    title.className = 'wh-note-title';
    title.textContent =
      e.code === 'daily_cap'
        ? "That's plenty for today"
        : e.code === 'extraction_in_progress'
          ? 'Almost there'
          : "That didn't work";
    const body = document.createElement('p');
    body.className = 'wh-note-body';
    body.textContent = e.message;
    note.append(icon, title, body);
    if (e.code !== 'daily_cap') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'wh-btn';
      retry.dataset.size = 'sm';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => openExtract(node));
      note.appendChild(retry);
    }
    extractBody.replaceChildren(note);
    extractFoot.hidden = true;
  }

  // ---- bank ---------------------------------------------------------------------

  const bankBody = $('bank-body');
  const bankCount = $('bank-count');
  const quizBtn = $<HTMLButtonElement>('btn-quiz');
  let bank: BankItem[] = [];

  function openBank(): void {
    void (async () => {
      if (!(await requireAuth({ type: 'bank' }))) return;
      bankBody.replaceChildren(skeleton());
      quizBtn.disabled = true;
      bankCount.textContent = '';
      openOverlay(bankOverlay);
      try {
        const data = await apiFetch<{ items: BankItem[] }>('/api/bank');
        bank = data.items;
        renderBank();
      } catch (err) {
        const note = document.createElement('p');
        note.className = 'wh-trivia-intro';
        note.textContent = err instanceof TriviaError ? err.message : "The bank didn't load. Try again.";
        bankBody.replaceChildren(note);
      }
    })();
  }

  function renderBank(): void {
    if (bank.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wh-note';
      const icon = document.createElement('span');
      icon.className = 'wh-icon';
      icon.dataset.name = 'sparkles';
      icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('p');
      title.className = 'wh-note-title';
      title.textContent = 'Nothing here yet';
      const body = document.createElement('p');
      body.className = 'wh-note-body';
      body.textContent = 'Open any card and press Extract trivia to start your bank.';
      empty.append(icon, title, body);
      bankBody.replaceChildren(empty);
      quizBtn.disabled = true;
      bankCount.textContent = '';
      return;
    }

    const groups = new Map<string, BankItem[]>();
    for (const item of bank) {
      const key = `${item.articleLang}:${item.articleTitle}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(item);
    }

    const frag = document.createDocumentFragment();
    for (const [, items] of groups) {
      const head = document.createElement('h3');
      head.className = 'wh-bank-article';
      head.textContent = items[0].articleTitle.replace(/_/g, ' ');
      frag.appendChild(head);
      for (const item of items) {
        frag.appendChild(bankRow(item));
      }
    }
    bankBody.replaceChildren(frag);
    quizBtn.disabled = false;
    bankCount.textContent = bank.length === 1 ? '1 question' : `${bank.length} questions`;
  }

  function bankRow(item: BankItem): HTMLElement {
    const row = document.createElement('div');
    row.className = 'wh-bank-item';
    const text = document.createElement('span');
    text.className = 'wh-bank-q';
    text.textContent = item.prompt;
    row.appendChild(text);
    if (item.timesAnswered > 0) {
      const stats = document.createElement('span');
      stats.className = 'wh-bank-stats';
      stats.textContent = `${item.timesCorrect}/${item.timesAnswered}`;
      stats.title = `Answered right ${item.timesCorrect} of ${item.timesAnswered} times`;
      row.appendChild(stats);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'wh-iconbtn';
    remove.dataset.size = 'sm';
    remove.setAttribute('aria-label', 'Remove from bank');
    remove.title = 'Remove from bank';
    const x = document.createElement('span');
    x.className = 'wh-icon';
    x.dataset.name = 'x';
    x.setAttribute('aria-hidden', 'true');
    remove.appendChild(x);
    remove.addEventListener('click', () => {
      remove.disabled = true;
      void (async () => {
        try {
          await apiFetch('/api/bank', {
            method: 'POST',
            body: JSON.stringify({ action: 'remove', bankItemIds: [item.bankItemId] }),
          });
          bank = bank.filter((b) => b.bankItemId !== item.bankItemId);
          renderBank();
        } catch {
          opts.onToast("That didn't remove. Try again.");
          remove.disabled = false;
        }
      })();
    });
    row.appendChild(remove);
    return row;
  }

  // ---- quiz ---------------------------------------------------------------------

  const quizBody = $('quiz-body');
  const quizProgress = $('quiz-progress');
  const QUIZ_SIZE = 10;
  let quizItems: BankItem[] = [];
  let quizIndex = 0;
  let quizCorrect = 0;
  let quizResults: Array<{ bankItemId: string; correct: boolean }> = [];

  quizBtn.addEventListener('click', () => {
    if (bank.length === 0) return;
    closeOverlay(bankOverlay);
    startQuiz();
  });

  function startQuiz(): void {
    quizItems = shuffle([...bank]).slice(0, QUIZ_SIZE);
    quizIndex = 0;
    quizCorrect = 0;
    quizResults = [];
    openOverlay(quizOverlay);
    renderQuizQuestion();
  }

  function renderQuizQuestion(): void {
    const item = quizItems[quizIndex];
    quizProgress.textContent = `${quizIndex + 1} of ${quizItems.length}`;

    const prompt = document.createElement('p');
    prompt.className = 'wh-quiz-q';
    prompt.textContent = item.prompt;

    const choices = document.createElement('div');
    choices.className = 'wh-quiz-choices';
    item.choices.forEach((choice, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wh-quiz-choice';
      btn.textContent = choice;
      btn.addEventListener('click', () => answerQuiz(item, i, choices));
      choices.appendChild(btn);
    });

    const from = document.createElement('p');
    from.className = 'wh-quiz-from';
    const a = document.createElement('a');
    a.href = `https://${item.articleLang}.wikipedia.org/wiki/${encodeURIComponent(item.articleTitle)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = item.articleTitle.replace(/_/g, ' ');
    from.append('From the Wikipedia article ', a);

    quizBody.replaceChildren(prompt, choices, from);
  }

  function answerQuiz(item: BankItem, picked: number, choicesEl: HTMLElement): void {
    const correct = picked === item.answerIndex;
    if (correct) quizCorrect++;
    quizResults.push({ bankItemId: item.bankItemId, correct });

    const buttons = Array.from(choicesEl.querySelectorAll<HTMLButtonElement>('.wh-quiz-choice'));
    buttons.forEach((b, i) => {
      b.disabled = true;
      if (i === item.answerIndex) b.dataset.result = 'correct';
      else if (i === picked) b.dataset.result = 'wrong';
    });

    const feedback = document.createElement('p');
    feedback.className = 'wh-quiz-feedback';
    feedback.dataset.tone = correct ? 'correct' : 'wrong';
    feedback.textContent = correct ? 'Right. ' + item.explanation : 'Not quite. ' + item.explanation;

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'wh-btn';
    next.textContent = quizIndex + 1 < quizItems.length ? 'Next question' : 'See your score';
    next.addEventListener('click', () => {
      quizIndex++;
      if (quizIndex < quizItems.length) renderQuizQuestion();
      else renderQuizEnd();
    });

    const actions = document.createElement('div');
    actions.className = 'wh-quiz-actions';
    actions.appendChild(next);
    quizBody.append(feedback, actions);
    next.focus();
    opts.announce(feedback.textContent);
  }

  function renderQuizEnd(): void {
    quizProgress.textContent = '';
    flushQuizResults();

    const score = document.createElement('p');
    score.className = 'wh-quiz-score';
    score.textContent = `${quizCorrect} of ${quizItems.length}`;
    const word = document.createElement('p');
    word.className = 'wh-quiz-word';
    word.textContent =
      quizCorrect === quizItems.length
        ? 'A clean sweep.'
        : quizCorrect >= quizItems.length * 0.7
          ? 'The wandering is sticking.'
          : 'Worth another pass down the hole.';

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'wh-btn';
    again.dataset.variant = 'soft';
    again.textContent = 'Quiz me again';
    again.addEventListener('click', startQuiz);
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'wh-btn';
    done.textContent = 'Done';
    done.addEventListener('click', () => closeOverlay(quizOverlay));

    const actions = document.createElement('div');
    actions.className = 'wh-quiz-actions';
    actions.append(again, done);
    quizBody.replaceChildren(score, word, actions);
    opts.announce(`Quiz finished. ${quizCorrect} of ${quizItems.length} right.`);
  }

  function flushQuizResults(): void {
    if (quizResults.length === 0) return;
    const results = quizResults;
    quizResults = [];
    void apiFetch('/api/quiz-results', {
      method: 'POST',
      body: JSON.stringify({ results }),
    }).catch(() => {
      // Stats are a courtesy; a failed flush shouldn't interrupt anything.
    });
  }

  // ---- shared bits -----------------------------------------------------------

  function skeleton(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.setAttribute('aria-hidden', 'true');
    for (const w of ['86%', '70%', '92%', '64%', '78%']) {
      const bar = document.createElement('div');
      bar.className = 'wh-skel';
      bar.style.width = w;
      bar.style.height = '14px';
      bar.style.marginBottom = '14px';
      wrap.appendChild(bar);
    }
    return wrap;
  }

  function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Load Clerk at boot only for returning users (its __client_uat cookie is
  // nonzero when a session exists), so anonymous wandering never downloads
  // the auth bundle. Everyone else gets it on their first trivia action.
  if (/(?:^|;\s*)__client_uat=(?!0(?:;|$))\d/.test(document.cookie)) void loadClerk();

  return {
    openExtract,
    openBank,
    signIn: () => {
      void requireAuth();
    },
  };
}
