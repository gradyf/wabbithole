// Trivia layer: Clerk accounts, per-card extraction, the bank, and quiz
// rounds. Wandering never touches this module's network calls; everything
// here is behind sign-in. Clerk loads lazily so the reading path stays light.

import type { Clerk } from '@clerk/clerk-js';

interface TriviaOpts {
  onToast(msg: string): void;
  announce(msg: string): void;
  /** Fired whenever the signed-in state is (re)determined. */
  onAuthState?(signedIn: boolean): void;
}

export interface TriviaUI {
  openExtract(node: { lang: string; title: string }): void;
  openBank(): void;
  /** Open the settings overlay; when true, scroll to the Membership section
   *  (the `#upgrade` deep-link target). */
  openSettings(scrollToMembership?: boolean): void;
  signIn(): void;
  signUp(): void;
  /** Decorate a card's extract button with cache/bank state (signed-in only). */
  decorateExtractButton(node: { lang: string; title: string }, btn: HTMLButtonElement): void;
  /** The active card changed (stack onActiveBody): scopes the highlight-to-
   *  question selection pill. Pass (null, null) when no card is active. */
  onActiveCard(node: { lang: string; title: string } | null, bodyEl: HTMLElement | null): void;
  /** Authenticated JSON fetch (Bearer token, throws on error). Callers MUST
   *  gate on signed-in state — invoking this forces the Clerk bundle to load. */
  api<T>(path: string, init?: RequestInit): Promise<T>;
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
  // null for owner accounts, which have no weekly cap.
  weeklyRemaining: number | null;
  weeklyCap: number;
  // Full curated MC pool size before the per-tier slice (additive, read-only).
  // Drives the free-tier "N more questions with premium" nudge.
  mcTotal: number;
  questions: ApiQuestion[];
}

// GET /api/billing — the caller's membership. tier is fail-closed to free on
// any server-side error; dates are present only for a live premium subscription.
interface BillingStatus {
  tier: 'free' | 'premium' | 'owner';
  status: 'none' | 'active' | 'canceled';
  renewsAt: string | null;
  endsAt: string | null;
  planSlug: string | null;
}

// POST /api/ask — one question generated from a reader's highlight. cached=true
// means it came from the communal pool (near-instant, no spend).
interface AskResponse {
  cached: boolean;
  question: {
    id: string;
    prompt: string;
    choices: string[];
    answerIndex: number;
    explanation: string;
  };
}

interface ArticleStatus {
  hasQuestions: boolean;
  inBank: number;
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

interface QuizSession {
  playedAt: string;
  questionCount: number;
  correctCount: number;
}

// The server-persisted preferences blob (api/settings.ts). quizFocuses lists
// the optional trivia lenses this user allows; ['flags'] = flag-image questions
// are shown and quizzed, absent/empty = off (opt-in default).
interface UserPreferences {
  quizFocuses?: string[];
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
  type PendingAction =
    | { type: 'bank' }
    | { type: 'extract'; lang: string; title: string }
    // Highlight -> question, interrupted by sign-in. Carries only serializable
    // text: the normalized selection plus the article's lang/title.
    | { type: 'ask'; lang: string; title: string; text: string };
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
      else if (action.type === 'ask')
        openAsk({ lang: action.lang, title: action.title, selectedText: action.text });
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
    $('btn-settings').hidden = !signedIn;
    if (!signedIn) {
      setBankSidebar(false);
      closeOverlay(settingsOverlay);
      settingsCache = null;
      settingsLoad = null;
      billingCache = null;
      billingLoad = null;
    } else {
      // Warm the preferences so the first quiz draw reflects the flags toggle
      // without waiting on a round trip; warm the tier so nudges/panel decisions
      // have it ready.
      void ensureSettings();
      void ensureBilling();
    }
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
    opts.onAuthState?.(signedIn);
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
  const quizOverlay = $('quiz-overlay');
  const settingsOverlay = $('settings-overlay');

  function openOverlay(el: HTMLElement): void {
    el.hidden = false;
  }
  function closeOverlay(el: HTMLElement): void {
    el.hidden = true;
    if (el === quizOverlay) {
      detachQuizKeys();
      flushQuizResults();
    }
  }

  for (const el of [extractOverlay, quizOverlay, settingsOverlay]) {
    el.addEventListener('click', (e) => {
      if (e.target === el) closeOverlay(el);
    });
  }
  $('btn-close-extract').addEventListener('click', () => closeOverlay(extractOverlay));
  $('btn-close-quiz').addEventListener('click', () => closeOverlay(quizOverlay));
  $('btn-close-settings').addEventListener('click', () => closeOverlay(settingsOverlay));

  // Close the topmost trivia overlay on Escape before main.ts's handler can
  // resurface a card (capture phase runs first; stopPropagation ends it).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      const open = [quizOverlay, extractOverlay, settingsOverlay].find((el) => !el.hidden);
      if (open) {
        e.stopPropagation();
        closeOverlay(open);
      }
    },
    true,
  );

  // ---- settings + focus preferences -----------------------------------------

  // Loaded once per signed-in session (mirrors statusCache). quizFocuses gates
  // which flag rows this user sees/quizzes; the communal pool is unaffected.
  let settingsCache: UserPreferences | null = null;
  let settingsLoad: Promise<UserPreferences> | null = null;

  // Membership/tier, loaded once per signed-in session. Everything that gates on
  // the paid tier (Membership section, the two free-tier nudges, the panel cap)
  // reads it here. Fails CLOSED: a failed load leaves the cache null, which every
  // reader treats as free — never premium — and the Membership section shows a
  // retry line instead of a status.
  let billingCache: BillingStatus | null = null;
  let billingLoad: Promise<BillingStatus | null> | null = null;

  function ensureBilling(force = false): Promise<BillingStatus | null> {
    if (force) {
      billingCache = null;
      billingLoad = null;
    }
    billingLoad ??= apiFetch<BillingStatus>('/api/billing')
      .then((r) => {
        billingCache = r;
        return r;
      })
      .catch(() => {
        // Allow a retry next open; readers see null and fall back to free.
        billingLoad = null;
        return null;
      });
    return billingLoad;
  }

  // Definitive free only. A null cache (load failed / not yet loaded) is NOT
  // treated as free here, so a premium user with a transient billing error is
  // never nagged with an upgrade nudge. Nudges/panel-cap read this.
  function isFreeTier(): boolean {
    return billingCache?.tier === 'free';
  }

  function ensureSettings(): Promise<UserPreferences> {
    settingsLoad ??= apiFetch<{ preferences: UserPreferences }>('/api/settings')
      .then((r) => {
        settingsCache = r.preferences ?? {};
        return settingsCache;
      })
      .catch(() => {
        // A failed load must not strand the session offline forever; default to
        // empty (flags off) and allow a retry next time settings are needed.
        settingsLoad = null;
        settingsCache ??= {};
        return settingsCache;
      });
    return settingsLoad;
  }

  // Synchronous read for the quiz/panel draw. Absent cache = flags off (the
  // opt-in default), which is exactly today's behavior for non-flag rows.
  function flagsOn(): boolean {
    return (settingsCache?.quizFocuses ?? []).includes('flags');
  }

  const flagsToggle = $<HTMLInputElement>('settings-flags');

  function renderSettings(): void {
    flagsToggle.checked = flagsOn();
    const email = clerk?.user?.primaryEmailAddress?.emailAddress ?? '';
    $('settings-email').textContent = email || 'Signed in';
  }

  flagsToggle.addEventListener('change', () => {
    const on = flagsToggle.checked;
    const before = settingsCache?.quizFocuses ?? [];
    const next = on
      ? Array.from(new Set([...before, 'flags']))
      : before.filter((f) => f !== 'flags');
    // Optimistic: the toggle already shows `on`; persist and revert on failure.
    settingsCache = { ...(settingsCache ?? {}), quizFocuses: next };
    void (async () => {
      try {
        const r = await apiFetch<{ preferences: UserPreferences }>('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ preferences: { quizFocuses: next } }),
        });
        settingsCache = r.preferences ?? {};
        renderSettings();
      } catch {
        settingsCache = { ...(settingsCache ?? {}), quizFocuses: before };
        flagsToggle.checked = before.includes('flags');
        opts.onToast("That didn't save. Try again.");
      }
    })();
  });

  function openSettings(scrollToMembership = false): void {
    void (async () => {
      if (!(await requireAuth())) return;
      // Opening settings takes over the modal layer: clear any extract/quiz
      // overlay underneath (a nudge's #upgrade link opens settings from the
      // extract panel).
      closeOverlay(extractOverlay);
      closeOverlay(quizOverlay);
      await ensureSettings();
      renderSettings();
      openOverlay(settingsOverlay);
      // Refresh the tier every open so a just-completed checkout/cancel or an
      // expired period is reflected; render whatever we have, then repaint when
      // the fresh status lands.
      renderMembership();
      void ensureBilling(true).then(renderMembership);
      if (scrollToMembership) {
        // The overlay just became visible; defer so layout is ready.
        requestAnimationFrame(() =>
          $('settings-membership').scrollIntoView({ block: 'start', behavior: 'smooth' }),
        );
      }
    })();
  }

  // ---- membership (the Task-29 slot: upgrade / status / cancel) --------------

  const membershipSlot = $('settings-membership-slot');

  // Gray's APPROVED upgrade copy — shipped VERBATIM (D6, locked 2026-07-12).
  // Only typographic adaptation to markup (the title + two paragraphs) is
  // allowed. Nothing here implies premium lifts the daily generation cap.
  const UPGRADE_TITLE = 'Support the burrow';
  const UPGRADE_BODY_1 =
    'Wabbit Hole is a hobby project with real running costs: every trivia question comes from a paid AI model, and the servers and database cost money each month. Premium helps cover that, and you get more in return: 25 questions per article instead of 5, highlight any sentence to turn it into a question, and a bank that grows five times faster.';
  const UPGRADE_BODY_2 =
    "$3 a month. If you ever cancel, you keep everything you've banked.";

  function fmtDate(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function renderMembership(): void {
    const b = billingCache;
    // Fail-closed: a failed load (null cache) renders as free with a retry line,
    // never as premium.
    if (!b) {
      membershipSlot.replaceChildren(retryLine(), upgradePitch());
      return;
    }
    if (b.tier === 'owner') {
      membershipSlot.replaceChildren(statusLine('Owner'));
      return;
    }
    if (b.tier === 'premium') {
      if (b.status === 'canceled') {
        const until = fmtDate(b.endsAt);
        membershipSlot.replaceChildren(
          statusLine(until ? `Premium until ${until}` : 'Premium, ending soon'),
          memNote("You keep everything you've banked."),
        );
        return;
      }
      const renews = fmtDate(b.renewsAt);
      membershipSlot.replaceChildren(
        statusLine(renews ? `Premium, renews ${renews}` : 'Premium'),
        cancelControl(),
      );
      return;
    }
    // Free.
    membershipSlot.replaceChildren(upgradePitch());
  }

  function statusLine(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'wh-mem-status';
    p.textContent = text;
    return p;
  }

  function memNote(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'wh-mem-note';
    p.textContent = text;
    return p;
  }

  function retryLine(): HTMLElement {
    const wrap = document.createElement('p');
    wrap.className = 'wh-mem-note';
    wrap.textContent = "Couldn't load your membership. ";
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'wh-linkbtn';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => {
      void ensureBilling(true).then(renderMembership);
    });
    wrap.appendChild(retry);
    return wrap;
  }

  function upgradePitch(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wh-mem';
    const title = document.createElement('p');
    title.className = 'wh-mem-title';
    title.textContent = UPGRADE_TITLE;
    const p1 = document.createElement('p');
    p1.className = 'wh-mem-body';
    p1.textContent = UPGRADE_BODY_1;
    const p2 = document.createElement('p');
    p2.className = 'wh-mem-body';
    p2.textContent = UPGRADE_BODY_2;
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'wh-btn';
    const spark = document.createElement('span');
    spark.className = 'wh-icon';
    spark.dataset.name = 'sparkles';
    spark.setAttribute('aria-hidden', 'true');
    cta.append(spark, 'Get premium');
    cta.addEventListener('click', () => void startCheckout(cta));
    wrap.append(title, p1, p2, cta);
    return wrap;
  }

  function cancelControl(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wh-mem-cancel';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wh-linkbtn';
    btn.textContent = 'Cancel premium';
    btn.addEventListener('click', () => {
      // One confirm step, DS-styled, no guilt copy: swap the link for a plain
      // question + two buttons.
      const confirm = document.createElement('div');
      confirm.className = 'wh-mem-confirm';
      const q = document.createElement('p');
      q.className = 'wh-mem-note';
      const until = fmtDate(billingCache?.endsAt ?? billingCache?.renewsAt ?? null);
      q.textContent = until
        ? `Cancel premium? You'll keep it until ${until}, and keep everything you've banked.`
        : "Cancel premium? You'll keep everything you've banked.";
      const row = document.createElement('div');
      row.className = 'wh-mem-confirm-row';
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.className = 'wh-btn';
      keep.dataset.variant = 'soft';
      keep.dataset.size = 'sm';
      keep.textContent = 'Keep premium';
      keep.addEventListener('click', () => renderMembership());
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'wh-btn';
      go.dataset.size = 'sm';
      go.textContent = 'Cancel it';
      go.addEventListener('click', () => void doCancel(go));
      row.append(keep, go);
      confirm.append(q, row);
      wrap.replaceChildren(confirm);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  async function doCancel(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const next = await apiFetch<BillingStatus>('/api/billing', { method: 'POST' });
      billingCache = next;
      renderMembership();
      opts.onToast('Premium canceled. You keep it until the period ends.');
    } catch (err) {
      opts.onToast(err instanceof TriviaError ? err.message : "That didn't work. Try again.");
      btn.disabled = false;
    }
  }

  async function startCheckout(cta: HTMLButtonElement): Promise<void> {
    const c = await loadClerk();
    if (!c) {
      opts.onToast('Accounts are unavailable right now. Wandering still works.');
      return;
    }
    const slug = billingCache?.planSlug;
    if (!slug) {
      opts.onToast("Premium isn't quite ready yet. Check back soon.");
      return;
    }
    cta.disabled = true;
    try {
      // Preferred path: Clerk's hosted checkout drawer (card entry + confirm),
      // the same entry point the prebuilt <CheckoutButton> uses under the hood
      // in clerk-js 6. It is an __internal_ symbol, so feature-detect at click
      // time: if a future clerk-js drops or renames it, fall back IN CODE to
      // the documented PricingTable component — checkout keeps working instead
      // of dead-ending on a toast (review MINOR-1).
      if (typeof c.__internal_openCheckout !== 'function') {
        openPricingFallback(c);
        cta.disabled = false;
        return;
      }
      // The plan claim (has({plan})) is keyed by SLUG, but checkout needs the
      // plan ID; resolve it from the published plans at click time.
      const plans = await c.billing.getPlans();
      const plan = plans.data.find((p) => p.slug === slug);
      if (!plan) {
        opts.onToast("Premium isn't available right now. Try again soon.");
        cta.disabled = false;
        return;
      }
      c.__internal_openCheckout({
        planId: plan.id,
        planPeriod: 'month',
        onSubscriptionComplete: () => void afterCheckout(),
        onClose: () => {
          cta.disabled = false;
        },
      });
    } catch {
      opts.onToast("Couldn't start checkout. Try again.");
      cta.disabled = false;
    }
  }

  // Documented-API fallback when the hosted drawer entry point is missing:
  // mount Clerk's PricingTable inside the Membership section. Its Subscribe flow
  // handles payment end to end and is self-consistent within whatever clerk-js
  // version is loaded. The refresh line re-reads the tier once the user has
  // subscribed; renderMembership then replaces the slot with the new state.
  function openPricingFallback(c: Clerk): void {
    if (membershipSlot.querySelector('.wh-mem-pricing')) return; // already mounted
    const wrap = document.createElement('div');
    wrap.className = 'wh-mem-pricing';
    const mount = document.createElement('div');
    wrap.appendChild(mount);
    const note = document.createElement('p');
    note.className = 'wh-mem-note';
    note.textContent = 'Subscribed? ';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'wh-linkbtn';
    refresh.textContent = 'Refresh status';
    refresh.addEventListener('click', () => {
      void (async () => {
        // Same NOTE-2 order as afterCheckout, minus its completion toast (this
        // line can be clicked before any purchase happened).
        try {
          await clerk?.session?.reload();
        } catch {
          // best effort; the forced billing reload below still corrects the view
        }
        await ensureBilling(true);
        renderMembership();
      })();
    });
    note.appendChild(refresh);
    wrap.appendChild(note);
    membershipSlot.appendChild(wrap);
    try {
      c.mountPricingTable(mount as HTMLDivElement);
    } catch {
      wrap.remove();
      opts.onToast("Couldn't start checkout. Try again.");
    }
  }

  async function afterCheckout(): Promise<void> {
    // NOTE-2: the fresh token must carry the plan claim before entitlements flip,
    // so reload the session first, then re-read tier/status and repaint.
    try {
      await clerk?.session?.reload();
    } catch {
      // best effort; the forced billing reload below still corrects the view
    }
    const b = await ensureBilling(true);
    renderMembership();
    // NOTE-3: only claim premium once the reloaded status actually shows it; a
    // lagging plan claim gets a neutral line the repainted UI can't contradict.
    if (b && b.tier !== 'free') {
      opts.onToast('You are premium now. Thanks for keeping the burrow lit.');
    } else {
      opts.onToast('Checkout complete. Your plan may take a moment to update.');
    }
  }

  // ---- extract panel ---------------------------------------------------------

  const extractBody = $('extract-body');
  const extractFoot = $('extract-foot');
  const extractTitle = $('extract-title');
  const extractRemaining = $('extract-remaining');
  const addBtn = $<HTMLButtonElement>('btn-add-bank');
  let panelRemaining: number | null = 0;
  let panelNode: { lang: string; title: string } | null = null;

  function openExtract(node: { lang: string; title: string }): void {
    void (async () => {
      if (!(await requireAuth({ type: 'extract', lang: node.lang, title: node.title }))) return;
      panelNode = node;
      extractTitle.textContent = 'Extract trivia';
      extractFoot.hidden = true;
      extractBody.replaceChildren(skeleton());
      openOverlay(extractOverlay);
      try {
        // Flag hint is sent whenever one is detected, regardless of this user's
        // own toggle — the pool is communal and the server validates it hard.
        // Resolve the tier alongside the extract so the nudge/panel-cap decisions
        // have it; ensureBilling never rejects, so it can't fail the extract.
        const flag = detectFlag();
        const [data] = await Promise.all([
          apiFetch<ExtractResponse>('/api/extract', {
            method: 'POST',
            body: JSON.stringify({ lang: node.lang, title: node.title, ...(flag ? { flag } : {}) }),
          }),
          ensureBilling(),
        ]);
        renderExtract(data);
      } catch (err) {
        renderExtractError(err, node);
      }
    })();
  }

  // Scan the active card's infobox for a flag image and return a hint. Parsoid
  // keeps the file link's `resource` (./File:Flag_of_X.svg) and the
  // mw-file-description anchor, so either identifies the flag; imageUrl is the
  // resolved (possibly thumbnail) upload URL the browser actually loaded.
  function detectFlag(): { imageUrl: string; sourceUrl: string } | null {
    const card = document.querySelector('.wh-cardpos[data-active]') ?? document;
    const anchor = card.querySelector<HTMLAnchorElement>('a.mw-file-description[title^="Flag of" i]');
    const img =
      anchor?.querySelector<HTMLImageElement>('img') ??
      card.querySelector<HTMLImageElement>('img[resource*="File:Flag_of" i]');
    if (!img) return null;
    let imageUrl = img.currentSrc || img.src || '';
    if (imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`;
    if (!imageUrl.startsWith('https://')) return null;
    // sourceUrl is best-effort attribution; the server derives its own from the
    // validated URL, so an unresolved/relative anchor href is harmless here.
    const href = anchor?.href ?? '';
    const sourceUrl = href.startsWith('https://') ? href : imageUrl;
    return { imageUrl, sourceUrl };
  }

  function renderExtract(data: ExtractResponse): void {
    extractTitle.textContent = data.article.displayTitle;
    // Premium/owner are not bounded by the panel's free-basis weekly number (the
    // extract endpoint reports a free-10 figure to every tier); their real cap
    // (50 / unlimited) is enforced server-side in bank.ts. Only a known free tier
    // keeps the panel's hard limit + row greying — existing free behavior intact.
    panelRemaining = billingCache && billingCache.tier !== 'free' ? null : data.weeklyRemaining;

    // Flag rows (image questions) only appear when the user allows them; the
    // server serves them to everyone (communal pool), the toggle decides who
    // sees them. Off = today's text-only panel, exactly.
    const visible = flagsOn() ? data.questions : data.questions.filter((q) => !q.imageUrl);

    const intro = document.createElement('p');
    intro.className = 'wh-trivia-intro';
    intro.textContent =
      visible.length === 1
        ? '1 question from this article. Keep the ones worth remembering.'
        : `${visible.length} questions from this article. Keep the ones worth remembering.`;

    const list = document.createElement('div');
    list.className = 'wh-picks';
    visible.forEach((q, i) => {
      const label = document.createElement('label');
      label.className = 'wh-pick';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = data.weeklyRemaining === null || i < data.weeklyRemaining;
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
      text.append(prompt);
      if (q.imageUrl) text.append(flagImage(q.imageUrl, q.imageSourceUrl));
      text.append(answer);
      label.append(input, box, text);
      list.appendChild(label);
    });

    if (panelNode) {
      const key = `${panelNode.lang}:${panelNode.title}`;
      statusCache.set(key, {
        hasQuestions: true,
        inBank: statusCache.get(key)?.inBank ?? 0,
      });
    }

    // Two quiet free-tier nudges, at most one shown (never for premium/owner):
    // a hit weekly cap takes priority (it blocks adding at all); otherwise, when
    // the article's curated pool holds more MC than a free reader is served,
    // surface the real remainder. No badges, counters, or interstitials.
    const children: Node[] = [intro, list];
    if (isFreeTier()) {
      const servedMc = data.questions.filter((q) => !q.imageUrl).length;
      const more = data.mcTotal - servedMc;
      if (panelRemaining === 0) {
        children.push(upgradeNudge('Weekly bank limit reached. Premium raises it to 50.'));
      } else if (more > 0) {
        children.push(
          upgradeNudge(`${more} more question${more === 1 ? '' : 's'} in this article with premium`),
        );
      }
    }

    extractBody.replaceChildren(...children);
    extractFoot.hidden = false;
    updateAddButton();
  }

  // A single muted line linking to the Membership section (#upgrade). Shown only
  // for free users, only when its condition is true — the whole line is the link.
  function upgradeNudge(message: string): HTMLElement {
    const a = document.createElement('a');
    a.className = 'wh-nudge';
    a.href = '#upgrade';
    a.textContent = message;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      goUpgrade();
    });
    return a;
  }

  // The #upgrade in-app path: leave the extract panel and open settings scrolled
  // to Membership. openSettings also clears the extract/quiz overlays.
  function goUpgrade(): void {
    openSettings(true);
  }

  function selectedIds(): string[] {
    return Array.from(
      extractBody.querySelectorAll<HTMLInputElement>('.wh-pick input:checked'),
      (i) => i.value,
    );
  }

  function updateAddButton(): void {
    // The weekly allowance bounds the selection: once it's reached, the
    // unchecked rows grey out rather than letting a doomed add through.
    const inputs = Array.from(extractBody.querySelectorAll<HTMLInputElement>('.wh-pick input'));
    const selected = inputs.filter((i) => i.checked).length;
    const atLimit = panelRemaining !== null && selected >= panelRemaining;
    for (const input of inputs) {
      const off = atLimit && !input.checked;
      input.disabled = off;
      input.closest('.wh-pick')?.toggleAttribute('data-disabled', off);
    }
    extractRemaining.textContent =
      panelRemaining === null
        ? ''
        : panelRemaining === 0
          ? 'No room this week'
          : panelRemaining === 1
            ? '1 left this week'
            : `${panelRemaining} left this week`;
    addBtn.disabled = selected === 0;
    addBtn.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = 'sparkles';
    icon.setAttribute('aria-hidden', 'true');
    addBtn.append(
      icon,
      selected === 0 ? 'Add to bank' : selected === 1 ? 'Add 1 to bank' : `Add ${selected} to bank`,
    );
  }

  addBtn.addEventListener('click', () => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    addBtn.disabled = true;
    void (async () => {
      try {
        const res = await apiFetch<{ added: number; remaining: number | null }>('/api/bank', {
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
        if (panelNode && kept > 0) {
          const key = `${panelNode.lang}:${panelNode.title}`;
          const prev = statusCache.get(key);
          statusCache.set(key, { hasQuestions: true, inBank: (prev?.inBank ?? 0) + kept });
          // Scope to the active card: since the trail cascade, ancestor peek
          // strips are also non-hidden and precede the active card in DOM order.
          const visibleBtn = document.querySelector<HTMLButtonElement>(
            '.wh-cardpos[data-active] .wh-card-actions .wh-btn',
          );
          if (visibleBtn) paintExtractButton(visibleBtn, statusCache.get(key)!);
        }
        closeOverlay(extractOverlay);
        if (bankOpen()) void refreshBank().catch(() => {});
      } catch (err) {
        opts.onToast(err instanceof TriviaError ? err.message : "That didn't save. Try again.");
        addBtn.disabled = false;
      }
    })();
  });

  // Friendly title per error code. Covers the extract codes and the ad-hoc
  // codes (not_in_article / no_question / bad_selection / adhoc_cap) so both
  // surfaces speak the same DS voice.
  function errorTitle(code: string): string {
    switch (code) {
      case 'daily_cap':
      case 'weekly_cap':
      case 'adhoc_cap':
        return "That's plenty for now";
      case 'generation_paused':
        return 'Trivia is resting';
      case 'extraction_in_progress':
        return 'Almost there';
      case 'not_in_article':
        return 'Not in this article';
      case 'no_question':
        return 'No question this time';
      case 'bad_selection':
        return 'Highlight a little more';
      default:
        return "That didn't work";
    }
  }

  function errorIconName(code: string): string {
    if (code === 'extraction_in_progress') return 'sparkles';
    if (code === 'generation_paused' || code === 'not_in_article' || code === 'no_question')
      return 'info';
    return 'rotate-ccw';
  }

  // Shared error card for the extract + ad-hoc surfaces. The caller decides
  // whether a retry makes sense (pass a thunk) — a spent/soft-capped or
  // deterministic failure passes null so no "Try again" appears.
  function errorNoteEl(code: string, message: string, onRetry: (() => void) | null): HTMLElement {
    const note = document.createElement('div');
    note.className = 'wh-note';
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = errorIconName(code);
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('p');
    title.className = 'wh-note-title';
    title.textContent = errorTitle(code);
    const body = document.createElement('p');
    body.className = 'wh-note-body';
    body.textContent = message;
    note.append(icon, title, body);
    if (onRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'wh-btn';
      retry.dataset.size = 'sm';
      retry.textContent = 'Try again';
      retry.addEventListener('click', onRetry);
      note.appendChild(retry);
    }
    extractFoot.hidden = true;
    return note;
  }

  function renderExtractError(err: unknown, node: { lang: string; title: string }): void {
    const e = err instanceof TriviaError ? err : new TriviaError('unknown', 'Something went wrong.');
    // Same retry policy as before: everything retries except a hit daily cap or a
    // paused site (both terminal for this open).
    const retry = e.code === 'daily_cap' || e.code === 'generation_paused' ? null : () => openExtract(node);
    extractBody.replaceChildren(errorNoteEl(e.code, e.message, retry));
    extractFoot.hidden = true;
  }

  // ---- highlight -> question (ad-hoc, premium) ------------------------------
  // Reuses the extract overlay as the result surface. openAsk gates on sign-in
  // (queuing an 'ask' PendingAction), then POSTs /api/ask; premium/owner get the
  // real question, free tier gets a 402 rendered as the quiet upgrade nudge.

  function openAsk(req: { lang: string; title: string; selectedText: string }): void {
    void (async () => {
      if (
        !(await requireAuth({ type: 'ask', lang: req.lang, title: req.title, text: req.selectedText }))
      )
        return;
      extractTitle.textContent = 'Make a question';
      extractFoot.hidden = true;
      extractBody.replaceChildren(skeleton());
      openOverlay(extractOverlay);
      try {
        const data = await apiFetch<AskResponse>('/api/ask', {
          method: 'POST',
          body: JSON.stringify(req),
        });
        renderAsk(data);
      } catch (err) {
        renderAskError(err, req);
      }
    })();
  }

  function renderAsk(data: AskResponse): void {
    const q = data.question;
    extractTitle.textContent = 'Your question';

    const intro = document.createElement('p');
    intro.className = 'wh-trivia-intro';
    intro.textContent = data.cached
      ? 'A question from your highlight, already in the pool.'
      : 'A question from your highlight. Keep it if it is worth remembering.';

    const card = document.createElement('div');
    card.className = 'wh-ask-card';
    const prompt = document.createElement('p');
    prompt.className = 'wh-ask-q';
    prompt.textContent = q.prompt;
    const answer = document.createElement('p');
    answer.className = 'wh-ask-a';
    answer.textContent = q.choices[q.answerIndex] ?? '';
    card.append(prompt, answer);
    if (q.explanation.trim()) {
      const why = document.createElement('p');
      why.className = 'wh-ask-why';
      why.textContent = q.explanation;
      card.appendChild(why);
    }

    const actions = document.createElement('div');
    actions.className = 'wh-ask-actions';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'wh-btn';
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = 'sparkles';
    icon.setAttribute('aria-hidden', 'true');
    add.append(icon, 'Add to bank');
    add.addEventListener('click', () => void bankAdhoc(q.id, add, actions));
    actions.appendChild(add);

    extractBody.replaceChildren(intro, card, actions);
    extractFoot.hidden = true;
  }

  async function bankAdhoc(id: string, btn: HTMLButtonElement, actions: HTMLElement): Promise<void> {
    btn.disabled = true;
    try {
      const res = await apiFetch<{ added: number }>('/api/bank', {
        method: 'POST',
        body: JSON.stringify({ action: 'add', questionIds: [id] }),
      });
      const banked = res.added > 0;
      const note = document.createElement('p');
      note.className = 'wh-ask-banked';
      note.textContent = banked ? 'Added to your bank.' : 'Already in your bank.';
      actions.replaceChildren(note);
      const msg = banked ? 'Added 1 question to your bank.' : 'Already in your bank.';
      opts.onToast(msg);
      opts.announce(msg);
      if (bankOpen()) void refreshBank().catch(() => {});
    } catch (err) {
      opts.onToast(err instanceof TriviaError ? err.message : "That didn't save. Try again.");
      btn.disabled = false;
    }
  }

  function renderAskError(err: unknown, req: { lang: string; title: string; selectedText: string }): void {
    const e = err instanceof TriviaError ? err : new TriviaError('unknown', 'Something went wrong.');
    // Free tier: /api/ask returns 402 — the quiet upgrade nudge, no modal.
    if (e.code === 'premium_required') {
      const intro = document.createElement('p');
      intro.className = 'wh-trivia-intro';
      intro.textContent = 'Turning your own highlight into a question is a premium feature.';
      extractBody.replaceChildren(intro, upgradeNudge('Get premium to make a question from any highlight'));
      extractFoot.hidden = true;
      return;
    }
    // not_in_article / no_question / adhoc_cap are terminal for this highlight;
    // bad_selection won't help on retry. Everything else can retry the same ask.
    const noRetry = new Set(['not_in_article', 'no_question', 'adhoc_cap', 'bad_selection', 'daily_cap', 'generation_paused']);
    const retry = noRetry.has(e.code) ? null : () => openAsk(req);
    extractBody.replaceChildren(errorNoteEl(e.code, e.message, retry));
    extractFoot.hidden = true;
  }

  // ---- selection pill: "Make a question" near a highlight -------------------
  // The stack reports the active card (onActiveBody -> onActiveCard); selection
  // is scoped to that card's .wh-prose. The pill floats near the selection and
  // dismisses on scroll, collapse, or Escape. Signed-out press routes through
  // the sign-in-first flow (PendingAction 'ask'); the server does the premium
  // gate, so free users still see the pill and get the 402 nudge.

  let activeCard: { node: { lang: string; title: string }; bodyEl: HTMLElement } | null = null;
  let pill: HTMLButtonElement | null = null;
  let pillText = '';
  let pillRaf = 0;

  function onActiveCard(
    node: { lang: string; title: string } | null,
    bodyEl: HTMLElement | null,
  ): void {
    activeCard = node && bodyEl ? { node, bodyEl } : null;
    if (!activeCard) dismissPill();
  }

  function ensurePill(): HTMLButtonElement {
    if (pill) return pill;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wh-ask-pill';
    b.hidden = true;
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = 'sparkles';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = 'Make a question';
    b.append(icon, label);
    // pointerdown preventDefault: pressing the pill must not collapse the
    // selection before the click lands (mobile especially); we captured the text
    // when the pill was shown, so the press has what it needs regardless.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      pressPill();
    });
    document.body.appendChild(b);
    pill = b;
    return b;
  }

  function pressPill(): void {
    const text = pillText;
    const card = activeCard;
    dismissPill();
    if (!card || !text) return;
    openAsk({ lang: card.node.lang, title: card.node.title, selectedText: text });
  }

  function dismissPill(): void {
    pillText = '';
    if (pill) pill.hidden = true;
  }

  function evaluateSelection(): void {
    if (!activeCard) return dismissPill();
    // Never over an open overlay (the result surface, quiz, or settings).
    if (!extractOverlay.hidden || !quizOverlay.hidden || !settingsOverlay.hidden) return dismissPill();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return dismissPill();
    const prose = activeCard.bodyEl.querySelector('.wh-prose');
    if (!prose) return dismissPill();
    const range = sel.getRangeAt(0);
    if (!prose.contains(range.startContainer) || !prose.contains(range.endContainer))
      return dismissPill();
    const norm = sel.toString().replace(/\s+/g, ' ').trim();
    const words = norm ? norm.split(' ').length : 0;
    // Mirror the server gate (12-400 chars, >=3 words) so the pill never appears
    // for a selection the endpoint would reject as bad_selection.
    if (norm.length < 12 || norm.length > 400 || words < 3) return dismissPill();
    pillText = norm;
    positionPill(range.getBoundingClientRect());
  }

  function positionPill(rect: DOMRect): void {
    const b = ensurePill();
    b.hidden = false;
    const pw = b.offsetWidth || 160;
    const ph = b.offsetHeight || 34;
    const gap = 8;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = rect.top - ph - gap;
    if (top < 8) top = rect.bottom + gap; // no room above -> below the selection
    b.style.left = `${Math.round(left)}px`;
    b.style.top = `${Math.round(top)}px`;
  }

  function scheduleSelectionCheck(): void {
    if (pillRaf) return;
    pillRaf = requestAnimationFrame(() => {
      pillRaf = 0;
      evaluateSelection();
    });
  }

  document.addEventListener('selectionchange', scheduleSelectionCheck);
  // Capture: a scroll on the card body (or anywhere) dismisses the pill.
  document.addEventListener('scroll', dismissPill, true);
  window.addEventListener('resize', dismissPill);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismissPill();
  });

  // ---- trivia portal (docked right sidebar: Bank | Stats | History) ----------
  // One right dock, three tabs. Bank and Stats both read the /api/bank payload
  // (Stats is derived client-side); History has its own endpoint. The bank foot
  // (count + Quiz me) is contextual to the Bank tab.

  const bankSidebar = $('bank-sidebar');
  const bankBody = $('bank-body');
  const statsBody = $('stats-body');
  const historyBody = $('history-body');
  const bankFoot = $('bank-foot');
  const bankCount = $('bank-count');
  const quizBtn = $<HTMLButtonElement>('btn-quiz');
  let bank: BankItem[] = [];
  let bankRemaining: number | null = 0;
  let sessions: QuizSession[] = [];
  let sessionTotals = { rounds: 0, questions: 0, correct: 0 };

  type TriviaTab = 'bank' | 'stats' | 'history';
  const TAB_ORDER: TriviaTab[] = ['bank', 'stats', 'history'];
  const tabButtons: Record<TriviaTab, HTMLButtonElement> = {
    bank: $('tab-bank'),
    stats: $('tab-stats'),
    history: $('tab-history'),
  };
  const tabPanels: Record<TriviaTab, HTMLElement> = {
    bank: bankBody,
    stats: statsBody,
    history: historyBody,
  };
  // Last-used tab persists within the session, so reopening the portal lands
  // where you left it (spec allows Bank-only; last-used is the friendlier pick).
  let activeTab: TriviaTab = 'bank';
  // Per-open caches: cleared each time the portal opens so tab content is fresh,
  // reused while it stays open so switching tabs doesn't refetch.
  let bankFetched = false;
  let historyFetched = false;

  function bankOpen(): boolean {
    return !bankSidebar.hasAttribute('data-collapsed');
  }

  function setBankSidebar(open: boolean): void {
    if (open) bankSidebar.removeAttribute('data-collapsed');
    else bankSidebar.setAttribute('data-collapsed', '');
    bankSidebar.setAttribute('aria-hidden', String(!open));
    $('btn-bank').setAttribute('aria-expanded', String(open));
  }

  async function loadBankData(): Promise<void> {
    const data = await apiFetch<{ items: BankItem[]; remaining: number | null }>('/api/bank');
    bank = data.items;
    bankRemaining = data.remaining;
    bankFetched = true;
  }

  async function loadHistory(): Promise<void> {
    const data = await apiFetch<{ sessions: QuizSession[]; totals: typeof sessionTotals }>(
      '/api/quiz-results',
    );
    sessions = data.sessions;
    sessionTotals = data.totals;
    historyFetched = true;
  }

  // Re-pull the bank and repaint whichever bank-derived tab is showing. Used
  // after an add lands while the portal is open.
  async function refreshBank(): Promise<void> {
    await loadBankData();
    if (activeTab === 'bank') renderBank();
    else if (activeTab === 'stats') renderStats();
  }

  function setActiveTab(tab: TriviaTab): void {
    activeTab = tab;
    for (const key of TAB_ORDER) {
      const selected = key === tab;
      tabButtons[key].setAttribute('aria-selected', String(selected));
      tabButtons[key].tabIndex = selected ? 0 : -1;
      tabPanels[key].hidden = !selected;
    }
    bankFoot.hidden = tab !== 'bank';
  }

  function renderTabError(container: HTMLElement, err: unknown): void {
    const note = document.createElement('p');
    note.className = 'wh-trivia-intro';
    note.textContent = err instanceof TriviaError ? err.message : "That didn't load. Try again.";
    container.replaceChildren(note);
  }

  async function loadTab(tab: TriviaTab): Promise<void> {
    if (tab === 'bank') {
      if (bankFetched) return renderBank();
      bankBody.replaceChildren(skeleton());
      quizBtn.disabled = true;
      bankCount.textContent = '';
      try {
        await loadBankData();
        renderBank();
      } catch (err) {
        renderTabError(bankBody, err);
      }
    } else if (tab === 'stats') {
      if (bankFetched) return renderStats();
      statsBody.replaceChildren(skeleton());
      try {
        await loadBankData();
        renderStats();
      } catch (err) {
        renderTabError(statsBody, err);
      }
    } else {
      if (historyFetched) return renderHistory();
      historyBody.replaceChildren(skeleton());
      try {
        await loadHistory();
        renderHistory();
      } catch (err) {
        renderTabError(historyBody, err);
      }
    }
  }

  function selectTab(tab: TriviaTab): void {
    if (tab === activeTab) return;
    setActiveTab(tab);
    void loadTab(tab);
  }

  for (const tab of TAB_ORDER) {
    tabButtons[tab].addEventListener('click', () => selectTab(tab));
  }
  // Arrow keys move selection within the tablist (roving tabindex); Home/End
  // jump to the ends. Plain Tab/click still work.
  tabButtons.bank.parentElement?.addEventListener('keydown', (e) => {
    const idx = TAB_ORDER.indexOf(activeTab);
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % TAB_ORDER.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TAB_ORDER.length - 1;
    else return;
    e.preventDefault();
    const tab = TAB_ORDER[next];
    selectTab(tab);
    tabButtons[tab].focus();
  });

  /** Topbar/entry action. In a session this toggles the docked portal; on the
   * entry screen there is no stage to dock to, so it quizzes directly. */
  function openBank(): void {
    void (async () => {
      if (!(await requireAuth({ type: 'bank' }))) return;
      // Preferences gate the quiz draw (flag front-loading); make sure they are
      // loaded before a draw can happen.
      await ensureSettings();
      if ($('main-row').hidden) {
        try {
          await loadBankData();
        } catch {
          opts.onToast("The bank didn't load. Try again.");
          return;
        }
        if (bank.length === 0) opts.onToast('Your bank is empty. Extract trivia from any card first.');
        else startQuiz();
        return;
      }
      if (bankOpen()) {
        setBankSidebar(false);
        return;
      }
      setBankSidebar(true);
      // Fresh data each open; the last-used tab within the session stays put.
      bankFetched = false;
      historyFetched = false;
      setActiveTab(activeTab);
      void loadTab(activeTab);
    })();
  }

  $('btn-close-bank').addEventListener('click', () => setBankSidebar(false));

  function renderBank(): void {
    if (bank.length === 0) {
      bankBody.replaceChildren(
        noteBlock(
          'sparkles',
          'Nothing here yet',
          'Open any card and press Extract trivia to start your bank.',
        ),
      );
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
    const n = bank.length === 1 ? '1 question' : `${bank.length} questions`;
    bankCount.textContent = bankRemaining === null ? n : `${n} · ${bankRemaining} left this week`;
  }

  function bankRow(item: BankItem): HTMLElement {
    const row = document.createElement('details');
    row.className = 'wh-bank-item';

    const summary = document.createElement('summary');
    const caret = document.createElement('span');
    caret.className = 'wh-icon wh-bank-caret';
    caret.dataset.name = 'chevron-right';
    caret.setAttribute('aria-hidden', 'true');
    summary.appendChild(caret);
    const text = document.createElement('span');
    text.className = 'wh-bank-q';
    text.textContent = item.prompt;
    summary.appendChild(text);
    if (item.timesAnswered > 0) {
      const stats = document.createElement('span');
      stats.className = 'wh-bank-stats';
      stats.textContent = `${item.timesCorrect}/${item.timesAnswered}`;
      stats.title = `Answered right ${item.timesCorrect} of ${item.timesAnswered} times`;
      summary.appendChild(stats);
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
    remove.addEventListener('click', (event) => {
      // A click inside <summary> would also toggle the row open.
      event.preventDefault();
      event.stopPropagation();
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
    summary.appendChild(remove);
    row.appendChild(summary);
    row.appendChild(revealBlock(item));
    return row;
  }

  // The answer + explanation drawer shared by bank rows and the Stats
  // "toughest questions" list (same reveal pattern, .wh-bank-reveal styling).
  function revealBlock(item: BankItem): HTMLElement {
    const reveal = document.createElement('div');
    reveal.className = 'wh-bank-reveal';
    if (item.imageUrl) reveal.appendChild(flagImage(item.imageUrl, item.imageSourceUrl));
    const answer = document.createElement('p');
    answer.className = 'wh-bank-a';
    answer.textContent = item.choices[item.answerIndex] ?? '';
    reveal.appendChild(answer);
    if (item.explanation) {
      const why = document.createElement('p');
      why.className = 'wh-bank-why';
      why.textContent = item.explanation;
      reveal.appendChild(why);
    }
    return reveal;
  }

  // ---- stats (derived client-side from the /api/bank payload) ----------------

  function renderStats(): void {
    if (bank.length === 0) {
      statsBody.replaceChildren(
        noteBlock(
          'sparkles',
          'No stats yet',
          'Extract trivia from a card, then quiz yourself. Your accuracy shows up here.',
        ),
      );
      return;
    }

    const frag = document.createDocumentFragment();

    // Headline: total questions · answered at least once · overall accuracy.
    const answeredItems = bank.filter((b) => b.timesAnswered > 0).length;
    const totalAnswered = bank.reduce((s, b) => s + b.timesAnswered, 0);
    const totalCorrect = bank.reduce((s, b) => s + b.timesCorrect, 0);
    const overall = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : null;

    const head = document.createElement('div');
    head.className = 'wh-stats-head';
    head.append(
      statCell(String(bank.length), bank.length === 1 ? 'question' : 'questions'),
      statCell(String(answeredItems), 'answered'),
      statCell(overall === null ? '·' : `${overall}%`, 'accuracy'),
    );
    frag.appendChild(head);

    // Per article, worst accuracy first (the useful study order). Articles with
    // nothing answered sink to the bottom as "not quizzed yet".
    const groups = new Map<string, BankItem[]>();
    for (const item of bank) {
      const key = `${item.articleLang}:${item.articleTitle}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(item);
    }
    const articleStats = Array.from(groups.values()).map((items) => {
      const answered = items.reduce((s, b) => s + b.timesAnswered, 0);
      const correct = items.reduce((s, b) => s + b.timesCorrect, 0);
      return {
        title: items[0].articleTitle.replace(/_/g, ' '),
        count: items.length,
        answered,
        accuracy: answered > 0 ? correct / answered : null,
      };
    });
    articleStats.sort((a, b) => {
      if (a.accuracy === null && b.accuracy === null) return a.title.localeCompare(b.title);
      if (a.accuracy === null) return 1;
      if (b.accuracy === null) return -1;
      if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
      return b.answered - a.answered;
    });

    frag.appendChild(sectionHead('By article'));
    const list = document.createElement('div');
    list.className = 'wh-stats-articles';
    for (const a of articleStats) list.appendChild(articleStatRow(a));
    frag.appendChild(list);

    // Toughest questions: bottom 5 by accuracy, min 2 attempts.
    const tough = bank
      .filter((b) => b.timesAnswered >= 2)
      .sort(
        (a, b) =>
          a.timesCorrect / a.timesAnswered - b.timesCorrect / b.timesAnswered ||
          b.timesAnswered - a.timesAnswered,
      )
      .slice(0, 5);
    if (tough.length > 0) {
      frag.appendChild(sectionHead('Toughest questions'));
      for (const item of tough) frag.appendChild(toughRow(item));
    }

    statsBody.replaceChildren(frag);
  }

  function statCell(value: string, label: string): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'wh-stat';
    const v = document.createElement('span');
    v.className = 'wh-stat-value';
    v.textContent = value;
    const l = document.createElement('span');
    l.className = 'wh-stat-label';
    l.textContent = label;
    cell.append(v, l);
    return cell;
  }

  function sectionHead(text: string): HTMLElement {
    const h = document.createElement('h3');
    h.className = 'wh-stats-section';
    h.textContent = text;
    return h;
  }

  function articleStatRow(a: {
    title: string;
    count: number;
    accuracy: number | null;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'wh-stats-article';
    const title = document.createElement('span');
    title.className = 'wh-stats-article-title';
    title.textContent = a.title;
    const meta = document.createElement('span');
    meta.className = 'wh-stats-article-meta';
    const qn = a.count === 1 ? '1 question' : `${a.count} questions`;
    meta.textContent =
      a.accuracy === null ? `${qn} · not quizzed yet` : `${qn} · ${Math.round(a.accuracy * 100)}%`;
    row.append(title, meta);
    return row;
  }

  function toughRow(item: BankItem): HTMLElement {
    const row = document.createElement('details');
    row.className = 'wh-bank-item';
    const summary = document.createElement('summary');
    const caret = document.createElement('span');
    caret.className = 'wh-icon wh-bank-caret';
    caret.dataset.name = 'chevron-right';
    caret.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'wh-bank-q';
    text.textContent = item.prompt;
    const stats = document.createElement('span');
    stats.className = 'wh-bank-stats';
    stats.textContent = `${item.timesCorrect}/${item.timesAnswered}`;
    stats.title = `Answered right ${item.timesCorrect} of ${item.timesAnswered} times`;
    summary.append(caret, text, stats);
    row.append(summary, revealBlock(item));
    return row;
  }

  // ---- history (own endpoint: the user's past quiz rounds) -------------------

  function renderHistory(): void {
    if (sessions.length === 0) {
      historyBody.replaceChildren(
        noteBlock(
          'circle-check',
          'No rounds yet',
          'Quiz yourself from the Bank tab and your past rounds show up here.',
        ),
      );
      return;
    }

    const frag = document.createDocumentFragment();
    const agg = document.createElement('p');
    agg.className = 'wh-history-agg';
    const roundWord = sessionTotals.rounds === 1 ? '1 round' : `${sessionTotals.rounds} rounds`;
    const avg =
      sessionTotals.questions > 0
        ? Math.round((sessionTotals.correct / sessionTotals.questions) * 100)
        : null;
    agg.textContent = avg === null ? roundWord : `${roundWord} · ${avg}% average`;
    frag.appendChild(agg);

    const list = document.createElement('div');
    list.className = 'wh-history-list';
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'wh-history-row';
      const score = document.createElement('span');
      score.className = 'wh-history-score';
      score.textContent = `${s.correctCount}/${s.questionCount}`;
      const when = document.createElement('span');
      when.className = 'wh-history-when';
      when.textContent = relativeTime(s.playedAt);
      row.append(score, when);
      list.appendChild(row);
    }
    frag.appendChild(list);
    historyBody.replaceChildren(frag);
  }

  function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const min = Math.floor((Date.now() - then) / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // A centered empty/nudge block, shared by the three tabs.
  function noteBlock(iconName: string, title: string, body: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wh-note';
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.dataset.name = iconName;
    icon.setAttribute('aria-hidden', 'true');
    const t = document.createElement('p');
    t.className = 'wh-note-title';
    t.textContent = title;
    const b = document.createElement('p');
    b.className = 'wh-note-body';
    b.textContent = body;
    wrap.append(icon, t, b);
    return wrap;
  }

  // ---- quiz ---------------------------------------------------------------------

  const quizBody = $('quiz-body');
  const quizProgress = $('quiz-progress');
  const QUIZ_SIZE = 10;
  let quizItems: BankItem[] = [];
  let quizIndex = 0;
  let quizCorrect = 0;
  let quizResults: Array<{ bankItemId: string; correct: boolean }> = [];
  // The button Enter/Space should run: the advance button while feedback shows,
  // the finish button on the end screen. Null while a question is unanswered,
  // which is the state where 1-4 pick a choice instead.
  let quizPrimaryBtn: HTMLButtonElement | null = null;

  quizBtn.addEventListener('click', () => {
    if (bank.length === 0) return;
    startQuiz();
  });

  // ---- quiz keyboard control -------------------------------------------------
  // Attached only while the quiz overlay is open (see startQuiz/closeOverlay),
  // so digits never reach the reading path or the search box once it closes.
  let quizKeysAttached = false;

  function attachQuizKeys(): void {
    if (quizKeysAttached) return;
    document.addEventListener('keydown', onQuizKeydown);
    quizKeysAttached = true;
  }
  function detachQuizKeys(): void {
    if (!quizKeysAttached) return;
    document.removeEventListener('keydown', onQuizKeydown);
    quizKeysAttached = false;
    quizPrimaryBtn = null;
  }

  function onQuizKeydown(e: KeyboardEvent): void {
    if (quizOverlay.hidden) return;
    // Never hijack typing: search box, or any input/textarea/contenteditable.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
      return;
    // Only act when the quiz is the topmost open overlay (later in the DOM
    // paints on top), so a dialog stacked above it keeps the keys.
    const overlays = Array.from(document.querySelectorAll<HTMLElement>('.wh-overlay')).filter(
      (o) => !o.hidden,
    );
    if (overlays[overlays.length - 1] !== quizOverlay) return;
    // Leave shortcuts (cmd/ctrl/alt combos) to the browser.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Feedback or end screen: Enter/Space runs the primary action. When it is
    // already focused the browser activates it natively, so we don't double-fire.
    if (quizPrimaryBtn) {
      if (e.key === 'Enter' || e.key === ' ' || e.code === 'Space') {
        if (document.activeElement === quizPrimaryBtn) return;
        e.preventDefault();
        quizPrimaryBtn.click();
      }
      return;
    }

    // Open, unanswered question: 1-4 (digit row or numpad) pick that choice.
    const digit = e.code.match(/^(?:Digit|Numpad)([1-4])$/);
    if (!digit) return;
    const btn = quizBody.querySelectorAll<HTMLButtonElement>('.wh-quiz-choice')[Number(digit[1]) - 1];
    if (btn && !btn.disabled) {
      e.preventDefault();
      btn.click();
    }
  }

  function startQuiz(): void {
    quizItems = drawQuiz();
    quizIndex = 0;
    quizCorrect = 0;
    quizResults = [];
    openOverlay(quizOverlay);
    attachQuizKeys();
    renderQuizQuestion();
  }

  // The quiz draw honors the flags toggle (client-side only; the bank keeps
  // every row). On: flag questions are front-loaded ahead of a shuffled rest.
  // Off: flag rows are excluded from draws (but stay in the bank list). Empty/
  // absent preferences on non-flag rows = today's uniform shuffle, unchanged.
  function drawQuiz(): BankItem[] {
    const flags = bank.filter((b) => b.imageUrl);
    const rest = bank.filter((b) => !b.imageUrl);
    const ordered = flagsOn() ? [...shuffle(flags), ...shuffle(rest)] : shuffle(rest);
    return ordered.slice(0, QUIZ_SIZE);
  }

  function renderQuizQuestion(): void {
    // Back to the answering state: 1-4 pick, Enter/Space are inert until feedback.
    quizPrimaryBtn = null;
    const item = quizItems[quizIndex];
    quizProgress.textContent = `${quizIndex + 1} of ${quizItems.length}`;

    const prompt = document.createElement('p');
    prompt.className = 'wh-quiz-q';
    prompt.textContent = item.prompt;

    const image = item.imageUrl ? flagImage(item.imageUrl, item.imageSourceUrl) : null;

    const choices = document.createElement('div');
    choices.className = 'wh-quiz-choices';
    item.choices.forEach((choice, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wh-quiz-choice';
      // Number hint: which digit picks this choice. Hidden from assistive tech
      // so the choice reads as just its text.
      const kbd = document.createElement('span');
      kbd.className = 'wh-kbd wh-quiz-kbd';
      kbd.textContent = String(i + 1);
      kbd.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'wh-quiz-choice-label';
      label.textContent = choice;
      btn.append(kbd, label);
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

    quizBody.replaceChildren(...(image ? [prompt, image, choices, from] : [prompt, choices, from]));
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
    // A quiet "report question" affordance on the reveal (moderation floor). It
    // sits left of the advance button (margin-right:auto) so it never competes
    // with the primary action.
    actions.append(buildReportButton(item.questionId), next);
    quizBody.append(feedback, actions);
    // Feedback is showing: Enter/Space now advance.
    quizPrimaryBtn = next;
    next.focus();
    opts.announce(feedback.textContent);
  }

  function buildReportButton(questionId: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wh-btn wh-quiz-report';
    btn.dataset.variant = 'ghost';
    btn.dataset.size = 'sm';
    btn.textContent = 'Report question';
    btn.addEventListener('click', () => void reportQuestion(questionId, btn));
    return btn;
  }

  // POST /api/report — idempotent per user server-side; a re-tap in a later round
  // just no-ops there and thanks the user again. A network failure is honest
  // (re-enable + a retry toast) rather than a false "thank you".
  async function reportQuestion(questionId: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      await apiFetch('/api/report', { method: 'POST', body: JSON.stringify({ questionId }) });
      btn.textContent = 'Reported';
      opts.onToast('Reported. Thank you.');
      opts.announce('Reported. Thank you.');
    } catch (err) {
      btn.disabled = false;
      opts.onToast(err instanceof TriviaError ? err.message : "Couldn't send that report. Try again.");
    }
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
    // End screen: the solid finish button is primary, so Enter closes the round.
    quizPrimaryBtn = done;
    done.focus();
    opts.announce(`Quiz finished. ${quizCorrect} of ${quizItems.length} right.`);
  }

  function flushQuizResults(): void {
    if (quizResults.length === 0) return;
    const results = quizResults;
    quizResults = [];
    const questionCount = results.length;
    const correctCount = results.filter((r) => r.correct).length;
    // A fresh round means the (cached) History tab is now stale.
    historyFetched = false;
    void apiFetch('/api/quiz-results', {
      method: 'POST',
      body: JSON.stringify({ results, questionCount, correctCount }),
    }).catch(() => {
      // Stats are a courtesy; a failed flush shouldn't interrupt anything.
    });
  }

  // ---- card button decoration ------------------------------------------------

  const statusCache = new Map<string, ArticleStatus>();

  function paintExtractButton(btn: HTMLButtonElement, status: ArticleStatus): void {
    const icon = document.createElement('span');
    icon.className = 'wh-icon';
    icon.setAttribute('aria-hidden', 'true');
    let label = 'Extract trivia';
    icon.dataset.name = 'sparkles';
    if (status.inBank > 0) {
      icon.dataset.name = 'book-marked';
      label = 'In your bank';
    } else if (status.hasQuestions) {
      label = 'Trivia ready';
    }
    btn.replaceChildren(icon, label);
  }

  function decorateExtractButton(
    node: { lang: string; title: string },
    btn: HTMLButtonElement,
  ): void {
    // Never trigger the auth bundle for anonymous wanderers: only decorate
    // when Clerk is already loading (returning user) or loaded.
    if (!clerkLoad) return;
    void (async () => {
      try {
        const c = await clerkLoad;
        if (!c?.user) return;
        const key = `${node.lang}:${node.title}`;
        let status = statusCache.get(key);
        if (!status) {
          status = await apiFetch<ArticleStatus>(
            `/api/article-status?lang=${encodeURIComponent(node.lang)}&title=${encodeURIComponent(node.title)}`,
          );
          statusCache.set(key, status);
        }
        if (btn.isConnected) paintExtractButton(btn, status);
      } catch {
        // decoration is a nicety; the default label is always correct
      }
    })();
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

  // A flag question's image + attribution link, shared by the panel, quiz, and
  // bank. alt is deliberately generic ("flag") so assistive tech never reads the
  // country and gives the answer away. Attribution matches the per-question
  // discipline: the file page carries the image's own license and author.
  function flagImage(url: string, sourceUrl: string | null): HTMLElement {
    const fig = document.createElement('figure');
    fig.className = 'wh-qimage';
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'flag';
    img.loading = 'lazy';
    img.decoding = 'async';
    fig.appendChild(img);
    if (sourceUrl) {
      const a = document.createElement('a');
      a.className = 'wh-qimage-src';
      a.href = sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const icon = document.createElement('span');
      icon.className = 'wh-icon';
      icon.dataset.name = 'external-link';
      icon.setAttribute('aria-hidden', 'true');
      a.append(icon, 'Image source');
      fig.appendChild(a);
    }
    return fig;
  }

  // Load Clerk at boot only for returning users (its __client_uat cookie is
  // nonzero when a session exists), so anonymous wandering never downloads
  // the auth bundle. Everyone else gets it on their first trivia action.
  if (/(?:^|;\s*)__client_uat=(?!0(?:;|$))\d/.test(document.cookie)) void loadClerk();

  return {
    openExtract,
    openBank,
    openSettings,
    decorateExtractButton,
    onActiveCard,
    api: apiFetch,
    signIn: () => {
      void requireAuth();
    },
    signUp: () => {
      void (async () => {
        const c = await loadClerk();
        if (!c) {
          opts.onToast('Accounts are unavailable right now. Wandering still works.');
          return;
        }
        if (c.user) return;
        void c.openSignUp({});
        watchForSession();
      })();
    },
  };
}
