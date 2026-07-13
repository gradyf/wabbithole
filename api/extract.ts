// POST /api/extract {lang, title}
// Returns the article's trivia questions, generating them once globally:
// cache hit -> instant; miss -> daily cap, pending-lock, fetch text, one
// structured Haiku call, insert, return. Auth required.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { and, eq, lt, sql } from 'drizzle-orm';
import { authenticate } from './_lib/auth.js';
import { enforceGenerationBudget, logGeneration } from './_lib/budget.js';
import { db } from './_lib/db.js';
import { type Entitlements, resolveEntitlements } from './_lib/entitlements.js';
import { HttpError, handle, json, readJson, requireMethod } from './_lib/http.js';
import { WEEKLY_ADD_CAP, weeklyRemaining } from './_lib/limits.js';
import {
  EXTRACTION_CEILING,
  EXTRACTION_MODEL,
  PROMPT_VERSION,
  QuestionsSchema,
  buildExtractionPrompt,
  validQuestions,
} from './_lib/prompt.js';
import { articleQuestions, articles, extractions } from './_lib/schema.js';
import { fetchArticleSource, validLang } from './_lib/wikipedia.js';

const STALE_LOCK_MS = 2 * 60 * 1000;

interface ExtractBody {
  lang?: unknown;
  title?: unknown;
}

export default handle(async (request) => {
  requireMethod(request, 'POST');
  const { userId, has } = await authenticate(request);

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

  // The serving tier (question ceiling). Resolved once and used by every
  // respond() path so a cache hit and a fresh generation serve identically.
  const entitlements = await resolveEntitlements(userId, has);

  const cached = await loadQuestions(articleRow.id);
  if (cached.length > 0) return respond(source, cached, true, userId, entitlements);

  // Wallet guard (cache misses only — hits above are free). The kill switch and
  // global daily ceiling stop everyone including owners; the per-user cap
  // exempts owners. Owner status is the resolved tier (same isUnlimited source).
  const isOwner = entitlements.tier === 'owner';
  await enforceGenerationBudget(userId, isOwner);

  const lockId = await acquireLock(articleRow.id, userId);

  // Someone may have finished between our cache read and the lock.
  const cachedAfterLock = await loadQuestions(articleRow.id);
  if (cachedAfterLock.length > 0) {
    await db.delete(extractions).where(eq(extractions.id, lockId));
    return respond(source, cachedAfterLock, true, userId, entitlements);
  }

  try {
    // Count before we spend: a timeout or crash during generateQuestions still
    // leaves this row, so the attempt counts against both caps (no free retry).
    await logGeneration(userId, 'extract', articleRow.id);
    const generated = await generateQuestions(source);
    const rows = await db
      .insert(articleQuestions)
      .values(
        // The model emits most-memorable-first, so its output index IS the rank
        // (0 = most memorable). Serving slices free callers to the top ranks.
        generated.map((q, i) => ({
          articleId: articleRow.id,
          prompt: q.prompt,
          choices: q.choices,
          answerIndex: q.answerIndex,
          explanation: q.explanation,
          rank: i,
          promptVersion: PROMPT_VERSION,
          model: EXTRACTION_MODEL,
        })),
      )
      .returning();
    await db.update(extractions).set({ status: 'done' }).where(eq(extractions.id, lockId));
    return respond(source, rows, false, userId, entitlements);
  } catch (err) {
    await db.update(extractions).set({ status: 'failed' }).where(eq(extractions.id, lockId));
    throw err;
  }
});

type QuestionRow = typeof articleQuestions.$inferSelect;

// Returns ALL rows for the article+version, unfiltered, ordered by rank then
// age (NULL ranks — old rows, flag rows — sort last). serveQuestions does the
// per-tier partition; every other read (backward-compat, flags in Task 29)
// starts from this full ordered set.
async function loadQuestions(articleId: number): Promise<QuestionRow[]> {
  return db
    .select()
    .from(articleQuestions)
    .where(
      and(
        eq(articleQuestions.articleId, articleId),
        eq(articleQuestions.promptVersion, PROMPT_VERSION),
      ),
    )
    .orderBy(sql`${articleQuestions.rank} NULLS LAST, ${articleQuestions.createdAt}`);
}

// Partition the full pool into what a tier is served. Flag rows are always
// included for every tier and never rank-sliced; MC rows are sorted by rank
// (NULLs last) then age and sliced to the tier's ceiling. hidden rows and
// ad-hoc rows never appear in the curated panel. (No flag rows exist until
// Task 29 — this must simply be correct when they do.)
export function serveQuestions(rows: QuestionRow[], tier: Entitlements): QuestionRow[] {
  const visible = rows.filter((r) => !r.hidden && r.origin === 'extract');
  const flags = visible.filter((r) => r.type === 'flag');
  const mc = visible
    .filter((r) => r.type === 'mc')
    .sort((a, b) => {
      const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.createdAt.getTime() - b.createdAt.getTime();
    })
    .slice(0, tier.questionCeiling);
  return [...flags, ...mc];
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
    // Headroom for EXTRACTION_CEILING (25) questions: ~25 x ~130 tok ≈ 3.3k
    // typical; 6000 is margin, not the ceiling. Paired with maxDuration 60
    // (vercel.json) so the larger call finishes inside the function window.
    max_tokens: 6000,
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

  const questions = validQuestions(res.parsed_output?.questions ?? []).slice(0, EXTRACTION_CEILING);
  if (questions.length < 3) {
    throw new HttpError(502, 'extraction_failed', 'Could not generate good questions for this article.');
  }
  return questions;
}

async function respond(
  source: { canonicalTitle: string; displayTitle: string; description?: string },
  rows: QuestionRow[],
  cachedHit: boolean,
  userId: string,
  entitlements: Entitlements,
): Promise<Response> {
  const served = serveQuestions(rows, entitlements);
  return json({
    article: {
      title: source.canonicalTitle,
      displayTitle: source.displayTitle,
      description: source.description,
    },
    cached: cachedHit,
    weeklyRemaining: await weeklyRemaining(userId),
    weeklyCap: WEEKLY_ADD_CAP,
    questions: served.map((r) => ({
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
