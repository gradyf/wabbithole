// POST /api/report {questionId}
// The moderation floor (Phase 7, [C12]): an authenticated user flags a bad
// communal question. Reports are idempotent per user (a duplicate is a no-op and
// never advances the count); once THREE distinct users have reported a question
// it is auto-hidden (article_questions.hidden=true), which removes it from every
// serve/quiz read (Task 28) WITHOUT deleting the row — so existing bank_items
// FKs, and the quiz of anyone who already banked it, keep working.

import { eq, sql } from 'drizzle-orm';
import { authenticate } from './_lib/auth.js';
import { db } from './_lib/db.js';
import { HttpError, handle, json, readJson, requireMethod } from './_lib/http.js';
import { articleQuestions, questionReports } from './_lib/schema.js';

// Distinct reporters needed to auto-hide a question.
const HIDE_THRESHOLD = 3;

interface ReportBody {
  questionId?: unknown;
}

export default handle(async (request) => {
  requireMethod(request, 'POST');
  const { userId } = await authenticate(request);

  const body = await readJson<ReportBody>(request);
  const questionId = body.questionId;
  if (typeof questionId !== 'string' || !/^[0-9a-f-]{36}$/.test(questionId)) {
    throw new HttpError(400, 'bad_request');
  }

  // Idempotent per (user, question): the unique index makes a re-tap a no-op via
  // onConflictDoNothing, so one person can never advance the distinct count.
  const inserted = await db
    .insert(questionReports)
    .values({ clerkUserId: userId, questionId })
    .onConflictDoNothing()
    .returning({ id: questionReports.id });

  // Only a genuinely NEW distinct reporter can move the count, so the hide check
  // runs on a real insert only (a duplicate skips it entirely).
  if (inserted.length > 0) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(questionReports)
      .where(eq(questionReports.questionId, questionId));
    if (count >= HIDE_THRESHOLD) {
      await db
        .update(articleQuestions)
        .set({ hidden: true })
        .where(eq(articleQuestions.id, questionId));
    }
  }

  // Always the same friendly acknowledgement — the reporter should not learn
  // whether their report was the one that tipped the question over.
  return json({ ok: true });
});
