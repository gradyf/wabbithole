// The user-facing allowance: bank additions per rolling 7 days, counted
// whether or not the questions were already in the global cache. Extraction
// spend has its own quiet guard in extract.ts; this is the product cap.
//
// Counted from live bank rows' added_at, so removing a question frees a slot
// at the price of losing the question — acceptable, not worth tombstones.

import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from './db.js';
import { bankItems } from './schema.js';

export const WEEKLY_ADD_CAP = 10;

export async function weeklyAddsUsed(userId: string): Promise<number> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bankItems)
    .where(and(eq(bankItems.clerkUserId, userId), gte(bankItems.addedAt, weekAgo)));
  return count;
}

export async function weeklyRemaining(userId: string): Promise<number> {
  return Math.max(0, WEEKLY_ADD_CAP - (await weeklyAddsUsed(userId)));
}
