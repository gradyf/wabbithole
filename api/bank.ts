// /api/bank — the user's trivia bank.
//   GET               -> all bank items with question + source article
//   POST {action:'add', questionIds}     -> link questions (idempotent)
//   POST {action:'remove', bankItemIds}  -> unlink items

import { and, desc, eq, inArray } from 'drizzle-orm';
import { requireUser } from './_lib/auth.js';
import { db, withUserLock } from './_lib/db.js';
import { HttpError, handle, json, readJson } from './_lib/http.js';
import { WEEKLY_ADD_CAP, weeklyRemaining } from './_lib/limits.js';
import { articleQuestions, articles, bankItems } from './_lib/schema.js';

interface BankPost {
  action?: unknown;
  questionIds?: unknown;
  bankItemIds?: unknown;
}

export default handle(async (request) => {
  const userId = await requireUser(request);

  if (request.method === 'GET') return list(userId);
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');

  const body = await readJson<BankPost>(request);
  if (body.action === 'add') return add(userId, idList(body.questionIds));
  if (body.action === 'remove') return remove(userId, idList(body.bankItemIds));
  throw new HttpError(400, 'bad_request');
});

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

async function list(userId: string): Promise<Response> {
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
  return json({ items: rows, remaining: await weeklyRemaining(userId), cap: WEEKLY_ADD_CAP });
}

async function add(userId: string, questionIds: string[]): Promise<Response> {
  // Only questions that actually exist; insert is idempotent per user+question.
  const existing = await db
    .select({ id: articleQuestions.id })
    .from(articleQuestions)
    .where(inArray(articleQuestions.id, questionIds));

  // Cap check and insert share a per-user lock so two concurrent adds
  // can't both spend the same remaining slots.
  const result = await withUserLock(userId, async (tx) => {
    const remaining = await weeklyRemaining(userId, tx);
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
    throw new HttpError(
      429,
      'weekly_cap',
      `Your bank takes ${WEEKLY_ADD_CAP} new questions a week. It has room again soon.`,
    );
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
