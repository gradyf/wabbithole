// POST /api/quiz-results {results: [{bankItemId, correct}]}
// Batch per-question counter update after a quiz round. Ownership enforced
// per row (clerk_user_id in the WHERE).

import { and, eq, sql } from 'drizzle-orm';
import { requireUser } from './_lib/auth';
import { db } from './_lib/db';
import { HttpError, handle, json, readJson, requireMethod } from './_lib/http';
import { bankItems } from './_lib/schema';

interface ResultsBody {
  results?: unknown;
}

export default handle(async (request) => {
  requireMethod(request, 'POST');
  const userId = await requireUser(request);

  const body = await readJson<ResultsBody>(request);
  const results = body.results;
  if (
    !Array.isArray(results) ||
    results.length === 0 ||
    results.length > 50 ||
    !results.every(
      (r) =>
        r &&
        typeof r === 'object' &&
        typeof (r as { bankItemId?: unknown }).bankItemId === 'string' &&
        typeof (r as { correct?: unknown }).correct === 'boolean',
    )
  ) {
    throw new HttpError(400, 'bad_request');
  }

  const updates = await Promise.all(
    (results as Array<{ bankItemId: string; correct: boolean }>).map((r) =>
      db
        .update(bankItems)
        .set({
          timesAnswered: sql`${bankItems.timesAnswered} + 1`,
          timesCorrect: sql`${bankItems.timesCorrect} + ${r.correct ? 1 : 0}`,
          lastAnsweredAt: sql`now()`,
        })
        .where(and(eq(bankItems.id, r.bankItemId), eq(bankItems.clerkUserId, userId)))
        .returning({ id: bankItems.id }),
    ),
  );
  return json({ recorded: updates.filter((u) => u.length > 0).length });
});
