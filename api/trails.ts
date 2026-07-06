// /api/trails — a signed-in user's saved trails plus their auto-resume trail.
//   GET                                  -> { trails } (auto first, then named by updatedAt desc)
//   POST {action:'autosave', nodes}      -> upsert the auto trail (empty nodes deletes it)
//   POST {action:'save', title?, nodes}  -> insert a named trail (50-trail cap -> 409 trail_limit)
//   POST {action:'rename', id, title}    -> rename an owned trail
//   POST {action:'delete', id}           -> delete an owned trail
// Anonymous visitors never reach here: every method requires a Clerk user.

import { and, count, desc, eq, sql } from 'drizzle-orm';
import { requireUser } from './_lib/auth.js';
import { db, withUserLock } from './_lib/db.js';
import { HttpError, handle, json, readJson } from './_lib/http.js';
import { trails } from './_lib/schema.js';
import { validLang } from './_lib/wikipedia.js';

const NAMED_TRAIL_CAP = 50;
const MAX_NODES = 100;
const MAX_TITLE = 120;
const MAX_NODE_TITLE = 300;

interface TrailNode {
  lang: string;
  title: string;
}

interface TrailsPost {
  action?: unknown;
  nodes?: unknown;
  title?: unknown;
  id?: unknown;
}

// What GET and every mutating action echo back for a single trail.
const trailFields = {
  id: trails.id,
  title: trails.title,
  nodes: trails.nodes,
  isAuto: trails.isAuto,
  updatedAt: trails.updatedAt,
} as const;

export default handle(async (request) => {
  const userId = await requireUser(request);

  if (request.method === 'GET') return list(userId);
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');

  const body = await readJson<TrailsPost>(request);
  if (body.action === 'autosave') return autosave(userId, parseNodes(body.nodes, true));
  if (body.action === 'save') {
    return save(userId, parseNodes(body.nodes, false), parseTitle(body.title, true));
  }
  if (body.action === 'rename') return rename(userId, parseId(body.id), parseTitle(body.title, false));
  if (body.action === 'delete') return remove(userId, parseId(body.id));
  throw new HttpError(400, 'bad_request');
});

// --- validation (fires before any DB query, so 400s are testable without the table) ---

function parseNodes(value: unknown, allowEmpty: boolean): TrailNode[] {
  if (!Array.isArray(value) || value.length > MAX_NODES || (!allowEmpty && value.length === 0)) {
    throw new HttpError(400, 'bad_request');
  }
  return value.map((n) => {
    if (n === null || typeof n !== 'object') throw new HttpError(400, 'bad_request');
    const { lang, title } = n as Record<string, unknown>;
    if (
      !validLang(lang) ||
      typeof title !== 'string' ||
      title.length === 0 ||
      title.length > MAX_NODE_TITLE
    ) {
      throw new HttpError(400, 'bad_request');
    }
    return { lang, title };
  });
}

// optional=true: a missing/undefined title is fine (caller derives one).
// optional=false: a title is required, so the result is always a string.
function parseTitle(value: unknown, optional: true): string | null;
function parseTitle(value: unknown, optional: false): string;
function parseTitle(value: unknown, optional: boolean): string | null {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new HttpError(400, 'bad_request');
  }
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request');
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE) throw new HttpError(400, 'bad_request');
  return trimmed;
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) {
    throw new HttpError(400, 'bad_request');
  }
  return value;
}

// "First → Last" with underscores spaced out; a single-node trail is just its
// title (no "First → First"). Clamped to the title column's soft cap.
function derivedTitle(nodes: TrailNode[]): string {
  const spaceify = (t: string) => t.replace(/_/g, ' ');
  const first = spaceify(nodes[0].title);
  const last = spaceify(nodes[nodes.length - 1].title);
  const title = nodes.length === 1 ? first : `${first} → ${last}`;
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE) : title;
}

// --- handlers ---

async function list(userId: string): Promise<Response> {
  // isAuto desc floats the (single) auto trail to the top; named trails follow
  // most-recent first.
  const rows = await db
    .select(trailFields)
    .from(trails)
    .where(eq(trails.clerkUserId, userId))
    .orderBy(desc(trails.isAuto), desc(trails.updatedAt));
  return json({ trails: rows });
}

async function autosave(userId: string, nodes: TrailNode[]): Promise<Response> {
  // Empty path = the user is Home / has no trail: clear their auto trail.
  if (nodes.length === 0) {
    await db.delete(trails).where(and(eq(trails.clerkUserId, userId), eq(trails.isAuto, true)));
    return json({ trail: null });
  }
  const title = derivedTitle(nodes);
  const [row] = await db
    .insert(trails)
    .values({ clerkUserId: userId, title, nodes, isAuto: true })
    .onConflictDoUpdate({
      target: trails.clerkUserId,
      targetWhere: sql`${trails.isAuto}`, // matches the partial unique index predicate
      set: { title, nodes, updatedAt: sql`now()` },
    })
    .returning(trailFields);
  return json({ trail: row });
}

async function save(userId: string, nodes: TrailNode[], title: string | null): Promise<Response> {
  const finalTitle = title ?? derivedTitle(nodes);
  // The cap check and insert share a per-user lock so two concurrent saves
  // can't both slip past slot 50.
  const row = await withUserLock(userId, async (tx) => {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(trails)
      .where(and(eq(trails.clerkUserId, userId), eq(trails.isAuto, false)));
    if (n >= NAMED_TRAIL_CAP) return null;
    const [inserted] = await tx
      .insert(trails)
      .values({ clerkUserId: userId, title: finalTitle, nodes, isAuto: false })
      .returning(trailFields);
    return inserted;
  });
  if (!row) {
    throw new HttpError(
      409,
      'trail_limit',
      `You can keep ${NAMED_TRAIL_CAP} saved trails. Delete one to save another.`,
    );
  }
  return json({ trail: row });
}

async function rename(userId: string, id: string, title: string): Promise<Response> {
  // Ownership lives in the WHERE clause: a foreign id updates nothing -> 404,
  // never a 403 that would confirm the id exists.
  const [row] = await db
    .update(trails)
    .set({ title, updatedAt: sql`now()` })
    .where(and(eq(trails.clerkUserId, userId), eq(trails.id, id)))
    .returning(trailFields);
  if (!row) throw new HttpError(404, 'not_found');
  return json({ trail: row });
}

async function remove(userId: string, id: string): Promise<Response> {
  // Same ownership guard; a foreign id is a silent no-op (deleted: 0), like
  // api/bank.ts remove().
  const deleted = await db
    .delete(trails)
    .where(and(eq(trails.clerkUserId, userId), eq(trails.id, id)))
    .returning({ id: trails.id });
  return json({ deleted: deleted.length });
}
