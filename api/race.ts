// /api/race — a signed-in user's daily race results + streak.
//   GET  -> { results, streak }   (last 60 results by raceDate desc; streak =
//           consecutive won local dates ending at the most recent won date)
//   POST {action:'result', raceDate, startTitle, targetTitle, cards, elapsedMs, won}
//        -> { recorded } — insert with onConflictDoNothing on (user, raceDate):
//           the FIRST result recorded for a date sticks, matching the client's
//           localStorage rule, so re-sends and cross-device races are harmless.
// Anonymous players never reach here: every method requires a Clerk user.

import { and, desc, eq } from 'drizzle-orm';
import { requireUser } from './_lib/auth.js';
import { db } from './_lib/db.js';
import { HttpError, handle, json, readJson } from './_lib/http.js';
import { raceResults } from './_lib/schema.js';

const RESULTS_LIMIT = 60;
// Upper bound on the won-dates scan (and so on the reported streak). A daily
// winner takes over a year to reach it; keeps the streak query bounded.
const STREAK_SCAN = 400;
const MAX_TITLE = 300;
const MAX_CARDS = 999;
const MAX_ELAPSED_MS = 86_400_000; // one day — a scored run is atomic to its day

interface RacePost {
  action?: unknown;
  raceDate?: unknown;
  startTitle?: unknown;
  targetTitle?: unknown;
  cards?: unknown;
  elapsedMs?: unknown;
  won?: unknown;
}

interface RaceResultInput {
  raceDate: string;
  startTitle: string;
  targetTitle: string;
  cards: number;
  elapsedMs: number;
  won: boolean;
}

export default handle(async (request) => {
  const userId = await requireUser(request);

  if (request.method === 'GET') return list(userId);
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');

  const body = await readJson<RacePost>(request);
  if (body.action === 'result') return record(userId, parseResult(body));
  throw new HttpError(400, 'bad_request');
});

// --- validation (fires before any DB query, so 400s are testable without the table) ---

function parseResult(body: RacePost): RaceResultInput {
  const { raceDate, startTitle, targetTitle, cards, elapsedMs, won } = body;
  if (
    typeof raceDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raceDate) ||
    !validTitle(startTitle) ||
    !validTitle(targetTitle) ||
    !intInRange(cards, 1, MAX_CARDS) ||
    !intInRange(elapsedMs, 0, MAX_ELAPSED_MS) ||
    typeof won !== 'boolean'
  ) {
    throw new HttpError(400, 'bad_request');
  }
  return { raceDate, startTitle, targetTitle, cards, elapsedMs, won };
}

function validTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TITLE;
}

function intInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// --- handlers ---

async function list(userId: string): Promise<Response> {
  const results = await db
    .select({
      raceDate: raceResults.raceDate,
      startTitle: raceResults.startTitle,
      targetTitle: raceResults.targetTitle,
      cards: raceResults.cards,
      elapsedMs: raceResults.elapsedMs,
      won: raceResults.won,
    })
    .from(raceResults)
    .where(eq(raceResults.clerkUserId, userId))
    .orderBy(desc(raceResults.raceDate))
    .limit(RESULTS_LIMIT);
  return json({ results, streak: await streak(userId) });
}

/** Consecutive won local dates ending at the user's most recent won date.
 *  Computed in JS over just the won dates (desc): walk from the newest won
 *  date while each next row is exactly one calendar day earlier. Recorded
 *  losses simply aren't in the list, so a lost day breaks the chain the same
 *  way a skipped day does. The server can't know the player's local "today",
 *  which is why the anchor is the most recent WON date; the client reconciles
 *  liveness against its own calendar. */
async function streak(userId: string): Promise<number> {
  const rows = await db
    .select({ raceDate: raceResults.raceDate })
    .from(raceResults)
    .where(and(eq(raceResults.clerkUserId, userId), eq(raceResults.won, true)))
    .orderBy(desc(raceResults.raceDate))
    .limit(STREAK_SCAN);
  let n = 0;
  let expected: string | null = null; // null = accept the first (anchor) date
  for (const { raceDate } of rows) {
    if (expected !== null && raceDate !== expected) break;
    n++;
    expected = prevDate(raceDate);
  }
  return n;
}

/** Step a YYYY-MM-DD key back one calendar day in pure UTC math (immune to
 *  the server's timezone and DST), mirroring src/race.ts prevKey. */
function prevDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function record(userId: string, input: RaceResultInput): Promise<Response> {
  // First result of a date sticks: the unique (clerk_user_id, race_date)
  // index turns any later attempt — a re-send, another device, a replayed
  // freeplay that somehow posts — into a silent no-op.
  const inserted = await db
    .insert(raceResults)
    .values({ clerkUserId: userId, ...input })
    .onConflictDoNothing({ target: [raceResults.clerkUserId, raceResults.raceDate] })
    .returning({ id: raceResults.id });
  return json({ recorded: inserted.length > 0 });
}
