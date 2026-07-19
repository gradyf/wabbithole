// POST /api/ask {lang, title, selectedText}
// The premium highlight-to-question pipeline: a reader highlights a passage and
// gets ONE generated multiple-choice question, added to the same communal pool
// (origin='adhoc') so an identical highlight is never generated twice.
//
// This endpoint SPENDS REAL MONEY per fresh call, so the order below is
// normative (spec §3.6): every free check — cache, containment — runs BEFORE any
// budget is consumed, and the generation_log row is written (and stays) BEFORE
// the paid call so a failure still counts [C4]. Cache hits and containment
// rejections cost nothing and write no budget row.

import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { and, eq, gte, sql } from 'drizzle-orm';
import { authenticate } from './_lib/auth.js';
import { enforceGenerationBudget, logGeneration } from './_lib/budget.js';
import { type DbTx, db, withKeyLock, withUserLock } from './_lib/db.js';
import { resolveEntitlements } from './_lib/entitlements.js';
import { HttpError, handle, json, readJson, requireMethod } from './_lib/http.js';
import {
  ADHOC_MODEL,
  PROMPT_VERSION,
  QuestionsSchema,
  buildAdhocPrompt,
  validAdhocQuestions,
} from './_lib/prompt.js';
import { articleQuestions, articles, generationLog } from './_lib/schema.js';
import { type ArticleSource, fetchArticleSource, fetchFullPlaintext, validLang } from './_lib/wikipedia.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface AskBody {
  lang?: unknown;
  title?: unknown;
  selectedText?: unknown;
}

export default handle(async (request) => {
  requireMethod(request, 'POST');
  const { userId, has } = await authenticate(request);

  // Premium gate: ad-hoc is a paid capability. Free (and anon-resolved-to-free)
  // never reaches the wallet — 402 tells the client to render the upgrade nudge.
  const entitlements = await resolveEntitlements(userId, has);
  if (!entitlements.adHoc) {
    throw new HttpError(402, 'premium_required', 'Highlight to make a question is a premium feature.');
  }

  const body = await readJson<AskBody>(request);
  if (!validLang(body.lang) || typeof body.title !== 'string' || !body.title.trim()) {
    throw new HttpError(400, 'bad_request');
  }
  if (typeof body.selectedText !== 'string') throw new HttpError(400, 'bad_request');
  const lang = body.lang;

  // Validate the selection: whitespace-normalized, 12-400 chars AND >= 3 words.
  const selection = normalizeSelection(body.selectedText);
  if (selection.length < 12 || selection.length > 400 || wordCount(selection) < 3) {
    throw new HttpError(400, 'bad_selection', 'Highlight a sentence or two to make a question.');
  }

  // Canonicalize + get/create the article row (same as extract).
  const source = await fetchArticleSource(lang, body.title.trim());
  const [inserted] = await db
    .insert(articles)
    .values({ lang, title: source.canonicalTitle })
    .onConflictDoNothing({ target: [articles.lang, articles.title] })
    .returning();
  const articleRow =
    inserted ??
    (await db
      .select()
      .from(articles)
      .where(and(eq(articles.lang, lang), eq(articles.title, source.canonicalTitle))))[0];

  const hash = hashSelection(selection);

  // Containment gate [C9]: the normalized selection must be a substring of the
  // article's FULL uncapped plaintext. Blocks attacker-authored / injected text
  // (which isn't in the article) before any spend, while still accepting a
  // highlight from DEEP in a long article (past the 12k generation cap).
  // Infobox/caption highlights (not in the plaintext) are unsupported v1.
  const fullText = await fetchFullPlaintext(lang, source.canonicalTitle);
  if (!isContained(fullText, selection)) {
    throw new HttpError(400, 'not_in_article', "That text isn't in this article.");
  }

  // Cache: an identical highlight (article_id + selection_hash) is served free —
  // zero LLM, zero budget. Uses the aq_adhoc_selection_idx unique partial index.
  const cachedRow = await loadAdhoc(articleRow.id, hash);
  if (cachedRow) return json(respond(cachedRow, true));

  // Wallet guard + ad-hoc cap are AUTHORITATIVE under a per-user advisory lock
  // [F2]: it SERIALIZES this user's concurrent requests, so N distinct valid
  // highlights fired at once can no longer each read count=0 and all spend — the
  // second waits for the first to release the lock, by which point the first's
  // autocommit log has committed and is visible. No fast pre-check: the only work
  // gated after this point is the (cheap) lock itself — all the expensive I/O
  // (article fetch, full-text fetch, containment, cache read) has already run, so
  // an early non-authoritative reject would save nothing and duplicate the cap
  // logic. The 402 premium gate stays at the top of the handler, before any I/O.
  const isOwner = entitlements.tier === 'owner';
  const result = await withUserLock(userId, async () => {
    // Kill switch -> global ceiling -> per-user 12/day, same order as extract.ts.
    // Owners bypass the per-user cap. Counts read on the default db are correct
    // here: the user-lock serializes same-user requests, so a fresh HTTP
    // connection sees every prior committed log for this user.
    await enforceGenerationBudget(userId, isOwner);

    // Ad-hoc daily cap: premium 10/day, owner unbounded. Counted from
    // generation_log kind='adhoc' (paid calls only — cache hits above never
    // reach here, so they don't consume the cap). Inside the user-lock so the
    // count is atomic with the log write below.
    if (entitlements.adhocDailyCap !== null) {
      const used = await adhocGenerationsToday(userId);
      if (used >= entitlements.adhocDailyCap) {
        throw new HttpError(429, 'adhoc_cap', "That's plenty of questions for today. More tomorrow.");
      }
    }

    // INNER lock: serialize identical concurrent highlights (cross-user) into ONE
    // paid call [C13]. Nested user->key (never key->user) so there is no deadlock
    // cycle. The body re-checks the cache and only the first misser logs +
    // generates. Key namespaces on article+hash with a salt distinct from the
    // user-lock's.
    return await withKeyLock(`adhoc:${articleRow.id}:${hash}`, async (tx) => {
      // Someone identical may have generated between our cache read and the lock.
      const winner = await loadAdhoc(articleRow.id, hash, tx);
      if (winner) return { row: winner, cached: true };

      // Moderation spend-guard [F3]: an UNFILTERED probe under the key-lock. The
      // hidden-filtered `winner` above missed, but a moderation-hidden row may
      // still occupy aq_adhoc_selection_idx for this (article, hash) — in which
      // case the insert below would only conflict-and-410 anyway. Detect it HERE,
      // before logGeneration + the paid call, so re-highlighting a moderated
      // passage burns no cap slot and no money. Sound under the lock: report.ts
      // only flips `hidden` on an existing row (it never inserts), and the
      // key-lock blocks any concurrent same-selection insert, so this set is
      // stable while we hold it.
      const [moderated] = await tx
        .select({ id: articleQuestions.id })
        .from(articleQuestions)
        .where(
          and(
            eq(articleQuestions.articleId, articleRow.id),
            eq(articleQuestions.selectionHash, hash),
            eq(articleQuestions.origin, 'adhoc'),
          ),
        )
        .limit(1);
      if (moderated)
        throw new HttpError(
          410,
          'question_removed',
          "It was removed and can't be asked again. Try a different highlight.",
        );

      // Count-before-spend [C4]: log on the autocommit `db` (NOT `tx`) so the row
      // survives even if generation throws and this transaction rolls back — a
      // failed/refused attempt still consumes the budget slot (no free retry).
      // Atomicity of cap+log comes from the OUTER user-lock serializing same-user
      // requests, not from a shared transaction — so the log stays on autocommit.
      await logGeneration(userId, 'adhoc', articleRow.id);
      const question = await generateAdhoc(source, selection);

      const [row] = await tx
        .insert(articleQuestions)
        .values({
          articleId: articleRow.id,
          type: 'mc',
          prompt: question.prompt,
          choices: question.choices,
          answerIndex: question.answerIndex,
          explanation: question.explanation,
          origin: 'adhoc',
          selectionHash: hash,
          createdBy: userId,
          rank: null,
          promptVersion: PROMPT_VERSION,
          model: ADHOC_MODEL,
        })
        .onConflictDoNothing()
        .returning();
      // A concurrent identical insert won the unique index — re-select the winner.
      if (row) return { row, cached: false };
      const other = await loadAdhoc(articleRow.id, hash, tx);
      // Defensive fallback [F3]: the pre-spend probe above already 410s the
      // moderation-hidden case before generating, and the key-lock blocks any
      // concurrent same-selection insert — so an insert conflict with a null
      // filtered re-select should be unreachable here. Kept as a clean 410 (not a
      // 500) in case a hidden row races in between the probe and the insert.
      if (!other)
        throw new HttpError(
          410,
          'question_removed',
          "It was removed and can't be asked again. Try a different highlight.",
        );
      return { row: other, cached: false };
    });
  });

  return json(respond(result.row, result.cached));
});

type QuestionRow = typeof articleQuestions.$inferSelect;

function respond(row: QuestionRow, cached: boolean) {
  return {
    cached,
    question: {
      id: row.id,
      prompt: row.prompt,
      choices: row.choices,
      answerIndex: row.answerIndex,
      explanation: row.explanation,
    },
  };
}

// ---- pure helpers (exported for unit tests; no live call / DB needed) -------

/** Collapse all runs of whitespace to a single space and trim. This is the
 * canonical selection used for length/word validation and for hashing, so the
 * dedup key is stable across the browser's whitespace quirks. */
export function normalizeSelection(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function wordCount(normalized: string): number {
  return normalized === '' ? 0 : normalized.split(' ').length;
}

/** SHA-256 of the normalized selection — the exact-dedup key (selection_hash). */
export function hashSelection(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

/** Containment [C9]: normalized (whitespace-collapsed, lowercased) selection is
 * a substring of the normalized full plaintext. Substring — not fuzzy overlap —
 * so an attacker-authored passage that isn't literally in the article is
 * rejected before any spend; a genuine highlight from anywhere in the article
 * (including past the generation cap) passes. */
export function isContained(fullPlaintext: string, selection: string): boolean {
  const needle = normalizeForContainment(selection);
  if (needle.length === 0) return false;
  return normalizeForContainment(fullPlaintext).includes(needle);
}

// Rendered .wh-prose carries inline citation/footnote markers ([1], [a],
// [note 2], [citation needed]) that the explaintext output does NOT contain, so
// a legitimate sentence selection with a marker would false-reject — a paid
// user seeing "That text isn't in this article." on normal prose. Stripped from
// BOTH sides (harmless where the haystack never has them; safe even if a
// marker-shaped string were real article text, since both sides lose it
// identically).
const CITATION_MARKERS = /\[(?:\d+|[a-z]{1,2}|note \d+|citation needed)\]/gi;

/** Shared containment normalization, applied identically to the selection and
 * the plaintext: NFC unicode composition first (the browser DOM and the
 * explaintext endpoint are not guaranteed the same composition form), then the
 * citation-marker strip, then whitespace collapse + case fold. Marker strip
 * runs before the collapse so a marker between words never leaves a double
 * space behind. */
function normalizeForContainment(s: string): string {
  return s
    .normalize('NFC')
    .replace(CITATION_MARKERS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ---- DB + generation --------------------------------------------------------

async function loadAdhoc(
  articleId: number,
  hash: string,
  executor: typeof db | DbTx = db,
): Promise<QuestionRow | null> {
  const [row] = await executor
    .select()
    .from(articleQuestions)
    .where(
      and(
        eq(articleQuestions.articleId, articleId),
        eq(articleQuestions.selectionHash, hash),
        eq(articleQuestions.origin, 'adhoc'),
        // Moderation floor [F3]: a 3-report auto-hidden ad-hoc row must NOT serve
        // from cache. Both the pre-lock cache read and the in-lock re-check miss
        // it; the resulting insert collision is answered as 410 question_removed.
        eq(articleQuestions.hidden, false),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** One user's ad-hoc paid generations in the last rolling 24h (kind='adhoc'). */
async function adhocGenerationsToday(userId: string): Promise<number> {
  const dayAgo = new Date(Date.now() - DAY_MS);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(generationLog)
    .where(
      and(
        eq(generationLog.clerkUserId, userId),
        eq(generationLog.kind, 'adhoc'),
        gte(generationLog.createdAt, dayAgo),
      ),
    );
  return count;
}

// One Haiku call -> one validated ad-hoc question, or 422 no_question when the
// model refuses (empty array) or the output fails the content checks [C12]. The
// generation_log row is already committed by the caller, so a 422 here still
// consumes the budget slot per [C4].
async function generateAdhoc(source: ArticleSource, selection: string) {
  const client = new Anthropic(); // ANTHROPIC_API_KEY from env
  const res = await client.messages.parse({
    model: ADHOC_MODEL,
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: buildAdhocPrompt({
          title: source.displayTitle,
          description: source.description,
          context: source.text,
          selection,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(QuestionsSchema) },
  });
  console.log('adhoc usage', JSON.stringify(res.usage));

  const valid = validAdhocQuestions(res.parsed_output?.questions ?? []);
  if (valid.length === 0) {
    throw new HttpError(422, 'no_question', "Couldn't make a fair question from that highlight.");
  }
  return valid[0];
}
