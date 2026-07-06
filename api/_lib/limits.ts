// The user-facing allowance: bank additions per rolling 7 days, counted
// whether or not the questions were already in the global cache. Extraction
// spend has its own quiet guard in extract.ts; this is the product cap.
//
// Counted from live bank rows' added_at, so removing a question frees a slot
// at the price of losing the question — acceptable, not worth tombstones.

import { and, eq, gte, sql } from 'drizzle-orm';
import { clerk } from './auth.js';
import { db, type DbTx } from './db.js';
import { bankItems } from './schema.js';

export const WEEKLY_ADD_CAP = 10;

// Owner accounts, matched by email so the allowance survives the dev->prod
// Clerk instance switch. Keyed by user id in a process-lifetime cache; a Clerk
// lookup failure never grants unlimited (fail closed to the normal cap).
const unlimitedEmails = new Set(
  (process.env.WH_UNLIMITED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
const unlimitedByUser = new Map<string, boolean>();

export async function isUnlimited(userId: string): Promise<boolean> {
  const cached = unlimitedByUser.get(userId);
  if (cached !== undefined) return cached;
  if (unlimitedEmails.size === 0) {
    unlimitedByUser.set(userId, false);
    return false;
  }
  try {
    const user = await clerk.users.getUser(userId);
    // Verified addresses only: anyone can attach someone else's email to
    // their own profile unverified, which must never grant unlimited.
    const match = user.emailAddresses.some(
      (e) =>
        e.verification?.status === 'verified' &&
        unlimitedEmails.has(e.emailAddress.toLowerCase()),
    );
    unlimitedByUser.set(userId, match);
    return match;
  } catch {
    return false;
  }
}

/** Pass the executor when counting inside a locked transaction; the
 * default reads through the plain HTTP connection (display only). */
export async function weeklyAddsUsed(userId: string, executor: typeof db | DbTx = db): Promise<number> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [{ count }] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(bankItems)
    .where(and(eq(bankItems.clerkUserId, userId), gte(bankItems.addedAt, weekAgo)));
  return count;
}

/** Slots left this week, or `null` for owner accounts with no cap. */
export async function weeklyRemaining(
  userId: string,
  executor: typeof db | DbTx = db,
): Promise<number | null> {
  if (await isUnlimited(userId)) return null;
  return Math.max(0, WEEKLY_ADD_CAP - (await weeklyAddsUsed(userId, executor)));
}
