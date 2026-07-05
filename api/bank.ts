// /api/bank — the user's trivia bank.
//   GET               -> all bank items with question + source article
//   POST {action:'add', questionIds}     -> link questions (idempotent)
//   POST {action:'remove', bankItemIds}  -> unlink items

import { and, desc, eq, inArray } from 'drizzle-orm';
import { requireUser } from './_lib/auth.js';
import { db } from './_lib/db.js';
import { HttpError, handle, json, readJson } from './_lib/http.js';
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
  return json({ items: rows });
}

async function add(userId: string, questionIds: string[]): Promise<Response> {
  // Only questions that actually exist; insert is idempotent per user+question.
  const existing = await db
    .select({ id: articleQuestions.id })
    .from(articleQuestions)
    .where(inArray(articleQuestions.id, questionIds));
  if (existing.length === 0) return json({ added: 0 });

  const inserted = await db
    .insert(bankItems)
    .values(existing.map((q) => ({ clerkUserId: userId, questionId: q.id })))
    .onConflictDoNothing()
    .returning({ id: bankItems.id });
  return json({ added: inserted.length });
}

async function remove(userId: string, bankItemIds: string[]): Promise<Response> {
  const deleted = await db
    .delete(bankItems)
    .where(and(eq(bankItems.clerkUserId, userId), inArray(bankItems.id, bankItemIds)))
    .returning({ id: bankItems.id });
  return json({ removed: deleted.length });
}
