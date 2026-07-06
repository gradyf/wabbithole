// /api/quiz-results — quiz round bookkeeping for a signed-in user.
//   POST {results:[{bankItemId, correct}], questionCount, correctCount}
//        -> bump each answered question's counters AND record one quiz_sessions
//           row for the round (same request, no extra round-trip).
//   GET  -> { sessions, totals } — the user's last 50 rounds (newest first)
//           plus lifetime totals for the History aggregate line.
// Ownership is enforced per row (clerk_user_id in the WHERE / on the insert).
// Anonymous players never reach here: every method requires a Clerk user.

import { and, desc, eq, sql } from 'drizzle-orm';
import { requireUser } from './_lib/auth.js';
import { db } from './_lib/db.js';
import { HttpError, handle, json, readJson } from './_lib/http.js';
import { bankItems, quizSessions } from './_lib/schema.js';

const HISTORY_LIMIT = 50;
const MAX_RESULTS = 50;
// A round holds at most a handful of questions; 100 is generous headroom and
// keeps a single row's counts sane.
const MAX_QUESTIONS = 100;

interface ResultsBody {
  results?: unknown;
  questionCount?: unknown;
  correctCount?: unknown;
}

interface QuizResult {
  bankItemId: string;
  correct: boolean;
}

export default handle(async (request) => {
  const userId = await requireUser(request);

  if (request.method === 'GET') return list(userId);
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');

  const body = await readJson<ResultsBody>(request);
  return record(userId, parseResults(body), parseSession(body));
});

// --- validation (fires before any DB query, so 400s are testable without the
// quiz_sessions table existing locally) ---

function parseResults(body: ResultsBody): QuizResult[] {
  const { results } = body;
  if (
    !Array.isArray(results) ||
    results.length === 0 ||
    results.length > MAX_RESULTS ||
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
  return results as QuizResult[];
}

function parseSession(body: ResultsBody): { questionCount: number; correctCount: number } {
  const { questionCount, correctCount } = body;
  if (
    !intInRange(questionCount, 1, MAX_QUESTIONS) ||
    !intInRange(correctCount, 0, questionCount)
  ) {
    throw new HttpError(400, 'bad_request');
  }
  return { questionCount, correctCount };
}

function intInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// --- handlers ---

async function record(
  userId: string,
  results: QuizResult[],
  session: { questionCount: number; correctCount: number },
): Promise<Response> {
  const updates = await Promise.all(
    results.map((r) =>
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

  await db.insert(quizSessions).values({
    clerkUserId: userId,
    questionCount: session.questionCount,
    correctCount: session.correctCount,
  });

  return json({ recorded: updates.filter((u) => u.length > 0).length });
}

async function list(userId: string): Promise<Response> {
  const sessions = await db
    .select({
      playedAt: quizSessions.playedAt,
      questionCount: quizSessions.questionCount,
      correctCount: quizSessions.correctCount,
    })
    .from(quizSessions)
    .where(eq(quizSessions.clerkUserId, userId))
    .orderBy(desc(quizSessions.playedAt))
    .limit(HISTORY_LIMIT);

  // Lifetime totals (over every round, not just the returned page) so the
  // aggregate line stays accurate past the 50-row window.
  const [totals] = await db
    .select({
      rounds: sql<number>`count(*)::int`,
      questions: sql<number>`coalesce(sum(${quizSessions.questionCount}), 0)::int`,
      correct: sql<number>`coalesce(sum(${quizSessions.correctCount}), 0)::int`,
    })
    .from(quizSessions)
    .where(eq(quizSessions.clerkUserId, userId));

  return json({ sessions, totals: totals ?? { rounds: 0, questions: 0, correct: 0 } });
}
