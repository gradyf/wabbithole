// /api/billing — the caller's premium membership surface (Clerk Billing).
//   GET  -> { tier, status, renewsAt, endsAt, planSlug } for the Membership
//           section. Tier is derived through resolveEntitlements so an owner
//           reads "owner" (not "free") and a fresh token that carries the plan
//           claim reads "premium". Subscription DATES come from the Clerk
//           Backend API; a lookup failure degrades to status 'none' — it never
//           downgrades the token-derived tier and never throws to the client.
//   POST -> cancel the premium subscription item at END OF PERIOD (endNow:false,
//           D5 keep-until-period-end), then echo the refreshed status.
//
// Reuses the shared Clerk backend client (CLERK_SECRET_KEY) — no new secrets.
// WH_PREMIUM_PLAN is the plan SLUG (the same identifier resolveEntitlements
// feeds to has({ plan })); the subscription item is matched to it by plan.slug.

import { authenticate, clerk } from './_lib/auth.js';
import { resolveEntitlements } from './_lib/entitlements.js';
import { HttpError, handle, json } from './_lib/http.js';

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

export default handle(async (request) => {
  const { userId, has } = await authenticate(request);
  if (request.method === 'GET') return status(userId, has);
  if (request.method === 'POST') return cancel(userId, has);
  throw new HttpError(405, 'method_not_allowed');
});

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null;
}

// The user's live premium subscription item (matched to WH_PREMIUM_PLAN by
// plan slug), or null. Any lookup error (billing not enabled, no subscription,
// network) resolves to null so the surface fails safe rather than throwing.
async function premiumItem(userId: string) {
  const slug = process.env.WH_PREMIUM_PLAN;
  if (!slug) return null;
  try {
    const sub = await clerk.billing.getUserBillingSubscription(userId);
    return sub.subscriptionItems.find((i) => matchesPremiumItem(i, slug)) ?? null;
  } catch {
    return null;
  }
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
    const item = await premiumItem(userId);
    if (item) Object.assign(body, deriveDates(item));
  }

  return json(body);
}

async function cancel(userId: string, has: Awaited<ReturnType<typeof authenticate>>['has']): Promise<Response> {
  const item = await premiumItem(userId);
  if (!item) throw new HttpError(404, 'no_subscription', 'No active premium subscription to cancel.');
  // endNow:false — D5 keep-until-period-end. The user keeps premium (and every
  // banked question) until the paid period ends, then reverts to free.
  await clerk.billing.cancelSubscriptionItem(item.id, { endNow: false });
  return status(userId, has);
}
