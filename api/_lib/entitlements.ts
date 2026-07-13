// The single entitlement authority. Every consumer that needs to know a
// caller's tier (question ceiling, ad-hoc access, weekly/ad-hoc caps) resolves
// it here and nowhere else.
//
// Layering, widest first:  owner (email allowlist) ⊃ premium (plan claim) ⊃ free.
// Fails CLOSED to free on any error — a broken/absent claim under-grants (safe),
// never over-grants. The premium check reads `has({ plan })` fresh from the
// session token per request: NO process-lifetime cache, because subscriptions
// are revocable and the token is always current. (`isUnlimited` keeps its own
// owner cache; ownership is stable, unlike a paid plan.)

import type { Has } from './auth.js';
import { isUnlimited } from './limits.js';
import { EXTRACTION_CEILING, FREE_CEILING } from './prompt.js';

export type Tier = 'free' | 'premium' | 'owner';

export interface Entitlements {
  tier: Tier;
  /** MC questions served per article: free 5, premium/owner 25. */
  questionCeiling: number;
  /** Highlight -> generate (ad-hoc) access. */
  adHoc: boolean;
  /** Bank-adds per rolling 7 days: free 10, premium 50, owner unlimited. */
  weeklyAddCap: number | null;
  /** Ad-hoc generations per day: free 0, premium 10, owner unlimited. */
  adhocDailyCap: number | null;
}

const FREE: Entitlements = {
  tier: 'free',
  questionCeiling: FREE_CEILING,
  adHoc: false,
  weeklyAddCap: 10,
  adhocDailyCap: 0,
};
const PREMIUM: Entitlements = {
  tier: 'premium',
  questionCeiling: EXTRACTION_CEILING,
  adHoc: true,
  weeklyAddCap: 50,
  adhocDailyCap: 10,
};
const OWNER: Entitlements = {
  tier: 'owner',
  questionCeiling: EXTRACTION_CEILING,
  adHoc: true,
  weeklyAddCap: null,
  adhocDailyCap: null,
};

export async function resolveEntitlements(userId: string, has: Has): Promise<Entitlements> {
  // Owner wins over everything. isUnlimited already fails closed internally.
  try {
    if (await isUnlimited(userId)) return OWNER;
  } catch {
    // fall through — never let an owner-check failure over-grant.
  }
  // Premium: the plan claim in the session token. Read fresh, never cached.
  try {
    const plan = process.env.WH_PREMIUM_PLAN;
    if (plan && has({ plan })) return PREMIUM;
  } catch {
    // fall through to free — fail closed.
  }
  return FREE;
}
