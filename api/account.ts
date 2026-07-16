// /api/account — the signed-in user's account surface. ONE Serverless Function
// fronting two user-scoped sub-resources, selected by the `scope` query param
// (merged verbatim from api/settings.ts + api/billing.ts to fit the Hobby
// 12-function cap). Each sub-resource keeps its former method + auth +
// validation + response/error shapes exactly:
//   scope=settings -> GET/PUT  (former /api/settings)
//   scope=billing  -> GET/POST (former /api/billing)
// A missing or unknown scope is a 400 before any sub-handler (and thus any
// auth) runs.

import { eq } from 'drizzle-orm';
import { authenticate, clerk, requireUser } from './_lib/auth.js';
import { db } from './_lib/db.js';
import { resolveEntitlements } from './_lib/entitlements.js';
import { isKnownFocus } from './_lib/focus.js';
import { HttpError, handle, json, readJson, requireMethod } from './_lib/http.js';
import { type UserPreferences, userSettings } from './_lib/schema.js';

export default handle(async (request) => {
  const scope = new URL(request.url).searchParams.get('scope');
  if (scope === 'settings') return handleSettings(request);
  if (scope === 'billing') return handleBilling(request);
  throw new HttpError(400, 'bad_request');
});

// ── settings ───────────────────────────────────────────────────────────────
// (former /api/settings) — the signed-in user's product preferences.
//   GET  -> { preferences }
//   PUT  { preferences } -> validates a whitelist, upserts, returns { preferences }
// Auth required. No withUserLock: settings are last-write-wins per user, with
// no cross-request cap to race (unlike bank adds).

interface SettingsBody {
  preferences?: unknown;
}

async function handleSettings(request: Request): Promise<Response> {
  const userId = await requireUser(request);
  if (request.method === 'GET') return get(userId);
  requireMethod(request, 'PUT');

  const body = await readJson<SettingsBody>(request);
  const preferences = validatePreferences(body.preferences);

  const now = new Date();
  const [row] = await db
    .insert(userSettings)
    .values({ clerkUserId: userId, preferences, updatedAt: now })
    .onConflictDoUpdate({
      target: userSettings.clerkUserId,
      set: { preferences, updatedAt: now },
    })
    .returning({ preferences: userSettings.preferences });
  return json({ preferences: row.preferences });
}

async function get(userId: string): Promise<Response> {
  const [row] = await db
    .select({ preferences: userSettings.preferences })
    .from(userSettings)
    .where(eq(userSettings.clerkUserId, userId));
  return json({ preferences: row?.preferences ?? {} });
}

// Reject anything not described by UserPreferences: unknown top-level keys, a
// non-object envelope, or a quizFocuses that isn't an array of known focus
// keys. A malformed PUT changes nothing (400) rather than persisting junk.
const ALLOWED_KEYS = new Set(['quizFocuses']);

function validatePreferences(value: unknown): UserPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'bad_request', 'preferences must be an object');
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new HttpError(400, 'bad_request', `unknown preference key: ${key}`);
    }
  }

  const out: UserPreferences = {};
  if ('quizFocuses' in input) {
    const focuses = input.quizFocuses;
    if (!Array.isArray(focuses) || !focuses.every(isKnownFocus)) {
      throw new HttpError(400, 'bad_request', 'quizFocuses must be an array of known focus keys');
    }
    // Dedupe so a client can't grow the array unboundedly with repeats.
    out.quizFocuses = [...new Set(focuses)];
  }
  return out;
}

// ── billing ──────────────────────────────────────────────────────────────────
// (former /api/billing) — the caller's premium membership surface (Clerk Billing).
//   GET  -> { tier, status, renewsAt, endsAt, planSlug } for the Membership
//           section. Tier is derived through resolveEntitlements so an owner
//           reads "owner" (not "free") and a fresh token that carries the plan
//           claim reads "premium". Subscription DATES come from the Clerk
//           Backend API; a lookup failure degrades to status 'none' — it never
//           downgrades the token-derived tier and never throws to the client.
//   POST -> cancel the premium subscription item at END OF PERIOD (endNow:false,
//           D5 keep-until-period-end), then echo the refreshed status. Errors
//           are honest: 404 no_subscription ONLY when the lookup succeeded and
//           found nothing; a failed Clerk call is a retryable 503
//           billing_unavailable (never a misleading "you have no subscription").
//
// Reuses the shared Clerk backend client (CLERK_SECRET_KEY) — no new secrets.
// WH_PREMIUM_PLAN is the plan SLUG (the same identifier resolveEntitlements
// feeds to has({ plan })); the subscription item is matched to it by plan.slug.

type BillingItemStatus =
  | 'abandoned'
  | 'active'
  | 'canceled'
  | 'ended'
  | 'expired'
  | 'incomplete'
  | 'past_due'
  | 'upcoming';

// A subscription item is a live cancel target while it is still granting or
// pending — anything but a terminal/never-started state.
const LIVE_ITEM = new Set<BillingItemStatus>(['active', 'past_due', 'incomplete', 'upcoming']);

// The subset of a Clerk BillingSubscriptionItem this module reads. Kept
// structural so the pure derivations below are unit-testable without the SDK.
export interface PremiumItemShape {
  id: string;
  status: string;
  plan?: { slug?: string } | null;
  canceledAt?: number | null;
  periodEnd?: number | null;
  endedAt?: number | null;
  nextPayment?: { date: number } | null;
}

/** True when this item is the caller's live subscription to the given plan. */
export function matchesPremiumItem(item: PremiumItemShape, slug: string): boolean {
  return item.plan?.slug === slug && LIVE_ITEM.has(item.status as BillingItemStatus);
}

/** Pure status/date derivation for a matched premium item. A scheduled cancel
 *  (canceledAt set, or status 'canceled') reports keep-until-period-end via
 *  endsAt; an active item reports its next renewal via renewsAt. */
export function deriveDates(item: PremiumItemShape): {
  status: 'active' | 'canceled';
  renewsAt: string | null;
  endsAt: string | null;
} {
  const canceled = item.canceledAt != null || (item.status as BillingItemStatus) === 'canceled';
  if (canceled) {
    return {
      status: 'canceled',
      renewsAt: null,
      endsAt: iso(item.periodEnd ?? item.endedAt ?? item.nextPayment?.date),
    };
  }
  return { status: 'active', renewsAt: iso(item.nextPayment?.date ?? item.periodEnd), endsAt: null };
}

interface BillingStatusBody {
  tier: 'free' | 'premium' | 'owner';
  /** 'active' = renews; 'canceled' = ends at period end (kept until then). */
  status: 'none' | 'active' | 'canceled';
  /** ISO date of the next payment while active; null otherwise. */
  renewsAt: string | null;
  /** ISO date the access ends after a scheduled cancel; null otherwise. */
  endsAt: string | null;
  /** WH_PREMIUM_PLAN echoed so the client can start checkout for it; null when
   *  the plan is not configured yet (premium not purchasable). */
  planSlug: string | null;
}

async function handleBilling(request: Request): Promise<Response> {
  const { userId, has } = await authenticate(request);
  if (request.method === 'GET') return status(userId, has);
  if (request.method === 'POST') return cancel(userId, has);
  throw new HttpError(405, 'method_not_allowed');
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null;
}

// The user's live premium subscription item (matched to WH_PREMIUM_PLAN by plan
// slug). The two "no item" outcomes are deliberately DISTINCT (review MINOR-2):
// a lookup that SUCCEEDS with no matching item resolves null (the true "no
// subscription" — cancel maps it to 404); a Clerk call that FAILS (outage,
// network, billing disabled) throws a retryable 503 billing_unavailable, so a
// premium user mid-outage is told to retry — never that they have nothing. An
// ambiguous failure can therefore never proceed to a cancel (fail-safe).
// Takes the fetch as a thunk so the split is unit-testable without the SDK.
export async function lookupPremiumItem(
  fetchSub: () => Promise<{ subscriptionItems: PremiumItemShape[] }>,
  slug: string | undefined,
): Promise<PremiumItemShape | null> {
  if (!slug) return null;
  let items: PremiumItemShape[];
  try {
    items = (await fetchSub()).subscriptionItems;
  } catch {
    throw new HttpError(503, 'billing_unavailable', "Couldn't reach billing. Try again in a moment.");
  }
  return items.find((i) => matchesPremiumItem(i, slug)) ?? null;
}

async function premiumItem(userId: string): Promise<PremiumItemShape | null> {
  return lookupPremiumItem(
    () => clerk.billing.getUserBillingSubscription(userId),
    process.env.WH_PREMIUM_PLAN,
  );
}

async function status(userId: string, has: Awaited<ReturnType<typeof authenticate>>['has']): Promise<Response> {
  const entitlements = await resolveEntitlements(userId, has);
  const body: BillingStatusBody = {
    tier: entitlements.tier,
    status: 'none',
    renewsAt: null,
    endsAt: null,
    planSlug: process.env.WH_PREMIUM_PLAN ?? null,
  };

  // Only a premium tier has paid-subscription dates to report. Owner (allowlist)
  // and free have no premium item; skipping the lookup also avoids a needless
  // Clerk round trip on every settings open for them.
  if (entitlements.tier === 'premium') {
    try {
      const item = await premiumItem(userId);
      if (item) Object.assign(body, deriveDates(item));
    } catch {
      // GET stays fail-safe: a billing blip degrades the DATES to 'none' but
      // keeps the token-derived tier — the client renders "Premium" undated
      // rather than a 5xx or a bogus downgrade. Only cancel surfaces the 503.
    }
  }

  return json(body);
}

async function cancel(userId: string, has: Awaited<ReturnType<typeof authenticate>>['has']): Promise<Response> {
  // A Clerk lookup failure propagates as 503 billing_unavailable (retryable);
  // only a SUCCESSFUL lookup with no live item is the true 404.
  const item = await premiumItem(userId);
  if (!item) throw new HttpError(404, 'no_subscription', 'No active premium subscription to cancel.');
  // endNow:false — D5 keep-until-period-end. The user keeps premium (and every
  // banked question) until the paid period ends, then reverts to free.
  try {
    await clerk.billing.cancelSubscriptionItem(item.id, { endNow: false });
  } catch {
    // Same retryable code: the cancel may or may not have landed; the client
    // retries and the lookup/cancel pair is idempotent for a live item.
    throw new HttpError(503, 'billing_unavailable', "Couldn't reach billing. Try again in a moment.");
  }
  return status(userId, has);
}
