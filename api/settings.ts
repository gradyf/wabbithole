// /api/settings — the signed-in user's product preferences.
//   GET  -> { preferences }
//   PUT  { preferences } -> validates a whitelist, upserts, returns { preferences }
// Auth required. No withUserLock: settings are last-write-wins per user, with
// no cross-request cap to race (unlike bank adds).

import { eq } from 'drizzle-orm';
import { requireUser } from './_lib/auth.js';
import { db } from './_lib/db.js';
import { isKnownFocus } from './_lib/focus.js';
import { HttpError, handle, json, readJson, requireMethod } from './_lib/http.js';
import { type UserPreferences, userSettings } from './_lib/schema.js';

interface SettingsBody {
  preferences?: unknown;
}

export default handle(async (request) => {
  const userId = await requireUser(request);
  if (request.method === 'GET') return get(userId);
  requireMethod(request, 'PUT');

  const body = await readJson<SettingsBody>(request);
  const preferences = validatePreferences(body.preferences);

  const now = new Date();
  const [row] = await db
    .insert(userSettings)
    .values({ clerkUserId: userId, preferences, updatedAt: now })
    .onConflictDoUpdate({
      target: userSettings.clerkUserId,
      set: { preferences, updatedAt: now },
    })
    .returning({ preferences: userSettings.preferences });
  return json({ preferences: row.preferences });
});

async function get(userId: string): Promise<Response> {
  const [row] = await db
    .select({ preferences: userSettings.preferences })
    .from(userSettings)
    .where(eq(userSettings.clerkUserId, userId));
  return json({ preferences: row?.preferences ?? {} });
}

// Reject anything not described by UserPreferences: unknown top-level keys, a
// non-object envelope, or a quizFocuses that isn't an array of known focus
// keys. A malformed PUT changes nothing (400) rather than persisting junk.
const ALLOWED_KEYS = new Set(['quizFocuses']);

function validatePreferences(value: unknown): UserPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'bad_request', 'preferences must be an object');
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new HttpError(400, 'bad_request', `unknown preference key: ${key}`);
    }
  }

  const out: UserPreferences = {};
  if ('quizFocuses' in input) {
    const focuses = input.quizFocuses;
    if (!Array.isArray(focuses) || !focuses.every(isKnownFocus)) {
      throw new HttpError(400, 'bad_request', 'quizFocuses must be an array of known focus keys');
    }
    // Dedupe so a client can't grow the array unboundedly with repeats.
    out.quizFocuses = [...new Set(focuses)];
  }
  return out;
}
