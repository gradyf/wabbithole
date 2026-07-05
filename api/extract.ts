// POST /api/extract {lang, title}
// Returns the article's trivia questions, generating them once globally:
// cache hit -> instant; miss -> daily cap, pending-lock, fetch text, one
// structured Haiku call, insert, return. Auth required.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { and, eq, gte, lt, ne, sql } from 'drizzle-orm';
import { requireUser } from './_lib/auth.js';
import { db } from './_lib/db.js';
import { HttpError, handle, json, readJson, requireMethod } from './_lib/http.js';
import {
  EXTRACTION_MODEL,
  PROMPT_VERSION,
  QuestionsSchema,
  buildExtractionPrompt,
  validQuestions,
} from './_lib/prompt.js';
import { articleQuestions, articles, extractions } from './_lib/schema.js';
import { fetchArticleSource, validLang } from './_lib/wikipedia.js';

const DAILY_CAP = 25; // fresh extractions per user per day; cache hits are free
const STALE_LOCK_MS = 2 * 60 * 1000;

interface ExtractBody {
  lang?: unknown;
  title?: unknown;
}

export default handle(async (request) => {
  requireMethod(request, 'POST');
  const userId = await requireUser(request);

  const body = await readJson<ExtractBody>(request);
  if (!validLang(body.lang) || typeof body.title !== 'string' || !body.title.trim()) {
    throw new HttpError(400, 'bad_request');
  }
  const lang = body.lang;

  // Canonicalize via the summary endpoint (follows redirects) so cache keys
  // never fragment across redirect aliases.
  const source = await fetchArticleSource(lang, body.title.trim());

  const [article] = await db
    .insert(articles)
    .values({ lang, title: source.canonicalTitle })
    .onConflictDoNothing({ target: [articles.lang, articles.title] })
    .returning();
  const articleRow =
    article ??
    (await db
      .select()
      .from(articles)
      .where(and(eq(articles.lang, lang), eq(articles.title, source.canonicalTitle))))[0];

  const cached = await loadQuestions(articleRow.id);
  if (cached.length > 0) return respond(source, cached, true);

  await enforceDailyCap(userId);
  const lockId = await acquireLock(articleRow.id, userId);

  // Someone may have finished between our cache read and the lock.
  const cachedAfterLock = await loadQuestions(articleRow.id);
  if (cachedAfterLock.length > 0) {
    await db.delete(extractions).where(eq(extractions.id, lockId));
    return respond(source, cachedAfterLock, true);
  }

  try {
    const generated = await generateQuestions(source);
    const rows = await db
      .insert(articleQuestions)
      .values(
        generated.map((q) => ({
          articleId: articleRow.id,
          prompt: q.prompt,
          choices: q.choices,
          answerIndex: q.answerIndex,
          explanation: q.explanation,
          promptVersion: PROMPT_VERSION,
          model: EXTRACTION_MODEL,
        })),
      )
      .returning();
    await db.update(extractions).set({ status: 'done' }).where(eq(extractions.id, lockId));
    return respond(source, rows, false);
  } catch (err) {
    await db.update(extractions).set({ status: 'failed' }).where(eq(extractions.id, lockId));
    throw err;
  }
});

type QuestionRow = typeof articleQuestions.$inferSelect;

async function loadQuestions(articleId: number): Promise<QuestionRow[]> {
  return db
    .select()
    .from(articleQuestions)
    .where(
      and(
        eq(articleQuestions.articleId, articleId),
        eq(articleQuestions.promptVersion, PROMPT_VERSION),
      ),
    );
}

async function enforceDailyCap(userId: string): Promise<void> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(extractions)
    .where(
      and(
        eq(extractions.clerkUserId, userId),
        gte(extractions.createdAt, dayAgo),
        ne(extractions.status, 'failed'),
      ),
    );
  if (count >= DAILY_CAP) {
    throw new HttpError(429, 'daily_cap', 'Daily extraction limit reached. Try again tomorrow.');
  }
}

// The partial unique index (one pending row per article+version) is the lock.
// A pending row older than STALE_LOCK_MS is from a crashed run; take it over.
async function acquireLock(articleId: number, userId: string): Promise<number> {
  const inserted = await db
    .insert(extractions)
    .values({ articleId, clerkUserId: userId, promptVersion: PROMPT_VERSION })
    .onConflictDoNothing()
    .returning({ id: extractions.id });
  if (inserted.length > 0) return inserted[0].id;

  const staleCutoff = new Date(Date.now() - STALE_LOCK_MS);
  const taken = await db
    .update(extractions)
    .set({ clerkUserId: userId, createdAt: sql`now()` })
    .where(
      and(
        eq(extractions.articleId, articleId),
        eq(extractions.promptVersion, PROMPT_VERSION),
        eq(extractions.status, 'pending'),
        lt(extractions.createdAt, staleCutoff),
      ),
    )
    .returning({ id: extractions.id });
  if (taken.length > 0) return taken[0].id;

  throw new HttpError(409, 'extraction_in_progress', 'This article is being extracted right now. Try again in a few seconds.');
}

async function generateQuestions(source: {
  displayTitle: string;
  description?: string;
  text: string;
}) {
  const client = new Anthropic(); // ANTHROPIC_API_KEY from env
  const res = await client.messages.parse({
    model: EXTRACTION_MODEL,
    max_tokens: 2500,
    messages: [
      {
        role: 'user',
        content: buildExtractionPrompt({
          title: source.displayTitle,
          description: source.description,
          text: source.text,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(QuestionsSchema) },
  });
  // Cost visibility: one line per paid call (REVIEW cost check).
  console.log('extraction usage', JSON.stringify(res.usage));

  const questions = validQuestions(res.parsed_output?.questions ?? []).slice(0, 5);
  if (questions.length < 3) {
    throw new HttpError(502, 'extraction_failed', 'Could not generate good questions for this article.');
  }
  return questions;
}

function respond(
  source: { canonicalTitle: string; displayTitle: string; description?: string },
  rows: QuestionRow[],
  cachedHit: boolean,
): Response {
  return json({
    article: {
      title: source.canonicalTitle,
      displayTitle: source.displayTitle,
      description: source.description,
    },
    cached: cachedHit,
    questions: rows.map((r) => ({
      id: r.id,
      prompt: r.prompt,
      choices: r.choices,
      answerIndex: r.answerIndex,
      explanation: r.explanation,
      imageUrl: r.imageUrl,
      imageSourceUrl: r.imageSourceUrl,
    })),
  });
}
