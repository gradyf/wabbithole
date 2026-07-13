// /api/bank — the user's trivia bank.
//   GET               -> all bank items with question + source article
//   POST {action:'add', questionIds}     -> link questions (idempotent)
//   POST {action:'remove', bankItemIds}  -> unlink items

import { and, desc, eq, inArray } from 'drizzle-orm';
import { authenticate } from './_lib/auth.js';
import { type DbTx, db, withUserLock } from './_lib/db.js';
import { type Entitlements, resolveEntitlements } from './_lib/entitlements.js';
import { HttpError, handle, json, readJson } from './_lib/http.js';
import { weeklyAddsUsed } from './_lib/limits.js';
import { articleQuestions, articles, bankItems } from './_lib/schema.js';

interface BankPost {
  action?: unknown;
  questionIds?: unknown;
  bankItemIds?: unknown;
}

export default handle(async (request) => {
  const { userId, has } = await authenticate(request);
  // The tier decides the weekly bank-add cap: free 10 / premium 50 / owner
  // unlimited. Resolved once per request and threaded into list() + add().
  const entitlements = await resolveEntitlements(userId, has);

  if (request.method === 'GET') return list(userId, entitlements);
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');

  const body = await readJson<BankPost>(request);
  if (body.action === 'add') return add(userId, entitlements, idList(body.questionIds));
  if (body.action === 'remove') return remove(userId, idList(body.bankItemIds));
  throw new HttpError(400, 'bad_request');
});

// Slots left this rolling week for this tier, or null for owner (uncapped).
// Reads live bank rows via the given executor, so the count runs inside the
// per-user lock in add() (no add/add race can overspend the cap).
async function remainingFor(
  ent: Entitlements,
  userId: string,
  executor: typeof db | DbTx = db,
): Promise<number | null> {
  if (ent.weeklyAddCap === null) return null;
  return Math.max(0, ent.weeklyAddCap - (await weeklyAddsUsed(userId, executor)));
}

function idList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 100 ||
    !value.every((v) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v))
  ) {
    throw new HttpError(400, 'bad_request');
  }
  return value;
}

async function list(userId: string, ent: Entitlements): Promise<Response> {
  const rows = await db
    .select({
      bankItemId: bankItems.id,
      addedAt: bankItems.addedAt,
      timesAnswered: bankItems.timesAnswered,
      timesCorrect: bankItems.timesCorrect,
      questionId: articleQuestions.id,
      prompt: articleQuestions.prompt,
      choices: articleQuestions.choices,
      answerIndex: articleQuestions.answerIndex,
      explanation: articleQuestions.explanation,
      imageUrl: articleQuestions.imageUrl,
      imageSourceUrl: articleQuestions.imageSourceUrl,
      articleLang: articles.lang,
      articleTitle: articles.title,
    })
    .from(bankItems)
    .innerJoin(articleQuestions, eq(bankItems.questionId, articleQuestions.id))
    .innerJoin(articles, eq(articleQuestions.articleId, articles.id))
    .where(eq(bankItems.clerkUserId, userId))
    .orderBy(desc(bankItems.addedAt));
  return json({ items: rows, remaining: await remainingFor(ent, userId), cap: ent.weeklyAddCap });
}

async function add(userId: string, ent: Entitlements, questionIds: string[]): Promise<Response> {
  // Only questions that actually exist; insert is idempotent per user+question.
  const existing = await db
    .select({ id: articleQuestions.id })
    .from(articleQuestions)
    .where(inArray(articleQuestions.id, questionIds));

  // Cap check and insert share a per-user lock so two concurrent adds
  // can't both spend the same remaining slots.
  const result = await withUserLock(userId, async (tx) => {
    const remaining = await remainingFor(ent, userId, tx);
    if (remaining === 0 || existing.length === 0) return { added: 0, remaining };

    // Owner accounts (remaining null) take everything; otherwise the cap
    // bounds how many can land this request. The client mirrors this.
    const limit = remaining ?? existing.length;
    const inserted = await tx
      .insert(bankItems)
      .values(existing.slice(0, limit).map((q) => ({ clerkUserId: userId, questionId: q.id })))
      .onConflictDoNothing()
      .returning({ id: bankItems.id });
    return { added: inserted.length, remaining: remaining === null ? null : remaining - inserted.length };
  });

  if (result.added === 0 && result.remaining === 0) {
    // A friendly code the client renders as a soft line (and, for free users,
    // a quiet premium nudge) — never a modal. Message stays tier-neutral; the
    // "premium raises it" pitch lives client-side, gated on the free tier.
    throw new HttpError(429, 'weekly_cap', 'Weekly bank limit reached. It has room again soon.');
  }
  return json(result);
}

async function remove(userId: string, bankItemIds: string[]): Promise<Response> {
  const deleted = await db
    .delete(bankItems)
    .where(and(eq(bankItems.clerkUserId, userId), inArray(bankItems.id, bankItemIds)))
    .returning({ id: bankItems.id });
  return json({ removed: deleted.length });
}
