// The wallet guard for paid trivia generation. Every paid Haiku call (extract
// today, ad-hoc later) writes one append-only `generation_log` row BEFORE the
// call, so a timeout or crash still counts — there is no free-retry hole. Three
// gates run before any spend, in this order:
//
//   1. Kill switch  (WH_GENERATION_KILL_SWITCH) — pauses ALL generation for
//      everyone (owners included). Zero-deploy panic button.
//   2. Global ceiling (WH_GENERATION_DAILY_BUDGET, default 500 / rolling 24h) —
//      protects the wallet from everyone, owners included, against a viral
//      moment or an abuser. Owners are NOT exempt from this one.
//   3. Per-user cap (12 / rolling 24h) — non-owners only; owner accounts bypass.
//
// Env vars (the orchestrator sets these at deploy; the defaults mean NONE are
// strictly required for correct behavior):
//   WH_GENERATION_DAILY_BUDGET  integer >= 0, default 500. Global fresh-
//                               generation ceiling per rolling 24h. Tune once
//                               real traffic is visible.
//   WH_GENERATION_KILL_SWITCH   set to 1 / true / on / yes to pause all
//                               generation immediately. Unset/anything else =
//                               off. Read per request, so flipping it takes
//                               effect on the next call without a redeploy.

import { and, eq, gte, sql } from 'drizzle-orm';
import { db, type DbTx } from './db.js';
import { HttpError } from './http.js';
import { generationLog } from './schema.js';

/** Global fresh generations allowed per rolling 24h. Env-overridable (D7). */
export const GLOBAL_DAILY_BUDGET = readIntEnv('WH_GENERATION_DAILY_BUDGET', 500);

/** Fresh generations per user per rolling 24h for non-owners (D8, was 25). */
export const PER_USER_DAILY_CAP = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

// Both the ceiling and the kill switch surface the same friendly 503 — the user
// should not care which guard tripped, only that trivia is paused right now.
const PAUSED_CODE = 'generation_paused';
const PAUSED_MESSAGE = 'Trivia is resting today. Wandering still works.';

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Read fresh per request so flipping the env var pauses generation on the next
 * call without a redeploy. */
function killSwitchOn(): boolean {
  const raw = (process.env.WH_GENERATION_KILL_SWITCH ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Count of paid generations across all users in the last rolling 24h. */
export async function globalGenerationsToday(executor: typeof db | DbTx = db): Promise<number> {
  const dayAgo = new Date(Date.now() - DAY_MS);
  const [{ count }] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(generationLog)
    .where(gte(generationLog.createdAt, dayAgo));
  return count;
}

/** Count of one user's paid generations in the last rolling 24h. */
export async function userGenerationsToday(
  userId: string,
  executor: typeof db | DbTx = db,
): Promise<number> {
  const dayAgo = new Date(Date.now() - DAY_MS);
  const [{ count }] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(generationLog)
    .where(and(eq(generationLog.clerkUserId, userId), gte(generationLog.createdAt, dayAgo)));
  return count;
}

/** The two count reads the guard depends on. Injectable so the guard can be
 * unit-tested without a live `generation_log` table (it does not exist until
 * the migration is applied). Production callers use the default. */
export interface GenerationCounts {
  global: () => Promise<number>;
  user: (userId: string) => Promise<number>;
}
const liveCounts: GenerationCounts = {
  global: () => globalGenerationsToday(),
  user: (userId) => userGenerationsToday(userId),
};

/** Gate a paid generation before any spend. Call on cache MISS only — cache
 * hits are free and must never be gated. Throws:
 *   - 503 generation_paused if the kill switch is on OR the global ceiling is
 *     hit (applies to EVERYONE, owners included — it protects the wallet).
 *   - 429 daily_cap if a non-owner is at/over their per-user cap (owners bypass).
 * The global ceiling is checked before the per-user cap so a paused site tells
 * every user the same warm thing rather than an owner seeing a per-user 429. */
export async function enforceGenerationBudget(
  userId: string,
  isOwner: boolean,
  counts: GenerationCounts = liveCounts,
): Promise<void> {
  if (killSwitchOn()) {
    throw new HttpError(503, PAUSED_CODE, PAUSED_MESSAGE);
  }
  if ((await counts.global()) >= GLOBAL_DAILY_BUDGET) {
    throw new HttpError(503, PAUSED_CODE, PAUSED_MESSAGE);
  }
  if (!isOwner && (await counts.user(userId)) >= PER_USER_DAILY_CAP) {
    throw new HttpError(429, 'daily_cap', 'Daily extraction limit reached. Try again tomorrow.');
  }
}

/** Write the append-only accounting row. MUST be called BEFORE the paid call so
 * a timeout or crash still counts against both caps. `articleId` is audit-only. */
export async function logGeneration(
  userId: string,
  kind: 'extract' | 'adhoc',
  articleId: number | null,
  executor: typeof db | DbTx = db,
): Promise<void> {
  await executor.insert(generationLog).values({ clerkUserId: userId, kind, articleId });
}
